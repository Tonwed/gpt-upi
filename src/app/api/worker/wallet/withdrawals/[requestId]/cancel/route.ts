import { Prisma } from "@prisma/client";
import { requireWorkerSession } from "@/lib/server/auth";
import { prisma } from "@/lib/server/prisma";
import { fail, handleRouteError, ok } from "@/lib/server/responses";
import { serializeWorkerWithdrawalRequest } from "@/lib/server/serializers";

export const runtime = "nodejs";

export async function POST(_request: Request, context: { params: Promise<{ requestId: string }> }) {
  try {
    const worker = await requireWorkerSession();
    const { requestId } = await context.params;

    const result = await prisma.$transaction(
      async (tx) => {
        const current = await tx.workerWithdrawalRequest.findUnique({
          where: { id: requestId },
          include: {
            worker: { select: { id: true, username: true, displayName: true, binanceUserId: true } },
          },
        });
        if (!current) return { type: "notFound" as const };
        if (current.workerId !== worker.id) return { type: "forbidden" as const };
        if (current.status !== "PENDING") return { type: "notPending" as const, withdrawal: current };

        const withdrawal = await tx.workerWithdrawalRequest.update({
          where: { id: requestId },
          data: {
            status: "CANCELLED",
            adminNote: "Cancelled by worker",
            processedAt: new Date(),
            processedBy: worker.username,
          },
          include: {
            worker: { select: { id: true, username: true, displayName: true, binanceUserId: true } },
          },
        });
        return { type: "ok" as const, withdrawal };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );

    if (result.type === "notFound") return fail("提现申请不存在", 404);
    if (result.type === "forbidden") return fail("只能取消自己的提现申请", 403);
    if (result.type === "notPending") return fail("该提现申请已处理，无法取消");
    return ok(serializeWorkerWithdrawalRequest(result.withdrawal));
  } catch (error) {
    if (error instanceof Response) return fail("Unauthorized", 401);
    return handleRouteError(error);
  }
}
