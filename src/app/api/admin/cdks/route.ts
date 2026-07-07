import { Prisma } from "@prisma/client";
import { requireAdminSession } from "@/lib/server/auth";
import { normalizeCdkCode } from "@/lib/cdk-code";
import { parseRechargeCdkAmount } from "@/lib/cdk-recharge";
import { containsInsensitive, paginatedPayload, parseAdminPagination } from "@/lib/server/admin-pagination";
import { prisma } from "@/lib/server/prisma";
import { fail, handleRouteError, ok } from "@/lib/server/responses";
import { serializeCdk } from "@/lib/server/serializers";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    await requireAdminSession();
    const { isPaged, page, pageSize, skip, take, search } = parseAdminPagination(request);
    const where: Prisma.CdkWhereInput = search
      ? {
          OR: [
            { code: containsInsensitive(search) },
            { batchId: containsInsensitive(search) },
            { remark: containsInsensitive(search) },
            { redeemedByTelegramId: containsInsensitive(search) },
            { redeemedByTelegramName: containsInsensitive(search) },
          ],
        }
      : {};
    if (!isPaged) {
      const cdks = await prisma.cdk.findMany({ orderBy: { createdAt: "desc" } });
      return ok(cdks.map(serializeCdk));
    }

    const [total, cdks] = await Promise.all([
      prisma.cdk.count({ where }),
      prisma.cdk.findMany({ where, orderBy: { createdAt: "desc" }, skip, take }),
    ]);

    return ok(paginatedPayload(cdks.map(serializeCdk), { page, pageSize, total, search }));
  } catch (error) {
    if (error instanceof Response) return fail("未登录管理员", 401);
    return handleRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    await requireAdminSession();
    const body = await request.json();
    const code = normalizeCdkCode(String(body.code || ""));
    const amount = parseRechargeCdkAmount(body.amount);
    const remark = String(body.remark || "").trim() || null;

    if (!code) return fail("请输入 CDK");
    if (!amount) return fail("请选择有效充值金额：1.8U、5U 或 10U");

    const cdk = await prisma.cdk.create({
      data: {
        code,
        amount,
        totalCount: 1,
        remark,
      },
    });

    return ok(serializeCdk(cdk));
  } catch (error) {
    if (error instanceof Response) return fail("未登录管理员", 401);
    const message = error instanceof Error ? error.message : "创建 CDK 失败";
    if (message.includes("Unique") || message.includes("P2002")) return fail("CDK 已存在");
    return handleRouteError(error);
  }
}
