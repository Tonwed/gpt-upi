import QRCode from "qrcode";
import { randomUUID } from "crypto";
import { describeUpstreamProxy, fetchWithUpstreamProxy, getUpstreamProxyPlan, normalizeCustomUpstreamProxyUrl, type UpstreamProxyPool } from "@/lib/server/upstream-proxy";

const SESSION_URL = "https://chatgpt.com/api/auth/session";
const ACCOUNT_CHECK_URL = "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27";
const ACCOUNT_CHECK_TIMEZONE_OFFSET_MIN = "-480";
const CHECKOUT_URL = "https://chatgpt.com/backend-api/payments/checkout";
const CHECKOUT_SNAPSHOT_URL = "https://chatgpt.com/backend-api/payments/checkout/snapshot";
const CHECKOUT_CONFIRM_URL = "https://chatgpt.com/backend-api/payments/checkout/confirm";
const CHECKOUT_APPROVE_URL = "https://chatgpt.com/backend-api/payments/checkout/approve";
const STRIPE_PAYMENT_PAGE_INIT_URL = "https://api.stripe.com/v1/payment_pages/{checkout_session_id}/init";
const STRIPE_PAYMENT_PAGE_CONFIRM_URL = "https://api.stripe.com/v1/payment_pages/{checkout_session_id}/confirm";
const STRIPE_PAYMENT_PAGE_GET_URL = "https://api.stripe.com/v1/payment_pages/{checkout_session_id}";
const STRIPE_ELEMENTS_SESSIONS_URL = "https://api.stripe.com/v1/elements/sessions";
const STRIPE_VERSION = "2025-03-31.basil; checkout_server_update_beta=v1; checkout_manual_approval_preview=v1";
const STRIPE_JS_SDK_VERSION = "3eeb60efc5";
const STRIPE_RV_TS = "2024-01-01 00:00:00 -0000";
const STRIPE_RV = "3eeb60efc554e1de356807017990ea438f6b156a";
const STRIPE_SV = "971bc6188a741072452a935de1be7526fa781f1e88e8adb8447145c67b902767";
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_APPROVAL_ATTEMPTS = 60;
const MAX_APPROVAL_ATTEMPTS = 80;

const SESSION_COOKIE_NAMES = [
  "__Secure-next-auth.session-token",
  "next-auth.session-token",
  "__Secure-authjs.session-token",
  "authjs.session-token",
] as const;

const ACCESS_TOKEN_RE = /(?<![A-Za-z0-9_-])(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)(?!\.[A-Za-z0-9_-])/;
const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+$/;

type JsonObject = Record<string, unknown>;

type ResolvedCredential = {
  accessToken: string;
  sessionData: JsonObject | null;
};

type UpiQrData = {
  upiUri?: string;
  mobileAuthUrl?: string;
  hostedInstructionsUrl?: string;
  qrImageUrlSvg?: string;
  qrImageUrlPng?: string;
  expiresAt?: number;
};

export type ExtractedUpiQr = {
  checkoutSessionId: string;
  publishableKey: string;
  processorEntity: string;
  upiUri: string;
  hostedInstructionsUrl?: string;
  expiresAt: number;
  qrPngBuffer: Buffer;
  steps: Array<{ name: string; status: number; state?: unknown; result?: unknown; attemptStatuses?: number[] }>;
};

export type ExtractedIdealPayment = {
  checkoutSessionId: string;
  publishableKey: string;
  processorEntity: string;
  paymentUrl: string;
  chatGptPaymentUrl: string;
  expiresAt: number;
  qrPngBuffer: Buffer;
  paymentMethodTypes: string[];
  steps: Array<{ name: string; status: number; state?: unknown; result?: unknown; attemptStatuses?: number[] }>;
};

export type UpiExtractionStage =
  | "queued"
  | "validating"
  | "checkout"
  | "stripe_init"
  | "stripe_confirm"
  | "approval"
  | "waiting_qr"
  | "hydrating"
  | "rendering_qr"
  | "completed"
  | "retrying";

export type UpiExtractionProgress = {
  stage: UpiExtractionStage;
  percent: number;
  proxy?: string;
  attempt?: number;
  maxAttempts?: number;
};

export type UpiExtractionDebugEvent = {
  level?: "debug" | "info" | "warn" | "error";
  message: string;
  stage?: UpiExtractionStage;
  percent?: number;
  proxy?: string;
  attempt?: number;
  maxAttempts?: number;
  details?: unknown;
};

export type UpiExtractionOptions = {
  maxProxyAttempts?: number;
  approvalAttempts?: number;
  approvalParallelism?: number;
  proxyPool?: UpstreamProxyPool;
  experimentalSnapshot?: boolean;
  experimentalElementsSession?: boolean;
  experimentalSubmissionAttemptId?: boolean;
  experimentalProxyUrls?: string[];
  checkoutProxyUrl?: string;
  providerProxyUrl?: string;
  shouldCancel?: () => boolean | Promise<boolean>;
  onProgress?: (progress: UpiExtractionProgress) => void;
  onDebug?: (event: UpiExtractionDebugEvent) => void;
};

type InternalUpiExtractionOptions = UpiExtractionOptions & {
  approvalProxyAttempts?: ProxyAttempt[];
};

export type ChatGptSubscriptionCheck = {
  planType: string;
  isPlus: boolean;
  checkedAt: string;
  proxy: string;
};

export type ChatGptAccountContact = {
  accountEmail?: string;
  accountPhone?: string;
};

export class EmailBoundError extends Error {
  email: string;

  constructor(email: string) {
    super(email ? `该账号已绑定邮箱 ${email}，无法提取 UPI 链接` : "该账号已绑定邮箱，无法提取 UPI 链接");
    this.name = "EmailBoundError";
    this.email = email;
  }
}

export class UpiQrUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpiQrUnavailableError";
  }
}

export class IdealPaymentUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdealPaymentUnavailableError";
  }
}

export class PaymentMethodUnavailableError extends Error {
  method: "upi" | "ideal";
  availablePaymentMethodTypes: string[];

  constructor(method: "upi" | "ideal", availablePaymentMethodTypes: string[] = []) {
    const methodLabel = method.toUpperCase();
    const article = method === "ideal" ? "an" : "a";
    const availableText = availablePaymentMethodTypes.length > 0
      ? ` available_payment_method_types=${availablePaymentMethodTypes.join(",")}`
      : "";
    super(`PAYMENT_METHOD_UNAVAILABLE:${methodLabel}: This account cannot create ${article} ${methodLabel} payment. Please switch account and try again.${availableText}`);
    this.name = "PaymentMethodUnavailableError";
    this.method = method;
    this.availablePaymentMethodTypes = availablePaymentMethodTypes;
  }
}

export class BillingCountryLockedError extends Error {
  constructor() {
    super("该账号地区已被 OpenAI 锁定，无法更改账单地址。");
    this.name = "BillingCountryLockedError";
  }
}

export class NoFreeTrialError extends Error {
  proxyConfirmations: string[];

  constructor(proxyConfirmations: string[] = []) {
    super("NO_FREE_TRIAL: This account does not have the free trial offer. Please use another account.");
    this.name = "NoFreeTrialError";
    this.proxyConfirmations = proxyConfirmations;
  }
}

function jsonLoadsMaybe(value: unknown) {
  if (value && typeof value === "object") return value;
  const text = String(value || "").trim();
  if (!text || !"{[".includes(text[0])) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getString(obj: JsonObject | null | undefined, key: string) {
  const value = obj?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function jsonGetAccessToken(value: unknown) {
  const obj = jsonLoadsMaybe(value);
  if (!isObject(obj)) return "";

  for (const key of ["accessToken", "access_token", "token"]) {
    const token = getString(obj, key);
    if (token) return token;
  }

  const data = obj.data;
  if (isObject(data)) {
    for (const key of ["accessToken", "access_token", "token"]) {
      const token = getString(data, key);
      if (token) return token;
    }
  }

  return "";
}

function extractAccessToken(value: unknown) {
  const text = String(value || "").trim();
  const jsonToken = jsonGetAccessToken(value);
  if (jsonToken) return jsonToken;
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(text)) return text;
  return ACCESS_TOKEN_RE.exec(text)?.[0] || "";
}

function sessionCookieHeader(sessionToken: string) {
  const token = sessionToken.trim();
  if (!token) return "";
  return SESSION_COOKIE_NAMES.slice(0, 2).map((name) => `${name}=${token}`).join("; ");
}

function extractCookiePairsFromJson(value: unknown): Array<[string, string]> {
  const obj = jsonLoadsMaybe(value);
  if (!obj) return [] as Array<[string, string]>;

  if (isObject(obj)) {
    const sessionToken = getString(obj, "sessionToken") || getString(obj, "session_token");
    if (sessionToken) return [[SESSION_COOKIE_NAMES[0], sessionToken], [SESSION_COOKIE_NAMES[1], sessionToken]];
  }

  const cookies = Array.isArray(obj)
    ? obj
    : isObject(obj) && Array.isArray(obj.cookies)
      ? obj.cookies
      : [];

  const pairs: Array<[string, string]> = [];
  for (const item of cookies) {
    if (!isObject(item)) continue;
    const name = getString(item, "name");
    const cookieValue = getString(item, "value");
    if (name && cookieValue) pairs.push([name, cookieValue]);
  }
  return pairs;
}

function extractCookiePairsFromText(value: unknown): Array<[string, string]> {
  let text = String(value || "").trim();
  if (!text) return [] as Array<[string, string]>;
  if (text.toLowerCase().startsWith("cookie:")) text = text.split(":", 2)[1]?.trim() || "";

  const pairs: Array<[string, string]> = [];
  for (const part of text.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const cookieValue = trimmed.slice(eq + 1).trim();
    if (name && cookieValue) pairs.push([name, cookieValue]);
  }
  return pairs;
}

function withSessionCookieAliases(pairs: Array<[string, string]>): Array<[string, string]> {
  const nextPairs = pairs.filter(([name, value]) => Boolean(name && value));
  const existing = new Set(nextPairs.map(([name]) => name));
  const sessionValue = nextPairs.find(([name]) => SESSION_COOKIE_NAMES.includes(name as (typeof SESSION_COOKIE_NAMES)[number]))?.[1] || "";
  if (sessionValue) {
    for (const name of SESSION_COOKIE_NAMES.slice(0, 2)) {
      if (!existing.has(name)) nextPairs.push([name, sessionValue]);
    }
  }
  return nextPairs;
}

function extractSessionCookie(value: unknown) {
  const text = String(value || "").trim();
  if (!text) return "";

  const pairs = extractCookiePairsFromJson(value);
  const textPairs = pairs.length ? pairs : extractCookiePairsFromText(value);
  if (textPairs.length && textPairs.some(([name]) => SESSION_COOKIE_NAMES.includes(name as (typeof SESSION_COOKIE_NAMES)[number]))) {
    return withSessionCookieAliases(textPairs).map(([name, cookieValue]) => `${name}=${cookieValue}`).join("; ");
  }

  if (SESSION_TOKEN_RE.test(text)) return sessionCookieHeader(text);
  return "";
}

export function hasRecognizedSessionCredential(value: unknown) {
  return Boolean(extractAccessToken(value) || extractSessionCookie(value));
}

function decodeJwtPayload(token: string) {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(normalized, "base64").toString("utf8")) as JsonObject;
  } catch {
    return null;
  }
}

function getNestedString(obj: unknown, path: string[]) {
  let current: unknown = obj;
  for (const key of path) {
    if (!isObject(current)) return "";
    current = current[key];
  }
  return typeof current === "string" ? current.trim() : "";
}

function getBoundEmail(sessionData: JsonObject | null, accessToken: string) {
  const sessionEmail =
    getNestedString(sessionData, ["user", "email"]) ||
    getNestedString(sessionData, ["account", "email"]) ||
    getNestedString(sessionData, ["email"]);
  if (sessionEmail) return sessionEmail;

  const payload = decodeJwtPayload(accessToken);
  return (
    getNestedString(payload, ["email"]) ||
    getNestedString(payload, ["https://api.openai.com/profile", "email"]) ||
    getNestedString(payload, ["profile", "email"])
  );
}

function normalizeAccountContactValue(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function getNestedContactString(obj: unknown, path: string[]) {
  let current: unknown = obj;
  for (const key of path) {
    if (!isObject(current)) return "";
    current = current[key];
  }
  return normalizeAccountContactValue(current);
}

function getBoundPhone(sessionData: JsonObject | null, accessToken: string) {
  const paths = [
    ["user", "phone_number"],
    ["user", "phoneNumber"],
    ["user", "phone"],
    ["account", "phone_number"],
    ["account", "phoneNumber"],
    ["account", "phone"],
    ["profile", "phone_number"],
    ["profile", "phoneNumber"],
    ["profile", "phone"],
    ["phone_number"],
    ["phoneNumber"],
    ["phone"],
  ];

  for (const path of paths) {
    const value = getNestedContactString(sessionData, path);
    if (value) return value;
  }

  const payload = decodeJwtPayload(accessToken);
  for (const path of [
    ["phone_number"],
    ["phoneNumber"],
    ["phone"],
    ["https://api.openai.com/profile", "phone_number"],
    ["https://api.openai.com/profile", "phoneNumber"],
    ["https://api.openai.com/profile", "phone"],
    ["profile", "phone_number"],
    ["profile", "phoneNumber"],
    ["profile", "phone"],
  ]) {
    const value = getNestedContactString(payload, path);
    if (value) return value;
  }

  return "";
}

function getAccountContactInfo(sessionData: JsonObject | null, accessToken: string): ChatGptAccountContact {
  const accountEmail = getBoundEmail(sessionData, accessToken);
  const accountPhone = getBoundPhone(sessionData, accessToken);
  return {
    ...(accountEmail ? { accountEmail } : {}),
    ...(accountPhone ? { accountPhone } : {}),
  };
}

function getSubscriptionPlanType(sessionData: JsonObject | null) {
  return (
    getNestedString(sessionData, ["account", "planType"]) ||
    getNestedString(sessionData, ["account", "plan_type"]) ||
    getNestedString(sessionData, ["account", "plan"]) ||
    getNestedString(sessionData, ["account", "subscription", "planType"]) ||
    getNestedString(sessionData, ["account", "subscription", "plan_type"]) ||
    getNestedString(sessionData, ["planType"]) ||
    getNestedString(sessionData, ["plan_type"]) ||
    ""
  ).trim();
}

function normalizePlanValue(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isPlusPlanValue(value: unknown) {
  const plan = normalizePlanValue(value);
  return plan === "plus" || plan === "chatgptplusplan" || (plan.includes("plus") && !plan.includes("free"));
}

function getAccountCheckUrl() {
  const url = new URL(ACCOUNT_CHECK_URL);
  url.searchParams.set("timezone_offset_min", process.env.CHATGPT_TIMEZONE_OFFSET_MIN || ACCOUNT_CHECK_TIMEZONE_OFFSET_MIN);
  return url.toString();
}

function accountCheckHeaders(token: string, cookie = "") {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    Origin: "https://chatgpt.com",
    Referer: "https://chatgpt.com/",
    "OAI-Language": "zh-CN",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  };
  if (cookie) headers.Cookie = cookie;
  return headers;
}

function collectAccountCheckCandidates(data: unknown) {
  const candidates: unknown[] = [];
  const accounts = isObject(data) && isObject(data.accounts) ? data.accounts : null;
  if (!accounts) return isObject(data) ? [data] : candidates;

  if (accounts.default) candidates.push(accounts.default);
  for (const [key, value] of Object.entries(accounts)) {
    if (key !== "default") candidates.push(value);
  }
  return candidates;
}

function getAccountCheckSubscriptionStatus(data: unknown) {
  const plans: string[] = [];
  let hasActivePlusSubscription = false;

  for (const candidate of collectAccountCheckCandidates(data)) {
    const account = isObject(candidate) && isObject(candidate.account) ? candidate.account : candidate;
    const entitlement = isObject(candidate) && isObject(candidate.entitlement) ? candidate.entitlement : null;

    for (const value of [
      isObject(account) ? account.plan_type : undefined,
      isObject(account) ? account.planType : undefined,
      isObject(account) ? account.plan : undefined,
      getNestedString(account, ["subscription", "plan_type"]),
      getNestedString(account, ["subscription", "planType"]),
    ]) {
      const plan = normalizePlanValue(value);
      if (plan) plans.push(plan);
    }

    const subscriptionPlan = normalizePlanValue(entitlement?.subscription_plan);
    if (subscriptionPlan) plans.push(subscriptionPlan);
    if (entitlement?.has_active_subscription === true && isPlusPlanValue(subscriptionPlan)) {
      hasActivePlusSubscription = true;
    }
  }

  const plusPlan = plans.find(isPlusPlanValue);
  return {
    planType: plusPlan || plans[0] || "unknown",
    isPlus: Boolean(plusPlan || hasActivePlusSubscription),
  };
}

function requestHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    Origin: "https://chatgpt.com",
    Referer: "https://chatgpt.com/",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  };
}

function sessionHeaders(cookie: string) {
  return {
    Accept: "application/json",
    Cookie: cookie,
    Origin: "https://chatgpt.com",
    Referer: "https://chatgpt.com/",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  };
}

function boolFromEnv(value: unknown) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function addStripeElementsClientParams(params: URLSearchParams, stripeJsId: string, locale = "en", elementsSessionId = "") {
  params.set("elements_session_client[client_betas][0]", "custom_checkout_server_updates_1");
  params.set("elements_session_client[client_betas][1]", "custom_checkout_manual_approval_1");
  params.set("elements_session_client[elements_init_source]", "custom_checkout");
  params.set("elements_session_client[referrer_host]", "chatgpt.com");
  if (elementsSessionId) params.set("elements_session_client[session_id]", elementsSessionId);
  params.set("elements_session_client[stripe_js_id]", stripeJsId);
  params.set("elements_session_client[locale]", locale);
  params.set("elements_session_client[is_aggregation_expected]", "false");
  params.set("elements_options_client[saved_payment_method][enable_save]", "auto");
  params.set("elements_options_client[saved_payment_method][enable_redisplay]", "auto");
}

function stripeInitForm(publishableKey: string, locale = "en", initMode: "custom" | "hosted" = "custom", stripeJsId = randomUUID().replace(/-/g, "")) {
  if (initMode === "hosted") {
    return new URLSearchParams({
      key: publishableKey,
      eid: "NA",
      browser_locale: locale,
      browser_timezone: "Asia/Shanghai",
      redirect_type: "url",
    });
  }

  const params = new URLSearchParams({
    browser_locale: locale,
    browser_timezone: "Asia/Shanghai",
    key: publishableKey,
    _stripe_version: STRIPE_VERSION,
  });
  addStripeElementsClientParams(params, stripeJsId, locale);
  return params;
}

function stripeInitHeaders(initMode: "custom" | "hosted" = "custom", checkoutSessionId = "") {
  if (initMode === "hosted") {
    return {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "https://pay.openai.com",
      Referer: checkoutSessionId ? `https://pay.openai.com/c/pay/${encodeURIComponent(checkoutSessionId)}` : "https://pay.openai.com/",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    };
  }
  return {
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
    Origin: "https://js.stripe.com",
    Referer: "https://js.stripe.com/",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  };
}

function stripeConfirmHeaders(checkoutSessionId = "") {
  return {
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
    Origin: "https://js.stripe.com",
    Referer: checkoutSessionId ? `https://js.stripe.com/v3/elements-inner-payment-${encodeURIComponent(checkoutSessionId)}.html` : "https://js.stripe.com/",
    "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  };
}

function checkoutActionHeaders(token: string, checkoutSessionId: string, processorEntity: string) {
  return {
    ...requestHeaders(token),
    Referer: `https://chatgpt.com/checkout/${processorEntity}/${checkoutSessionId}`,
    "X-OpenAI-Target-Path": `/checkout/${processorEntity}/${checkoutSessionId}`,
    "X-OpenAI-Target-Route": "/checkout/[processorEntity]/[checkoutSessionId]",
    "OAI-Language": "zh-CN",
    "OAI-Chat-Web-Route": "/checkout/[processorEntity]/[checkoutSessionId]",
  };
}

function looksLikeCloudflareChallenge(text: string) {
  const lowered = text.toLowerCase();
  return lowered.includes("_cf_chl_opt") || lowered.includes("enable javascript and cookies to continue") || lowered.includes("cf-chl");
}

function compactError(data: unknown) {
  const value = isObject(data)
    ? data.error || data.message || data.detail || data
    : data;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text
    .replace(ACCESS_TOKEN_RE, "<JWT_REDACTED>")
    .replace(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+/g, "<SESSION_TOKEN_REDACTED>")
    .slice(0, 500);
}

async function fetchText(url: string, init: RequestInit = {}, proxyUrl = "") {
  const response = await fetchWithUpstreamProxy(url, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    cache: "no-store",
  }, proxyUrl);
  const text = await response.text();
  if (looksLikeCloudflareChallenge(text)) {
    return {
      status: 502,
      data: { error: "请求被 Cloudflare 拦截，请稍后重试或更换服务器出口。" },
      response,
    };
  }
  try {
    return { status: response.status, data: JSON.parse(text || "{}") as unknown, response };
  } catch {
    return { status: response.status, data: { error: text.slice(0, 2000) || "返回不是 JSON" }, response };
  }
}

async function resolveCredential(credential: string, proxyUrl = ""): Promise<ResolvedCredential> {
  const accessToken = extractAccessToken(credential);
  const obj = jsonLoadsMaybe(credential);
  const jsonSessionData = isObject(obj) ? obj : null;
  if (accessToken) {
    return { accessToken, sessionData: jsonSessionData };
  }

  const cookie = extractSessionCookie(credential);
  if (!cookie) {
    throw new Error("No valid session token / session cookie / session JSON was recognized.");
  }

  const { status, data } = await fetchText(SESSION_URL, {
    method: "GET",
    headers: sessionHeaders(cookie),
  }, proxyUrl);
  if (status >= 400 || !isObject(data)) {
    throw new Error(`Session token access token exchange failed (HTTP ${status}): ${compactError(data)}`);
  }

  const token = jsonGetAccessToken(data);
  if (!token) {
    throw new Error(`session 响应中没有 accessToken：${compactError(data)}`);
  }

  return { accessToken: token, sessionData: data };
}

async function resolveFreshSessionCredential(credential: string, proxyUrl = ""): Promise<ResolvedCredential> {
  const cookie = extractSessionCookie(credential);
  if (!cookie) return resolveCredential(credential, proxyUrl);

  const { status, data } = await fetchText(SESSION_URL, {
    method: "GET",
    headers: sessionHeaders(cookie),
  }, proxyUrl);
  if (status >= 400 || !isObject(data)) {
    throw new Error(`Refresh session status failed (HTTP ${status}): ${compactError(data)}`);
  }

  const token = jsonGetAccessToken(data) || extractAccessToken(credential);
  return { accessToken: token, sessionData: data };
}

export async function validateCredentialForUpiExtraction(credential: string) {
  const attempts = await getProxyAttempts();
  const errors: string[] = [];
  let firstError: unknown = null;

  for (const attempt of attempts) {
    try {
      const resolved = await resolveCredential(credential, attempt.proxyUrl);
      return { ok: true as const, ...getAccountContactInfo(resolved.sessionData, resolved.accessToken) };
    } catch (error) {
      if (!firstError) firstError = error;
      if (error instanceof EmailBoundError || isNonRetryableCredentialError(error) || attempts.length === 1) throw error;
      errors.push(`${attempt.label}: ${compactThrownError(error)}`);
      console.warn("UPI credential validation failed on proxy, trying next proxy", {
        proxy: attempt.label,
        error: compactThrownError(error),
      });
    }
  }

  if (firstError && errors.length === 0) throw firstError;
  throw new Error(`session token 校验失败，已尝试 ${attempts.length} 个出口：${errors.join(" | ")}`);
}

async function callAccountCheck(accessToken: string, cookie: string, proxyUrl: string) {
  return fetchText(getAccountCheckUrl(), {
    method: "GET",
    headers: accountCheckHeaders(accessToken, cookie),
  }, proxyUrl);
}

export async function checkChatGptSubscription(credential: string): Promise<ChatGptSubscriptionCheck> {
  const attempts = await getProxyAttempts();
  const errors: string[] = [];
  let firstError: unknown = null;
  const cookie = extractSessionCookie(credential);

  for (const attempt of attempts) {
    try {
      const { accessToken, sessionData } = await resolveFreshSessionCredential(credential, attempt.proxyUrl);
      const accountCheck = await callAccountCheck(accessToken, cookie, attempt.proxyUrl);
      if (accountCheck.status >= 400 || !isObject(accountCheck.data)) {
        throw new Error(`accounts/check subscription check failed (HTTP ${accountCheck.status}): ${compactError(accountCheck.data)}`);
      }

      const accountStatus = getAccountCheckSubscriptionStatus(accountCheck.data);
      if (accountStatus.isPlus || accountStatus.planType !== "unknown") {
        return {
          planType: accountStatus.planType,
          isPlus: accountStatus.isPlus,
          checkedAt: new Date().toISOString(),
          proxy: attempt.label,
        };
      }

      const planType = getSubscriptionPlanType(sessionData);
      return {
        planType: planType || "unknown",
        isPlus: isPlusPlanValue(planType),
        checkedAt: new Date().toISOString(),
        proxy: attempt.label,
      };
    } catch (error) {
      if (!firstError) firstError = error;
      if (isNonRetryableCredentialError(error) || attempts.length === 1) throw error;
      const message = compactThrownError(error);
      errors.push(`${attempt.label}: ${message}`);
      console.warn("ChatGPT subscription check failed on proxy, trying next proxy", {
        proxy: attempt.label,
        error: message,
      });
    }
  }

  if (firstError && errors.length === 0) throw firstError;
  throw new Error(`订阅状态检测失败，已尝试 ${attempts.length} 个出口：${errors.join(" | ")}`);
}

function checkoutPayload() {
  const payload: JsonObject = {
    entry_point: "all_plans_pricing_modal",
    plan_name: "chatgptplusplan",
    billing_details: {
      country: "IN",
      currency: "INR",
    },
    checkout_ui_mode: "custom",
    cancel_url: "https://chatgpt.com/#pricing",
  };

  const promoCampaignId = (process.env.CHATGPT_UPI_PROMO_CAMPAIGN_ID || "").trim();
  if (promoCampaignId) {
    payload.promo_campaign = {
      promo_campaign_id: promoCampaignId,
      is_coupon_from_query_param: false,
    };
  }

  return payload;
}

async function callCheckout(accessToken: string, proxyUrl: string) {
  return fetchText(CHECKOUT_URL, {
    method: "POST",
    headers: requestHeaders(accessToken),
    body: JSON.stringify(checkoutPayload()),
  }, proxyUrl);
}

function checkoutSnapshotPayload() {
  return {
    snapshot: {
      billing_address: {
        name: "Rahul Sharma",
        address: {
          line1: "123 MG Road",
          city: "Mumbai",
          country: "IN",
          postal_code: "400001",
          state: "Maharashtra",
        },
      },
    },
  };
}

async function callCheckoutSnapshot(accessToken: string, checkoutSessionId: string, processorEntity: string, proxyUrl: string) {
  return fetchText(CHECKOUT_SNAPSHOT_URL, {
    method: "POST",
    headers: checkoutActionHeaders(accessToken, checkoutSessionId, processorEntity),
    body: JSON.stringify(checkoutSnapshotPayload()),
  }, proxyUrl);
}

async function callStripeInit(checkoutSessionId: string, publishableKey: string, proxyUrl: string, stripeJsId = randomUUID().replace(/-/g, "")) {
  const url = STRIPE_PAYMENT_PAGE_INIT_URL.replace("{checkout_session_id}", encodeURIComponent(checkoutSessionId));
  return fetchText(url, {
    method: "POST",
    headers: stripeInitHeaders("custom", checkoutSessionId),
    body: stripeInitForm(publishableKey, "en", "custom", stripeJsId).toString(),
  }, proxyUrl);
}

async function callStripeElementsSession(
  checkoutSessionId: string,
  publishableKey: string,
  amount: number,
  proxyUrl: string,
  stripeJsId: string
) {
  const params = new URLSearchParams({
    "client_betas[0]": "custom_checkout_server_updates_1",
    "client_betas[1]": "custom_checkout_manual_approval_1",
    "deferred_intent[mode]": "subscription",
    "deferred_intent[amount]": String(amount),
    "deferred_intent[currency]": "inr",
    "deferred_intent[setup_future_usage]": "off_session",
    "deferred_intent[payment_method_types][0]": "card",
    "deferred_intent[payment_method_types][1]": "link",
    "deferred_intent[payment_method_types][2]": "upi",
    currency: "inr",
    key: publishableKey,
    _stripe_version: STRIPE_VERSION,
    elements_init_source: "custom_checkout",
    referrer_host: "chatgpt.com",
    stripe_js_id: stripeJsId,
    locale: "en",
    type: "deferred_intent",
    checkout_session_id: checkoutSessionId,
  });

  return fetchText(`${STRIPE_ELEMENTS_SESSIONS_URL}?${params.toString()}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Origin: "https://js.stripe.com",
      Referer: "https://js.stripe.com/",
      "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    },
  }, proxyUrl);
}

function amountMinor(value: unknown): number | null {
  if (typeof value === "boolean") return null;
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  if (isObject(value)) {
    for (const key of ["amount", "amount_due", "minor", "value"]) {
      const next = amountMinor(value[key]);
      if (next != null) return next;
    }
  }
  return null;
}

function nestedGet(data: unknown, path: string[]) {
  let current = data;
  for (const key of path) {
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

function extractPaymentAmount(initData: unknown) {
  return (
    amountMinor(nestedGet(initData, ["total_summary", "due"])) ??
    amountMinor(nestedGet(initData, ["invoice", "amount_due"])) ??
    amountMinor(nestedGet(initData, ["elements_options", "amount"])) ??
    0
  );
}

function extractPaymentAmountMaybe(initData: unknown) {
  return (
    amountMinor(nestedGet(initData, ["total_summary", "due"])) ??
    amountMinor(nestedGet(initData, ["invoice", "amount_due"])) ??
    amountMinor(nestedGet(initData, ["elements_options", "amount"])) ??
    amountMinor(nestedGet(initData, ["amount_due"])) ??
    null
  );
}

function getStripePaymentMethodTypes(initData: unknown) {
  const candidates = [
    nestedGet(initData, ["elements_options", "payment_method_types"]),
    isObject(initData) ? initData.payment_method_types : undefined,
    nestedGet(initData, ["payment_method_preference", "payment_method_types"]),
    nestedGet(initData, ["session", "payment_method_types"]),
    isObject(initData) ? initData.ordered_payment_method_types : undefined,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) {
      return candidate.map((item) => String(item).toLowerCase());
    }
  }

  return [] as string[];
}

function sumAmountList(value: unknown) {
  if (!Array.isArray(value)) return 0;
  return value.reduce((sum, item) => sum + (amountMinor(item) ?? 0), 0);
}

function extractDiscountAmount(initData: unknown) {
  const directCandidates: unknown[] = [
    nestedGet(initData, ["total_summary", "discount"]),
    nestedGet(initData, ["total_summary", "total_discount_amount"]),
    nestedGet(initData, ["invoice", "discount_amount"]),
    nestedGet(initData, ["invoice", "total_discount_amount"]),
  ];
  const direct = directCandidates.reduce<number>((max, value) => Math.max(max, amountMinor(value) ?? 0), 0);
  const list = Math.max(
    sumAmountList(nestedGet(initData, ["total_discount_amounts"])),
    sumAmountList(nestedGet(initData, ["invoice", "total_discount_amounts"]))
  );
  return Math.max(direct, list);
}

function extractSubtotalAmount(initData: unknown) {
  return (
    amountMinor(nestedGet(initData, ["total_summary", "subtotal"])) ??
    amountMinor(nestedGet(initData, ["invoice", "subtotal"])) ??
    amountMinor(nestedGet(initData, ["invoice", "amount_subtotal"])) ??
    amountMinor(nestedGet(initData, ["elements_options", "amount"])) ??
    null
  );
}

type FreeTrialSignals = {
  couponName: string;
  percentOff: number | null;
  durationMonths: number | null;
};

function scanFreeTrialSignals(
  value: unknown,
  depth = 0,
  signals: FreeTrialSignals = { couponName: "", percentOff: null, durationMonths: null }
): FreeTrialSignals {
  if (depth > 8 || !value || typeof value !== "object") return signals;

  if (Array.isArray(value)) {
    for (const item of value) scanFreeTrialSignals(item, depth + 1, signals);
    return signals;
  }

  if (!isObject(value)) return signals;
  for (const [key, next] of Object.entries(value)) {
    const lowerKey = key.toLowerCase();
    if (typeof next === "string") {
      const lowerValue = next.toLowerCase();
      if (
        !signals.couponName &&
        (lowerValue.includes("free trial") ||
          lowerValue.includes("1 month free") ||
          lowerValue.includes("one month free") ||
          lowerValue.includes("plus-1-month-free") ||
          lowerKey.includes("coupon") ||
          lowerKey.includes("promotion"))
      ) {
        signals.couponName = next;
      }
    } else if (typeof next === "number" && Number.isFinite(next)) {
      if (lowerKey === "percent_off" || lowerKey === "percentoff") {
        signals.percentOff = Math.max(signals.percentOff ?? 0, next);
      }
      if (lowerKey === "duration_in_months" || lowerKey === "durationmonths") {
        signals.durationMonths = Math.max(signals.durationMonths ?? 0, next);
      }
    }

    if (next && typeof next === "object") scanFreeTrialSignals(next, depth + 1, signals);
  }

  return signals;
}

function getFreeTrialStatusFromStripeInit(initData: unknown) {
  const due = extractPaymentAmountMaybe(initData);
  const subtotal = extractSubtotalAmount(initData);
  const discountAmount = extractDiscountAmount(initData);
  const signals = scanFreeTrialSignals(initData);
  const paymentMethodTypes = getStripePaymentMethodTypes(initData);
  const couponName = signals.couponName.trim();
  const couponLower = couponName.toLowerCase();
  const couponLooksLikeTrial =
    couponLower.includes("free trial") ||
    couponLower.includes("1 month free") ||
    couponLower.includes("one month free") ||
    couponLower.includes("plus-1-month-free");
  const couponLooksLikeFullDiscount =
    (signals.percentOff != null && signals.percentOff >= 100) ||
    couponLooksLikeTrial;

  return {
    hasFreeTrial: due === 0 || (discountAmount > 0 && couponLooksLikeFullDiscount),
    hasUpi: paymentMethodTypes.includes("upi"),
    due,
    subtotal,
    discountAmount,
    couponName,
    percentOff: signals.percentOff,
    durationMonths: signals.durationMonths,
    paymentMethodTypes,
  };
}

function stripeXorBase64Encode(value: string) {
  const padding = " ".repeat((3 - (value.length % 3)) % 3);
  const padded = `${value}${padding}`;
  let xored = "";
  for (let index = 0; index < padded.length; index += 1) {
    xored += String.fromCharCode(5 ^ padded.charCodeAt(index));
  }
  return encodeURIComponent(Buffer.from(xored, "binary").toString("base64"));
}

function stripeShiftPrintable(value: string, offset = 11) {
  let shifted = "";
  for (let index = 0; index < value.length; index += 1) {
    shifted += String.fromCharCode(((value.charCodeAt(index) - 32 + offset) % 95) + 32);
  }
  return shifted;
}

function stripeJsChecksum(id: string) {
  return stripeShiftPrintable(stripeXorBase64Encode(JSON.stringify({ id })), 11);
}

function stripeRvTimestamp() {
  return stripeShiftPrintable(stripeXorBase64Encode(JSON.stringify({ rvTs: STRIPE_RV_TS, rv: STRIPE_RV, sv: STRIPE_SV })), 11);
}

function getCheckoutConfigId(pageData: unknown) {
  return (
    getNestedString(pageData, ["config_id"]) ||
    getNestedString(pageData, ["elements_options", "__checkout_config_id"])
  );
}

function stripeConfirmForm(initData: unknown, publishableKey: string, checkoutSessionId: string, stripeJsId: string, processorEntity: string, elementsSessionId = "") {
  const params = new URLSearchParams({
    "payment_method_data[billing_details][name]": "Rahul Sharma",
    "payment_method_data[billing_details][email]": "upi-scanner@example.com",
    "payment_method_data[billing_details][address][line1]": "Flat 302, Sai Residency",
    "payment_method_data[billing_details][address][line2]": "MG Road, Andheri East",
    "payment_method_data[billing_details][address][city]": "Mumbai",
    "payment_method_data[billing_details][address][state]": "Maharashtra",
    "payment_method_data[billing_details][address][postal_code]": "400069",
    "payment_method_data[billing_details][address][country]": "IN",
    "payment_method_data[type]": "upi",
    expected_amount: String(extractPaymentAmount(initData)),
    expected_payment_method_type: "upi",
    version: STRIPE_JS_SDK_VERSION,
    js_checksum: stripeJsChecksum(String(isObject(initData) && initData.id ? initData.id : checkoutSessionId)),
    rv_timestamp: stripeRvTimestamp(),
    return_url: `https://chatgpt.com/checkout/${processorEntity}/${checkoutSessionId}`,
    "client_attribution_metadata[client_session_id]": stripeJsId,
    "client_attribution_metadata[checkout_session_id]": checkoutSessionId,
    "client_attribution_metadata[merchant_integration_source]": "checkout",
    "client_attribution_metadata[merchant_integration_version]": "custom",
    "client_attribution_metadata[merchant_integration_subtype]": "payment-element",
    "client_attribution_metadata[payment_intent_creation_flow]": "deferred",
    "client_attribution_metadata[payment_method_selection_flow]": "automatic",
    key: publishableKey,
    _stripe_version: STRIPE_VERSION,
  });

  const initChecksum = isObject(initData) ? initData.init_checksum : undefined;
  if (initChecksum) params.set("init_checksum", String(initChecksum));
  const checkoutConfigId = getCheckoutConfigId(initData);
  if (checkoutConfigId) params.set("client_attribution_metadata[checkout_config_id]", checkoutConfigId);
  addStripeElementsClientParams(params, stripeJsId, "en", elementsSessionId);
  if (elementsSessionId) {
    params.set("client_attribution_metadata[elements_session_id]", elementsSessionId);
    params.set("client_attribution_metadata[elements_session_config_id]", checkoutConfigId || elementsSessionId);
  }
  return params;
}

function unknownParameter(data: unknown) {
  const error = isObject(data) && isObject(data.error) ? data.error : data;
  if (!isObject(error) || String(error.code || "") !== "parameter_unknown") return "";
  return typeof error.param === "string" ? error.param.trim() : "";
}

function stripeTaxRegionForm(publishableKey: string, stripeJsId: string, elementsSessionId = "") {
  const params = new URLSearchParams({
    "tax_region[country]": "IN",
    "tax_region[postal_code]": "400069",
    "tax_region[state]": "Maharashtra",
    "tax_region[city]": "Mumbai",
    "tax_region[line1]": "Flat 302, Sai Residency",
    "tax_region[line2]": "MG Road, Andheri East",
    key: publishableKey,
    _stripe_version: STRIPE_VERSION,
  });
  addStripeElementsClientParams(params, stripeJsId, "en", elementsSessionId);
  return params;
}

async function callStripeUpdateTaxRegion(checkoutSessionId: string, publishableKey: string, proxyUrl: string, stripeJsId: string, elementsSessionId = "") {
  const url = STRIPE_PAYMENT_PAGE_GET_URL.replace("{checkout_session_id}", encodeURIComponent(checkoutSessionId));
  const form = stripeTaxRegionForm(publishableKey, stripeJsId, elementsSessionId);
  let result = await fetchText(url, {
    method: "POST",
    headers: stripeConfirmHeaders(checkoutSessionId),
    body: form.toString(),
  }, proxyUrl);

  const unknown = unknownParameter(result.data);
  if (result.status >= 400 && unknown && form.has(unknown)) {
    form.delete(unknown);
    result = await fetchText(url, {
      method: "POST",
      headers: stripeConfirmHeaders(checkoutSessionId),
      body: form.toString(),
    }, proxyUrl);
  }

  return result;
}

async function callStripeConfirm(checkoutSessionId: string, publishableKey: string, initData: unknown, proxyUrl: string, stripeJsId: string, processorEntity: string, elementsSessionId = "") {
  const url = STRIPE_PAYMENT_PAGE_CONFIRM_URL.replace("{checkout_session_id}", encodeURIComponent(checkoutSessionId));
  const form = stripeConfirmForm(initData, publishableKey, checkoutSessionId, stripeJsId, processorEntity, elementsSessionId);
  let result = await fetchText(url, {
    method: "POST",
    headers: stripeConfirmHeaders(checkoutSessionId),
    body: form.toString(),
  }, proxyUrl);

  const unknown = unknownParameter(result.data);
  if (result.status >= 400 && unknown && form.has(unknown)) {
    form.delete(unknown);
    result = await fetchText(url, {
      method: "POST",
      headers: stripeConfirmHeaders(checkoutSessionId),
      body: form.toString(),
    }, proxyUrl);
  }

  return result;
}

type CheckoutApprovalResult = {
  status: number;
  data: unknown;
  name: string;
  attemptStatuses?: number[];
};

function checkoutApprovalResultText(data: unknown) {
  return isObject(data) ? String(data.result || "").toLowerCase() : "";
}

function isCheckoutApprovalAccepted(result: CheckoutApprovalResult) {
  const resultText = checkoutApprovalResultText(result.data);
  return result.status < 400 && resultText === "approved";
}

function normalizeAttemptCount(value: unknown, fallback = 1) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(MAX_APPROVAL_ATTEMPTS, Math.floor(parsed)));
}

function normalizeApprovalParallelism(value: unknown, fallback = 1) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.floor(parsed));
}

async function postChatGptCheckoutAction(
  accessToken: string,
  checkoutSessionId: string,
  processorEntity: string,
  proxyUrl: string,
  endpoint: { url: string; payload: JsonObject; name: string }
): Promise<CheckoutApprovalResult> {
  const result = await fetchText(endpoint.url, {
    method: "POST",
    headers: checkoutActionHeaders(accessToken, checkoutSessionId, processorEntity),
    body: JSON.stringify(endpoint.payload),
  }, proxyUrl);
  return { status: result.status, data: result.data, name: endpoint.name };
}

async function callChatGptCheckoutApproval(
  accessToken: string,
  checkoutSessionId: string,
  processorEntity: string,
  proxyUrl: string,
  approvalAttempts = 1,
  submissionAttemptId = "",
  paymentMethod: "upi" | "ideal" = "upi",
  options?: Pick<UpiExtractionOptions, "shouldCancel">
) {
  const confirm = await postChatGptCheckoutAction(accessToken, checkoutSessionId, processorEntity, proxyUrl, {
    url: CHECKOUT_CONFIRM_URL,
    payload: { checkout_session_id: checkoutSessionId, selected_payment_method_type: paymentMethod },
    name: "confirm",
  });
  if (isCheckoutApprovalAccepted(confirm)) return confirm;

  const maxApprovalAttempts = normalizeAttemptCount(approvalAttempts, 1);
  const attemptStatuses: number[] = [];
  let last: CheckoutApprovalResult = confirm;
  for (let attempt = 1; attempt <= maxApprovalAttempts; attempt += 1) {
    await throwIfExtractionCancelled(options);
    const payload: JsonObject = { checkout_session_id: checkoutSessionId, processor_entity: processorEntity };
    if (submissionAttemptId) payload.submission_attempt_id = submissionAttemptId;
    const approve = await postChatGptCheckoutAction(accessToken, checkoutSessionId, processorEntity, proxyUrl, {
      url: CHECKOUT_APPROVE_URL,
      payload,
      name: maxApprovalAttempts > 1 ? `approve#${attempt}` : "approve",
    });
    attemptStatuses.push(approve.status);
    last = { ...approve, attemptStatuses: [...attemptStatuses] };
    if (isCheckoutApprovalAccepted(approve)) return last;
  }
  return last;
}

async function callChatGptCheckoutApprovalParallel(
  accessToken: string,
  checkoutSessionId: string,
  processorEntity: string,
  proxyUrl: string,
  approvalAttempts = 1,
  approvalParallelism = 1,
  approvalProxyAttempts: ProxyAttempt[] = [],
  submissionAttemptId = "",
  paymentMethod: "upi" | "ideal" = "upi",
  options?: Pick<UpiExtractionOptions, "shouldCancel">
) {
  const confirm = await postChatGptCheckoutAction(accessToken, checkoutSessionId, processorEntity, proxyUrl, {
    url: CHECKOUT_CONFIRM_URL,
    payload: { checkout_session_id: checkoutSessionId, selected_payment_method_type: paymentMethod },
    name: "confirm",
  });
  if (isCheckoutApprovalAccepted(confirm)) return confirm;

  const maxApprovalAttempts = normalizeAttemptCount(approvalAttempts, 1);
  const parallelism = normalizeApprovalParallelism(approvalParallelism, 1);
  const proxies = approvalProxyAttempts.length > 0 ? approvalProxyAttempts : [{ proxyUrl, label: describeUpstreamProxy(proxyUrl) }];
  const attemptStatuses: number[] = [];
  let last: CheckoutApprovalResult = confirm;

  for (let start = 1; start <= maxApprovalAttempts; start += parallelism) {
    await throwIfExtractionCancelled(options);
    const batchSize = Math.min(parallelism, maxApprovalAttempts - start + 1);
    const batchPromises = Array.from({ length: batchSize }, async (_, index) => {
      try {
        const attempt = start + index;
        const attemptProxy = proxies[(attempt - 1) % proxies.length];
        const payload: JsonObject = { checkout_session_id: checkoutSessionId, processor_entity: processorEntity };
        if (submissionAttemptId) payload.submission_attempt_id = submissionAttemptId;
        const result = await postChatGptCheckoutAction(accessToken, checkoutSessionId, processorEntity, attemptProxy.proxyUrl, {
          url: CHECKOUT_APPROVE_URL,
          payload,
          name: maxApprovalAttempts > 1 ? `approve#${attempt}` : "approve",
        });
        return { result, attempt };
      } catch (error) {
        return {
          result: {
            status: 0,
            data: { result: "exception", error: compactThrownError(error) },
            name: `approve#${start + index}`,
          } satisfies CheckoutApprovalResult,
          attempt: start + index,
        };
      }
    });

    const accepted = await new Promise<{ result: CheckoutApprovalResult; attempt: number } | null>((resolve) => {
      let settled = 0;
      let resolved = false;
      for (const promise of batchPromises) {
        promise.then((item) => {
          if (resolved) return;
          if (isCheckoutApprovalAccepted(item.result)) {
            resolved = true;
            resolve(item);
            return;
          }
          settled += 1;
          if (settled >= batchPromises.length) {
            resolved = true;
            resolve(null);
          }
        });
      }
    });

    if (accepted) {
      attemptStatuses.push(accepted.result.status);
      return { ...accepted.result, attemptStatuses: [...attemptStatuses] };
    }

    const batch = await Promise.all(batchPromises);

    for (const item of batch) {
      attemptStatuses.push(item.result.status);
      last = { ...item.result, attemptStatuses: [...attemptStatuses] };
    }
  }

  return last;
}

async function callStripePaymentPageGet(checkoutSessionId: string, publishableKey: string, proxyUrl: string, stripeJsId = randomUUID().replace(/-/g, ""), elementsSessionId = "") {
  const base = STRIPE_PAYMENT_PAGE_GET_URL.replace("{checkout_session_id}", encodeURIComponent(checkoutSessionId));
  const params = new URLSearchParams({ key: publishableKey, _stripe_version: STRIPE_VERSION });
  addStripeElementsClientParams(params, stripeJsId, "en", elementsSessionId);
  const url = `${base}?${params.toString()}`;
  return fetchText(url, {
    method: "GET",
    headers: stripeConfirmHeaders(checkoutSessionId),
  }, proxyUrl);
}

function mergeUpiKey(result: UpiQrData, key: string, value: unknown) {
  if (value == null) return;
  const normalizedKey = key.toLowerCase();
  if (typeof value === "string") {
    if (value.startsWith("upi://") && !result.upiUri) {
      result.upiUri = value;
      result.mobileAuthUrl = value;
    } else if (value.startsWith("https://payments.stripe.com/upi/instructions/") && !result.hostedInstructionsUrl) {
      result.hostedInstructionsUrl = value;
    } else if (value.startsWith("https://qr.stripe.com/") && value.toLowerCase().includes("svg") && !result.qrImageUrlSvg) {
      result.qrImageUrlSvg = value;
    } else if (value.startsWith("https://qr.stripe.com/") && value.toLowerCase().includes("png") && !result.qrImageUrlPng) {
      result.qrImageUrlPng = value;
    }
  }

  if (["hosted_instructions_url", "mobile_auth_url", "upi_uri", "image_url_svg", "qr_image_url_svg", "image_url_png", "qr_image_url_png"].includes(normalizedKey) && typeof value === "string" && value) {
    const outKey: keyof UpiQrData =
      normalizedKey === "image_url_svg" || normalizedKey === "qr_image_url_svg"
        ? "qrImageUrlSvg"
        : normalizedKey === "image_url_png" || normalizedKey === "qr_image_url_png"
          ? "qrImageUrlPng"
          : normalizedKey === "hosted_instructions_url"
            ? "hostedInstructionsUrl"
            : normalizedKey === "mobile_auth_url"
              ? "mobileAuthUrl"
              : "upiUri";
    result[outKey] ||= value;
  }

  if (["expires_at", "expires_after_timestamp", "qr_expires_at"].includes(normalizedKey)) {
    const expiresAt = Number(value);
    if (Number.isFinite(expiresAt) && expiresAt > 0 && !result.expiresAt) result.expiresAt = Math.floor(expiresAt);
  }
}

function extractUpiNextAction(data: unknown) {
  const result: UpiQrData = {};
  const walk = (value: unknown, key = "") => {
    mergeUpiKey(result, key, value);
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!isObject(value)) return;
    for (const [childKey, childValue] of Object.entries(value)) {
      if (childKey === "qr_code" && isObject(childValue)) {
        mergeUpiKey(result, "qr_expires_at", childValue.expires_at);
        mergeUpiKey(result, "image_url_svg", childValue.image_url_svg);
        mergeUpiKey(result, "image_url_png", childValue.image_url_png);
      }
      walk(childValue, childKey);
    }
  };
  walk(data);
  return result;
}

function decodePayloadB64(value: string) {
  const text = value.replace(/&quot;/g, "\"").replace(/-/g, "+").replace(/_/g, "/");
  try {
    return JSON.parse(Buffer.from(text.padEnd(Math.ceil(text.length / 4) * 4, "="), "base64").toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

function extractUpiQrFromHostedHtml(pageHtml: string) {
  const result: UpiQrData = {};
  const meta = /<meta\b(?=[^>]*\bid=["']payload["'])(?=[^>]*\bdata-message=["']([^"']+)["'])[^>]*>/i.exec(pageHtml);
  if (meta?.[1]) {
    const payload = decodePayloadB64(meta[1]);
    if (isObject(payload)) {
      mergeUpiKey(result, "mobile_auth_url", payload.mobile_auth_url);
      mergeUpiKey(result, "upi_uri", payload.upi_uri);
      mergeUpiKey(result, "expires_at", payload.expires_at || payload.expires_after_timestamp);
    }
  }

  const imgMatches = pageHtml.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi);
  for (const match of imgMatches) {
    const src = match[1]?.replace(/&amp;/g, "&") || "";
    const tag = match[0] || "";
    if (src.includes("qr.stripe.com") || tag.includes("QRCode-image")) {
      mergeUpiKey(result, src.toLowerCase().includes("png") ? "qr_image_url_png" : "qr_image_url_svg", src);
      break;
    }
  }
  return result;
}

async function hydrateUpiQrData(qrData: UpiQrData, proxyUrl: string) {
  const next = { ...qrData };
  if (next.hostedInstructionsUrl && !next.upiUri) {
    const response = await fetchWithUpstreamProxy(next.hostedInstructionsUrl, {
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Referer: "https://js.stripe.com/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    }, proxyUrl);
    if (response.ok) {
      const extracted = extractUpiQrFromHostedHtml(await response.text());
      Object.assign(next, Object.fromEntries(Object.entries(extracted).filter(([, value]) => value)));
    }
  }
  return next;
}

async function makeUpiQrPng(upiUri: string) {
  if (!upiUri.toLowerCase().startsWith("upi://")) {
    throw new Error("提取到的数据不是 upi:// 协议，无法生成 UPI 二维码");
  }
  return QRCode.toBuffer(upiUri, {
    type: "png",
    errorCorrectionLevel: "M",
    margin: 4,
    scale: 12,
  });
}

type ProxyAttempt = {
  proxyUrl: string;
  label: string;
};

const NO_FREE_TRIAL_CONFIRMATION_PROXY_COUNT = 5;

async function getProxyAttempts(pool: UpstreamProxyPool = "public"): Promise<ProxyAttempt[]> {
  const plan = await getUpstreamProxyPlan(pool);
  if (plan.length === 0) return [{ proxyUrl: "", label: "DIRECT" }];
  return plan.map((proxy) => ({
    proxyUrl: proxy.url,
    label: `#${proxy.index + 1} ${describeUpstreamProxy(proxy.url)}`,
  }));
}

function getExplicitProxyAttempts(proxyUrls: string[] | undefined): ProxyAttempt[] {
  const urls = (proxyUrls || []).map((item) => normalizeCustomUpstreamProxyUrl(item)).filter(Boolean);
  if (urls.length === 0) return [];
  return urls.map((proxyUrl, index) => ({
    proxyUrl,
    label: `experimental#${index + 1} ${describeUpstreamProxy(proxyUrl)}`,
  }));
}

function getCustomProxyUrl(value?: string) {
  return value ? normalizeCustomUpstreamProxyUrl(value) : "";
}

function getProviderProxyAttempt(options: Pick<UpiExtractionOptions, "providerProxyUrl"> | undefined, checkoutProxyUrl: string): ProxyAttempt {
  const providerProxyUrl = getCustomProxyUrl(options?.providerProxyUrl) || checkoutProxyUrl;
  return { proxyUrl: providerProxyUrl, label: describeUpstreamProxy(providerProxyUrl) };
}

function proxyAttemptKey(attempt: ProxyAttempt) {
  return attempt.proxyUrl || "DIRECT";
}

function uniqueProxyAttempts(attempts: ProxyAttempt[]) {
  const seen = new Set<string>();
  const uniqueAttempts: ProxyAttempt[] = [];

  for (const attempt of attempts) {
    const key = proxyAttemptKey(attempt);
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueAttempts.push(attempt);
  }

  return uniqueAttempts;
}

function selectProxyAttemptsForExtraction(allAttempts: ProxyAttempt[], requestedMaxProxyAttempts: number) {
  if (allAttempts.length === 0) return allAttempts;

  const targetAttemptCount = Math.max(1, requestedMaxProxyAttempts, NO_FREE_TRIAL_CONFIRMATION_PROXY_COUNT);
  const roundRobinAttempts = uniqueProxyAttempts(allAttempts);
  const selectedAttempts: ProxyAttempt[] = [];

  for (let index = 0; selectedAttempts.length < targetAttemptCount; index += 1) {
    selectedAttempts.push(roundRobinAttempts[index % roundRobinAttempts.length]);
  }

  return selectedAttempts;
}

type NoFreeTrialConfirmationState = {
  target: number;
  proxyKeys: Set<string>;
  proxyLabels: string[];
};

function createNoFreeTrialConfirmationState(attempts: ProxyAttempt[]): NoFreeTrialConfirmationState {
  void attempts;
  return {
    target: NO_FREE_TRIAL_CONFIRMATION_PROXY_COUNT,
    proxyKeys: new Set<string>(),
    proxyLabels: [],
  };
}

function recordNoFreeTrialConfirmation(state: NoFreeTrialConfirmationState, attempt: ProxyAttempt) {
  const key = proxyAttemptKey(attempt);
  state.proxyKeys.add(key);
  state.proxyLabels.push(attempt.label);
}

function handleNoFreeTrialConfirmation(
  state: NoFreeTrialConfirmationState,
  methodLabel: "IDEAL" | "UPI",
  attempt: ProxyAttempt,
  attemptIndex: number,
  attempts: ProxyAttempt[],
  options?: UpiExtractionOptions
) {
  recordNoFreeTrialConfirmation(state, attempt);
  const confirmedCount = state.proxyLabels.length;

  reportExtractionProgress(options, {
    stage: "retrying",
    percent: 8,
    proxy: attempt.label,
    attempt: attemptIndex + 1,
    maxAttempts: attempts.length,
  });
  reportExtractionDebug(options, "warn", `${methodLabel} free trial unavailable on proxy; confirming with another proxy`, {
    stage: "retrying",
    percent: 8,
    proxy: attempt.label,
    attempt: attemptIndex + 1,
    maxAttempts: attempts.length,
    details: {
      noFreeTrialConfirmations: confirmedCount,
      distinctProxyConfirmations: state.proxyKeys.size,
      requiredConfirmations: state.target,
      confirmedProxies: [...state.proxyLabels],
    },
  });
  console.warn(`${methodLabel} free trial unavailable on proxy, confirming with another proxy`, {
    proxy: attempt.label,
    confirmations: confirmedCount,
    distinctProxyConfirmations: state.proxyKeys.size,
    requiredConfirmations: state.target,
  });

  if (confirmedCount >= state.target) {
    throw new NoFreeTrialError([...state.proxyLabels]);
  }
}

function rotateProxyAttempts(attempts: ProxyAttempt[], startIndex: number) {
  if (attempts.length === 0) return attempts;
  const normalized = ((startIndex % attempts.length) + attempts.length) % attempts.length;
  return [...attempts.slice(normalized), ...attempts.slice(0, normalized)];
}

function compactThrownError(error: unknown) {
  const cause = error && typeof error === "object" && "cause" in error ? String((error as { cause?: unknown }).cause || "") : "";
  const text = error instanceof Error ? `${error.name}: ${error.message}${cause ? ` | cause: ${cause}` : ""}` : String(error);
  return text
    .replace(ACCESS_TOKEN_RE, "<JWT_REDACTED>")
    .replace(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+/g, "<SESSION_TOKEN_REDACTED>")
    .replace(/(:\/\/[^:@/]+):([^@/]+)@/g, "$1:<PASSWORD_REDACTED>@")
    .slice(0, 700);
}

function isNonRetryableCredentialError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  return (
    error instanceof PaymentMethodUnavailableError ||
    lower.includes("payment_method_unavailable") ||
    lower.includes("no valid session token") ||
    lower.includes("session response missing accesstoken") ||
    lower.includes("session response does not contain accesstoken") ||
    lower.includes("refresh session status failed (http 401") ||
    lower.includes("refresh session status failed (http 403") ||
    lower.includes("session token access token exchange failed (http 401") ||
    lower.includes("session token access token exchange failed (http 403") ||
    lower.includes("token_invalidated") ||
    lower.includes("token invalidated") ||
    lower.includes("token has been invalidated") ||
    lower.includes("invalidated oauth token") ||
    lower.includes("token_revoked") ||
    lower.includes("user is already paid") ||
    lower.includes("already paid") ||
    message.includes("没有识别到有效的 session token") ||
    message.includes("娌℃湁璇嗗埆鍒版湁鏁堢殑 session token")
  );
}


function isBillingCountryLockedErrorMessage(message: string) {
  return message.toLowerCase().includes("billing country must match request country");
}

function summarizeExtractionFailure(errors: string[], attemptsCount: number, method: "upi" | "ideal" = "upi") {
  const joined = errors.join(" | ").toLowerCase();
  const attemptsText = attemptsCount > 1 ? ` Tried ${attemptsCount} exit nodes.` : "";
  const target = method === "ideal" ? "IDEAL payment link" : "UPI QR";

  if (joined.includes("payment_method_unavailable") || joined.includes("available_payment_method_types")) {
    if (joined.includes("ideal")) {
      return "This account cannot create an IDEAL payment. Please switch account and try again.";
    }
    return "This account cannot create a UPI payment. Please switch account and try again.";
  }

  if (joined.includes("billing country must match request country")) {
    return "This account's region is locked by OpenAI, so the billing country cannot be changed.";
  }

  if (
    joined.includes("token_invalidated") ||
    joined.includes("token invalidated") ||
    joined.includes("token has been invalidated") ||
    joined.includes("invalidated oauth token") ||
    joined.includes("token_revoked")
  ) {
    return "This session token has expired or been invalidated. Please sign in again and use a fresh token.";
  }

  if (joined.includes("user is already paid") || joined.includes("already paid")) {
    return "This account is already subscribed or paid. Please use another account.";
  }

  if (joined.includes('"result":"blocked"') || joined.includes("approval") || joined.includes("approve_attempts")) {
    return `${target} generation failed because the Approve step is temporarily blocked.${attemptsText} Please retry later or switch account/exit node.`;
  }

  if (
    joined.includes("econnrefused") ||
    joined.includes("socks5") ||
    joined.includes("authentication timeout") ||
    joined.includes("fetch failed") ||
    joined.includes("connect timeout")
  ) {
    return `${target} generation failed because available exit nodes are failing.${attemptsText} Please check the proxy pool or retry later.`;
  }

  if (method === "upi" && (joined.includes("upi://") || joined.includes("upi data") || joined.includes("no upi"))) {
    return `UPI QR generation failed because no UPI data was returned by the payment response.${attemptsText} Please retry later or switch account/exit node.`;
  }

  if (method === "ideal" && (joined.includes("ideal") || joined.includes("payment link") || joined.includes("redirect"))) {
    return `${target} generation failed.${attemptsText} Please retry later or switch account/exit node.`;
  }

  return `${target} generation failed.${attemptsText} Please retry later or switch account/exit node.`;
}

function reportExtractionProgress(options: UpiExtractionOptions | undefined, progress: UpiExtractionProgress) {
  try {
    options?.onProgress?.({
      ...progress,
      percent: Math.max(0, Math.min(100, Math.round(progress.percent))),
    });
  } catch {
    // Progress reporting must never break extraction.
  }
}

async function throwIfExtractionCancelled(options?: Pick<UpiExtractionOptions, "shouldCancel">) {
  if (await options?.shouldCancel?.()) {
    throw new Error("Extraction task cancelled by user");
  }
}

function reportExtractionDebug(
  options: UpiExtractionOptions | undefined,
  level: NonNullable<UpiExtractionDebugEvent["level"]>,
  message: string,
  input: Omit<UpiExtractionDebugEvent, "level" | "message"> = {}
) {
  try {
    options?.onDebug?.({
      level,
      message,
      ...input,
    });
  } catch {
    // Debug logging must never break extraction.
  }
}

function summarizeDebugString(value: string) {
  return value.length > 600 ? `${value.slice(0, 600)}…` : value;
}

function summarizeDebugValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return summarizeDebugString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => summarizeDebugValue(item, depth + 1));
  if (!isObject(value)) return String(value);
  if (depth >= 2) return "[nested]";

  const output: Record<string, unknown> = {};
  const interestingKeys = [
    "error",
    "code",
    "type",
    "message",
    "result",
    "state",
    "status",
    "payment_method_types",
    "payment_method_type",
    "amount",
    "amount_total",
    "currency",
    "url",
    "redirect_url",
    "return_url",
    "expires_at",
    "client_secret",
    "checkout_session_id",
    "cs_id",
    "publishable_key",
    "processor_entity",
    "submission_attempt",
    "next_action",
  ];

  for (const key of interestingKeys) {
    if (!(key in value)) continue;
    const lower = key.toLowerCase();
    if (lower.includes("secret") || lower.includes("token") || lower.includes("publishable_key")) {
      output[key] = value[key] ? "[present]" : value[key];
      continue;
    }
    if (key === "checkout_session_id" || key === "cs_id") {
      const id = String(value[key] || "");
      output[key] = id ? `${id.slice(0, 10)}…${id.slice(-6)}` : id;
      continue;
    }
    output[key] = summarizeDebugValue(value[key], depth + 1);
  }

  if (Object.keys(output).length === 0) {
    output.keys = Object.keys(value).slice(0, 24);
  }
  return output;
}

function summarizeHttpDebug(status: number, data: unknown, extra: Record<string, unknown> = {}) {
  return {
    status,
    ok: status < 400,
    ...extra,
    response: summarizeDebugValue(data),
  };
}

function idealCheckoutPayload() {
  const country = (process.env.CHATGPT_IDEAL_COUNTRY || "NL").trim().toUpperCase() || "NL";
  const currency = (process.env.CHATGPT_IDEAL_CURRENCY || "EUR").trim().toUpperCase() || "EUR";
  const payload: JsonObject = {
    entry_point: process.env.CHATGPT_IDEAL_ENTRY_POINT || "all_plans_pricing_modal",
    plan_name: "chatgptplusplan",
    billing_details: {
      country,
      currency,
    },
    checkout_ui_mode: process.env.CHATGPT_IDEAL_CHECKOUT_UI_MODE || "custom",
    cancel_url: "https://chatgpt.com/#pricing",
  };

  const promoCampaignId = (
    process.env.CHATGPT_IDEAL_PROMO_CAMPAIGN_ID ||
    process.env.CHATGPT_UPI_PROMO_CAMPAIGN_ID ||
    "plus-1-month-free"
  ).trim();
  if (promoCampaignId) {
    payload.promo_campaign = {
      promo_campaign_id: promoCampaignId,
      is_coupon_from_query_param: false,
    };
  }

  return payload;
}

async function callIdealCheckout(accessToken: string, proxyUrl: string) {
  return fetchText(CHECKOUT_URL, {
    method: "POST",
    headers: requestHeaders(accessToken),
    body: JSON.stringify(idealCheckoutPayload()),
  }, proxyUrl);
}

function idealCheckoutSnapshotPayload() {
  return {
    snapshot: {
      billing_address: {
        name: "Jan de Vries",
        address: {
          line1: "Damrak 1",
          city: "Amsterdam",
          country: "NL",
          postal_code: "1012 LG",
        },
      },
    },
  };
}

async function callIdealCheckoutSnapshot(accessToken: string, checkoutSessionId: string, processorEntity: string, proxyUrl: string) {
  return fetchText(CHECKOUT_SNAPSHOT_URL, {
    method: "POST",
    headers: checkoutActionHeaders(accessToken, checkoutSessionId, processorEntity),
    body: JSON.stringify(idealCheckoutSnapshotPayload()),
  }, proxyUrl);
}

function idealStripeInitForm(publishableKey: string, stripeJsId: string, locale = "en") {
  const params = new URLSearchParams({
    browser_locale: locale,
    browser_timezone: "Europe/Amsterdam",
    key: publishableKey,
    _stripe_version: STRIPE_VERSION,
  });
  addStripeElementsClientParams(params, stripeJsId, locale);
  return params;
}

async function callIdealStripeInit(checkoutSessionId: string, publishableKey: string, proxyUrl: string, stripeJsId: string) {
  const url = STRIPE_PAYMENT_PAGE_INIT_URL.replace("{checkout_session_id}", encodeURIComponent(checkoutSessionId));
  return fetchText(url, {
    method: "POST",
    headers: stripeInitHeaders("custom", checkoutSessionId),
    body: idealStripeInitForm(publishableKey, stripeJsId).toString(),
  }, proxyUrl);
}

function idealStripeElementsSessionParams(checkoutSessionId: string, publishableKey: string, amount: number, stripeJsId: string) {
  return new URLSearchParams({
    "client_betas[0]": "custom_checkout_server_updates_1",
    "client_betas[1]": "custom_checkout_manual_approval_1",
    "deferred_intent[mode]": "subscription",
    "deferred_intent[amount]": String(amount),
    "deferred_intent[currency]": "eur",
    "deferred_intent[setup_future_usage]": "off_session",
    "deferred_intent[payment_method_types][0]": "card",
    "deferred_intent[payment_method_types][1]": "link",
    "deferred_intent[payment_method_types][2]": "ideal",
    currency: "eur",
    key: publishableKey,
    _stripe_version: STRIPE_VERSION,
    elements_init_source: "custom_checkout",
    referrer_host: "chatgpt.com",
    stripe_js_id: stripeJsId,
    locale: "en",
    type: "deferred_intent",
    checkout_session_id: checkoutSessionId,
  });
}

async function callIdealStripeElementsSession(checkoutSessionId: string, publishableKey: string, amount: number, proxyUrl: string, stripeJsId: string) {
  const url = `${STRIPE_ELEMENTS_SESSIONS_URL}?${idealStripeElementsSessionParams(checkoutSessionId, publishableKey, amount, stripeJsId).toString()}`;
  return fetchText(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Origin: "https://js.stripe.com",
      Referer: "https://js.stripe.com/",
      "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    },
  }, proxyUrl);
}

function idealStripeTaxRegionForm(publishableKey: string, stripeJsId: string, elementsSessionId = "") {
  const params = new URLSearchParams({
    "tax_region[country]": "NL",
    "tax_region[postal_code]": "1012 LG",
    "tax_region[city]": "Amsterdam",
    "tax_region[line1]": "Damrak 1",
    key: publishableKey,
    _stripe_version: STRIPE_VERSION,
  });
  addStripeElementsClientParams(params, stripeJsId, "en", elementsSessionId);
  return params;
}

async function callIdealStripeUpdateTaxRegion(checkoutSessionId: string, publishableKey: string, proxyUrl: string, stripeJsId: string, elementsSessionId = "") {
  const url = STRIPE_PAYMENT_PAGE_GET_URL.replace("{checkout_session_id}", encodeURIComponent(checkoutSessionId));
  const form = idealStripeTaxRegionForm(publishableKey, stripeJsId, elementsSessionId);
  let result = await fetchText(url, {
    method: "POST",
    headers: stripeConfirmHeaders(checkoutSessionId),
    body: form.toString(),
  }, proxyUrl);

  const unknown = unknownParameter(result.data);
  if (result.status >= 400 && unknown && form.has(unknown)) {
    form.delete(unknown);
    result = await fetchText(url, {
      method: "POST",
      headers: stripeConfirmHeaders(checkoutSessionId),
      body: form.toString(),
    }, proxyUrl);
  }

  return result;
}

function idealStripeConfirmForm(initData: unknown, publishableKey: string, checkoutSessionId: string, stripeJsId: string, processorEntity: string, elementsSessionId = "") {
  const params = new URLSearchParams({
    "payment_method_data[billing_details][name]": "Jan de Vries",
    "payment_method_data[billing_details][email]": "ideal-scanner@example.com",
    "payment_method_data[billing_details][address][line1]": "Damrak 1",
    "payment_method_data[billing_details][address][city]": "Amsterdam",
    "payment_method_data[billing_details][address][postal_code]": "1012 LG",
    "payment_method_data[billing_details][address][country]": "NL",
    "payment_method_data[type]": "ideal",
    expected_amount: String(extractPaymentAmount(initData)),
    expected_payment_method_type: "ideal",
    version: STRIPE_JS_SDK_VERSION,
    js_checksum: stripeJsChecksum(String(isObject(initData) && initData.id ? initData.id : checkoutSessionId)),
    rv_timestamp: stripeRvTimestamp(),
    return_url: `https://chatgpt.com/checkout/${processorEntity}/${checkoutSessionId}`,
    "client_attribution_metadata[client_session_id]": stripeJsId,
    "client_attribution_metadata[checkout_session_id]": checkoutSessionId,
    "client_attribution_metadata[merchant_integration_source]": "checkout",
    "client_attribution_metadata[merchant_integration_version]": "custom",
    "client_attribution_metadata[merchant_integration_subtype]": "payment-element",
    "client_attribution_metadata[payment_intent_creation_flow]": "deferred",
    "client_attribution_metadata[payment_method_selection_flow]": "automatic",
    key: publishableKey,
    _stripe_version: STRIPE_VERSION,
  });
  const bank = (process.env.CHATGPT_IDEAL_BANK || "").trim();
  if (bank) params.set("payment_method_data[ideal][bank]", bank);
  const initChecksum = isObject(initData) ? initData.init_checksum : undefined;
  if (initChecksum) params.set("init_checksum", String(initChecksum));
  const checkoutConfigId = getCheckoutConfigId(initData);
  if (checkoutConfigId) params.set("client_attribution_metadata[checkout_config_id]", checkoutConfigId);
  addStripeElementsClientParams(params, stripeJsId, "en", elementsSessionId);
  if (elementsSessionId) {
    params.set("client_attribution_metadata[elements_session_id]", elementsSessionId);
    params.set("client_attribution_metadata[elements_session_config_id]", checkoutConfigId || elementsSessionId);
  }
  return params;
}

async function callIdealStripeConfirm(checkoutSessionId: string, publishableKey: string, initData: unknown, proxyUrl: string, stripeJsId: string, processorEntity: string, elementsSessionId = "") {
  const url = STRIPE_PAYMENT_PAGE_CONFIRM_URL.replace("{checkout_session_id}", encodeURIComponent(checkoutSessionId));
  const form = idealStripeConfirmForm(initData, publishableKey, checkoutSessionId, stripeJsId, processorEntity, elementsSessionId);
  let result = await fetchText(url, {
    method: "POST",
    headers: stripeConfirmHeaders(checkoutSessionId),
    body: form.toString(),
  }, proxyUrl);

  const unknown = unknownParameter(result.data);
  if (result.status >= 400 && unknown && form.has(unknown)) {
    form.delete(unknown);
    result = await fetchText(url, {
      method: "POST",
      headers: stripeConfirmHeaders(checkoutSessionId),
      body: form.toString(),
    }, proxyUrl);
  }

  return result;
}

async function callChatGptIdealCheckoutApproval(
  accessToken: string,
  checkoutSessionId: string,
  processorEntity: string,
  proxyUrl: string,
  approvalAttempts = 1,
  approvalParallelism = 1,
  approvalProxyAttempts: ProxyAttempt[] = [],
  submissionAttemptId = "",
  options?: Pick<UpiExtractionOptions, "shouldCancel">
) {
  return callChatGptCheckoutApprovalParallel(
    accessToken,
    checkoutSessionId,
    processorEntity,
    proxyUrl,
    approvalAttempts,
    approvalParallelism,
    approvalProxyAttempts,
    submissionAttemptId,
    "ideal",
    options
  );
}

type IdealPaymentArtifact = {
  paymentUrl: string;
  redirectUrl: string;
  expiresAt?: number;
  rank?: number;
};

type IdealRedirectResolution = {
  paymentUrl: string;
  resolved: boolean;
  statuses: number[];
  hops: string[];
  error?: string;
};

const IDEAL_FINAL_REDIRECT_MAX_HOPS = 8;

function parseUrlSafe(value: string) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isFinalIdealPaymentUrl(value: string) {
  const url = parseUrlSafe(value);
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  if (host === "pay.ideal.nl" && path.startsWith("/transactions/")) return true;
  if (host === "tx.ideal.nl") return true;
  return false;
}

function safeUrlDebugLabel(value: string) {
  const url = parseUrlSafe(value);
  if (!url) return "";
  const path = url.pathname.length > 80 ? `${url.pathname.slice(0, 80)}…` : url.pathname;
  return `${url.hostname}${path}`;
}

function isNonActionableIdealUrl(value: string) {
  const url = parseUrlSafe(value);
  if (!url) return true;
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  const full = value.toLowerCase();
  if (host === "openai.com" || host.endsWith(".openai.com")) return true;
  if (host === "chatgpt.com" || host.endsWith(".chatgpt.com")) return true;
  if (host === "js.stripe.com") return true;
  if (host === "q.stripe.com" || host === "r.stripe.com") return true;
  if (path.includes("/apple_pay/merchant_token/")) return true;
  if (full.includes("icon-pm-ideal")) return true;
  if (/\.(png|svg|jpg|jpeg|gif|webp|css|js)(\?|#|$)/i.test(path)) return true;
  return false;
}

function idealPaymentUrlRank(value: string, pathParts: string[]) {
  if (!/^https?:\/\//i.test(value) || isNonActionableIdealUrl(value)) return 0;
  const url = parseUrlSafe(value);
  if (!url) return 0;
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  const keyPath = pathParts.map((item) => item.toLowerCase()).join(".");
  if (isFinalIdealPaymentUrl(value)) return 220;
  if (host.endsWith(".ideal.nl") && path.includes("/transactions/")) return 200;
  const isStripeRedirectHost =
    host === "hooks.stripe.com" ||
    host === "pm-hooks.stripe.com" ||
    host === "pm-redirects.stripe.com";
  const isRedirectField =
    keyPath.includes("redirect_to_url.url") ||
    keyPath.includes("next_action") ||
    keyPath.includes("redirect.url") ||
    keyPath.endsWith(".redirect_url") ||
    keyPath.endsWith(".return_url");
  if (isStripeRedirectHost && (path.includes("/redirect") || host === "pm-redirects.stripe.com")) return 100;
  if (isRedirectField && isStripeRedirectHost) return 90;
  if (isRedirectField) return 70;
  if (host.endsWith(".stripe.com") && path.includes("/redirect")) return 60;
  if (host === "checkout.stripe.com" && path.startsWith("/c/pay/")) return 40;
  return 0;
}

function collectIdealPaymentArtifact(...values: unknown[]): IdealPaymentArtifact {
  const result: IdealPaymentArtifact = { paymentUrl: "", redirectUrl: "" };
  let bestRank = 0;
  const acceptUrl = (text: string, pathParts: string[]) => {
    const rank = idealPaymentUrlRank(text, pathParts);
    if (rank <= bestRank) return;
    bestRank = rank;
    result.rank = rank;
    if (rank >= 60) result.redirectUrl = text;
    result.paymentUrl = text;
  };
  const walk = (value: unknown, key = "", pathParts: string[] = []) => {
    const nextPath = key ? [...pathParts, key] : pathParts;
    const lowerKey = key.toLowerCase();
    if (typeof value === "string") {
      const text = value.trim();
      if (text.startsWith("http://") || text.startsWith("https://")) {
        acceptUrl(text, nextPath);
      }
      return;
    }
    if (typeof value === "number" && Number.isFinite(value) && ["expires_at", "expires_after", "expires_after_timestamp"].includes(lowerKey)) {
      result.expiresAt ||= Math.floor(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, "", nextPath);
      return;
    }
    if (!isObject(value)) return;
    const redirectToUrl = nestedGet(value, ["redirect_to_url", "url"]);
    if (typeof redirectToUrl === "string" && redirectToUrl.startsWith("http")) {
      acceptUrl(redirectToUrl, [...nextPath, "redirect_to_url", "url"]);
    }
    for (const [childKey, childValue] of Object.entries(value)) walk(childValue, childKey, nextPath);
  };
  for (const value of values) walk(value);
  result.paymentUrl ||= result.redirectUrl;
  return result;
}

function decodeHtmlUrlText(value: string) {
  return value
    .replace(/\\u0026/gi, "&")
    .replace(/\\\//g, "/")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function normalizeIdealCandidateUrl(rawValue: string, baseUrl = "") {
  const trimmed = decodeHtmlUrlText(rawValue).trim().replace(/[),.;\]}]+$/g, "");
  if (!trimmed) return "";
  try {
    return new URL(trimmed, baseUrl || undefined).toString();
  } catch {
    return "";
  }
}

function collectIdealCandidateUrlsFromText(text: string, baseUrl = "") {
  const candidates = new Set<string>();
  const decoded = decodeHtmlUrlText(text);
  const add = (rawValue: string | undefined) => {
    if (!rawValue) return;
    const url = normalizeIdealCandidateUrl(rawValue, baseUrl);
    if (url && idealPaymentUrlRank(url, ["ideal_redirect_html"]) > 0) candidates.add(url);
  };

  for (const match of decoded.matchAll(/https?:\/\/[^\s"'<>\\]+/gi)) {
    add(match[0]);
  }
  for (const match of decoded.matchAll(/\b(?:href|action|data-[\w-]*url|url)=["']([^"']+)["']/gi)) {
    add(match[1]);
  }
  for (const match of decoded.matchAll(/;\s*url=([^"'<>\s]+)/gi)) {
    add(match[1]);
  }

  return [...candidates];
}

async function resolveIdealFinalPaymentUrl(paymentUrl: string, proxyUrl: string): Promise<IdealRedirectResolution> {
  let currentUrl = paymentUrl;
  const statuses: number[] = [];
  const hops: string[] = [];
  const seen = new Set<string>();

  if (isFinalIdealPaymentUrl(currentUrl)) {
    return { paymentUrl: currentUrl, resolved: true, statuses, hops: [safeUrlDebugLabel(currentUrl)].filter(Boolean) };
  }

  for (let hop = 0; hop < IDEAL_FINAL_REDIRECT_MAX_HOPS; hop += 1) {
    if (!/^https?:\/\//i.test(currentUrl) || seen.has(currentUrl)) break;
    seen.add(currentUrl);
    hops.push(safeUrlDebugLabel(currentUrl));

    let response: Response;
    try {
      response = await fetchWithUpstreamProxy(currentUrl, {
        method: "GET",
        redirect: "manual",
        headers: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
          Referer: "https://js.stripe.com/",
          "Accept-Language": "en-US,en;q=0.9,nl;q=0.8,zh-CN;q=0.7",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        cache: "no-store",
      }, proxyUrl);
    } catch (error) {
      return { paymentUrl: currentUrl, resolved: false, statuses, hops, error: compactThrownError(error) };
    }

    statuses.push(response.status);
    const responseUrl = response.url || currentUrl;
    if (isFinalIdealPaymentUrl(responseUrl)) {
      return { paymentUrl: responseUrl, resolved: true, statuses, hops: [...hops, safeUrlDebugLabel(responseUrl)].filter(Boolean) };
    }

    const location = response.headers.get("location");
    const locationUrl = location ? normalizeIdealCandidateUrl(location, currentUrl) : "";
    if (locationUrl) {
      if (isFinalIdealPaymentUrl(locationUrl)) {
        return { paymentUrl: locationUrl, resolved: true, statuses, hops: [...hops, safeUrlDebugLabel(locationUrl)].filter(Boolean) };
      }
      if (idealPaymentUrlRank(locationUrl, ["ideal_redirect_location"]) > 0 && !seen.has(locationUrl)) {
        currentUrl = locationUrl;
        continue;
      }
    }

    const contentType = response.headers.get("content-type") || "";
    const shouldReadBody =
      response.status < 400 &&
      (contentType.includes("text/html") ||
        contentType.includes("application/xhtml") ||
        contentType.includes("application/json") ||
        contentType.includes("text/plain") ||
        !contentType);
    if (!shouldReadBody) break;

    const bodyText = await response.text().catch(() => "");
    const candidateUrls = collectIdealCandidateUrlsFromText(bodyText, responseUrl);
    const finalCandidate = candidateUrls.find(isFinalIdealPaymentUrl);
    if (finalCandidate) {
      return { paymentUrl: finalCandidate, resolved: true, statuses, hops: [...hops, safeUrlDebugLabel(finalCandidate)].filter(Boolean) };
    }

    const nextCandidate = candidateUrls
      .map((url) => ({ url, rank: idealPaymentUrlRank(url, ["ideal_redirect_html"]) }))
      .filter((item) => item.rank > 0 && !seen.has(item.url))
      .sort((a, b) => b.rank - a.rank)[0]?.url;
    if (nextCandidate) {
      currentUrl = nextCandidate;
      continue;
    }

    break;
  }

  return { paymentUrl: currentUrl, resolved: isFinalIdealPaymentUrl(currentUrl), statuses, hops };
}

async function makePaymentUrlQrPng(paymentUrl: string) {
  if (!/^https?:\/\//i.test(paymentUrl)) {
    throw new Error("IDEAL payment URL is invalid.");
  }
  return QRCode.toBuffer(paymentUrl, {
    type: "png",
    errorCorrectionLevel: "M",
    margin: 4,
    scale: 12,
  });
}

async function extractIdealPaymentFromCredentialWithProxy(
  credential: string,
  proxyUrl: string,
  options?: InternalUpiExtractionOptions
): Promise<ExtractedIdealPayment> {
  const proxyLabel = describeUpstreamProxy(proxyUrl);
  const providerProxy = getProviderProxyAttempt(options, proxyUrl);
  const providerProxyUrl = providerProxy.proxyUrl;
  const providerProxyLabel = providerProxy.label;
  reportExtractionProgress(options, { stage: "validating", percent: 10, proxy: proxyLabel });
  const { accessToken } = await resolveCredential(credential, proxyUrl);
  reportExtractionDebug(options, "info", "Credential resolved for IDEAL extraction", {
    stage: "validating",
    percent: 12,
    proxy: proxyLabel,
    details: { hasAccessToken: Boolean(accessToken) },
  });

  reportExtractionProgress(options, { stage: "checkout", percent: 24, proxy: proxyLabel });
  const checkout = await callIdealCheckout(accessToken, proxyUrl);
  reportExtractionDebug(options, checkout.status >= 400 ? "warn" : "info", "ChatGPT IDEAL checkout response", {
    stage: "checkout",
    percent: 28,
    proxy: proxyLabel,
    details: summarizeHttpDebug(checkout.status, checkout.data, {
      country: process.env.CHATGPT_IDEAL_COUNTRY || "NL",
      currency: process.env.CHATGPT_IDEAL_CURRENCY || "EUR",
    }),
  });
  if (checkout.status >= 400 || !isObject(checkout.data) || checkout.data.error) {
    const checkoutError = compactError(checkout.data);
    if (isBillingCountryLockedErrorMessage(checkoutError)) throw new BillingCountryLockedError();
    throw new Error(`Create IDEAL checkout failed: ${checkoutError}`);
  }

  const checkoutSessionId = String(checkout.data.checkout_session_id || checkout.data.cs_id || "").trim();
  const publishableKey = String(checkout.data.publishable_key || "").trim();
  const processorEntity = String(checkout.data.processor_entity || "openai_llc").trim() || "openai_llc";
  if (!checkoutSessionId || !publishableKey) {
    throw new Error(`IDEAL checkout response is missing required fields: ${compactError(checkout.data)}`);
  }

  const steps: ExtractedIdealPayment["steps"] = [];
  const useSnapshot = options?.experimentalSnapshot ?? boolFromEnv(process.env.CHATGPT_IDEAL_EXPERIMENT_SNAPSHOT);
  const useElementsSession = options?.experimentalElementsSession ?? boolFromEnv(process.env.CHATGPT_IDEAL_EXPERIMENT_ELEMENTS_SESSION);
  const chatGptPaymentUrl = `https://chatgpt.com/checkout/${processorEntity}/${checkoutSessionId}`;

  if (useSnapshot) {
    const snapshot = await callIdealCheckoutSnapshot(accessToken, checkoutSessionId, processorEntity, providerProxyUrl);
    steps.push({ name: "chatgpt_checkout_snapshot_ideal", status: snapshot.status });
    reportExtractionDebug(options, snapshot.status >= 400 ? "warn" : "debug", "ChatGPT IDEAL checkout snapshot response", {
      stage: "checkout",
      percent: 32,
      proxy: providerProxyLabel,
      details: summarizeHttpDebug(snapshot.status, snapshot.data),
    });
  }

  const stripeJsId = randomUUID().replace(/-/g, "");
  reportExtractionProgress(options, { stage: "stripe_init", percent: 38, proxy: providerProxyLabel });
  const init = await callIdealStripeInit(checkoutSessionId, publishableKey, providerProxyUrl, stripeJsId);
  steps.push({ name: "stripe_init_ideal", status: init.status });
  reportExtractionDebug(options, init.status >= 400 ? "warn" : "info", "Stripe IDEAL init response", {
    stage: "stripe_init",
    percent: 40,
    proxy: providerProxyLabel,
    details: summarizeHttpDebug(init.status, init.data, {
      paymentAmount: extractPaymentAmountMaybe(init.data),
    }),
  });
  if (init.status >= 400 || !isObject(init.data) || init.data.error) {
    throw new Error(`Stripe IDEAL init failed: ${compactError(init.data)}`);
  }

  const freeTrialStatus = getFreeTrialStatusFromStripeInit(init.data);
  steps.push({
    name: "free_trial_check_ideal",
    status: freeTrialStatus.hasFreeTrial ? 200 : 402,
    state: {
      due: freeTrialStatus.due,
      subtotal: freeTrialStatus.subtotal,
      discountAmount: freeTrialStatus.discountAmount,
      couponName: freeTrialStatus.couponName,
      percentOff: freeTrialStatus.percentOff,
      durationMonths: freeTrialStatus.durationMonths,
      paymentMethodTypes: freeTrialStatus.paymentMethodTypes,
    },
  });
  reportExtractionDebug(options, freeTrialStatus.hasFreeTrial ? "info" : "warn", "IDEAL free trial status parsed from Stripe init", {
    stage: "stripe_init",
    percent: 44,
    proxy: providerProxyLabel,
    details: {
      hasFreeTrial: freeTrialStatus.hasFreeTrial,
      due: freeTrialStatus.due,
      subtotal: freeTrialStatus.subtotal,
      discountAmount: freeTrialStatus.discountAmount,
      couponName: freeTrialStatus.couponName,
      percentOff: freeTrialStatus.percentOff,
      durationMonths: freeTrialStatus.durationMonths,
      paymentMethodTypes: freeTrialStatus.paymentMethodTypes,
    },
  });
  if (!freeTrialStatus.hasFreeTrial) throw new NoFreeTrialError();
  if (freeTrialStatus.paymentMethodTypes.length > 0 && !freeTrialStatus.paymentMethodTypes.includes("ideal")) {
    throw new PaymentMethodUnavailableError("ideal", freeTrialStatus.paymentMethodTypes);
  }

  let elementsSessionId = "";
  if (useElementsSession) {
    const elementsSession = await callIdealStripeElementsSession(checkoutSessionId, publishableKey, extractPaymentAmount(init.data), providerProxyUrl, stripeJsId);
    elementsSessionId = getNestedString(elementsSession.data, ["session_id"]);
    steps.push({
      name: "stripe_elements_session_ideal",
      status: elementsSession.status,
      state: elementsSessionId ? "has_session_id" : "missing_session_id",
    });
    reportExtractionDebug(options, elementsSession.status >= 400 ? "warn" : "debug", "Stripe IDEAL elements session response", {
      stage: "stripe_init",
      percent: 47,
      proxy: providerProxyLabel,
      details: summarizeHttpDebug(elementsSession.status, elementsSession.data, { hasElementsSessionId: Boolean(elementsSessionId) }),
    });
    if (elementsSession.status >= 400 || !elementsSessionId) elementsSessionId = "";
  }

  const taxRegionUpdate = await callIdealStripeUpdateTaxRegion(checkoutSessionId, publishableKey, providerProxyUrl, stripeJsId, elementsSessionId);
  steps.push({ name: "stripe_update_tax_region_ideal", status: taxRegionUpdate.status });
  reportExtractionDebug(options, taxRegionUpdate.status >= 400 ? "warn" : "debug", "Stripe IDEAL tax region update response", {
    stage: "stripe_init",
    percent: 50,
    proxy: providerProxyLabel,
    details: summarizeHttpDebug(taxRegionUpdate.status, taxRegionUpdate.data),
  });
  if (taxRegionUpdate.status >= 400 || !isObject(taxRegionUpdate.data) || taxRegionUpdate.data.error) {
    throw new Error(`Stripe IDEAL tax region update failed: ${compactError(taxRegionUpdate.data)}`);
  }

  reportExtractionProgress(options, { stage: "stripe_confirm", percent: 52, proxy: providerProxyLabel });
  const confirm = await callIdealStripeConfirm(checkoutSessionId, publishableKey, taxRegionUpdate.data, providerProxyUrl, stripeJsId, processorEntity, elementsSessionId);
  const useSubmissionAttemptId = options?.experimentalSubmissionAttemptId ?? boolFromEnv(process.env.CHATGPT_IDEAL_EXPERIMENT_SUBMISSION_ATTEMPT_ID);
  const submissionAttemptId = useSubmissionAttemptId ? getNestedString(confirm.data, ["submission_attempt", "id"]) : "";
  steps.push({
    name: "stripe_confirm_ideal",
    status: confirm.status,
    state: nestedGet(confirm.data, ["submission_attempt", "state"]),
    result: submissionAttemptId ? "submission_attempt_id" : undefined,
  });
  reportExtractionDebug(options, confirm.status >= 400 ? "warn" : "info", "Stripe IDEAL confirm response", {
    stage: "stripe_confirm",
    percent: 56,
    proxy: providerProxyLabel,
    details: summarizeHttpDebug(confirm.status, confirm.data, {
      submissionAttemptState: nestedGet(confirm.data, ["submission_attempt", "state"]),
      hasSubmissionAttemptId: Boolean(submissionAttemptId),
    }),
  });
  if (confirm.status >= 400 || !isObject(confirm.data) || confirm.data.error) {
    throw new Error(`Stripe IDEAL confirm failed: ${compactError(confirm.data)}`);
  }

  reportExtractionProgress(options, { stage: "approval", percent: 66, proxy: providerProxyLabel });
  const approvalAttempts = normalizeAttemptCount(
    options?.approvalAttempts ?? process.env.CHATGPT_IDEAL_APPROVAL_ATTEMPTS ?? process.env.CHATGPT_UPI_APPROVAL_ATTEMPTS,
    DEFAULT_APPROVAL_ATTEMPTS
  );
  const approvalParallelism = normalizeApprovalParallelism(
    options?.approvalParallelism ?? process.env.CHATGPT_IDEAL_APPROVAL_PARALLELISM ?? process.env.CHATGPT_UPI_APPROVAL_PARALLELISM,
    1
  );
  const approval = await callChatGptIdealCheckoutApproval(
    accessToken,
    checkoutSessionId,
    processorEntity,
    providerProxyUrl,
    approvalAttempts,
    approvalParallelism,
    options?.approvalProxyAttempts,
    submissionAttemptId,
    options
  );
  steps.push({
    name: `chatgpt_checkout_ideal_${approval.name || "approval"}`,
    status: approval.status,
    result: isObject(approval.data) ? approval.data.result : undefined,
    attemptStatuses: approval.attemptStatuses,
  });
  const approvalResultText = checkoutApprovalResultText(approval.data);
  reportExtractionDebug(options, isCheckoutApprovalAccepted(approval) ? "info" : "warn", "ChatGPT IDEAL approval response", {
    stage: "approval",
    percent: 68,
    proxy: providerProxyLabel,
    details: summarizeHttpDebug(approval.status, approval.data, {
      approvalResult: approvalResultText,
      attemptStatuses: approval.attemptStatuses,
    }),
  });

  if (approval.status >= 400 || approvalResultText !== "approved") {
    const approveAttempts = approval.attemptStatuses?.length ? ` approve_attempts=${approval.attemptStatuses.join("/")}` : "";
    throw new IdealPaymentUnavailableError(`ChatGPT IDEAL approval failed: HTTP ${approval.status} ${compactError(approval.data)}.${approveAttempts}`);
  }

  let artifact = collectIdealPaymentArtifact(init.data, confirm.data, approval.data);
  const getStatuses: number[] = [];
  const pageSnapshots: unknown[] = [];
  for (let attempt = 0; attempt < 12 && (artifact.rank || 0) < 90; attempt += 1) {
    reportExtractionProgress(options, {
      stage: "waiting_qr",
      percent: 72 + Math.min(16, attempt),
      proxy: providerProxyLabel,
    });
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1000));
    const page = await callStripePaymentPageGet(checkoutSessionId, publishableKey, providerProxyUrl, stripeJsId, elementsSessionId);
    getStatuses.push(page.status);
    pageSnapshots.push(page.data);
    artifact = collectIdealPaymentArtifact(init.data, confirm.data, approval.data, ...pageSnapshots);
    reportExtractionDebug(options, page.status >= 400 ? "warn" : "debug", "Stripe IDEAL payment page polling response", {
      stage: "waiting_qr",
      percent: 72 + Math.min(16, attempt),
      proxy: providerProxyLabel,
      details: summarizeHttpDebug(page.status, page.data, {
        pollAttempt: attempt + 1,
        artifactRank: artifact.rank || 0,
        hasPaymentUrl: Boolean(artifact.paymentUrl),
        hasRedirectUrl: Boolean(artifact.redirectUrl),
        expiresAt: artifact.expiresAt || null,
      }),
    });
    if (page.status >= 400) break;
  }
  if (getStatuses.length > 0) {
    steps.push({ name: "stripe_payment_page_get_ideal", status: getStatuses[getStatuses.length - 1], attemptStatuses: getStatuses });
  }

  let paymentUrl = artifact.paymentUrl;
  if (!paymentUrl) {
    throw new IdealPaymentUnavailableError("IDEAL payment URL was not returned after approval.");
  }

  if (!isFinalIdealPaymentUrl(paymentUrl)) {
    reportExtractionProgress(options, { stage: "waiting_qr", percent: 92, proxy: providerProxyLabel });
    const redirectResolution = await resolveIdealFinalPaymentUrl(paymentUrl, providerProxyUrl);
    if (redirectResolution.statuses.length > 0) {
      steps.push({
        name: "ideal_redirect_resolve",
        status: redirectResolution.statuses[redirectResolution.statuses.length - 1],
        result: redirectResolution.resolved ? "resolved" : "unresolved",
        attemptStatuses: redirectResolution.statuses,
      });
    }
    reportExtractionDebug(options, redirectResolution.resolved ? "info" : "warn", "IDEAL final payment redirect resolution", {
      stage: "waiting_qr",
      percent: 94,
      proxy: providerProxyLabel,
      details: {
        resolved: redirectResolution.resolved,
        statuses: redirectResolution.statuses,
        hops: redirectResolution.hops,
        finalHost: (() => {
          try { return new URL(redirectResolution.paymentUrl).host; } catch { return ""; }
        })(),
        error: redirectResolution.error || null,
      },
    });
    paymentUrl = redirectResolution.paymentUrl;
  }

  if (!isFinalIdealPaymentUrl(paymentUrl)) {
    const host = (() => {
      try { return new URL(paymentUrl).host; } catch { return ""; }
    })();
    throw new IdealPaymentUnavailableError(`IDEAL final payment URL was not resolved after approval${host ? ` (last host: ${host})` : ""}.`);
  }

  reportExtractionProgress(options, { stage: "rendering_qr", percent: 96, proxy: providerProxyLabel });
  const qrPngBuffer = await makePaymentUrlQrPng(paymentUrl);
  reportExtractionDebug(options, "info", "IDEAL payment URL extracted and QR rendered", {
    stage: "rendering_qr",
    percent: 98,
    proxy: providerProxyLabel,
    details: {
      paymentUrlHost: (() => {
        try { return new URL(paymentUrl).host; } catch { return ""; }
      })(),
      expiresAt: artifact.expiresAt || null,
    },
  });
  reportExtractionProgress(options, { stage: "completed", percent: 100, proxy: providerProxyLabel });

  return {
    checkoutSessionId,
    publishableKey,
    processorEntity,
    paymentUrl,
    chatGptPaymentUrl,
    expiresAt: artifact.expiresAt || Math.floor(Date.now() / 1000) + 300,
    qrPngBuffer,
    paymentMethodTypes: freeTrialStatus.paymentMethodTypes,
    steps,
  };
}

export async function extractIdealPaymentFromCredential(credential: string, options?: UpiExtractionOptions): Promise<ExtractedIdealPayment> {
  const proxyPool = options?.proxyPool || "public";
  const checkoutProxyUrl = getCustomProxyUrl(options?.checkoutProxyUrl);
  const explicitAttempts = checkoutProxyUrl ? getExplicitProxyAttempts([checkoutProxyUrl]) : getExplicitProxyAttempts(options?.experimentalProxyUrls);
  const allAttempts = explicitAttempts.length ? explicitAttempts : await getProxyAttempts(proxyPool);
  const requestedMaxProxyAttempts = Math.max(1, Math.floor(options?.maxProxyAttempts || allAttempts.length || 1));
  const attempts = selectProxyAttemptsForExtraction(allAttempts, requestedMaxProxyAttempts);
  const noFreeTrialState = createNoFreeTrialConfirmationState(attempts);
  const errors: string[] = [];
  let firstError: unknown = null;

  reportExtractionProgress(options, { stage: "queued", percent: 4, maxAttempts: attempts.length });
  for (const [attemptIndex, attempt] of attempts.entries()) {
    try {
      await throwIfExtractionCancelled(options);
      reportExtractionProgress(options, {
        stage: "validating",
        percent: 8,
        proxy: attempt.label,
        attempt: attemptIndex + 1,
        maxAttempts: attempts.length,
      });
      return await extractIdealPaymentFromCredentialWithProxy(credential, attempt.proxyUrl, {
        ...options,
        approvalProxyAttempts: options?.providerProxyUrl ? [getProviderProxyAttempt(options, attempt.proxyUrl)] : rotateProxyAttempts(allAttempts, attemptIndex),
        onProgress: (progress) => {
          options?.onProgress?.({
            ...progress,
            proxy: attempt.label,
            attempt: attemptIndex + 1,
            maxAttempts: attempts.length,
          });
        },
        onDebug: (event) => {
          options?.onDebug?.({
            ...event,
            proxy: event.proxy || attempt.label,
            maxAttempts: event.maxAttempts || attempts.length,
            details: {
              ...(isObject(event.details) ? event.details : { value: event.details }),
              proxyAttempt: attemptIndex + 1,
              proxyAttempts: attempts.length,
            },
          });
        },
      });
    } catch (error) {
      if (!firstError) firstError = error;
      if (error instanceof NoFreeTrialError) {
        handleNoFreeTrialConfirmation(noFreeTrialState, "IDEAL", attempt, attemptIndex, attempts, options);
        continue;
      }
      if (
        error instanceof EmailBoundError ||
        error instanceof BillingCountryLockedError ||
        error instanceof PaymentMethodUnavailableError ||
        isBillingCountryLockedErrorMessage(error instanceof Error ? error.message : String(error)) ||
        isNonRetryableCredentialError(error)
      ) throw error;
      const message = compactThrownError(error);
      errors.push(`${attempt.label}: ${message}`);
      reportExtractionProgress(options, {
        stage: "retrying",
        percent: 8,
        proxy: attempt.label,
        attempt: attemptIndex + 1,
        maxAttempts: attempts.length,
      });
      reportExtractionDebug(options, "warn", "IDEAL extraction proxy attempt failed", {
        stage: "retrying",
        percent: 8,
        proxy: attempt.label,
        attempt: attemptIndex + 1,
        maxAttempts: attempts.length,
        details: { error: message },
      });
      console.warn("IDEAL extraction failed on proxy, trying next proxy", {
        proxy: attempt.label,
        error: message,
      });
    }
  }

  if (noFreeTrialState.proxyLabels.length >= noFreeTrialState.target) {
    throw new NoFreeTrialError([...noFreeTrialState.proxyLabels]);
  }
  if (firstError && errors.length === 0) throw firstError;
  console.warn("IDEAL extraction failed after all proxy attempts", {
    attempts: attempts.length,
    errors,
  });
  throw new Error(summarizeExtractionFailure(errors, attempts.length, "ideal"));
}

async function extractUpiQrFromCredentialWithProxy(
  credential: string,
  proxyUrl: string,
  options?: InternalUpiExtractionOptions
): Promise<ExtractedUpiQr> {
  const proxyLabel = describeUpstreamProxy(proxyUrl);
  const providerProxy = getProviderProxyAttempt(options, proxyUrl);
  const providerProxyUrl = providerProxy.proxyUrl;
  const providerProxyLabel = providerProxy.label;
  reportExtractionProgress(options, { stage: "validating", percent: 10, proxy: proxyLabel });
  const { accessToken } = await resolveCredential(credential, proxyUrl);
  reportExtractionDebug(options, "info", "Credential resolved for UPI extraction", {
    stage: "validating",
    percent: 12,
    proxy: proxyLabel,
    details: { hasAccessToken: Boolean(accessToken) },
  });

  reportExtractionProgress(options, { stage: "checkout", percent: 24, proxy: proxyLabel });
  const checkout = await callCheckout(accessToken, proxyUrl);
  reportExtractionDebug(options, checkout.status >= 400 ? "warn" : "info", "ChatGPT UPI checkout response", {
    stage: "checkout",
    percent: 28,
    proxy: proxyLabel,
    details: summarizeHttpDebug(checkout.status, checkout.data, {
      country: process.env.CHATGPT_UPI_COUNTRY || "IN",
      currency: process.env.CHATGPT_UPI_CURRENCY || "INR",
    }),
  });
  if (checkout.status >= 400 || !isObject(checkout.data) || checkout.data.error) {
    const checkoutError = compactError(checkout.data);
    if (isBillingCountryLockedErrorMessage(checkoutError)) throw new BillingCountryLockedError();
    throw new Error(`Create UPI checkout failed: ${checkoutError}`);
  }

  const checkoutSessionId = String(checkout.data.checkout_session_id || checkout.data.cs_id || "").trim();
  const publishableKey = String(checkout.data.publishable_key || "").trim();
  const processorEntity = String(checkout.data.processor_entity || "openai_llc").trim() || "openai_llc";
  if (!checkoutSessionId || !publishableKey) {
    throw new Error(`checkout 响应缺少必要字段：${compactError(checkout.data)}`);
  }

  const steps: ExtractedUpiQr["steps"] = [];
  const useSnapshot = options?.experimentalSnapshot ?? boolFromEnv(process.env.CHATGPT_UPI_EXPERIMENT_SNAPSHOT);
  const useElementsSession = options?.experimentalElementsSession ?? boolFromEnv(process.env.CHATGPT_UPI_EXPERIMENT_ELEMENTS_SESSION);
  const useSubmissionAttemptId = options?.experimentalSubmissionAttemptId ?? boolFromEnv(process.env.CHATGPT_UPI_EXPERIMENT_SUBMISSION_ATTEMPT_ID);
  if (useSnapshot) {
    const snapshot = await callCheckoutSnapshot(accessToken, checkoutSessionId, processorEntity, providerProxyUrl);
    steps.push({ name: "chatgpt_checkout_snapshot", status: snapshot.status });
    reportExtractionDebug(options, snapshot.status >= 400 ? "warn" : "debug", "ChatGPT UPI checkout snapshot response", {
      stage: "checkout",
      percent: 32,
      proxy: providerProxyLabel,
      details: summarizeHttpDebug(snapshot.status, snapshot.data),
    });
    if (snapshot.status >= 400 || !isObject(snapshot.data) || snapshot.data.error) {
      console.warn("ChatGPT checkout snapshot failed, continuing UPI extraction experiment", {
        status: snapshot.status,
        error: compactError(snapshot.data),
        proxy: proxyLabel,
      });
    }
  }
  const stripeJsId = randomUUID().replace(/-/g, "");
  reportExtractionProgress(options, { stage: "stripe_init", percent: 38, proxy: providerProxyLabel });
  const init = await callStripeInit(checkoutSessionId, publishableKey, providerProxyUrl, stripeJsId);
  steps.push({ name: "stripe_init_custom", status: init.status });
  reportExtractionDebug(options, init.status >= 400 ? "warn" : "info", "Stripe UPI init response", {
    stage: "stripe_init",
    percent: 40,
    proxy: providerProxyLabel,
    details: summarizeHttpDebug(init.status, init.data, {
      paymentAmount: extractPaymentAmountMaybe(init.data),
    }),
  });
  if (init.status >= 400 || !isObject(init.data) || init.data.error) {
    throw new Error(`Stripe custom init failed: ${compactError(init.data)}`);
  }

  const freeTrialStatus = getFreeTrialStatusFromStripeInit(init.data);
  steps.push({
    name: "free_trial_check",
    status: freeTrialStatus.hasFreeTrial ? 200 : 402,
    state: {
      due: freeTrialStatus.due,
      subtotal: freeTrialStatus.subtotal,
      discountAmount: freeTrialStatus.discountAmount,
      couponName: freeTrialStatus.couponName,
      percentOff: freeTrialStatus.percentOff,
      durationMonths: freeTrialStatus.durationMonths,
    },
  });
  reportExtractionDebug(options, freeTrialStatus.hasFreeTrial ? "info" : "warn", "UPI free trial status parsed from Stripe init", {
    stage: "stripe_init",
    percent: 44,
    proxy: providerProxyLabel,
    details: {
      hasFreeTrial: freeTrialStatus.hasFreeTrial,
      due: freeTrialStatus.due,
      subtotal: freeTrialStatus.subtotal,
      discountAmount: freeTrialStatus.discountAmount,
      couponName: freeTrialStatus.couponName,
      percentOff: freeTrialStatus.percentOff,
      durationMonths: freeTrialStatus.durationMonths,
      paymentMethodTypes: freeTrialStatus.paymentMethodTypes,
      hasUpi: freeTrialStatus.hasUpi,
    },
  });
  if (!freeTrialStatus.hasFreeTrial) {
    throw new NoFreeTrialError();
  }

  const paymentMethods = freeTrialStatus.paymentMethodTypes;
  if (paymentMethods.length > 0 && !freeTrialStatus.hasUpi) {
    throw new PaymentMethodUnavailableError("upi", paymentMethods);
  }

  let elementsSessionId = "";
  if (useElementsSession) {
    const elementsSession = await callStripeElementsSession(checkoutSessionId, publishableKey, extractPaymentAmount(init.data), providerProxyUrl, stripeJsId);
    elementsSessionId = getNestedString(elementsSession.data, ["session_id"]);
    steps.push({
      name: "stripe_elements_session",
      status: elementsSession.status,
      state: elementsSessionId ? "has_session_id" : "missing_session_id",
    });
    reportExtractionDebug(options, elementsSession.status >= 400 ? "warn" : "debug", "Stripe UPI elements session response", {
      stage: "stripe_init",
      percent: 47,
      proxy: providerProxyLabel,
      details: summarizeHttpDebug(elementsSession.status, elementsSession.data, { hasElementsSessionId: Boolean(elementsSessionId) }),
    });
    if (elementsSession.status >= 400 || !isObject(elementsSession.data) || elementsSession.data.error || !elementsSessionId) {
      console.warn("Stripe elements/sessions experiment failed, continuing without elements session id", {
        status: elementsSession.status,
        error: compactError(elementsSession.data),
        proxy: providerProxyLabel,
      });
      elementsSessionId = "";
    }
  }

  const taxRegionUpdate = await callStripeUpdateTaxRegion(checkoutSessionId, publishableKey, providerProxyUrl, stripeJsId, elementsSessionId);
  steps.push({ name: "stripe_update_tax_region", status: taxRegionUpdate.status });
  reportExtractionDebug(options, taxRegionUpdate.status >= 400 ? "warn" : "debug", "Stripe UPI tax region update response", {
    stage: "stripe_init",
    percent: 50,
    proxy: providerProxyLabel,
    details: summarizeHttpDebug(taxRegionUpdate.status, taxRegionUpdate.data),
  });
  if (taxRegionUpdate.status >= 400 || !isObject(taxRegionUpdate.data) || taxRegionUpdate.data.error) {
    throw new Error(`Stripe tax region update failed: ${compactError(taxRegionUpdate.data)}`);
  }

  reportExtractionProgress(options, { stage: "stripe_confirm", percent: 52, proxy: providerProxyLabel });
  const confirm = await callStripeConfirm(checkoutSessionId, publishableKey, taxRegionUpdate.data, providerProxyUrl, stripeJsId, processorEntity, elementsSessionId);
  const submissionAttemptId = useSubmissionAttemptId ? getNestedString(confirm.data, ["submission_attempt", "id"]) : "";
  steps.push({
    name: "stripe_confirm_upi",
    status: confirm.status,
    state: nestedGet(confirm.data, ["submission_attempt", "state"]),
    result: submissionAttemptId ? "submission_attempt_id" : undefined,
  });
  reportExtractionDebug(options, confirm.status >= 400 ? "warn" : "info", "Stripe UPI confirm response", {
    stage: "stripe_confirm",
    percent: 56,
    proxy: providerProxyLabel,
    details: summarizeHttpDebug(confirm.status, confirm.data, {
      submissionAttemptState: nestedGet(confirm.data, ["submission_attempt", "state"]),
      hasSubmissionAttemptId: Boolean(submissionAttemptId),
    }),
  });
  if (confirm.status >= 400 || !isObject(confirm.data) || confirm.data.error) {
    throw new Error(`Stripe UPI confirm failed: ${compactError(confirm.data)}`);
  }

  reportExtractionProgress(options, { stage: "approval", percent: 66, proxy: providerProxyLabel });
  const approvalAttempts = normalizeAttemptCount(
    options?.approvalAttempts ?? process.env.CHATGPT_UPI_APPROVAL_ATTEMPTS,
    DEFAULT_APPROVAL_ATTEMPTS
  );
  const approvalParallelism = normalizeApprovalParallelism(
    options?.approvalParallelism ?? process.env.CHATGPT_UPI_APPROVAL_PARALLELISM,
    1
  );
  const approval = approvalParallelism > 1
    ? await callChatGptCheckoutApprovalParallel(
      accessToken,
      checkoutSessionId,
      processorEntity,
      providerProxyUrl,
      approvalAttempts,
      approvalParallelism,
      options?.approvalProxyAttempts,
      submissionAttemptId,
      "upi",
      options
      )
    : await callChatGptCheckoutApproval(accessToken, checkoutSessionId, processorEntity, providerProxyUrl, approvalAttempts, submissionAttemptId, "upi", options);
  steps.push({
    name: `chatgpt_checkout_${approval.name || "approval"}`,
    status: approval.status,
    result: isObject(approval.data) ? approval.data.result : undefined,
    attemptStatuses: approval.attemptStatuses,
  });

  const approvalResultText = checkoutApprovalResultText(approval.data);
  reportExtractionDebug(options, isCheckoutApprovalAccepted(approval) ? "info" : "warn", "ChatGPT UPI approval response", {
    stage: "approval",
    percent: 68,
    proxy: providerProxyLabel,
    details: summarizeHttpDebug(approval.status, approval.data, {
      approvalResult: approvalResultText,
      attemptStatuses: approval.attemptStatuses,
    }),
  });
  if (approval.status >= 400 || approvalResultText !== "approved") {
    const approveAttempts = approval.attemptStatuses?.length ? ` approve_attempts=${approval.attemptStatuses.join("/")}` : "";
    throw new UpiQrUnavailableError(`ChatGPT approval 返回异常：HTTP ${approval.status} ${compactError(approval.data)}.${approveAttempts}`);
  }

  let qrData: UpiQrData = {};
  for (const source of [confirm.data, approval.data]) {
    const extracted = extractUpiNextAction(source);
    qrData = { ...qrData, ...Object.fromEntries(Object.entries(extracted).filter(([, value]) => value)) };
  }

  const getStatuses: number[] = [];
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (qrData.upiUri || qrData.hostedInstructionsUrl || qrData.qrImageUrlSvg || qrData.qrImageUrlPng) break;
    reportExtractionProgress(options, {
      stage: "waiting_qr",
      percent: 72 + Math.min(16, attempt),
      proxy: providerProxyLabel,
    });
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1000));
    const page = await callStripePaymentPageGet(checkoutSessionId, publishableKey, providerProxyUrl, stripeJsId, elementsSessionId);
    getStatuses.push(page.status);
    const extracted = extractUpiNextAction(page.data);
    qrData = { ...qrData, ...Object.fromEntries(Object.entries(extracted).filter(([, value]) => value)) };
    reportExtractionDebug(options, page.status >= 400 ? "warn" : "debug", "Stripe UPI payment page polling response", {
      stage: "waiting_qr",
      percent: 72 + Math.min(16, attempt),
      proxy: providerProxyLabel,
      details: summarizeHttpDebug(page.status, page.data, {
        pollAttempt: attempt + 1,
        hasUpiUri: Boolean(qrData.upiUri),
        hasHostedInstructionsUrl: Boolean(qrData.hostedInstructionsUrl),
        hasQrImageUrlSvg: Boolean(qrData.qrImageUrlSvg),
        hasQrImageUrlPng: Boolean(qrData.qrImageUrlPng),
      }),
    });
    if (page.status >= 400) break;
  }
  if (getStatuses.length) {
    steps.push({ name: "stripe_payment_page_get", status: getStatuses[getStatuses.length - 1], attemptStatuses: getStatuses });
  }

  if (!qrData.upiUri && !qrData.hostedInstructionsUrl && !qrData.qrImageUrlSvg && !qrData.qrImageUrlPng) {
    const refresh = await callStripeInit(checkoutSessionId, publishableKey, providerProxyUrl, stripeJsId);
    steps.push({ name: "stripe_init_refresh", status: refresh.status });
    const extracted = extractUpiNextAction(refresh.data);
    qrData = { ...qrData, ...Object.fromEntries(Object.entries(extracted).filter(([, value]) => value)) };
    reportExtractionDebug(options, refresh.status >= 400 ? "warn" : "debug", "Stripe UPI init refresh response", {
      stage: "waiting_qr",
      percent: 89,
      proxy: providerProxyLabel,
      details: summarizeHttpDebug(refresh.status, refresh.data, {
        hasUpiUri: Boolean(qrData.upiUri),
        hasHostedInstructionsUrl: Boolean(qrData.hostedInstructionsUrl),
        hasQrImageUrlSvg: Boolean(qrData.qrImageUrlSvg),
        hasQrImageUrlPng: Boolean(qrData.qrImageUrlPng),
      }),
    });
  }

  reportExtractionProgress(options, { stage: "hydrating", percent: 91, proxy: providerProxyLabel });
  qrData = await hydrateUpiQrData(qrData, providerProxyUrl);
  reportExtractionDebug(options, qrData.upiUri || qrData.mobileAuthUrl ? "info" : "warn", "UPI QR data hydrated", {
    stage: "hydrating",
    percent: 92,
    proxy: providerProxyLabel,
    details: {
      hasUpiUri: Boolean(qrData.upiUri),
      hasMobileAuthUrl: Boolean(qrData.mobileAuthUrl),
      hasHostedInstructionsUrl: Boolean(qrData.hostedInstructionsUrl),
      hasQrImageUrlSvg: Boolean(qrData.qrImageUrlSvg),
      hasQrImageUrlPng: Boolean(qrData.qrImageUrlPng),
      expiresAt: qrData.expiresAt || null,
    },
  });
  const upiUri = qrData.upiUri || qrData.mobileAuthUrl || "";
  if (!upiUri) {
    console.error("UPI extraction failed without upi uri", {
      steps,
      hasHostedInstructionsUrl: Boolean(qrData.hostedInstructionsUrl),
      hasQrImageUrlSvg: Boolean(qrData.qrImageUrlSvg),
      hasQrImageUrlPng: Boolean(qrData.qrImageUrlPng),
      approvalStatus: approval.status,
      approvalResult: isObject(approval.data) ? approval.data.result : undefined,
      proxy: providerProxyLabel,
    });
    const stepText = steps.map((step) => {
      const suffix = step.attemptStatuses?.length ? ` attempts=${step.attemptStatuses.join("/")}` : "";
      const state = step.state ? ` state=${String(step.state)}` : "";
      const result = step.result ? ` result=${String(step.result)}` : "";
      return `${step.name}:${step.status}${state}${result}${suffix}`;
    }).join(" -> ");
    let detail = `未在协议响应中拿到 upi:// 数据，无法生成二维码。已完成步骤：${stepText || "none"}。`;
    if (approval.status < 400 && isObject(approval.data) && String(approval.data.result || "").toLowerCase() === "approved") {
      detail += " ChatGPT 已返回 approved，但 Stripe 未下发 UPI 二维码字段，可能是该 checkout/账号/出口暂未生成 UPI 指令，请稍后重试或更换代理出口。";
    }
    if (approval.status >= 400 || (isObject(approval.data) && ["blocked", "exception"].includes(String(approval.data.result || "").toLowerCase()))) {
      detail += ` ChatGPT approval 返回异常：HTTP ${approval.status} ${compactError(approval.data)}`;
    }
    throw new UpiQrUnavailableError(detail);
  }

  reportExtractionProgress(options, { stage: "rendering_qr", percent: 96, proxy: providerProxyLabel });
  const qrPngBuffer = await makeUpiQrPng(upiUri);
  reportExtractionDebug(options, "info", "UPI URI extracted and QR rendered", {
    stage: "rendering_qr",
    percent: 98,
    proxy: providerProxyLabel,
    details: {
      expiresAt: qrData.expiresAt || null,
      upiUriPrefix: upiUri.slice(0, 16),
    },
  });
  reportExtractionProgress(options, { stage: "completed", percent: 100, proxy: providerProxyLabel });

  return {
    checkoutSessionId,
    publishableKey,
    processorEntity,
    upiUri,
    hostedInstructionsUrl: qrData.hostedInstructionsUrl,
    expiresAt: qrData.expiresAt || Math.floor(Date.now() / 1000) + 300,
    qrPngBuffer,
    steps,
  };
}

export async function extractUpiQrFromCredential(credential: string, options?: UpiExtractionOptions): Promise<ExtractedUpiQr> {
  const proxyPool = options?.proxyPool || "public";
  const checkoutProxyUrl = getCustomProxyUrl(options?.checkoutProxyUrl);
  const explicitAttempts = checkoutProxyUrl ? getExplicitProxyAttempts([checkoutProxyUrl]) : getExplicitProxyAttempts(options?.experimentalProxyUrls);
  const allAttempts = explicitAttempts.length ? explicitAttempts : await getProxyAttempts(proxyPool);
  const requestedMaxProxyAttempts = Math.max(1, Math.floor(options?.maxProxyAttempts || allAttempts.length || 1));
  const attempts = selectProxyAttemptsForExtraction(allAttempts, requestedMaxProxyAttempts);
  const noFreeTrialState = createNoFreeTrialConfirmationState(attempts);
  const errors: string[] = [];
  let firstError: unknown = null;

  reportExtractionProgress(options, { stage: "queued", percent: 4, maxAttempts: attempts.length });
  for (const [attemptIndex, attempt] of attempts.entries()) {
    try {
      await throwIfExtractionCancelled(options);
      reportExtractionProgress(options, {
        stage: "validating",
        percent: 8,
        proxy: attempt.label,
        attempt: attemptIndex + 1,
        maxAttempts: attempts.length,
      });
      return await extractUpiQrFromCredentialWithProxy(credential, attempt.proxyUrl, {
        ...options,
        approvalProxyAttempts: options?.providerProxyUrl ? [getProviderProxyAttempt(options, attempt.proxyUrl)] : rotateProxyAttempts(allAttempts, attemptIndex),
        onProgress: (progress) => {
          options?.onProgress?.({
            ...progress,
            proxy: attempt.label,
            attempt: attemptIndex + 1,
            maxAttempts: attempts.length,
          });
        },
        onDebug: (event) => {
          options?.onDebug?.({
            ...event,
            proxy: event.proxy || attempt.label,
            maxAttempts: event.maxAttempts || attempts.length,
            details: {
              ...(isObject(event.details) ? event.details : { value: event.details }),
              proxyAttempt: attemptIndex + 1,
              proxyAttempts: attempts.length,
            },
          });
        },
      });
    } catch (error) {
      if (!firstError) firstError = error;
      if (error instanceof NoFreeTrialError) {
        handleNoFreeTrialConfirmation(noFreeTrialState, "UPI", attempt, attemptIndex, attempts, options);
        continue;
      }
      if (
        error instanceof EmailBoundError ||
        error instanceof BillingCountryLockedError ||
        error instanceof PaymentMethodUnavailableError ||
        isBillingCountryLockedErrorMessage(error instanceof Error ? error.message : String(error)) ||
        isNonRetryableCredentialError(error)
      ) throw error;
      const message = compactThrownError(error);
      errors.push(`${attempt.label}: ${message}`);
      reportExtractionProgress(options, {
        stage: "retrying",
        percent: 8,
        proxy: attempt.label,
        attempt: attemptIndex + 1,
        maxAttempts: attempts.length,
      });
      reportExtractionDebug(options, "warn", "UPI extraction proxy attempt failed", {
        stage: "retrying",
        percent: 8,
        proxy: attempt.label,
        attempt: attemptIndex + 1,
        maxAttempts: attempts.length,
        details: { error: message },
      });
      console.warn("UPI extraction failed on proxy, trying next proxy", {
        proxy: attempt.label,
        error: message,
      });
    }
  }

  if (noFreeTrialState.proxyLabels.length >= noFreeTrialState.target) {
    throw new NoFreeTrialError([...noFreeTrialState.proxyLabels]);
  }
  if (firstError && errors.length === 0) throw firstError;
  console.warn("UPI extraction failed after all proxy attempts", {
    attempts: attempts.length,
    errors,
  });
  throw new Error(summarizeExtractionFailure(errors, attempts.length, "upi"));
}
