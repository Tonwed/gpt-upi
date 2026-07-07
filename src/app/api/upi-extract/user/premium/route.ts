import { getPublicUserSession } from "@/lib/server/auth";
import { claimPublicUserPremiumTrial, getPublicUserPremiumPurchaseInfo, getPublicUserPremiumTrialStatus } from "@/lib/server/public-user-premium";
import { getPublicUserSettings } from "@/lib/server/public-user-settings";
import { getPublicUpiExtractUserActiveJobs, getPublicUpiExtractUserHistory } from "@/lib/server/public-upi-extract-queue";
import {
  getLatestPublicUserDepositOrder,
  getPublicUnifiedDepositInfo,
  getPublicUserWalletHistory,
  getPublicUserWalletSummary,
  purchasePublicUserLifetimePremium,
} from "@/lib/server/public-user-wallet";
import { fail, handleRouteError, ok } from "@/lib/server/responses";

export const runtime = "nodejs";

async function buildUserPayload() {
  const user = await getPublicUserSession();
  if (!user) return null;

  const [history, activeJobs, settings, wallet, depositOrder, walletHistory, premiumTrial, premiumPurchase] = await Promise.all([
    getPublicUpiExtractUserHistory(user.telegramUserId),
    getPublicUpiExtractUserActiveJobs(user.telegramUserId),
    getPublicUserSettings(user.telegramUserId),
    getPublicUserWalletSummary(user),
    getLatestPublicUserDepositOrder(user),
    getPublicUserWalletHistory(user),
    getPublicUserPremiumTrialStatus({ telegramUserId: user.telegramUserId, isPremium: user.isPremium }),
    getPublicUserPremiumPurchaseInfo(),
  ]);

  return {
    user,
    history,
    activeJobs,
    settings,
    wallet,
    deposit: getPublicUnifiedDepositInfo(),
    depositOrder,
    walletHistory,
    premium: {
      purchasePrice: premiumPurchase.purchasePrice,
      saleEnabled: premiumPurchase.saleEnabled,
      trialHours: premiumTrial.hours,
      trialClaimed: premiumTrial.claimed,
      trialAvailable: premiumTrial.available,
      trialClaimedAt: premiumTrial.claimedAt,
      trialPremiumUntil: premiumTrial.premiumUntil,
    },
  };
}

export async function POST(request: Request) {
  try {
    const user = await getPublicUserSession();
    if (!user) return fail("Please log in with Telegram first.", 401);

    const body = (await request.json().catch(() => ({}))) as { action?: string };
    const action = String(body.action || "").trim();

    if (action === "purchase") {
      await purchasePublicUserLifetimePremium(user);
    } else if (action === "claimTrial") {
      await claimPublicUserPremiumTrial(user);
    } else {
      return fail("Unknown Premium action.", 400);
    }

    const payload = await buildUserPayload();
    if (!payload) return fail("Please log in with Telegram first.", 401);
    return ok(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (
      message.includes("Premium") ||
      message.includes("Free Premium trial") ||
      message.includes("sale") ||
      message.includes("余额不足") ||
      message.includes("用户钱包")
    ) {
      return fail(message, 400);
    }
    return handleRouteError(error);
  }
}
