import { prisma } from "@/lib/server/prisma";

export const TG_INVITE_URL = process.env.NEXT_PUBLIC_TG_INVITE_URL || "https://t.me/your_group";
export const SETTING_PUBLIC_TG_INVITE_ENABLED = "public_tg_invite_enabled";
export const SETTING_PUBLIC_DEPOSIT_ENABLED = "public_deposit_enabled";
export const SETTING_PUBLIC_WITHDRAW_ENABLED = "public_withdraw_enabled";
export const SETTING_PUBLIC_PREMIUM_SALE_ENABLED = "public_premium_sale_enabled";
export const SETTING_PUBLIC_PREMIUM_PURCHASE_PRICE = "public_premium_purchase_price";
export const SETTING_PUBLIC_FAQ_CONTENT = "public_faq_content";
export const SETTING_PUBLIC_FAQ_CONTENT_ZH = "public_faq_content_zh";
export const SETTING_PUBLIC_FAQ_CONTENT_EN = "public_faq_content_en";
export const SETTING_PUBLIC_EXTRACT_METHOD_SELECTION_ENABLED = "public_extract_method_selection_enabled";
export const SETTING_PUBLIC_CUSTOM_PROXY_ENABLED = "public_custom_proxy_enabled";

export const DEFAULT_PUBLIC_PREMIUM_PURCHASE_PRICE = 1.5;
export const DEFAULT_PUBLIC_FAQ_CONTENT_ZH = [
  "Q: 应该转账多少？",
  "A: 请严格支付充值订单显示的金额；钱包余额会按链上实际到账数量入账。",
  "",
  "Q: 转错金额怎么办？",
  "A: 金额可能会匹配到其他用户的有效充值订单。错误转账无法退款，也无法手动补发余额。",
  "",
  "Q: 支持哪条链？",
  "A: 仅支持 BSC / BEP20 USDT。",
].join("\n");
export const DEFAULT_PUBLIC_FAQ_CONTENT_EN = [
  "Q: What amount should I transfer?",
  "A: Pay the exact amount shown in the deposit order. The wallet balance is credited by the actual on-chain amount received.",
  "",
  "Q: What if I transfer the wrong amount?",
  "A: The amount may match another user's active deposit order. Wrong transfers cannot be refunded or manually credited.",
  "",
  "Q: Which chain is supported?",
  "A: BSC / BEP20 USDT only.",
].join("\n");
export const DEFAULT_PUBLIC_FAQ_CONTENT = DEFAULT_PUBLIC_FAQ_CONTENT_EN;

export type PublicSiteSettings = {
  tgInviteEnabled: boolean;
  tgInviteUrl: string;
  depositEnabled: boolean;
  withdrawEnabled: boolean;
  premiumSaleEnabled: boolean;
  premiumPurchasePrice: number;
  faqContent: string;
  faqContentEn: string;
  extractMethodSelectionEnabled: boolean;
  customProxyEnabled: boolean;
};

function parseBooleanSetting(value: string | null | undefined, defaultValue = false) {
  if (value === null || value === undefined) return defaultValue;
  return value === "true" || value === "1" || value === "yes";
}

function parsePositiveNumberSetting(value: string | null | undefined, defaultValue: number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return defaultValue;
  return numeric;
}

export async function getPublicSiteSettings(): Promise<PublicSiteSettings> {
  const settings = await prisma.systemSetting.findMany({
    where: {
      key: {
        in: [
          SETTING_PUBLIC_TG_INVITE_ENABLED,
          SETTING_PUBLIC_DEPOSIT_ENABLED,
          SETTING_PUBLIC_WITHDRAW_ENABLED,
          SETTING_PUBLIC_PREMIUM_SALE_ENABLED,
          SETTING_PUBLIC_PREMIUM_PURCHASE_PRICE,
          SETTING_PUBLIC_FAQ_CONTENT,
          SETTING_PUBLIC_FAQ_CONTENT_ZH,
          SETTING_PUBLIC_FAQ_CONTENT_EN,
          SETTING_PUBLIC_EXTRACT_METHOD_SELECTION_ENABLED,
          SETTING_PUBLIC_CUSTOM_PROXY_ENABLED,
        ],
      },
    },
    select: { key: true, value: true },
  });
  const values = new Map(settings.map((setting) => [setting.key, setting.value]));

  return {
    tgInviteEnabled: parseBooleanSetting(values.get(SETTING_PUBLIC_TG_INVITE_ENABLED)),
    tgInviteUrl: TG_INVITE_URL,
    depositEnabled: parseBooleanSetting(values.get(SETTING_PUBLIC_DEPOSIT_ENABLED), true),
    withdrawEnabled: parseBooleanSetting(values.get(SETTING_PUBLIC_WITHDRAW_ENABLED), false),
    premiumSaleEnabled: parseBooleanSetting(values.get(SETTING_PUBLIC_PREMIUM_SALE_ENABLED), true),
    premiumPurchasePrice: parsePositiveNumberSetting(
      values.get(SETTING_PUBLIC_PREMIUM_PURCHASE_PRICE),
      DEFAULT_PUBLIC_PREMIUM_PURCHASE_PRICE
    ),
    faqContent: values.get(SETTING_PUBLIC_FAQ_CONTENT_ZH) || DEFAULT_PUBLIC_FAQ_CONTENT_ZH,
    faqContentEn: values.get(SETTING_PUBLIC_FAQ_CONTENT_EN) || values.get(SETTING_PUBLIC_FAQ_CONTENT) || DEFAULT_PUBLIC_FAQ_CONTENT_EN,
    extractMethodSelectionEnabled: parseBooleanSetting(values.get(SETTING_PUBLIC_EXTRACT_METHOD_SELECTION_ENABLED), false),
    customProxyEnabled: parseBooleanSetting(values.get(SETTING_PUBLIC_CUSTOM_PROXY_ENABLED), false),
  };
}

async function setBooleanSetting(key: string, enabled: boolean) {
  await prisma.systemSetting.upsert({
    where: { key },
    update: { value: enabled ? "true" : "false" },
    create: { key, value: enabled ? "true" : "false" },
  });
}

export async function setPublicTgInviteEnabled(enabled: boolean) {
  await setBooleanSetting(SETTING_PUBLIC_TG_INVITE_ENABLED, enabled);
  return getPublicSiteSettings();
}

export async function setPublicDepositEnabled(enabled: boolean) {
  await setBooleanSetting(SETTING_PUBLIC_DEPOSIT_ENABLED, enabled);
  return getPublicSiteSettings();
}

export async function setPublicWithdrawEnabled(enabled: boolean) {
  await setBooleanSetting(SETTING_PUBLIC_WITHDRAW_ENABLED, enabled);
  return getPublicSiteSettings();
}

export async function setPublicPremiumSaleEnabled(enabled: boolean) {
  await setBooleanSetting(SETTING_PUBLIC_PREMIUM_SALE_ENABLED, enabled);
  return getPublicSiteSettings();
}

export async function setPublicExtractMethodSelectionEnabled(enabled: boolean) {
  await setBooleanSetting(SETTING_PUBLIC_EXTRACT_METHOD_SELECTION_ENABLED, enabled);
  return getPublicSiteSettings();
}

export async function setPublicCustomProxyEnabled(enabled: boolean) {
  await setBooleanSetting(SETTING_PUBLIC_CUSTOM_PROXY_ENABLED, enabled);
  return getPublicSiteSettings();
}

export async function setPublicFaqContent(content: string) {
  const value = String(content || "").trim().slice(0, 6000) || DEFAULT_PUBLIC_FAQ_CONTENT_ZH;
  await prisma.systemSetting.upsert({
    where: { key: SETTING_PUBLIC_FAQ_CONTENT_ZH },
    update: { value },
    create: { key: SETTING_PUBLIC_FAQ_CONTENT_ZH, value },
  });

  return getPublicSiteSettings();
}

export async function setPublicFaqContentEn(content: string) {
  const value = String(content || "").trim().slice(0, 6000) || DEFAULT_PUBLIC_FAQ_CONTENT_EN;
  await prisma.systemSetting.upsert({
    where: { key: SETTING_PUBLIC_FAQ_CONTENT_EN },
    update: { value },
    create: { key: SETTING_PUBLIC_FAQ_CONTENT_EN, value },
  });

  return getPublicSiteSettings();
}

export async function setPublicPremiumPurchasePrice(price: number) {
  const numeric = Number(price);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error("Premium 售卖价格必须大于 0");
  }

  await prisma.systemSetting.upsert({
    where: { key: SETTING_PUBLIC_PREMIUM_PURCHASE_PRICE },
    update: { value: String(numeric) },
    create: { key: SETTING_PUBLIC_PREMIUM_PURCHASE_PRICE, value: String(numeric) },
  });

  return getPublicSiteSettings();
}

export async function isPublicDepositEnabled() {
  const settings = await getPublicSiteSettings();
  return settings.depositEnabled;
}

export async function isPublicWithdrawEnabled() {
  const settings = await getPublicSiteSettings();
  return settings.withdrawEnabled;
}

export async function getPublicPremiumSaleSettings() {
  const settings = await getPublicSiteSettings();
  return {
    saleEnabled: settings.premiumSaleEnabled,
    purchasePrice: settings.premiumPurchasePrice,
  };
}
