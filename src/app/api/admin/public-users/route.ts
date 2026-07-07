import { requireAdminSession } from "@/lib/server/auth";
import { paginateArray, parseAdminPagination } from "@/lib/server/admin-pagination";
import { prisma } from "@/lib/server/prisma";
import { fail, handleRouteError, ok } from "@/lib/server/responses";
import { decimalToNumber } from "@/lib/server/serializers";
import {
  getPublicUserPremiumStatusMap,
  PUBLIC_USER_PREMIUM_SETTING_PREFIX,
  type PublicUserPremiumSource,
  type PublicUserPremiumTier,
} from "@/lib/server/public-user-premium";
import {
  isPublicUserDepositRiskSignedValue,
  PUBLIC_USER_DEPOSIT_RISK_SIGNED_SETTING_PREFIX,
} from "@/lib/server/public-user-settings";

export const runtime = "nodejs";

type UserEntry = {
  id: string;
  telegramUserId: string;
  telegramUsername: string | null;
  hasWallet: boolean;
  isPremium: boolean;
  premiumEnabled: boolean;
  premiumUntil: string | null;
  premiumSource: PublicUserPremiumSource;
  premiumTier: PublicUserPremiumTier;
  premiumExpired: boolean;
  depositRiskSigned: boolean;
  depositRiskSignedAt: string | null;
  availableBalance: number;
  frozenBalance: number;
  totalDeposited: number;
  totalSpent: number;
  withdrawalCount: number;
  pendingWithdrawalCount: number;
  pendingWithdrawalAmount: number;
  ledgerCount: number;
  extractCount: number;
  scanOrderCount: number;
  createdAt: Date;
  updatedAt: Date;
};

function money(value: unknown) {
  const amount = decimalToNumber(value as never);
  return Number(amount.toFixed(6));
}

function pickEarlier(current: Date, next?: Date | null) {
  if (!next) return current;
  return next < current ? next : current;
}

function pickLater(current: Date, next?: Date | null) {
  if (!next) return current;
  return next > current ? next : current;
}

function newestUsername(current: string | null, next?: string | null) {
  const value = String(next || "").trim();
  return value || current;
}

function getOrCreateEntry(users: Map<string, UserEntry>, input: {
  telegramUserId: string;
  telegramUsername?: string | null;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}) {
  const now = new Date();
  const createdAt = input.createdAt || input.updatedAt || now;
  const updatedAt = input.updatedAt || input.createdAt || now;
  const existing = users.get(input.telegramUserId);
  if (existing) {
    existing.telegramUsername = newestUsername(existing.telegramUsername, input.telegramUsername);
    existing.createdAt = pickEarlier(existing.createdAt, createdAt);
    existing.updatedAt = pickLater(existing.updatedAt, updatedAt);
    return existing;
  }

  const entry: UserEntry = {
    id: input.telegramUserId,
    telegramUserId: input.telegramUserId,
    telegramUsername: input.telegramUsername || null,
    hasWallet: false,
    isPremium: false,
    premiumEnabled: false,
    premiumUntil: null,
    premiumSource: "none",
    premiumTier: "none",
    premiumExpired: false,
    depositRiskSigned: false,
    depositRiskSignedAt: null,
    availableBalance: 0,
    frozenBalance: 0,
    totalDeposited: 0,
    totalSpent: 0,
    withdrawalCount: 0,
    pendingWithdrawalCount: 0,
    pendingWithdrawalAmount: 0,
    ledgerCount: 0,
    extractCount: 0,
    scanOrderCount: 0,
    createdAt,
    updatedAt,
  };
  users.set(input.telegramUserId, entry);
  return entry;
}

export async function GET(request: Request) {
  try {
    await requireAdminSession();
    const { isPaged, page, pageSize, search } = parseAdminPagination(request);

    const [
      wallets,
      withdrawals,
      ledgerCounts,
      activities,
      scanOrders,
      loginChallenges,
      premiumSettings,
      depositRiskSignedSettings,
      walletSummary,
    ] = await Promise.all([
      prisma.publicUserWallet.findMany({
        orderBy: { updatedAt: "desc" },
        include: {
          _count: {
            select: {
              ledgers: true,
              withdrawals: true,
            },
          },
        },
      }),
      prisma.publicUserWithdrawalRequest.findMany({
        select: {
          telegramUserId: true,
          telegramUsername: true,
          status: true,
          totalFrozen: true,
          requestedAt: true,
          updatedAt: true,
        },
      }),
      prisma.publicUserWalletLedger.groupBy({
        by: ["telegramUserId"],
        _count: { _all: true },
      }),
      prisma.publicUpiExtractActivity.findMany({
        where: { publicUserTelegramId: { not: null } },
        select: {
          publicUserTelegramId: true,
          publicUserTelegramName: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.order.findMany({
        where: { publicUserTelegramId: { not: null } },
        select: {
          publicUserTelegramId: true,
          publicUserTelegramName: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.telegramLoginChallenge.findMany({
        where: {
          purpose: "USER",
          telegramUserId: { not: null },
          status: { in: ["USED", "APPROVED"] },
        },
        select: {
          telegramUserId: true,
          telegramUsername: true,
          createdAt: true,
          updatedAt: true,
          usedAt: true,
          approvedAt: true,
        },
      }),
      prisma.systemSetting.findMany({
        where: { key: { startsWith: PUBLIC_USER_PREMIUM_SETTING_PREFIX } },
        select: { key: true, createdAt: true, updatedAt: true },
      }),
      prisma.systemSetting.findMany({
        where: { key: { startsWith: PUBLIC_USER_DEPOSIT_RISK_SIGNED_SETTING_PREFIX } },
        select: { key: true, value: true, createdAt: true, updatedAt: true },
      }),
      prisma.publicUserWallet.aggregate({
        _sum: {
          availableBalance: true,
          frozenBalance: true,
          totalDeposited: true,
          totalSpent: true,
        },
      }),
    ]);

    const users = new Map<string, UserEntry>();

    for (const activity of activities) {
      if (!activity.publicUserTelegramId) continue;
      const entry = getOrCreateEntry(users, {
        telegramUserId: activity.publicUserTelegramId,
        telegramUsername: activity.publicUserTelegramName,
        createdAt: activity.createdAt,
        updatedAt: activity.updatedAt,
      });
      entry.extractCount += 1;
    }

    for (const login of loginChallenges) {
      if (!login.telegramUserId) continue;
      getOrCreateEntry(users, {
        telegramUserId: login.telegramUserId,
        telegramUsername: login.telegramUsername,
        createdAt: login.createdAt,
        updatedAt: login.usedAt || login.approvedAt || login.updatedAt,
      });
    }

    for (const setting of premiumSettings) {
      const telegramUserId = setting.key.slice(PUBLIC_USER_PREMIUM_SETTING_PREFIX.length);
      if (!telegramUserId) continue;
      getOrCreateEntry(users, {
        telegramUserId,
        createdAt: setting.createdAt,
        updatedAt: setting.updatedAt,
      });
    }

    for (const setting of depositRiskSignedSettings) {
      const telegramUserId = setting.key.slice(PUBLIC_USER_DEPOSIT_RISK_SIGNED_SETTING_PREFIX.length);
      if (!telegramUserId) continue;
      const entry = getOrCreateEntry(users, {
        telegramUserId,
        createdAt: setting.createdAt,
        updatedAt: setting.updatedAt,
      });
      entry.depositRiskSigned = isPublicUserDepositRiskSignedValue(setting.value);
      if (entry.depositRiskSigned) {
        const signedAt = new Date(setting.value || "");
        entry.depositRiskSignedAt = Number.isFinite(signedAt.getTime())
          ? signedAt.toISOString()
          : setting.updatedAt.toISOString();
      } else {
        entry.depositRiskSignedAt = null;
      }
    }

    for (const order of scanOrders) {
      if (!order.publicUserTelegramId) continue;
      const entry = getOrCreateEntry(users, {
        telegramUserId: order.publicUserTelegramId,
        telegramUsername: order.publicUserTelegramName,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
      });
      entry.scanOrderCount += 1;
    }

    for (const wallet of wallets) {
      const entry = getOrCreateEntry(users, {
        telegramUserId: wallet.telegramUserId,
        telegramUsername: wallet.telegramUsername,
        createdAt: wallet.createdAt,
        updatedAt: wallet.updatedAt,
      });
      entry.id = wallet.id;
      entry.hasWallet = true;
      entry.availableBalance = money(wallet.availableBalance);
      entry.frozenBalance = money(wallet.frozenBalance);
      entry.totalDeposited = money(wallet.totalDeposited);
      entry.totalSpent = money(wallet.totalSpent);
      entry.ledgerCount = wallet._count.ledgers;
    }

    for (const item of ledgerCounts) {
      const entry = getOrCreateEntry(users, { telegramUserId: item.telegramUserId });
      entry.ledgerCount = item._count._all;
    }

    for (const withdrawal of withdrawals) {
      const entry = getOrCreateEntry(users, {
        telegramUserId: withdrawal.telegramUserId,
        telegramUsername: withdrawal.telegramUsername,
        createdAt: withdrawal.requestedAt,
        updatedAt: withdrawal.updatedAt,
      });
      entry.withdrawalCount += 1;
      if (withdrawal.status === "PENDING") {
        entry.pendingWithdrawalCount += 1;
        entry.pendingWithdrawalAmount = money(entry.pendingWithdrawalAmount + money(withdrawal.totalFrozen));
      }
    }

    const premiumStatusMap = await getPublicUserPremiumStatusMap(
      Array.from(users.values()).map((user) => ({
        telegramUserId: user.telegramUserId,
        telegramUsername: user.telegramUsername,
      }))
    );

    for (const entry of users.values()) {
      const premium = premiumStatusMap.get(entry.telegramUserId);
      if (!premium) continue;
      entry.isPremium = premium.isPremium;
      entry.premiumEnabled = premium.premiumEnabled;
      entry.premiumUntil = premium.premiumUntil;
      entry.premiumSource = premium.premiumSource;
      entry.premiumTier = premium.premiumTier;
      entry.premiumExpired = premium.premiumExpired;
    }

    const normalizedSearch = search.toLowerCase();
    const sortedUsers = Array.from(users.values())
      .filter((user) => {
        if (!normalizedSearch) return true;
        return [
          user.telegramUserId,
          user.telegramUsername,
          user.id,
          user.premiumSource,
          user.premiumTier,
          user.depositRiskSigned ? "已签署" : "未签署",
          user.depositRiskSigned ? "signed" : "unsigned",
        ].some((value) => String(value || "").toLowerCase().includes(normalizedSearch));
      })
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    const pagedUsers = isPaged ? paginateArray(sortedUsers, { page, pageSize, search }) : null;

    return ok({
      users: pagedUsers ? pagedUsers.items : sortedUsers,
      pagination: pagedUsers?.pagination,
      summary: {
        userCount: sortedUsers.length,
        walletCount: wallets.length,
        availableBalance: money(walletSummary._sum.availableBalance),
        frozenBalance: money(walletSummary._sum.frozenBalance),
        totalDeposited: money(walletSummary._sum.totalDeposited),
        totalSpent: money(walletSummary._sum.totalSpent),
      },
    });
  } catch (error) {
    if (error instanceof Response) return fail("未登录管理员", 401);
    return handleRouteError(error);
  }
}
