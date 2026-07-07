import { Prisma } from "@prisma/client";
import { getPublicUserSession } from "@/lib/server/auth";
import { getPublicUserPremiumPurchaseInfo, getPublicUserPremiumTrialStatus } from "@/lib/server/public-user-premium";
import { getPublicUserSettings } from "@/lib/server/public-user-settings";
import { getPublicUpiExtractUserActiveJobs, getPublicUpiExtractUserHistory } from "@/lib/server/public-upi-extract-queue";
import { prisma } from "@/lib/server/prisma";
import {
  getLatestPublicUserDepositOrder,
  getPublicUnifiedDepositInfo,
  getPublicUserWalletHistory,
  redeemRechargeCdk,
} from "@/lib/server/public-user-wallet";
import { fail, handleRouteError, ok } from "@/lib/server/responses";

export const runtime = "nodejs";

const CDK_REDEEM_RATE_LIMIT_WINDOW_MS = 60_000;
const CDK_REDEEM_RATE_LIMIT_COUNT = 5;

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

async function assertCdkRedeemRateLimit(telegramUserId: string) {
  const key = `public_cdk_redeem_rate:${telegramUserId}`;
  const now = Date.now();
  const cutoff = now - CDK_REDEEM_RATE_LIMIT_WINDOW_MS;

  await prisma.$transaction(
    async (tx) => {
      await tx.systemSetting.upsert({
        where: { key },
        update: {},
        create: { key, value: "[]" },
      });
      const rows = await tx.$queryRaw<Array<{ value: string }>>`
        SELECT "value"
        FROM "system_settings"
        WHERE "key" = ${key}
        FOR UPDATE
      `;
      const raw = rows[0]?.value || "[]";
      let timestamps: number[] = [];
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          timestamps = parsed.map((item) => Number(item)).filter((item) => Number.isFinite(item));
        }
      } catch {
        timestamps = [];
      }

      const recent = timestamps.filter((item) => item >= cutoff);
      if (recent.length >= CDK_REDEEM_RATE_LIMIT_COUNT) {
        throw new Error("CDK 兑换太频繁，请 1 分钟后再试。");
      }
      recent.push(now);

      await tx.systemSetting.update({
        where: { key },
        data: { value: JSON.stringify(recent.slice(-CDK_REDEEM_RATE_LIMIT_COUNT)) },
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

export async function POST(request: Request) {
  try {
    const user = await getPublicUserSession();
    if (!user) return fail("请先登录 Telegram 账户。", 401);

    const body = (await request.json().catch(() => ({}))) as { code?: unknown };
    await assertCdkRedeemRateLimit(user.telegramUserId);
    const redeem = await redeemRechargeCdk(user, { code: body.code });
    const [history, activeJobs, settings, depositOrder, walletHistory, premium] = await Promise.all([
      getPublicUpiExtractUserHistory(user.telegramUserId),
      getPublicUpiExtractUserActiveJobs(user.telegramUserId),
      getPublicUserSettings(user.telegramUserId),
      getLatestPublicUserDepositOrder(user),
      getPublicUserWalletHistory(user),
      getPremiumInfo(user),
    ]);

    return ok({
      redeem,
      user,
      history,
      activeJobs,
      settings,
      wallet: redeem.wallet,
      deposit: getPublicUnifiedDepositInfo(),
      depositOrder,
      walletHistory,
      premium,
    });
  } catch (error) {
    if (error instanceof Response) return fail("请先登录 Telegram 账户。", 401);
    const message = error instanceof Error ? error.message : "CDK 兑换失败";
    if (message.includes("CDK") || message.includes("兑换") || message.includes("频繁")) return fail(message);
    return handleRouteError(error);
  }
}
