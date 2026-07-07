import { Prisma, PublicUserWalletLedgerType } from "@prisma/client";
import { requireAdminSession } from "@/lib/server/auth";
import { prisma } from "@/lib/server/prisma";
import { fail, handleRouteError, ok } from "@/lib/server/responses";
import { decimalToNumber } from "@/lib/server/serializers";

export const runtime = "nodejs";

type DbLike = typeof prisma | Prisma.TransactionClient;

class CorrectionError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function money(value: unknown) {
  const amount = decimalToNumber(value as never);
  return Number(amount.toFixed(6));
}

function decimal(value: unknown) {
  return new Prisma.Decimal(String(value ?? 0));
}

function normalizeTxHash(value: unknown) {
  const txHash = String(value || "").trim();
  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) throw new CorrectionError("请输入有效的交易哈希");
  return txHash;
}

function normalizeLogIndex(value: unknown) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0) throw new CorrectionError("logIndex 必须是非负整数");
  return index;
}

function normalizeTarget(value: unknown) {
  const target = String(value || "").trim().replace(/^@+/, "");
  if (!target) throw new CorrectionError("请输入正确入账用户的 Telegram ID 或用户名");
  return target;
}

function shortHash(value?: string | null) {
  if (!value) return "-";
  return value.length > 22 ? `${value.slice(0, 12)}...${value.slice(-8)}` : value;
}

async function findChainDeposit(db: DbLike, txHash: string, logIndex: number | null) {
  const rows = await db.publicChainDeposit.findMany({
    where: {
      txHash: { equals: txHash, mode: "insensitive" },
      ...(logIndex !== null ? { logIndex } : {}),
    },
    orderBy: { logIndex: "asc" },
  });
  if (rows.length === 0) throw new CorrectionError("没有找到这笔链上入账记录，请确认交易已被系统扫描到。", 404);
  if (rows.length > 1) throw new CorrectionError("该交易包含多条入账日志，请填写 logIndex 后再预览。", 400);
  return rows[0];
}

async function findTargetWallet(db: DbLike, target: string) {
  const wallet = await db.publicUserWallet.findFirst({
    where: {
      OR: [
        { telegramUserId: target },
        { telegramUsername: { equals: target, mode: "insensitive" } },
      ],
    },
  });
  if (!wallet) throw new CorrectionError("没有找到目标用户钱包，请确认该用户已经登录过网站。", 404);
  return wallet;
}

async function buildCorrectionContext(input: {
  txHash: string;
  logIndex: number | null;
  target: string;
  targetOrderId?: string | null;
}, db: DbLike = prisma) {
  const chainDeposit = await findChainDeposit(db, input.txHash, input.logIndex);
  const targetWallet = await findTargetWallet(db, input.target);
  const currentWallet = await db.publicUserWallet.findUnique({
    where: { telegramUserId: chainDeposit.telegramUserId },
  });
  if (!currentWallet) throw new CorrectionError("当前入账用户的钱包不存在，无法自动纠错。", 400);

  const currentOrder = await db.publicUserDepositOrder.findFirst({
    where: {
      txHash: { equals: chainDeposit.txHash, mode: "insensitive" },
      logIndex: chainDeposit.logIndex,
    },
  });
  const currentLedger = await db.publicUserWalletLedger.findFirst({
    where: {
      type: PublicUserWalletLedgerType.CHAIN_DEPOSIT,
      OR: [
        ...(currentOrder ? [{ referenceId: `pub_deposit_order:${currentOrder.id}` }] : []),
        { referenceId: `${chainDeposit.txHash}:${chainDeposit.logIndex}` },
      ],
    },
    orderBy: { createdAt: "asc" },
  });

  const amount = decimal(chainDeposit.amount);
  const paidAt = currentOrder?.paidAt || chainDeposit.creditedAt || chainDeposit.createdAt;
  const candidateOrders = await db.publicUserDepositOrder.findMany({
    where: {
      walletId: targetWallet.id,
      depositAddress: chainDeposit.toAddress,
      createdAt: { lte: paidAt },
      expiresAt: { gte: paidAt },
    },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  const selectedTargetOrder = input.targetOrderId
    ? await db.publicUserDepositOrder.findUnique({ where: { id: input.targetOrderId } })
    : null;

  const warnings: string[] = [];
  const errors: string[] = [];
  if (currentWallet.telegramUserId === targetWallet.telegramUserId) errors.push("这笔入账已经属于目标用户，无需纠错。");
  if (amount.lte(0)) errors.push("链上入账金额无效。");
  if (decimal(currentWallet.availableBalance).lt(amount)) errors.push(`当前错误用户可用余额不足，无法扣回 ${money(amount)} USDT。`);
  if (decimal(currentWallet.totalDeposited).lt(amount)) errors.push(`当前错误用户累计充值不足，无法扣回 ${money(amount)} USDT。`);
  if (!currentLedger) errors.push("没有找到这笔入账对应的钱包流水，暂不自动纠错。");
  if (selectedTargetOrder) {
    if (selectedTargetOrder.walletId !== targetWallet.id) errors.push("选择的目标充值订单不属于目标用户。");
    if (selectedTargetOrder.depositAddress !== chainDeposit.toAddress) errors.push("选择的目标充值订单地址与链上入账地址不一致。");
    if (selectedTargetOrder.status === "PAID" && selectedTargetOrder.txHash !== chainDeposit.txHash) {
      errors.push("选择的目标充值订单已经被其他交易支付，不能再次绑定。");
    }
    if (selectedTargetOrder.createdAt.getTime() > paidAt.getTime() || selectedTargetOrder.expiresAt.getTime() < paidAt.getTime()) {
      warnings.push("选择的目标充值订单不在该交易付款时间窗口内，请确认后再执行。");
    }
  }
  if (currentOrder && currentOrder.status !== "PAID") warnings.push(`当前绑定充值单状态是 ${currentOrder.status}，执行时仍会清除该 tx 绑定。`);
  if (candidateOrders.length === 0) warnings.push("没有找到付款时间窗口内的目标充值订单，将只按 tx 给目标用户补余额。 ");

  const bindableCandidate = candidateOrders.find((item) => item.status !== "PAID" || item.txHash === chainDeposit.txHash);
  const ledgerReference = selectedTargetOrder ? `pub_deposit_order:${selectedTargetOrder.id}` : `${chainDeposit.txHash}:${chainDeposit.logIndex}`;

  return {
    chainDeposit,
    currentWallet,
    currentOrder,
    currentLedger,
    targetWallet,
    candidateOrders,
    selectedTargetOrder,
    amount,
    paidAt,
    preview: {
      tx: {
        txHash: chainDeposit.txHash,
        logIndex: chainDeposit.logIndex,
        amount: money(chainDeposit.amount),
        fromAddress: chainDeposit.fromAddress,
        toAddress: chainDeposit.toAddress,
        blockNumber: chainDeposit.blockNumber,
        confirmations: chainDeposit.confirmations,
        creditedAt: chainDeposit.creditedAt,
      },
      current: {
        telegramUserId: currentWallet.telegramUserId,
        telegramUsername: currentWallet.telegramUsername || chainDeposit.telegramUsername || null,
        walletId: currentWallet.id,
        availableBalance: money(currentWallet.availableBalance),
        totalDeposited: money(currentWallet.totalDeposited),
        order: currentOrder ? {
          id: currentOrder.id,
          orderNo: currentOrder.orderNo,
          status: currentOrder.status,
          payAmount: money(currentOrder.payAmount),
          txHash: currentOrder.txHash,
          logIndex: currentOrder.logIndex,
        } : null,
        ledger: currentLedger ? {
          id: currentLedger.id,
          referenceId: currentLedger.referenceId,
          availableDelta: money(currentLedger.availableDelta),
        } : null,
      },
      target: {
        telegramUserId: targetWallet.telegramUserId,
        telegramUsername: targetWallet.telegramUsername,
        walletId: targetWallet.id,
        availableBalance: money(targetWallet.availableBalance),
        totalDeposited: money(targetWallet.totalDeposited),
      },
      candidateOrders: candidateOrders.map((item) => ({
        id: item.id,
        orderNo: item.orderNo,
        status: item.status,
        baseAmount: money(item.baseAmount),
        payAmount: money(item.payAmount),
        txHash: item.txHash,
        logIndex: item.logIndex,
        createdAt: item.createdAt,
        expiresAt: item.expiresAt,
        paidAt: item.paidAt,
        canBind: item.status !== "PAID" || item.txHash === chainDeposit.txHash,
      })),
      selectedTargetOrderId: selectedTargetOrder?.id || null,
      recommendedTargetOrderId: bindableCandidate?.id || null,
      plan: {
        amount: money(amount),
        debit: {
          telegramUserId: currentWallet.telegramUserId,
          beforeAvailable: money(currentWallet.availableBalance),
          afterAvailable: money(decimal(currentWallet.availableBalance).minus(amount)),
          beforeTotalDeposited: money(currentWallet.totalDeposited),
          afterTotalDeposited: money(decimal(currentWallet.totalDeposited).minus(amount)),
        },
        credit: {
          telegramUserId: targetWallet.telegramUserId,
          beforeAvailable: money(targetWallet.availableBalance),
          afterAvailable: money(decimal(targetWallet.availableBalance).plus(amount)),
          beforeTotalDeposited: money(targetWallet.totalDeposited),
          afterTotalDeposited: money(decimal(targetWallet.totalDeposited).plus(amount)),
        },
        wrongOrderAction: currentOrder ? `充值单 ${currentOrder.orderNo} 将改为 EXPIRED，并清除 ${shortHash(chainDeposit.txHash)} 绑定。` : "没有找到当前绑定充值单。",
        targetOrderAction: selectedTargetOrder
          ? `目标充值单 ${selectedTargetOrder.orderNo} 将标记为 PAID，并绑定该 tx。`
          : "不绑定目标充值单，只按 tx 给目标用户补余额。",
        chainDepositAction: "链上入账记录将改归属到目标用户。",
        ledgerAction: `钱包流水将迁移到目标用户，reference 改为 ${ledgerReference}。`,
        canExecute: errors.length === 0,
        errors,
        warnings,
      },
    },
  };
}

export async function GET(request: Request) {
  try {
    await requireAdminSession();
    const url = new URL(request.url);
    const context = await buildCorrectionContext({
      txHash: normalizeTxHash(url.searchParams.get("txHash")),
      logIndex: normalizeLogIndex(url.searchParams.get("logIndex")),
      target: normalizeTarget(url.searchParams.get("target")),
      targetOrderId: url.searchParams.get("targetOrderId")?.trim() || null,
    });
    return ok(context.preview);
  } catch (error) {
    if (error instanceof Response) return fail("未登录管理员", 401);
    if (error instanceof CorrectionError) return fail(error.message, error.status);
    return handleRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    await requireAdminSession();
    const body = await request.json().catch(() => ({}));
    if (String(body.confirmText || "").trim() !== "CONFIRM") {
      return fail("请输入 CONFIRM 后再执行充值纠错。", 400);
    }
    const txHash = normalizeTxHash(body.txHash);
    const logIndex = normalizeLogIndex(body.logIndex);
    const target = normalizeTarget(body.target);
    const targetOrderId = String(body.targetOrderId || "").trim() || null;
    const adminNote = String(body.adminNote || "").trim();

    const result = await prisma.$transaction(async (tx) => {
      const context = await buildCorrectionContext({ txHash, logIndex, target, targetOrderId }, tx);
      const { chainDeposit, currentWallet, currentOrder, currentLedger, targetWallet, selectedTargetOrder, amount } = context;
      if (!context.preview.plan.canExecute) throw new CorrectionError(context.preview.plan.errors.join("；") || "当前状态无法执行纠错。", 400);
      if (!currentLedger) throw new CorrectionError("没有找到对应钱包流水。", 400);

      if (currentOrder) {
        await tx.publicUserDepositOrder.update({
          where: { id: currentOrder.id },
          data: {
            status: "EXPIRED",
            txHash: null,
            logIndex: null,
            fromAddress: null,
            blockNumber: null,
            confirmations: null,
            paidAt: null,
          },
        });
      }

      if (selectedTargetOrder) {
        await tx.publicUserDepositOrder.update({
          where: { id: selectedTargetOrder.id },
          data: {
            status: "PAID",
            payAmount: amount,
            txHash: chainDeposit.txHash,
            logIndex: chainDeposit.logIndex,
            fromAddress: chainDeposit.fromAddress,
            blockNumber: chainDeposit.blockNumber,
            confirmations: chainDeposit.confirmations,
            paidAt: currentOrder?.paidAt || chainDeposit.creditedAt || chainDeposit.createdAt,
          },
        });
      }

      await tx.publicChainDeposit.update({
        where: { txHash_logIndex: { txHash: chainDeposit.txHash, logIndex: chainDeposit.logIndex } },
        data: {
          telegramUserId: targetWallet.telegramUserId,
          telegramUsername: targetWallet.telegramUsername || null,
        },
      });

      const referenceId = selectedTargetOrder ? `pub_deposit_order:${selectedTargetOrder.id}` : `${chainDeposit.txHash}:${chainDeposit.logIndex}`;
      await tx.publicUserWalletLedger.update({
        where: { id: currentLedger.id },
        data: {
          walletId: targetWallet.id,
          telegramUserId: targetWallet.telegramUserId,
          referenceId,
          note: adminNote || `充值纠错：从 ${currentWallet.telegramUsername ? `@${currentWallet.telegramUsername}` : currentWallet.telegramUserId} 改归属到 ${targetWallet.telegramUsername ? `@${targetWallet.telegramUsername}` : targetWallet.telegramUserId}，tx ${shortHash(chainDeposit.txHash)}`,
        },
      });

      await tx.publicUserWallet.update({
        where: { id: currentWallet.id },
        data: {
          availableBalance: { decrement: amount },
          totalDeposited: { decrement: amount },
        },
      });
      await tx.publicUserWallet.update({
        where: { id: targetWallet.id },
        data: {
          telegramUsername: targetWallet.telegramUsername || null,
          availableBalance: { increment: amount },
          totalDeposited: { increment: amount },
        },
      });

      return buildCorrectionContext({ txHash: chainDeposit.txHash, logIndex: chainDeposit.logIndex, target: targetWallet.telegramUserId }, tx).then((next) => next.preview);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20_000, maxWait: 10_000 });

    return ok(result);
  } catch (error) {
    if (error instanceof Response) return fail("未登录管理员", 401);
    if (error instanceof CorrectionError) return fail(error.message, error.status);
    return handleRouteError(error);
  }
}

