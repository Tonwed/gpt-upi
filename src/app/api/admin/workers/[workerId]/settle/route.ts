import { Prisma } from "@prisma/client";
import { requireAdminSession } from "@/lib/server/auth";
import { prisma } from "@/lib/server/prisma";
import { fail, handleRouteError, ok } from "@/lib/server/responses";
import { decimalToNumber } from "@/lib/server/serializers";

export const runtime = "nodejs";

export async function POST(_request: Request, context: { params: Promise<{ workerId: string }> }) {
  try {
    const admin = await requireAdminSession();
    const { workerId } = await context.params;

    const result = await prisma.$transaction(
      async (tx) => {
        const records = await tx.workerOrderRecord.findMany({
          where: {
            workerId,
            result: "COMPLETED",
            settledAt: null,
          },
          select: {
            id: true,
            unitPriceSnapshot: true,
          },
        });

        if (records.length === 0) {
          return { settledCount: 0, settledAmount: 0, settledAt: new Date() };
        }

        const settledAt = new Date();
        const settledAmount = records.reduce((sum, record) => sum + decimalToNumber(record.unitPriceSnapshot), 0);

        const updated = await tx.workerOrderRecord.updateMany({
          where: {
            id: { in: records.map((record) => record.id) },
            settledAt: null,
          },
          data: {
            settledAt,
            settledBy: admin.telegramUserId,
          },
        });

        return {
          settledCount: updated.count,
          settledAmount,
          settledAt,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );

    return ok(result);
  } catch (error) {
    if (error instanceof Response) return fail("未登录管理员", 401);
    return handleRouteError(error);
  }
}
