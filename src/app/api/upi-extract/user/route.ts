import { clearPublicUserCookie, getPublicUserSession } from "@/lib/server/auth";
import { isBscDepositWatcherDisabled, scanBscUsdtDepositsOnce } from "@/lib/server/bsc-deposit-watcher";
import { getPublicUserPremiumPurchaseInfo, getPublicUserPremiumTrialStatus } from "@/lib/server/public-user-premium";
import { getPublicUserSettings, updatePublicUserSettings } from "@/lib/server/public-user-settings";
import { getPublicUpiExtractUserActiveJobs, getPublicUpiExtractUserHistoryPage } from "@/lib/server/public-upi-extract-queue";
import {
  getLatestPublicUserDepositOrder,
  getPublicUnifiedDepositInfo,
  getPublicUserWalletHistory,
  getPublicUserWalletSummary,
} from "@/lib/server/public-user-wallet";
import { fail, handleRouteError, ok } from "@/lib/server/responses";

export const runtime = "nodejs";

const SCAN_THROTTLE_MS = 15_000;
const USER_HISTORY_PAGE_SIZE = 10;

type UserRouteGlobal = typeof globalThis & {
  __upiLastUserDepositScanAt?: number;
  __upiUserDepositScanPromise?: Promise<void> | null;
};

async function scanDepositsBestEffort() {
  if (isBscDepositWatcherDisabled()) return;
  const store = globalThis as UserRouteGlobal;
  const now = Date.now();
  if (store.__upiUserDepositScanPromise) {
    await store.__upiUserDepositScanPromise.catch(() => undefined);
    return;
  }
  if (store.__upiLastUserDepositScanAt && now - store.__upiLastUserDepositScanAt < SCAN_THROTTLE_MS) {
    return;
  }
  store.__upiLastUserDepositScanAt = now;
  store.__upiUserDepositScanPromise = scanBscUsdtDepositsOnce()
    .then((result) => {
      if (result.credited > 0) {
        console.log(`BSC USDT deposit scan from user refresh: scanned=${result.scanned}, credited=${result.credited}`);
      }
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`BSC USDT deposit scan from user refresh failed: ${message}`);
    })
    .finally(() => {
      store.__upiUserDepositScanPromise = null;
    });
  await store.__upiUserDepositScanPromise;
}

async function getPremiumInfo(user: NonNullable<Awaited<ReturnType<typeof getPublicUserSession>>>) {
  const [trial, purchase] = await Promise.all([
    getPublicUserPremiumTrialStatus({
      telegramUserId: user.telegramUserId,
      isPremium: user.isPremium,
    }),
    getPublicUserPremiumPurchaseInfo(),
  ]);
  return {
    purchasePrice: purchase.purchasePrice,
    saleEnabled: purchase.saleEnabled,
    trialHours: trial.hours,
    trialClaimed: trial.claimed,
    trialAvailable: trial.available,
    trialClaimedAt: trial.claimedAt,
    trialPremiumUntil: trial.premiumUntil,
  };
}

function parseHistoryParams(request?: Request) {
  const url = request ? new URL(request.url) : null;
  const page = Math.max(1, Math.floor(Number(url?.searchParams.get("historyPage") || 1) || 1));
  const pageSize = Math.max(1, Math.min(50, Math.floor(Number(url?.searchParams.get("historyPageSize") || USER_HISTORY_PAGE_SIZE) || USER_HISTORY_PAGE_SIZE)));
  const status = url?.searchParams.get("historyStatus") || "all";
  return { page, pageSize, status };
}

function emptyHistoryPagination(params = parseHistoryParams()) {
  return {
    page: params.page,
    pageSize: params.pageSize,
    total: 0,
    totalPages: 1,
    hasPrev: false,
    hasNext: false,
    search: "",
  };
}

function emptyHistoryCounts() {
  return { all: 0, active: 0, completed: 0, failed: 0 };
}

async function getPublicUserPayload(
  user: NonNullable<Awaited<ReturnType<typeof getPublicUserSession>>>,
  historyParams = parseHistoryParams()
) {
  const [historyPage, activeJobs, settings, wallet, depositOrder, walletHistory, premium] = await Promise.all([
    getPublicUpiExtractUserHistoryPage({
      telegramUserId: user.telegramUserId,
      page: historyParams.page,
      pageSize: historyParams.pageSize,
      status: historyParams.status,
    }),
    getPublicUpiExtractUserActiveJobs(user.telegramUserId),
    getPublicUserSettings(user.telegramUserId),
    getPublicUserWalletSummary(user),
    getLatestPublicUserDepositOrder(user),
    getPublicUserWalletHistory(user),
    getPremiumInfo(user),
  ]);
  return {
    user,
    history: historyPage.items,
    historyPagination: historyPage.pagination,
    historyCounts: historyPage.counts,
    historyFilter: historyPage.filter,
    activeJobs,
    settings,
    wallet,
    deposit: getPublicUnifiedDepositInfo(),
    depositOrder,
    walletHistory,
    premium,
  };
}

function getPublicUserGuestPayload(historyParams = parseHistoryParams()) {
  return {
    user: null,
    history: [],
    historyPagination: emptyHistoryPagination(historyParams),
    historyCounts: emptyHistoryCounts(),
    historyFilter: "all",
    activeJobs: [],
    settings: {
      successTgNotifyEnabled: false,
      autoRetryUntilSuccessEnabled: false,
      depositRiskSigned: false,
      depositRiskSignedAt: null,
    },
    wallet: null,
    deposit: null,
    depositOrder: null,
    walletHistory: [],
    premium: null,
  };
}

export async function GET(request: Request) {
  try {
    const historyParams = parseHistoryParams(request);
    const user = await getPublicUserSession();
    if (user) {
      await scanDepositsBestEffort();
    }
    return ok(user ? await getPublicUserPayload(user, historyParams) : getPublicUserGuestPayload(historyParams));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE() {
  const response = ok(getPublicUserGuestPayload());
  clearPublicUserCookie(response);
  return response;
}

export async function PATCH(request: Request) {
  try {
    const user = await getPublicUserSession();
    if (!user) return fail("请先登录 Telegram 账户。", 401);

    const body = (await request.json().catch(() => ({}))) as {
      successTgNotifyEnabled?: boolean;
      autoRetryUntilSuccessEnabled?: boolean;
      depositRiskSigned?: boolean;
    };
    const settings = await updatePublicUserSettings(user.telegramUserId, {
      ...(typeof body.successTgNotifyEnabled === "boolean" ? { successTgNotifyEnabled: body.successTgNotifyEnabled } : {}),
      ...(typeof body.autoRetryUntilSuccessEnabled === "boolean" ? { autoRetryUntilSuccessEnabled: body.autoRetryUntilSuccessEnabled } : {}),
      ...(typeof body.depositRiskSigned === "boolean" ? { depositRiskSigned: body.depositRiskSigned } : {}),
    });
    const payload = await getPublicUserPayload(user, parseHistoryParams(request));
    return ok({ ...payload, settings });
  } catch (error) {
    return handleRouteError(error);
  }
}
