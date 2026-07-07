import { prisma } from "@/lib/server/prisma";
import { sendTelegramMessage, sendTelegramPhoto } from "@/lib/server/telegram-bot";

const SUCCESS_NOTIFY_SETTING_PREFIX = "public_user_success_tg_notify:";
const AUTO_RETRY_UNTIL_SUCCESS_SETTING_PREFIX = "public_user_auto_retry_until_success:";
export const PUBLIC_USER_DEPOSIT_RISK_SIGNED_SETTING_PREFIX = "public_user_deposit_risk_signed:";

export type PublicUserSettings = {
  successTgNotifyEnabled: boolean;
  autoRetryUntilSuccessEnabled: boolean;
  depositRiskSigned: boolean;
  depositRiskSignedAt: string | null;
};

function parseBooleanSetting(value: string | null | undefined) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function successNotifySettingKey(telegramUserId: string) {
  return `${SUCCESS_NOTIFY_SETTING_PREFIX}${telegramUserId}`;
}

function autoRetryUntilSuccessSettingKey(telegramUserId: string) {
  return `${AUTO_RETRY_UNTIL_SUCCESS_SETTING_PREFIX}${telegramUserId}`;
}

function depositRiskSignedSettingKey(telegramUserId: string) {
  return `${PUBLIC_USER_DEPOSIT_RISK_SIGNED_SETTING_PREFIX}${telegramUserId}`;
}

export function isPublicUserDepositRiskSignedValue(value: string | null | undefined) {
  const normalized = String(value || "").trim().toLowerCase();
  return Boolean(normalized) && !["0", "false", "no", "off"].includes(normalized);
}

function parseDepositRiskSignedAt(value: string | null | undefined, updatedAt?: Date | null) {
  if (!isPublicUserDepositRiskSignedValue(value)) return null;
  const date = new Date(String(value || ""));
  if (Number.isFinite(date.getTime())) return date.toISOString();
  return updatedAt ? updatedAt.toISOString() : null;
}

export async function getPublicUserSettings(telegramUserId: string): Promise<PublicUserSettings> {
  const successNotifyKey = successNotifySettingKey(telegramUserId);
  const autoRetryKey = autoRetryUntilSuccessSettingKey(telegramUserId);
  const depositRiskSignedKey = depositRiskSignedSettingKey(telegramUserId);
  const settings = await prisma.systemSetting.findMany({
    where: { key: { in: [successNotifyKey, autoRetryKey, depositRiskSignedKey] } },
    select: { key: true, value: true, updatedAt: true },
  });
  const byKey = new Map(settings.map((setting) => [setting.key, setting]));
  const depositRiskSigned = byKey.get(depositRiskSignedKey);

  return {
    successTgNotifyEnabled: parseBooleanSetting(byKey.get(successNotifyKey)?.value),
    autoRetryUntilSuccessEnabled: parseBooleanSetting(byKey.get(autoRetryKey)?.value),
    depositRiskSigned: isPublicUserDepositRiskSignedValue(depositRiskSigned?.value),
    depositRiskSignedAt: parseDepositRiskSignedAt(depositRiskSigned?.value, depositRiskSigned?.updatedAt),
  };
}

export async function updatePublicUserSettings(telegramUserId: string, updates: Partial<PublicUserSettings>) {
  const writes: Promise<unknown>[] = [];

  if (typeof updates.successTgNotifyEnabled === "boolean") {
    writes.push(prisma.systemSetting.upsert({
      where: { key: successNotifySettingKey(telegramUserId) },
      update: { value: updates.successTgNotifyEnabled ? "true" : "false" },
      create: { key: successNotifySettingKey(telegramUserId), value: updates.successTgNotifyEnabled ? "true" : "false" },
    }));
  }

  if (typeof updates.autoRetryUntilSuccessEnabled === "boolean") {
    writes.push(prisma.systemSetting.upsert({
      where: { key: autoRetryUntilSuccessSettingKey(telegramUserId) },
      update: { value: updates.autoRetryUntilSuccessEnabled ? "true" : "false" },
      create: { key: autoRetryUntilSuccessSettingKey(telegramUserId), value: updates.autoRetryUntilSuccessEnabled ? "true" : "false" },
    }));
  }

  if (typeof updates.depositRiskSigned === "boolean") {
    const value = updates.depositRiskSigned ? new Date().toISOString() : "false";
    writes.push(prisma.systemSetting.upsert({
      where: { key: depositRiskSignedSettingKey(telegramUserId) },
      update: { value },
      create: { key: depositRiskSignedSettingKey(telegramUserId), value },
    }));
  }

  if (writes.length > 0) {
    await Promise.all(writes);
  }

  return getPublicUserSettings(telegramUserId);
}

export async function setPublicUserSuccessTgNotifyEnabled(telegramUserId: string, enabled: boolean) {
  return updatePublicUserSettings(telegramUserId, { successTgNotifyEnabled: enabled });
}

export async function setPublicUserAutoRetryUntilSuccessEnabled(telegramUserId: string, enabled: boolean) {
  return updatePublicUserSettings(telegramUserId, { autoRetryUntilSuccessEnabled: enabled });
}

function telegramExtractionReason(error?: string | null) {
  const text = String(error || "").trim();
  const lower = text.toLowerCase();
  if (!text) return "Extraction failed. Please retry later or switch account/exit node.";

  if (
    lower.includes("payment_method_unavailable") ||
    lower.includes("available_payment_method_types") ||
    lower.includes("cannot create a upi payment") ||
    lower.includes("cannot create an ideal payment")
  ) {
    if (lower.includes("ideal")) {
      return "This account cannot create an IDEAL payment. Please switch account and try again.";
    }
    return "This account cannot create a UPI payment. Please switch account and try again.";
  }

  if (lower.includes("billing country must match request country") || lower.includes("billing country") || lower.includes("request country")) {
    return "This account's region is locked by OpenAI, so the billing country cannot be changed.";
  }
  if (lower.includes("bound email") || lower.includes("email already bound") || lower.includes("account has an email")) {
    return "This account is already bound to an email address, so the UPI link cannot be extracted.";
  }
  if (
    lower.includes("no valid session token") ||
    lower.includes("session token") && lower.includes("invalid") ||
    lower.includes("session cookie") && lower.includes("invalid") ||
    lower.includes("session json") && lower.includes("invalid") ||
    text.includes("没有识别到有效的 session token")
  ) {
    return "No valid session token / session cookie / session JSON was recognized.";
  }
  if (lower.includes("approve") || lower.includes("approval") || lower.includes("approve_attempts") || lower.includes('"result":"blocked"')) {
    return "UPI QR generation failed because the Approve step is temporarily blocked. Please retry later or switch account/exit node.";
  }
  if (
    lower.includes("socks5") ||
    lower.includes("econnrefused") ||
    lower.includes("authentication timeout") ||
    lower.includes("fetch failed") ||
    lower.includes("connect timeout")
  ) {
    return "UPI QR generation failed because available exit nodes are failing. Please check the proxy pool or retry later.";
  }
  if (lower.includes("upi://") || lower.includes("upi data") || lower.includes("no upi")) {
    return "UPI QR generation failed because no UPI data was returned by the payment response. Please retry later or switch account/exit node.";
  }
  if (lower.includes("http 524") || lower.includes("timeout") || lower.includes("timed out")) {
    return "The background extraction timed out. Please check the result later or submit again.";
  }

  if (/^[\x09\x0a\x0d\x20-\x7e]{1,180}$/.test(text) && !lower.includes("socks5://") && !lower.includes("approve_attempts")) {
    return text;
  }
  return "UPI QR generation failed. Please retry later or switch account/exit node.";
}

export async function notifyPublicUpiExtractResult({
  telegramUserId,
  channel,
  status,
  error,
  qrPngBuffer,
  paymentUrl,
  expiresAt,
  accountEmail,
  accountPhone,
}: {
  telegramUserId: string;
  channel: "public" | "premium";
  status: "completed" | "failed";
  error?: string | null;
  qrPngBuffer?: Buffer | Uint8Array | null;
  paymentUrl?: string | null;
  expiresAt?: string | null;
  accountEmail?: string | null;
  accountPhone?: string | null;
}) {
  const settings = await getPublicUserSettings(telegramUserId);
  if (!settings.successTgNotifyEnabled) return;

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "http://127.0.0.1:3001").replace(/\/+$/, "");
  const isCompleted = status === "completed";
  const channelText = channel === "premium" ? "Premium" : "Public";
  const accountLines = [
    ...(accountEmail ? [`Email: ${accountEmail}`] : []),
    ...(accountPhone ? [`Phone: ${accountPhone}`] : []),
  ];

  if (isCompleted && qrPngBuffer) {
    const caption = [
      "✅ UPI QR extraction completed",
      `Channel: ${channelText}`,
      ...accountLines,
      ...(expiresAt ? [`QR expires at: ${new Date(expiresAt).toLocaleString("en-US", { hour12: false })}`] : []),
      ...(paymentUrl ? ["", `Payment link: ${paymentUrl}`] : []),
      "",
      `${appUrl}/`,
    ].join("\n");

    try {
      await sendTelegramPhoto(telegramUserId, qrPngBuffer, caption);
      return;
    } catch (photoError) {
      console.error("Telegram UPI QR photo notification failed", photoError);
    }
  }

  await sendTelegramMessage(
    telegramUserId,
    [
      isCompleted ? "✅ UPI QR extraction completed" : "❌ UPI QR extraction failed",
      "",
      `Channel: ${channelText}`,
      ...accountLines,
      ...(isCompleted && paymentUrl ? [`Payment link: ${paymentUrl}`] : []),
      ...(isCompleted && expiresAt ? [`QR expires at: ${new Date(expiresAt).toLocaleString("en-US", { hour12: false })}`] : []),
      ...(isCompleted ? [] : [`Reason: ${telegramExtractionReason(error)}`]),
      isCompleted
        ? "Open the extraction page to view the QR code and payment link:"
        : "Open the extraction page to view details or submit a new task:",
      `${appUrl}/`,
    ].join("\n")
  );
}

export const notifyPublicUpiExtractSuccess = notifyPublicUpiExtractResult;
