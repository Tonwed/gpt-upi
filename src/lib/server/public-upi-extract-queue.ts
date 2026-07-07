import { createHash, randomUUID } from "crypto";
import { checkChatGptSubscription, extractIdealPaymentFromCredential, extractUpiQrFromCredential, NoFreeTrialError, PaymentMethodUnavailableError, type UpiExtractionDebugEvent, type UpiExtractionProgress } from "@/lib/server/chatgpt-upi";
import { prisma } from "@/lib/server/prisma";
import { decryptSessionCredential, encryptSessionCredential, hashSessionCredential } from "@/lib/server/credential-vault";
import { createPublicScanOrderFromTicket, createPublicScanOrderTicket } from "@/lib/server/public-scan-orders";
import { notifyPublicUpiExtractResult } from "@/lib/server/public-user-settings";
import { PUBLIC_SCAN_ORDER_PRICE, freezePublicScanOrderFunds, refundPublicScanOrderFunds } from "@/lib/server/public-user-wallet";
import { disableActiveUpiGuards, recordUpiGuardUseFailure, recordUpiGuardUseSuccess } from "@/lib/server/upi-guard";
import { cleanupGuardCreateTickets, createGuardCreateTicket } from "@/lib/server/upi-guard-tickets";
import { PUBLIC_SCAN_PENDING_AUTO_RETURN_REASON, expireStaleOrders, orderInclude } from "@/lib/server/orders";
import { serializeWorkerOrder, type OrderWithRelations } from "@/lib/server/serializers";
import { getConfiguredUpstreamProxies } from "@/lib/server/upstream-proxy";
import { deleteCachedJson, deleteLocalCachedJson, getCachedJson } from "@/lib/server/redis-cache";

const RATE_LIMIT_MS = 60_000;
const FALLBACK_QR_TTL_MS = 5 * 60 * 1000;
const TERMINAL_JOB_TTL_MS = 15 * 60 * 1000;
const SUBSCRIPTION_CHECK_COOLDOWN_MS = 5_000;
const ACTIVE_JOB_TTL_MS = 60 * 60 * 1000;
const UNTIL_SUCCESS_RETRY_DELAY_MS = 2_000;
const MAX_ACTIVITY_ITEMS = 320;
const MAX_DEBUG_LOGS_PER_JOB = 800;
const MAX_PERSISTED_ACTIVE_JOB_RESTORE = 120;
const MAX_PERSISTED_QUEUED_JOB_RESTORE = 500;
const STALE_PERSISTED_RUNNING_REQUEUE_MS = 30 * 60 * 1000;
const HEATMAP_OVERVIEW_CACHE_TTL_MS = 1_500;
const HEATMAP_OVERVIEW_LOCAL_CACHE_TTL_MS = 450;
const PROXY_COUNT_CACHE_TTL_MS = 10_000;
const CANCEL_CHECK_CACHE_MS = 500;
const DEFAULT_MAX_CONCURRENT_EXTRACTIONS_BY_CHANNEL: ChannelMap<number> = {
  public: 10,
  premium: 20,
};
const MIN_CONCURRENT_EXTRACTIONS = 1;
const SETTING_UPI_EXTRACT_PAUSED_BY_CHANNEL: ChannelMap<string> = {
  public: "public_upi_extract_paused",
  premium: "premium_upi_extract_paused",
};
const SETTING_UPI_EXTRACT_CONCURRENCY_BY_CHANNEL: ChannelMap<string> = {
  public: "public_upi_extract_concurrency",
  premium: "premium_upi_extract_concurrency",
};
const ABANDONED_ACTIVITY_ERROR = "Extraction task interrupted: the server restarted or temporary task data was lost. Please submit again.";
const UPI_EXTRACT_CHANNELS = ["public", "premium"] as const;

export type PublicUpiExtractStatus = "queued" | "running" | "completed" | "failed";
export type PublicUpiExtractSource = "direct" | "storage";
export type PublicUpiExtractChannel = typeof UPI_EXTRACT_CHANNELS[number];
export type PublicUpiExtractMethod = "upi" | "ideal";
export type PublicUpiExtractUserHistoryFilter = "all" | "active" | "completed" | "failed";
export type PublicUpiExtractDebugLogLevel = "debug" | "info" | "warn" | "error";
type ChannelMap<T> = Record<PublicUpiExtractChannel, T>;
type PublicUpiExtractRunnerMode = "inline" | "external" | "worker";

export type PublicUpiExtractDebugLogEntry = {
  seq: number;
  at: string;
  level: PublicUpiExtractDebugLogLevel;
  message: string;
  stage?: UpiExtractionProgress["stage"];
  percent?: number;
  proxy?: string;
  attempt?: number;
  maxAttempts?: number;
  details?: unknown;
};

function readRuntimeEnv(nameParts: string[]) {
  const key = nameParts.join("_");
  const env = process.env as Record<string, string | undefined>;
  return env[key];
}

function getPublicUpiExtractRunnerMode(): PublicUpiExtractRunnerMode {
  // Keep this as a runtime lookup. Next.js may freeze simple process.env.X reads
  // during build, while the production web/extractor split depends on launchctl
  // injecting UPI_EXTRACT_RUNNER at process start.
  const fallbackMode = process.env.NODE_ENV === "production" ? "external" : "inline";
  const mode = String(readRuntimeEnv(["UPI", "EXTRACT", "RUNNER"]) || fallbackMode).trim().toLowerCase();
  if (mode === "external") return "external";
  if (mode === "worker") return "worker";
  return "inline";
}

function shouldRunExtractorInThisProcess() {
  return getPublicUpiExtractRunnerMode() !== "external";
}

function shouldUseInMemoryRuntimeStateForReads() {
  return shouldRunExtractorInThisProcess();
}

export type PublicUpiExtractResult = {
  qrImageUrl: string;
  upiUri?: string;
  checkoutSessionId: string;
  processorEntity: string;
  paymentUrl: string;
  extractMethod?: PublicUpiExtractMethod;
  chatGptPaymentUrl?: string;
  stripeInstructionsUrl?: string;
  expiresAt: string;
  createdAt: string;
  accountEmail?: string | null;
  accountPhone?: string | null;
  guardCreateToken?: string;
  scanOrderCreateToken?: string;
  scanOrder?: ReturnType<typeof serializeWorkerOrder>;
  scanOrderError?: string;
};

export type PublicUpiExtractJob = {
  jobId: string;
  status: PublicUpiExtractStatus;
  source: PublicUpiExtractSource;
  channel: PublicUpiExtractChannel;
  extractMethod: PublicUpiExtractMethod;
  createdAt: string;
  updatedAt: string;
  publicUserTelegramId?: string | null;
  publicUserTelegramName?: string | null;
  accountEmail?: string | null;
  accountPhone?: string | null;
  subscriptionPlan?: string | null;
  subscriptionIsPlus?: boolean | null;
  subscriptionCheckedAt?: string | null;
  subscriptionCheckError?: string | null;
  progress?: UpiExtractionProgress & { updatedAt: string };
  result?: PublicUpiExtractResult;
  error?: string;
  untilSuccess?: boolean;
  autoPublishScanOrder?: boolean;
  approvalParallelism?: number;
  retryCount?: number;
  cancelled?: boolean;
  scanOrderFundsReserved?: boolean;
  scanOrderFundsReservedAmount?: number | null;
  scanOrderFundsReleasedAt?: string | null;
  scanOrderFundsTransferredAt?: string | null;
};

export type PublicUpiExtractActivity = {
  jobId: string;
  seq: number;
  status: PublicUpiExtractStatus;
  source: PublicUpiExtractSource;
  channel: PublicUpiExtractChannel;
  extractMethod?: PublicUpiExtractMethod;
  publicUserTelegramId?: string | null;
  publicUserTelegramName?: string | null;
  accountEmail?: string | null;
  accountPhone?: string | null;
  subscriptionPlan?: string | null;
  subscriptionIsPlus?: boolean | null;
  subscriptionCheckedAt?: string | null;
  subscriptionCheckError?: string | null;
  error?: string | null;
  resultPaymentUrl?: string | null;
  resultExpiresAt?: string | null;
  resultQrImageUrl?: string | null;
  resultUpiUri?: string | null;
  resultCheckoutSessionId?: string | null;
  resultProcessorEntity?: string | null;
  resultChatGptPaymentUrl?: string | null;
  resultStripeInstructionsUrl?: string | null;
  resultCreatedAt?: string | null;
  scanOrderId?: string | null;
  scanOrderCreateToken?: string | null;
  scanOrderCreateTokenExpiresAt?: string | null;
  scanOrderCreateTokenConsumedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PublicUpiExtractActivityCounts = Record<PublicUpiExtractStatus, number>;
export type PublicUpiExtractActivityCountsByChannel = ChannelMap<PublicUpiExtractActivityCounts>;
export type PublicUpiExtractHeatmapStatusCode = "q" | "r" | "c" | "f";
export type PublicUpiExtractHeatmapChannelCode = "p" | "m";
export type PublicUpiExtractHeatmapSourceCode = "d" | "s";
export type PublicUpiExtractHeatmapItem = [
  seq: number,
  status: PublicUpiExtractHeatmapStatusCode,
  channel: PublicUpiExtractHeatmapChannelCode,
  source: PublicUpiExtractHeatmapSourceCode,
  updatedAtSec?: number,
];

export type PublicUpiExtractCapacity = ChannelMap<{
  concurrency: number;
  proxyCount: number;
}>;

export type PublicUpiExtractHeatmapOverview = {
  compact: true;
  channel: PublicUpiExtractChannel;
  items: PublicUpiExtractHeatmapItem[];
  counts: PublicUpiExtractActivityCounts;
  countsByChannel: PublicUpiExtractActivityCountsByChannel;
  storageActiveCount: number;
  paused: boolean;
  capacity: PublicUpiExtractCapacity;
};

export type PublicUpiExtractUserHistoryCounts = Record<PublicUpiExtractUserHistoryFilter, number>;

export type PublicUpiExtractUserHistoryPage = {
  items: PublicUpiExtractActivity[];
  filter: PublicUpiExtractUserHistoryFilter;
  counts: PublicUpiExtractUserHistoryCounts;
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
    hasPrev: boolean;
    hasNext: boolean;
    search: string;
  };
};

type QueuedExtractionPayload = {
  credential: string;
  issueGuardCreateToken: boolean;
  source: PublicUpiExtractSource;
  channel?: PublicUpiExtractChannel;
  extractMethod?: PublicUpiExtractMethod;
  guardId?: string;
  publicUserTelegramId?: string | null;
  publicUserTelegramName?: string | null;
  accountEmail?: string | null;
  accountPhone?: string | null;
  autoPublishScanOrder?: boolean;
  untilSuccess?: boolean;
  approvalParallelism?: number;
  checkoutProxyUrl?: string;
  providerProxyUrl?: string;
};

type PublicUpiExtractStore = {
  rateLimitMemory: Map<string, number>;
  jobs: Map<string, PublicUpiExtractJob>;
  activity: Map<string, PublicUpiExtractActivity>;
  queuedJobIdsByChannel: ChannelMap<string[]>;
  payloads: Map<string, QueuedExtractionPayload>;
  debugLogs: Map<string, PublicUpiExtractDebugLogEntry[]>;
  activityOmitJobIds: Set<string>;
  manuallyStoppedJobIds: Set<string>;
  cancelledJobIds: Set<string>;
  cancelCheckMemory: Map<string, { at: number; cancelled: boolean }>;
  activeRunIds: Map<string, number>;
  activeExtractionCountByChannel: ChannelMap<number>;
  nextActivitySeq: number;
  nextDebugLogSeq: number;
  nextRunSeq: number;
  paused: boolean;
  pausedByChannel: ChannelMap<boolean>;
  pauseLoaded: boolean;
  pauseLoadedByChannel: ChannelMap<boolean>;
  maxConcurrentByChannel: ChannelMap<number>;
  concurrencyLoadedByChannel: ChannelMap<boolean>;
};

type StoreGlobal = typeof globalThis & {
  __publicUpiExtractStore?: PublicUpiExtractStore;
  __publicUpiExtractActivityAccountColumnsPromise?: Promise<void> | null;
};

const store = ((globalThis as StoreGlobal).__publicUpiExtractStore ??= {
  rateLimitMemory: new Map<string, number>(),
  jobs: new Map<string, PublicUpiExtractJob>(),
  activity: new Map<string, PublicUpiExtractActivity>(),
  queuedJobIdsByChannel: { public: [], premium: [] },
  payloads: new Map<string, QueuedExtractionPayload>(),
  debugLogs: new Map<string, PublicUpiExtractDebugLogEntry[]>(),
  activityOmitJobIds: new Set<string>(),
  manuallyStoppedJobIds: new Set<string>(),
  cancelledJobIds: new Set<string>(),
  cancelCheckMemory: new Map<string, { at: number; cancelled: boolean }>(),
  activeRunIds: new Map<string, number>(),
  activeExtractionCountByChannel: { public: 0, premium: 0 },
  nextActivitySeq: 0,
  nextDebugLogSeq: 0,
  nextRunSeq: 0,
  paused: false,
  pausedByChannel: { public: false, premium: false },
  pauseLoaded: false,
  pauseLoadedByChannel: { public: false, premium: false },
  maxConcurrentByChannel: { ...DEFAULT_MAX_CONCURRENT_EXTRACTIONS_BY_CHANNEL },
  concurrencyLoadedByChannel: { public: false, premium: false },
});

function heatmapOverviewCacheKey(channel?: PublicUpiExtractChannel | null) {
  return `upi-extract:heatmap-overview:${channel ? normalizePublicUpiExtractChannel(channel) : "all"}`;
}

function heatmapOverviewCacheKeys(channel?: PublicUpiExtractChannel | null) {
  const keys = [
    heatmapOverviewCacheKey(null),
    heatmapOverviewCacheKey("public"),
    heatmapOverviewCacheKey("premium"),
  ];
  if (!channel) return keys;
  return [heatmapOverviewCacheKey(null), heatmapOverviewCacheKey(channel)];
}

function invalidateHeatmapOverviewCache(channel?: PublicUpiExtractChannel | null) {
  const keys = heatmapOverviewCacheKeys(channel);
  deleteLocalCachedJson(keys);
  void deleteCachedJson(keys);
}

function proxyCountCacheKey() {
  return "upi-extract:proxy-counts";
}

ensureStoreShape();

export function isPublicUpiExtractDebugLogsEnabled() {
  return false;
}

function redactDebugLogText(value: string) {
  return value
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted-jwt]")
    .replace(/[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/g, "[redacted-session-token]")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, "$1[redacted]");
}

function sanitizeDebugLogValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    const redacted = redactDebugLogText(value);
    return redacted.length > 4_000 ? `${redacted.slice(0, 4_000)}…` : redacted;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactDebugLogText(value.message),
    };
  }
  if (depth >= 4) return "[max-depth]";
  if (Array.isArray(value)) {
    return value.slice(0, 60).map((item) => sanitizeDebugLogValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
      const lowerKey = key.toLowerCase();
      if (lowerKey.includes("credential") || lowerKey.includes("sessiontoken") || lowerKey === "token" || lowerKey === "access_token") {
        output[key] = "[redacted]";
        continue;
      }
      output[key] = sanitizeDebugLogValue(item, depth + 1);
    }
    return output;
  }
  return String(value);
}

function appendPublicUpiExtractDebugLog(
  jobId: string,
  level: PublicUpiExtractDebugLogLevel,
  message: string,
  input: Partial<Omit<PublicUpiExtractDebugLogEntry, "seq" | "at" | "level" | "message">> = {}
) {
  if (!isPublicUpiExtractDebugLogsEnabled()) return;
  const safeJobId = String(jobId || "").trim();
  if (!safeJobId) return;
  const logs = store.debugLogs.get(safeJobId) || [];
  const entry: PublicUpiExtractDebugLogEntry = {
    seq: store.nextDebugLogSeq++,
    at: new Date().toISOString(),
    level,
    message: redactDebugLogText(message),
    ...(input.stage ? { stage: input.stage } : {}),
    ...(typeof input.percent === "number" ? { percent: Math.max(0, Math.min(100, Math.round(input.percent))) } : {}),
    ...(input.proxy ? { proxy: redactDebugLogText(input.proxy) } : {}),
    ...(typeof input.attempt === "number" ? { attempt: input.attempt } : {}),
    ...(typeof input.maxAttempts === "number" ? { maxAttempts: input.maxAttempts } : {}),
    ...(input.details !== undefined ? { details: sanitizeDebugLogValue(input.details) } : {}),
  };
  logs.push(entry);
  if (logs.length > MAX_DEBUG_LOGS_PER_JOB) logs.splice(0, logs.length - MAX_DEBUG_LOGS_PER_JOB);
  store.debugLogs.set(safeJobId, logs);
}

export function getPublicUpiExtractDebugLogs(jobId: string) {
  if (!isPublicUpiExtractDebugLogsEnabled()) return [];
  cleanupMemory();
  return [...(store.debugLogs.get(jobId) || [])];
}

async function ensureActivityAccountColumns() {
  const globalStore = globalThis as StoreGlobal;
  if (!globalStore.__publicUpiExtractActivityAccountColumnsPromise) {
    globalStore.__publicUpiExtractActivityAccountColumnsPromise = (async () => {
      await prisma.$executeRawUnsafe(`
        ALTER TABLE "public_upi_extract_activities"
          ADD COLUMN IF NOT EXISTS "accountEmail" TEXT,
          ADD COLUMN IF NOT EXISTS "accountPhone" TEXT,
          ADD COLUMN IF NOT EXISTS "extractMethod" TEXT DEFAULT 'upi',
          ADD COLUMN IF NOT EXISTS "subscriptionPlan" TEXT,
          ADD COLUMN IF NOT EXISTS "subscriptionIsPlus" BOOLEAN,
          ADD COLUMN IF NOT EXISTS "subscriptionCheckedAt" TIMESTAMP(3),
          ADD COLUMN IF NOT EXISTS "subscriptionCheckError" TEXT,
          ADD COLUMN IF NOT EXISTS "credentialEncrypted" TEXT,
          ADD COLUMN IF NOT EXISTS "credentialHash" TEXT,
          ADD COLUMN IF NOT EXISTS "customCheckoutProxyEncrypted" TEXT,
          ADD COLUMN IF NOT EXISTS "customProviderProxyEncrypted" TEXT,
          ADD COLUMN IF NOT EXISTS "issueGuardCreateToken" BOOLEAN DEFAULT FALSE,
          ADD COLUMN IF NOT EXISTS "guardId" TEXT,
          ADD COLUMN IF NOT EXISTS "autoPublishScanOrder" BOOLEAN DEFAULT FALSE,
          ADD COLUMN IF NOT EXISTS "untilSuccess" BOOLEAN DEFAULT FALSE,
          ADD COLUMN IF NOT EXISTS "approvalParallelism" INTEGER DEFAULT 1,
          ADD COLUMN IF NOT EXISTS "cancelled" BOOLEAN DEFAULT FALSE,
          ADD COLUMN IF NOT EXISTS "retryCount" INTEGER DEFAULT 0,
          ADD COLUMN IF NOT EXISTS "progressStage" TEXT,
          ADD COLUMN IF NOT EXISTS "progressPercent" INTEGER,
          ADD COLUMN IF NOT EXISTS "progressAttempt" INTEGER,
          ADD COLUMN IF NOT EXISTS "progressMaxAttempts" INTEGER,
          ADD COLUMN IF NOT EXISTS "progressUpdatedAt" TIMESTAMP(3),
          ADD COLUMN IF NOT EXISTS "resultQrImageUrl" TEXT,
          ADD COLUMN IF NOT EXISTS "resultUpiUri" TEXT,
          ADD COLUMN IF NOT EXISTS "resultCheckoutSessionId" TEXT,
          ADD COLUMN IF NOT EXISTS "resultProcessorEntity" TEXT,
          ADD COLUMN IF NOT EXISTS "resultChatGptPaymentUrl" TEXT,
          ADD COLUMN IF NOT EXISTS "resultStripeInstructionsUrl" TEXT,
          ADD COLUMN IF NOT EXISTS "resultCreatedAt" TIMESTAMP(3),
          ADD COLUMN IF NOT EXISTS "scanOrderId" TEXT,
          ADD COLUMN IF NOT EXISTS "scanOrderCreateToken" TEXT,
          ADD COLUMN IF NOT EXISTS "scanOrderCreateTokenExpiresAt" TIMESTAMP(3),
          ADD COLUMN IF NOT EXISTS "scanOrderCreateTokenConsumedAt" TIMESTAMP(3),
          ADD COLUMN IF NOT EXISTS "scanOrderFundsReserved" BOOLEAN DEFAULT FALSE,
          ADD COLUMN IF NOT EXISTS "scanOrderFundsReservedAmount" DECIMAL(10, 2),
          ADD COLUMN IF NOT EXISTS "scanOrderFundsReservedAt" TIMESTAMP(3),
          ADD COLUMN IF NOT EXISTS "scanOrderFundsReleasedAt" TIMESTAMP(3),
          ADD COLUMN IF NOT EXISTS "scanOrderFundsTransferredAt" TIMESTAMP(3)
      `);
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS "public_upi_extract_activities_method_created_idx"
          ON "public_upi_extract_activities" ("extractMethod", "createdAt")
      `);
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS "public_upi_extract_activities_active_payload_idx"
          ON "public_upi_extract_activities" ("status", "channel", "createdAt")
          WHERE "credentialEncrypted" IS NOT NULL
      `);
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS "public_upi_extract_activities_scan_token_idx"
          ON "public_upi_extract_activities" ("scanOrderCreateToken")
          WHERE "scanOrderCreateToken" IS NOT NULL
      `);
    })().catch((error) => {
      globalStore.__publicUpiExtractActivityAccountColumnsPromise = null;
      throw error;
    });
  }
  return globalStore.__publicUpiExtractActivityAccountColumnsPromise;
}

export function normalizePublicUpiExtractChannel(channel?: string | null): PublicUpiExtractChannel {
  return channel === "premium" ? "premium" : "public";
}

export function normalizePublicUpiExtractMethod(method?: string | null): PublicUpiExtractMethod {
  return String(method || "").trim().toLowerCase() === "ideal" ? "ideal" : "upi";
}

const PUBLIC_UPI_APPROVAL_PARALLELISM = 1;

function normalizeApprovalParallelismInput(value: unknown) {
  void value;
  return PUBLIC_UPI_APPROVAL_PARALLELISM;
}

function emptyChannelQueues(): ChannelMap<string[]> {
  return { public: [], premium: [] };
}

function emptyChannelCounts(): ChannelMap<number> {
  return { public: 0, premium: 0 };
}

function ensureStoreShape() {
  const legacyStore = store as PublicUpiExtractStore & {
    queuedJobIds?: string[];
    activeExtractionCount?: number;
    cancelledJobIds?: Set<string>;
    cancelCheckMemory?: Map<string, { at: number; cancelled: boolean }>;
  };
  if (!legacyStore.queuedJobIdsByChannel) {
    legacyStore.queuedJobIdsByChannel = emptyChannelQueues();
  }
  if (!legacyStore.debugLogs) {
    legacyStore.debugLogs = new Map<string, PublicUpiExtractDebugLogEntry[]>();
  }
  if (typeof legacyStore.nextDebugLogSeq !== "number") {
    legacyStore.nextDebugLogSeq = 0;
  }
  if (Array.isArray(legacyStore.queuedJobIds) && legacyStore.queuedJobIds.length > 0) {
    legacyStore.queuedJobIdsByChannel.public.push(...legacyStore.queuedJobIds);
    legacyStore.queuedJobIds = [];
  }
  if (!legacyStore.activeExtractionCountByChannel) {
    legacyStore.activeExtractionCountByChannel = emptyChannelCounts();
  }
  if (!legacyStore.activityOmitJobIds) {
    legacyStore.activityOmitJobIds = new Set<string>();
  }
  if (!legacyStore.manuallyStoppedJobIds) {
    legacyStore.manuallyStoppedJobIds = new Set<string>();
  }
  if (!legacyStore.cancelledJobIds) {
    legacyStore.cancelledJobIds = new Set<string>();
  }
  if (!legacyStore.cancelCheckMemory) {
    legacyStore.cancelCheckMemory = new Map<string, { at: number; cancelled: boolean }>();
  }
  if (typeof legacyStore.activeExtractionCount === "number" && legacyStore.activeExtractionCount > 0) {
    legacyStore.activeExtractionCountByChannel.public += legacyStore.activeExtractionCount;
    legacyStore.activeExtractionCount = 0;
  }
  if (!legacyStore.pausedByChannel) {
    legacyStore.pausedByChannel = { public: Boolean(legacyStore.paused), premium: Boolean(legacyStore.paused) };
  }
  if (!legacyStore.pauseLoadedByChannel) {
    legacyStore.pauseLoadedByChannel = { public: Boolean(legacyStore.pauseLoaded), premium: Boolean(legacyStore.pauseLoaded) };
  }
  if (!legacyStore.maxConcurrentByChannel) {
    legacyStore.maxConcurrentByChannel = { ...DEFAULT_MAX_CONCURRENT_EXTRACTIONS_BY_CHANNEL };
  }
  if (!legacyStore.concurrencyLoadedByChannel) {
    legacyStore.concurrencyLoadedByChannel = { public: false, premium: false };
  }
}

function parseBooleanSetting(value: string | null | undefined) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isEnvPaused(channel: PublicUpiExtractChannel) {
  const channelEnv = channel === "premium" ? process.env.PREMIUM_UPI_EXTRACT_PAUSED : process.env.PUBLIC_UPI_EXTRACT_PAUSED;
  return parseBooleanSetting(channelEnv) || parseBooleanSetting(process.env.UPI_EXTRACT_PAUSED);
}

function normalizeConcurrency(value: unknown, fallback: number) {
  const numeric = Math.floor(Number(value));
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(MIN_CONCURRENT_EXTRACTIONS, numeric);
}

function getEnvConcurrency(channel: PublicUpiExtractChannel) {
  const value = channel === "premium"
    ? process.env.PREMIUM_UPI_EXTRACT_CONCURRENCY
    : process.env.PUBLIC_UPI_EXTRACT_CONCURRENCY;
  return normalizeConcurrency(value || process.env.UPI_EXTRACT_CONCURRENCY, DEFAULT_MAX_CONCURRENT_EXTRACTIONS_BY_CHANNEL[channel]);
}

async function loadPublicUpiExtractConcurrency(channel: PublicUpiExtractChannel) {
  const normalizedChannel = normalizePublicUpiExtractChannel(channel);
  const fallback = getEnvConcurrency(normalizedChannel);
  try {
    const setting = await prisma.systemSetting.findUnique({
      where: { key: SETTING_UPI_EXTRACT_CONCURRENCY_BY_CHANNEL[normalizedChannel] },
      select: { value: true },
    });
    store.maxConcurrentByChannel[normalizedChannel] = normalizeConcurrency(setting?.value, fallback);
    store.concurrencyLoadedByChannel[normalizedChannel] = true;
  } catch (error) {
    console.error("Failed to read public UPI extraction concurrency setting", error);
    store.maxConcurrentByChannel[normalizedChannel] = fallback;
  }

  return store.maxConcurrentByChannel[normalizedChannel];
}

function getMaxConcurrentCached(channel: PublicUpiExtractChannel) {
  const normalizedChannel = normalizePublicUpiExtractChannel(channel);
  return normalizeConcurrency(
    store.maxConcurrentByChannel[normalizedChannel],
    DEFAULT_MAX_CONCURRENT_EXTRACTIONS_BY_CHANNEL[normalizedChannel]
  );
}

export async function isPublicUpiExtractPaused(channel: PublicUpiExtractChannel = "public") {
  const normalizedChannel = normalizePublicUpiExtractChannel(channel);
  await loadPublicUpiExtractConcurrency(normalizedChannel);
  if (isEnvPaused(normalizedChannel)) {
    store.pausedByChannel[normalizedChannel] = true;
    store.paused = store.pausedByChannel.public;
    store.pauseLoadedByChannel[normalizedChannel] = true;
    store.pauseLoaded = true;
    return true;
  }

  try {
    const setting = await prisma.systemSetting.findUnique({
      where: { key: SETTING_UPI_EXTRACT_PAUSED_BY_CHANNEL[normalizedChannel] },
      select: { value: true },
    });
    store.pausedByChannel[normalizedChannel] = parseBooleanSetting(setting?.value);
    store.paused = store.pausedByChannel.public;
    store.pauseLoadedByChannel[normalizedChannel] = true;
    store.pauseLoaded = true;
  } catch (error) {
    console.error("Failed to read public UPI extraction pause setting", error);
  }

  return store.pausedByChannel[normalizedChannel];
}

function isPublicUpiExtractPausedCached(channel: PublicUpiExtractChannel) {
  return isEnvPaused(channel) || store.pausedByChannel[channel];
}

export async function setPublicUpiExtractPaused(paused: boolean, channel: PublicUpiExtractChannel = "public") {
  const normalizedChannel = normalizePublicUpiExtractChannel(channel);
  await prisma.systemSetting.upsert({
    where: { key: SETTING_UPI_EXTRACT_PAUSED_BY_CHANNEL[normalizedChannel] },
    update: { value: paused ? "true" : "false" },
    create: { key: SETTING_UPI_EXTRACT_PAUSED_BY_CHANNEL[normalizedChannel], value: paused ? "true" : "false" },
  });
  store.pausedByChannel[normalizedChannel] = paused;
  store.paused = store.pausedByChannel.public;
  store.pauseLoadedByChannel[normalizedChannel] = true;
  store.pauseLoaded = true;
  invalidateHeatmapOverviewCache(normalizedChannel);
  if (!paused && shouldRunExtractorInThisProcess()) processExtractionQueue({ channel: normalizedChannel });
  return paused;
}

export async function setPublicUpiExtractConcurrency(channel: PublicUpiExtractChannel, value: unknown) {
  const normalizedChannel = normalizePublicUpiExtractChannel(channel);
  const concurrency = normalizeConcurrency(value, DEFAULT_MAX_CONCURRENT_EXTRACTIONS_BY_CHANNEL[normalizedChannel]);
  await prisma.systemSetting.upsert({
    where: { key: SETTING_UPI_EXTRACT_CONCURRENCY_BY_CHANNEL[normalizedChannel] },
    update: { value: String(concurrency) },
    create: { key: SETTING_UPI_EXTRACT_CONCURRENCY_BY_CHANNEL[normalizedChannel], value: String(concurrency) },
  });
  store.maxConcurrentByChannel[normalizedChannel] = concurrency;
  store.concurrencyLoadedByChannel[normalizedChannel] = true;
  invalidateHeatmapOverviewCache(normalizedChannel);
  if (shouldRunExtractorInThisProcess()) processExtractionQueue({ channel: normalizedChannel });
  return concurrency;
}

export async function checkPublicUpiExtractRateLimit(request: Request, channel: PublicUpiExtractChannel = "public") {
  const identityHash = hashIdentity(`${channel}:${getClientIdentity(request)}`);
  const now = Date.now();
  const lastAt = store.rateLimitMemory.get(identityHash) || 0;
  if (Number.isFinite(lastAt) && lastAt > 0) {
    const remainingMs = RATE_LIMIT_MS - (now - lastAt);
    if (remainingMs > 0) {
      return {
        allowed: false as const,
        remainingSeconds: Math.ceil(remainingMs / 1000),
      };
    }
  }

  store.rateLimitMemory.set(identityHash, now);
  cleanupMemory();
  return { allowed: true as const };
}

export async function getPublicUpiExtractJob(jobId: string) {
  cleanupMemory();
  const memoryJob = store.jobs.get(jobId) || null;
  const persistedJob = await getPersistedExtractJob(jobId);
  const job = shouldUseInMemoryRuntimeStateForReads()
    ? memoryJob || persistedJob
    : persistedJob || memoryJob;
  return maybeRetryAutoPublishedScanOrder(await refreshJobScanOrder(job));
}

export async function getPublicUpiExtractUserActiveJobs(telegramUserId: string, take = 20) {
  cleanupMemory();
  const safeTake = Math.max(1, Math.min(50, Math.floor(take)));
  const memoryJobs = shouldUseInMemoryRuntimeStateForReads()
    ? Array.from(store.jobs.values())
      .filter((job) => job.publicUserTelegramId === telegramUserId)
      .filter((job) => !job.cancelled)
      .filter((job) => job.status === "queued" || job.status === "running" || Boolean(job.result))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, safeTake)
    : [];
  const safeTelegramUserId = telegramUserId.replace(/'/g, "''");
  const persistedRows = await getPersistedExtractJobRows(`
    "publicUserTelegramId" = '${safeTelegramUserId}'
    AND COALESCE("cancelled", FALSE) = FALSE
    AND (
      "status" IN ('queued', 'running')
      OR (
        "resultQrImageUrl" IS NOT NULL
        AND (
          "resultExpiresAt" > NOW()
          OR EXISTS (
            SELECT 1
            FROM "orders" o
            WHERE o."id" = "public_upi_extract_activities"."scanOrderId"
              AND o."source" = 'PUBLIC_SCAN'
              AND o."status" IN ('PENDING', 'ASSIGNED', 'CHECKING')
          )
        )
      )
    )
  `, safeTake, `
    CASE WHEN "status" IN ('queued', 'running') THEN 0 ELSE 1 END ASC,
    "createdAt" DESC,
    "id" DESC
  `);
  const persistedJobs = await Promise.all(persistedRows.map((row) => rowToPublicUpiExtractJob(row)));
  const byJobId = new Map<string, PublicUpiExtractJob>();
  for (const job of persistedJobs) byJobId.set(job.jobId, job);
  for (const job of memoryJobs) byJobId.set(job.jobId, job);
  const jobs = Array.from(byJobId.values())
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, safeTake);
  return Promise.all(jobs.map(async (job) => maybeRetryAutoPublishedScanOrder(await refreshJobScanOrder(job))));
}

export async function countPublicUpiExtractUserActiveJobs(telegramUserId: string) {
  cleanupMemory();
  const jobIds = new Set<string>();
  if (shouldUseInMemoryRuntimeStateForReads()) {
    for (const job of store.jobs.values()) {
      if (job.publicUserTelegramId !== telegramUserId) continue;
      if (job.cancelled) continue;
      if (job.status !== "queued" && job.status !== "running") continue;
      jobIds.add(job.jobId);
    }
  }
  try {
    const safeTelegramUserId = telegramUserId.replace(/'/g, "''");
    const rows = await getPersistedExtractJobRows(`
      "publicUserTelegramId" = '${safeTelegramUserId}'
      AND COALESCE("cancelled", FALSE) = FALSE
      AND "status" IN ('queued', 'running')
    `, 100);
    for (const row of rows) jobIds.add(row.jobId);
  } catch (error) {
    console.error("Failed to count persisted public UPI extraction active jobs", error);
  }
  return jobIds.size;
}

export async function createPublicUpiExtractJob(payload: QueuedExtractionPayload) {
  const now = new Date().toISOString();
  const channel = normalizePublicUpiExtractChannel(payload.channel);
  const extractMethod = normalizePublicUpiExtractMethod(payload.extractMethod);
  const approvalParallelism = normalizeApprovalParallelismInput(payload.approvalParallelism);
  let job: PublicUpiExtractJob = {
    jobId: randomUUID(),
    status: "queued",
    source: payload.source,
    channel,
    extractMethod,
    publicUserTelegramId: payload.publicUserTelegramId || null,
    publicUserTelegramName: payload.publicUserTelegramName || null,
    accountEmail: payload.accountEmail || null,
    accountPhone: payload.accountPhone || null,
    untilSuccess: channel === "premium" && Boolean(payload.untilSuccess),
    autoPublishScanOrder: Boolean(payload.autoPublishScanOrder),
    approvalParallelism,
    retryCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  const normalizedPayload = { ...payload, channel, extractMethod, approvalParallelism };
  job = await reserveAutoPublishScanOrderFundsForJob(job, normalizedPayload);
  setJob(job);
  appendPublicUpiExtractDebugLog(job.jobId, "info", "Extraction job created", {
    stage: "queued",
    percent: 4,
    details: {
      source: job.source,
      channel,
      extractMethod,
      publicUserTelegramId: job.publicUserTelegramId || null,
      publicUserTelegramName: job.publicUserTelegramName || null,
      accountEmail: job.accountEmail || null,
      accountPhone: job.accountPhone || null,
      autoPublishScanOrder: job.autoPublishScanOrder,
      untilSuccess: job.untilSuccess,
      approvalParallelism,
    },
  });
  await persistActivity({
    jobId: job.jobId,
    seq: store.activity.get(job.jobId)?.seq ?? store.nextActivitySeq++,
    status: "queued",
    source: job.source,
    channel,
    extractMethod,
    publicUserTelegramId: job.publicUserTelegramId || null,
    publicUserTelegramName: job.publicUserTelegramName || null,
    accountEmail: job.accountEmail || null,
    accountPhone: job.accountPhone || null,
    error: null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }, job, normalizedPayload);
  enqueueExtractionJob(job.jobId, normalizedPayload);
  return job;
}

export function updatePublicUpiExtractJobScanOrder(jobId: string, order: OrderWithRelations) {
  const job = store.jobs.get(jobId);
  if (!job?.result) return job || null;
  const updated = withUpdatedPublicScanOrder(job, order);
  store.jobs.set(jobId, updated);
  return updated;
}

function withUpdatedPublicScanOrder(job: PublicUpiExtractJob, order: OrderWithRelations) {
  if (!job.result) return job;
  const transferredAt = job.scanOrderFundsReserved && !job.scanOrderFundsReleasedAt
    ? job.scanOrderFundsTransferredAt || new Date().toISOString()
    : job.scanOrderFundsTransferredAt || null;
  return {
    ...job,
    scanOrderFundsTransferredAt: transferredAt,
    result: {
      ...job.result,
      scanOrder: serializeWorkerOrder(order),
      scanOrderCreateToken: undefined,
    },
  } satisfies PublicUpiExtractJob;
}

async function markAutoPublishedScanOrderTerminalFailure(
  job: PublicUpiExtractJob,
  order: OrderWithRelations,
  error: string
) {
  const refreshed = withUpdatedPublicScanOrder(job, order);
  const failed = {
    ...refreshed,
    status: "failed" as const,
    error,
    progress: {
      ...(refreshed.progress || { stage: "completed" as const, percent: 100 }),
      updatedAt: new Date().toISOString(),
    },
  } satisfies PublicUpiExtractJob;
  store.payloads.delete(job.jobId);
  setJob(failed);
  await persistCurrentJobActivity(job.jobId);
  return store.jobs.get(job.jobId) || failed;
}

async function reserveAutoPublishScanOrderFundsForJob(job: PublicUpiExtractJob, payload: QueuedExtractionPayload) {
  if (!job.autoPublishScanOrder || job.scanOrderFundsReserved || !payload.publicUserTelegramId) return job;
  await ensureActivityAccountColumns();
  await prisma.$transaction(
    async (tx) => {
      await freezePublicScanOrderFunds(tx, {
        telegramUserId: payload.publicUserTelegramId || "",
        telegramUsername: payload.publicUserTelegramName || null,
      }, {
        orderId: job.jobId,
        referenceId: `auto_publish:${job.jobId}`,
        amount: PUBLIC_SCAN_ORDER_PRICE,
        note: "Auto-publish scan order reservation",
      });
    },
    { isolationLevel: "Serializable" }
  );
  return {
    ...job,
    scanOrderFundsReserved: true,
    scanOrderFundsReservedAmount: PUBLIC_SCAN_ORDER_PRICE,
  } satisfies PublicUpiExtractJob;
}

async function reserveAutoPublishScanOrderFundsForRetry(
  job: PublicUpiExtractJob,
  payload: QueuedExtractionPayload,
  reason: string
) {
  if (!job.autoPublishScanOrder || !payload.publicUserTelegramId) return job;
  await ensureActivityAccountColumns();

  const amount = Number(job.scanOrderFundsReservedAmount || PUBLIC_SCAN_ORDER_PRICE);
  await prisma.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<Array<{
        scanOrderId: string | null;
        scanOrderFundsReserved: boolean | null;
        scanOrderFundsReleasedAt: Date | null;
        scanOrderFundsTransferredAt: Date | null;
      }>>`
        SELECT
          "scanOrderId",
          "scanOrderFundsReserved",
          "scanOrderFundsReleasedAt",
          "scanOrderFundsTransferredAt"
        FROM "public_upi_extract_activities"
        WHERE "jobId" = ${job.jobId}
        FOR UPDATE
      `;
      const row = rows[0] || null;
      const alreadyHeld = Boolean(
        row?.scanOrderFundsReserved &&
        !row.scanOrderFundsReleasedAt &&
        !row.scanOrderFundsTransferredAt &&
        !row.scanOrderId
      );
      if (alreadyHeld) return;

      await freezePublicScanOrderFunds(tx, {
        telegramUserId: payload.publicUserTelegramId || "",
        telegramUsername: payload.publicUserTelegramName || null,
      }, {
        orderId: job.jobId,
        referenceId: `auto_publish_retry:${job.jobId}`,
        amount,
        note: reason,
      });

      await tx.$executeRaw`
        UPDATE "public_upi_extract_activities"
        SET "scanOrderId" = NULL,
            "scanOrderCreateToken" = NULL,
            "scanOrderCreateTokenExpiresAt" = NULL,
            "scanOrderCreateTokenConsumedAt" = NULL,
            "scanOrderFundsReserved" = TRUE,
            "scanOrderFundsReservedAmount" = ${amount},
            "scanOrderFundsReservedAt" = NOW(),
            "scanOrderFundsReleasedAt" = NULL,
            "scanOrderFundsTransferredAt" = NULL,
            "updatedAt" = NOW()
        WHERE "jobId" = ${job.jobId}
      `;
    },
    { isolationLevel: "Serializable" }
  );

  return {
    ...job,
    scanOrderFundsReserved: true,
    scanOrderFundsReservedAmount: amount,
    scanOrderFundsReleasedAt: null,
    scanOrderFundsTransferredAt: null,
  } satisfies PublicUpiExtractJob;
}

function isSerializableTransactionConflict(error: unknown) {
  const maybeError = error as { code?: string; meta?: { code?: string; message?: string }; message?: string };
  const message = `${maybeError?.message || ""} ${maybeError?.meta?.message || ""}`.toLowerCase();
  return (
    maybeError?.code === "P2034" ||
    (maybeError?.code === "P2010" && maybeError?.meta?.code === "40001") ||
    message.includes("could not serialize access") ||
    message.includes("serialization failure")
  );
}

async function releaseAutoPublishScanOrderReservation(job: PublicUpiExtractJob | null | undefined, reason: string) {
  if (!job?.publicUserTelegramId) return false;
  if (job.result?.scanOrder?.id) return false;
  await ensureActivityAccountColumns();

  const fallbackReserved = Boolean(job.scanOrderFundsReserved && !job.scanOrderFundsReleasedAt && !job.scanOrderFundsTransferredAt);
  const fallbackAmount = Number(job.scanOrderFundsReservedAmount || PUBLIC_SCAN_ORDER_PRICE);

  let released = false;
  try {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        released = await prisma.$transaction(
          async (tx) => {
            if (fallbackReserved) {
              await tx.$executeRaw`
                INSERT INTO "public_upi_extract_activities" (
                  "jobId",
                  "status",
                  "source",
                  "channel",
                  "extractMethod",
                  "publicUserTelegramId",
                  "publicUserTelegramName",
                  "autoPublishScanOrder",
                  "untilSuccess",
                  "cancelled",
                  "scanOrderFundsReserved",
                  "scanOrderFundsReservedAmount",
                  "scanOrderFundsReservedAt",
                  "createdAt",
                  "updatedAt"
                )
                VALUES (
                  ${job.jobId},
                  ${job.status},
                  ${job.source},
                  ${normalizePublicUpiExtractChannel(job.channel)},
                  ${normalizePublicUpiExtractMethod(job.extractMethod)},
                  ${job.publicUserTelegramId || null},
                  ${job.publicUserTelegramName || null},
                  ${Boolean(job.autoPublishScanOrder)},
                  ${Boolean(job.untilSuccess)},
                  ${Boolean(job.cancelled)},
                  TRUE,
                  ${fallbackAmount},
                  ${new Date(job.createdAt)},
                  ${new Date(job.createdAt)},
                  NOW()
                )
                ON CONFLICT ("jobId") DO NOTHING
              `;
            }
            const rows = await tx.$queryRaw<Array<{
              scanOrderId: string | null;
              scanOrderFundsReserved: boolean | null;
              scanOrderFundsReservedAmount: string | number | null;
              scanOrderFundsReleasedAt: Date | null;
              scanOrderFundsTransferredAt: Date | null;
            }>>`
              SELECT
                "scanOrderId",
                "scanOrderFundsReserved",
                "scanOrderFundsReservedAmount",
                "scanOrderFundsReleasedAt",
                "scanOrderFundsTransferredAt"
              FROM "public_upi_extract_activities"
              WHERE "jobId" = ${job.jobId}
              FOR UPDATE
            `;
            const movementRows = await tx.$queryRaw<Array<{ outstandingFrozen: string | number | null }>>`
              SELECT COALESCE(SUM("frozenDelta"), 0) AS "outstandingFrozen"
              FROM "public_user_wallet_ledgers"
              WHERE "telegramUserId" = ${job.publicUserTelegramId}
                AND "orderId" = ${job.jobId}
                AND "type" IN ('SCAN_ORDER_FREEZE', 'SCAN_ORDER_REFUND', 'SCAN_ORDER_SPEND')
            `;
            const row = rows[0] || null;
            const outstandingFrozen = Number(movementRows[0]?.outstandingFrozen || 0);
            const reserved = row
              ? Boolean(!row.scanOrderId && !row.scanOrderFundsTransferredAt && (
                (row.scanOrderFundsReserved && !row.scanOrderFundsReleasedAt) ||
                outstandingFrozen > 0
              ))
              : fallbackReserved || outstandingFrozen > 0;
            if (!reserved) return false;

            const amount = Number(row?.scanOrderFundsReservedAmount || outstandingFrozen || fallbackAmount || PUBLIC_SCAN_ORDER_PRICE);
            const refunded = await refundPublicScanOrderFunds(tx, {
              telegramUserId: job.publicUserTelegramId || "",
              orderId: job.jobId,
              amount,
              note: reason,
            });
            if (!refunded) return false;
            await tx.$executeRaw`
              UPDATE "public_upi_extract_activities"
              SET "scanOrderFundsReleasedAt" = NOW(),
                  "updatedAt" = NOW()
              WHERE "jobId" = ${job.jobId}
            `;
            return true;
          },
          { isolationLevel: "Serializable" }
        );
        break;
      } catch (error) {
        if (!isSerializableTransactionConflict(error) || attempt >= 4) throw error;
        await sleep(80 * attempt + Math.floor(Math.random() * 80));
      }
    }
  } catch (error) {
    console.error("Failed to release auto-publish scan order reservation", {
      jobId: job.jobId,
      telegramUserId: job.publicUserTelegramId,
      error: compactError(error),
    });
    return false;
  }

  if (released) {
    const current = store.jobs.get(job.jobId);
    if (current) {
      store.jobs.set(job.jobId, {
        ...current,
        scanOrderFundsReserved: true,
        scanOrderFundsReservedAmount: fallbackAmount,
        scanOrderFundsReleasedAt: new Date().toISOString(),
      });
    }
  }
  return released;
}

async function refreshJobScanOrder(job: PublicUpiExtractJob | null) {
  if (!job?.result?.scanOrder?.id) return job;
  try {
    await expireStaleOrders();
    const order = await prisma.order.findUnique({
      where: { id: job.result.scanOrder.id },
      include: orderInclude,
    });
    if (!order) return job;
    const typedOrder = order as OrderWithRelations;
    const keepPayloadForRetry = shouldRetryAutoPublishedScanOrder(job, typedOrder);
    if (
      typedOrder.source === "PUBLIC_SCAN" &&
      ["COMPLETED", "FAILED", "CANCELLED"].includes(typedOrder.status) &&
      !keepPayloadForRetry
    ) {
      store.payloads.delete(job.jobId);
    }
    if (typedOrder.source === "PUBLIC_SCAN" && typedOrder.status === "EXPIRED" && !keepPayloadForRetry) {
      store.payloads.delete(job.jobId);
    }
    const refreshed = withUpdatedPublicScanOrder(job, typedOrder);
    if (store.jobs.has(job.jobId)) store.jobs.set(job.jobId, refreshed);
    if (typedOrder.source === "PUBLIC_SCAN" && typedOrder.status === "COMPLETED") {
      return {
        ...refreshed,
        status: "completed" as const,
        error: undefined,
        cancelled: false,
        progress: {
          ...(refreshed.progress || { stage: "completed" as const, percent: 100 }),
          stage: "completed" as const,
          percent: 100,
          updatedAt: refreshed.progress?.updatedAt || new Date().toISOString(),
        },
      };
    }
    if (typedOrder.source === "PUBLIC_SCAN" && (typedOrder.status === "FAILED" || typedOrder.status === "EXPIRED")) {
      if (keepPayloadForRetry) {
        const retryReason = autoPublishRetryReason(typedOrder);
        const retryPayload = await getAutoPublishRetryPayload(refreshed, typedOrder);
        if (retryPayload?.autoPublishScanOrder && shouldRunExtractorInThisProcess()) {
          return requeueAutoPublishJob(refreshed, retryPayload, retryReason);
        }
        if (!retryPayload?.autoPublishScanOrder) {
          return markAutoPublishedScanOrderTerminalFailure(
            refreshed,
            typedOrder,
            "The scan order failed, but the saved session data is no longer available for automatic retry. Please submit a new task."
          );
        }
        return {
          ...refreshed,
          status: "queued" as const,
          error: retryReason,
          progress: {
            stage: "queued" as const,
            percent: 4,
            updatedAt: new Date().toISOString(),
          },
        };
      }

      return markAutoPublishedScanOrderTerminalFailure(
        refreshed,
        typedOrder,
        typedOrder.problemReason || autoPublishRetryReason(typedOrder)
      );
    }
    return refreshed;
  } catch (error) {
    console.warn("Failed to refresh public scan order status for extraction job", {
      jobId: job.jobId,
      orderId: job.result.scanOrder.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return job;
  }
}

export async function getPublicUpiExtractHeatmapOverview(channel?: PublicUpiExtractChannel | null): Promise<PublicUpiExtractHeatmapOverview> {
  const normalizedChannel = channel ? normalizePublicUpiExtractChannel(channel) : null;
  return getCachedJson(
    heatmapOverviewCacheKey(normalizedChannel),
    HEATMAP_OVERVIEW_CACHE_TTL_MS,
    () => getPublicUpiExtractHeatmapOverviewUncached(normalizedChannel),
    { localTtlMs: HEATMAP_OVERVIEW_LOCAL_CACHE_TTL_MS }
  );
}

async function getPublicUpiExtractHeatmapOverviewUncached(channel?: PublicUpiExtractChannel | null): Promise<PublicUpiExtractHeatmapOverview> {
  const normalizedChannel = channel ? normalizePublicUpiExtractChannel(channel) : null;
  cleanupMemory();

  await (normalizedChannel
    ? isPublicUpiExtractPaused(normalizedChannel)
    : Promise.all(UPI_EXTRACT_CHANNELS.map((item) => isPublicUpiExtractPaused(item))));

  if (shouldRunExtractorInThisProcess()) {
    await Promise.all([
      markAbandonedPersistedActivity(),
      disableActiveUpiGuards(),
    ]);
    await retryAutoPublishedScanOrdersReturnedBeforeAcceptance();
    processExtractionQueue(normalizedChannel ? { channel: normalizedChannel } : undefined);
  }

  const [items, countsByChannel, storageActiveCount] = await Promise.all([
    getActivityHeatmapItems(normalizedChannel || undefined),
    getActivityCountsByChannel(),
    getStorageActiveCount(),
  ]);
  const counts = normalizedChannel
    ? { ...countsByChannel[normalizedChannel] }
    : sumActivityCountsByChannel(countsByChannel);
  const { public: publicProxyCount, premium: premiumProxyCount } = await getConfiguredProxyCounts();
  return {
    compact: true,
    channel: normalizedChannel || "public",
    items,
    counts,
    countsByChannel,
    storageActiveCount,
    paused: normalizedChannel ? store.pausedByChannel[normalizedChannel] : store.pausedByChannel.public,
    capacity: {
      public: {
        concurrency: getMaxConcurrentCached("public"),
        proxyCount: publicProxyCount,
      },
      premium: {
        concurrency: getMaxConcurrentCached("premium"),
        proxyCount: premiumProxyCount,
      },
    },
  };
}

function normalizeUserHistoryFilter(filter?: string | null): PublicUpiExtractUserHistoryFilter {
  if (filter === "active" || filter === "completed" || filter === "failed") return filter;
  return "all";
}

function userHistoryFilterStatuses(filter: PublicUpiExtractUserHistoryFilter): PublicUpiExtractStatus[] | null {
  if (filter === "active") return ["queued", "running"];
  if (filter === "completed") return ["completed"];
  if (filter === "failed") return ["failed"];
  return null;
}

function matchesUserHistoryFilter(status: PublicUpiExtractStatus, filter: PublicUpiExtractUserHistoryFilter) {
  const statuses = userHistoryFilterStatuses(filter);
  return !statuses || statuses.includes(status);
}

function emptyUserHistoryCounts(): PublicUpiExtractUserHistoryCounts {
  return { all: 0, active: 0, completed: 0, failed: 0 };
}

function isMemoryActivityCancelled(item: Pick<PublicUpiExtractActivity, "jobId">) {
  return Boolean(store.jobs.get(item.jobId)?.cancelled);
}

function activityToUserHistoryItem(item: PublicUpiExtractActivity): PublicUpiExtractActivity {
  return {
    jobId: item.jobId,
    seq: item.seq,
    status: normalizeActivityStatus(item.status),
    source: normalizeActivitySource(item.source),
    channel: normalizePublicUpiExtractChannel(item.channel),
    extractMethod: normalizePublicUpiExtractMethod(item.extractMethod),
    publicUserTelegramId: item.publicUserTelegramId,
    publicUserTelegramName: item.publicUserTelegramName,
    accountEmail: item.accountEmail || null,
    accountPhone: item.accountPhone || null,
    subscriptionPlan: item.subscriptionPlan || null,
    subscriptionIsPlus: item.subscriptionIsPlus ?? null,
    subscriptionCheckedAt: item.subscriptionCheckedAt || null,
    subscriptionCheckError: item.subscriptionCheckError || null,
    error: item.error || null,
    resultPaymentUrl: item.resultPaymentUrl || null,
    resultExpiresAt: item.resultExpiresAt || null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function activityDbRowToUserHistoryItem(item: {
  id: number;
  jobId: string;
  status: string;
  source: string | null;
  channel: string | null;
  extractMethod?: string | null;
  publicUserTelegramId?: string | null;
  publicUserTelegramName?: string | null;
  accountEmail?: string | null;
  accountPhone?: string | null;
  subscriptionPlan?: string | null;
  subscriptionIsPlus?: boolean | null;
  subscriptionCheckedAt?: Date | string | null;
  subscriptionCheckError?: string | null;
  error?: string | null;
  resultPaymentUrl?: string | null;
  resultExpiresAt?: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}): PublicUpiExtractActivity {
  const createdAt = item.createdAt instanceof Date ? item.createdAt.toISOString() : item.createdAt;
  const updatedAt = item.updatedAt instanceof Date ? item.updatedAt.toISOString() : item.updatedAt;
  const resultExpiresAt = item.resultExpiresAt instanceof Date ? item.resultExpiresAt.toISOString() : item.resultExpiresAt || null;
  return {
    jobId: item.jobId,
    seq: item.id,
    status: normalizeActivityStatus(item.status),
    source: normalizeActivitySource(item.source),
    channel: normalizePublicUpiExtractChannel(item.channel),
    extractMethod: normalizePublicUpiExtractMethod(item.extractMethod),
    publicUserTelegramId: item.publicUserTelegramId,
    publicUserTelegramName: item.publicUserTelegramName,
    accountEmail: item.accountEmail,
    accountPhone: item.accountPhone,
    subscriptionPlan: item.subscriptionPlan || null,
    subscriptionIsPlus: item.subscriptionIsPlus ?? null,
    subscriptionCheckedAt: item.subscriptionCheckedAt instanceof Date ? item.subscriptionCheckedAt.toISOString() : item.subscriptionCheckedAt || null,
    subscriptionCheckError: item.subscriptionCheckError || null,
    error: item.error,
    resultPaymentUrl: item.resultPaymentUrl,
    resultExpiresAt,
    createdAt,
    updatedAt,
  };
}

async function getPublicUpiExtractUserHistoryCounts(telegramUserId: string): Promise<PublicUpiExtractUserHistoryCounts> {
  const counts = emptyUserHistoryCounts();
  await ensureActivityAccountColumns();
  const safeTelegramUserId = telegramUserId.replace(/'/g, "''");
  const grouped = await prisma.$queryRawUnsafe<Array<{ status: string; count: number }>>(`
    SELECT "status", COUNT(*)::int AS "count"
    FROM "public_upi_extract_activities"
    WHERE "publicUserTelegramId" = '${safeTelegramUserId}'
      AND COALESCE("cancelled", FALSE) = FALSE
    GROUP BY "status"
  `);

  for (const group of grouped) {
    const status = normalizeActivityStatus(group.status);
    const count = Math.max(0, Number(group.count || 0));
    counts.all += count;
    if (status === "queued" || status === "running") counts.active += count;
    if (status === "completed") counts.completed += count;
    if (status === "failed") counts.failed += count;
  }

  const activeRows = await prisma.$queryRawUnsafe<Array<{ count: number }>>(`
    SELECT COUNT(*)::int AS "count"
    FROM "public_upi_extract_activities" a
    WHERE a."publicUserTelegramId" = '${safeTelegramUserId}'
      AND COALESCE(a."cancelled", FALSE) = FALSE
      AND (
        a."status" IN ('queued', 'running')
        OR EXISTS (
          SELECT 1
          FROM "orders" o
          WHERE o."id" = a."scanOrderId"
            AND o."source" = 'PUBLIC_SCAN'
            AND o."status" IN ('PENDING', 'ASSIGNED', 'CHECKING')
        )
      )
  `);
  counts.active = Math.max(0, Number(activeRows[0]?.count || counts.active));

  const memoryItems = shouldUseInMemoryRuntimeStateForReads()
    ? Array.from(store.activity.values())
      .filter((item) => item.publicUserTelegramId === telegramUserId)
      .filter((item) => !isMemoryActivityCancelled(item))
    : [];
  if (memoryItems.length > 0) {
    const safeJobIds = memoryItems
      .map((item) => item.jobId.replace(/'/g, "''"))
      .filter(Boolean);
    const persistedMemory = safeJobIds.length > 0
      ? await prisma.$queryRawUnsafe<Array<{ jobId: string; status: string }>>(`
        SELECT "jobId", "status"
        FROM "public_upi_extract_activities"
        WHERE "jobId" IN (${safeJobIds.map((jobId) => `'${jobId}'`).join(",")})
          AND COALESCE("cancelled", FALSE) = FALSE
      `)
      : [];
    const persistedByJobId = new Map(persistedMemory.map((item) => [item.jobId, normalizeActivityStatus(item.status)]));

    for (const item of memoryItems) {
      const nextStatus = normalizeActivityStatus(item.status);
      const previousStatus = persistedByJobId.get(item.jobId);
      if (previousStatus) {
        counts.all = Math.max(0, counts.all - 1);
        if (previousStatus === "queued" || previousStatus === "running") counts.active = Math.max(0, counts.active - 1);
        if (previousStatus === "completed") counts.completed = Math.max(0, counts.completed - 1);
        if (previousStatus === "failed") counts.failed = Math.max(0, counts.failed - 1);
      }
      counts.all += 1;
      if (nextStatus === "queued" || nextStatus === "running") counts.active += 1;
      if (nextStatus === "completed") counts.completed += 1;
      if (nextStatus === "failed") counts.failed += 1;
    }
  }

  return counts;
}

async function syncPublicUserOrderSubscriptionSnapshots(telegramUserId: string) {
  try {
    await ensureActivityAccountColumns();
    await prisma.$executeRaw`
      UPDATE "public_upi_extract_activities" a
      SET "subscriptionPlan" = COALESCE(o."subscriptionCheckLastPlan", a."subscriptionPlan"),
          "subscriptionIsPlus" = CASE
            WHEN o."subscriptionCheckStatus" = 'VERIFIED' THEN TRUE
            WHEN o."subscriptionCheckStatus" = 'FAILED' THEN FALSE
            ELSE a."subscriptionIsPlus"
          END,
          "subscriptionCheckedAt" = COALESCE(o."subscriptionCheckedAt", a."subscriptionCheckedAt"),
          "subscriptionCheckError" = CASE
            WHEN o."subscriptionCheckStatus" = 'VERIFIED' THEN NULL
            WHEN o."subscriptionCheckLastError" IS NOT NULL THEN o."subscriptionCheckLastError"
            ELSE a."subscriptionCheckError"
          END,
          "updatedAt" = GREATEST(a."updatedAt", COALESCE(o."subscriptionCheckedAt", a."updatedAt"))
      FROM "orders" o
      WHERE o."id" = a."scanOrderId"
        AND o."source" = 'PUBLIC_SCAN'
        AND o."publicUserTelegramId" = ${telegramUserId}
        AND a."publicUserTelegramId" = ${telegramUserId}
        AND o."subscriptionCheckStatus" IN ('VERIFIED', 'FAILED')
        AND (
          a."subscriptionPlan" IS DISTINCT FROM o."subscriptionCheckLastPlan"
          OR a."subscriptionIsPlus" IS DISTINCT FROM CASE
            WHEN o."subscriptionCheckStatus" = 'VERIFIED' THEN TRUE
            WHEN o."subscriptionCheckStatus" = 'FAILED' THEN FALSE
            ELSE a."subscriptionIsPlus"
          END
          OR a."subscriptionCheckedAt" IS DISTINCT FROM o."subscriptionCheckedAt"
          OR (
            o."subscriptionCheckStatus" = 'VERIFIED'
            AND a."subscriptionCheckError" IS NOT NULL
          )
          OR (
            o."subscriptionCheckStatus" = 'FAILED'
            AND o."subscriptionCheckLastError" IS NOT NULL
            AND a."subscriptionCheckError" IS DISTINCT FROM o."subscriptionCheckLastError"
          )
        )
    `;
  } catch (error) {
    console.warn("Failed to sync public user order subscription snapshots", {
      telegramUserId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function getPublicUpiExtractUserHistoryPage({
  telegramUserId,
  page = 1,
  pageSize = 10,
  status = "all",
}: {
  telegramUserId: string;
  page?: number;
  pageSize?: number;
  status?: string | null;
}): Promise<PublicUpiExtractUserHistoryPage> {
  const filter = normalizeUserHistoryFilter(status);
  const safePage = Math.max(1, Math.floor(Number(page) || 1));
  const safePageSize = Math.max(1, Math.min(100, Math.floor(Number(pageSize) || 10)));
  const statusFilter = userHistoryFilterStatuses(filter);
  await ensureActivityAccountColumns();
  await syncPublicUserOrderSubscriptionSnapshots(telegramUserId);

  const safeTelegramUserId = telegramUserId.replace(/'/g, "''");
  const whereSql = [
    `"publicUserTelegramId" = '${safeTelegramUserId}'`,
    `COALESCE("cancelled", FALSE) = FALSE`,
    ...(statusFilter ? [`"status" IN (${statusFilter.map((item) => `'${item}'`).join(",")})`] : []),
  ].join(" AND ");
  const [counts, rows] = await Promise.all([
    getPublicUpiExtractUserHistoryCounts(telegramUserId),
    getPersistedExtractJobRows(whereSql, safePageSize, `"id" DESC`, (safePage - 1) * safePageSize),
  ]);
  const total = counts[filter];
  const totalPages = Math.max(1, Math.ceil(total / safePageSize));
  const memoryByJobId = new Map(
    shouldUseInMemoryRuntimeStateForReads()
      ? Array.from(store.activity.values())
        .filter((item) => item.publicUserTelegramId === telegramUserId)
        .filter((item) => !isMemoryActivityCancelled(item))
        .map((item) => [item.jobId, item] as const)
      : []
  );
  const rowJobIds = new Set(rows.map((item) => item.jobId));
  const memoryOnly = safePage === 1
    ? Array.from(memoryByJobId.values())
      .filter((item) => !rowJobIds.has(item.jobId))
      .filter((item) => matchesUserHistoryFilter(normalizeActivityStatus(item.status), filter))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.jobId.localeCompare(a.jobId))
      .map(activityToUserHistoryItem)
    : [];
  const items = [
    ...memoryOnly,
    ...rows.map((item) => {
      const base = activityDbRowToUserHistoryItem(item);
      const memory = memoryByJobId.get(base.jobId);
      if (!memory) return base;
      const live = activityToUserHistoryItem(memory);
      return {
        ...base,
        status: live.status,
        source: live.source,
        channel: live.channel,
        publicUserTelegramId: live.publicUserTelegramId,
        publicUserTelegramName: live.publicUserTelegramName,
        accountEmail: live.accountEmail,
        accountPhone: live.accountPhone,
        subscriptionPlan: live.subscriptionPlan,
        subscriptionIsPlus: live.subscriptionIsPlus,
        subscriptionCheckedAt: live.subscriptionCheckedAt,
        subscriptionCheckError: live.subscriptionCheckError,
        error: live.error,
        resultPaymentUrl: live.resultPaymentUrl,
        resultExpiresAt: live.resultExpiresAt,
        updatedAt: live.updatedAt,
      };
    }).filter((item) => matchesUserHistoryFilter(item.status, filter)),
  ].slice(0, safePageSize);

  return {
    items,
    filter,
    counts,
    pagination: {
      page: Math.min(safePage, totalPages),
      pageSize: safePageSize,
      total,
      totalPages,
      hasPrev: safePage > 1,
      hasNext: safePage < totalPages,
      search: "",
    },
  };
}

export async function getPublicUpiExtractUserHistory(telegramUserId: string, take = 50) {
  const page = await getPublicUpiExtractUserHistoryPage({
    telegramUserId,
    page: 1,
    pageSize: take,
    status: "all",
  });

  return page.items;
}

export type AdminPublicUpiExtractJob = Omit<PublicUpiExtractJob, "result"> & {
  hasPayload: boolean;
  hasResult: boolean;
  canStart: boolean;
  canStop: boolean;
};

type AdminExtractionRuntimeSnapshot = {
  jobs: AdminPublicUpiExtractJob[];
  activeExtractionCountByChannel: ChannelMap<number>;
  queuedCountByChannel: ChannelMap<number>;
};

export async function getAdminPublicUpiExtractState() {
  cleanupMemory();
  await Promise.all(UPI_EXTRACT_CHANNELS.map((channel) => isPublicUpiExtractPaused(channel)));
  if (shouldRunExtractorInThisProcess()) {
    await markAbandonedPersistedActivity();
    await retryAutoPublishedScanOrdersReturnedBeforeAcceptance();
    processExtractionQueue();
  }
  const [items, counts, storageActiveCount] = await Promise.all([
    getActivityItems(),
    getActivityCounts(),
    getStorageActiveCount(),
  ]);
  const persistedRuntime = shouldUseInMemoryRuntimeStateForReads()
    ? null
    : await getAdminPersistedExtractionRuntimeSnapshot().catch((error) => {
      console.error("Failed to load admin public UPI extraction runtime snapshot from DB", error);
      return null;
    });
  const memoryJobs = Array.from(store.jobs.values())
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((job) => toAdminJob(job));
  const jobs = persistedRuntime?.jobs || memoryJobs;
  const activeExtractionCountByChannel = persistedRuntime?.activeExtractionCountByChannel || store.activeExtractionCountByChannel;
  const queuedCountByChannel = persistedRuntime?.queuedCountByChannel || {
    public: store.queuedJobIdsByChannel.public.length,
    premium: store.queuedJobIdsByChannel.premium.length,
  };

  return {
    paused: store.pausedByChannel.public,
    pausedByChannel: { ...store.pausedByChannel },
    maxConcurrent: getMaxConcurrentCached("public"),
    maxConcurrentByChannel: { ...store.maxConcurrentByChannel },
    activeExtractionCount: UPI_EXTRACT_CHANNELS.reduce((total, channel) => total + activeExtractionCountByChannel[channel], 0),
    activeExtractionCountByChannel: { ...activeExtractionCountByChannel },
    queuedCount: UPI_EXTRACT_CHANNELS.reduce((total, channel) => total + queuedCountByChannel[channel], 0),
    queuedCountByChannel: { ...queuedCountByChannel },
    liveJobCount: jobs.length,
    jobs,
    items,
    counts,
    storageActiveCount,
  };
}

export async function startPublicUpiExtractJob(jobId: string) {
  const job = store.jobs.get(jobId);
  const payload = store.payloads.get(jobId);
  if (!job) throw new Error("Extraction task not found or expired.");
  if (!payload) throw new Error("This task has no recoverable temporary data and cannot be restarted.");
  if (job.status === "completed") throw new Error("Completed tasks cannot be restarted.");
  if (job.status === "running") return toAdminJob(job);

  await clearPersistedPublicUpiExtractCancellation(jobId);
  store.manuallyStoppedJobIds.delete(jobId);
  removeQueuedJob(jobId);
  setJob({
    ...job,
    status: "queued",
    error: undefined,
    cancelled: false,
    progress: { stage: "queued", percent: 4, updatedAt: new Date().toISOString() },
  });
  startSpecificJob(jobId);
  return toAdminJob(store.jobs.get(jobId) || job);
}

export async function stopPublicUpiExtractJob(jobId: string) {
  const job = store.jobs.get(jobId);
  if (!job) throw new Error("Extraction task not found or expired.");
  if (job.status === "completed" || job.status === "failed") return toAdminJob(job);
  const channel = normalizePublicUpiExtractChannel(job.channel);

  removeQueuedJob(jobId);
  store.manuallyStoppedJobIds.add(jobId);
  store.activeRunIds.delete(jobId);
  setJob({
    ...job,
    status: "queued",
    error: undefined,
    progress: { stage: "queued", percent: 4, updatedAt: new Date().toISOString() },
  });
  if (shouldRunExtractorInThisProcess()) processExtractionQueue({ channel });
  return toAdminJob(store.jobs.get(jobId) || job);
}



export async function checkPublicUpiExtractJobSubscription(jobId: string, telegramUserId: string) {
  cleanupMemory();
  const job = await getPublicUpiExtractJob(jobId);
  if (!job) throw new Error("Extraction task not found or expired.");
  if (!job.publicUserTelegramId || job.publicUserTelegramId !== telegramUserId) {
    throw new Error("You can only check your own task.");
  }
  const credential = await getSubscriptionCheckCredential(job, telegramUserId);
  if (!credential) {
    if (job.status === "queued" || job.status === "running") {
      throw new Error("This task is still being processed. Subscription checking is available after extraction completes or after a scan order is created.");
    }
    const updated = {
      ...job,
      subscriptionCheckError: "This task no longer has saved session data for subscription checking.",
      subscriptionCheckedAt: new Date().toISOString(),
    } satisfies PublicUpiExtractJob;
    setJob(updated);
    return updated;
  }

  const lastCheckedAt = job.subscriptionCheckedAt ? new Date(job.subscriptionCheckedAt).getTime() : 0;
  if (Number.isFinite(lastCheckedAt) && Date.now() - lastCheckedAt < SUBSCRIPTION_CHECK_COOLDOWN_MS) {
    throw new Error("Please wait a few seconds before checking again.");
  }

  try {
    const result = await checkChatGptSubscription(credential);
    const updated = {
      ...job,
      subscriptionPlan: result.planType,
      subscriptionIsPlus: result.isPlus,
      subscriptionCheckedAt: result.checkedAt,
      subscriptionCheckError: null,
    } satisfies PublicUpiExtractJob;
    await updateSubscriptionCheckOrderSnapshot(updated, telegramUserId, {
      status: result.isPlus ? "VERIFIED" : "FAILED",
      plan: result.planType,
      error: result.isPlus ? null : "Plus subscription was not detected.",
    });
    setJob(updated);
    return updated;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error || "Subscription check failed");
    const updated = {
      ...job,
      subscriptionCheckedAt: new Date().toISOString(),
      subscriptionCheckError: errorMessage,
    } satisfies PublicUpiExtractJob;
    await updateSubscriptionCheckOrderSnapshot(updated, telegramUserId, {
      status: "FAILED",
      plan: job.subscriptionPlan || null,
      error: errorMessage,
    });
    setJob(updated);
    return updated;
  }
}

async function getPublicScanOrderIdForJob(job: Pick<PublicUpiExtractJob, "jobId" | "result">, telegramUserId: string) {
  const resultOrderId = job.result?.scanOrder?.id;
  if (resultOrderId) return resultOrderId;
  const rows = await prisma.$queryRaw<Array<{ scanOrderId: string | null }>>`
    SELECT a."scanOrderId"
    FROM "public_upi_extract_activities" a
    INNER JOIN "orders" o ON o."id" = a."scanOrderId"
    WHERE a."jobId" = ${job.jobId}
      AND a."publicUserTelegramId" = ${telegramUserId}
      AND o."source" = 'PUBLIC_SCAN'
      AND o."publicUserTelegramId" = ${telegramUserId}
    LIMIT 1
  `;
  return rows[0]?.scanOrderId || null;
}

async function getSubscriptionCheckCredential(job: PublicUpiExtractJob, telegramUserId: string) {
  const payload = store.payloads.get(job.jobId);
  if (payload?.credential) return payload.credential;

  const orderId = await getPublicScanOrderIdForJob(job, telegramUserId);
  if (!orderId) return null;

  const order = await prisma.order.findFirst({
    where: {
      id: orderId,
      source: "PUBLIC_SCAN",
      publicUserTelegramId: telegramUserId,
    },
    select: { sessionCredentialEncrypted: true },
  });
  if (!order?.sessionCredentialEncrypted) return null;

  try {
    return decryptSessionCredential(order.sessionCredentialEncrypted);
  } catch (error) {
    console.warn("Failed to decrypt saved session credential for subscription checking", {
      jobId: job.jobId,
      orderId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function updateSubscriptionCheckOrderSnapshot(job: PublicUpiExtractJob, telegramUserId: string, input: {
  status: "FAILED" | "VERIFIED";
  plan?: string | null;
  error?: string | null;
}) {
  const orderId = await getPublicScanOrderIdForJob(job, telegramUserId);
  if (!orderId) return;
  try {
    await prisma.order.updateMany({
      where: {
        id: orderId,
        source: "PUBLIC_SCAN",
        publicUserTelegramId: telegramUserId,
      },
      data: {
        subscriptionCheckStatus: input.status,
        subscriptionCheckLastPlan: input.plan || null,
        subscriptionCheckLastError: input.error || null,
        subscriptionCheckedAt: new Date(),
        subscriptionCheckAttemptCount: { increment: 1 },
      },
    });
  } catch (error) {
    console.warn("Failed to update public scan order subscription check snapshot", {
      jobId: job.jobId,
      orderId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function canCancelPublicUpiExtractJob(job: PublicUpiExtractJob) {
  if (job.cancelled) return false;
  const scanOrderStatus = job.result?.scanOrder?.status;
  if (scanOrderStatus === "COMPLETED") return false;
  if (job.status === "completed" && job.result?.scanOrder) {
    return Boolean(
      job.untilSuccess &&
      job.autoPublishScanOrder &&
      (scanOrderStatus === "FAILED" || scanOrderStatus === "EXPIRED")
    );
  }
  if (job.status === "queued" || job.status === "running") return true;
  if (job.status === "completed" || job.status === "failed") {
    return Boolean(job.untilSuccess && job.autoPublishScanOrder);
  }
  return false;
}

async function persistPublicUpiExtractCancellation(jobId: string, reason: string) {
  try {
    await ensureActivityAccountColumns();
    await prisma.$executeRaw`
      UPDATE "public_upi_extract_activities"
      SET "status" = 'failed',
          "error" = ${reason},
          "cancelled" = true,
          "credentialEncrypted" = NULL,
          "credentialHash" = NULL,
          "updatedAt" = NOW()
      WHERE "jobId" = ${jobId}
    `;
    rememberCancelledJob(jobId);
    return true;
  } catch (error) {
    console.error("Failed to persist public UPI extraction cancellation", error);
    return false;
  }
}

async function clearPersistedPublicUpiExtractCancellation(jobId: string) {
  try {
    await ensureActivityAccountColumns();
    await prisma.$executeRaw`
      UPDATE "public_upi_extract_activities"
      SET "cancelled" = false,
          "error" = NULL,
          "updatedAt" = NOW()
      WHERE "jobId" = ${jobId}
        AND "status" <> 'completed'
    `;
    forgetCancelledJob(jobId);
  } catch (error) {
    console.error("Failed to clear public UPI extraction cancellation", error);
  }
}

export async function cancelPublicUpiExtractJob(jobId: string, reason = "Extraction task cancelled by user") {
  const memoryJob = store.jobs.get(jobId) || null;
  const persistedJob = await getPersistedExtractJob(jobId);
  const job = shouldUseInMemoryRuntimeStateForReads()
    ? memoryJob || persistedJob
    : persistedJob || memoryJob;
  if (!job) {
    return null;
  }
  if (!canCancelPublicUpiExtractJob(job)) return job;
  const channel = normalizePublicUpiExtractChannel(job.channel);

  const persistedCancellation = await persistPublicUpiExtractCancellation(jobId, reason);
  if (!persistedCancellation) return null;
  await releaseAutoPublishScanOrderReservation(job, "Auto-publish extraction task cancelled; reserved scan order balance refunded.");

  if (!shouldUseInMemoryRuntimeStateForReads() && !memoryJob) {
    invalidateHeatmapOverviewCache(channel);
    return { ...job, status: "failed", error: reason, cancelled: true, updatedAt: new Date().toISOString() } satisfies PublicUpiExtractJob;
  }

  removeQueuedJob(jobId);
  store.manuallyStoppedJobIds.delete(jobId);
  store.activeRunIds.delete(jobId);
  store.payloads.delete(jobId);
  setJob({
    ...job,
    status: "failed",
    error: reason,
    cancelled: true,
    progress: {
      ...(job.progress || { stage: "queued", percent: 4 }),
      updatedAt: new Date().toISOString(),
    },
  });
  if (shouldRunExtractorInThisProcess()) processExtractionQueue({ channel });
  return store.jobs.get(jobId) || job;
}

export async function stopAllPublicUpiExtractJobs() {
  let changed = 0;
  for (const job of Array.from(store.jobs.values())) {
    if (job.status !== "queued" && job.status !== "running") continue;
    removeQueuedJob(job.jobId);
    store.manuallyStoppedJobIds.add(job.jobId);
    store.activeRunIds.delete(job.jobId);
    setJob({
      ...job,
      status: "queued",
      error: undefined,
      progress: { stage: "queued", percent: 4, updatedAt: new Date().toISOString() },
    });
    changed += 1;
  }

  try {
    const result = await prisma.publicUpiExtractActivity.updateMany({
      where: { status: { in: ["queued", "running"] } },
      data: { status: "queued" },
    });
    changed = Math.max(changed, result.count);
  } catch (error) {
    console.error("Failed to mark public UPI extraction jobs as queued", error);
  }

  return { changed };
}

export async function failAllPublicUpiExtractJobs(reason = "管理员已停止提取任务") {
  let changed = 0;
  for (const job of Array.from(store.jobs.values())) {
    if (job.status !== "queued" && job.status !== "running") continue;
    removeQueuedJob(job.jobId);
    store.manuallyStoppedJobIds.delete(job.jobId);
    store.activeRunIds.delete(job.jobId);
    store.payloads.delete(job.jobId);
    setJob({ ...job, status: "failed", error: reason });
    changed += 1;
  }

  try {
    const result = await prisma.publicUpiExtractActivity.updateMany({
      where: { status: { in: ["queued", "running"] } },
      data: { status: "failed" },
    });
    changed = Math.max(changed, result.count);
  } catch (error) {
    console.error("Failed to mark public UPI extraction jobs as failed", error);
  }

  return { changed };
}

function toAdminJob(job: PublicUpiExtractJob, options?: { hasPersistedPayload?: boolean }): AdminPublicUpiExtractJob {
  const hasRuntimePayload = store.payloads.has(job.jobId);
  const hasPayload = hasRuntimePayload || Boolean(options?.hasPersistedPayload);
  const canUseProcessLocalControls = shouldUseInMemoryRuntimeStateForReads() || hasRuntimePayload;
  const { result: _result, ...safeJob } = job;
  return {
    ...safeJob,
    hasPayload,
    hasResult: Boolean(_result),
    canStart: canUseProcessLocalControls && hasPayload && (job.status === "queued" || job.status === "failed"),
    canStop: canUseProcessLocalControls && (job.status === "queued" || job.status === "running"),
  };
}

async function getAdminPersistedExtractionRuntimeSnapshot(limit = 500): Promise<AdminExtractionRuntimeSnapshot> {
  await ensureActivityAccountColumns();
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const [rows, countRows] = await Promise.all([
    getPersistedExtractJobRows(`"status" IN ('queued', 'running')`, safeLimit),
    prisma.$queryRawUnsafe<Array<{ status: string | null; channel: string | null; count: number | bigint }>>(`
      SELECT
        "status",
        COALESCE("channel", 'public') AS "channel",
        COUNT(*)::int AS "count"
      FROM "public_upi_extract_activities"
      WHERE "status" IN ('queued', 'running')
      GROUP BY "status", COALESCE("channel", 'public')
    `),
  ]);

  const activeExtractionCountByChannel: ChannelMap<number> = { public: 0, premium: 0 };
  const queuedCountByChannel: ChannelMap<number> = { public: 0, premium: 0 };
  for (const row of countRows) {
    const channel = normalizePublicUpiExtractChannel(row.channel);
    const count = Number(row.count || 0);
    if (row.status === "running") activeExtractionCountByChannel[channel] += count;
    if (row.status === "queued") queuedCountByChannel[channel] += count;
  }

  const jobs = await Promise.all(rows.map(async (row) => {
    const job = await rowToPublicUpiExtractJob(row);
    return toAdminJob(job, { hasPersistedPayload: Boolean(row.credentialEncrypted) });
  }));

  jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return {
    jobs,
    activeExtractionCountByChannel,
    queuedCountByChannel,
  };
}

function getClientIdentity(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const realIp = request.headers.get("x-real-ip")?.trim();
  const cfIp = request.headers.get("cf-connecting-ip")?.trim();
  return forwarded || realIp || cfIp || "unknown";
}

function hashIdentity(identity: string) {
  return createHash("sha256").update(identity).digest("hex");
}

function cleanupMemory() {
  const now = Date.now();
  for (const [key, value] of store.rateLimitMemory.entries()) {
    if (now - value > RATE_LIMIT_MS * 10) store.rateLimitMemory.delete(key);
  }
  for (const [jobId, job] of store.jobs.entries()) {
    const isTerminal = job.status === "completed" || job.status === "failed";
    const isRecoverableActive = job.untilSuccess && (job.status === "queued" || job.status === "running");
    const referenceAt = isTerminal || isRecoverableActive ? job.updatedAt : job.createdAt;
    const ageMs = now - new Date(referenceAt).getTime();
    const ttlMs = isRecoverableActive
      ? Math.max(ACTIVE_JOB_TTL_MS, 24 * 60 * 60 * 1000)
      : isTerminal ? TERMINAL_JOB_TTL_MS : ACTIVE_JOB_TTL_MS;
    if (ageMs > ttlMs) {
      store.jobs.delete(jobId);
      store.payloads.delete(jobId);
      store.debugLogs.delete(jobId);
      store.activeRunIds.delete(jobId);
      store.manuallyStoppedJobIds.delete(jobId);
    }
  }
  for (const jobId of store.payloads.keys()) {
    if (!store.jobs.has(jobId)) store.payloads.delete(jobId);
  }
  for (const jobId of store.manuallyStoppedJobIds.keys()) {
    if (!store.jobs.has(jobId)) store.manuallyStoppedJobIds.delete(jobId);
  }
  for (const channel of UPI_EXTRACT_CHANNELS) {
    const queue = store.queuedJobIdsByChannel[channel];
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      if (!store.jobs.has(queue[index])) queue.splice(index, 1);
    }
  }
  cleanupGuardCreateTickets();
  while (store.activity.size > MAX_ACTIVITY_ITEMS) {
    const oldest = store.activity.keys().next().value as string | undefined;
    if (!oldest) break;
    store.activity.delete(oldest);
  }
}

function normalizeExpiresAt(expiresAt?: number) {
  const expiresMs = Number(expiresAt || 0) * 1000;
  if (Number.isFinite(expiresMs) && expiresMs > Date.now() + 15_000) {
    return new Date(expiresMs);
  }
  return new Date(Date.now() + FALLBACK_QR_TTL_MS);
}

function chatGptPaymentUrl(processorEntity: string, checkoutSessionId: string) {
  return `https://chatgpt.com/checkout/${encodeURIComponent(processorEntity)}/${encodeURIComponent(checkoutSessionId)}`;
}

function qrPngDataUrl(buffer: Buffer | Uint8Array) {
  return `data:image/png;base64,${Buffer.from(buffer).toString("base64")}`;
}

function setJob(job: PublicUpiExtractJob, options?: { omitActivity?: boolean }) {
  const updatedAt = new Date().toISOString();
  const channel = normalizePublicUpiExtractChannel(job.channel);
  const extractMethod = normalizePublicUpiExtractMethod(job.extractMethod);
  const nextJob = store.cancelledJobIds.has(job.jobId) && !job.cancelled
    ? {
      ...job,
      channel,
      extractMethod,
      status: "failed" as const,
      error: job.error || "Cancelled by user",
      cancelled: true,
      updatedAt,
    }
    : { ...job, channel, extractMethod, updatedAt };
  store.jobs.set(job.jobId, nextJob);
  if (nextJob.status === "completed" || nextJob.status === "failed") {
    store.manuallyStoppedJobIds.delete(job.jobId);
  }

  if (options?.omitActivity) {
    store.activityOmitJobIds.add(job.jobId);
    store.activity.delete(job.jobId);
    invalidateHeatmapOverviewCache(channel);
    void deletePersistedActivity(job.jobId);
    cleanupMemory();
    return;
  }

  store.activityOmitJobIds.delete(job.jobId);
  const existingActivity = store.activity.get(job.jobId);
  const nextActivity: PublicUpiExtractActivity = {
    jobId: job.jobId,
    seq: existingActivity?.seq ?? store.nextActivitySeq++,
    status: job.status === "completed" ? "completed" : job.status === "failed" ? "failed" : job.status === "queued" ? "queued" : "running",
    source: job.source,
    channel,
    extractMethod,
    publicUserTelegramId: job.publicUserTelegramId || null,
    publicUserTelegramName: job.publicUserTelegramName || null,
    accountEmail: job.accountEmail || job.result?.accountEmail || null,
    accountPhone: job.accountPhone || job.result?.accountPhone || null,
    subscriptionPlan: job.subscriptionPlan || null,
    subscriptionIsPlus: job.subscriptionIsPlus ?? null,
    subscriptionCheckedAt: job.subscriptionCheckedAt || null,
    subscriptionCheckError: job.subscriptionCheckError || null,
    error: job.error || null,
    resultPaymentUrl: job.result?.paymentUrl || null,
    resultExpiresAt: job.result?.expiresAt || null,
    resultQrImageUrl: job.result?.qrImageUrl || null,
    resultUpiUri: job.result?.upiUri || null,
    resultCheckoutSessionId: job.result?.checkoutSessionId || null,
    resultProcessorEntity: job.result?.processorEntity || null,
    resultChatGptPaymentUrl: job.result?.chatGptPaymentUrl || null,
    resultStripeInstructionsUrl: job.result?.stripeInstructionsUrl || null,
    resultCreatedAt: job.result?.createdAt || null,
    scanOrderId: job.result?.scanOrder?.id || null,
    scanOrderCreateToken: job.result?.scanOrderCreateToken || null,
    scanOrderCreateTokenExpiresAt: job.result?.expiresAt || null,
    scanOrderCreateTokenConsumedAt: null,
    createdAt: job.createdAt,
    updatedAt,
  };
  store.activity.set(job.jobId, nextActivity);
  if (!existingActivity || existingActivity.status !== nextActivity.status || existingActivity.channel !== nextActivity.channel || existingActivity.extractMethod !== nextActivity.extractMethod) {
    invalidateHeatmapOverviewCache(channel);
  } else {
    deleteLocalCachedJson(heatmapOverviewCacheKeys(channel));
  }
  void persistActivity(nextActivity, nextJob, store.payloads.get(job.jobId));
  cleanupMemory();
}

async function deletePersistedActivity(jobId: string) {
  for (const delayMs of [0, 250, 1000]) {
    if (delayMs > 0) await sleep(delayMs);
    try {
      await prisma.publicUpiExtractActivity.deleteMany({ where: { jobId } });
    } catch (error) {
      console.error("Failed to delete omitted public UPI extraction activity", error);
      return;
    }
  }
}

async function persistActivity(item: PublicUpiExtractActivity, job?: PublicUpiExtractJob | null, payload?: QueuedExtractionPayload | null) {
  if (store.activityOmitJobIds.has(item.jobId)) return;
  const isAutoPublishRetryRequeue = Boolean(
    item.status === "queued" &&
    job?.untilSuccess &&
    job.autoPublishScanOrder &&
    !job.cancelled &&
    !item.resultQrImageUrl &&
    !item.scanOrderId
  );
  const isAutoPublishScanOrderTerminalFailure = Boolean(
    item.status === "failed" &&
    job?.autoPublishScanOrder &&
    item.scanOrderId
  );
  const resultExpiresAt = item.resultExpiresAt ? new Date(item.resultExpiresAt) : null;
  const subscriptionCheckedAt = item.subscriptionCheckedAt ? new Date(item.subscriptionCheckedAt) : null;
  const progressUpdatedAt = job?.progress?.updatedAt ? new Date(job.progress.updatedAt) : null;
  const resultCreatedAt = item.resultCreatedAt ? new Date(item.resultCreatedAt) : null;
  const scanOrderCreateTokenExpiresAt = item.scanOrderCreateTokenExpiresAt ? new Date(item.scanOrderCreateTokenExpiresAt) : null;
  const scanOrderCreateTokenConsumedAt = item.scanOrderCreateTokenConsumedAt ? new Date(item.scanOrderCreateTokenConsumedAt) : null;
  const credential = payload?.credential || null;
  const shouldStoreCredential = Boolean(
    credential &&
    !job?.cancelled &&
    (item.status === "queued" || item.status === "running" || item.scanOrderCreateToken)
  );
  const credentialEncrypted = shouldStoreCredential && credential ? encryptSessionCredential(credential) : null;
  const credentialHash = shouldStoreCredential && credential ? hashSessionCredential(credential) : null;
  const customCheckoutProxyEncrypted = payload?.checkoutProxyUrl ? encryptSessionCredential(payload.checkoutProxyUrl) : null;
  const customProviderProxyEncrypted = payload?.providerProxyUrl ? encryptSessionCredential(payload.providerProxyUrl) : null;
  const approvalParallelism = normalizeApprovalParallelismInput(job?.approvalParallelism ?? payload?.approvalParallelism);
  try {
    await ensureActivityAccountColumns();
    await prisma.$executeRaw`
      INSERT INTO "public_upi_extract_activities" (
        "jobId",
        "status",
        "source",
        "channel",
        "extractMethod",
        "publicUserTelegramId",
        "publicUserTelegramName",
        "accountEmail",
        "accountPhone",
        "subscriptionPlan",
        "subscriptionIsPlus",
        "subscriptionCheckedAt",
        "subscriptionCheckError",
        "error",
        "resultPaymentUrl",
        "resultExpiresAt",
        "resultQrImageUrl",
        "resultUpiUri",
        "resultCheckoutSessionId",
        "resultProcessorEntity",
        "resultChatGptPaymentUrl",
        "resultStripeInstructionsUrl",
        "resultCreatedAt",
        "scanOrderId",
        "scanOrderCreateToken",
        "scanOrderCreateTokenExpiresAt",
        "scanOrderCreateTokenConsumedAt",
        "scanOrderFundsReserved",
        "scanOrderFundsReservedAmount",
        "scanOrderFundsReservedAt",
        "scanOrderFundsReleasedAt",
        "scanOrderFundsTransferredAt",
        "credentialEncrypted",
        "credentialHash",
        "customCheckoutProxyEncrypted",
        "customProviderProxyEncrypted",
        "issueGuardCreateToken",
        "guardId",
        "autoPublishScanOrder",
        "untilSuccess",
        "approvalParallelism",
        "cancelled",
        "retryCount",
        "progressStage",
        "progressPercent",
        "progressAttempt",
        "progressMaxAttempts",
        "progressUpdatedAt",
        "createdAt",
        "updatedAt"
      )
      VALUES (
        ${item.jobId},
        ${item.status},
        ${item.source},
        ${normalizePublicUpiExtractChannel(item.channel)},
        ${normalizePublicUpiExtractMethod(item.extractMethod)},
        ${item.publicUserTelegramId || null},
        ${item.publicUserTelegramName || null},
        ${item.accountEmail || null},
        ${item.accountPhone || null},
        ${item.subscriptionPlan || null},
        ${item.subscriptionIsPlus ?? null},
        ${subscriptionCheckedAt},
        ${item.subscriptionCheckError || null},
        ${item.error || null},
        ${item.resultPaymentUrl || null},
        ${resultExpiresAt},
        ${item.resultQrImageUrl || null},
        ${item.resultUpiUri || null},
        ${item.resultCheckoutSessionId || null},
        ${item.resultProcessorEntity || null},
        ${item.resultChatGptPaymentUrl || null},
        ${item.resultStripeInstructionsUrl || null},
        ${resultCreatedAt},
        ${item.scanOrderId || null},
        ${item.scanOrderCreateToken || null},
        ${scanOrderCreateTokenExpiresAt},
        ${scanOrderCreateTokenConsumedAt},
        ${job?.scanOrderFundsReserved ?? null},
        ${job?.scanOrderFundsReservedAmount ?? (job?.scanOrderFundsReserved ? PUBLIC_SCAN_ORDER_PRICE : null)},
        ${job?.scanOrderFundsReserved ? new Date(job.createdAt) : null},
        ${job?.scanOrderFundsReleasedAt ? new Date(job.scanOrderFundsReleasedAt) : null},
        ${job?.scanOrderFundsTransferredAt ? new Date(job.scanOrderFundsTransferredAt) : null},
        ${credentialEncrypted},
        ${credentialHash},
        ${customCheckoutProxyEncrypted},
        ${customProviderProxyEncrypted},
        ${Boolean(payload?.issueGuardCreateToken)},
        ${payload?.guardId || null},
        ${job?.autoPublishScanOrder ?? null},
        ${job?.untilSuccess ?? null},
        ${approvalParallelism},
        ${job?.cancelled ?? null},
        ${job?.retryCount ?? 0},
        ${job?.progress?.stage || null},
        ${job?.progress?.percent ?? null},
        ${job?.progress?.attempt ?? null},
        ${job?.progress?.maxAttempts ?? null},
        ${progressUpdatedAt},
        ${new Date(item.createdAt)},
        ${new Date(item.updatedAt)}
      )
      ON CONFLICT ("jobId") DO UPDATE SET
        "source" = CASE
          WHEN "public_upi_extract_activities"."source" = 'storage' OR EXCLUDED."source" = 'storage' THEN 'storage'
          ELSE 'direct'
        END,
        "channel" = COALESCE("public_upi_extract_activities"."channel", EXCLUDED."channel"),
        "extractMethod" = COALESCE(EXCLUDED."extractMethod", "public_upi_extract_activities"."extractMethod", 'upi'),
        "publicUserTelegramId" = COALESCE("public_upi_extract_activities"."publicUserTelegramId", EXCLUDED."publicUserTelegramId"),
        "publicUserTelegramName" = COALESCE("public_upi_extract_activities"."publicUserTelegramName", EXCLUDED."publicUserTelegramName"),
        "accountEmail" = COALESCE(EXCLUDED."accountEmail", "public_upi_extract_activities"."accountEmail"),
        "accountPhone" = COALESCE(EXCLUDED."accountPhone", "public_upi_extract_activities"."accountPhone"),
        "subscriptionPlan" = COALESCE(EXCLUDED."subscriptionPlan", "public_upi_extract_activities"."subscriptionPlan"),
        "subscriptionIsPlus" = COALESCE(EXCLUDED."subscriptionIsPlus", "public_upi_extract_activities"."subscriptionIsPlus"),
        "subscriptionCheckedAt" = COALESCE(EXCLUDED."subscriptionCheckedAt", "public_upi_extract_activities"."subscriptionCheckedAt"),
        "subscriptionCheckError" = COALESCE(EXCLUDED."subscriptionCheckError", "public_upi_extract_activities"."subscriptionCheckError"),
        "error" = CASE
          WHEN "public_upi_extract_activities"."cancelled" IS TRUE THEN "public_upi_extract_activities"."error"
          WHEN EXCLUDED."cancelled" IS TRUE THEN EXCLUDED."error"
          WHEN ${isAutoPublishRetryRequeue} THEN EXCLUDED."error"
          WHEN EXCLUDED."status" = 'completed' THEN NULL
          WHEN EXCLUDED."status" = 'failed' THEN EXCLUDED."error"
          WHEN EXCLUDED."status" = 'queued' THEN NULL
          ELSE "public_upi_extract_activities"."error"
        END,
        "resultPaymentUrl" = CASE WHEN ${isAutoPublishRetryRequeue} THEN NULL ELSE COALESCE(EXCLUDED."resultPaymentUrl", "public_upi_extract_activities"."resultPaymentUrl") END,
        "resultExpiresAt" = CASE WHEN ${isAutoPublishRetryRequeue} THEN NULL ELSE COALESCE(EXCLUDED."resultExpiresAt", "public_upi_extract_activities"."resultExpiresAt") END,
        "resultQrImageUrl" = CASE WHEN ${isAutoPublishRetryRequeue} THEN NULL ELSE COALESCE(EXCLUDED."resultQrImageUrl", "public_upi_extract_activities"."resultQrImageUrl") END,
        "resultUpiUri" = CASE WHEN ${isAutoPublishRetryRequeue} THEN NULL ELSE COALESCE(EXCLUDED."resultUpiUri", "public_upi_extract_activities"."resultUpiUri") END,
        "resultCheckoutSessionId" = CASE WHEN ${isAutoPublishRetryRequeue} THEN NULL ELSE COALESCE(EXCLUDED."resultCheckoutSessionId", "public_upi_extract_activities"."resultCheckoutSessionId") END,
        "resultProcessorEntity" = CASE WHEN ${isAutoPublishRetryRequeue} THEN NULL ELSE COALESCE(EXCLUDED."resultProcessorEntity", "public_upi_extract_activities"."resultProcessorEntity") END,
        "resultChatGptPaymentUrl" = CASE WHEN ${isAutoPublishRetryRequeue} THEN NULL ELSE COALESCE(EXCLUDED."resultChatGptPaymentUrl", "public_upi_extract_activities"."resultChatGptPaymentUrl") END,
        "resultStripeInstructionsUrl" = CASE WHEN ${isAutoPublishRetryRequeue} THEN NULL ELSE COALESCE(EXCLUDED."resultStripeInstructionsUrl", "public_upi_extract_activities"."resultStripeInstructionsUrl") END,
        "resultCreatedAt" = CASE WHEN ${isAutoPublishRetryRequeue} THEN NULL ELSE COALESCE(EXCLUDED."resultCreatedAt", "public_upi_extract_activities"."resultCreatedAt") END,
        "scanOrderId" = CASE WHEN ${isAutoPublishRetryRequeue} THEN NULL ELSE COALESCE(EXCLUDED."scanOrderId", "public_upi_extract_activities"."scanOrderId") END,
        "scanOrderCreateToken" = CASE WHEN ${isAutoPublishRetryRequeue} THEN NULL ELSE COALESCE(EXCLUDED."scanOrderCreateToken", "public_upi_extract_activities"."scanOrderCreateToken") END,
        "scanOrderCreateTokenExpiresAt" = CASE WHEN ${isAutoPublishRetryRequeue} THEN NULL ELSE COALESCE(EXCLUDED."scanOrderCreateTokenExpiresAt", "public_upi_extract_activities"."scanOrderCreateTokenExpiresAt") END,
        "scanOrderCreateTokenConsumedAt" = CASE WHEN ${isAutoPublishRetryRequeue} THEN NULL ELSE COALESCE(EXCLUDED."scanOrderCreateTokenConsumedAt", "public_upi_extract_activities"."scanOrderCreateTokenConsumedAt") END,
        "scanOrderFundsReserved" = CASE
          WHEN ${isAutoPublishRetryRequeue} THEN COALESCE("public_upi_extract_activities"."scanOrderFundsReserved", FALSE) OR COALESCE(EXCLUDED."scanOrderFundsReserved", FALSE)
          ELSE COALESCE("public_upi_extract_activities"."scanOrderFundsReserved", FALSE) OR COALESCE(EXCLUDED."scanOrderFundsReserved", FALSE)
        END,
        "scanOrderFundsReservedAmount" = CASE
          WHEN ${isAutoPublishRetryRequeue} THEN COALESCE(EXCLUDED."scanOrderFundsReservedAmount", "public_upi_extract_activities"."scanOrderFundsReservedAmount")
          ELSE COALESCE("public_upi_extract_activities"."scanOrderFundsReservedAmount", EXCLUDED."scanOrderFundsReservedAmount")
        END,
        "scanOrderFundsReservedAt" = CASE
          WHEN ${isAutoPublishRetryRequeue} THEN COALESCE(EXCLUDED."scanOrderFundsReservedAt", "public_upi_extract_activities"."scanOrderFundsReservedAt")
          ELSE COALESCE("public_upi_extract_activities"."scanOrderFundsReservedAt", EXCLUDED."scanOrderFundsReservedAt")
        END,
        "scanOrderFundsReleasedAt" = CASE
          WHEN ${isAutoPublishRetryRequeue} THEN EXCLUDED."scanOrderFundsReleasedAt"
          ELSE COALESCE("public_upi_extract_activities"."scanOrderFundsReleasedAt", EXCLUDED."scanOrderFundsReleasedAt")
        END,
        "scanOrderFundsTransferredAt" = CASE
          WHEN ${isAutoPublishRetryRequeue} THEN EXCLUDED."scanOrderFundsTransferredAt"
          ELSE COALESCE("public_upi_extract_activities"."scanOrderFundsTransferredAt", EXCLUDED."scanOrderFundsTransferredAt")
        END,
        "credentialEncrypted" = CASE
          WHEN "public_upi_extract_activities"."cancelled" IS TRUE THEN NULL
          WHEN EXCLUDED."cancelled" IS TRUE THEN NULL
          WHEN EXCLUDED."status" IN ('completed', 'failed') THEN EXCLUDED."credentialEncrypted"
          WHEN EXCLUDED."credentialEncrypted" IS NOT NULL THEN EXCLUDED."credentialEncrypted"
          ELSE "public_upi_extract_activities"."credentialEncrypted"
        END,
        "credentialHash" = CASE
          WHEN "public_upi_extract_activities"."cancelled" IS TRUE THEN NULL
          WHEN EXCLUDED."cancelled" IS TRUE THEN NULL
          WHEN EXCLUDED."status" IN ('completed', 'failed') THEN EXCLUDED."credentialHash"
          WHEN EXCLUDED."credentialHash" IS NOT NULL THEN EXCLUDED."credentialHash"
          ELSE "public_upi_extract_activities"."credentialHash"
        END,
        "customCheckoutProxyEncrypted" = CASE
          WHEN "public_upi_extract_activities"."cancelled" IS TRUE THEN NULL
          WHEN EXCLUDED."cancelled" IS TRUE THEN NULL
          WHEN EXCLUDED."status" IN ('completed', 'failed') THEN EXCLUDED."customCheckoutProxyEncrypted"
          WHEN EXCLUDED."customCheckoutProxyEncrypted" IS NOT NULL THEN EXCLUDED."customCheckoutProxyEncrypted"
          ELSE "public_upi_extract_activities"."customCheckoutProxyEncrypted"
        END,
        "customProviderProxyEncrypted" = CASE
          WHEN "public_upi_extract_activities"."cancelled" IS TRUE THEN NULL
          WHEN EXCLUDED."cancelled" IS TRUE THEN NULL
          WHEN EXCLUDED."status" IN ('completed', 'failed') THEN EXCLUDED."customProviderProxyEncrypted"
          WHEN EXCLUDED."customProviderProxyEncrypted" IS NOT NULL THEN EXCLUDED."customProviderProxyEncrypted"
          ELSE "public_upi_extract_activities"."customProviderProxyEncrypted"
        END,
        "issueGuardCreateToken" = COALESCE(EXCLUDED."issueGuardCreateToken", "public_upi_extract_activities"."issueGuardCreateToken"),
        "guardId" = COALESCE(EXCLUDED."guardId", "public_upi_extract_activities"."guardId"),
        "autoPublishScanOrder" = COALESCE("public_upi_extract_activities"."autoPublishScanOrder", FALSE) OR COALESCE(EXCLUDED."autoPublishScanOrder", FALSE),
        "untilSuccess" = COALESCE(EXCLUDED."untilSuccess", "public_upi_extract_activities"."untilSuccess"),
        "approvalParallelism" = COALESCE(EXCLUDED."approvalParallelism", "public_upi_extract_activities"."approvalParallelism", 1),
        "cancelled" = CASE
          WHEN "public_upi_extract_activities"."cancelled" IS TRUE
            AND EXCLUDED."cancelled" IS NOT TRUE
            THEN TRUE
          ELSE COALESCE(EXCLUDED."cancelled", "public_upi_extract_activities"."cancelled")
        END,
        "retryCount" = CASE
          WHEN "public_upi_extract_activities"."cancelled" IS TRUE THEN "public_upi_extract_activities"."retryCount"
          ELSE GREATEST(COALESCE("public_upi_extract_activities"."retryCount", 0), EXCLUDED."retryCount")
        END,
        "progressStage" = CASE
          WHEN "public_upi_extract_activities"."cancelled" IS TRUE THEN "public_upi_extract_activities"."progressStage"
          WHEN ${isAutoPublishScanOrderTerminalFailure} THEN EXCLUDED."progressStage"
          WHEN ${isAutoPublishRetryRequeue} THEN EXCLUDED."progressStage"
          WHEN "public_upi_extract_activities"."status" IN ('completed', 'failed')
            AND EXCLUDED."status" NOT IN ('completed', 'failed')
            THEN "public_upi_extract_activities"."progressStage"
          ELSE COALESCE(EXCLUDED."progressStage", "public_upi_extract_activities"."progressStage")
        END,
        "progressPercent" = CASE
          WHEN "public_upi_extract_activities"."cancelled" IS TRUE THEN "public_upi_extract_activities"."progressPercent"
          WHEN ${isAutoPublishScanOrderTerminalFailure} THEN EXCLUDED."progressPercent"
          WHEN ${isAutoPublishRetryRequeue} THEN EXCLUDED."progressPercent"
          WHEN "public_upi_extract_activities"."status" IN ('completed', 'failed')
            AND EXCLUDED."status" NOT IN ('completed', 'failed')
            THEN "public_upi_extract_activities"."progressPercent"
          ELSE COALESCE(EXCLUDED."progressPercent", "public_upi_extract_activities"."progressPercent")
        END,
        "progressAttempt" = CASE
          WHEN "public_upi_extract_activities"."cancelled" IS TRUE THEN "public_upi_extract_activities"."progressAttempt"
          WHEN ${isAutoPublishScanOrderTerminalFailure} THEN EXCLUDED."progressAttempt"
          WHEN ${isAutoPublishRetryRequeue} THEN EXCLUDED."progressAttempt"
          WHEN "public_upi_extract_activities"."status" IN ('completed', 'failed')
            AND EXCLUDED."status" NOT IN ('completed', 'failed')
            THEN "public_upi_extract_activities"."progressAttempt"
          ELSE COALESCE(EXCLUDED."progressAttempt", "public_upi_extract_activities"."progressAttempt")
        END,
        "progressMaxAttempts" = CASE
          WHEN "public_upi_extract_activities"."cancelled" IS TRUE THEN "public_upi_extract_activities"."progressMaxAttempts"
          WHEN ${isAutoPublishScanOrderTerminalFailure} THEN EXCLUDED."progressMaxAttempts"
          WHEN ${isAutoPublishRetryRequeue} THEN EXCLUDED."progressMaxAttempts"
          WHEN "public_upi_extract_activities"."status" IN ('completed', 'failed')
            AND EXCLUDED."status" NOT IN ('completed', 'failed')
            THEN "public_upi_extract_activities"."progressMaxAttempts"
          ELSE COALESCE(EXCLUDED."progressMaxAttempts", "public_upi_extract_activities"."progressMaxAttempts")
        END,
        "progressUpdatedAt" = CASE
          WHEN "public_upi_extract_activities"."cancelled" IS TRUE THEN "public_upi_extract_activities"."progressUpdatedAt"
          WHEN ${isAutoPublishScanOrderTerminalFailure} THEN EXCLUDED."progressUpdatedAt"
          WHEN ${isAutoPublishRetryRequeue} THEN EXCLUDED."progressUpdatedAt"
          WHEN "public_upi_extract_activities"."status" IN ('completed', 'failed')
            AND EXCLUDED."status" NOT IN ('completed', 'failed')
            THEN "public_upi_extract_activities"."progressUpdatedAt"
          ELSE COALESCE(EXCLUDED."progressUpdatedAt", "public_upi_extract_activities"."progressUpdatedAt")
        END,
        "status" = CASE
          WHEN "public_upi_extract_activities"."cancelled" IS TRUE THEN "public_upi_extract_activities"."status"
          WHEN EXCLUDED."cancelled" IS TRUE THEN EXCLUDED."status"
          WHEN ${isAutoPublishRetryRequeue} THEN 'queued'
          WHEN ${isAutoPublishScanOrderTerminalFailure} THEN 'failed'
          WHEN EXCLUDED."status" = 'completed' THEN 'completed'
          WHEN "public_upi_extract_activities"."status" = 'completed' THEN "public_upi_extract_activities"."status"
          WHEN EXCLUDED."status" = 'failed' THEN 'failed'
          WHEN "public_upi_extract_activities"."status" = 'failed' THEN "public_upi_extract_activities"."status"
          WHEN EXCLUDED."status" = 'queued' THEN 'queued'
          WHEN EXCLUDED."status" = 'running' AND "public_upi_extract_activities"."status" = 'queued' THEN 'running'
          ELSE "public_upi_extract_activities"."status"
        END,
        "updatedAt" = CASE
          WHEN "public_upi_extract_activities"."cancelled" IS TRUE THEN "public_upi_extract_activities"."updatedAt"
          WHEN ${isAutoPublishScanOrderTerminalFailure} THEN GREATEST("public_upi_extract_activities"."updatedAt", EXCLUDED."updatedAt")
          WHEN "public_upi_extract_activities"."status" IN ('completed', 'failed')
            AND EXCLUDED."status" NOT IN ('completed', 'queued')
            THEN "public_upi_extract_activities"."updatedAt"
          ELSE GREATEST("public_upi_extract_activities"."updatedAt", EXCLUDED."updatedAt")
        END
    `;
    if (store.activityOmitJobIds.has(item.jobId)) {
      await prisma.publicUpiExtractActivity.deleteMany({ where: { jobId: item.jobId } });
    }
  } catch (error) {
    console.error("Failed to persist public UPI extraction activity", error);
  }
}

type PersistedExtractJobRow = {
  id: number;
  jobId: string;
  status: string;
  source: string | null;
  channel: string | null;
  extractMethod: string | null;
  publicUserTelegramId: string | null;
  publicUserTelegramName: string | null;
  accountEmail: string | null;
  accountPhone: string | null;
  subscriptionPlan: string | null;
  subscriptionIsPlus: boolean | null;
  subscriptionCheckedAt: Date | string | null;
  subscriptionCheckError: string | null;
  error: string | null;
  resultPaymentUrl: string | null;
  resultExpiresAt: Date | string | null;
  resultQrImageUrl: string | null;
  resultUpiUri: string | null;
  resultCheckoutSessionId: string | null;
  resultProcessorEntity: string | null;
  resultChatGptPaymentUrl: string | null;
  resultStripeInstructionsUrl: string | null;
  resultCreatedAt: Date | string | null;
  scanOrderId: string | null;
  scanOrderCreateToken: string | null;
  scanOrderCreateTokenExpiresAt: Date | string | null;
  scanOrderCreateTokenConsumedAt: Date | string | null;
  scanOrderFundsReserved: boolean | null;
  scanOrderFundsReservedAmount: number | string | null;
  scanOrderFundsReleasedAt: Date | string | null;
  scanOrderFundsTransferredAt: Date | string | null;
  credentialEncrypted: string | null;
  credentialHash: string | null;
  customCheckoutProxyEncrypted: string | null;
  customProviderProxyEncrypted: string | null;
  issueGuardCreateToken: boolean | null;
  guardId: string | null;
  autoPublishScanOrder: boolean | null;
  untilSuccess: boolean | null;
  approvalParallelism: number | null;
  cancelled: boolean | null;
  retryCount: number | null;
  progressStage: string | null;
  progressPercent: number | null;
  progressAttempt: number | null;
  progressMaxAttempts: number | null;
  progressUpdatedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

function toIsoString(value: Date | string | null | undefined) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

async function hydratePersistedScanOrder(scanOrderId?: string | null) {
  if (!scanOrderId) return null;
  try {
    const order = await prisma.order.findUnique({
      where: { id: scanOrderId },
      include: orderInclude,
    });
    return order ? serializeWorkerOrder(order as OrderWithRelations) : null;
  } catch (error) {
    console.warn("Failed to hydrate persisted scan order for extraction job", {
      scanOrderId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function rowToPublicUpiExtractJob(row: PersistedExtractJobRow): Promise<PublicUpiExtractJob> {
  const createdAt = toIsoString(row.createdAt) || new Date().toISOString();
  const updatedAt = toIsoString(row.updatedAt) || createdAt;
  const extractMethod = normalizePublicUpiExtractMethod(row.extractMethod);
  const resultExpiresAt = toIsoString(row.resultExpiresAt);
  const resultCreatedAt = toIsoString(row.resultCreatedAt) || updatedAt;
  const scanOrder = await hydratePersistedScanOrder(row.scanOrderId);
  const canUseScanOrderToken = Boolean(
    row.scanOrderCreateToken &&
    !row.scanOrderCreateTokenConsumedAt &&
    resultExpiresAt &&
    new Date(resultExpiresAt).getTime() > Date.now()
  );
  const result = row.resultQrImageUrl && row.resultCheckoutSessionId && row.resultProcessorEntity && row.resultPaymentUrl && resultExpiresAt && (extractMethod === "ideal" || row.resultUpiUri)
    ? {
      qrImageUrl: row.resultQrImageUrl,
      ...(row.resultUpiUri ? { upiUri: row.resultUpiUri } : {}),
      checkoutSessionId: row.resultCheckoutSessionId,
      processorEntity: row.resultProcessorEntity,
      paymentUrl: row.resultPaymentUrl,
      extractMethod,
      chatGptPaymentUrl: row.resultChatGptPaymentUrl || undefined,
      stripeInstructionsUrl: row.resultStripeInstructionsUrl || undefined,
      expiresAt: resultExpiresAt,
      createdAt: resultCreatedAt,
      accountEmail: row.accountEmail || null,
      accountPhone: row.accountPhone || null,
      scanOrderCreateToken: canUseScanOrderToken ? row.scanOrderCreateToken || undefined : undefined,
      scanOrder: scanOrder || undefined,
    } satisfies PublicUpiExtractResult
    : undefined;

  return {
    jobId: row.jobId,
    status: normalizeActivityStatus(row.status),
    source: normalizeActivitySource(row.source),
    channel: normalizePublicUpiExtractChannel(row.channel),
    extractMethod,
    publicUserTelegramId: row.publicUserTelegramId || null,
    publicUserTelegramName: row.publicUserTelegramName || null,
    accountEmail: row.accountEmail || null,
    accountPhone: row.accountPhone || null,
    subscriptionPlan: row.subscriptionPlan || null,
    subscriptionIsPlus: row.subscriptionIsPlus ?? null,
    subscriptionCheckedAt: toIsoString(row.subscriptionCheckedAt),
    subscriptionCheckError: row.subscriptionCheckError || null,
    progress: row.progressStage
      ? {
        stage: row.progressStage as UpiExtractionProgress["stage"],
        percent: typeof row.progressPercent === "number" ? row.progressPercent : 4,
        attempt: row.progressAttempt ?? undefined,
        maxAttempts: row.progressMaxAttempts ?? undefined,
        updatedAt: toIsoString(row.progressUpdatedAt) || updatedAt,
      }
      : undefined,
    result,
    error: row.error || undefined,
    untilSuccess: Boolean(row.untilSuccess),
    approvalParallelism: normalizeApprovalParallelismInput(row.approvalParallelism),
    autoPublishScanOrder: Boolean(row.autoPublishScanOrder),
    retryCount: row.retryCount ?? 0,
    cancelled: Boolean(row.cancelled),
    scanOrderFundsReserved: Boolean(row.scanOrderFundsReserved),
    scanOrderFundsReservedAmount: row.scanOrderFundsReservedAmount === null ? null : Number(row.scanOrderFundsReservedAmount),
    scanOrderFundsReleasedAt: toIsoString(row.scanOrderFundsReleasedAt),
    scanOrderFundsTransferredAt: toIsoString(row.scanOrderFundsTransferredAt),
    createdAt,
    updatedAt,
  };
}

async function getConfiguredProxyCounts(): Promise<ChannelMap<number>> {
  return getCachedJson(
    proxyCountCacheKey(),
    PROXY_COUNT_CACHE_TTL_MS,
    async () => {
      const [publicProxyCount, premiumProxyCount] = await Promise.all([
        getConfiguredUpstreamProxies("public").then((items) => items.length).catch(() => 0),
        getConfiguredUpstreamProxies("premium").then((items) => items.length).catch(() => 0),
      ]);
      return {
        public: publicProxyCount,
        premium: premiumProxyCount,
      };
    },
    { localTtlMs: 2_000 }
  );
}

async function getPersistedExtractJobRows(whereSql: string, limit = 50, orderSql = `"createdAt" ASC, "id" ASC`, offset = 0) {
  await ensureActivityAccountColumns();
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const safeOffset = Math.max(0, Math.floor(offset));
  return prisma.$queryRawUnsafe<PersistedExtractJobRow[]>(`
    SELECT
      "id",
      "jobId",
      "status",
      "source",
      "channel",
      "extractMethod",
      "publicUserTelegramId",
      "publicUserTelegramName",
      "accountEmail",
      "accountPhone",
      "subscriptionPlan",
      "subscriptionIsPlus",
      "subscriptionCheckedAt",
      "subscriptionCheckError",
      "error",
      "resultPaymentUrl",
      "resultExpiresAt",
      "resultQrImageUrl",
      "resultUpiUri",
      "resultCheckoutSessionId",
      "resultProcessorEntity",
      "resultChatGptPaymentUrl",
      "resultStripeInstructionsUrl",
      "resultCreatedAt",
      "scanOrderId",
      "scanOrderCreateToken",
      "scanOrderCreateTokenExpiresAt",
      "scanOrderCreateTokenConsumedAt",
      "scanOrderFundsReserved",
      "scanOrderFundsReservedAmount",
      "scanOrderFundsReleasedAt",
      "scanOrderFundsTransferredAt",
      "credentialEncrypted",
      "credentialHash",
      "customCheckoutProxyEncrypted",
      "customProviderProxyEncrypted",
      "issueGuardCreateToken",
      "guardId",
      "autoPublishScanOrder",
      "untilSuccess",
      "approvalParallelism",
      "cancelled",
      "retryCount",
      "progressStage",
      "progressPercent",
      "progressAttempt",
      "progressMaxAttempts",
      "progressUpdatedAt",
      "createdAt",
      "updatedAt"
    FROM "public_upi_extract_activities"
    WHERE ${whereSql}
    ORDER BY ${orderSql}
    LIMIT ${safeLimit}
    OFFSET ${safeOffset}
  `);
}

async function getPersistedExtractJob(jobId: string) {
  const safeJobId = jobId.replace(/'/g, "''");
  const rows = await getPersistedExtractJobRows(`"jobId" = '${safeJobId}'`, 1);
  if (!rows[0]) return null;
  return rowToPublicUpiExtractJob(rows[0]);
}

async function getPersistedAutoPublishRetryCandidateRows(limit = 30) {
  await ensureActivityAccountColumns();
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const jobRows = await prisma.$queryRawUnsafe<Array<{ jobId: string }>>(`
    SELECT a."jobId"
    FROM "public_upi_extract_activities" a
    INNER JOIN "orders" o ON o."id" = a."scanOrderId"
    WHERE a."status" IN ('completed', 'failed')
      AND COALESCE(a."untilSuccess", FALSE) = TRUE
      AND COALESCE(a."autoPublishScanOrder", FALSE) = TRUE
      AND COALESCE(a."cancelled", FALSE) = FALSE
      AND o."source" = 'PUBLIC_SCAN'
      AND o."status" IN ('FAILED', 'EXPIRED')
    ORDER BY a."createdAt" ASC, a."id" ASC
    LIMIT ${safeLimit}
  `);
  const jobIds = Array.from(new Set(jobRows.map((row) => row.jobId).filter(Boolean)));
  if (jobIds.length === 0) return [];
  return getPersistedExtractJobRows(
    `"jobId" IN (${jobIds.map((jobId) => `'${jobId.replace(/'/g, "''")}'`).join(",")})`,
    jobIds.length
  );
}

async function getActivityItems(channel?: PublicUpiExtractChannel) {
  const normalizedChannel = channel ? normalizePublicUpiExtractChannel(channel) : null;
  try {
    await ensureActivityAccountColumns();
    const persisted = await prisma.publicUpiExtractActivity.findMany({
      where: normalizedChannel ? { channel: normalizedChannel } : undefined,
      select: {
        id: true,
        jobId: true,
        status: true,
        source: true,
        channel: true,
        extractMethod: true,
        publicUserTelegramId: true,
        publicUserTelegramName: true,
        accountEmail: true,
        accountPhone: true,
        subscriptionPlan: true,
        subscriptionIsPlus: true,
        subscriptionCheckedAt: true,
        subscriptionCheckError: true,
        error: true,
        resultPaymentUrl: true,
        resultExpiresAt: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { id: "desc" },
      take: MAX_ACTIVITY_ITEMS,
    });
    const persistedItems: PublicUpiExtractActivity[] = persisted.reverse().map((item) => ({
      jobId: item.jobId,
      seq: item.id,
      status: normalizeActivityStatus(item.status),
      source: normalizeActivitySource(item.source),
      channel: normalizePublicUpiExtractChannel(item.channel),
      extractMethod: normalizePublicUpiExtractMethod(item.extractMethod),
      publicUserTelegramId: item.publicUserTelegramId,
      publicUserTelegramName: item.publicUserTelegramName,
      accountEmail: item.accountEmail,
      accountPhone: item.accountPhone,
      subscriptionPlan: item.subscriptionPlan || null,
      subscriptionIsPlus: item.subscriptionIsPlus ?? null,
      subscriptionCheckedAt: item.subscriptionCheckedAt?.toISOString() || null,
      subscriptionCheckError: item.subscriptionCheckError || null,
      error: item.error,
      resultPaymentUrl: item.resultPaymentUrl,
      resultExpiresAt: item.resultExpiresAt?.toISOString() || null,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    }));

    const merged = new Map<string, PublicUpiExtractActivity>();
    for (const item of persistedItems) merged.set(item.jobId, item);

    // In production the web/API process is intentionally separated from the
    // extractor worker. Its in-memory activity store is not authoritative and
    // can contain stale pre-restart state, so public/admin read APIs should only
    // merge memory activity when this process is actually allowed to run the
    // extractor (local inline mode or the worker process itself).
    if (shouldRunExtractorInThisProcess()) {
      const maxPersistedSeq = persistedItems.reduce((max, item) => Math.max(max, item.seq), -1);
      let memoryOnlyIndex = 0;
      for (const item of store.activity.values()) {
        if (normalizedChannel && normalizePublicUpiExtractChannel(item.channel) !== normalizedChannel) continue;
        const existing = merged.get(item.jobId);
        const safeItem = omitPrivateActivityFields(item);
        merged.set(item.jobId, existing ? { ...safeItem, seq: existing.seq } : { ...safeItem, seq: maxPersistedSeq + 1 + memoryOnlyIndex++ });
      }
    }

    return Array.from(merged.values())
      .sort((a, b) => a.seq - b.seq || a.createdAt.localeCompare(b.createdAt))
      .slice(-MAX_ACTIVITY_ITEMS);
  } catch (error) {
    console.error("Failed to load public UPI extraction activity", error);
    return Array.from(store.activity.values())
      .filter((item) => !normalizedChannel || normalizePublicUpiExtractChannel(item.channel) === normalizedChannel)
      .map(omitPrivateActivityFields)
      .sort((a, b) => a.seq - b.seq || a.createdAt.localeCompare(b.createdAt));
  }
}

type HeatmapMergeItem = {
  jobId: string;
  seq: number;
  status: PublicUpiExtractStatus;
  source: PublicUpiExtractSource;
  channel: PublicUpiExtractChannel;
  extractMethod?: PublicUpiExtractMethod;
  error?: string | null;
  updatedAt: string;
};

async function getActivityHeatmapItems(channel?: PublicUpiExtractChannel): Promise<PublicUpiExtractHeatmapItem[]> {
  const normalizedChannel = channel ? normalizePublicUpiExtractChannel(channel) : null;
  try {
    await ensureActivityAccountColumns();
    const heatmapSelect = {
        id: true,
        jobId: true,
        status: true,
        source: true,
        channel: true,
        extractMethod: true,
        error: true,
        updatedAt: true,
    } as const;
    const [recentPersisted, activePersisted] = await Promise.all([
      prisma.publicUpiExtractActivity.findMany({
        where: normalizedChannel ? { channel: normalizedChannel } : undefined,
        select: heatmapSelect,
        orderBy: { id: "desc" },
        take: MAX_ACTIVITY_ITEMS,
      }),
      prisma.publicUpiExtractActivity.findMany({
        where: {
          status: { in: ["queued", "running"] },
          ...(normalizedChannel ? { channel: normalizedChannel } : {}),
        },
        select: heatmapSelect,
        orderBy: { id: "asc" },
        take: MAX_ACTIVITY_ITEMS,
      }),
    ]);
    const persisted = Array.from(new Map(
      [...recentPersisted, ...activePersisted].map((item) => [item.jobId, item])
    ).values()).sort((a, b) => a.id - b.id);
    const persistedItems: HeatmapMergeItem[] = persisted.map((item) => ({
      jobId: item.jobId,
      seq: item.id,
      status: normalizeActivityStatus(item.status),
      source: normalizeActivitySource(item.source),
      channel: normalizePublicUpiExtractChannel(item.channel),
      extractMethod: normalizePublicUpiExtractMethod(item.extractMethod),
      error: item.error || null,
      updatedAt: item.updatedAt.toISOString(),
    }));

    const merged = new Map<string, HeatmapMergeItem>();
    for (const item of persistedItems) merged.set(item.jobId, item);

    if (shouldRunExtractorInThisProcess()) {
      const maxPersistedSeq = persistedItems.reduce((max, item) => Math.max(max, item.seq), -1);
      let memoryOnlyIndex = 0;
      for (const item of store.activity.values()) {
        if (normalizedChannel && normalizePublicUpiExtractChannel(item.channel) !== normalizedChannel) continue;
        const existing = merged.get(item.jobId);
        merged.set(item.jobId, {
          jobId: item.jobId,
          seq: existing?.seq ?? maxPersistedSeq + 1 + memoryOnlyIndex++,
          status: normalizeActivityStatus(item.status),
          source: normalizeActivitySource(item.source),
          channel: normalizePublicUpiExtractChannel(item.channel),
          extractMethod: normalizePublicUpiExtractMethod(item.extractMethod),
          error: item.error || null,
          updatedAt: item.updatedAt,
        });
      }
    }

    return selectVisibleHeatmapItems(Array.from(merged.values()).filter((item) => !isNoFreeTrialHeatmapExcluded(item)), MAX_ACTIVITY_ITEMS)
      .map(activityToHeatmapItem);
  } catch (error) {
    console.error("Failed to load public UPI extraction heatmap activity", error);
    return selectVisibleHeatmapItems(
      Array.from(store.activity.values())
        .filter((item) => !normalizedChannel || normalizePublicUpiExtractChannel(item.channel) === normalizedChannel)
        .map((item) => ({
          jobId: item.jobId,
          seq: item.seq,
          status: normalizeActivityStatus(item.status),
          source: normalizeActivitySource(item.source),
          channel: normalizePublicUpiExtractChannel(item.channel),
          extractMethod: normalizePublicUpiExtractMethod(item.extractMethod),
          error: item.error || null,
          updatedAt: item.updatedAt,
        }))
        .filter((item) => !isNoFreeTrialHeatmapExcluded(item)),
      MAX_ACTIVITY_ITEMS
    ).map(activityToHeatmapItem);
  }
}

function isNoFreeTrialHeatmapExcluded(item: { status: PublicUpiExtractStatus; error?: string | null }) {
  return item.status === "failed" && isNoFreeTrialError(null, item.error || "");
}

function selectVisibleHeatmapItems(items: HeatmapMergeItem[], limit: number) {
  const safeLimit = Math.max(1, Math.floor(limit));
  const sorted = items.sort((a, b) => a.seq - b.seq);
  if (sorted.length <= safeLimit) return sorted;

  const activeItems = sorted.filter((item) => item.status === "queued" || item.status === "running");
  if (activeItems.length >= safeLimit) return activeItems.slice(-safeLimit);

  const activeJobIds = new Set(activeItems.map((item) => item.jobId));
  const terminalItems = sorted.filter((item) => !activeJobIds.has(item.jobId));
  return [...terminalItems.slice(-(safeLimit - activeItems.length)), ...activeItems]
    .sort((a, b) => a.seq - b.seq);
}

function activityToHeatmapItem(item: HeatmapMergeItem): PublicUpiExtractHeatmapItem {
  const updatedAtMs = new Date(item.updatedAt).getTime();
  const updatedAtSec = Number.isFinite(updatedAtMs) ? Math.floor(updatedAtMs / 1000) : undefined;
  const tuple: PublicUpiExtractHeatmapItem = [
    item.seq,
    heatmapStatusCode(item.status),
    item.channel === "premium" ? "m" : "p",
    item.source === "storage" ? "s" : "d",
  ];
  if (updatedAtSec) tuple.push(updatedAtSec);
  return tuple;
}

function heatmapStatusCode(status: PublicUpiExtractStatus): PublicUpiExtractHeatmapStatusCode {
  if (status === "queued") return "q";
  if (status === "running") return "r";
  if (status === "completed") return "c";
  return "f";
}

function isPendingAutoReturnedScanOrder(order: OrderWithRelations) {
  return (
    order.source === "PUBLIC_SCAN" &&
    order.status === "EXPIRED" &&
    !order.assignedWorkerId &&
    order.problemReason === PUBLIC_SCAN_PENDING_AUTO_RETURN_REASON
  );
}

function isNonRetryableAutoPublishedScanFailureReason(reason?: string | null) {
  const text = String(reason || "").trim().toLowerCase();
  if (!text) return false;
  return [
    "invalid session",
    "session token is invalid",
    "session token has expired",
    "session token expired",
    "token invalid",
    "token_invalidated",
    "token invalidated",
    "token_expired",
    "token expired",
    "token_revoked",
    "unauthorized",
    "no free trial",
    "free trial is unavailable",
    "account does not have free trial",
    "already paid",
    "already subscribed",
    "billing country",
    "region is locked",
    "cannot create a upi payment",
    "cannot create an upi payment",
    "payment method is not available",
    "this account cannot create a upi payment",
    "this account cannot create an upi payment",
    "\u5730\u533a\u5df2\u88ab openai \u9501\u5b9a",
    "\u65e0\u6cd5\u66f4\u6539\u8d26\u5355\u5730\u5740",
    "\u6ca1\u6709\u514d\u8d39\u8bd5\u7528",
    "\u65e0\u514d\u8d39\u8bd5\u7528",
    "\u6ca1\u6709\u514d\u8d39\u4f7f\u7528",
    "\u9700\u8981\u66f4\u6362\u8d26\u53f7",
    "\u66f4\u6362\u8d26\u53f7",
    "\u66f4\u6362 token",
  ].some((item) => text.includes(item));
}

function isRetryableAutoPublishedScanOrder(order: OrderWithRelations) {
  if (order.source !== "PUBLIC_SCAN") return false;
  if (order.status === "EXPIRED") return true;
  if (order.status !== "FAILED") return false;
  return !isNonRetryableAutoPublishedScanFailureReason(order.problemReason);
}

function shouldRetryAutoPublishedScanOrder(job: PublicUpiExtractJob, order: OrderWithRelations) {
  if (job.cancelled) return false;
  if (!job.untilSuccess) return false;
  if (!isRetryableAutoPublishedScanOrder(order)) return false;
  const payload = store.payloads.get(job.jobId);
  return Boolean(job.autoPublishScanOrder || payload?.autoPublishScanOrder);
}

function autoPublishRetryReason(order: OrderWithRelations) {
  if (isPendingAutoReturnedScanOrder(order)) {
    return "The scan order was not accepted before the QR was close to expiry, so it was refunded and queued for a fresh QR.";
  }
  if (order.status === "EXPIRED") {
    return "The scan order QR expired, so it was refunded and queued for a fresh QR.";
  }
  return "The scan order failed or was returned by the scanner, so it was refunded and queued for a fresh QR.";
}

async function getAutoPublishRetryPayload(job: PublicUpiExtractJob, order: OrderWithRelations) {
  const existing = store.payloads.get(job.jobId);
  if (existing?.autoPublishScanOrder) return existing;
  if (!job.autoPublishScanOrder || !job.publicUserTelegramId || !order.sessionCredentialEncrypted) return null;

  try {
    const credential = decryptSessionCredential(order.sessionCredentialEncrypted);
    return {
      credential,
      issueGuardCreateToken: false,
      source: job.source,
      channel: normalizePublicUpiExtractChannel(job.channel),
      extractMethod: "upi",
      publicUserTelegramId: job.publicUserTelegramId,
      publicUserTelegramName: job.publicUserTelegramName || null,
      accountEmail: job.accountEmail || job.result?.accountEmail || null,
      accountPhone: job.accountPhone || job.result?.accountPhone || null,
      autoPublishScanOrder: true,
      untilSuccess: true,
    } satisfies QueuedExtractionPayload;
  } catch (error) {
    console.warn("Failed to restore auto-publish retry payload from scan order", {
      jobId: job.jobId,
      orderId: order.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function persistCurrentJobActivity(jobId: string) {
  const activity = store.activity.get(jobId);
  const current = store.jobs.get(jobId);
  if (!activity || !current) return;
  await persistActivity(activity, current, store.payloads.get(jobId));
}

async function requeueAutoPublishJob(job: PublicUpiExtractJob, payload: QueuedExtractionPayload, reason: string) {
  if (job.cancelled) return job;
  const channel = normalizePublicUpiExtractChannel(job.channel || payload.channel);
  const extractMethod = "upi" satisfies PublicUpiExtractMethod;
  let reservedJob: PublicUpiExtractJob;
  try {
    reservedJob = await reserveAutoPublishScanOrderFundsForRetry(job, { ...payload, channel, extractMethod }, reason);
  } catch (error) {
    const errorMessage = compactError(error);
    store.payloads.delete(job.jobId);
    setJob({
      ...job,
      status: "failed",
      error: `Auto-publish retry could not reserve scan order balance: ${errorMessage}`,
      cancelled: false,
      progress: {
        ...(job.progress || { stage: "completed", percent: 100 }),
        updatedAt: new Date().toISOString(),
      },
    });
    await persistCurrentJobActivity(job.jobId);
    return store.jobs.get(job.jobId) || job;
  }
  removeQueuedJob(job.jobId);
  store.manuallyStoppedJobIds.delete(job.jobId);
  store.activeRunIds.delete(job.jobId);
  store.payloads.set(job.jobId, { ...payload, channel, extractMethod, autoPublishScanOrder: true, untilSuccess: true });
  setJob({
    ...reservedJob,
    channel,
    extractMethod,
    status: "queued",
    result: undefined,
    error: reason,
    untilSuccess: true,
    autoPublishScanOrder: true,
    cancelled: false,
    progress: {
      stage: "queued",
      percent: 4,
      updatedAt: new Date().toISOString(),
    },
  });
  await persistCurrentJobActivity(job.jobId);
  enqueueExtractionJob(job.jobId, { ...payload, channel, extractMethod, autoPublishScanOrder: true, untilSuccess: true });
  return store.jobs.get(job.jobId) || job;
}

async function maybeRetryAutoPublishedScanOrder(job: PublicUpiExtractJob | null) {
  if (!shouldRunExtractorInThisProcess()) return job;
  if (!job?.result?.scanOrder?.id) return job;
  if (job.cancelled) return job;
  if (job.status === "queued" || job.status === "running") return job;
  if (!job.untilSuccess) return job;

  const order = await prisma.order.findUnique({
    where: { id: job.result.scanOrder.id },
    include: orderInclude,
  });
  if (!order) return job;

  const typedOrder = order as OrderWithRelations;
  if (!isRetryableAutoPublishedScanOrder(typedOrder)) {
    if (typedOrder.source === "PUBLIC_SCAN" && (typedOrder.status === "FAILED" || typedOrder.status === "EXPIRED")) {
      return markAutoPublishedScanOrderTerminalFailure(
        job,
        typedOrder,
        typedOrder.problemReason || "The scan order failed and cannot be retried automatically."
      );
    }
    return job;
  }
  if (!shouldRetryAutoPublishedScanOrder(job, typedOrder)) return job;

  const payload = await getAutoPublishRetryPayload(job, typedOrder);
  if (!payload?.autoPublishScanOrder) {
    return markAutoPublishedScanOrderTerminalFailure(
      job,
      typedOrder,
      "The scan order failed, but the saved session data is no longer available for automatic retry. Please submit a new task."
    );
  }

  return requeueAutoPublishJob(job, payload, autoPublishRetryReason(typedOrder));
}

export async function retryAutoPublishedScanOrdersReturnedBeforeAcceptance(limit = 30) {
  cleanupMemory();
  await expireStaleOrders();

  let retried = 0;
  for (const job of Array.from(store.jobs.values()).sort(sortQueuedJobsByCreatedAt)) {
    if (retried >= limit) break;
    if (!job.untilSuccess || job.status === "queued" || job.status === "running") continue;
    if (!job.result?.scanOrder?.id) continue;
    const before = store.jobs.get(job.jobId);
    const after = await maybeRetryAutoPublishedScanOrder(job);
    if (before?.status !== "queued" && after?.status === "queued") retried += 1;
  }

  if (retried < limit) {
    const remaining = limit - retried;
    const persistedRows = await getPersistedAutoPublishRetryCandidateRows(remaining);
    for (const row of persistedRows) {
      if (retried >= limit) break;
      if (store.jobs.has(row.jobId)) continue;
      const before = row.status;
      const job = await rowToPublicUpiExtractJob({ ...row, status: normalizeActivityStatus(row.status) });
      const after = await maybeRetryAutoPublishedScanOrder(job);
      if (before !== "queued" && after?.status === "queued") retried += 1;
    }
  }

  return { retried };
}

async function markAbandonedPersistedActivity() {
  if (getPublicUpiExtractRunnerMode() === "external") return;
  try {
    await ensureActivityAccountColumns();
    const liveJobIds = Array.from(store.activity.keys());
    const liveFilter = liveJobIds.length > 0
      ? `AND "jobId" NOT IN (${liveJobIds.map((jobId) => `'${jobId.replace(/'/g, "''")}'`).join(",")})`
      : "";
    await prisma.$executeRawUnsafe(`
      UPDATE "public_upi_extract_activities"
      SET "status" = 'failed',
          "error" = '${ABANDONED_ACTIVITY_ERROR.replace(/'/g, "''")}'
      WHERE "status" IN ('queued', 'running')
        AND "credentialEncrypted" IS NULL
        ${liveFilter}
    `);
  } catch (error) {
    console.error("Failed to mark abandoned public UPI extraction activity", error);
  }
}

function normalizeActivityStatus(status: string): PublicUpiExtractStatus {
  if (status === "completed" || status === "failed" || status === "running" || status === "queued") return status;
  return "failed";
}

function normalizeActivitySource(source?: string | null): PublicUpiExtractSource {
  return source === "storage" ? "storage" : "direct";
}

async function getActivityCounts(channel?: PublicUpiExtractChannel): Promise<PublicUpiExtractActivityCounts> {
  const normalizedChannel = channel ? normalizePublicUpiExtractChannel(channel) : null;
  const counts = emptyActivityCounts();

  try {
    const [grouped, excludedNoFreeTrialCounts] = await Promise.all([
      prisma.publicUpiExtractActivity.groupBy({
        by: ["status"],
        where: normalizedChannel ? { channel: normalizedChannel } : undefined,
        _count: { _all: true },
      }),
      getPersistedNoFreeTrialFailedCountsByChannel(normalizedChannel || undefined),
    ]);
    for (const group of grouped) {
      counts[normalizeActivityStatus(group.status)] += group._count._all;
    }
    counts.failed = Math.max(0, counts.failed - sumNoFreeTrialFailedCounts(excludedNoFreeTrialCounts));

    const memoryItems = shouldRunExtractorInThisProcess()
      ? Array.from(store.activity.values())
        .filter((item) => !normalizedChannel || normalizePublicUpiExtractChannel(item.channel) === normalizedChannel)
      : [];
    if (memoryItems.length > 0) {
      const persistedMemory = await prisma.publicUpiExtractActivity.findMany({
        where: { jobId: { in: memoryItems.map((item) => item.jobId) } },
        select: { jobId: true, status: true },
      });
      const persistedByJobId = new Map(persistedMemory.map((item) => [item.jobId, normalizeActivityStatus(item.status)]));

      for (const item of memoryItems) {
        const persistedStatus = persistedByJobId.get(item.jobId);
        const excluded = isNoFreeTrialHeatmapExcluded(item);
        if (persistedStatus && !excluded) {
          counts[persistedStatus] = Math.max(0, counts[persistedStatus] - 1);
        }
        if (excluded) continue;
        counts[item.status] += 1;
      }
    }

    return counts;
  } catch (error) {
    console.error("Failed to count public UPI extraction activity", error);
    return countActivity(Array.from(store.activity.values()).filter((item) => !normalizedChannel || normalizePublicUpiExtractChannel(item.channel) === normalizedChannel));
  }
}

async function getActivityCountsByChannel(): Promise<PublicUpiExtractActivityCountsByChannel> {
  const counts: PublicUpiExtractActivityCountsByChannel = emptyActivityCountsByChannel();
  try {
    const [grouped, excludedNoFreeTrialCounts] = await Promise.all([
      prisma.publicUpiExtractActivity.groupBy({
        by: ["channel", "status"],
        _count: { _all: true },
      }),
      getPersistedNoFreeTrialFailedCountsByChannel(),
    ]);
    for (const group of grouped) {
      const channel = normalizePublicUpiExtractChannel(group.channel);
      const status = normalizeActivityStatus(group.status);
      counts[channel][status] += group._count._all;
    }
    for (const channel of UPI_EXTRACT_CHANNELS) {
      counts[channel].failed = Math.max(0, counts[channel].failed - excludedNoFreeTrialCounts[channel]);
    }

    const memoryItems = shouldRunExtractorInThisProcess() ? Array.from(store.activity.values()) : [];
    if (memoryItems.length > 0) {
      const persistedMemory = await prisma.publicUpiExtractActivity.findMany({
        where: { jobId: { in: memoryItems.map((item) => item.jobId) } },
        select: { jobId: true, status: true, channel: true },
      });
      const persistedByJobId = new Map(persistedMemory.map((item) => [item.jobId, {
        channel: normalizePublicUpiExtractChannel(item.channel),
        status: normalizeActivityStatus(item.status),
      }]));

      for (const item of memoryItems) {
        const persisted = persistedByJobId.get(item.jobId);
        const excluded = isNoFreeTrialHeatmapExcluded(item);
        if (persisted && !excluded) {
          counts[persisted.channel][persisted.status] = Math.max(0, counts[persisted.channel][persisted.status] - 1);
        }
        const nextChannel = normalizePublicUpiExtractChannel(item.channel);
        const nextStatus = normalizeActivityStatus(item.status);
        if (excluded) continue;
        counts[nextChannel][nextStatus] += 1;
      }
    }

    return counts;
  } catch (error) {
    console.error("Failed to count public UPI extraction activity by channel", error);
    return countActivityByChannel(Array.from(store.activity.values()));
  }
}

async function getStorageActiveCount() {
  try {
    return await prisma.upiGuardTask.count({
      where: {
        status: "ACTIVE",
        expiresAt: { gt: new Date() },
        purgedAt: null,
        credentialEncrypted: { not: "" },
      },
    });
  } catch (error) {
    console.error("Failed to count active UPI guard tasks", error);
    return 0;
  }
}

function emptyActivityCounts(): PublicUpiExtractActivityCounts {
  return { completed: 0, queued: 0, running: 0, failed: 0 };
}

function emptyActivityCountsByChannel(): PublicUpiExtractActivityCountsByChannel {
  return {
    public: emptyActivityCounts(),
    premium: emptyActivityCounts(),
  };
}

async function getPersistedNoFreeTrialFailedCountsByChannel(channel?: PublicUpiExtractChannel): Promise<ChannelMap<number>> {
  const counts: ChannelMap<number> = { public: 0, premium: 0 };
  const channelFilter = channel ? `AND COALESCE("channel", 'public') = '${normalizePublicUpiExtractChannel(channel)}'` : "";
  const rows = await prisma.$queryRawUnsafe<Array<{ channel: string | null; count: number | bigint }>>(`
    SELECT COALESCE("channel", 'public') AS "channel", COUNT(*)::int AS "count"
    FROM "public_upi_extract_activities"
    WHERE "status" = 'failed'
      ${channelFilter}
      AND (
        LOWER(COALESCE("error", '')) LIKE '%no_free_trial%'
        OR LOWER(COALESCE("error", '')) LIKE '%does not have the free trial offer%'
        OR LOWER(COALESCE("error", '')) LIKE '%no free trial%'
      )
    GROUP BY COALESCE("channel", 'public')
  `);
  for (const row of rows) {
    counts[normalizePublicUpiExtractChannel(row.channel)] += Number(row.count || 0);
  }
  return counts;
}

function sumNoFreeTrialFailedCounts(counts: ChannelMap<number>) {
  return UPI_EXTRACT_CHANNELS.reduce((total, channel) => total + counts[channel], 0);
}

function countActivity(items: PublicUpiExtractActivity[]): PublicUpiExtractActivityCounts {
  const counts = emptyActivityCounts();
  for (const item of items) {
    if (isNoFreeTrialHeatmapExcluded(item)) continue;
    counts[item.status] += 1;
  }
  return counts;
}

function countActivityByChannel(items: PublicUpiExtractActivity[]): PublicUpiExtractActivityCountsByChannel {
  const counts = emptyActivityCountsByChannel();
  for (const item of items) {
    if (isNoFreeTrialHeatmapExcluded(item)) continue;
    const channel = normalizePublicUpiExtractChannel(item.channel);
    const status = normalizeActivityStatus(item.status);
    counts[channel][status] += 1;
  }
  return counts;
}

function sumActivityCountsByChannel(countsByChannel: PublicUpiExtractActivityCountsByChannel): PublicUpiExtractActivityCounts {
  const counts = emptyActivityCounts();
  for (const channel of UPI_EXTRACT_CHANNELS) {
    for (const status of ["completed", "queued", "running", "failed"] as const) {
      counts[status] += countsByChannel[channel][status];
    }
  }
  return counts;
}

function omitPrivateActivityFields(item: PublicUpiExtractActivity): PublicUpiExtractActivity {
  const safeItem: PublicUpiExtractActivity = { ...item };
  delete safeItem.accountEmail;
  delete safeItem.accountPhone;
  return safeItem;
}

function totalQueuedCount() {
  return UPI_EXTRACT_CHANNELS.reduce((total, channel) => total + store.queuedJobIdsByChannel[channel].length, 0);
}

function totalActiveExtractionCount() {
  return UPI_EXTRACT_CHANNELS.reduce((total, channel) => total + store.activeExtractionCountByChannel[channel], 0);
}

function sortQueuedJobsByCreatedAt(a: PublicUpiExtractJob, b: PublicUpiExtractJob) {
  const createdCompare = a.createdAt.localeCompare(b.createdAt);
  if (createdCompare !== 0) return createdCompare;
  return a.jobId.localeCompare(b.jobId);
}

function reconcileExtractionRuntime(channel?: PublicUpiExtractChannel) {
  const channels = channel ? [normalizePublicUpiExtractChannel(channel)] : UPI_EXTRACT_CHANNELS;
  for (const itemChannel of channels) {
    let activeCount = 0;
    for (const [jobId] of store.activeRunIds) {
      const job = store.jobs.get(jobId);
      if (job?.status === "running" && normalizePublicUpiExtractChannel(job.channel) === itemChannel) {
        activeCount += 1;
      }
    }
    store.activeExtractionCountByChannel[itemChannel] = activeCount;

    store.queuedJobIdsByChannel[itemChannel] = Array.from(store.jobs.values())
      .filter((job) => normalizePublicUpiExtractChannel(job.channel) === itemChannel)
      .filter((job) => job.status === "queued" && store.payloads.has(job.jobId) && !store.manuallyStoppedJobIds.has(job.jobId))
      .sort(sortQueuedJobsByCreatedAt)
      .map((job) => job.jobId);
  }
}

function removeQueuedJob(jobId: string) {
  for (const channel of UPI_EXTRACT_CHANNELS) {
    const queue = store.queuedJobIdsByChannel[channel];
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      if (queue[index] === jobId) queue.splice(index, 1);
    }
  }
}

function rememberCancelledJob(jobId: string) {
  store.cancelledJobIds.add(jobId);
  store.cancelCheckMemory.set(jobId, { at: Date.now(), cancelled: true });
}

function forgetCancelledJob(jobId: string) {
  store.cancelledJobIds.delete(jobId);
  store.cancelCheckMemory.delete(jobId);
}

function enqueueExtractionJob(jobId: string, payload: QueuedExtractionPayload) {
  const channel = normalizePublicUpiExtractChannel(payload.channel);
  const extractMethod = normalizePublicUpiExtractMethod(payload.extractMethod);
  store.payloads.set(jobId, { ...payload, channel, extractMethod });
  store.manuallyStoppedJobIds.delete(jobId);
  removeQueuedJob(jobId);
  store.queuedJobIdsByChannel[channel].push(jobId);
  appendPublicUpiExtractDebugLog(jobId, "info", "Job queued for extractor", {
    stage: "queued",
    percent: 4,
    details: {
      channel,
      extractMethod,
      queueLength: store.queuedJobIdsByChannel[channel].length,
      runnerMode: getPublicUpiExtractRunnerMode(),
    },
  });
  if (shouldRunExtractorInThisProcess()) {
    processExtractionQueue({ channel });
  }
}

function buildLiveJobExclusionSql(jobIds: string[]) {
  if (jobIds.length === 0) return "";
  return `AND "jobId" NOT IN (${jobIds.map((jobId) => `'${jobId.replace(/'/g, "''")}'`).join(",")})`;
}

async function requeueStalePersistedRunningJobs(staleMs = STALE_PERSISTED_RUNNING_REQUEUE_MS) {
  if (!shouldRunExtractorInThisProcess()) return 0;
  await ensureActivityAccountColumns();
  const cutoff = new Date(Date.now() - Math.max(60_000, Math.floor(staleMs))).toISOString();
  const liveFilter = buildLiveJobExclusionSql(Array.from(store.activeRunIds.keys()));
  const rows = await prisma.$queryRawUnsafe<Array<{ jobId: string; channel: string | null }>>(`
    UPDATE "public_upi_extract_activities"
    SET "status" = 'queued',
        "progressStage" = 'queued',
        "progressPercent" = 4,
        "progressUpdatedAt" = NOW(),
        "updatedAt" = NOW()
    WHERE "status" = 'running'
      AND "credentialEncrypted" IS NOT NULL
      AND COALESCE("cancelled", FALSE) = FALSE
      AND "updatedAt" < '${cutoff.replace(/'/g, "''")}'
      ${liveFilter}
    RETURNING "jobId", "channel"
  `);

  for (const row of rows) {
    store.activeRunIds.delete(row.jobId);
    removeQueuedJob(row.jobId);
    const channel = normalizePublicUpiExtractChannel(row.channel);
    const job = store.jobs.get(row.jobId);
    if (job && job.status === "running") {
      store.jobs.set(row.jobId, {
        ...job,
        status: "queued",
        progress: {
          stage: "queued",
          percent: 4,
          updatedAt: new Date().toISOString(),
        },
        updatedAt: new Date().toISOString(),
      });
    }
    invalidateHeatmapOverviewCache(channel);
  }

  if (rows.length > 0) {
    console.warn("Requeued stale persisted extraction jobs", {
      count: rows.length,
      staleMs,
      cutoff,
    });
  }

  return rows.length;
}

async function restorePersistedExtractJobRows(rows: PersistedExtractJobRow[]) {
  let restored = 0;

  for (const row of rows) {
    if (store.activeRunIds.has(row.jobId)) continue;
    const existing = store.jobs.get(row.jobId);
    if (existing?.status === "running" && store.activeRunIds.has(row.jobId)) continue;

    const channel = normalizePublicUpiExtractChannel(row.channel);
    const extractMethod = normalizePublicUpiExtractMethod(row.extractMethod);
    if (existing?.status === "queued" && store.payloads.has(row.jobId)) {
      removeQueuedJob(row.jobId);
      store.queuedJobIdsByChannel[channel].push(row.jobId);
      continue;
    }

    let credential: string;
    try {
      credential = decryptSessionCredential(row.credentialEncrypted || "");
    } catch (error) {
      console.warn("Failed to decrypt persisted public UPI extraction payload", {
        jobId: row.jobId,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    let checkoutProxyUrl = "";
    let providerProxyUrl = "";
    try {
      checkoutProxyUrl = row.customCheckoutProxyEncrypted ? decryptSessionCredential(row.customCheckoutProxyEncrypted) : "";
      providerProxyUrl = row.customProviderProxyEncrypted ? decryptSessionCredential(row.customProviderProxyEncrypted) : "";
    } catch (error) {
      console.warn("Failed to decrypt persisted public UPI extraction custom proxy payload", {
        jobId: row.jobId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const restoredJob = await rowToPublicUpiExtractJob({
      ...row,
      status: "queued",
    });
    store.payloads.set(row.jobId, {
      credential,
      issueGuardCreateToken: Boolean(row.issueGuardCreateToken),
      source: normalizeActivitySource(row.source),
      channel,
      extractMethod,
      guardId: row.guardId || undefined,
      publicUserTelegramId: row.publicUserTelegramId || null,
      publicUserTelegramName: row.publicUserTelegramName || null,
      accountEmail: row.accountEmail || null,
      accountPhone: row.accountPhone || null,
      autoPublishScanOrder: Boolean(row.autoPublishScanOrder),
      untilSuccess: Boolean(row.untilSuccess),
      approvalParallelism: normalizeApprovalParallelismInput(row.approvalParallelism),
      checkoutProxyUrl,
      providerProxyUrl,
    });
    setJob({
      ...restoredJob,
      status: "queued",
      progress: { stage: "queued", percent: 4, updatedAt: new Date().toISOString() },
    });
    removeQueuedJob(row.jobId);
    store.queuedJobIdsByChannel[channel].push(row.jobId);
    appendPublicUpiExtractDebugLog(row.jobId, "info", "Persisted extraction job restored into local runner", {
      stage: "queued",
      percent: 4,
      details: {
        channel,
        extractMethod,
        restoredFromStatus: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
    });
    restored += 1;
  }

  return restored;
}

async function restorePersistedQueuedJobs(limit = MAX_PERSISTED_ACTIVE_JOB_RESTORE) {
  const queuedRows = await getPersistedExtractJobRows(`
    "status" = 'queued'
    AND "credentialEncrypted" IS NOT NULL
    AND COALESCE("cancelled", FALSE) = FALSE
  `, MAX_PERSISTED_QUEUED_JOB_RESTORE, `"updatedAt" ASC, "createdAt" ASC, "id" ASC`);

  const restoredQueued = await restorePersistedExtractJobRows(queuedRows);
  const remaining = Math.max(0, limit - restoredQueued);
  if (remaining <= 0) return restoredQueued;

  const runningRows = await getPersistedExtractJobRows(`
    "status" = 'running'
    AND "credentialEncrypted" IS NOT NULL
    AND COALESCE("cancelled", FALSE) = FALSE
  `, remaining, `"updatedAt" ASC, "createdAt" ASC, "id" ASC`);

  return restoredQueued + await restorePersistedExtractJobRows(runningRows);
}

function processExtractionQueue(options?: { force?: boolean; channel?: PublicUpiExtractChannel }) {
  if (!shouldRunExtractorInThisProcess()) return;
  cleanupMemory();

  const channels = options?.channel ? [normalizePublicUpiExtractChannel(options.channel)] : UPI_EXTRACT_CHANNELS;
  reconcileExtractionRuntime(options?.channel);
  for (const channel of channels) {
    if (!options?.force && isPublicUpiExtractPausedCached(channel)) continue;
    const queue = store.queuedJobIdsByChannel[channel];
    const maxConcurrent = getMaxConcurrentCached(channel);
    while (store.activeExtractionCountByChannel[channel] < maxConcurrent && queue.length > 0) {
      const jobId = queue.shift();
      if (!jobId) continue;

      const payload = store.payloads.get(jobId);
      const job = store.jobs.get(jobId);
      if (!payload || !job || job.cancelled || job.status !== "queued") continue;
      launchJob(jobId, { ...payload, channel });
    }
  }
}

function startSpecificJob(jobId: string) {
  const payload = store.payloads.get(jobId);
  const job = store.jobs.get(jobId);
  if (!payload || !job) return;
  if (job.cancelled) return;
  const channel = normalizePublicUpiExtractChannel(job.channel || payload.channel);
  store.manuallyStoppedJobIds.delete(jobId);
  removeQueuedJob(jobId);
  if (!shouldRunExtractorInThisProcess()) {
    store.queuedJobIdsByChannel[channel].unshift(jobId);
    invalidateHeatmapOverviewCache(channel);
    return;
  }
  reconcileExtractionRuntime(channel);
  if (store.activeExtractionCountByChannel[channel] >= getMaxConcurrentCached(channel)) {
    store.queuedJobIdsByChannel[channel].unshift(jobId);
    return;
  }
  launchJob(jobId, { ...payload, channel });
}

function launchJob(jobId: string, payload: QueuedExtractionPayload) {
  if (!shouldRunExtractorInThisProcess()) return;
  const channel = normalizePublicUpiExtractChannel(payload.channel);
  store.activeExtractionCountByChannel[channel] += 1;
  const runId = ++store.nextRunSeq;
  store.activeRunIds.set(jobId, runId);
  appendPublicUpiExtractDebugLog(jobId, "info", "Extractor worker launched job", {
    stage: "queued",
    percent: 4,
    details: {
      channel,
      extractMethod: normalizePublicUpiExtractMethod(payload.extractMethod),
      runId,
      activeCount: store.activeExtractionCountByChannel[channel],
    },
  });
  void runExtractionJob(jobId, payload, runId).finally(() => {
    if (store.activeRunIds.get(jobId) === runId) store.activeRunIds.delete(jobId);
    processExtractionQueue({ channel });
  });
}

export async function runPublicUpiExtractWorkerTick() {
  cleanupMemory();
  await Promise.all(UPI_EXTRACT_CHANNELS.map((channel) => isPublicUpiExtractPaused(channel)));
  const staleRunningRequeued = await requeueStalePersistedRunningJobs();
  const restoredPersistedJobs = await restorePersistedQueuedJobs();
  const autoPublishRetryResult = await retryAutoPublishedScanOrdersReturnedBeforeAcceptance();
  processExtractionQueue({ force: false });
  return {
    runnerMode: getPublicUpiExtractRunnerMode(),
    maxConcurrentByChannel: { ...store.maxConcurrentByChannel },
    staleRunningRequeued,
    restoredPersistedJobs,
    autoPublishRetryCount: autoPublishRetryResult.retried,
    activeExtractionCount: totalActiveExtractionCount(),
    queuedCount: totalQueuedCount(),
    activeExtractionCountByChannel: { ...store.activeExtractionCountByChannel },
    queuedCountByChannel: {
      public: store.queuedJobIdsByChannel.public.length,
      premium: store.queuedJobIdsByChannel.premium.length,
    },
  };
}

export function startPublicUpiExtractWorkerLoop(options?: { intervalMs?: number }) {
  const intervalMs = Math.max(1000, Math.floor(options?.intervalMs || 2000));
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runPublicUpiExtractWorkerTick();
    } catch (error) {
      console.error("Public UPI extractor worker tick failed", error);
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  return () => clearInterval(timer);
}

function isCurrentRun(jobId: string, runId: number) {
  return store.activeRunIds.get(jobId) === runId;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isPersistedJobCancelled(jobId: string) {
  try {
    await ensureActivityAccountColumns();
    const rows = await prisma.$queryRaw<Array<{ cancelled: boolean | null; status: string | null }>>`
      SELECT "cancelled", "status"
      FROM "public_upi_extract_activities"
      WHERE "jobId" = ${jobId}
      LIMIT 1
    `;
    const row = rows[0];
    return Boolean(row?.cancelled && row.status === "failed");
  } catch {
    return false;
  }
}

async function isRunCancelled(jobId: string) {
  if (store.cancelledJobIds.has(jobId)) return true;
  const cached = store.cancelCheckMemory.get(jobId);
  if (cached && Date.now() - cached.at < CANCEL_CHECK_CACHE_MS) return cached.cancelled;
  const cancelled = await isPersistedJobCancelled(jobId);
  store.cancelCheckMemory.set(jobId, { at: Date.now(), cancelled });
  if (cancelled) rememberCancelledJob(jobId);
  return cancelled;
}

function markLocalRunCancelled(
  jobId: string,
  started: PublicUpiExtractJob,
  input: {
    runId?: number;
    untilSuccess: boolean;
    attempt: number;
    reason?: string;
  }
) {
  if (input.runId !== undefined && !isCurrentRun(jobId, input.runId)) return false;
  rememberCancelledJob(jobId);
  const current = store.jobs.get(jobId) || started;
  const channel = normalizePublicUpiExtractChannel(current.channel);
  removeQueuedJob(jobId);
  store.payloads.delete(jobId);
  if (input.runId === undefined || store.activeRunIds.get(jobId) === input.runId) {
    store.activeRunIds.delete(jobId);
  }
  appendPublicUpiExtractDebugLog(jobId, "warn", "Extraction run stopped because the task was cancelled", {
    stage: current.progress?.stage,
    percent: current.progress?.percent,
    attempt: input.attempt,
    details: { untilSuccess: input.untilSuccess },
  });
  void releaseAutoPublishScanOrderReservation(current, "Auto-publish extraction task cancelled; reserved scan order balance refunded.").catch((error) => {
    console.error("Failed to release auto-publish scan order reservation after cancellation", error);
  });
  setJob({
    ...current,
    status: "failed",
    error: input.reason || current.error || "Cancelled by user",
    cancelled: true,
    untilSuccess: input.untilSuccess,
    retryCount: Math.max(0, input.attempt),
    progress: {
      ...(current.progress || { stage: "queued", percent: 4 }),
      attempt: input.attempt > 0 ? input.attempt : current.progress?.attempt,
      updatedAt: new Date().toISOString(),
    },
  });
  if (shouldRunExtractorInThisProcess()) processExtractionQueue({ channel });
  return true;
}

async function stopRunIfPersistedCancelled(
  jobId: string,
  started: PublicUpiExtractJob,
  input: {
    untilSuccess: boolean;
    attempt: number;
  }
) {
  if (!(await isRunCancelled(jobId))) return false;
  return markLocalRunCancelled(jobId, started, input);
}

function setJobProgress(jobId: string, runId: number, progress: UpiExtractionProgress) {
  if (!isCurrentRun(jobId, runId)) return;
  const job = store.jobs.get(jobId);
  if (!job || job.cancelled || job.status !== "running") return;
  if (store.cancelledJobIds.has(jobId)) {
    markLocalRunCancelled(jobId, job, {
      runId,
      untilSuccess: Boolean(job.untilSuccess),
      attempt: Math.max(0, progress.attempt ?? job.retryCount ?? 0),
    });
    return;
  }
  void isRunCancelled(jobId).then((cancelled) => {
    if (!cancelled) return;
    markLocalRunCancelled(jobId, job, {
      runId,
      untilSuccess: Boolean(job.untilSuccess),
      attempt: Math.max(0, progress.attempt ?? job.retryCount ?? 0),
    });
  }).catch(() => {
    // Cancellation checks are best-effort; extraction progress must keep working.
  });
  appendPublicUpiExtractDebugLog(jobId, "debug", `Progress: ${progress.stage}`, {
    stage: progress.stage,
    percent: progress.percent,
    proxy: progress.proxy,
    attempt: progress.attempt,
    maxAttempts: progress.maxAttempts,
  });
  setJob({
    ...job,
    progress: {
      ...progress,
      updatedAt: new Date().toISOString(),
    },
  });
}

function compactError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "UPI QR extraction failed");
  return userFacingExtractionError(message);
}

function isNoFreeTrialError(error: unknown, message?: string) {
  const text = String(message || (error instanceof Error ? error.message : error) || "").toLowerCase();
  return error instanceof NoFreeTrialError ||
    text.includes("no_free_trial") ||
    text.includes("does not have the free trial offer") ||
    text.includes("no free trial");
}

function isNonRetryableExtractionError(error: unknown, message?: string) {
  if (isNoFreeTrialError(error, message)) return true;
  if (error instanceof PaymentMethodUnavailableError) return true;
  const rawMessage = error instanceof Error ? error.message : String(error || "");
  const text = `${message || ""}\n${rawMessage}`.toLowerCase().replace(/\s+/g, " ").trim();
  const compactText = text.replace(/\s+/g, "");
  const includesAll = (...parts: string[]) => parts.every((part) => text.includes(part) || compactText.includes(part.replace(/\s+/g, "")));
  return (
    text.includes("payment_method_unavailable") ||
    text.includes("available_payment_method_types") ||
    text.includes("available payment method") ||
    text.includes("payment method unavailable") ||
    text.includes("no supported payment method") ||
    text.includes("no available payment method") ||
    text.includes("cannot create a upi payment") ||
    text.includes("cannot create an ideal payment") ||
    text.includes("cannot create upi payment") ||
    text.includes("cannot create ideal payment") ||
    text.includes("billing country must match request country") ||
    includesAll("billing country", "request country") ||
    text.includes("region is locked") ||
    text.includes("region locked") ||
    text.includes("country is locked") ||
    text.includes("country locked") ||
    text.includes("billing country locked") ||
    includesAll("cannot change", "billing") ||
    includesAll("billing", "cannot be changed") ||
    includesAll("billing address", "locked") ||
    includesAll("openai", "locked") ||
    text.includes("地区已被 openai 锁定") ||
    text.includes("无法更改账单地址") ||
    includesAll("地区", "锁定") ||
    includesAll("账单", "无法", "更改") ||
    includesAll("账单", "不能", "更改") ||
    text.includes("鍦板尯宸茶 openai 閿佸畾") ||
    text.includes("鏃犳硶鏇存敼璐﹀崟鍦板潃") ||
    text.includes("token_invalidated") ||
    text.includes("token invalidated") ||
    text.includes("invalidated oauth token") ||
    text.includes("token_expired") ||
    text.includes("authentication token is expired") ||
    text.includes("provided authentication token is expired") ||
    text.includes("session token has expired") ||
    text.includes("session token expired") ||
    text.includes("token_revoked") ||
    text.includes("token has been invalidated") ||
    text.includes("user is already paid") ||
    text.includes("already paid") ||
    text.includes("already subscribed") ||
    text.includes("already has an active subscription") ||
    text.includes("bound email") ||
    text.includes("email already bound") ||
    text.includes("account has an email") ||
    text.includes("no valid session token") ||
    text.includes("session cookie") && text.includes("invalid") ||
    text.includes("session json") && text.includes("invalid")
  );
}

function userFacingExtractionError(message: string) {
  const text = String(message || "").trim();
  const lower = text.toLowerCase();

  if (isNoFreeTrialError(null, text)) {
    return "This account does not have the free trial offer. Please use another account.";
  }

  if (
    lower.includes("payment_method_unavailable") ||
    lower.includes("available_payment_method_types") ||
    lower.includes("available payment method") ||
    lower.includes("payment method unavailable") ||
    lower.includes("no supported payment method") ||
    lower.includes("no available payment method") ||
    lower.includes("cannot create a upi payment") ||
    lower.includes("cannot create an ideal payment") ||
    lower.includes("cannot create upi payment") ||
    lower.includes("cannot create ideal payment")
  ) {
    if (lower.includes("ideal")) {
      return "This account cannot create an IDEAL payment. Please switch account and try again.";
    }
    return "This account cannot create a UPI payment. Please switch account and try again.";
  }

  if (
    lower.includes("billing country must match request country") ||
    lower.includes("billing country") ||
    lower.includes("request country") ||
    lower.includes("region is locked") ||
    lower.includes("region locked") ||
    lower.includes("country is locked") ||
    lower.includes("country locked") ||
    lower.includes("billing country locked") ||
    (lower.includes("billing") && (lower.includes("cannot change") || lower.includes("cannot be changed") || lower.includes("locked"))) ||
    lower.includes("地区已被 openai 锁定") ||
    lower.includes("无法更改账单地址") ||
    (lower.includes("地区") && lower.includes("锁定")) ||
    (lower.includes("账单") && (lower.includes("无法") || lower.includes("不能")) && lower.includes("更改"))
  ) {
    return "This account's region is locked by OpenAI, so the billing country cannot be changed.";
  }

  if (lower.includes("bound email") || lower.includes("email already bound") || lower.includes("account has an email")) {
    return "This account is already bound to an email address, so the UPI link cannot be extracted.";
  }

  if (
    lower.includes("token_invalidated") ||
    lower.includes("token_expired") ||
    lower.includes("token invalidated") ||
    lower.includes("authentication token is expired") ||
    lower.includes("provided authentication token is expired") ||
    lower.includes("session token expired") ||
    lower.includes("token has been invalidated") ||
    lower.includes("invalidated oauth token") ||
    lower.includes("token_revoked")
  ) {
    return "This session token has expired or been invalidated. Please sign in again and use a fresh token.";
  }

  if (lower.includes("user is already paid") || lower.includes("already paid") || lower.includes("already subscribed") || lower.includes("already has an active subscription")) {
    return "This account is already subscribed or paid. Please use another account.";
  }

  if (
    lower.includes("no valid session token") ||
    lower.includes("session token") && lower.includes("invalid") ||
    lower.includes("session cookie") && lower.includes("invalid") ||
    lower.includes("session json") && lower.includes("invalid")
  ) {
    return "No valid session token / session cookie / session JSON was recognized.";
  }

  if (lower.includes("ideal") && (lower.includes('"result":"blocked"') || lower.includes("approve") || lower.includes("approval") || lower.includes("approve_attempts"))) {
    return "IDEAL payment link generation failed because the Approve step is temporarily blocked. Please retry later or switch account/exit node.";
  }

  if (lower.includes('"result":"blocked"') || lower.includes("approve") || lower.includes("approval") || lower.includes("approve_attempts")) {
    return "UPI QR generation failed because the Approve step is temporarily blocked. Please retry later or switch account/exit node.";
  }

  if (
    lower.includes("econnrefused") ||
    lower.includes("socks5") ||
    lower.includes("authentication timeout") ||
    lower.includes("fetch failed") ||
    lower.includes("connect timeout") ||
    lower.includes("exit nodes are failing")
  ) {
    if (lower.includes("ideal")) {
      return "IDEAL payment link generation failed because available exit nodes are failing. Please check the proxy pool or retry later.";
    }
    return "UPI QR generation failed because available exit nodes are failing. Please check the proxy pool or retry later.";
  }

  if (lower.includes("upi://") || lower.includes("no upi") || lower.includes("upi data")) {
    return "UPI QR generation failed because no UPI data was returned by the payment response. Please retry later or switch account/exit node.";
  }

  if (lower.includes("ideal") || lower.includes("payment link")) {
    return "IDEAL payment link generation failed. Please retry later or switch account/exit node.";
  }

  if (lower.includes("http 524") || lower.includes("timeout") || lower.includes("timed out")) {
    return "The background extraction timed out. Please check the result later or submit again.";
  }

  return "UPI QR generation failed. Please retry later or switch account/exit node.";
}

async function runExtractionJob(jobId: string, payload: QueuedExtractionPayload, runId: number) {
  const started = store.jobs.get(jobId);
  if (!started || !isCurrentRun(jobId, runId)) return;

  const credential = payload.credential;
  const channel = normalizePublicUpiExtractChannel(payload.channel);
  const extractMethod = normalizePublicUpiExtractMethod(payload.extractMethod);
  const autoPublishForThisJob = extractMethod === "upi" && Boolean(payload.autoPublishScanOrder);
  const untilSuccess = channel === "premium" && Boolean(payload.untilSuccess);
  const approvalParallelism = normalizeApprovalParallelismInput(payload.approvalParallelism);
  const extractionLabel = extractMethod === "ideal" ? "IDEAL" : "UPI";
  let attempt = 0;

  if (await stopRunIfPersistedCancelled(jobId, started, { untilSuccess, attempt: 0 })) return;

  appendPublicUpiExtractDebugLog(jobId, "info", `${extractionLabel} extraction run started`, {
    stage: "queued",
    percent: 4,
    details: {
      channel,
      extractMethod,
      untilSuccess,
      autoPublishScanOrder: autoPublishForThisJob,
      approvalParallelism,
      accountEmail: payload.accountEmail || null,
      accountPhone: payload.accountPhone || null,
      runId,
    },
  });

  setJob({
    ...started,
    extractMethod,
    status: "running",
    untilSuccess,
    autoPublishScanOrder: autoPublishForThisJob,
    approvalParallelism,
    retryCount: 0,
    cancelled: false,
    error: undefined,
    progress: { stage: "queued", percent: 4, updatedAt: new Date().toISOString() },
  });

  while (isCurrentRun(jobId, runId)) {
    if (await stopRunIfPersistedCancelled(jobId, started, { untilSuccess, attempt })) return;
    attempt += 1;
    try {
      if (await stopRunIfPersistedCancelled(jobId, started, { untilSuccess, attempt })) return;
      appendPublicUpiExtractDebugLog(jobId, "info", `${extractionLabel} extraction attempt ${attempt} started`, {
        stage: "queued",
        percent: 4,
        attempt,
        details: {
          channel,
          extractMethod,
          approvalParallelism,
        },
      });
      setJob({
        ...(store.jobs.get(jobId) || started),
        extractMethod,
        status: "running",
        untilSuccess,
        autoPublishScanOrder: autoPublishForThisJob,
        approvalParallelism,
        retryCount: Math.max(0, attempt - 1),
        cancelled: false,
        error: attempt > 1 ? (store.jobs.get(jobId)?.error || undefined) : undefined,
      });

      const onExtractionProgress = (progress: UpiExtractionProgress) => setJobProgress(jobId, runId, { ...progress, attempt });
      const onExtractionDebug = (event: UpiExtractionDebugEvent) => appendPublicUpiExtractDebugLog(
        jobId,
        event.level || "debug",
        event.message,
        {
          stage: event.stage,
          percent: event.percent,
          proxy: event.proxy,
          attempt,
          maxAttempts: event.maxAttempts,
          details: event.details,
        }
      );
      const shouldCancelExtraction = () => isRunCancelled(jobId);
      const extracted = extractMethod === "ideal"
        ? await extractIdealPaymentFromCredential(credential, {
          proxyPool: channel,
          approvalParallelism,
          checkoutProxyUrl: payload.checkoutProxyUrl,
          providerProxyUrl: payload.providerProxyUrl,
          shouldCancel: shouldCancelExtraction,
          onProgress: onExtractionProgress,
          onDebug: onExtractionDebug,
        })
        : await extractUpiQrFromCredential(credential, {
          proxyPool: channel,
          approvalParallelism,
          checkoutProxyUrl: payload.checkoutProxyUrl,
          providerProxyUrl: payload.providerProxyUrl,
          shouldCancel: shouldCancelExtraction,
          onProgress: onExtractionProgress,
          onDebug: onExtractionDebug,
        });
      if (!isCurrentRun(jobId, runId)) return;
      if (await stopRunIfPersistedCancelled(jobId, started, { untilSuccess, attempt: Math.max(0, attempt - 1) })) return;

      const expiresAt = normalizeExpiresAt(extracted.expiresAt);
      const chatGptCheckoutUrl = chatGptPaymentUrl(extracted.processorEntity, extracted.checkoutSessionId);
      const stripeInstructionsUrl = "hostedInstructionsUrl" in extracted ? extracted.hostedInstructionsUrl || "" : "";
      const paymentUrl = "paymentUrl" in extracted ? extracted.paymentUrl : stripeInstructionsUrl || chatGptCheckoutUrl;
      const result: PublicUpiExtractResult = {
        qrImageUrl: qrPngDataUrl(extracted.qrPngBuffer),
        ...("upiUri" in extracted ? { upiUri: extracted.upiUri } : {}),
        checkoutSessionId: extracted.checkoutSessionId,
        processorEntity: extracted.processorEntity,
        paymentUrl,
        extractMethod,
        chatGptPaymentUrl: "chatGptPaymentUrl" in extracted ? extracted.chatGptPaymentUrl : chatGptCheckoutUrl,
        ...(stripeInstructionsUrl ? { stripeInstructionsUrl } : {}),
        expiresAt: expiresAt.toISOString(),
        createdAt: new Date().toISOString(),
        accountEmail: payload.accountEmail || null,
        accountPhone: payload.accountPhone || null,
        ...(payload.issueGuardCreateToken && extractMethod === "upi" ? { guardCreateToken: createGuardCreateTicket(credential) } : {}),
      };
      if (extractMethod === "upi" && payload.publicUserTelegramId && result.upiUri) {
        result.scanOrderCreateToken = createPublicScanOrderTicket({
          jobId,
          credential,
          qrImageUrl: result.qrImageUrl,
          upiUri: result.upiUri,
          paymentUrl: result.paymentUrl,
          expiresAt: result.expiresAt,
          publicUserTelegramId: payload.publicUserTelegramId,
          publicUserTelegramName: payload.publicUserTelegramName || null,
          channel,
        });
      }
      if (autoPublishForThisJob && result.scanOrderCreateToken && payload.publicUserTelegramId) {
        try {
          const { order } = await createPublicScanOrderFromTicket({
            token: result.scanOrderCreateToken,
            telegramUserId: payload.publicUserTelegramId,
            telegramUsername: payload.publicUserTelegramName || null,
          });
          result.scanOrder = serializeWorkerOrder(order);
        } catch (publishError) {
          result.scanOrderError = publishError instanceof Error ? publishError.message : "Scan order auto-publish failed";
        }
      }
      if (autoPublishForThisJob && result.scanOrderError && !result.scanOrder) {
        if (untilSuccess) {
          throw new Error(`Scan order auto-publish failed: ${result.scanOrderError}`);
        }
        await releaseAutoPublishScanOrderReservation(
          store.jobs.get(jobId) || started,
          "Auto-publish scan order could not be created; reserved balance refunded."
        );
      }
      if (payload.guardId) await recordUpiGuardUseSuccess(payload.guardId);
      if (!isCurrentRun(jobId, runId)) return;

      appendPublicUpiExtractDebugLog(jobId, "info", `${extractionLabel} extraction attempt ${attempt} completed`, {
        stage: "completed",
        percent: 100,
        attempt,
        details: {
          checkoutSessionId: extracted.checkoutSessionId,
          processorEntity: extracted.processorEntity,
          expiresAt: result.expiresAt,
          paymentUrl: result.paymentUrl,
          chatGptPaymentUrl: result.chatGptPaymentUrl,
          stripeInstructionsUrl: result.stripeInstructionsUrl,
          hasUpiUri: Boolean(result.upiUri),
          scanOrderAutoPublish: autoPublishForThisJob,
          scanOrderCreated: Boolean(result.scanOrder),
          scanOrderError: result.scanOrderError || null,
          steps: extracted.steps,
          ...("paymentMethodTypes" in extracted ? { paymentMethodTypes: extracted.paymentMethodTypes } : {}),
        },
      });
      if (!(untilSuccess && autoPublishForThisJob) && !payload.publicUserTelegramId) {
        store.payloads.delete(jobId);
      }
      setJob({
        ...(store.jobs.get(jobId) || started),
        extractMethod,
        status: "completed",
        result,
        error: undefined,
        untilSuccess,
        retryCount: Math.max(0, attempt - 1),
        progress: { stage: "completed", percent: 100, attempt, updatedAt: new Date().toISOString() },
      });
      if (payload.publicUserTelegramId) {
        void notifyPublicUpiExtractResult({
          telegramUserId: payload.publicUserTelegramId,
          channel,
          status: "completed",
          qrPngBuffer: extracted.qrPngBuffer,
          paymentUrl: result.paymentUrl,
          expiresAt: result.expiresAt,
          accountEmail: result.accountEmail || payload.accountEmail || null,
          accountPhone: result.accountPhone || payload.accountPhone || null,
        }).catch((error) => {
          console.error("Public UPI extraction result notification failed", error);
        });
      }
      return;
    } catch (error) {
      if (!isCurrentRun(jobId, runId)) return;
      if (await stopRunIfPersistedCancelled(jobId, started, { untilSuccess, attempt })) return;
      if (payload.guardId) await recordUpiGuardUseFailure(payload.guardId, error);
      const errorMessage = compactError(error);
      const noFreeTrial = isNoFreeTrialError(error, errorMessage);
      const nonRetryable = isNonRetryableExtractionError(error, errorMessage);
      appendPublicUpiExtractDebugLog(jobId, nonRetryable ? "error" : "warn", `${extractionLabel} extraction attempt ${attempt} failed`, {
        stage: store.jobs.get(jobId)?.progress?.stage || "retrying",
        percent: store.jobs.get(jobId)?.progress?.percent ?? 8,
        attempt,
        details: {
          userFacingError: errorMessage,
          rawError: error,
          noFreeTrial,
          nonRetryable,
          untilSuccess,
        },
      });
      console.warn(
        noFreeTrial
          ? `${extractionLabel} extraction stopped because free trial is unavailable`
          : nonRetryable
            ? `${extractionLabel} extraction stopped because the error is not retryable`
            : untilSuccess
              ? `Premium ${extractionLabel} extraction attempt failed; retrying until success`
              : `Public ${extractionLabel} extraction job failed`,
        {
        jobId,
        channel,
        extractMethod,
        attempt,
        untilSuccess,
        error: error instanceof Error ? error.message : String(error),
        }
      );

      if (!untilSuccess || nonRetryable) {
        if (nonRetryable) store.payloads.delete(jobId);
        await releaseAutoPublishScanOrderReservation(
          store.jobs.get(jobId) || started,
          "Auto-publish extraction stopped before creating a scan order; reserved balance refunded."
        );
        appendPublicUpiExtractDebugLog(jobId, "error", `${extractionLabel} extraction stopped`, {
          stage: store.jobs.get(jobId)?.progress?.stage || "retrying",
          percent: store.jobs.get(jobId)?.progress?.percent ?? 8,
          attempt,
          details: {
            userFacingError: errorMessage,
            noFreeTrial,
            nonRetryable,
          },
        });
        setJob({ ...(store.jobs.get(jobId) || started), extractMethod, status: "failed", error: errorMessage, retryCount: Math.max(0, attempt - 1) });
        if (payload.publicUserTelegramId) {
          void notifyPublicUpiExtractResult({
            telegramUserId: payload.publicUserTelegramId,
            channel,
            status: "failed",
            error: errorMessage,
            accountEmail: payload.accountEmail || null,
            accountPhone: payload.accountPhone || null,
          }).catch((notifyError) => {
            console.error("Public UPI extraction result notification failed", notifyError);
          });
        }
        return;
      }

      if (await stopRunIfPersistedCancelled(jobId, started, { untilSuccess: true, attempt })) return;

      appendPublicUpiExtractDebugLog(jobId, "info", `${extractionLabel} extraction will retry until success`, {
        stage: "retrying",
        percent: 8,
        attempt: attempt + 1,
        details: {
          previousAttempt: attempt,
          retryDelayMs: UNTIL_SUCCESS_RETRY_DELAY_MS,
          lastError: errorMessage,
        },
      });
      setJob({
        ...(store.jobs.get(jobId) || started),
        extractMethod,
        status: "running",
        error: errorMessage,
        untilSuccess: true,
        retryCount: attempt,
        progress: {
          stage: "retrying",
          percent: 8,
          attempt: attempt + 1,
          updatedAt: new Date().toISOString(),
        },
      });
      await sleep(UNTIL_SUCCESS_RETRY_DELAY_MS);
      if (await stopRunIfPersistedCancelled(jobId, started, { untilSuccess: true, attempt })) return;
    }
  }
}
