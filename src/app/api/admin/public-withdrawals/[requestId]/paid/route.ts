import { Prisma } from "@prisma/client";
import { requireAdminSession } from "@/lib/server/auth";
import { prisma } from "@/lib/server/prisma";
import { fail, handleRouteError, ok } from "@/lib/server/responses";
import { decimalToNumber } from "@/lib/server/serializers";

export const runtime = "nodejs";

function money(value: unknown) {
  const amount = decimalToNumber(value as never);
  return Number(amount.toFixed(6));
}

async function lockWallet(tx: Prisma.TransactionClient, walletId: string) {
  const rows = await tx.$queryRaw<Array<{
    id: string;
    telegramUserId: string;
    availableBalance: Prisma.Decimal;
    frozenBalance: Prisma.Decimal;
  }>>`
    SELECT
      "id",
      "telegramUserId",
      "availableBalance",
      "frozenBalance"
    FROM "public_user_wallets"
    WHERE "id" = ${walletId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

function serializeWithdrawal(request: {
  id: string;
  telegramUserId: string;
  telegramUsername: string | null;
  amount: Prisma.Decimal;
  fee: Prisma.Decimal;
  totalFrozen: Prisma.Decimal;
  status: string;
  chain: string;
  tokenSymbol: string;
  withdrawalAddress: string;
  note: string | null;
  adminNote: string | null;
  requestedAt: Date;
  processedAt: Date | null;
  processedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    ...request,
    amount: money(request.amount),
    fee: money(request.fee),
    totalFrozen: money(request.totalFrozen),
  };
}

export async function POST(request: Request, context: { params: Promise<{ requestId: string }> }) {
  try {
    const admin = await requireAdminSession();
    const { requestId } = await context.params;
    const body = await request.json().catch(() => ({}));
    const adminNote = String(body.adminNote || "").trim() || null;

    const result = await prisma.$transaction(
      async (tx) => {
        const withdrawal = await tx.publicUserWithdrawalRequest.findUnique({
          where: { id: requestId },
        });
        if (!withdrawal) return { type: "notFound" as const };
        if (withdrawal.status !== "PENDING") return { type: "notPending" as const, withdrawal };

        const wallet = await lockWallet(tx, withdrawal.walletId);
        if (!wallet) return { type: "walletNotFound" as const, withdrawal };
        if (wallet.frozenBalance.lessThan(withdrawal.totalFrozen)) {
          return { type: "insufficientFrozen" as const, withdrawal };
        }

        await tx.publicUserWallet.update({
          where: { id: wallet.id },
          data: {
            frozenBalance: { decrement: withdrawal.totalFrozen },
          },
        });

        await tx.publicUserWalletLedger.create({
          data: {
            walletId: wallet.id,
            telegramUserId: withdrawal.telegramUserId,
            type: "WITHDRAWAL_PAID",
            availableDelta: 0,
            frozenDelta: withdrawal.totalFrozen.negated(),
            referenceId: `pub_withdrawal:${withdrawal.id}`,
            note: adminNote || "Admin marked public user withdrawal as paid",
          },
        });

        const updated = await tx.publicUserWithdrawalRequest.update({
          where: { id: withdrawal.id },
          data: {
            status: "PAID",
            adminNote,
            processedAt: new Date(),
            processedBy: admin.username,
          },
        });
        return { type: "ok" as const, withdrawal: updated };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );

    if (result.type === "notFound") return fail("提现申请不存在", 404);
    if (result.type === "notPending") return fail("该提现申请已处理");
    if (result.type === "walletNotFound") return fail("用户钱包不存在", 404);
    if (result.type === "insufficientFrozen") return fail("用户冻结余额不足，不能标记已打款");
    return ok(serializeWithdrawal(result.withdrawal));
  } catch (error) {
    if (error instanceof Response) return fail("未登录管理员", 401);
    return handleRouteError(error);
  }
}
