import { Prisma } from "@prisma/client";
import { requireAdminSession } from "@/lib/server/auth";
import { expireStaleOrders, orderInclude } from "@/lib/server/orders";
import { containsInsensitive, paginatedPayload, parseAdminPagination } from "@/lib/server/admin-pagination";
import { prisma } from "@/lib/server/prisma";
import { fail, handleRouteError, ok } from "@/lib/server/responses";
import { serializeOrder } from "@/lib/server/serializers";

export const runtime = "nodejs";

function orderFilterWhere(filter: string | null): Prisma.OrderWhereInput {
  if (filter === "HALL") return { status: "PENDING" };
  if (filter === "ACTIVE") return { status: { in: ["ASSIGNED", "CHECKING"] } };
  if (filter === "REUPLOAD") return { status: "NEED_REUPLOAD" };
  if (filter === "HISTORY") return { status: { in: ["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"] } };
  return {};
}

export async function GET(request: Request) {
  try {
    await requireAdminSession();
    await expireStaleOrders();
    const { isPaged, page, pageSize, skip, take, search, url } = parseAdminPagination(request);
    const filterWhere = orderFilterWhere(url.searchParams.get("filter"));
    const sourceSearch = search.toUpperCase();
    const searchClauses: Prisma.OrderWhereInput[] = [
      { orderNo: containsInsensitive(search) },
      { publicUserTelegramId: containsInsensitive(search) },
      { publicUserTelegramName: containsInsensitive(search) },
      { customerNote: containsInsensitive(search) },
      { problemReason: containsInsensitive(search) },
      { cdk: { code: containsInsensitive(search) } },
      { assignedWorker: { username: containsInsensitive(search) } },
      { assignedWorker: { displayName: containsInsensitive(search) } },
    ];
    if (sourceSearch === "CDK" || sourceSearch === "PUBLIC_SCAN") {
      searchClauses.push({ source: sourceSearch });
    }
    const searchWhere: Prisma.OrderWhereInput = search
      ? {
          OR: searchClauses,
        }
      : {};
    const andWhere = [filterWhere, searchWhere].filter((item) => Object.keys(item).length > 0);
    const where: Prisma.OrderWhereInput = andWhere.length > 0 ? { AND: andWhere } : {};

    if (!isPaged) {
      const orders = await prisma.order.findMany({
        orderBy: { createdAt: "desc" },
        include: orderInclude,
      });
      return ok(orders.map(serializeOrder));
    }

    const [total, orders] = await Promise.all([
      prisma.order.count({ where }),
      prisma.order.findMany({ where, orderBy: { createdAt: "desc" }, include: orderInclude, skip, take }),
    ]);

    return ok(paginatedPayload(orders.map(serializeOrder), { page, pageSize, total, search }));
  } catch (error) {
    if (error instanceof Response) return fail("未登录管理员", 401);
    return handleRouteError(error);
  }
}
