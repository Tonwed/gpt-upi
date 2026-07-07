import { Prisma, WorkerWithdrawalStatus } from "@prisma/client";
import { prisma } from "@/lib/server/prisma";
import { decimalToNumber } from "@/lib/server/serializers";

type WalletDb = typeof prisma | Prisma.TransactionClient;

function money(value: number) {
  return Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
}

export function parseMoneyAmount(value: unknown) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return amount.toFixed(2);
}

export async function getWorkerWalletSummary(workerId: string, db: WalletDb = prisma) {
  const [completed, settled, ledger, pendingWithdrawals, advances] = await Promise.all([
    db.workerOrderRecord.aggregate({
      where: { workerId, result: "COMPLETED" },
      _sum: { unitPriceSnapshot: true },
    }),
    db.workerOrderRecord.aggregate({
      where: { workerId, result: "COMPLETED", settledAt: { not: null } },
      _sum: { unitPriceSnapshot: true },
    }),
    db.workerWalletLedger.aggregate({
      where: { workerId },
      _sum: { amount: true },
    }),
    db.workerWithdrawalRequest.aggregate({
      where: { workerId, status: WorkerWithdrawalStatus.PENDING },
      _sum: { amount: true },
    }),
    db.workerWalletLedger.aggregate({
      where: { workerId, type: "ADMIN_ADVANCE" },
      _sum: { amount: true },
    }),
  ]);

  const completedEarnings = decimalToNumber(completed._sum.unitPriceSnapshot);
  const settledAmount = decimalToNumber(settled._sum.unitPriceSnapshot);
  const ledgerAmount = decimalToNumber(ledger._sum.amount);
  const pendingWithdrawalAmount = decimalToNumber(pendingWithdrawals._sum.amount);
  const balance = money(completedEarnings - settledAmount + ledgerAmount);

  return {
    balance,
    availableBalance: money(balance - pendingWithdrawalAmount),
    pendingWithdrawalAmount: money(pendingWithdrawalAmount),
    completedEarnings: money(completedEarnings),
    settledAmount: money(settledAmount),
    ledgerAmount: money(ledgerAmount),
    advanceAmount: money(Math.abs(Math.min(0, decimalToNumber(advances._sum.amount)))),
  };
}

export async function createWithdrawalRequest(input: {
  workerId: string;
  amount: string;
  note?: string | null;
}) {
  return prisma.$transaction(
    async (tx) => {
      const worker = await tx.worker.findUnique({
        where: { id: input.workerId },
        select: { binanceUserId: true },
      });
      if (!worker) throw new Error("接单方不存在");
      if (!worker.binanceUserId) throw new Error("请先绑定 Binance 用户 ID 后再申请提现");

      const summary = await getWorkerWalletSummary(input.workerId, tx);
      const amount = Number(input.amount);
      if (summary.availableBalance < amount) {
        throw new Error("可提现余额不足");
      }

      return tx.workerWithdrawalRequest.create({
        data: {
          workerId: input.workerId,
          amount: input.amount,
          binanceUserIdSnapshot: worker.binanceUserId,
          note: input.note || null,
        },
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}
