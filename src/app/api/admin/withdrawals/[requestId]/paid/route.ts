import { Prisma } from "@prisma/client";
import { requireAdminSession } from "@/lib/server/auth";
import { prisma } from "@/lib/server/prisma";
import { fail, handleRouteError, ok } from "@/lib/server/responses";
import { serializeWorkerWithdrawalRequest } from "@/lib/server/serializers";
import { getWorkerWalletSummary } from "@/lib/server/wallet";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ requestId: string }> }) {
  try {
    const admin = await requireAdminSession();
    const { requestId } = await context.params;
    const body = await request.json().catch(() => ({}));
    const adminNote = String(body.adminNote || "").trim() || null;

    const result = await prisma.$transaction(
      async (tx) => {
        const withdrawal = await tx.workerWithdrawalRequest.findUnique({
          where: { id: requestId },
          include: {
            worker: { select: { id: true, username: true, displayName: true, binanceUserId: true } },
          },
        });
        if (!withdrawal) return { type: "notFound" as const };
        if (withdrawal.status !== "PENDING") return { type: "notPending" as const, withdrawal };

        const summary = await getWorkerWalletSummary(withdrawal.workerId, tx);
        if (summary.availableBalance + Number(withdrawal.amount) < Number(withdrawal.amount)) {
          return { type: "insufficient" as const, withdrawal };
        }

        await tx.workerWalletLedger.create({
          data: {
            workerId: withdrawal.workerId,
            type: "WITHDRAWAL_PAID",
            amount: (-Number(withdrawal.amount)).toFixed(2),
            note: `Withdrawal ${withdrawal.id}`,
            createdBy: admin.username,
          },
        });
        const updated = await tx.workerWithdrawalRequest.update({
          where: { id: withdrawal.id },
          data: {
            status: "PAID",
            adminNote,
            processedAt: new Date(),
            processedBy: admin.username,
          },
          include: {
            worker: { select: { id: true, username: true, displayName: true, binanceUserId: true } },
          },
        });
        return { type: "ok" as const, withdrawal: updated };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );

    if (result.type === "notFound") return fail("提现申请不存在", 404);
    if (result.type === "notPending") return fail("该提现申请已处理");
    if (result.type === "insufficient") return fail("worker 可用余额不足，不能标记付款");
    return ok(serializeWorkerWithdrawalRequest(result.withdrawal));
  } catch (error) {
    if (error instanceof Response) return fail("未登录管理员", 401);
    return handleRouteError(error);
  }
}
