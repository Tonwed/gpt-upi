import { Prisma } from "@prisma/client";
import { requireAdminSession } from "@/lib/server/auth";
import { containsInsensitive, paginatedPayload, parseAdminPagination } from "@/lib/server/admin-pagination";
import { prisma } from "@/lib/server/prisma";
import { fail, handleRouteError, ok } from "@/lib/server/responses";
import { serializeWorkerWithdrawalRequest } from "@/lib/server/serializers";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    await requireAdminSession();
    const { isPaged, page, pageSize, skip, take, search } = parseAdminPagination(request);
    const where: Prisma.WorkerWithdrawalRequestWhereInput = search
      ? {
          OR: [
            { id: containsInsensitive(search) },
            { binanceUserIdSnapshot: containsInsensitive(search) },
            { note: containsInsensitive(search) },
            { adminNote: containsInsensitive(search) },
            { worker: { username: containsInsensitive(search) } },
            { worker: { displayName: containsInsensitive(search) } },
            { worker: { binanceUserId: containsInsensitive(search) } },
          ],
        }
      : {};
    const requests = await prisma.workerWithdrawalRequest.findMany({
      where,
      orderBy: [{ status: "asc" }, { requestedAt: "desc" }],
      skip: isPaged ? skip : undefined,
      take: isPaged ? take : 100,
      include: {
        worker: {
          select: {
            id: true,
            username: true,
            displayName: true,
            binanceUserId: true,
          },
        },
      },
    });
    const items = requests.map(serializeWorkerWithdrawalRequest);
    if (!isPaged) return ok(items);
    const total = await prisma.workerWithdrawalRequest.count({ where });
    return ok(paginatedPayload(items, { page, pageSize, total, search }));
  } catch (error) {
    if (error instanceof Response) return fail("未登录管理员", 401);
    return handleRouteError(error);
  }
}
