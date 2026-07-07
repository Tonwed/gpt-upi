import { Prisma } from "@prisma/client";
import { requireAdminSession } from "@/lib/server/auth";
import { containsInsensitive, paginatedPayload, parseAdminPagination } from "@/lib/server/admin-pagination";
import { prisma } from "@/lib/server/prisma";
import { fail, handleRouteError, ok } from "@/lib/server/responses";
import { decimalToNumber } from "@/lib/server/serializers";

export const runtime = "nodejs";

type BillingTab = "deposits" | "ledgers" | "withdrawals" | "chain";

function normalizeBillingTab(value: string | null): BillingTab {
  if (value === "ledgers" || value === "withdrawals" || value === "chain") return value;
  return "deposits";
}

function money(value: unknown) {
  const amount = decimalToNumber(value as never);
  return Number(amount.toFixed(6));
}

export async function GET(request: Request) {
  try {
    await requireAdminSession();
    const { isPaged, page, pageSize, skip, take, search, url } = parseAdminPagination(request);
    const activeTab = normalizeBillingTab(url.searchParams.get("tab"));

    const ledgerWhere: Prisma.PublicUserWalletLedgerWhereInput = search
      ? {
          OR: [
            { telegramUserId: containsInsensitive(search) },
            { orderId: containsInsensitive(search) },
            { referenceId: containsInsensitive(search) },
            { note: containsInsensitive(search) },
            { wallet: { telegramUsername: containsInsensitive(search) } },
          ],
        }
      : {};
    const depositOrderWhere: Prisma.PublicUserDepositOrderWhereInput = search
      ? {
          OR: [
            { orderNo: containsInsensitive(search) },
            { telegramUserId: containsInsensitive(search) },
            { telegramUsername: containsInsensitive(search) },
            { depositAddress: containsInsensitive(search) },
            { txHash: containsInsensitive(search) },
            { fromAddress: containsInsensitive(search) },
            { wallet: { telegramUsername: containsInsensitive(search) } },
          ],
        }
      : {};
    const withdrawalWhere: Prisma.PublicUserWithdrawalRequestWhereInput = search
      ? {
          OR: [
            { id: containsInsensitive(search) },
            { telegramUserId: containsInsensitive(search) },
            { telegramUsername: containsInsensitive(search) },
            { withdrawalAddress: containsInsensitive(search) },
            { note: containsInsensitive(search) },
            { adminNote: containsInsensitive(search) },
            { wallet: { telegramUsername: containsInsensitive(search) } },
          ],
        }
      : {};
    const chainDepositWhere: Prisma.PublicChainDepositWhereInput = search
      ? {
          OR: [
            { telegramUserId: containsInsensitive(search) },
            { telegramUsername: containsInsensitive(search) },
            { txHash: containsInsensitive(search) },
            { fromAddress: containsInsensitive(search) },
            { toAddress: containsInsensitive(search) },
          ],
        }
      : {};

    const selectedTotalPromise = isPaged
      ? activeTab === "ledgers"
        ? prisma.publicUserWalletLedger.count({ where: ledgerWhere })
        : activeTab === "withdrawals"
          ? prisma.publicUserWithdrawalRequest.count({ where: withdrawalWhere })
          : activeTab === "chain"
            ? prisma.publicChainDeposit.count({ where: chainDepositWhere })
            : prisma.publicUserDepositOrder.count({ where: depositOrderWhere })
      : Promise.resolve(0);

    const [
      walletSummary,
      walletCount,
      ledgerCount,
      depositOrderSummary,
      pendingDepositOrderSummary,
      paidDepositOrderSummary,
      withdrawalSummary,
      pendingWithdrawalSummary,
      chainDepositCount,
      selectedTotal,
      ledgers,
      depositOrders,
      withdrawals,
      chainDeposits,
    ] = await Promise.all([
      prisma.publicUserWallet.aggregate({
        _sum: {
          availableBalance: true,
          frozenBalance: true,
          totalDeposited: true,
          totalSpent: true,
        },
      }),
      prisma.publicUserWallet.count(),
      prisma.publicUserWalletLedger.count(),
      prisma.publicUserDepositOrder.aggregate({
        _count: { _all: true },
        _sum: { payAmount: true },
      }),
      prisma.publicUserDepositOrder.aggregate({
        where: { status: "PENDING", expiresAt: { gt: new Date() } },
        _count: { _all: true },
        _sum: { payAmount: true },
      }),
      prisma.publicUserDepositOrder.aggregate({
        where: { status: "PAID" },
        _count: { _all: true },
        _sum: { payAmount: true },
      }),
      prisma.publicUserWithdrawalRequest.aggregate({
        _count: { _all: true },
        _sum: { totalFrozen: true },
      }),
      prisma.publicUserWithdrawalRequest.aggregate({
        where: { status: "PENDING" },
        _count: { _all: true },
        _sum: { totalFrozen: true },
      }),
      prisma.publicChainDeposit.count(),
      selectedTotalPromise,
      !isPaged || activeTab === "ledgers" ? prisma.publicUserWalletLedger.findMany({
        where: isPaged ? ledgerWhere : undefined,
        orderBy: { createdAt: "desc" },
        skip: isPaged ? skip : undefined,
        take: isPaged ? take : 300,
        include: { wallet: { select: { telegramUsername: true, availableBalance: true, frozenBalance: true } } },
      }) : Promise.resolve([]),
      !isPaged || activeTab === "deposits" ? prisma.publicUserDepositOrder.findMany({
        where: isPaged ? depositOrderWhere : undefined,
        orderBy: { createdAt: "desc" },
        skip: isPaged ? skip : undefined,
        take: isPaged ? take : 300,
        include: { wallet: { select: { telegramUsername: true, availableBalance: true, frozenBalance: true } } },
      }) : Promise.resolve([]),
      !isPaged || activeTab === "withdrawals" ? prisma.publicUserWithdrawalRequest.findMany({
        where: isPaged ? withdrawalWhere : undefined,
        orderBy: [{ status: "asc" }, { requestedAt: "desc" }],
        skip: isPaged ? skip : undefined,
        take: isPaged ? take : 300,
        include: { wallet: { select: { telegramUsername: true, availableBalance: true, frozenBalance: true } } },
      }) : Promise.resolve([]),
      !isPaged || activeTab === "chain" ? prisma.publicChainDeposit.findMany({
        where: isPaged ? chainDepositWhere : undefined,
        orderBy: { createdAt: "desc" },
        skip: isPaged ? skip : undefined,
        take: isPaged ? take : 300,
      }) : Promise.resolve([]),
    ]);

    return ok({
      summary: {
        walletCount,
        ledgerCount,
        chainDepositCount,
        availableBalance: money(walletSummary._sum.availableBalance),
        frozenBalance: money(walletSummary._sum.frozenBalance),
        totalDeposited: money(walletSummary._sum.totalDeposited),
        totalSpent: money(walletSummary._sum.totalSpent),
        depositOrderCount: depositOrderSummary._count._all,
        depositOrderAmount: money(depositOrderSummary._sum.payAmount),
        pendingDepositOrderCount: pendingDepositOrderSummary._count._all,
        pendingDepositOrderAmount: money(pendingDepositOrderSummary._sum.payAmount),
        paidDepositOrderCount: paidDepositOrderSummary._count._all,
        paidDepositOrderAmount: money(paidDepositOrderSummary._sum.payAmount),
        withdrawalCount: withdrawalSummary._count._all,
        withdrawalAmount: money(withdrawalSummary._sum.totalFrozen),
        pendingWithdrawalCount: pendingWithdrawalSummary._count._all,
        pendingWithdrawalAmount: money(pendingWithdrawalSummary._sum.totalFrozen),
      },
      ledgers: ledgers.map((item) => ({
        id: item.id,
        walletId: item.walletId,
        telegramUserId: item.telegramUserId,
        telegramUsername: item.wallet?.telegramUsername ?? null,
        type: item.type,
        availableDelta: money(item.availableDelta),
        frozenDelta: money(item.frozenDelta),
        orderId: item.orderId,
        referenceId: item.referenceId,
        note: item.note,
        createdAt: item.createdAt,
        walletAvailableBalance: money(item.wallet?.availableBalance),
        walletFrozenBalance: money(item.wallet?.frozenBalance),
      })),
      depositOrders: depositOrders.map((item) => ({
        id: item.id,
        orderNo: item.orderNo,
        walletId: item.walletId,
        telegramUserId: item.telegramUserId,
        telegramUsername: item.telegramUsername || item.wallet?.telegramUsername || null,
        baseAmount: money(item.baseAmount),
        payAmount: money(item.payAmount),
        status: item.status,
        chain: item.chain,
        tokenSymbol: item.tokenSymbol,
        depositAddress: item.depositAddress,
        txHash: item.txHash,
        logIndex: item.logIndex,
        fromAddress: item.fromAddress,
        blockNumber: item.blockNumber,
        confirmations: item.confirmations,
        expiresAt: item.expiresAt,
        paidAt: item.paidAt,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        walletAvailableBalance: money(item.wallet?.availableBalance),
        walletFrozenBalance: money(item.wallet?.frozenBalance),
      })),
      withdrawals: withdrawals.map((item) => ({
        id: item.id,
        walletId: item.walletId,
        telegramUserId: item.telegramUserId,
        telegramUsername: item.telegramUsername || item.wallet?.telegramUsername || null,
        amount: money(item.amount),
        fee: money(item.fee),
        totalFrozen: money(item.totalFrozen),
        status: item.status,
        chain: item.chain,
        tokenSymbol: item.tokenSymbol,
        withdrawalAddress: item.withdrawalAddress,
        note: item.note,
        adminNote: item.adminNote,
        requestedAt: item.requestedAt,
        processedAt: item.processedAt,
        processedBy: item.processedBy,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        walletAvailableBalance: money(item.wallet?.availableBalance),
        walletFrozenBalance: money(item.wallet?.frozenBalance),
      })),
      chainDeposits: chainDeposits.map((item) => ({
        id: item.id,
        telegramUserId: item.telegramUserId,
        telegramUsername: item.telegramUsername,
        chain: item.chain,
        tokenSymbol: item.tokenSymbol,
        tokenContract: item.tokenContract,
        txHash: item.txHash,
        logIndex: item.logIndex,
        blockNumber: item.blockNumber,
        fromAddress: item.fromAddress,
        toAddress: item.toAddress,
        amount: money(item.amount),
        confirmations: item.confirmations,
        status: item.status,
        creditedAt: item.creditedAt,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      })),
      activeTab,
      pagination: isPaged ? paginatedPayload([], { page, pageSize, total: selectedTotal, search }).pagination : undefined,
    });
  } catch (error) {
    if (error instanceof Response) return fail("未登录管理员", 401);
    return handleRouteError(error);
  }
}
