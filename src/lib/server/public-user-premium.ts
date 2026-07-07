import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/server/prisma";
import { getPublicPremiumSaleSettings } from "@/lib/server/site-settings";

export const PUBLIC_USER_PREMIUM_SETTING_PREFIX = "public_user_premium:";
export const PUBLIC_USER_PREMIUM_TRIAL_PREFIX = "public_user_premium_trial:";
export const PUBLIC_USER_PREMIUM_TRIAL_HOURS = 24;

const DEFAULT_PREMIUM_TELEGRAM_IDS: string[] = [];
const DEFAULT_PREMIUM_TELEGRAM_USERNAMES: string[] = [];

export type PublicUserPremiumSource = "manual" | "default" | "none";
export type PublicUserPremiumTier = "premium" | "premium_og" | "none";

export type PublicUserPremiumStatus = {
  telegramUserId: string;
  isPremium: boolean;
  premiumEnabled: boolean;
  premiumUntil: string | null;
  premiumSource: PublicUserPremiumSource;
  premiumTier: PublicUserPremiumTier;
  premiumExpired: boolean;
};

type StoredPremiumSetting = {
  enabled?: boolean;
  premiumUntil?: string | null;
  tier?: PublicUserPremiumTier | null;
  updatedBy?: string | null;
  updatedAt?: string | null;
};

type StoredPremiumTrial = {
  claimed?: boolean;
  claimedAt?: string | null;
  premiumUntil?: string | null;
};

function splitList(value: string | null | undefined) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeUsername(value?: string | null) {
  return String(value || "").replace(/^@/, "").trim().toLowerCase();
}

export function publicUserPremiumSettingKey(telegramUserId: string) {
  return `${PUBLIC_USER_PREMIUM_SETTING_PREFIX}${telegramUserId}`;
}

export function publicUserPremiumTrialKey(telegramUserId: string) {
  return `${PUBLIC_USER_PREMIUM_TRIAL_PREFIX}${telegramUserId}`;
}

export function isDefaultPremiumPublicUser(input: { telegramUserId: string; telegramUsername?: string | null }) {
  const premiumIds = new Set([
    ...DEFAULT_PREMIUM_TELEGRAM_IDS,
    ...splitList(process.env.PREMIUM_TELEGRAM_IDS),
  ]);
  const premiumUsernames = new Set([
    ...DEFAULT_PREMIUM_TELEGRAM_USERNAMES,
    ...splitList(process.env.PREMIUM_TELEGRAM_USERNAMES),
  ].map(normalizeUsername));

  const username = normalizeUsername(input.telegramUsername);
  return premiumIds.has(input.telegramUserId) || (username ? premiumUsernames.has(username) : false);
}

function parseStoredPremiumSetting(value: string | null | undefined): StoredPremiumSetting | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as StoredPremiumSetting;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseStoredPremiumTrial(value: string | null | undefined): StoredPremiumTrial | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as StoredPremiumTrial;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function normalizeUntil(value: unknown) {
  if (!value) return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function normalizePremiumTier(value: unknown): Exclude<PublicUserPremiumTier, "none"> {
  return value === "premium_og" ? "premium_og" : "premium";
}

function statusFromStored(telegramUserId: string, stored: StoredPremiumSetting | null, now = new Date()): PublicUserPremiumStatus | null {
  if (!stored) return null;
  const premiumUntil = normalizeUntil(stored.premiumUntil);
  const enabled = stored.enabled !== false;
  const expired = Boolean(enabled && premiumUntil && new Date(premiumUntil).getTime() <= now.getTime());
  const tier = normalizePremiumTier(stored.tier);
  return {
    telegramUserId,
    isPremium: enabled && !expired,
    premiumEnabled: enabled,
    premiumUntil,
    premiumSource: "manual",
    premiumTier: enabled ? tier : "none",
    premiumExpired: expired,
  };
}

function defaultStatus(input: { telegramUserId: string; telegramUsername?: string | null }): PublicUserPremiumStatus {
  const enabled = isDefaultPremiumPublicUser(input);
  return {
    telegramUserId: input.telegramUserId,
    isPremium: enabled,
    premiumEnabled: enabled,
    premiumUntil: null,
    premiumSource: enabled ? "default" : "none",
    premiumTier: enabled ? "premium_og" : "none",
    premiumExpired: false,
  };
}

export async function getPublicUserPremiumStatus(input: { telegramUserId: string; telegramUsername?: string | null }) {
  const setting = await prisma.systemSetting.findUnique({
    where: { key: publicUserPremiumSettingKey(input.telegramUserId) },
  });
  const manual = statusFromStored(input.telegramUserId, parseStoredPremiumSetting(setting?.value));
  return manual || defaultStatus(input);
}

export async function getPublicUserPremiumTrialStatus(input: { telegramUserId: string; isPremium?: boolean }) {
  const setting = await prisma.systemSetting.findUnique({
    where: { key: publicUserPremiumTrialKey(input.telegramUserId) },
  });
  const trial = parseStoredPremiumTrial(setting?.value);
  const claimed = Boolean(trial?.claimed);
  return {
    claimed,
    claimedAt: normalizeUntil(trial?.claimedAt),
    premiumUntil: normalizeUntil(trial?.premiumUntil),
    available: Boolean(!claimed && !input.isPremium),
    hours: PUBLIC_USER_PREMIUM_TRIAL_HOURS,
  };
}

export async function getPublicUserPremiumPurchaseInfo() {
  const settings = await getPublicPremiumSaleSettings();
  return {
    saleEnabled: settings.saleEnabled,
    purchasePrice: settings.purchasePrice,
  };
}

export async function getPublicUserPremiumStatusMap(users: Array<{ telegramUserId: string; telegramUsername?: string | null }>) {
  const uniqueUsers = Array.from(new Map(users.map((user) => [user.telegramUserId, user])).values());
  if (uniqueUsers.length === 0) return new Map<string, PublicUserPremiumStatus>();

  const settings = await prisma.systemSetting.findMany({
    where: { key: { in: uniqueUsers.map((user) => publicUserPremiumSettingKey(user.telegramUserId)) } },
  });
  const settingsById = new Map(settings.map((setting) => [setting.key.slice(PUBLIC_USER_PREMIUM_SETTING_PREFIX.length), setting.value]));
  const now = new Date();
  const result = new Map<string, PublicUserPremiumStatus>();

  for (const user of uniqueUsers) {
    const manual = statusFromStored(user.telegramUserId, parseStoredPremiumSetting(settingsById.get(user.telegramUserId)), now);
    result.set(user.telegramUserId, manual || defaultStatus(user));
  }

  return result;
}

export async function setPublicUserPremiumStatus(input: {
  telegramUserId: string;
  enabled: boolean;
  premiumUntil?: string | null;
  premiumTier?: PublicUserPremiumTier | null;
  updatedBy?: string | null;
}) {
  const premiumUntil = normalizeUntil(input.premiumUntil);
  const value = JSON.stringify({
    enabled: Boolean(input.enabled),
    premiumUntil,
    tier: input.enabled ? normalizePremiumTier(input.premiumTier) : "none",
    updatedBy: input.updatedBy || null,
    updatedAt: new Date().toISOString(),
  } satisfies StoredPremiumSetting);

  await prisma.systemSetting.upsert({
    where: { key: publicUserPremiumSettingKey(input.telegramUserId) },
    update: { value },
    create: { key: publicUserPremiumSettingKey(input.telegramUserId), value },
  });

  return getPublicUserPremiumStatus({ telegramUserId: input.telegramUserId });
}

export async function claimPublicUserPremiumTrial(input: {
  telegramUserId: string;
  telegramUsername?: string | null;
}) {
  const current = await getPublicUserPremiumStatus(input);
  if (current.isPremium) {
    throw new Error("Premium is already active for this account.");
  }

  const now = new Date();
  const premiumUntil = new Date(now.getTime() + PUBLIC_USER_PREMIUM_TRIAL_HOURS * 60 * 60 * 1000).toISOString();
  const trialKey = publicUserPremiumTrialKey(input.telegramUserId);
  const premiumKey = publicUserPremiumSettingKey(input.telegramUserId);

  await prisma.$transaction(
    async (tx) => {
      await tx.systemSetting.upsert({
        where: { key: trialKey },
        update: {},
        create: { key: trialKey, value: JSON.stringify({ claimed: false }) },
      });

      const rows = await tx.$queryRaw<Array<{ key: string; value: string }>>`
        SELECT "key", "value"
        FROM "system_settings"
        WHERE "key" = ${trialKey}
        FOR UPDATE
      `;
      const storedTrial = parseStoredPremiumTrial(rows[0]?.value);
      if (storedTrial?.claimed) {
        throw new Error("Free Premium trial has already been claimed for this account.");
      }

      const updatedAt = now.toISOString();
      await tx.systemSetting.update({
        where: { key: trialKey },
        data: {
          value: JSON.stringify({
            claimed: true,
            claimedAt: updatedAt,
            premiumUntil,
          } satisfies StoredPremiumTrial),
        },
      });

      await tx.systemSetting.upsert({
        where: { key: premiumKey },
        update: {
          value: JSON.stringify({
            enabled: true,
            premiumUntil,
            tier: "premium",
            updatedBy: "public_trial",
            updatedAt,
          } satisfies StoredPremiumSetting),
        },
        create: {
          key: premiumKey,
          value: JSON.stringify({
            enabled: true,
            premiumUntil,
            tier: "premium",
            updatedBy: "public_trial",
            updatedAt,
          } satisfies StoredPremiumSetting),
        },
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );

  return getPublicUserPremiumStatus(input);
}
