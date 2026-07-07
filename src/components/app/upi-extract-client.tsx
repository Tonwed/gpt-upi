"use client";

import { type CSSProperties, FormEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircleIcon,
  BotIcon,
  ChevronDownIcon,
  CheckCircle2Icon,
  ClockIcon,
  CopyIcon,
  CrownIcon,
  ExternalLinkIcon,
  HelpCircleIcon,
  KeyRoundIcon,
  LinkIcon,
  Loader2Icon,
  LogOutIcon,
  QrCodeIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SendIcon,
  ShieldCheckIcon,
  SparklesIcon,
  StarIcon,
  Trash2Icon,
  UserCircleIcon,
  UsersRoundIcon,
  WalletIcon,
  XCircleIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch } from "@/lib/api-client";
import type { PublicOrder } from "@/lib/types/app";
import { cn } from "@/lib/utils";

const AUTH_SESSION_URL = "https://chatgpt.com/api/auth/session";
const OPEN_SOURCE_REPO_URL = "https://github.com/Tonwed/gpt-upi";
const OPEN_SOURCE_REPO_API_URL = "https://api.github.com/repos/Tonwed/gpt-upi";
const SCANNER_APPLY_URL = process.env.NEXT_PUBLIC_SCANNER_APPLY_URL || "https://t.me/your_admin";
const TELEGRAM_BOT_USERNAME = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME || "your_bot_username";
const POLL_INTERVAL_MS = 2_000;
const HEATMAP_ROWS = 5;
const HEATMAP_CELL_SIZE = 10;
const HEATMAP_CELL_GAP = 4;
const HEATMAP_WRAP_GAP = 8;
const PRESENCE_HEARTBEAT_MS = 10_000;
const BUFF_POLL_INTERVAL_MS = 2_000;
const BUFF_BURST_INTERVAL_MS = 120;
const BUFF_BURST_LIFETIME_MS = 1_800;
const MAX_ACTIVE_BUFF_BURSTS = 8;
const MAX_PENDING_BUFF_BURSTS = 24;
const VIEWER_STORAGE_KEY = "upi_extract_viewer_id";
const LANG_STORAGE_KEY = "upi_extract_lang";
const CURRENT_JOB_STORAGE_KEY = "upi_extract_current_job";
const SUPPRESS_COMPLETED_AUTO_VIEW_STORAGE_KEY = "upi_extract_suppress_completed_auto_view";
const ENABLE_EXTRACT_DEBUG_LOGS = false;
const GUARD_QUERY_PARAM = "guard";
const GUARD_TTL_OPTIONS = [6, 12, 24, 48, 72] as const;
const SCAN_ORDER_PRICE = 0.6;
const MIN_SCAN_ORDER_QR_REMAINING_MS = 60 * 1000;
const PUBLIC_WITHDRAWAL_FEE = 0.01;
const PUBLIC_MIN_WITHDRAWAL_AMOUNT = 1.5;
const TASK_HISTORY_PAGE_SIZE = 10;
const NORMAL_USER_MAX_ACTIVE_EXTRACT_JOBS = 1;
const PREMIUM_USER_MAX_ACTIVE_EXTRACT_JOBS = 5;
const DEFAULT_EXTRACT_CAPACITY: ExtractCapacity = {
  public: { concurrency: 10, proxyCount: 0 },
  premium: { concurrency: 20, proxyCount: 0 },
};
type PublicDepositBaseAmount = 1.8 | 5 | 10;
const PROGRESS_STAGES: UpiProgressStage[] = [
  "validating",
  "checkout",
  "stripe_init",
  "stripe_confirm",
  "approval",
  "waiting_qr",
  "rendering_qr",
];

type ActivityStatus = "queued" | "running" | "completed" | "failed";
type ExtractChannel = "public" | "premium";
type PaymentExtractMethod = "upi" | "ideal";
const DEFAULT_PAYMENT_EXTRACT_METHOD: PaymentExtractMethod = "upi";
type Lang = "zh" | "en";
type ExtractMode = "token" | "guard";
type ExtractPageView = "extract" | "tasks";
type TaskHistoryFilter = "all" | "active" | "completed" | "failed";
type CardTransitionPhase = "idle" | "leaving" | "entering";
type UpiProgressStage =
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

type UpiExtractProgress = {
  stage: UpiProgressStage;
  percent: number;
  proxy?: string;
  attempt?: number;
  maxAttempts?: number;
  updatedAt?: string;
};

type UpiExtractDebugLogEntry = {
  seq: number;
  at: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  stage?: UpiProgressStage;
  percent?: number;
  proxy?: string;
  attempt?: number;
  maxAttempts?: number;
  details?: unknown;
};

type UpiExtractDebugLogsResponse = {
  jobId: string;
  logs: UpiExtractDebugLogEntry[];
};

type UpiExtractResult = {
  qrImageUrl: string;
  upiUri?: string;
  checkoutSessionId: string;
  processorEntity: string;
  paymentUrl: string;
  extractMethod?: PaymentExtractMethod;
  chatGptPaymentUrl?: string;
  stripeInstructionsUrl?: string;
  expiresAt: string;
  createdAt: string;
  accountEmail?: string | null;
  accountPhone?: string | null;
  guardCreateToken?: string;
  scanOrderCreateToken?: string;
  scanOrder?: PublicOrder;
  scanOrderError?: string;
};

type UpiExtractJob = {
  jobId: string;
  status: ActivityStatus;
  source?: "direct" | "storage";
  channel?: ExtractChannel;
  extractMethod?: PaymentExtractMethod;
  createdAt: string;
  updatedAt: string;
  progress?: UpiExtractProgress;
  result?: UpiExtractResult;
  error?: string;
  accountEmail?: string | null;
  accountPhone?: string | null;
  subscriptionPlan?: string | null;
  subscriptionIsPlus?: boolean | null;
  subscriptionCheckedAt?: string | null;
  subscriptionCheckError?: string | null;
  untilSuccess?: boolean;
  approvalParallelism?: number;
  retryCount?: number;
  cancelled?: boolean;
};

type SavedExtractJob = UpiExtractJob;

type UpiExtractActivity = {
  jobId: string;
  seq?: number;
  status: ActivityStatus;
  source?: "direct" | "storage";
  channel?: ExtractChannel;
  extractMethod?: PaymentExtractMethod;
  createdAt: string;
  updatedAt: string;
};

type CompactActivityStatus = "q" | "r" | "c" | "f";
type CompactActivityChannel = "p" | "m";
type CompactActivitySource = "d" | "s";
type CompactActivityItem = [
  seq: number,
  status: CompactActivityStatus,
  channel?: CompactActivityChannel,
  source?: CompactActivitySource,
  updatedAtSec?: number,
];

type ActivityCounts = Record<ActivityStatus, number>;
type ActivityCountsByChannel = Record<ExtractChannel, ActivityCounts>;

type ActivityResponse = {
  compact?: boolean;
  items: Array<UpiExtractActivity | CompactActivityItem>;
  counts: ActivityCounts;
  countsByChannel?: ActivityCountsByChannel;
  storageActiveCount?: number;
  paused?: boolean;
  channel?: ExtractChannel;
  capacity?: ExtractCapacity;
};

type CustomProxyRole = "checkout" | "provider";

type CustomProxyCheckResult = {
  ok: boolean;
  redactedUrl: string;
  ip?: string;
  country?: string;
  countryCode?: string;
  region?: string;
  city?: string;
  org?: string;
  latencyMs?: number;
  chatgptStatus?: number;
  stripeStatus?: number;
  error?: string;
  warnings?: string[];
};

type CustomProxyCheckResponse = {
  result: CustomProxyCheckResult;
};

type CustomProxyCheckState = Partial<Record<CustomProxyRole, {
  checking: boolean;
  result?: CustomProxyCheckResult;
  error?: string;
}>>;

type ExtractCapacity = Record<ExtractChannel, {
  concurrency: number;
  proxyCount: number;
}>;

type PresenceResponse = {
  count: number;
};

type PublicUserSession = {
  telegramUserId: string;
  telegramUsername?: string | null;
  displayName: string;
  isPremium?: boolean;
  premiumUntil?: string | null;
  premiumSource?: "manual" | "default" | "none";
  premiumTier?: "premium" | "premium_og" | "none";
};

type PublicUserPremiumInfo = {
  purchasePrice: number;
  saleEnabled: boolean;
  trialHours: number;
  trialClaimed: boolean;
  trialAvailable: boolean;
  trialClaimedAt?: string | null;
  trialPremiumUntil?: string | null;
};

type PublicUserWalletSummary = {
  availableBalance: number;
  frozenBalance: number;
  totalDeposited: number;
  totalSpent: number;
};

type PublicUserDepositAddressInfo = {
  configured: boolean;
  network: "BSC";
  chainId: 56;
  tokenSymbol: "USDT";
  tokenContract: string;
  confirmations: number;
  address?: string;
  message?: string;
};

type PublicUserDepositOrderInfo = {
  id: string;
  orderNo: string;
  baseAmount: number;
  payAmount: number;
  status: "PENDING" | "PAID" | "EXPIRED" | "CANCELLED";
  chain: string;
  tokenSymbol: string;
  depositAddress: string;
  txHash?: string | null;
  fromAddress?: string | null;
  blockNumber?: number | null;
  confirmations?: number | null;
  expiresAt: string;
  paidAt?: string | null;
  createdAt: string;
};

type PublicUserWithdrawalSummary = {
  id: string;
  amount: number;
  fee: number;
  totalFrozen: number;
  status: "PENDING" | "PAID" | "REJECTED" | "CANCELLED";
  chain: string;
  tokenSymbol: string;
  withdrawalAddress: string;
  requestedAt: string;
  processedAt?: string | null;
};

type PublicUserWalletHistoryItem = {
  id: string;
  type: string;
  availableDelta: number;
  frozenDelta: number;
  orderId?: string | null;
  referenceId?: string | null;
  note?: string | null;
  createdAt: string;
  withdrawal?: PublicUserWithdrawalSummary | null;
};

type PublicUserWithdrawalResponse = {
  withdrawal: PublicUserWithdrawalSummary;
  wallet: PublicUserWalletSummary;
  deposit: PublicUserDepositAddressInfo | null;
  depositOrder?: PublicUserDepositOrderInfo | null;
  walletHistory: PublicUserWalletHistoryItem[];
  fee: number;
};

type PublicUserDepositOrderResponse = {
  wallet: PublicUserWalletSummary;
  deposit: PublicUserDepositAddressInfo | null;
  depositOrder: PublicUserDepositOrderInfo | null;
  walletHistory: PublicUserWalletHistoryItem[];
};

type PublicUserCdkRedeemResponse = PublicUserResponse & {
  redeem: { code: string; amount: number; wallet: PublicUserWalletSummary };
};

type PublicUserResponse = {
  user: PublicUserSession | null;
  history?: UserExtractHistoryItem[];
  historyPagination?: TaskHistoryPagination;
  historyCounts?: TaskHistoryCounts;
  historyFilter?: TaskHistoryFilter;
  activeJobs?: UpiExtractJob[];
  settings?: PublicUserSettings;
  wallet?: PublicUserWalletSummary | null;
  deposit?: PublicUserDepositAddressInfo | null;
  depositOrder?: PublicUserDepositOrderInfo | null;
  walletHistory?: PublicUserWalletHistoryItem[];
  premium?: PublicUserPremiumInfo | null;
};

type PublicUserSettings = {
  successTgNotifyEnabled: boolean;
  autoRetryUntilSuccessEnabled: boolean;
  depositRiskSigned: boolean;
  depositRiskSignedAt: string | null;
};

const DEFAULT_PUBLIC_USER_SETTINGS: PublicUserSettings = {
  successTgNotifyEnabled: false,
  autoRetryUntilSuccessEnabled: false,
  depositRiskSigned: false,
  depositRiskSignedAt: null,
};

type UserExtractHistoryItem = {
  jobId: string;
  seq?: number;
  status: ActivityStatus;
  source?: "direct" | "storage";
  channel?: ExtractChannel;
  extractMethod?: PaymentExtractMethod;
  accountEmail?: string | null;
  accountPhone?: string | null;
  subscriptionPlan?: string | null;
  subscriptionIsPlus?: boolean | null;
  subscriptionCheckedAt?: string | null;
  subscriptionCheckError?: string | null;
  error?: string | null;
  resultPaymentUrl?: string | null;
  resultExpiresAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

type TaskHistoryCounts = Record<TaskHistoryFilter, number>;

type TaskHistoryPagination = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasPrev: boolean;
  hasNext: boolean;
  search?: string;
};

type LoginChallengeStatus = "PENDING" | "APPROVED" | "USED" | "EXPIRED";

type PublicLoginChallenge = {
  id: string;
  code: string;
  purpose: "user";
  status: LoginChallengeStatus;
  expiresAt: string;
};

type PublicLoginPollResponse = {
  status: LoginChallengeStatus;
  expiresAt?: string;
  redirectTo?: string;
};

type PublicSiteSettings = {
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

type BuffEvent = {
  seq: number;
  viewerId: string;
  createdAt: string;
};

type BuffStatsResponse = {
  buffCount: number;
  guideOpenCount: number;
  latestEventSeq: number;
  events: BuffEvent[];
};

type BuffBurst = {
  id: number;
  label: string;
  offset: number;
};

type UpiGuardInfo = {
  guardId: string;
  status: "ACTIVE" | "COMPLETED" | "EXPIRED" | "CANCELLED";
  expiresAt: string;
  useCount: number;
  createdAt: string;
  lastUsedAt?: string | null;
};

const EN_TEXT = {
    title: "QR Code Extractor",
    subtitle: "Paste your ChatGPT session token. The system will generate a UPI QR code in the background and return the ChatGPT payment link.",
    subtitleIdeal: "Paste your ChatGPT session token. The system will generate an IDEAL payment link QR in the background.",
    channelCapacityNote: (publicConcurrency: number, publicProxyCount: number, premiumConcurrency: number, premiumProxyCount: number) =>
      `Public channel: ${publicConcurrency} concurrent tasks, ${publicProxyCount} exit proxies · Premium channel: ${premiumConcurrency} concurrent tasks, ${premiumProxyCount} exit proxies`,
    channelCapacityLoading: "Loading channel capacity...",
    successTipsButton: "How to boost success?",
    giveBuff: "Buff everyone",
    buffTotal: "Global Buffs",
    buffReceived: "+1 Buff",
    buffFailedToast: "Buff launch failed. The luck engine jammed.",
    successTipsTitle: "Success-rate buff checklist",
    successTipsIntro: "Want the UPI QR to pop out nicely? Stack these buffs first:",
    successTipsOpenedPrefix: "This buff guide has been opened",
    successTipsOpenedSuffix: "times.",
    successTipsItems: ["Use a clean exit node. The cleaner the exit, the fewer suspicious looks.", "Refresh until the free trial offer appears. See the trial first, then charge in.", "Click the free trial, then on the subscription selection page you can see the option to change country."],
    successTipsFooter: "When all buffs are active, the rest is up to fate and the luck cat.",
    successTipsClose: "Got it, stacking buffs",
    storageInfoButton: "What is temporary storage?",
    storageInfoTitle: "What is temporary storage?",
    storageInfoIntro: "Temporary storage encrypts and stores this account session on the server for a limited time, then gives you a Storage ID.",
    storageInfoItems: ["Anyone with the Storage ID can regenerate a UPI QR code while it is valid.", "They cannot view the Session Token, account info, or other sensitive data.", "It is useful when a QR code expires, or when someone else needs to continue the payment flow.", "Storage lasts up to 3 days. You can finish and clear it manually, or it will expire automatically."],
    storageInfoFooter: "Normal extraction does not store the Session. The session is stored encrypted only when you create temporary storage.",
    storageInfoClose: "Got it",
    tokenMode: "New extraction",
    guardMode: "Storage reuse",
    publicChannel: "Public channel",
    premiumChannel: "Premium channel",
    paymentMethodTitle: "Extraction channel",
    upiMethod: "UPI channel",
    idealMethod: "IDEAL channel",
    upiMethodDesc: "Generate the existing India UPI QR code and payment link.",
    idealMethodDesc: "Generate a Netherlands iDEAL payment link QR when the account exposes iDEAL.",
    premiumBadge: "Premium",
    premiumUnlockedTitle: "Premium enabled",
    premiumUnlockedDesc: "Premium channel and auto retry are enabled.",
    premiumUntilLabel: "Valid until",
    premiumPermanent: "Lifetime",
    premiumConfirm: "Confirm",
    premiumManageTitle: "Premium benefits",
    premiumManageDesc: "Premium uses the higher-capacity channel and can auto-retry until success.",
    premiumBuyLifetime: (price: number) => `Buy Premium · ${formatCompactU(price)} lifetime`,
    premiumBuying: "Activating...",
    premiumBuySuccess: "Lifetime Premium enabled.",
    premiumBuyInsufficient: (price: number) => `Insufficient balance. Lifetime Premium requires ${formatUsdt(price)}.`,
    premiumSaleDisabled: "Premium purchase is currently unavailable.",
    premiumTrialOneDay: "Free 1-day trial",
    premiumTrialClaimed: "Free trial already claimed",
    premiumTrialClaiming: "Claiming...",
    premiumTrialSuccess: "1-day Premium trial enabled.",
    premiumActiveHint: "Premium is active for this account.",
    premiumTrialHint: "Each Telegram account can claim the free trial once.",
    scannerApply: "Apply as Scanner",
    premiumOnlyHint: "Premium channel has its own queue, concurrent workers, and a separate heatmap.",
    premiumLoginHint: "You can view the Premium channel. Submitting Premium jobs requires a Premium account.",
    premiumSubmitBlocked: "Premium channel is view-only for the current account. Sign in with a Premium account to submit.",
    untilSuccess: "Auto retry until success",
    untilSuccessDesc: "Premium only. When enabled, failed extraction attempts keep retrying until a QR code is generated or you cancel it manually.",
    untilSuccessCancel: "Cancel retry",
    untilSuccessCancelling: "Cancelling...",
    untilSuccessCancelled: "Retry task cancelled.",
    untilSuccessRetryCount: (count: number) => `Retried ${count} time${count === 1 ? "" : "s"}`,
    untilSuccessLastError: "Last failure",
    normalTaskLimitHint: "A normal account can run 1 extraction task at a time. Please wait for the current task to finish or cancel it.",
    premiumTaskLimitHint: `A Premium account can run up to ${PREMIUM_USER_MAX_ACTIVE_EXTRACT_JOBS} extraction tasks at a time. Please wait for existing tasks to finish or cancel them.`,
    cancelTask: "Cancel task",
    cancellingTask: "Cancelling...",
    cancelTaskFailed: "Task could not be cancelled. Please refresh and try again.",
    extractView: "Extract",
    tasksView: "Tasks",
    taskListTitle: "Extraction tasks",
    taskListDesc: "Logged-in tasks are restored by your Telegram account.",
    taskListEmpty: "No extraction tasks yet.",
    taskView: "View",
    taskRetrying: "Retrying until success",
    taskFilterAll: "All",
    taskFilterActive: "Active",
    taskFilterCompleted: "Success",
    taskFilterFailed: "Failed",
    taskPageSummary: (page: number, totalPages: number, total: number, pageSize: number) => `Page ${page} / ${totalPages}, ${total} total, ${pageSize} per page`,
    taskPrevPage: "Previous",
    taskNextPage: "Next",
    accountContact: "Account",
    accountEmail: "Email",
    accountPhone: "Phone",
    accountSubscription: "Subscription",
    subscriptionPlus: "Plus",
    subscriptionFree: "Free",
    subscriptionUnknown: "Unknown",
    subscriptionPlanLabel: (plan: string) => `Plan: ${plan || "unknown"}`,
    subscriptionCheckedAt: (value: string) => `Checked ${value}`,
    subscriptionCheckAction: "Check subscription",
    subscriptionCheckQuick: "Check",
    subscriptionChecking: "Checking...",
    subscriptionCheckSuccess: (plan: string) => `Subscription checked: ${plan || "unknown"}`,
    subscriptionCheckFailed: "Subscription check failed",
    subscriptionCheckCooldown: "Please wait a few seconds before checking again.",
    subscriptionCheckUnavailable: "This task no longer has temporary session data for checking. Please submit a new extraction if needed.",
    premiumRunning: "Premium running",
    sessionTitle: "Session Token",
    guardInputTitle: "Storage ID",
    privacyTitle: "Privacy Notice",
    faqButton: "FAQ",
    faqTitle: "Frequently asked questions",
    faqEmpty: "No FAQ yet.",
    privacyText: "We process data only as needed for UPI extraction, scan orders, and wallet crediting.",
    privacyItems: ["Session Tokens / cookies are used only for the current background extraction by default. They are not stored as history, and are not shown or returned after the task finishes.", "After login, we store task status, time, channel, result summary, and the email or phone number recognized from the account session so you can identify your own tasks.", "If you publish a scan order, the generated QR code, payment link, expiry time, and order status are stored so a worker can scan it.", "Wallet deposits record only the BSC deposit address, transaction hash, amount, confirmations, and balance ledger for automatic crediting and reconciliation.", "Do not submit unrelated passwords, private keys, seed phrases, or other sensitive information."],
    howTitle: "How to get the Session Token",
    step1Prefix: "1. Open",
    step1Suffix: "in your browser and log in to the account you want to extract.",
    step2: "2. Open the session page, copy everything shown on the page, and paste it below.",
    copySessionUrl: "Copy session page URL",
    sessionUrlCopied: "Session page URL copied.",
    tokenPlaceholder: "Paste session token / Cookie / Session JSON",
    guardPlaceholder: "Enter guard_xxxxxxxxxxxxxxxxxx",
    guardDescription: "Enter a shared Storage ID to regenerate a UPI QR code with the temporarily stored account. You cannot view account info or the Session Token.",
    needGuardId: "Please enter the Storage ID first.",
    submit: "Extract UPI QR Code",
    submitIdeal: "Extract IDEAL payment QR",
    submitGuard: "Extract with Storage ID",
    submitting: "Extracting in background...",
    copyFailed: "Copy failed. Please copy manually.",
    needToken: "Please paste the session token first.",
    mockSubmitting: "Starting a mock background extraction...",
    realSubmitting: "Submitting background extraction task...",
    mockRunning: "Mock extraction is running and generating the QR code...",
    submitted: "Task submitted. Generating the UPI QR code in the background...",
    submittedIdeal: "Task submitted. Generating the IDEAL payment QR in the background...",
    successToast: "UPI QR code extracted successfully.",
    successToastIdeal: "IDEAL payment QR extracted successfully.",
    failedToast: "UPI QR code extraction failed",
    failedToastIdeal: "IDEAL payment QR extraction failed",
    failedTitle: "Extraction failed",
    failedDesc: "This task did not generate a QR code. Try another account or node and extract again.",
    failedReasonApproveBlocked: "The Approve step is temporarily blocked. Please retry later or switch account/exit node.",
    failedReasonProxy: "Available exit nodes are failing. Please check the proxy pool or retry later.",
    failedReasonNoQr: "No UPI data was returned by the payment response. Please retry later or switch account/exit node.",
    failedReasonBillingCountry: "This account's region is locked by OpenAI, so the billing country cannot be changed.",
    failedReasonInvalidSession: "No valid session token / session cookie / session JSON was recognized.",
    failedReasonNoFreeTrial: "This account does not have the free trial offer. Please use another account.",
    failedReasonPaymentMethodUnavailable: "This account cannot create this payment method. Please switch account and try again.",
    failedReasonGeneric: "UPI QR code generation failed. Please retry later or switch account/exit node.",
    failedReasonGenericIdeal: "IDEAL payment link generation failed. Please retry later or switch account/exit node.",
    restoringTitle: "Restoring task state",
    restoringDesc: "Reading the last extraction task...",
    polling: (seconds: number) => `Background extraction running, waited ${seconds}s...`,
    maintenanceTitle: "Maintenance in progress",
    maintenanceDesc: "The extraction service is currently under maintenance. New extraction requests are temporarily unavailable. Existing submitted jobs can continue waiting for results.",
    resultTitle: "Extraction successful",
    resultTitleIdeal: "IDEAL extraction successful",
    qrRemaining: "QR code expires in: ",
    openPayment: "Open ChatGPT payment link",
    openPaymentIdeal: "Open IDEAL payment link",
    copyPayment: "Copy payment link",
    paymentCopied: "ChatGPT payment link copied.",
    paymentCopiedIdeal: "IDEAL payment link copied.",
    upiContent: "UPI protocol data",
    idealContent: "IDEAL payment link",
    newExtraction: "Extract a new UPI link",
    newIdealExtraction: "Extract a new IDEAL link",
    guardPanelTitle: "Enable temporary storage",
    guardPanelDesc: "After creating temporary storage, the system temporarily stores this account session encrypted. Anyone with the Storage ID can only regenerate the QR code.",
    guardStorageNotice: "The data is temporarily stored on the server until you finish and clear it or it expires automatically, up to 3 days.",
    guardTtlLabel: "Storage time",
    guardTtlHours: (hours: number) => hours >= 24 ? `${hours / 24} day${hours >= 48 ? "s" : ""}` : `${hours} hours`,
    createGuard: "Generate and copy Storage ID",
    creatingGuard: "Creating storage...",
    guardCreateUnavailable: "This result cannot create temporary storage. Please extract again.",
    guardCreated: "Storage ID generated and copied.",
    guardIdLabel: "Storage ID",
    guardExpiresAt: "Expires at",
    guardUseCount: "Reuse count",
    copyGuardId: "Copy ID",
    copyGuardLink: "Copy link",
    guardIdCopied: "Storage ID copied.",
    guardLinkCopied: "Storage link copied.",
    activeGuardTitle: "Current storage",
    completeGuard: "Finish and clear storage",
    completingGuard: "Clearing...",
    guardCompleted: "Storage finished and cleared.",
    guardCompletedState: "Finished and cleared",
    onlineLabel: "Online on this page",
    tgGroup: "TG Group",
    accountLogin: "Account login",
    accountLoggedIn: "Logged in",
    walletBadge: "Wallet",
    accountLogout: "Log out",
    loginTitle: "Telegram account login",
    loginDesc: "Sign in to this page with your Telegram account.",
    loginOpeningBot: "Opening Telegram Bot...",
    loginWaiting: "Waiting for you to confirm in the Telegram Bot.",
    loginApproved: "Telegram confirmed. Signing in...",
    loginExpired: "The login code expired. Please get a new one.",
    loginCodeLabel: "One-time login code",
    loginOpenBot: "Open Bot to login",
    loginCopyCommand: "Copy command",
    loginNewCode: "New code",
    loginManualTip: "If Telegram does not send automatically, tap Start in the Bot chat or manually send the command above.",
    loginCopied: "Login command copied.",
    loginSuccess: "Account logged in.",
    loginFailed: "Account login failed",
    logoutSuccess: "Logged out.",
    accountHistoryTitle: "Extraction history",
    accountHistoryEmpty: "Tasks submitted after login will appear here.",
    accountHistoryHint: "History stores task status only; it does not store Session Tokens.",
    successTgNotify: "Telegram extraction result notice",
    successTgNotifyDesc: "When enabled, the bot sends a result notice after a background extraction succeeds or fails. Successful notices include the QR image and payment link, but never include the Session Token or UPI data.",
    autoPublishScanOrder: "Auto-publish scan order after QR is generated",
    autoPublishScanOrderDesc: "Price: 0.6 USDT. The balance is frozen when the order is published, and refunded if the worker reports an issue or the QR expires.",
    customProxyTitle: "Custom proxies",
    customProxyDesc: "Optional. Checkout is used for session validation and creating the ChatGPT checkout; Provider is used for Stripe/payment-provider steps and approval after checkout.",
    approvalParallelismLabel: "Approve parallelism",
    approvalParallelismDesc: "Default 1. When greater than 1, multiple approve requests are sent in parallel; as soon as any one is approved, extraction continues.",
    customCheckoutProxy: "Checkout proxy",
    customProviderProxy: "Provider proxy",
    customProxyPlaceholder: "socks5://user:pass@host:port or host:port:user:pass",
    customProxyCheck: "Check exit",
    customProxyChecking: "Checking...",
    customProxyExit: (ip: string, country: string, latency: number) => `Exit ${ip || "-"} \u00b7 ${country || "unknown"} \u00b7 ${latency || 0}ms`,
    customProxyOk: "Proxy reachable",
    customProxyFailed: "Proxy check failed",
    customProxyNeedInput: "Please enter a proxy first.",
    scanOrderTitle: "Scan order",
    scanOrderDesc: "If auto-publish is off, you can manually publish the generated QR for an online worker to scan.",
    scanOrderSent: "Scan order sent",
    scanOrderStatus: "Order status",
    scanOrderPending: "Waiting for worker",
    scanOrderAssigned: "Worker accepted",
    scanOrderChecking: "Checking subscription",
    scanOrderCompleted: "Order completed",
    scanOrderFailed: "Order failed. Funds refunded.",
    scanOrderCancelled: "Order cancelled. Funds refunded.",
    scanOrderExpired: "QR expired. Funds refunded.",
    scanOrderCancel: "Cancel scan order",
    scanOrderCancelling: "Cancelling...",
    scanOrderCancelledToast: "Scan order cancelled and funds refunded.",
    publishScanOrder: "Publish scan order · 0.6U",
    scanOrderPublishing: "Publishing scan order...",
    scanOrderPublished: "Scan order published",
    scanOrderPublishedWithNo: (orderNo: string) => `Scan order published: ${orderNo}`,
    scanOrderPublishFailed: "Failed to publish scan order",
    scanOrderUnavailable: "This QR does not have an available publish token. Please extract again.",
    scanOrderLoginRequired: "Please log in with Telegram before publishing a scan order.",
    scanOrderInsufficientBalance: "Insufficient balance. Publishing a scan order requires 0.6 USDT.",
    scanOrderAlmostExpired: "1 minute or less remains on this QR. Please extract a new QR before publishing a scan order.",
    scanOrderAutoPending: "Auto-publish was enabled, but the order status is not available yet. Refresh the account or check the worker hall later.",
    notifySettingSaved: "Settings saved.",
    depositTitle: "USDT-BEP20 deposit",
    depositDesc: "Only BSC / BEP20 USDT is supported.",
    depositAddressLabel: "Deposit address",
    depositCopyAddress: "Copy address",
    depositAddressQr: "QR code",
    depositAddressQrTitle: "Deposit address QR code",
    depositAddressQrDesc: "Scan this QR code to fill the BSC / BEP20 USDT deposit address.",
    depositAddressQrGenerating: "Generating QR code...",
    depositAddressCopied: "Deposit address copied.",
    depositUnavailable: "On-chain deposit is not configured yet. Please try again later.",
    depositWarning: "Do not send non-BEP20-USDT assets to this address.",
    depositExactAmountWarning: "The wallet is credited by the actual on-chain amount received. Network/platform fees may mean you need to pay slightly more. If you send a wrong amount, it may complete another user's deposit order and cannot be refunded or manually credited.",
    depositWarningDialogTitle: "Confirm before depositing",
    depositWarningDialogDesc: "Deposit orders are matched only by the actual BSC / BEP20 USDT amount received on-chain, not by the amount you intended to send.",
    depositWarningDialogFeeTitle: "Fees can change the received amount",
    depositWarningDialogFeeDesc: "Some exchanges or wallets deduct fees from the transfer amount. If the received amount is lower than the order amount, the deposit will not match. Please make sure the final on-chain received amount is exactly the payment amount shown here; you may need to send slightly more, for example +0.01 USDT.",
    depositWarningDialogNoRefundTitle: "Wrong amounts are final",
    depositWarningDialogNoRefundDesc: "If you send the wrong amount, it may be matched to another user's deposit order. Wrong transfer amounts are not refundable and will not be manually credited.",
    depositWarningDialogNoExcuseDesc: "If the amount is wrong, please do not argue that you paid something or that we received the money. We only match exact on-chain received amounts; wrong amounts are not refunded or reissued.",
    depositWarningDialogAsset: "Only send BSC / BEP20 USDT. Other chains or assets may be lost.",
    depositWarningAgreement: "I have fully read, understood, and agree to the notice above",
    depositWarningNoticeTitle: "Deposit risk notice",
    depositWarningSignedBadge: "Signed",
    depositWarningUnsignedBadge: "Not signed",
    depositWarningNoticeHint: "This notice stays visible in the wallet so you can review the exact-amount rule before every deposit.",
    depositWarningExpand: "View details",
    depositWarningCollapse: "Collapse",
    depositWarningCancel: "Cancel",
    depositWarningConfirm: "I understand, continue",
    depositWarningCountdown: (seconds: number) => `Continue in ${seconds}s`,
    depositChooseAmount: "Choose a deposit amount. The system will create a 20-minute unique payment amount.",
    depositDisabled: "Deposit is temporarily closed. Please try again later.",
    cdkRedeemAction: "Redeem CDK",
    cdkRedeemTitle: "Recharge CDK",
    cdkRedeemDesc: "Enter a recharge CDK issued by the admin. Your balance is credited immediately after redemption.",
    cdkRedeemPlaceholder: "Enter upi_xxxxxxxxxxxxxxxx",
    cdkRedeemSubmit: "Redeem balance",
    cdkRedeemSubmitting: "Redeeming...",
    cdkRedeemNeedCode: "Please enter the CDK.",
    cdkRedeemSuccess: (amount: number) => `CDK redeemed. ${formatUsdt(amount)} credited.`,
    walletLedgerCdkRedeem: "CDK redemption",
    depositCreate18: "Deposit 1.8 USDT",
    depositCreate5: "Deposit 5 USDT",
    depositCreate10: "Deposit 10 USDT",
    depositCreating: "Creating deposit order...",
    depositOrderTitle: "Deposit order",
    depositOrderNo: "Order No.",
    depositPayAmount: "Pay amount",
    depositOrderExpiresIn: (seconds: number) => `${formatDuration(seconds)} left`,
    depositOrderExpired: "This deposit order has expired. Please create a new one.",
    depositOrderPaid: "Credited",
    depositOrderPending: "Pending payment",
    depositOrderExpiredStatus: "Expired",
    depositCopyAmount: "Copy amount",
    depositAmountCopied: "Payment amount copied.",
    depositOrderHint: "Send BSC / BEP20 USDT to the unified address below, and make sure the actual on-chain amount exactly matches the payment amount shown here. Create a new order after timeout.",
    depositCreateNew: "Create new deposit order",
    walletDepositAction: "Deposit",
    walletWithdrawAction: "Withdraw",
    walletRefreshAction: "Refresh balance",
    walletRefreshSuccess: "Balance refreshed.",
    walletRefreshFailed: "Failed to refresh balance.",
    walletFrozen: "Frozen",
    walletWithdrawTitle: "USDT-BEP20 withdrawal",
    walletWithdrawDesc: "After submitting, the withdrawal amount and a 0.01 USDT fee will be frozen. Admin will process the BEP20-USDT payout.",
    walletWithdrawAmount: "Withdrawal amount",
    walletWithdrawAddress: "Withdrawal address",
    walletWithdrawAddressPlaceholder: "BSC / BEP20 USDT address",
    walletWithdrawFee: "Fee",
    walletWithdrawTotal: "Total frozen",
    walletWithdrawSubmit: "Request withdrawal",
    walletWithdrawSubmitting: "Submitting...",
    walletWithdrawNeedAmount: "Enter a valid withdrawal amount.",
    walletWithdrawMinAmount: "Minimum withdrawal amount is 1.50 USDT.",
    walletWithdrawNeedAddress: "Enter the withdrawal address.",
    walletWithdrawMax: "Max",
    walletWithdrawExceedBalance: "The withdrawal amount exceeds your available balance. Please reserve the 0.01 USDT fee.",
    walletWithdrawSuccess: "Withdrawal request submitted.",
    walletWithdrawDisabled: "Withdrawal is currently unavailable.",
    walletLedgerTitle: "Order history",
    walletLedgerHint: "Wallet activity for deposits, withdrawals, scan-order freezes, refunds and payments.",
    walletLedgerEmpty: "No wallet activity yet.",
    walletLedgerDeposit: "Deposit credited",
    walletLedgerWithdrawFreeze: "Withdrawal requested",
    walletLedgerWithdrawRefund: "Withdrawal refunded",
    walletLedgerWithdrawPaid: "Withdrawal paid",
    walletLedgerScanFreeze: "Scan order frozen",
    walletLedgerScanRefund: "Scan order refunded",
    walletLedgerScanSpend: "Scan order paid",
    walletLedgerPremiumPurchase: "Premium purchase",
    walletLedgerAdjustment: "Balance adjustment",
    walletLedgerFrozenAmount: "Frozen",
    walletLedgerPending: "Pending",
    walletLedgerPaid: "Processed",
    walletLedgerRejected: "Rejected",
    walletLedgerCancelled: "Cancelled",
    success: "Success",
    queued: "Queued",
    running: "Running",
    storageActive: "Stored",
    failed: "Failed",
    expired: "Expired",
    elapsed: (seconds: number) => `Waited ${seconds}s`,
    progressTitle: "Extraction progress",
    progressPercent: "Progress",
    debugLogsTitle: "Local extraction logs",
    debugLogsDesc: "Visible only in local-test mode. Session tokens are not printed.",
    debugLogsEmpty: "Waiting for logs...",
    debugLogsRefresh: "Refresh logs",
    debugLogsError: "Failed to load logs",
    debugLogsDetails: "details",
    stageLabels: {
      queued: "Preparing",
      validating: "Verify account",
      checkout: "Create Checkout",
      stripe_init: "Initialize payment",
      stripe_confirm: "Confirm UPI",
      approval: "Approve stage",
      waiting_qr: "Wait for QR",
      hydrating: "Parse QR data",
      rendering_qr: "Render image",
      completed: "Done",
      retrying: "Retrying exit"
    },

} as const;

const ZH_TEXT: Record<string, unknown> = {
  title: "公益二维码提取",
  subtitle: "粘贴 ChatGPT Session Token，系统会在后台生成 UPI 二维码并返回支付链接。",
  subtitleIdeal: "粘贴 ChatGPT Session Token，系统会在后台生成 IDEAL 支付链接二维码。",
  channelCapacityNote: (publicConcurrency: number, publicProxyCount: number, premiumConcurrency: number, premiumProxyCount: number) =>
    `公共通道：${publicConcurrency} 个并发，${publicProxyCount} 个出口代理 · Premium 通道：${premiumConcurrency} 个并发，${premiumProxyCount} 个出口代理`,
  channelCapacityLoading: "正在读取通道容量...",
  successTipsButton: "如何提高成功率？",
  giveBuff: "给所有人加 Buff",
  buffTotal: "全站 Buff",
  buffReceived: "+1 Buff",
  buffFailedToast: "Buff 发射失败，玄学引擎卡住了。",
  successTipsTitle: "成功率 Buff 叠加指南",
  successTipsIntro: "想让 UPI 二维码更听话？先把这些 Buff 叠上：",
  successTipsOpenedPrefix: "这个 Buff 指南已经被打开",
  successTipsOpenedSuffix: "次。",
  successTipsItems: ["使用干净稳定的出口节点，越干净越不容易被盯上。", "刷出免费试用入口，先看到试用再冲。", "点击免费试用，在选择订阅界面可以看到更改国家选项。"],
  successTipsFooter: "以上都满足后，剩下的看天意和招财猫心情。",
  successTipsClose: "懂了，去叠 Buff",
  storageInfoButton: "什么是暂存？",
  storageInfoTitle: "什么是暂存？",
  storageInfoIntro: "暂存会把本次账号会话加密保存到服务器一段时间，并生成一个暂存 ID。",
  storageInfoItems: ["拿到暂存 ID 的人可以在有效期内重新生成 UPI 二维码。", "对方看不到 Session Token、账号信息或其它敏感数据。", "适合二维码过期后重新生成，或让别人继续当前支付流程。", "暂存最长 3 天。你可以手动完成并清除，到期也会自动失效。"],
  storageInfoFooter: "普通提取默认不保存 Session；只有你主动创建暂存时才会加密暂存。",
  storageInfoClose: "知道了",
  tokenMode: "新提取",
  guardMode: "暂存复用",
  publicChannel: "公共通道",
  premiumChannel: "Premium 通道",
  paymentMethodTitle: "提取渠道",
  upiMethod: "UPI 渠道",
  idealMethod: "IDEAL 渠道",
  upiMethodDesc: "沿用当前印度 UPI 二维码和支付链接提取流程。",
  idealMethodDesc: "当账号支持荷兰 iDEAL 时，生成 iDEAL 支付链接二维码。",
  premiumBadge: "Premium",
  premiumUnlockedTitle: "已启用 Premium",
  premiumUnlockedDesc: "Premium 通道和自动重试已开启。",
  premiumUntilLabel: "有效期",
  premiumPermanent: "长期有效",
  premiumConfirm: "确认",
  premiumManageTitle: "Premium 权益",
  premiumManageDesc: "Premium 可使用更高并发通道，并开启自动重试直到成功。",
  premiumBuyLifetime: (price: number) => `购买 Premium · ${formatCompactU(price)} 长期`,
  premiumBuying: "正在开通...",
  premiumBuySuccess: "Premium 长期权益已开通。",
  premiumBuyInsufficient: (price: number) => `余额不足，购买长期 Premium 需要 ${formatUsdt(price)}。`,
  premiumSaleDisabled: "Premium 暂未开放购买",
  premiumTrialOneDay: "免费体验 1 天",
  premiumTrialClaimed: "已领取过免费体验",
  premiumTrialClaiming: "正在领取...",
  premiumTrialSuccess: "已领取 1 天 Premium 体验。",
  premiumActiveHint: "当前账号已启用 Premium。",
  premiumTrialHint: "每个 Telegram 账号只能领取一次免费体验。",
  scannerApply: "申请成为 Scanner",
  premiumOnlyHint: "Premium 通道拥有独立队列、并发和热力图。",
  premiumLoginHint: "你可以查看 Premium 通道，提交 Premium 任务需要 Premium 账号。",
  premiumSubmitBlocked: "当前账号只能查看 Premium 通道，登录 Premium 账号后才能提交。",
  untilSuccess: "自动重试直到成功",
  untilSuccessDesc: "Premium 专属。开启后，提取失败会自动继续重试，直到生成二维码或你手动取消。",
  untilSuccessCancel: "取消重试",
  untilSuccessCancelling: "正在取消...",
  untilSuccessCancelled: "重试任务已取消。",
  untilSuccessRetryCount: (count: number) => `已重试 ${count} 次`,
  untilSuccessLastError: "上次失败",
  normalTaskLimitHint: "普通账号同时只能进行 1 个提取任务，请等待当前任务完成或取消。",
  premiumTaskLimitHint: `Premium 账号最多同时进行 ${PREMIUM_USER_MAX_ACTIVE_EXTRACT_JOBS} 个提取任务，请等待已有任务完成或取消。`,
  cancelTask: "取消任务",
  cancellingTask: "正在取消...",
  cancelTaskFailed: "\u4efb\u52a1\u53d6\u6d88\u5931\u8d25\uff0c\u8bf7\u5237\u65b0\u540e\u91cd\u8bd5\u3002",
  extractView: "提取",
  tasksView: "任务列表",
  taskListTitle: "提取任务",
  taskListDesc: "登录后，任务会按你的 Telegram 账号恢复。",
  taskListEmpty: "还没有提取任务。",
  taskView: "查看",
  taskRetrying: "正在直到成功",
  taskFilterAll: "全部",
  taskFilterActive: "进行中",
  taskFilterCompleted: "成功",
  taskFilterFailed: "失败",
  taskPageSummary: (page: number, totalPages: number, total: number, pageSize: number) => `第 ${page} / ${totalPages} 页，共 ${total} 条，每页 ${pageSize} 条`,
  taskPrevPage: "上一页",
  taskNextPage: "下一页",
  accountContact: "账号",
  accountEmail: "邮箱",
  accountPhone: "手机号",
  accountSubscription: "订阅",
  subscriptionPlus: "Plus",
  subscriptionFree: "Free",
  subscriptionUnknown: "未知",
  subscriptionPlanLabel: (plan: string) => `套餐：${plan || "unknown"}`,
  subscriptionCheckedAt: (value: string) => `检测于 ${value}`,
  subscriptionCheckAction: "检测账号订阅",
  subscriptionCheckQuick: "检测",
  subscriptionChecking: "检测中...",
  subscriptionCheckSuccess: (plan: string) => `订阅检测完成：${plan || "unknown"}`,
  subscriptionCheckFailed: "订阅检测失败",
  subscriptionCheckCooldown: "请间隔几秒后再检测。",
  subscriptionCheckUnavailable: "该任务已没有可用于检测的临时会话数据，如需检测请重新提交提取。",
  premiumRunning: "Premium 进行中",
  sessionTitle: "Session Token",
  guardInputTitle: "暂存 ID",
  privacyTitle: "隐私说明",
  faqButton: "常见问题",
  faqTitle: "常见问题",
  faqEmpty: "暂无常见问题。",
  privacyText: "我们只在 UPI 提取、扫码订单和钱包入账所需范围内处理数据。",
  privacyItems: ["Session Token / Cookie 默认仅用于本次后台提取；任务结束后不作为历史保存，也不会再展示或返回。", "登录后会保存任务状态、时间、通道、结果摘要，以及从账号会话识别到的邮箱或手机号，方便你查询自己的任务。", "发布扫码订单时，会保存生成的二维码、支付链接、过期时间和订单状态，供接单方扫码处理。", "钱包充值只记录 BSC 充值地址、交易哈希、金额、确认数和余额账本，用于自动入账与对账。", "请不要提交无关密码、私钥、助记词或其它敏感信息。"],
  howTitle: "如何获取 Session Token",
  step1Prefix: "1. 在浏览器打开",
  step1Suffix: "并登录需要提取的账号。",
  step2: "2. 打开 session 页面后，复制页面里显示的全部内容并粘贴到下方。",
  copySessionUrl: "复制 session 页面地址",
  sessionUrlCopied: "session 页面地址已复制。",
  tokenPlaceholder: "粘贴 session token / Cookie / Session JSON",
  guardPlaceholder: "输入 guard_xxxxxxxxxxxxxxxxxx",
  guardDescription: "输入共享的暂存 ID 后，可以用暂存账号重新生成 UPI 二维码；你无法查看账号信息或 Session Token。",
  needGuardId: "请先输入暂存 ID。",
  submit: "提取 UPI 二维码",
  submitIdeal: "提取 IDEAL 支付二维码",
  submitGuard: "使用暂存 ID 提取",
  submitting: "正在后台提取...",
  copyFailed: "复制失败，请手动复制。",
  needToken: "请先粘贴 Session Token。",
  mockSubmitting: "正在启动模拟后台提取...",
  realSubmitting: "正在提交后台提取任务...",
  mockRunning: "模拟提取正在生成二维码...",
  submitted: "任务已提交，正在后台生成 UPI 二维码...",
  submittedIdeal: "任务已提交，正在后台生成 IDEAL 支付二维码...",
  successToast: "UPI 二维码提取成功。",
  successToastIdeal: "IDEAL 支付二维码提取成功。",
  failedToast: "UPI 二维码提取失败",
  failedToastIdeal: "IDEAL 支付二维码提取失败",
  failedTitle: "提取失败",
  failedDesc: "本次任务没有生成二维码，请更换账号或节点后重试。",
  failedReasonApproveBlocked: "Approve 阶段暂时被阻止，请稍后重试或更换账号/出口。",
  failedReasonProxy: "可用出口节点异常，请检查代理池或稍后重试。",
  failedReasonNoQr: "支付响应未返回 UPI 数据，请稍后重试或更换账号/出口。",
  failedReasonBillingCountry: "该账号地区已被 OpenAI 锁定，无法更改账单国家。",
  failedReasonInvalidSession: "没有识别到有效的 session token / session cookie / session JSON。",
  failedReasonNoFreeTrial: "该账号没有免费试用，请更换账号。",
  failedReasonPaymentMethodUnavailable: "该账号无法创建当前渠道的支付，请更换账号重试。",
  failedReasonGeneric: "UPI 二维码生成失败，请稍后重试或更换账号/出口。",
  failedReasonGenericIdeal: "IDEAL 支付链接生成失败，请稍后重试或更换账号/出口。",
  restoringTitle: "正在恢复任务状态",
  restoringDesc: "正在读取上一次提取任务...",
  polling: (seconds: number) => `后台提取中，已等待 ${seconds} 秒...`,
  maintenanceTitle: "正在维护升级",
  maintenanceDesc: "提取服务正在维护中，暂时无法提交新的提取请求；已提交的任务可以继续等待结果。",
  resultTitle: "提取成功",
  resultTitleIdeal: "IDEAL 提取成功",
  qrRemaining: "二维码剩余有效期：",
  openPayment: "打开支付链接",
  openPaymentIdeal: "打开 IDEAL 支付链接",
  copyPayment: "复制支付链接",
  paymentCopied: "支付链接已复制。",
  paymentCopiedIdeal: "IDEAL 支付链接已复制。",
  upiContent: "UPI 协议内容",
  idealContent: "IDEAL 支付链接",
  newExtraction: "提取新的 UPI 链接",
  newIdealExtraction: "提取新的 IDEAL 链接",
  guardPanelTitle: "开启暂存",
  guardPanelDesc: "创建暂存后，系统会加密暂存本账号会话；拿到暂存 ID 的人只能重新生成二维码。",
  guardStorageNotice: "数据会暂存在服务器，直到你手动完成并清除，或到期自动失效，最长 3 天。",
  guardTtlLabel: "暂存时间",
  guardTtlHours: (hours: number) => hours >= 24 ? `${hours / 24} 天` : `${hours} 小时`,
  createGuard: "生成并复制暂存 ID",
  creatingGuard: "正在创建暂存...",
  guardCreateUnavailable: "当前结果无法创建暂存，请重新提取。",
  guardCreated: "暂存 ID 已生成并复制。",
  guardIdLabel: "暂存 ID",
  guardExpiresAt: "过期时间",
  guardUseCount: "复用次数",
  copyGuardId: "复制 ID",
  copyGuardLink: "复制链接",
  guardIdCopied: "暂存 ID 已复制。",
  guardLinkCopied: "暂存链接已复制。",
  activeGuardTitle: "当前暂存",
  completeGuard: "完成并清除暂存",
  completingGuard: "正在清除...",
  guardCompleted: "暂存已完成并清除。",
  guardCompletedState: "已完成并清除",
  onlineLabel: "当前页面在线",
  tgGroup: "TG 群组",
  accountLogin: "账户登录",
  accountLoggedIn: "已登录",
  walletBadge: "钱包",
  accountLogout: "退出登录",
  loginTitle: "Telegram 账户登录",
  loginDesc: "使用 Telegram 账户登录本页面。",
  loginOpeningBot: "正在打开 Telegram Bot...",
  loginWaiting: "等待你在 Telegram Bot 中确认。",
  loginApproved: "Telegram 已确认，正在登录...",
  loginExpired: "登录码已过期，请重新获取。",
  loginCodeLabel: "一次性登录码",
  loginOpenBot: "打开 Bot 登录",
  loginCopyCommand: "复制命令",
  loginNewCode: "新的登录码",
  loginManualTip: "如果 Telegram 没有自动发送，请在 Bot 聊天中点击 Start，或手动发送上方命令。",
  loginCopied: "登录命令已复制。",
  loginSuccess: "账户已登录。",
  loginFailed: "账户登录失败",
  logoutSuccess: "已退出登录。",
  accountHistoryTitle: "提取历史",
  accountHistoryEmpty: "登录后提交的任务会显示在这里。",
  accountHistoryHint: "历史只保存任务状态，不保存 Session Token。",
  successTgNotify: "Telegram 提取结果通知",
  successTgNotifyDesc: "开启后，后台提取成功或失败都会通过 Bot 通知你；成功时会附带二维码图片和支付链接，但不包含 Session Token 或 UPI 数据。",
  autoPublishScanOrder: "二维码生成后自动发布扫码订单",
  autoPublishScanOrderDesc: "价格：0.6 USDT。发布订单时冻结余额；接单方反馈问题或二维码过期时退回。",
  customProxyTitle: "\u81ea\u5b9a\u4e49\u4ee3\u7406",
  customProxyDesc: "\u53ef\u9009\u3002Checkout \u4ee3\u7406\u7528\u4e8e\u9a8c\u8bc1 session \u548c\u521b\u5efa ChatGPT checkout\uff1bProvider \u4ee3\u7406\u7528\u4e8e checkout \u4e4b\u540e\u7684 Stripe/\u652f\u4ed8\u63d0\u4f9b\u65b9\u6b65\u9aa4\u548c approve\u3002",
  approvalParallelismLabel: "\u0041\u0070\u0070\u0072\u006f\u0076\u0065 \u5e76\u53d1\u6570",
  approvalParallelismDesc: "\u9ed8\u8ba4 1\u3002\u5927\u4e8e 1 \u65f6\u4f1a\u5e76\u884c\u53d1\u8d77\u591a\u6b21 approve\uff1b\u53ea\u8981\u4efb\u610f\u4e00\u6b21\u8fd4\u56de approved\uff0c\u5c31\u7acb\u5373\u7ee7\u7eed\u540e\u7eed\u6d41\u7a0b\u3002",
  customCheckoutProxy: "Checkout \u4ee3\u7406",
  customProviderProxy: "Provider \u4ee3\u7406",
  customProxyPlaceholder: "socks5://user:pass@host:port \u6216 host:port:user:pass",
  customProxyCheck: "\u68c0\u6d4b\u51fa\u53e3",
  customProxyChecking: "\u68c0\u6d4b\u4e2d...",
  customProxyExit: (ip: string, country: string, latency: number) => `\u51fa\u53e3 ${ip || "-"} \u00b7 ${country || "\u672a\u77e5"} \u00b7 ${latency || 0}ms`,
  customProxyOk: "\u4ee3\u7406\u53ef\u7528",
  customProxyFailed: "\u4ee3\u7406\u68c0\u6d4b\u5931\u8d25",
  customProxyNeedInput: "\u8bf7\u5148\u586b\u5199\u4ee3\u7406\u5730\u5740\u3002",
  scanOrderTitle: "扫码订单",
  scanOrderDesc: "如果未开启自动发布，可以在二维码生成后手动发布给在线接单方扫码。",
  scanOrderSent: "已发送扫码订单",
  scanOrderStatus: "订单状态",
  scanOrderPending: "等待接单",
  scanOrderAssigned: "已接单处理中",
  scanOrderChecking: "正在检测订阅",
  scanOrderCompleted: "订单已完成",
  scanOrderFailed: "订单失败，费用已退回",
  scanOrderCancelled: "订单已取消，费用已退回",
  scanOrderExpired: "二维码已过期，费用已退回",
  scanOrderCancel: "取消扫码订单",
  scanOrderCancelling: "正在取消...",
  scanOrderCancelledToast: "扫码订单已取消，费用已退回。",
  publishScanOrder: "发布扫码订单 · 0.6U",
  scanOrderPublishing: "正在发布扫码订单...",
  scanOrderPublished: "扫码订单已发布",
  scanOrderPublishedWithNo: (orderNo: string) => `扫码订单已发布：${orderNo}`,
  scanOrderPublishFailed: "发布扫码订单失败",
  scanOrderUnavailable: "该二维码没有可用的发布凭证，请重新提取。",
  scanOrderLoginRequired: "发布扫码订单前请先登录 Telegram。",
  scanOrderInsufficientBalance: "余额不足，发布扫码订单需要 0.6 USDT。",
  scanOrderAlmostExpired: "二维码剩余有效期不足或等于 1 分钟，请重新提取后再发布扫码订单。",
  scanOrderAutoPending: "已开启自动发布，但订单状态暂不可用。请刷新账户或稍后查看接单大厅。",
  notifySettingSaved: "设置已保存。",
  depositTitle: "USDT-BEP20 充值",
  depositDesc: "仅支持 BSC / BEP20 USDT。",
  depositAddressLabel: "充值地址",
  depositCopyAddress: "复制地址",
  depositAddressQr: "二维码",
  depositAddressQrTitle: "充值地址二维码",
  depositAddressQrDesc: "扫描该二维码可填写 BSC / BEP20 USDT 充值地址。",
  depositAddressQrGenerating: "正在生成二维码...",
  depositAddressCopied: "充值地址已复制。",
  depositUnavailable: "链上充值暂未配置，请稍后再试。",
  depositWarning: "请勿向该地址转入非 BEP20-USDT 资产。",
  depositExactAmountWarning: "钱包按链上实际到账数量入账，平台或网络手续费可能导致你需要多支付约 0.01U。错误金额可能匹配并完成他人的充值订单，无法退款或补发余额。",
  depositWarningDialogTitle: "充值前请确认",
  depositWarningDialogDesc: "充值订单只按 BSC / BEP20 USDT 链上实际到账金额匹配，不按你以为自己转出的金额判断。",
  depositWarningDialogFeeTitle: "手续费会影响实际到账金额",
  depositWarningDialogFeeDesc: "部分交易所或钱包会从转账金额中扣除手续费，如果实际到账金额少于订单金额，就无法匹配。请确认最终链上实际到账金额与页面显示的支付金额完全一致；必要时你可能需要多转一点，例如 +0.01 USDT。",
  depositWarningDialogNoRefundTitle: "转错数量后果自负",
  depositWarningDialogNoRefundDesc: "如果你转错数量，可能会匹配到其他人的充值订单。错误转账数量不支持退款，也不支持人工补发余额。",
  depositWarningDialogNoExcuseDesc: "如果数量转错，请不要再说“我支付了多少”“你们收到了钱”之类的话。系统只认链上实际到账金额是否精确匹配；转错数量不退款、不补发。",
  depositWarningDialogAsset: "仅支持 BSC / BEP20 USDT。转入其他链或其他资产可能丢失。",
  depositWarningAgreement: "我已完全阅读、理解并同意以上说明",
  depositWarningNoticeTitle: "充值风险说明",
  depositWarningSignedBadge: "已签署",
  depositWarningUnsignedBadge: "未签署",
  depositWarningNoticeHint: "该说明会常驻显示在钱包页，方便你每次充值前确认“实际到账金额必须精确匹配”的规则。",
  depositWarningExpand: "展开说明",
  depositWarningCollapse: "收起说明",
  depositWarningCancel: "取消",
  depositWarningConfirm: "我已确认，继续",
  depositWarningCountdown: (seconds: number) => `${seconds} 秒后可继续`,
  depositChooseAmount: "选择充值金额，系统会生成 20 分钟有效的唯一支付金额。",
  depositDisabled: "充值功能暂时关闭，请稍后再试。",
  cdkRedeemAction: "兑换 CDK",
  cdkRedeemTitle: "充值 CDK 兑换",
  cdkRedeemDesc: "输入管理员发放的充值 CDK，兑换成功后余额会立即增加。",
  cdkRedeemPlaceholder: "输入 upi_xxxxxxxxxxxxxxxx",
  cdkRedeemSubmit: "兑换余额",
  cdkRedeemSubmitting: "正在兑换...",
  cdkRedeemNeedCode: "请输入 CDK。",
  cdkRedeemSuccess: (amount: number) => `CDK 兑换成功，已到账 ${formatUsdt(amount)}。`,
  walletLedgerCdkRedeem: "CDK 兑换入账",
  depositCreate18: "充值 1.8 USDT",
  depositCreate5: "充值 5 USDT",
  depositCreate10: "充值 10 USDT",
  depositCreating: "正在创建充值订单...",
  depositOrderTitle: "充值订单",
  depositOrderNo: "订单号",
  depositPayAmount: "支付金额",
  depositOrderExpiresIn: (seconds: number) => `剩余 ${formatDuration(seconds)}`,
  depositOrderExpired: "该充值订单已过期，请创建新的订单。",
  depositOrderPaid: "已到账",
  depositOrderPending: "待支付",
  depositOrderExpiredStatus: "已过期",
  depositCopyAmount: "复制金额",
  depositAmountCopied: "支付金额已复制。",
  depositOrderHint: "请向下方统一地址转入 BSC / BEP20 USDT，并确保链上实际到账金额与页面显示金额完全一致。超时后请重新创建订单。",
  depositCreateNew: "创建新的充值订单",
  walletDepositAction: "充值",
  walletWithdrawAction: "提现",
  walletRefreshAction: "刷新余额",
  walletRefreshSuccess: "余额已刷新。",
  walletRefreshFailed: "刷新余额失败。",
  walletFrozen: "冻结",
  walletWithdrawTitle: "USDT-BEP20 提现",
  walletWithdrawDesc: "提交后会冻结提现金额和 0.01 USDT 手续费，管理员会处理 BEP20-USDT 转账。",
  walletWithdrawAmount: "提现金额",
  walletWithdrawAddress: "提现地址",
  walletWithdrawAddressPlaceholder: "BSC / BEP20 USDT 地址",
  walletWithdrawFee: "手续费",
  walletWithdrawTotal: "冻结合计",
  walletWithdrawSubmit: "申请提现",
  walletWithdrawSubmitting: "正在提交...",
  walletWithdrawNeedAmount: "请输入有效提现金额。",
  walletWithdrawMinAmount: "最低提现金额为 1.50 USDT。",
  walletWithdrawNeedAddress: "请输入提现地址。",
  walletWithdrawMax: "全部",
  walletWithdrawExceedBalance: "提现金额超过可用余额，请预留 0.01 USDT 手续费。",
  walletWithdrawSuccess: "提现申请已提交。",
  walletWithdrawDisabled: "提现功能暂未开放。",
  walletLedgerTitle: "订单历史",
  walletLedgerHint: "钱包中的充值、提现、扫码订单冻结、退款和支付记录。",
  walletLedgerEmpty: "暂无钱包记录。",
  walletLedgerDeposit: "充值到账",
  walletLedgerWithdrawFreeze: "提现申请",
  walletLedgerWithdrawRefund: "提现退回",
  walletLedgerWithdrawPaid: "提现已支付",
  walletLedgerScanFreeze: "扫码订单冻结",
  walletLedgerScanRefund: "扫码订单退款",
  walletLedgerScanSpend: "扫码订单支付",
  walletLedgerPremiumPurchase: "购买 Premium",
  walletLedgerAdjustment: "余额调整",
  walletLedgerFrozenAmount: "冻结",
  walletLedgerPending: "处理中",
  walletLedgerPaid: "已处理",
  walletLedgerRejected: "已拒绝",
  walletLedgerCancelled: "已取消",
  success: "成功",
  queued: "等待中",
  running: "提取中",
  storageActive: "暂存中",
  failed: "失败",
  expired: "已过期",
  elapsed: (seconds: number) => `已等待 ${seconds} 秒`,
  progressTitle: "提取进度",
  progressPercent: "进度",
  debugLogsTitle: "本地提取日志",
  debugLogsDesc: "仅本地测试模式显示，不会打印 Session Token。",
  debugLogsEmpty: "等待日志...",
  debugLogsRefresh: "刷新日志",
  debugLogsError: "日志加载失败",
  debugLogsDetails: "详情",
  stageLabels: {
    queued: "准备中",
    validating: "验证账号",
    checkout: "创建 Checkout",
    stripe_init: "初始化支付",
    stripe_confirm: "确认 UPI",
    approval: "Approve 阶段",
    waiting_qr: "等待二维码",
    hydrating: "解析二维码",
    rendering_qr: "生成图片",
    completed: "完成",
    retrying: "重试出口"
  }

};

function createUiText<T extends Record<string, unknown>>(base: T, overrides: Record<string, unknown>): T {
  const merged: Record<string, unknown> = { ...base, ...overrides };
  if (base.stageLabels && typeof base.stageLabels === "object" && overrides.stageLabels && typeof overrides.stageLabels === "object") {
    merged.stageLabels = { ...(base.stageLabels as Record<string, unknown>), ...(overrides.stageLabels as Record<string, unknown>) };
  }
  return merged as T;
}

const UI_TEXT: Record<Lang, typeof EN_TEXT> = {
  zh: createUiText(EN_TEXT, ZH_TEXT),
  en: EN_TEXT,
};

export function UpiExtractClient({ mockMode = false, mockSeedAt }: { mockMode?: boolean; mockSeedAt?: number }) {
  const [lang, setLang] = useState<Lang>(() => getInitialLanguage());
  const [initialGuardId] = useState(() => getInitialGuardIdFromUrl());
  const [mode, setMode] = useState<ExtractMode>("token");
  const [extractMethod, setExtractMethod] = useState<PaymentExtractMethod>(DEFAULT_PAYMENT_EXTRACT_METHOD);
  const [pageView, setPageView] = useState<ExtractPageView>("extract");
  const [contentView, setContentView] = useState<ExtractPageView>("extract");
  const [cardTransitionPhase, setCardTransitionPhase] = useState<CardTransitionPhase>("idle");
  const [sessionToken, setSessionToken] = useState("");
  const [customCheckoutProxy, setCustomCheckoutProxy] = useState("");
  const [customProviderProxy, setCustomProviderProxy] = useState("");
  const [approvalParallelism, setApprovalParallelism] = useState(1);
  const [customProxyCheck, setCustomProxyCheck] = useState<CustomProxyCheckState>({});
  const [guardIdInput, setGuardIdInput] = useState(initialGuardId);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<UpiExtractProgress | null>(null);
  const [extractStartedAt, setExtractStartedAt] = useState<number | null>(null);
  const [result, setResult] = useState<UpiExtractResult | null>(null);
  const [failedJob, setFailedJob] = useState<SavedExtractJob | null>(null);
  const [extractDebugLogs, setExtractDebugLogs] = useState<UpiExtractDebugLogEntry[]>([]);
  const [extractDebugLogError, setExtractDebugLogError] = useState<string | null>(null);
  const [restorePending, setRestorePending] = useState(!mockMode);
  const [createdGuard, setCreatedGuard] = useState<UpiGuardInfo | null>(null);
  const [activeGuardId, setActiveGuardId] = useState<string | null>(null);
  const [creatingGuard, setCreatingGuard] = useState(false);
  const [completingGuard, setCompletingGuard] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [activity, setActivity] = useState<UpiExtractActivity[]>(() => mockMode ? makeMockActivity(mockSeedAt) : []);
  const [activityCounts, setActivityCounts] = useState<ActivityCounts>(() => emptyActivityCounts());
  const [activityCountsByChannel, setActivityCountsByChannel] = useState<ActivityCountsByChannel>(() => emptyActivityCountsByChannel());
  const [extractionPaused, setExtractionPaused] = useState(false);
  const [extractCapacity, setExtractCapacity] = useState<ExtractCapacity | null>(null);
  const [viewerId] = useState(() => getOrCreateViewerId());
  const [onlineViewers, setOnlineViewers] = useState<number | null>(1);
  const [siteSettings, setSiteSettings] = useState<PublicSiteSettings>({
    tgInviteEnabled: false,
    tgInviteUrl: "https://t.me/your_group",
    depositEnabled: true,
    withdrawEnabled: false,
    premiumSaleEnabled: true,
    premiumPurchasePrice: 1.5,
    faqContent: "",
    faqContentEn: "",
    extractMethodSelectionEnabled: false,
    customProxyEnabled: false,
  });
  const paymentMethodSelectionEnabled = Boolean(siteSettings.extractMethodSelectionEnabled);
  const customProxyConfigEnabled = Boolean(siteSettings.customProxyEnabled);
  const [publicUser, setPublicUser] = useState<PublicUserSession | null>(null);
  const [publicUserWallet, setPublicUserWallet] = useState<PublicUserWalletSummary | null>(null);
  const [publicUserDeposit, setPublicUserDeposit] = useState<PublicUserDepositAddressInfo | null>(null);
  const [publicUserDepositOrder, setPublicUserDepositOrder] = useState<PublicUserDepositOrderInfo | null>(null);
  const [publicUserPremium, setPublicUserPremium] = useState<PublicUserPremiumInfo | null>(null);
  const [publicUserHistory, setPublicUserHistory] = useState<UserExtractHistoryItem[]>([]);
  const [publicUserActiveJobs, setPublicUserActiveJobs] = useState<UpiExtractJob[]>([]);
  const [taskFilter, setTaskFilter] = useState<TaskHistoryFilter>("all");
  const [taskPage, setTaskPage] = useState(1);
  const [taskPagination, setTaskPagination] = useState<TaskHistoryPagination | null>(null);
  const [taskCounts, setTaskCounts] = useState<TaskHistoryCounts>(() => emptyTaskHistoryCounts());
  const [publicUserWalletHistory, setPublicUserWalletHistory] = useState<PublicUserWalletHistoryItem[]>([]);
  const [publicUserSettings, setPublicUserSettings] = useState<PublicUserSettings>(DEFAULT_PUBLIC_USER_SETTINGS);
  const [publicUserLoaded, setPublicUserLoaded] = useState(false);
  const [publicUserSettingSaving, setPublicUserSettingSaving] = useState(false);
  const [publicUserRefreshing, setPublicUserRefreshing] = useState(false);
  const [autoPublishScanOrder, setAutoPublishScanOrder] = useState(false);
  const [untilSuccess, setUntilSuccess] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [displayedJobId, setDisplayedJobId] = useState<string | null>(null);
  const [activeUntilSuccess, setActiveUntilSuccess] = useState(false);
  const [untilSuccessRetryCount, setUntilSuccessRetryCount] = useState(0);
  const [untilSuccessLastError, setUntilSuccessLastError] = useState<string | null>(null);
  const [suppressCompletedAutoView, setSuppressCompletedAutoView] = useState(() => getInitialSuppressCompletedAutoView());
  const [cancellingUntilSuccess, setCancellingUntilSuccess] = useState(false);
  const [cancellingJobId, setCancellingJobId] = useState<string | null>(null);
  const [publishingScanOrder, setPublishingScanOrder] = useState(false);
  const [publishedScanOrder, setPublishedScanOrder] = useState<PublicOrder | null>(null);
  const [cancellingScanOrder, setCancellingScanOrder] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [walletOpen, setWalletOpen] = useState(false);
  const [loginChallenge, setLoginChallenge] = useState<PublicLoginChallenge | null>(null);
  const [loginStatus, setLoginStatus] = useState<LoginChallengeStatus>("PENDING");
  const [loginLoading, setLoginLoading] = useState(false);
  const [buffCount, setBuffCount] = useState(0);
  const [guideOpenCount, setGuideOpenCount] = useState(0);
  const [buffBursts, setBuffBursts] = useState<BuffBurst[]>([]);
  const [overlayScrollbar, setOverlayScrollbar] = useState({ visible: false, top: 8, height: 48 });
  const [premiumCelebrationVisible, setPremiumCelebrationVisible] = useState(false);
  const [subscriptionCheckingJobId, setSubscriptionCheckingJobId] = useState<string | null>(null);
  const [subscriptionCheckLastAtByJobId, setSubscriptionCheckLastAtByJobId] = useState<Record<string, number>>({});
  const [githubStars, setGithubStars] = useState<number | null>(null);
  const [githubStarsFailed, setGithubStarsFailed] = useState(false);
  const buffSeqRef = useRef<number | null>(null);
  const buffBurstIdRef = useRef(0);
  const pendingBuffBurstCountRef = useRef(0);
  const buffReceivedLabelRef = useRef("");
  const restoredJobRef = useRef(false);
  const activityRefreshInFlightRef = useRef(false);
  const publicUserRefreshInFlightRef = useRef(false);
  const cardTransitionTimeoutRef = useRef<number | null>(null);
  const premiumStatusRef = useRef<{ telegramUserId: string | null; isPremium: boolean | null }>({ telegramUserId: null, isPremium: null });
  const t = UI_TEXT[lang];
  const userIsPremium = isPremiumActive(publicUser, now);
  const effectivePublicUser = useMemo(() => publicUser ? { ...publicUser, isPremium: userIsPremium } : null, [publicUser, userIsPremium]);
  const livePublicUserJobIds = useMemo(() => publicUserActiveJobs
    .filter((job) => job.status === "queued" || job.status === "running" || isActiveScanOrder(job.result?.scanOrder))
    .map((job) => job.jobId)
    .sort()
    .join("|"), [publicUserActiveJobs]);

  const switchCardPage = useCallback((nextView: ExtractPageView, options: { immediate?: boolean } = {}) => {
    setPageView(nextView);

    if (cardTransitionTimeoutRef.current !== null) {
      window.clearTimeout(cardTransitionTimeoutRef.current);
      cardTransitionTimeoutRef.current = null;
    }

    if (options.immediate || contentView === nextView) {
      setContentView(nextView);
      setCardTransitionPhase("idle");
      return;
    }

    setCardTransitionPhase("leaving");
    cardTransitionTimeoutRef.current = window.setTimeout(() => {
      setContentView(nextView);
      setCardTransitionPhase("entering");
      cardTransitionTimeoutRef.current = window.setTimeout(() => {
        setCardTransitionPhase("idle");
        cardTransitionTimeoutRef.current = null;
      }, 280);
    }, 260);
  }, [contentView]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 15_000);

    void fetch(OPEN_SOURCE_REPO_API_URL, {
      headers: { Accept: "application/vnd.github+json" },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
        const data = await response.json() as { stargazers_count?: unknown };
        const nextStars = Number(data.stargazers_count);
        if (!Number.isFinite(nextStars)) throw new Error("Invalid GitHub star count");
        setGithubStars(nextStars);
        setGithubStarsFailed(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setGithubStarsFailed(true);
      })
      .finally(() => window.clearTimeout(timer));

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, []);

  useEffect(() => {
    buffReceivedLabelRef.current = t.buffReceived;
  }, [t.buffReceived]);

  useEffect(() => {
    const telegramUserId = publicUser?.telegramUserId ?? null;
    const previous = premiumStatusRef.current;

    if (telegramUserId && previous.telegramUserId === telegramUserId && previous.isPremium === false && userIsPremium) {
      setPremiumCelebrationVisible(true);
    }

    premiumStatusRef.current = { telegramUserId, isPremium: telegramUserId ? userIsPremium : null };
  }, [publicUser?.telegramUserId, userIsPremium]);

  useEffect(() => {
    const overlayScrollbarClassName = "upi-extract-overlay-scrollbar";
    const targets = [document.documentElement, document.body];
    for (const target of targets) {
      target.classList.add(overlayScrollbarClassName);
    }

    return () => {
      for (const target of targets) {
        target.classList.remove(overlayScrollbarClassName);
      }
    };
  }, []);

  useEffect(() => {
    let frame = 0;
    const updateScrollbar = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const root = document.documentElement;
        const scrollHeight = Math.max(root.scrollHeight, document.body.scrollHeight);
        const clientHeight = window.innerHeight;
        const maxScroll = Math.max(0, scrollHeight - clientHeight);
        if (maxScroll <= 2) {
          setOverlayScrollbar((current) => current.visible ? { ...current, visible: false } : current);
          return;
        }

        const trackPadding = 8;
        const trackHeight = Math.max(0, clientHeight - trackPadding * 2);
        const thumbHeight = Math.max(36, Math.round((clientHeight / scrollHeight) * trackHeight));
        const thumbTop = trackPadding + Math.round((window.scrollY / maxScroll) * Math.max(0, trackHeight - thumbHeight));
        setOverlayScrollbar({ visible: true, top: thumbTop, height: thumbHeight });
      });
    };

    updateScrollbar();
    window.addEventListener("scroll", updateScrollbar, { passive: true });
    window.addEventListener("resize", updateScrollbar);

    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(updateScrollbar) : null;
    if (observer) observer.observe(document.body);

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", updateScrollbar);
      window.removeEventListener("resize", updateScrollbar);
      observer?.disconnect();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (cardTransitionTimeoutRef.current !== null) {
        window.clearTimeout(cardTransitionTimeoutRef.current);
      }
    };
  }, []);

  const changeLanguage = useCallback((nextLang: Lang) => {
    setLang(nextLang);
    try {
      window.localStorage.setItem(LANG_STORAGE_KEY, nextLang);
    } catch {
      // Ignore unavailable storage.
    }
  }, []);

  const refreshPresence = useCallback(async () => {
    if (!viewerId) return;
    try {
      const data = await apiFetch<PresenceResponse>("/api/upi-extract/presence", {
        method: "POST",
        body: JSON.stringify({ sessionId: viewerId }),
      });
      setOnlineViewers(data.count);
    } catch {
      setOnlineViewers((current) => current ?? 1);
    }
  }, [viewerId]);

  const refreshActivity = useCallback(async () => {
    if (mockMode) return;
    if (activityRefreshInFlightRef.current) return;
    activityRefreshInFlightRef.current = true;
    try {
      const data = await apiFetch<ActivityResponse>("/api/upi-extract");
      setActivity(normalizeActivityItems(data.items));
      setActivityCounts(normalizeActivityCounts(data.counts));
      setActivityCountsByChannel(normalizeActivityCountsByChannel(data.countsByChannel));
      setExtractionPaused(Boolean(data.paused));
      setExtractCapacity(normalizeExtractCapacity(data.capacity));
    } catch {
      // Activity panel is display-only; keep the current content if refresh fails.
    } finally {
      activityRefreshInFlightRef.current = false;
    }
  }, [mockMode]);

  const refreshSiteSettings = useCallback(async () => {
    try {
      const data = await apiFetch<PublicSiteSettings>("/api/upi-extract/settings");
      setSiteSettings(data);
    } catch {
      setSiteSettings((current) => ({ ...current, tgInviteEnabled: false }));
    }
  }, []);

  const refreshPublicUser = useCallback(async () => {
    if (publicUserRefreshInFlightRef.current) return;
    publicUserRefreshInFlightRef.current = true;
    try {
      const params = new URLSearchParams({
        historyPage: String(taskPage),
        historyPageSize: String(TASK_HISTORY_PAGE_SIZE),
        historyStatus: taskFilter,
      });
      const data = await apiFetch<PublicUserResponse>(`/api/upi-extract/user?${params.toString()}`);
      setPublicUser(data.user);
      setPublicUserWallet(data.wallet || null);
      setPublicUserDeposit(data.deposit || null);
      setPublicUserDepositOrder(data.depositOrder || null);
      setPublicUserPremium(data.premium || null);
      setPublicUserHistory(data.history || []);
      setTaskPagination(data.historyPagination || null);
      setTaskCounts(normalizeTaskHistoryCounts(data.historyCounts));
      setPublicUserActiveJobs(mergeExtractJobs([], data.activeJobs || []));
      setPublicUserWalletHistory(data.walletHistory || []);
      setPublicUserSettings(normalizePublicUserSettings(data.settings));
      setPublicUserLoaded(true);
    } catch {
      setPublicUser(null);
      setPublicUserWallet(null);
      setPublicUserDeposit(null);
      setPublicUserDepositOrder(null);
      setPublicUserPremium(null);
      setPublicUserHistory([]);
      setTaskPagination(null);
      setTaskCounts(emptyTaskHistoryCounts());
      setPublicUserActiveJobs([]);
      setPublicUserWalletHistory([]);
      setPublicUserSettings(DEFAULT_PUBLIC_USER_SETTINGS);
      setPublicUserLoaded(true);
    } finally {
      publicUserRefreshInFlightRef.current = false;
    }
  }, [taskFilter, taskPage]);

  useEffect(() => {
    if (!publicUser?.premiumUntil) return undefined;
    const expiresAtMs = new Date(publicUser.premiumUntil).getTime();
    if (!Number.isFinite(expiresAtMs)) return undefined;
    const delay = expiresAtMs - Date.now();
    const timer = window.setTimeout(() => void refreshPublicUser(), delay <= 0 ? 0 : Math.min(delay + 300, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [publicUser?.premiumUntil, refreshPublicUser]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setUntilSuccess(Boolean(userIsPremium && publicUserSettings.autoRetryUntilSuccessEnabled));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [userIsPremium, publicUser?.telegramUserId, publicUserSettings.autoRetryUntilSuccessEnabled]);

  useEffect(() => {
    if (extractMethod === "ideal" && autoPublishScanOrder) {
      const timer = window.setTimeout(() => setAutoPublishScanOrder(false), 0);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [autoPublishScanOrder, extractMethod]);

  useEffect(() => {
    if (paymentMethodSelectionEnabled) return;
    if (extractMethod !== DEFAULT_PAYMENT_EXTRACT_METHOD) {
      const timer = window.setTimeout(() => setExtractMethod(DEFAULT_PAYMENT_EXTRACT_METHOD), 0);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [extractMethod, paymentMethodSelectionEnabled]);

  useEffect(() => {
    if (customProxyConfigEnabled) return;
    if (!customCheckoutProxy && !customProviderProxy && approvalParallelism === 1) return;
    const timer = window.setTimeout(() => {
      setCustomCheckoutProxy("");
      setCustomProviderProxy("");
      setCustomProxyCheck({});
      setApprovalParallelism(1);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [approvalParallelism, customCheckoutProxy, customProxyConfigEnabled, customProviderProxy]);

  useEffect(() => {
    if (!publicUser && contentView === "tasks") {
      const timer = window.setTimeout(() => switchCardPage("extract", { immediate: true }), 0);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [contentView, publicUser, switchCardPage]);

  useEffect(() => {
    if (!publicUser?.telegramUserId) return;
    const timer = window.setTimeout(() => {
      clearCurrentJob();
      setTaskFilter("all");
      setTaskPage(1);
      setResult(null);
      setFailedJob(null);
      setProgress(null);
      setExtractStartedAt(null);
      setActiveJobId(null);
      setDisplayedJobId(null);
      setActiveUntilSuccess(false);
      setUntilSuccessRetryCount(0);
      setUntilSuccessLastError(null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [publicUser?.telegramUserId]);

  useEffect(() => {
    if (!taskPagination) return;
    if (taskPage > taskPagination.totalPages) {
      const timer = window.setTimeout(() => setTaskPage(Math.max(1, taskPagination.totalPages)), 0);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [taskPage, taskPagination]);

  const startPublicLogin = useCallback(async (openBot = false) => {
    let popup: Window | null = null;
    if (openBot && typeof window !== "undefined") {
      popup = window.open("about:blank", "_blank");
    }

    try {
      setLoginLoading(true);
      setLoginOpen(true);
      const challenge = await apiFetch<PublicLoginChallenge>("/api/tg-login/challenge", {
        method: "POST",
        body: JSON.stringify({ purpose: "user" }),
      });
      setLoginChallenge(challenge);
      setLoginStatus(challenge.status);

      if (openBot) {
        const link = makeTelegramLoginLink(challenge.code);
        if (popup) {
          popup.location.href = link;
        } else {
          window.open(link, "_blank", "noopener,noreferrer");
        }
      }
    } catch (error) {
      popup?.close();
      toast.error(error instanceof Error ? error.message : t.loginFailed);
    } finally {
      setLoginLoading(false);
    }
  }, [t.loginFailed]);

  const logoutPublicUser = useCallback(async () => {
    try {
      const data = await apiFetch<PublicUserResponse>("/api/upi-extract/user", { method: "DELETE" });
      setPublicUser(data.user);
      setPublicUserWallet(data.wallet || null);
      setPublicUserDeposit(data.deposit || null);
      setPublicUserDepositOrder(data.depositOrder || null);
      setPublicUserPremium(data.premium || null);
      setPublicUserHistory(data.history || []);
      if (data.historyPagination) setTaskPagination(data.historyPagination);
      if (data.historyCounts) setTaskCounts(normalizeTaskHistoryCounts(data.historyCounts));
      setTaskFilter("all");
      setTaskPage(1);
      setPublicUserActiveJobs(mergeExtractJobs([], data.activeJobs || []));
      setPublicUserWalletHistory(data.walletHistory || []);
      setPublicUserSettings(normalizePublicUserSettings(data.settings));
      toast.success(t.logoutSuccess);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t.loginFailed);
    }
  }, [t.loginFailed, t.logoutSuccess]);

  const updateSuccessTgNotify = useCallback(async (enabled: boolean) => {
    const previous = publicUserSettings;
    setPublicUserSettings({ ...previous, successTgNotifyEnabled: enabled });
    try {
      setPublicUserSettingSaving(true);
      const params = new URLSearchParams({
        historyPage: String(taskPage),
        historyPageSize: String(TASK_HISTORY_PAGE_SIZE),
        historyStatus: taskFilter,
      });
      const data = await apiFetch<PublicUserResponse>(`/api/upi-extract/user?${params.toString()}`, {
        method: "PATCH",
        body: JSON.stringify({ successTgNotifyEnabled: enabled }),
      });
      setPublicUser(data.user);
      setPublicUserWallet(data.wallet || null);
      setPublicUserDeposit(data.deposit || null);
      setPublicUserDepositOrder(data.depositOrder || null);
      setPublicUserPremium(data.premium || null);
      setPublicUserHistory(data.history || []);
      if (data.historyPagination) setTaskPagination(data.historyPagination);
      if (data.historyCounts) setTaskCounts(normalizeTaskHistoryCounts(data.historyCounts));
      setPublicUserActiveJobs(mergeExtractJobs([], data.activeJobs || []));
      setPublicUserWalletHistory(data.walletHistory || []);
      setPublicUserSettings(normalizePublicUserSettings(data.settings || { ...previous, successTgNotifyEnabled: enabled }));
      toast.success(t.notifySettingSaved);
    } catch (error) {
      setPublicUserSettings(previous);
      toast.error(error instanceof Error ? error.message : t.loginFailed);
    } finally {
      setPublicUserSettingSaving(false);
    }
  }, [publicUserSettings, t.loginFailed, t.notifySettingSaved, taskFilter, taskPage]);

  const updateAutoRetryUntilSuccess = useCallback(async (enabled: boolean) => {
    if (!userIsPremium) {
      setUntilSuccess(false);
      return;
    }

    const nextEnabled = Boolean(enabled);
    const previousSettings = publicUserSettings;
    const previousUntilSuccess = untilSuccess;
    setUntilSuccess(nextEnabled);
    setPublicUserSettings({ ...previousSettings, autoRetryUntilSuccessEnabled: nextEnabled });

    try {
      setPublicUserSettingSaving(true);
      const params = new URLSearchParams({
        historyPage: String(taskPage),
        historyPageSize: String(TASK_HISTORY_PAGE_SIZE),
        historyStatus: taskFilter,
      });
      const data = await apiFetch<PublicUserResponse>(`/api/upi-extract/user?${params.toString()}`, {
        method: "PATCH",
        body: JSON.stringify({ autoRetryUntilSuccessEnabled: nextEnabled }),
      });
      const nextSettings = normalizePublicUserSettings(data.settings || { ...previousSettings, autoRetryUntilSuccessEnabled: nextEnabled });
      setPublicUser(data.user);
      setPublicUserWallet(data.wallet || null);
      setPublicUserDeposit(data.deposit || null);
      setPublicUserDepositOrder(data.depositOrder || null);
      setPublicUserPremium(data.premium || null);
      setPublicUserHistory(data.history || []);
      if (data.historyPagination) setTaskPagination(data.historyPagination);
      if (data.historyCounts) setTaskCounts(normalizeTaskHistoryCounts(data.historyCounts));
      setPublicUserActiveJobs(mergeExtractJobs([], data.activeJobs || []));
      setPublicUserWalletHistory(data.walletHistory || []);
      setPublicUserSettings(nextSettings);
      setUntilSuccess(Boolean(isPremiumActive(data.user, Date.now()) && nextSettings.autoRetryUntilSuccessEnabled));
      toast.success(t.notifySettingSaved);
    } catch (error) {
      setUntilSuccess(previousUntilSuccess);
      setPublicUserSettings(previousSettings);
      toast.error(error instanceof Error ? error.message : t.loginFailed);
    } finally {
      setPublicUserSettingSaving(false);
    }
  }, [publicUserSettings, t.loginFailed, t.notifySettingSaved, untilSuccess, userIsPremium, taskFilter, taskPage]);

  const signDepositRiskNotice = useCallback(async () => {
    const params = new URLSearchParams({
      historyPage: String(taskPage),
      historyPageSize: String(TASK_HISTORY_PAGE_SIZE),
      historyStatus: taskFilter,
    });
    const data = await apiFetch<PublicUserResponse>(`/api/upi-extract/user?${params.toString()}`, {
      method: "PATCH",
      body: JSON.stringify({ depositRiskSigned: true }),
    });
    const nextSettings = normalizePublicUserSettings(data.settings);
    setPublicUser(data.user);
    setPublicUserWallet(data.wallet || null);
    setPublicUserDeposit(data.deposit || null);
    setPublicUserDepositOrder(data.depositOrder || null);
    setPublicUserPremium(data.premium || null);
    setPublicUserHistory(data.history || []);
    if (data.historyPagination) setTaskPagination(data.historyPagination);
    if (data.historyCounts) setTaskCounts(normalizeTaskHistoryCounts(data.historyCounts));
    setPublicUserActiveJobs(mergeExtractJobs([], data.activeJobs || []));
    setPublicUserWalletHistory(data.walletHistory || []);
    setPublicUserSettings(nextSettings);
    return nextSettings;
  }, [taskFilter, taskPage]);

  const requestPublicWithdrawal = useCallback(async (amount: number, withdrawalAddress: string) => {
    const data = await apiFetch<PublicUserWithdrawalResponse>("/api/upi-extract/user/withdraw", {
      method: "POST",
      body: JSON.stringify({ amount, withdrawalAddress }),
    });
    setPublicUserWallet(data.wallet || null);
    setPublicUserDeposit(data.deposit || null);
    setPublicUserDepositOrder(data.depositOrder || null);
    setPublicUserWalletHistory(data.walletHistory || []);
    return data.withdrawal;
  }, []);

  const createPublicDepositOrder = useCallback(async (baseAmount: PublicDepositBaseAmount) => {
    if (!siteSettings.depositEnabled) {
      throw new Error(t.depositDisabled);
    }
    const data = await apiFetch<PublicUserDepositOrderResponse>("/api/upi-extract/user/deposit-order", {
      method: "POST",
      body: JSON.stringify({ baseAmount }),
    });
    setPublicUserWallet(data.wallet || null);
    setPublicUserDeposit(data.deposit || null);
    setPublicUserDepositOrder(data.depositOrder || null);
    setPublicUserWalletHistory(data.walletHistory || []);
    return data.depositOrder;
  }, [siteSettings.depositEnabled, t.depositDisabled]);

  const redeemPublicCdk = useCallback(async (code: string) => {
    const data = await apiFetch<PublicUserCdkRedeemResponse>("/api/upi-extract/user/cdk-redeem", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
    setPublicUser(data.user);
    setPublicUserWallet(data.wallet || null);
    setPublicUserDeposit(data.deposit || null);
    setPublicUserDepositOrder(data.depositOrder || null);
    setPublicUserPremium(data.premium || null);
    setPublicUserHistory(data.history || []);
    if (data.historyPagination) setTaskPagination(data.historyPagination);
    if (data.historyCounts) setTaskCounts(normalizeTaskHistoryCounts(data.historyCounts));
    setPublicUserActiveJobs(mergeExtractJobs([], data.activeJobs || []));
    setPublicUserWalletHistory(data.walletHistory || []);
    setPublicUserSettings(normalizePublicUserSettings(data.settings));
    return data.redeem;
  }, []);

  const applyPublicPremiumActionResponse = useCallback((data: PublicUserResponse) => {
    setPublicUser(data.user);
    setPublicUserWallet(data.wallet || null);
    setPublicUserDeposit(data.deposit || null);
    setPublicUserDepositOrder(data.depositOrder || null);
    setPublicUserPremium(data.premium || null);
    setPublicUserHistory(data.history || []);
    if (data.historyPagination) setTaskPagination(data.historyPagination);
    if (data.historyCounts) setTaskCounts(normalizeTaskHistoryCounts(data.historyCounts));
    setPublicUserActiveJobs(mergeExtractJobs([], data.activeJobs || []));
    setPublicUserWalletHistory(data.walletHistory || []);
    setPublicUserSettings(normalizePublicUserSettings(data.settings));
  }, []);

  const purchasePublicPremium = useCallback(async () => {
    const data = await apiFetch<PublicUserResponse>("/api/upi-extract/user/premium", {
      method: "POST",
      body: JSON.stringify({ action: "purchase" }),
    });
    applyPublicPremiumActionResponse(data);
    return data;
  }, [applyPublicPremiumActionResponse]);

  const claimPublicPremiumTrial = useCallback(async () => {
    const data = await apiFetch<PublicUserResponse>("/api/upi-extract/user/premium", {
      method: "POST",
      body: JSON.stringify({ action: "claimTrial" }),
    });
    applyPublicPremiumActionResponse(data);
    return data;
  }, [applyPublicPremiumActionResponse]);

  const refreshPublicUserBalance = useCallback(async () => {
    try {
      setPublicUserRefreshing(true);
      const params = new URLSearchParams({
        historyPage: String(taskPage),
        historyPageSize: String(TASK_HISTORY_PAGE_SIZE),
        historyStatus: taskFilter,
      });
      const data = await apiFetch<PublicUserResponse>(`/api/upi-extract/user?${params.toString()}`);
      setPublicUser(data.user);
      setPublicUserWallet(data.wallet || null);
      setPublicUserDeposit(data.deposit || null);
      setPublicUserDepositOrder(data.depositOrder || null);
      setPublicUserPremium(data.premium || null);
      setPublicUserHistory(data.history || []);
      if (data.historyPagination) setTaskPagination(data.historyPagination);
      if (data.historyCounts) setTaskCounts(normalizeTaskHistoryCounts(data.historyCounts));
      setPublicUserActiveJobs(mergeExtractJobs([], data.activeJobs || []));
      setPublicUserWalletHistory(data.walletHistory || []);
      setPublicUserSettings(normalizePublicUserSettings(data.settings));
      toast.success(t.walletRefreshSuccess);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t.walletRefreshFailed);
    } finally {
      setPublicUserRefreshing(false);
    }
  }, [t.walletRefreshFailed, t.walletRefreshSuccess, taskFilter, taskPage]);

  const enqueueBuffBursts = useCallback((amount = 1) => {
    const safeAmount = Math.max(0, Math.floor(amount));
    if (safeAmount <= 0) return;
    const availableSlots = Math.max(0, MAX_PENDING_BUFF_BURSTS - pendingBuffBurstCountRef.current);
    pendingBuffBurstCountRef.current += Math.min(safeAmount, availableSlots);
  }, []);

  const applyBuffStats = useCallback((data: BuffStatsResponse, animateEvents = true) => {
    setBuffCount(data.buffCount);
    setGuideOpenCount(data.guideOpenCount);

    if (animateEvents && buffSeqRef.current !== null) {
      const foreignBuffCount = data.events.filter((event) => event.viewerId !== viewerId).length;
      enqueueBuffBursts(foreignBuffCount);
    }

    buffSeqRef.current = data.latestEventSeq;
  }, [enqueueBuffBursts, viewerId]);

  const refreshBuffStats = useCallback(async () => {
    if (!viewerId) return;
    try {
      const params = new URLSearchParams({ viewerId });
      if (buffSeqRef.current !== null) params.set("since", String(buffSeqRef.current));
      const data = await apiFetch<BuffStatsResponse>(`/api/upi-extract/buff?${params.toString()}`);
      applyBuffStats(data, true);
    } catch {
      // Buff 只是趣味展示，失败时保持当前数据。
    }
  }, [applyBuffStats, viewerId]);

  const sendBuff = useCallback(async () => {
    if (!viewerId) return;
    try {
      const data = await apiFetch<BuffStatsResponse>("/api/upi-extract/buff", {
        method: "POST",
        body: JSON.stringify({ type: "buff", viewerId }),
      });
      applyBuffStats(data, false);
      enqueueBuffBursts(1);
    } catch {
      toast.error(t.buffFailedToast);
    }
  }, [applyBuffStats, enqueueBuffBursts, t.buffFailedToast, viewerId]);

  const recordGuideOpen = useCallback(async () => {
    if (!viewerId) return;
    try {
      const data = await apiFetch<BuffStatsResponse>("/api/upi-extract/buff", {
        method: "POST",
        body: JSON.stringify({ type: "guide-open", viewerId }),
      });
      applyBuffStats(data, false);
    } catch {
      // 打开次数统计失败不影响弹窗阅读。
    }
  }, [applyBuffStats, viewerId]);

  useEffect(() => {
    const firstTimer = window.setTimeout(() => void refreshPresence(), 0);
    const timer = window.setInterval(() => void refreshPresence(), PRESENCE_HEARTBEAT_MS);

    const leave = () => {
      if (!viewerId) return;
      const payload = JSON.stringify({ sessionId: viewerId, leave: true });
      if (window.navigator.sendBeacon) {
        window.navigator.sendBeacon("/api/upi-extract/presence", new Blob([payload], { type: "application/json" }));
        return;
      }
      void fetch("/api/upi-extract/presence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        keepalive: true,
      }).catch(() => undefined);
    };

    window.addEventListener("pagehide", leave);
    return () => {
      window.clearTimeout(firstTimer);
      window.clearInterval(timer);
      window.removeEventListener("pagehide", leave);
    };
  }, [refreshPresence, viewerId]);

  useEffect(() => {
    if (mockMode) return;
    const firstTimer = window.setTimeout(() => void refreshActivity(), 0);
    const timer = window.setInterval(() => void refreshActivity(), 2_000);
    return () => {
      window.clearTimeout(firstTimer);
      window.clearInterval(timer);
    };
  }, [mockMode, refreshActivity]);

  useEffect(() => {
    const firstTimer = window.setTimeout(() => void refreshSiteSettings(), 0);
    const timer = window.setInterval(() => void refreshSiteSettings(), 30_000);
    return () => {
      window.clearTimeout(firstTimer);
      window.clearInterval(timer);
    };
  }, [refreshSiteSettings]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshPublicUser(), 0);
    return () => window.clearTimeout(timer);
  }, [refreshPublicUser]);

  useEffect(() => {
    if (!publicUser?.telegramUserId) return undefined;
    const timer = window.setInterval(() => void refreshPublicUser(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [publicUser?.telegramUserId, refreshPublicUser]);

  useEffect(() => {
    if (mockMode || !publicUser?.telegramUserId || !livePublicUserJobIds) return undefined;
    const jobIds = livePublicUserJobIds.split("|").filter(Boolean);
    if (jobIds.length === 0) return undefined;

    let stopped = false;
    const pollLiveJobs = async () => {
      try {
        const updates = (await Promise.all(jobIds.map(async (jobId) => {
          try {
            return await apiFetch<UpiExtractJob>(`/api/upi-extract?jobId=${encodeURIComponent(jobId)}`);
          } catch {
            return null;
          }
        }))).filter((job): job is UpiExtractJob => Boolean(job));

        if (stopped || updates.length === 0) return;
        setPublicUserActiveJobs((current) => mergeExtractJobs(current, updates));
        if (updates.some((job) => job.status === "completed" || job.status === "failed")) {
          void refreshPublicUser();
        }
        void refreshActivity();
      } catch {
        // 单个任务进度轮询只影响实时展示，失败时等待下一轮。
      }
    };

    const firstTimer = window.setTimeout(() => void pollLiveJobs(), 0);
    const timer = window.setInterval(() => void pollLiveJobs(), POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      window.clearTimeout(firstTimer);
      window.clearInterval(timer);
    };
  }, [livePublicUserJobIds, mockMode, publicUser?.telegramUserId, refreshActivity, refreshPublicUser]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!publicUser) return;
      const liveJobs = publicUserActiveJobs.filter((job) => job.status === "queued" || job.status === "running");
      const latestCompletedJob = publicUserActiveJobs.find((job) => job.status === "completed" && Boolean(job.result));
      const selectedJob = activeJobId
        ? publicUserActiveJobs.find((job) => job.jobId === activeJobId)
        : !result && !failedJob
          ? liveJobs[0] || (suppressCompletedAutoView ? undefined : latestCompletedJob)
          : undefined;

      if (!selectedJob) return;

      setExtractStartedAt((current) => current || new Date(selectedJob.createdAt).getTime());
      setActiveUntilSuccess(Boolean(selectedJob.untilSuccess));
      setUntilSuccessRetryCount(Math.max(0, Number(selectedJob.retryCount || 0)));
      setUntilSuccessLastError(selectedJob.error ? compactFailureMessage(selectedJob.error, t, selectedJob.extractMethod || selectedJob.result?.extractMethod) : null);

      if (selectedJob.status === "queued" || selectedJob.status === "running") {
        if (!activeJobId) setActiveJobId(selectedJob.jobId);
        setResult(null);
        setDisplayedJobId(null);
        setPublishedScanOrder(null);
        setFailedJob(null);
        setProgress(selectedJob.progress || { stage: "queued", percent: 4 });
        return;
      }

      if (selectedJob.status === "completed" && selectedJob.result) {
        saveCurrentJob(selectedJob);
        setResult(selectedJob.result);
        setDisplayedJobId(selectedJob.jobId);
        setPublishedScanOrder(selectedJob.result.scanOrder || null);
        setFailedJob(null);
        setProgress(selectedJob.progress || { stage: "completed", percent: 100 });
        setActiveJobId(null);
        setActiveUntilSuccess(false);
        setLoading(false);
        return;
      }

      if (selectedJob.status === "failed") {
        setResult(null);
        setDisplayedJobId(null);
        setPublishedScanOrder(null);
        setFailedJob(toSavedJob(selectedJob));
        setProgress(null);
        setExtractStartedAt(null);
        setActiveJobId(null);
        setActiveUntilSuccess(false);
        setLoading(false);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeJobId, failedJob, publicUser, publicUserActiveJobs, result, suppressCompletedAutoView, t]);

  useEffect(() => {
    if (!displayedJobId) return;
    const timer = window.setTimeout(() => {
      const updated = publicUserActiveJobs.find((job) => job.jobId === displayedJobId);
      if (!updated?.result) return;
      setResult((current) => current ? { ...current, ...updated.result } : current);
      setPublishedScanOrder(updated.result.scanOrder || null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [displayedJobId, publicUserActiveJobs]);

  useEffect(() => {
    if (!loginChallenge || loginStatus === "APPROVED" || loginStatus === "USED" || loginStatus === "EXPIRED") return;

    const poll = async () => {
      try {
        const data = await apiFetch<PublicLoginPollResponse>(`/api/tg-login/challenge/${loginChallenge.id}?purpose=user`);
        setLoginStatus(data.status);
        if (data.status === "APPROVED") {
          await refreshPublicUser();
          toast.success(t.loginSuccess);
          setLoginOpen(false);
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t.loginFailed);
      }
    };

    const timer = window.setInterval(() => void poll(), 2_000);
    void poll();
    return () => window.clearInterval(timer);
  }, [loginChallenge, loginStatus, refreshPublicUser, t.loginFailed, t.loginSuccess]);

  useEffect(() => {
    const firstTimer = window.setTimeout(() => void refreshBuffStats(), 0);
    const timer = window.setInterval(() => void refreshBuffStats(), BUFF_POLL_INTERVAL_MS);
    return () => {
      window.clearTimeout(firstTimer);
      window.clearInterval(timer);
    };
  }, [refreshBuffStats]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (pendingBuffBurstCountRef.current <= 0) return;

      setBuffBursts((current) => {
        if (pendingBuffBurstCountRef.current <= 0 || current.length >= MAX_ACTIVE_BUFF_BURSTS) return current;

        pendingBuffBurstCountRef.current -= 1;
        const id = buffBurstIdRef.current + 1;
        buffBurstIdRef.current = id;
        const offset = Math.round((Math.random() * 2 - 1) * 84);
        const burst: BuffBurst = {
          id,
          label: buffReceivedLabelRef.current || t.buffReceived,
          offset,
        };

        window.setTimeout(() => {
          setBuffBursts((latest) => latest.filter((item) => item.id !== id));
        }, BUFF_BURST_LIFETIME_MS);

        return [...current, burst];
      });
    }, BUFF_BURST_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [t.buffReceived]);

  const remainingText = result?.expiresAt ? formatRemaining(result.expiresAt, now, t) : "";
  const elapsedSeconds = extractStartedAt ? Math.max(0, Math.floor((now - extractStartedAt) / 1000)) : 0;
  const heatmapCounts = mockMode ? countActivity(activity) : activityCounts;
  const heatmapCountsByChannel = mockMode ? countActivityByChannel(activity) : activityCountsByChannel;
  const guardCreateToken = result?.guardCreateToken || "";
  const loginExpiresAtMs = loginChallenge?.expiresAt ? new Date(loginChallenge.expiresAt).getTime() : 0;
  const loginRemainingSeconds = loginExpiresAtMs ? Math.max(0, Math.ceil((loginExpiresAtMs - now) / 1000)) : 0;
  const loginCommand = loginChallenge ? `/login ${loginChallenge.code}` : "/login --------";
  const effectiveExtractChannel: ExtractChannel = userIsPremium ? "premium" : "public";
  const activeAccountJobCount = publicUserActiveJobs.filter((job) => job.status === "queued" || job.status === "running").length;
  const maxAccountJobs = userIsPremium ? PREMIUM_USER_MAX_ACTIVE_EXTRACT_JOBS : NORMAL_USER_MAX_ACTIVE_EXTRACT_JOBS;
  const accountTaskLimitReached = Boolean(publicUser && activeAccountJobCount >= maxAccountJobs);
  const publicWalletAvailable = publicUserWallet?.availableBalance ?? 0;
  const autoPublishBlocked = extractMethod === "upi" && autoPublishScanOrder && (!publicUser || publicWalletAvailable < SCAN_ORDER_PRICE);
  const showTaskListInCard = Boolean(publicUser && contentView === "tasks");
  const taskTabCount = useMemo(() => {
    if (taskPagination) return taskCounts.all;
    const countedLiveIds = new Set(publicUserHistory.map((item) => item.jobId));
    return publicUserHistory.length + publicUserActiveJobs.filter((job) => !countedLiveIds.has(job.jobId)).length;
  }, [publicUserActiveJobs, publicUserHistory, taskCounts.all, taskPagination]);
  const displayedExtractJob = useMemo(() => {
    if (displayedJobId) {
      const job = publicUserActiveJobs.find((item) => item.jobId === displayedJobId);
      if (job) return job;
    }
    if (activeJobId) {
      const job = publicUserActiveJobs.find((item) => item.jobId === activeJobId);
      if (job) return job;
    }
    return failedJob;
  }, [activeJobId, displayedJobId, failedJob, publicUserActiveJobs]);
  const displayedAccountEmail = displayedExtractJob?.accountEmail || displayedExtractJob?.result?.accountEmail || result?.accountEmail || null;
  const displayedAccountPhone = displayedExtractJob?.accountPhone || displayedExtractJob?.result?.accountPhone || result?.accountPhone || null;
  const debugLogJobId = ENABLE_EXTRACT_DEBUG_LOGS ? (activeJobId || displayedJobId || failedJob?.jobId || null) : null;

  const refreshExtractDebugLogs = useCallback(async (jobId = debugLogJobId) => {
    if (!ENABLE_EXTRACT_DEBUG_LOGS || !jobId || jobId.startsWith("local-error-")) {
      setExtractDebugLogs([]);
      setExtractDebugLogError(null);
      return;
    }
    try {
      const data = await apiFetch<UpiExtractDebugLogsResponse>(`/api/upi-extract/logs?jobId=${encodeURIComponent(jobId)}`);
      setExtractDebugLogs(data.logs || []);
      setExtractDebugLogError(null);
    } catch (error) {
      setExtractDebugLogError(error instanceof Error ? error.message : t.debugLogsError);
    }
  }, [debugLogJobId, t.debugLogsError]);

  useEffect(() => {
    if (!ENABLE_EXTRACT_DEBUG_LOGS || !debugLogJobId) {
      const clearTimer = window.setTimeout(() => {
        setExtractDebugLogs([]);
        setExtractDebugLogError(null);
      }, 0);
      return () => window.clearTimeout(clearTimer);
    }

    const firstTimer = window.setTimeout(() => void refreshExtractDebugLogs(debugLogJobId), 0);
    const timer = window.setInterval(() => void refreshExtractDebugLogs(debugLogJobId), 1_000);
    return () => {
      window.clearTimeout(firstTimer);
      window.clearInterval(timer);
    };
  }, [debugLogJobId, refreshExtractDebugLogs]);


  const checkTaskSubscription = useCallback(async (jobId: string) => {
    const targetJobId = String(jobId || "").trim();
    if (!targetJobId) return;
    const lastAt = subscriptionCheckLastAtByJobId[targetJobId] || 0;
    if (Date.now() - lastAt < 5_000) {
      toast.info(t.subscriptionCheckCooldown);
      return;
    }
    setSubscriptionCheckLastAtByJobId((current) => ({ ...current, [targetJobId]: Date.now() }));
    setSubscriptionCheckingJobId(targetJobId);
    try {
      const job = await apiFetch<UpiExtractJob>("/api/upi-extract/user/subscription-check", {
        method: "POST",
        body: JSON.stringify({ jobId: targetJobId }),
      });
      if (job.status === "queued" || job.status === "running") {
        setPublicUserActiveJobs((current) => mergeExtractJobs(current, [job]));
      } else {
        setPublicUserHistory((current) => current.map((item) => item.jobId === job.jobId ? {
          ...item,
          subscriptionPlan: job.subscriptionPlan ?? item.subscriptionPlan,
          subscriptionIsPlus: job.subscriptionIsPlus ?? item.subscriptionIsPlus,
          subscriptionCheckedAt: job.subscriptionCheckedAt || item.subscriptionCheckedAt,
          subscriptionCheckError: job.subscriptionCheckError ?? item.subscriptionCheckError,
          accountEmail: job.accountEmail || job.result?.accountEmail || item.accountEmail || null,
          accountPhone: job.accountPhone || job.result?.accountPhone || item.accountPhone || null,
          updatedAt: job.updatedAt || item.updatedAt,
        } : item));
      }
      if (job.subscriptionCheckError) {
        toast.error(compactFailureMessage(job.subscriptionCheckError, t) || t.subscriptionCheckFailed);
      } else {
        toast.success(t.subscriptionCheckSuccess(job.subscriptionPlan || (job.subscriptionIsPlus ? "plus" : "unknown")));
      }
      void refreshPublicUser();
    } catch (error) {
      toast.error(error instanceof Error ? compactFailureMessage(error.message, t) : t.subscriptionCheckFailed);
    } finally {
      setSubscriptionCheckingJobId(null);
    }
  }, [refreshPublicUser, subscriptionCheckLastAtByJobId, t]);

  const copyText = useCallback(async (text: string, successMessage: string) => {
    try {
      if (window.navigator.clipboard?.writeText) {
        await window.navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "true");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }
      toast.success(successMessage);
    } catch {
      toast.error(t.copyFailed);
    }
  }, [t.copyFailed]);

  const createGuard = useCallback(async (ttlHours: number) => {
    if (!guardCreateToken) {
      toast.error(t.guardCreateUnavailable);
      return;
    }

    try {
      setCreatingGuard(true);
      const guard = mockMode
        ? makeMockGuard(ttlHours)
        : await apiFetch<UpiGuardInfo>("/api/upi-extract/guard", {
          method: "POST",
          body: JSON.stringify({ guardCreateToken, ttlHours }),
        });
      setCreatedGuard(guard);
      await copyText(guard.guardId, t.guardCreated);
      void refreshActivity();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t.guardCreateUnavailable);
    } finally {
      setCreatingGuard(false);
    }
  }, [copyText, guardCreateToken, mockMode, refreshActivity, t.guardCreateUnavailable, t.guardCreated]);

  const completeGuard = useCallback(async (guardId: string) => {
    if (!guardId.trim()) return;
    try {
      setCompletingGuard(true);
      const guard = mockMode
        ? { ...(createdGuard || makeMockGuard(1, guardId)), status: "COMPLETED" as const }
        : await apiFetch<UpiGuardInfo>("/api/upi-extract/guard", {
          method: "PATCH",
          body: JSON.stringify({ guardId }),
        });
      if (createdGuard?.guardId === guard.guardId) setCreatedGuard(guard);
      if (activeGuardId === guard.guardId) setActiveGuardId(null);
      toast.success(t.guardCompleted);
      void refreshActivity();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t.guardCreateUnavailable);
    } finally {
      setCompletingGuard(false);
    }
  }, [activeGuardId, createdGuard, mockMode, refreshActivity, t.guardCompleted, t.guardCreateUnavailable]);

  const publishScanOrder = useCallback(async (token: string) => {
    if (!token) {
      toast.error(t.scanOrderUnavailable);
      return;
    }
    if (!publicUser) {
      toast.error(t.scanOrderLoginRequired);
      return;
    }
    if ((publicUserWallet?.availableBalance ?? 0) < SCAN_ORDER_PRICE) {
      toast.error(t.scanOrderInsufficientBalance);
      return;
    }

    try {
      setPublishingScanOrder(true);
      const order = mockMode
        ? makeMockScanOrder()
        : await apiFetch<PublicOrder>("/api/upi-extract/scan-order", {
          method: "POST",
          body: JSON.stringify({ scanOrderCreateToken: token }),
        });
      setPublishedScanOrder(order);
      setResult((current) => current ? { ...current, scanOrder: order, scanOrderCreateToken: undefined } : current);
      if (displayedJobId) {
        setPublicUserActiveJobs((current) => current.map((job) => job.jobId === displayedJobId && job.result
          ? { ...job, result: { ...job.result, scanOrder: order, scanOrderCreateToken: undefined } }
          : job));
      }
      toast.success(t.scanOrderPublished);
      void refreshPublicUser();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t.scanOrderPublishFailed);
    } finally {
      setPublishingScanOrder(false);
    }
  }, [displayedJobId, mockMode, publicUser, publicUserWallet?.availableBalance, refreshPublicUser, t.scanOrderInsufficientBalance, t.scanOrderLoginRequired, t.scanOrderPublishFailed, t.scanOrderPublished, t.scanOrderUnavailable]);

  const cancelScanOrder = useCallback(async (order: PublicOrder) => {
    if (!publicUser) {
      toast.error(t.scanOrderLoginRequired);
      return;
    }

    try {
      setCancellingScanOrder(true);
      const updated = mockMode
        ? { ...order, status: "CANCELLED" as const, failedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
        : await apiFetch<PublicOrder>(`/api/upi-extract/scan-order?orderId=${encodeURIComponent(order.id)}${displayedJobId ? `&jobId=${encodeURIComponent(displayedJobId)}` : ""}`, {
          method: "DELETE",
        });
      setPublishedScanOrder(updated);
      setResult((current) => current ? { ...current, scanOrder: updated } : current);
      if (displayedJobId) {
        setPublicUserActiveJobs((current) => current.map((job) => job.jobId === displayedJobId && job.result
          ? { ...job, result: { ...job.result, scanOrder: updated } }
          : job));
      }
      toast.success(t.scanOrderCancelledToast);
      void refreshPublicUser();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t.scanOrderPublishFailed);
    } finally {
      setCancellingScanOrder(false);
    }
  }, [displayedJobId, mockMode, publicUser, refreshPublicUser, t.scanOrderCancelledToast, t.scanOrderLoginRequired, t.scanOrderPublishFailed]);

  const pollJob = useCallback(async (jobId: string) => {
    for (let count = 0; ; count += 1) {
      if (count > 0) await sleep(POLL_INTERVAL_MS);
      const job = await apiFetch<UpiExtractJob>(`/api/upi-extract?jobId=${encodeURIComponent(jobId)}`);
      if (job.cancelled) {
        clearCurrentJob();
        if (publicUser) setPublicUserActiveJobs((current) => current.filter((item) => item.jobId !== job.jobId));
        void refreshActivity();
        return job;
      }
      if (!publicUser) saveCurrentJob(job);
      if (publicUser) setPublicUserActiveJobs((current) => mergeExtractJobs(current, [job]));
      void refreshActivity();
      setActiveJobId(job.jobId);
      setActiveUntilSuccess(Boolean(job.untilSuccess));
      setUntilSuccessRetryCount(Math.max(0, Number(job.retryCount || 0)));
      if (job.untilSuccess && job.error && job.status === "running") {
        setUntilSuccessLastError(compactFailureMessage(job.error, t, job.extractMethod || job.result?.extractMethod));
      }
      if (job.progress) setProgress(job.progress);
      if (job.status === "completed" && job.result) {
        setProgress(job.progress || { stage: "completed", percent: 100 });
        return job;
      }
      if (job.status === "failed") return job;
    }
  }, [publicUser, refreshActivity, t]);

  const cancelExtractJob = useCallback(async (jobId?: string) => {
    const targetJobId = jobId || activeJobId;
    if (!targetJobId) return;
    try {
      setCancellingUntilSuccess(true);
      setCancellingJobId(targetJobId);
      const job = await apiFetch<UpiExtractJob>(`/api/upi-extract?jobId=${encodeURIComponent(targetJobId)}`, {
        method: "DELETE",
      });
      if (!job.cancelled) {
        if (!publicUser) saveCurrentJob(job);
        setPublicUserActiveJobs((current) => current.map((item) => item.jobId === job.jobId ? job : item));
        setFailedJob(toSavedJob(job));
        toast.error(t.cancelTaskFailed);
        void refreshActivity();
        void refreshPublicUser();
        return;
      }
      if (!publicUser) {
        clearCurrentJob();
      }
      setPublicUserActiveJobs((current) => current.filter((item) => item.jobId !== job.jobId));
      setPublicUserHistory((current) => current.filter((item) => item.jobId !== job.jobId));
      if (!jobId || activeJobId === targetJobId) {
        setResult(null);
        setDisplayedJobId(null);
        setFailedJob(job.cancelled ? null : toSavedJob(job));
        setProgress(null);
        setExtractStartedAt(null);
        setActiveJobId(null);
        setActiveUntilSuccess(false);
      }
      toast.success(t.untilSuccessCancelled);
      void refreshActivity();
      void refreshPublicUser();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t.failedToast);
    } finally {
      setCancellingUntilSuccess(false);
      setCancellingJobId(null);
      setLoading(false);
    }
  }, [activeJobId, publicUser, refreshActivity, refreshPublicUser, t.cancelTaskFailed, t.failedToast, t.untilSuccessCancelled]);

  useEffect(() => {
    if (mockMode || restoredJobRef.current) return;
    if (!publicUserLoaded) return;

    const timer = window.setTimeout(() => {
      if (restoredJobRef.current) return;
      restoredJobRef.current = true;
      if (publicUser) {
        setRestorePending(false);
        return;
      }
      const saved = loadCurrentJob();
      if (!saved) {
        setRestorePending(false);
        return;
      }

      setResult(null);
      setDisplayedJobId(null);
      setFailedJob(null);
      setActiveJobId(saved.jobId);
      setExtractMethod(normalizePaymentExtractMethod(saved.extractMethod || saved.result?.extractMethod));
      setActiveUntilSuccess(Boolean(saved.untilSuccess));
      setUntilSuccessRetryCount(Math.max(0, Number(saved.retryCount || 0)));
      setUntilSuccessLastError(saved.untilSuccess && saved.error ? compactFailureMessage(saved.error, t, saved.extractMethod || saved.result?.extractMethod) : null);

      if (saved.status === "completed" && saved.result) {
        setResult(saved.result);
        setDisplayedJobId(saved.jobId);
        setPublishedScanOrder(saved.result.scanOrder || null);
        setProgress({ stage: "completed", percent: 100 });
        setExtractStartedAt(new Date(saved.createdAt).getTime());
        setLoading(false);
        setActiveJobId(null);
        setActiveUntilSuccess(false);
        setRestorePending(false);
        return;
      }

      if (saved.status === "failed") {
        setFailedJob(saved);
        setProgress(null);
        setExtractStartedAt(null);
        setLoading(false);
        setActiveJobId(null);
        setActiveUntilSuccess(false);
        setRestorePending(false);
        return;
      }

      setLoading(true);
      setExtractStartedAt(new Date(saved.createdAt).getTime());
      setProgress(saved.progress || { stage: "queued", percent: 4 });
      setRestorePending(false);

      void (async () => {
        try {
          const finalJob = await pollJob(saved.jobId);
          saveCurrentJob(finalJob);
          if (finalJob.status === "completed" && finalJob.result) {
            setResult(finalJob.result);
            setDisplayedJobId(finalJob.jobId);
            setPublishedScanOrder(finalJob.result.scanOrder || null);
            setFailedJob(null);
            setProgress(finalJob.progress || { stage: "completed", percent: 100 });
            setActiveJobId(null);
            setActiveUntilSuccess(false);
          } else if (finalJob.status === "failed") {
            setResult(null);
            setDisplayedJobId(null);
            setFailedJob(toSavedJob(finalJob));
            setProgress(null);
            setExtractStartedAt(null);
            setActiveJobId(null);
            setActiveUntilSuccess(false);
          }
          void refreshPublicUser();
        } catch (error) {
          const failed: SavedExtractJob = {
            ...saved,
            status: "failed",
            updatedAt: new Date().toISOString(),
            error: error instanceof Error ? error.message : getFailedToastForMethod(saved.extractMethod || saved.result?.extractMethod, t),
          };
          saveCurrentJob(failed);
          setFailedJob(failed);
          setProgress(null);
          setExtractStartedAt(null);
        } finally {
          setLoading(false);
          setRestorePending(false);
        }
      })();
    }, 0);

    return () => window.clearTimeout(timer);
  }, [mockMode, pollJob, publicUser, publicUserLoaded, refreshPublicUser, t, t.failedToast]);

  async function checkCustomProxy(role: CustomProxyRole) {
    if (!customProxyConfigEnabled) return;
    const proxyUrl = (role === "checkout" ? customCheckoutProxy : customProviderProxy).trim();
    if (!proxyUrl) {
      toast.error(t.customProxyNeedInput);
      return;
    }

    setCustomProxyCheck((current) => ({ ...current, [role]: { checking: true } }));
    try {
      const data = await apiFetch<CustomProxyCheckResponse>("/api/upi-extract/proxy-check", {
        method: "POST",
        body: JSON.stringify({ proxyUrl }),
      });
      setCustomProxyCheck((current) => ({ ...current, [role]: { checking: false, result: data.result } }));
      if (data.result.ok) toast.success(t.customProxyOk);
      else toast.error(data.result.error || data.result.warnings?.[0] || t.customProxyFailed);
    } catch (error) {
      const message = error instanceof Error ? error.message : t.customProxyFailed;
      setCustomProxyCheck((current) => ({ ...current, [role]: { checking: false, error: message } }));
      toast.error(message);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    switchCardPage("extract", { immediate: true });
    const submitExtractMethod = paymentMethodSelectionEnabled ? extractMethod : DEFAULT_PAYMENT_EXTRACT_METHOD;
    if (!paymentMethodSelectionEnabled && extractMethod !== submitExtractMethod) setExtractMethod(submitExtractMethod);
    const isGuardMode = mode === "guard";
    const credential = sessionToken.trim();
    const guardId = guardIdInput.trim();
    if (!isGuardMode && !credential) {
      toast.error(t.needToken);
      return;
    }
    if (isGuardMode && !guardId) {
      toast.error(t.needGuardId);
      return;
    }
    if (accountTaskLimitReached) {
      toast.error(userIsPremium ? t.premiumTaskLimitHint : t.normalTaskLimitHint);
      return;
    }
    const shouldAutoPublishScanOrder = submitExtractMethod === "upi" && autoPublishScanOrder;
    if (shouldAutoPublishScanOrder && !publicUser) {
      toast.error(t.scanOrderLoginRequired);
      return;
    }
    if (shouldAutoPublishScanOrder && publicWalletAvailable < SCAN_ORDER_PRICE) {
      toast.error(t.scanOrderInsufficientBalance);
      return;
    }

    const startedAt = now;
    try {
      setLoading(true);
      setResult(null);
      setDisplayedJobId(null);
      setFailedJob(null);
      setExtractDebugLogs([]);
      setExtractDebugLogError(null);
      setCreatedGuard(null);
      setPublishedScanOrder(null);
      setActiveGuardId(isGuardMode ? guardId : null);
      setActiveJobId(null);
      setActiveUntilSuccess(false);
      setUntilSuccessRetryCount(0);
      setUntilSuccessLastError(null);
      setSuppressCompletedAutoView(false);
      saveSuppressCompletedAutoView(false);
      setExtractStartedAt(startedAt);
      setProgress({ stage: "queued", percent: 4 });

      if (mockMode) {
        const mockJob = addMockActivity("queued", isGuardMode ? "storage" : "direct", effectiveExtractChannel, submitExtractMethod);
        if (!isGuardMode) setSessionToken("");
        await sleep(350);
        updateMockActivity(mockJob.jobId, "running");
        const mockStages: UpiExtractProgress[] = [
          { stage: "validating", percent: 12 },
          { stage: "checkout", percent: 26 },
          { stage: "stripe_init", percent: 40 },
          { stage: "stripe_confirm", percent: 56 },
          { stage: "approval", percent: 70 },
          { stage: "waiting_qr", percent: 84 },
          { stage: "rendering_qr", percent: 96 },
        ];
        for (const stage of mockStages) {
          setProgress(stage);
          await sleep(450);
        }
        updateMockActivity(mockJob.jobId, "completed");
        setProgress({ stage: "completed", percent: 100 });
        const mockResult = makeMockResult(false, submitExtractMethod);
        if (shouldAutoPublishScanOrder) {
          mockResult.scanOrder = makeMockScanOrder();
        }
        const saved: SavedExtractJob = {
          jobId: mockJob.jobId,
          status: "completed",
          source: isGuardMode ? "storage" : "direct",
          channel: effectiveExtractChannel,
          extractMethod: submitExtractMethod,
          untilSuccess: effectiveExtractChannel === "premium" && untilSuccess,
          retryCount: 0,
          createdAt: mockJob.createdAt,
          updatedAt: new Date().toISOString(),
          progress: { stage: "completed", percent: 100 },
          result: mockResult,
        };
        saveCurrentJob(saved);
        setResult(mockResult);
        setDisplayedJobId(saved.jobId);
        setPublishedScanOrder(mockResult.scanOrder || null);
        toast.success(getSuccessToastForMethod(submitExtractMethod, t));
        return;
      }

      const job = await apiFetch<UpiExtractJob>("/api/upi-extract", {
        method: "POST",
        body: JSON.stringify(isGuardMode
          ? { guardId }
          : {
            sessionToken: credential,
            extractMethod: submitExtractMethod,
            autoPublishScanOrder: shouldAutoPublishScanOrder,
            untilSuccess: Boolean(userIsPremium && untilSuccess),
            approvalParallelism: customProxyConfigEnabled ? normalizeApprovalParallelism(approvalParallelism) : 1,
            ...(customProxyConfigEnabled
              ? {
                checkoutProxyUrl: customCheckoutProxy.trim(),
                providerProxyUrl: customProviderProxy.trim(),
              }
              : {}),
          }),
      });
      setActiveJobId(job.jobId);
      setActiveUntilSuccess(Boolean(job.untilSuccess));
      if (!isGuardMode) setSessionToken("");
      void refreshActivity();
      saveCurrentJob(job);
      if (job.progress) setProgress(job.progress);
      if (publicUser) {
        setPublicUserActiveJobs((current) => [job, ...current.filter((item) => item.jobId !== job.jobId)]);
        toast.success(submitExtractMethod === "ideal" ? t.submittedIdeal : t.submitted);
        void refreshPublicUser();
        return;
      }
      const finalJob = await pollJob(job.jobId);
      saveCurrentJob(finalJob);
      if (finalJob.status === "completed" && finalJob.result) {
        setResult(finalJob.result);
        setDisplayedJobId(finalJob.jobId);
        setPublishedScanOrder(finalJob.result.scanOrder || null);
        setFailedJob(null);
        setActiveJobId(null);
        setActiveUntilSuccess(false);
        if (finalJob.result.scanOrderError) toast.warning(finalJob.result.scanOrderError);
        toast.success(getSuccessToastForMethod(finalJob.result.extractMethod || submitExtractMethod, t));
      } else if (finalJob.status === "failed") {
        setResult(null);
        setDisplayedJobId(null);
        setFailedJob(toSavedJob(finalJob));
        setActiveJobId(null);
        setActiveUntilSuccess(false);
        if (finalJob.cancelled) {
          toast.success(t.untilSuccessCancelled);
        } else {
          toast.error(compactFailureMessage(finalJob.error, t, finalJob.extractMethod || finalJob.result?.extractMethod || submitExtractMethod) || getFailedToastForMethod(finalJob.extractMethod || submitExtractMethod, t));
        }
      }
      void refreshPublicUser();
    } catch (error) {
      setProgress(null);
      setExtractStartedAt(null);
      setActiveJobId(null);
      setActiveUntilSuccess(false);
      const fallbackFailureToast = getFailedToastForMethod(submitExtractMethod, t);
      const message = compactFailureMessage(error instanceof Error ? error.message : fallbackFailureToast, t) || fallbackFailureToast;
      setFailedJob({
        jobId: `local-error-${startedAt}`,
        status: "failed",
        channel: effectiveExtractChannel,
        extractMethod: submitExtractMethod,
        createdAt: new Date(startedAt).toISOString(),
        updatedAt: new Date().toISOString(),
        error: message,
      });
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }

  function addMockActivity(status: ActivityStatus, source: UpiExtractActivity["source"] = "direct", channel: ExtractChannel = "public", method: PaymentExtractMethod = "upi") {
    const item: UpiExtractActivity = {
      jobId: `mock-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      seq: nextMockSeq(activity),
      status,
      source,
      channel,
      extractMethod: method,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    setActivity((current) => [...current.slice(-319), item]);
    return item;
  }

  function updateMockActivity(jobId: string, status: ActivityStatus) {
    setActivity((current) => current.map((item) => item.jobId === jobId ? { ...item, status, updatedAt: new Date().toISOString() } : item));
  }

  function startNewExtraction() {
    setExtractMethod(DEFAULT_PAYMENT_EXTRACT_METHOD);
    switchCardPage("extract", { immediate: true });
    clearCurrentJob();
    setResult(null);
    setDisplayedJobId(null);
    setFailedJob(null);
    setExtractDebugLogs([]);
    setExtractDebugLogError(null);
    setProgress(null);
    setExtractStartedAt(null);
    setLoading(false);
    setCreatedGuard(null);
    setPublishedScanOrder(null);
    setActiveGuardId(null);
    setActiveJobId(null);
    setActiveUntilSuccess(false);
    setUntilSuccessRetryCount(0);
    setUntilSuccessLastError(null);
    setSuppressCompletedAutoView(true);
    saveSuppressCompletedAutoView(true);
    setCancellingUntilSuccess(false);
    setCancellingJobId(null);
  }

  const debugLogPanel = ENABLE_EXTRACT_DEBUG_LOGS && debugLogJobId ? (
    <ExtractionDebugLogPanel
      logs={extractDebugLogs}
      error={extractDebugLogError}
      labels={t}
      onRefresh={() => void refreshExtractDebugLogs(debugLogJobId)}
    />
  ) : null;

  return (
    <div className={cn(
      "min-h-dvh bg-soft text-foreground transition-colors duration-500"
    )}>
      <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col items-center justify-center gap-5 px-5 py-6">
        <div className="text-center">
          <h1 className="text-4xl font-semibold tracking-tight md:text-5xl">
            <span className="text-brand">UPI</span> {t.title}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t.subtitle}
          </p>
          <p className="mt-1 text-xs font-medium text-muted-foreground">
            {extractCapacity ? t.channelCapacityNote(
              extractCapacity.public.concurrency,
              extractCapacity.public.proxyCount,
              extractCapacity.premium.concurrency,
              extractCapacity.premium.proxyCount
            ) : t.channelCapacityLoading}
          </p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            <PrivacyInfoDialog labels={t} />
            <FaqDialog labels={t} content={getLocalizedFaqContent(siteSettings, lang)} />
            <SuccessRateDialog
              labels={t}
              guideOpenCount={guideOpenCount}
              onOpenGuide={recordGuideOpen}
            />
            <BuffButton
              labels={t}
              buffCount={buffCount}
              bursts={buffBursts}
              onSendBuff={sendBuff}
            />
          </div>
          <a
            href={OPEN_SOURCE_REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="mx-auto mt-4 flex w-full max-w-xl items-center justify-between gap-3 rounded-2xl border border-brand/35 bg-brand/10 px-4 py-3 text-left shadow-sm shadow-brand/10 transition hover:-translate-y-0.5 hover:border-brand/55 hover:bg-brand/15 hover:shadow-md"
          >
            <span className="flex min-w-0 items-center gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-background text-brand shadow-sm ring-1 ring-brand/20">
                <span className="text-sm font-black leading-none">&lt;/&gt;</span>
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-bold text-foreground">
                  {lang === "zh" ? "代码已开源" : "Source code is open"}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  Tonwed/gpt-upi
                </span>
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-2 rounded-full bg-background px-3 py-1.5 text-xs font-semibold text-foreground shadow-sm ring-1 ring-border">
              <StarIcon className="size-4 fill-brand text-brand" />
              {githubStars !== null
                ? new Intl.NumberFormat(lang === "zh" ? "zh-CN" : "en-US").format(githubStars)
                : githubStarsFailed
                  ? "Stars"
                  : "..."}
              <ExternalLinkIcon className="size-3.5 text-muted-foreground" />
            </span>
          </a>
        </div>

        <ActivityHeatmap items={activity} counts={heatmapCounts} countsByChannel={heatmapCountsByChannel} labels={t} />

        <Card size="sm" className={cn(
          "w-full rounded-3xl bg-background shadow-sm"
        )}>
          <CardHeader className="pb-1">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="relative grid w-full grid-cols-2 rounded-2xl border border-border bg-muted/35 p-1 shadow-inner sm:max-w-xs">
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute left-1 top-1 h-[calc(100%-0.5rem)] w-[calc(50%-0.25rem)] rounded-xl bg-brand/18 shadow-sm shadow-brand/10 ring-1 ring-brand/20 transition-transform duration-300 ease-out will-change-transform",
                    pageView === "tasks" && "translate-x-full"
                  )}
                />
                <button
                  type="button"
                  className={cn(
                    "relative z-10 rounded-xl px-4 py-2 text-sm font-semibold transition-colors duration-300",
                    pageView === "extract" ? "text-brand" : "text-muted-foreground hover:text-foreground"
                  )}
                  onClick={() => switchCardPage("extract")}
                >
                  {t.extractView}
                </button>
                <button
                  type="button"
                  className={cn(
                    "relative z-10 inline-flex items-center justify-center rounded-xl px-4 py-2 text-sm font-semibold transition-colors duration-300",
                    pageView === "tasks" ? "text-brand" : "text-muted-foreground hover:text-foreground"
                  )}
                  onClick={() => publicUser ? switchCardPage("tasks") : void startPublicLogin(false)}
                >
                  {t.tasksView}
                  <span
                    className={cn(
                      "ml-2 inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-[11px] font-semibold leading-none transition-colors duration-300",
                      pageView === "tasks" ? "bg-brand/15 text-brand" : "bg-background text-muted-foreground"
                    )}
                  >
                    {taskTabCount}
                  </span>
                </button>
              </div>

              <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => publicUser ? setLoginOpen(true) : void startPublicLogin(false)}
                  className="inline-flex h-10 min-w-0 items-center gap-2 rounded-2xl border border-border bg-background/80 px-3 text-sm font-semibold shadow-sm backdrop-blur transition hover:bg-muted"
                >
                  <UserCircleIcon className="size-4 shrink-0 text-brand" />
                  <span className="max-w-36 truncate">{publicUser ? publicUser.displayName : t.accountLogin}</span>
                  {userIsPremium && <span className="shrink-0 rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-semibold text-brand">{getPublicUserPremiumLabel(publicUser, t)}</span>}
                </button>
                {publicUser && (
                  <button
                    type="button"
                    onClick={() => setWalletOpen(true)}
                    aria-label={`${t.walletBadge}: ${formatWalletDisplay(publicUserWallet?.availableBalance ?? 0)}`}
                    className="rounded-2xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    <Badge variant="secondary" className="h-10 rounded-2xl border border-border bg-background/80 px-3 text-sm font-semibold shadow-sm backdrop-blur transition hover:bg-muted">
                      <WalletIcon data-icon="inline-start" className="text-brand" />
                      <span className="tabular-nums">{formatWalletDisplay(publicUserWallet?.availableBalance ?? 0)}</span>
                    </Badge>
                  </button>
                )}
              </div>
            </div>
          </CardHeader>
          <AnimatedCardPage>
            {showTaskListInCard ? (
              <AccountTaskList
                jobs={publicUserActiveJobs}
                history={publicUserHistory}
                filter={taskFilter}
                counts={taskCounts}
                pagination={taskPagination}
                labels={t}
                now={now}
                cancellingJobId={cancellingJobId}
                subscriptionCheckingJobId={subscriptionCheckingJobId}
                transitionPhase={cardTransitionPhase}
                onFilterChange={(nextFilter) => {
                  setTaskFilter(nextFilter);
                  setTaskPage(1);
                }}
                onPageChange={setTaskPage}
                onViewJob={(job) => {
                  switchCardPage("extract");
                  setSuppressCompletedAutoView(false);
                  saveSuppressCompletedAutoView(false);
                  setResult(job.result || null);
                  setDisplayedJobId(job.result ? job.jobId : null);
                  setPublishedScanOrder(job.result?.scanOrder || null);
                  setFailedJob(job.status === "failed" ? toSavedJob(job) : null);
                  setProgress(job.progress || null);
                  setExtractStartedAt(new Date(job.createdAt).getTime());
                  setActiveJobId(job.status === "queued" || job.status === "running" ? job.jobId : null);
                  setActiveUntilSuccess(Boolean(job.untilSuccess));
                  setUntilSuccessRetryCount(Math.max(0, Number(job.retryCount || 0)));
                  setUntilSuccessLastError(job.error ? compactFailureMessage(job.error, t, job.extractMethod || job.result?.extractMethod) : null);
                }}
                onCancelJob={(jobId) => void cancelExtractJob(jobId)}
                onCheckSubscription={(jobId) => void checkTaskSubscription(jobId)}
              />
            ) : result ? (
              <ResultView
                result={result}
                now={now}
                remainingText={remainingText}
                copyText={copyText}
                startNewExtraction={startNewExtraction}
                labels={t}
                accountEmail={displayedAccountEmail}
                accountPhone={displayedAccountPhone}
                subscriptionPlan={displayedExtractJob?.subscriptionPlan}
                subscriptionIsPlus={displayedExtractJob?.subscriptionIsPlus}
                subscriptionCheckedAt={displayedExtractJob?.subscriptionCheckedAt}
                subscriptionCheckError={displayedExtractJob?.subscriptionCheckError}
                subscriptionChecking={Boolean(displayedJobId && subscriptionCheckingJobId === displayedJobId)}
                onCheckSubscription={displayedJobId ? () => void checkTaskSubscription(displayedJobId) : undefined}
                createdGuard={createdGuard}
                activeGuardId={activeGuardId}
                creatingGuard={creatingGuard}
                completingGuard={completingGuard}
                publicUser={effectivePublicUser}
                wallet={publicUserWallet}
                autoPublishScanOrder={autoPublishScanOrder}
                publishedScanOrder={publishedScanOrder}
                publishingScanOrder={publishingScanOrder}
                cancellingScanOrder={cancellingScanOrder}
                onCreateGuard={createGuard}
                onCompleteGuard={completeGuard}
                onPublishScanOrder={publishScanOrder}
                onCancelScanOrder={cancelScanOrder}
                debugLogPanel={debugLogPanel}
              />
            ) : failedJob ? (
              <FailureView
                job={failedJob}
                startNewExtraction={startNewExtraction}
                labels={t}
                debugLogPanel={debugLogPanel}
              />
            ) : restorePending ? (
              <RestoringView labels={t} />
            ) : extractionPaused && !loading ? (
              <MaintenanceView labels={t} />
            ) : (
              <CardContent className="pt-0">
              <form onSubmit={submit} className={cn("flex flex-col gap-3", cardPageStaggerClass(cardTransitionPhase))}>
                {false && <div className="mx-auto flex rounded-full border border-border bg-muted/50 p-1 text-sm">
                  <button
                    type="button"
                    onClick={() => setMode("token")}
                    disabled={loading}
                    className={cn("rounded-full px-4 py-1.5 font-medium transition", mode === "token" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
                  >
                    {t.tokenMode}
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode("guard")}
                    disabled={loading}
                    className={cn("rounded-full px-4 py-1.5 font-medium transition", mode === "guard" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
                  >
                    {t.guardMode}
                  </button>
                </div>}

                {paymentMethodSelectionEnabled && <div className="rounded-2xl border border-border bg-muted/35 p-3">
                  <div className="mb-2 text-sm font-semibold text-foreground">{t.paymentMethodTitle}</div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {(["upi", "ideal"] as const).map((method) => {
                      const selected = extractMethod === method;
                      return (
                        <button
                          key={method}
                          type="button"
                          disabled={loading}
                          onClick={() => {
                            setExtractMethod(method);
                            if (method === "ideal") {
                              setMode("token");
                              setAutoPublishScanOrder(false);
                            }
                          }}
                          className={cn(
                            "rounded-2xl border p-3 text-left transition",
                            selected ? "border-brand/50 bg-brand/10 shadow-sm" : "border-border bg-background/80 hover:bg-muted"
                          )}
                        >
                          <div className={cn("text-sm font-semibold", selected ? "text-brand" : "text-foreground")}>
                            {method === "ideal" ? t.idealMethod : t.upiMethod}
                          </div>
                          <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
                            {method === "ideal" ? t.idealMethodDesc : t.upiMethodDesc}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>}

                {mode === "token" && (
                  <div className="rounded-2xl border border-border bg-muted/40 px-3 py-2.5 text-left text-sm">
                    <div className="font-semibold">{t.howTitle}</div>
                    <div className="mt-1.5 flex flex-col gap-1 text-muted-foreground">
                      <p>
                        {t.step1Prefix}{" "}
                        <a href="https://chatgpt.com/" target="_blank" rel="noreferrer" className="font-medium text-brand underline-offset-4 hover:underline">
                          chatgpt.com
                        </a>{" "}
                        {t.step1Suffix}
                      </p>
                      <p>{t.step2}</p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-2 rounded-full bg-background"
                      onClick={() => copyText(AUTH_SESSION_URL, t.sessionUrlCopied)}
                    >
                      <CopyIcon data-icon="inline-start" />
                      {t.copySessionUrl}
                    </Button>
                  </div>
                )}

                <FieldGroup>
                  {mode === "token" ? (
                    <Field>
                      <FieldLabel htmlFor="upi-extract-session-token" className="sr-only">
                        Session Token
                      </FieldLabel>
                      <Textarea
                        id="upi-extract-session-token"
                        value={sessionToken}
                        onChange={(event) => setSessionToken(event.target.value)}
                        placeholder={t.tokenPlaceholder}
                        className="h-36 min-h-36 max-h-36 resize-none overflow-y-auto overscroll-contain break-all font-mono text-xs leading-relaxed [field-sizing:fixed]"
                        disabled={loading}
                      />
                    </Field>
                  ) : (
                    <Field>
                      <FieldLabel htmlFor="upi-extract-guard-id" className="sr-only">
                        Storage ID
                      </FieldLabel>
                      <Input
                        id="upi-extract-guard-id"
                        value={guardIdInput}
                        onChange={(event) => setGuardIdInput(event.target.value)}
                        placeholder={t.guardPlaceholder}
                        className="h-11 rounded-2xl font-mono text-sm"
                        disabled={loading}
                      />
                      <FieldDescription className="text-center">
                        {t.guardDescription}
                      </FieldDescription>
                    </Field>
                  )}
                </FieldGroup>

                {customProxyConfigEnabled && mode === "token" && (
                  <details className="group rounded-2xl border border-border bg-muted/30 p-3">
                    <summary className="flex cursor-pointer list-none items-start justify-between gap-3 text-sm font-semibold text-foreground marker:hidden">
                      <span>{t.customProxyTitle}</span>
                      <ChevronDownIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
                    </summary>
                    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{t.customProxyDesc}</p>
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      {([
                        { role: "checkout" as const, label: t.customCheckoutProxy, value: customCheckoutProxy, setValue: setCustomCheckoutProxy },
                        { role: "provider" as const, label: t.customProviderProxy, value: customProviderProxy, setValue: setCustomProviderProxy },
                      ]).map((item) => {
                        const checkState = customProxyCheck[item.role];
                        const checkResult = checkState?.result;
                        const countryText = [checkResult?.countryCode, checkResult?.country, checkResult?.city].filter(Boolean).join(" / ");
                        return (
                          <div key={item.role} className="rounded-2xl border border-border bg-background/80 p-3">
                            <Field>
                              <FieldLabel htmlFor={`custom-${item.role}-proxy`}>{item.label}</FieldLabel>
                              <Input
                                id={`custom-${item.role}-proxy`}
                                value={item.value}
                                onChange={(event) => {
                                  item.setValue(event.target.value);
                                  setCustomProxyCheck((current) => ({ ...current, [item.role]: undefined }));
                                }}
                                placeholder={t.customProxyPlaceholder}
                                className="h-10 rounded-xl font-mono text-xs"
                                disabled={loading}
                                spellCheck={false}
                              />
                            </Field>
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="h-8 rounded-xl bg-background"
                                disabled={loading || Boolean(checkState?.checking)}
                                onClick={() => void checkCustomProxy(item.role)}
                              >
                                {checkState?.checking ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <RefreshCwIcon data-icon="inline-start" />}
                                {checkState?.checking ? t.customProxyChecking : t.customProxyCheck}
                              </Button>
                              {checkResult && (
                                <Badge variant={checkResult.ok ? "default" : "destructive"} className="rounded-full">
                                  {checkResult.ok ? t.customProxyOk : t.customProxyFailed}
                                </Badge>
                              )}
                            </div>
                            {checkResult && (
                              <div className="mt-2 space-y-1 rounded-xl bg-muted/45 px-3 py-2 text-xs text-muted-foreground">
                                <div>{t.customProxyExit(checkResult.ip || "", countryText, Number(checkResult.latencyMs || 0))}</div>
                                <div>ChatGPT HTTP {checkResult.chatgptStatus ?? "-"} ? Stripe HTTP {checkResult.stripeStatus ?? "-"}</div>
                                {checkResult.error && <div className="text-destructive">{checkResult.error}</div>}
                                {checkResult.warnings?.slice(0, 2).map((warning) => <div key={warning} className="text-warning">{warning}</div>)}
                              </div>
                            )}
                            {checkState?.error && !checkResult && (
                              <div className="mt-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{checkState.error}</div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    <div className="mt-3 rounded-2xl border border-border bg-background/80 p-3">
                      <Field>
                        <FieldLabel htmlFor="approval-parallelism">{t.approvalParallelismLabel}</FieldLabel>
                        <Input
                          id="approval-parallelism"
                          type="number"
                          min={1}
                          step={1}
                          value={approvalParallelism}
                          onChange={(event) => setApprovalParallelism(normalizeApprovalParallelism(event.target.value))}
                          className="h-10 w-28 rounded-xl font-mono text-sm"
                          disabled={loading}
                        />
                        <FieldDescription>
                          {t.approvalParallelismDesc}
                        </FieldDescription>
                      </Field>
                    </div>
                  </details>
                )}

                {(loading || (activeJobId && progress && !result && !failedJob)) && (
                  <ExtractionProgressPanel
                    progress={progress}
                    elapsedSeconds={elapsedSeconds}
                    labels={t}
                    extractMethod={displayedExtractJob?.extractMethod || displayedExtractJob?.result?.extractMethod || extractMethod}
                    accountEmail={displayedAccountEmail}
                    accountPhone={displayedAccountPhone}
                    untilSuccess={activeUntilSuccess}
                    retryCount={untilSuccessRetryCount}
                    lastError={untilSuccessLastError}
                    cancelling={cancellingUntilSuccess}
                    onCancel={() => void cancelExtractJob()}
                  />
                )}

                {debugLogPanel}

                <div className={cn(
                  "rounded-2xl border p-3",
                  userIsPremium ? "border-brand/30 bg-brand/10" : "border-border bg-muted/40"
                )}>
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="font-semibold text-foreground">{t.untilSuccess}</div>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        {t.untilSuccessDesc}
                      </p>
                    </div>
                    <Switch
                      checked={Boolean(userIsPremium && untilSuccess)}
                      onCheckedChange={(checked) => void updateAutoRetryUntilSuccess(Boolean(checked))}
                      disabled={loading || publicUserSettingSaving || !userIsPremium}
                      aria-label={t.untilSuccess}
                    />
                  </div>
                </div>

                {accountTaskLimitReached && (
                  <div className="flex gap-2 rounded-2xl border border-warning/30 bg-warning/10 p-3 text-sm text-warning">
                    <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
                    <span>{userIsPremium ? t.premiumTaskLimitHint : t.normalTaskLimitHint}</span>
                  </div>
                )}

                {extractMethod === "upi" && (
                <div className="rounded-2xl border border-border bg-muted/40 p-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="font-semibold text-foreground">{t.autoPublishScanOrder}</div>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        {t.autoPublishScanOrderDesc}
                      </p>
                    </div>
                    <Switch
                      checked={autoPublishScanOrder}
                      onCheckedChange={setAutoPublishScanOrder}
                      disabled={loading}
                      aria-label={t.autoPublishScanOrder}
                    />
                  </div>
                  {autoPublishBlocked && (
                    <div className="mt-3 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
                      {!publicUser ? t.scanOrderLoginRequired : t.scanOrderInsufficientBalance}
                    </div>
                  )}
                </div>
                )}

                <Button type="submit" size="lg" disabled={loading || accountTaskLimitReached || autoPublishBlocked || (mode === "token" ? !sessionToken.trim() : !guardIdInput.trim())} className="h-10 rounded-xl">
                  {loading ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <SendIcon data-icon="inline-start" />}
                  {loading ? t.submitting : mode === "guard" ? t.submitGuard : paymentMethodSelectionEnabled && extractMethod === "ideal" ? t.submitIdeal : t.submit}
                </Button>
              </form>
              </CardContent>
            )}
          </AnimatedCardPage>
        </Card>
      </main>

      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none fixed right-1 top-0 z-50 h-dvh w-2 transition-opacity duration-200",
          overlayScrollbar.visible ? "opacity-100" : "opacity-0"
        )}
      >
        <div
          className="absolute right-0.5 w-1.5 rounded-full bg-muted-foreground/35 shadow-sm backdrop-blur-sm"
          style={{ top: overlayScrollbar.top, height: overlayScrollbar.height }}
        />
      </div>

      {premiumCelebrationVisible && (
        <PremiumCelebrationOverlay
          labels={t}
          premiumUntil={effectivePublicUser?.premiumUntil}
          onClose={() => setPremiumCelebrationVisible(false)}
        />
      )}

      <PublicAccountLoginDialog
        open={loginOpen}
        onOpenChange={setLoginOpen}
        view="account"
        user={effectivePublicUser}
        wallet={publicUserWallet}
        premiumInfo={publicUserPremium}
        deposit={publicUserDeposit}
        depositOrder={publicUserDepositOrder}
        walletHistory={publicUserWalletHistory}
        settings={publicUserSettings}
        settingSaving={publicUserSettingSaving}
        depositEnabled={siteSettings.depositEnabled}
        withdrawEnabled={siteSettings.withdrawEnabled}
        challenge={loginChallenge}
        status={loginStatus}
        remainingSeconds={loginRemainingSeconds}
        now={now}
        command={loginCommand}
        loading={loginLoading}
        refreshingWallet={publicUserRefreshing}
        labels={t}
        copyText={copyText}
        onStartLogin={() => void startPublicLogin(true)}
        onNewCode={() => void startPublicLogin(false)}
        onLogout={() => void logoutPublicUser()}
        onRefreshWallet={() => void refreshPublicUserBalance()}
        onToggleSuccessNotify={(enabled) => void updateSuccessTgNotify(enabled)}
        onWithdraw={requestPublicWithdrawal}
        onSignDepositRiskNotice={signDepositRiskNotice}
        onCreateDepositOrder={createPublicDepositOrder}
        onRedeemCdk={redeemPublicCdk}
        onPurchasePremium={purchasePublicPremium}
        onClaimPremiumTrial={claimPublicPremiumTrial}
      />

      <PublicAccountLoginDialog
        open={walletOpen}
        onOpenChange={setWalletOpen}
        view="wallet"
        user={effectivePublicUser}
        wallet={publicUserWallet}
        premiumInfo={publicUserPremium}
        deposit={publicUserDeposit}
        depositOrder={publicUserDepositOrder}
        walletHistory={publicUserWalletHistory}
        settings={publicUserSettings}
        settingSaving={publicUserSettingSaving}
        depositEnabled={siteSettings.depositEnabled}
        withdrawEnabled={siteSettings.withdrawEnabled}
        challenge={loginChallenge}
        status={loginStatus}
        remainingSeconds={loginRemainingSeconds}
        now={now}
        command={loginCommand}
        loading={loginLoading}
        refreshingWallet={publicUserRefreshing}
        labels={t}
        copyText={copyText}
        onStartLogin={() => void startPublicLogin(true)}
        onNewCode={() => void startPublicLogin(false)}
        onLogout={() => void logoutPublicUser()}
        onRefreshWallet={() => void refreshPublicUserBalance()}
        onToggleSuccessNotify={(enabled) => void updateSuccessTgNotify(enabled)}
        onWithdraw={requestPublicWithdrawal}
        onSignDepositRiskNotice={signDepositRiskNotice}
        onCreateDepositOrder={createPublicDepositOrder}
        onRedeemCdk={redeemPublicCdk}
        onPurchasePremium={purchasePublicPremium}
        onClaimPremiumTrial={claimPublicPremiumTrial}
      />

      <div className="fixed bottom-5 right-5 flex flex-col items-end gap-2">
        <div className="flex items-center gap-2 rounded-full border border-border bg-background/95 px-4 py-2 text-sm shadow-[0_12px_40px_rgba(0,0,0,0.12)] backdrop-blur-xl">
          <UsersRoundIcon className="size-4 text-muted-foreground" />
          <span className="text-muted-foreground">{t.onlineLabel}</span>
          <span className="font-semibold">{onlineViewers ?? "-"}</span>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {siteSettings.tgInviteEnabled && (
            <a
              href={siteSettings.tgInviteUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-full border border-border bg-background/95 px-4 py-2 text-sm font-medium shadow-[0_12px_40px_rgba(0,0,0,0.12)] backdrop-blur-xl transition hover:bg-muted"
            >
              <SendIcon data-icon="inline-start" className="size-4 text-brand" />
              {t.tgGroup}
            </a>
          )}
          <div className="flex rounded-full border border-border bg-background/95 p-1 text-xs shadow-[0_12px_40px_rgba(0,0,0,0.12)] backdrop-blur-xl">
            <button
              type="button"
              onClick={() => changeLanguage("zh")}
              className={cn("rounded-full px-3 py-1 transition", lang === "zh" ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}
            >
              中文
            </button>
            <button
              type="button"
              onClick={() => changeLanguage("en")}
              className={cn("rounded-full px-3 py-1 transition", lang === "en" ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}
            >
              EN
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PremiumCelebrationOverlay({
  labels,
  premiumUntil,
  onClose,
}: {
  labels: typeof UI_TEXT[Lang];
  premiumUntil?: string | null;
  onClose: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={labels.premiumUnlockedTitle}
      className="fixed inset-0 z-[9999] flex items-center justify-center px-5"
    >
      <div className="absolute inset-0 bg-foreground/45 backdrop-blur-[2px] upi-premium-unlock-backdrop" />
      <div className="upi-premium-unlock-card relative w-full max-w-sm overflow-hidden rounded-3xl border border-brand/20 bg-background p-6 text-center shadow-[0_30px_100px_rgba(0,0,0,0.28)]">
        <div className="absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-brand/60 to-transparent" />
        <div className="absolute -right-12 -top-12 size-32 rounded-full bg-brand/16 blur-2xl" />
        <div className="absolute -bottom-16 -left-16 size-36 rounded-full bg-brand/10 blur-3xl" />
        <div className="relative">
          <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-brand/12 text-brand ring-1 ring-brand/20">
            <CheckCircle2Icon className="size-7" />
          </div>
          <div className="mt-4 text-xl font-bold tracking-tight text-foreground">{labels.premiumUnlockedTitle}</div>
          <div className="mt-2 text-sm leading-relaxed text-muted-foreground">{labels.premiumUnlockedDesc}</div>
          <div className="mt-4 rounded-2xl border border-brand/15 bg-brand/10 px-4 py-3 text-sm font-semibold text-brand">
            {formatPremiumUntil(premiumUntil, labels)}
          </div>
          <Button type="button" className="mt-5 h-10 w-full rounded-2xl" onClick={onClose}>
            {labels.premiumConfirm}
          </Button>
        </div>
      </div>
    </div>
  );
}

function PublicAccountLoginDialog({
  open,
  onOpenChange,
  view = "account",
  user,
  wallet,
  premiumInfo,
  deposit,
  depositOrder,
  walletHistory,
  settings,
  settingSaving,
  depositEnabled,
  withdrawEnabled,
  challenge,
  status,
  remainingSeconds,
  now,
  command,
  loading,
  refreshingWallet,
  labels,
  copyText,
  onStartLogin,
  onNewCode,
  onLogout,
  onRefreshWallet,
  onToggleSuccessNotify,
  onWithdraw,
  onSignDepositRiskNotice,
  onCreateDepositOrder,
  onRedeemCdk,
  onPurchasePremium,
  onClaimPremiumTrial,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view?: "account" | "wallet";
  user: PublicUserSession | null;
  wallet: PublicUserWalletSummary | null;
  premiumInfo: PublicUserPremiumInfo | null;
  deposit: PublicUserDepositAddressInfo | null;
  depositOrder: PublicUserDepositOrderInfo | null;
  walletHistory: PublicUserWalletHistoryItem[];
  settings: PublicUserSettings;
  settingSaving: boolean;
  depositEnabled: boolean;
  withdrawEnabled: boolean;
  challenge: PublicLoginChallenge | null;
  status: LoginChallengeStatus;
  remainingSeconds: number;
  now: number;
  command: string;
  loading: boolean;
  refreshingWallet: boolean;
  labels: typeof UI_TEXT[Lang];
  copyText: (text: string, successMessage: string) => Promise<void>;
  onStartLogin: () => void;
  onNewCode: () => void;
  onLogout: () => void;
  onRefreshWallet: () => void;
  onToggleSuccessNotify: (enabled: boolean) => void;
  onWithdraw: (amount: number, withdrawalAddress: string) => Promise<PublicUserWithdrawalSummary>;
  onSignDepositRiskNotice: () => Promise<PublicUserSettings>;
  onCreateDepositOrder: (baseAmount: PublicDepositBaseAmount) => Promise<PublicUserDepositOrderInfo | null>;
  onRedeemCdk: (code: string) => Promise<{ code: string; amount: number; wallet: PublicUserWalletSummary }>;
  onPurchasePremium: () => Promise<PublicUserResponse>;
  onClaimPremiumTrial: () => Promise<PublicUserResponse>;
}) {
  const walletOnly = view === "wallet";
  const [walletPanel, setWalletPanel] = useState<"none" | "deposit" | "withdraw" | "cdk">("none");
  const [redeemCdkCode, setRedeemCdkCode] = useState("");
  const [redeemCdkSubmitting, setRedeemCdkSubmitting] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [withdrawAddress, setWithdrawAddress] = useState("");
  const [withdrawSubmitting, setWithdrawSubmitting] = useState(false);
  const [depositCreatingAmount, setDepositCreatingAmount] = useState<PublicDepositBaseAmount | null>(null);
  const [depositQrOpen, setDepositQrOpen] = useState(false);
  const [depositQrDataUrl, setDepositQrDataUrl] = useState("");
  const [depositQrAddress, setDepositQrAddress] = useState("");
  const [depositQrLoading, setDepositQrLoading] = useState(false);
  const [depositWarningOpen, setDepositWarningOpen] = useState(false);
  const [depositWarningAgreed, setDepositWarningAgreed] = useState(false);
  const [depositWarningSigned, setDepositWarningSigned] = useState(false);
  const [depositWarningSigning, setDepositWarningSigning] = useState(false);
  const [depositWarningCountdown, setDepositWarningCountdown] = useState(5);
  const [depositNoticeExpanded, setDepositNoticeExpanded] = useState(false);
  const [walletHistoryExpanded, setWalletHistoryExpanded] = useState(false);
  const [premiumAction, setPremiumAction] = useState<"purchase" | "trial" | null>(null);
  const expired = status === "EXPIRED" || Boolean(challenge && remainingSeconds <= 0);
  const statusText = user
    ? labels.accountLoggedIn
    : status === "APPROVED"
      ? labels.loginApproved
      : expired
        ? labels.loginExpired
        : challenge
          ? labels.loginWaiting
          : labels.loginOpeningBot;
  const parsedWithdrawAmount = Number(withdrawAmount);
  const safeWithdrawAmount = Number.isFinite(parsedWithdrawAmount) && parsedWithdrawAmount > 0 ? parsedWithdrawAmount : 0;
  const withdrawAvailable = Number(wallet?.availableBalance ?? 0);
  const maxWithdrawAmount = Math.max(0, withdrawAvailable - PUBLIC_WITHDRAWAL_FEE);
  const withdrawTotal = safeWithdrawAmount + PUBLIC_WITHDRAWAL_FEE;
  const withdrawBelowMinimum = safeWithdrawAmount > 0 && safeWithdrawAmount < PUBLIC_MIN_WITHDRAWAL_AMOUNT;
  const withdrawExceedsBalance = safeWithdrawAmount > 0 && withdrawTotal > withdrawAvailable + 0.000001;
  const depositOrderRemainingSeconds = depositOrder?.expiresAt
    ? Math.max(0, Math.ceil((new Date(depositOrder.expiresAt).getTime() - now) / 1000))
    : 0;
  const depositOrderActive = Boolean(depositOrder && depositOrder.status === "PENDING" && depositOrderRemainingSeconds > 0);
  const canOpenDepositPanel = depositEnabled || depositOrderActive;
  const canOpenWithdrawPanel = Boolean(withdrawEnabled);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!canOpenDepositPanel && walletPanel === "deposit") setWalletPanel("none");
      if (!canOpenWithdrawPanel && walletPanel === "withdraw") setWalletPanel("none");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [canOpenDepositPanel, canOpenWithdrawPanel, walletPanel]);

  useEffect(() => {
    if (!depositWarningOpen) return;
    const timer = window.setInterval(() => {
      setDepositWarningCountdown((current) => Math.max(0, current - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [depositWarningOpen]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDepositWarningSigned(Boolean(settings.depositRiskSigned));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [settings.depositRiskSigned, user?.telegramUserId]);

  const openDepositPanel = () => {
    if (walletPanel === "deposit") {
      setWalletPanel("none");
      return;
    }

    if (!canOpenDepositPanel) {
      toast.error(labels.depositDisabled);
      return;
    }

    const signed = depositWarningSigned || settings.depositRiskSigned;
    if (signed) {
      setDepositWarningSigned(true);
      setWalletPanel("deposit");
      return;
    }

    setDepositWarningAgreed(false);
    setDepositWarningCountdown(5);
    setDepositWarningOpen(true);
  };

  const confirmDepositWarning = async () => {
    if (depositWarningCountdown > 0 || !depositWarningAgreed) return;
    setDepositWarningSigning(true);
    try {
      await onSignDepositRiskNotice();
      setDepositWarningSigned(true);
      setDepositWarningOpen(false);
      setWalletPanel("deposit");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : labels.loginFailed);
    } finally {
      setDepositWarningSigning(false);
    }
  };

  const createDepositOrder = async (baseAmount: PublicDepositBaseAmount) => {
    if (!depositEnabled) {
      toast.error(labels.depositDisabled);
      return;
    }
    setDepositCreatingAmount(baseAmount);
    try {
      await onCreateDepositOrder(baseAmount);
    } catch (error) {
      toast.error(compactFailureMessage(error instanceof Error ? error.message : labels.depositUnavailable, labels) || labels.depositUnavailable);
    } finally {
      setDepositCreatingAmount(null);
    }
  };

  const purchasePrice = premiumInfo?.purchasePrice ?? 1;
  const premiumSaleEnabled = premiumInfo?.saleEnabled !== false;
  const premiumBuyDisabled = !premiumSaleEnabled || Boolean(user?.isPremium && !user.premiumUntil) || (wallet?.availableBalance ?? 0) < purchasePrice || Boolean(premiumAction);
  const premiumTrialDisabled = Boolean(user?.isPremium) || Boolean(premiumInfo?.trialClaimed) || Boolean(premiumAction);

  const purchasePremium = async () => {
    if (!premiumSaleEnabled) {
      toast.error(labels.premiumSaleDisabled);
      return;
    }
    if ((wallet?.availableBalance ?? 0) < purchasePrice) {
      toast.error(labels.premiumBuyInsufficient(purchasePrice));
      return;
    }
    setPremiumAction("purchase");
    try {
      await onPurchasePremium();
      toast.success(labels.premiumBuySuccess);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : labels.premiumBuyInsufficient(purchasePrice));
    } finally {
      setPremiumAction(null);
    }
  };

  const claimPremiumTrial = async () => {
    setPremiumAction("trial");
    try {
      await onClaimPremiumTrial();
      toast.success(labels.premiumTrialSuccess);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : labels.loginFailed);
    } finally {
      setPremiumAction(null);
    }
  };

  const openDepositAddressQr = async (address: string) => {
    const normalizedAddress = address.trim();
    if (!normalizedAddress) return;
    setDepositQrOpen(true);
    setDepositQrAddress(normalizedAddress);
    setDepositQrDataUrl("");
    setDepositQrLoading(true);
    try {
      const QRCode = await import("qrcode");
      const dataUrl = await QRCode.toDataURL(normalizedAddress, {
        errorCorrectionLevel: "M",
        margin: 2,
        width: 280,
      });
      setDepositQrDataUrl(dataUrl);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : labels.copyFailed);
    } finally {
      setDepositQrLoading(false);
    }
  };

  const submitCdkRedeem = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = redeemCdkCode.trim();
    if (!code) {
      toast.error(labels.cdkRedeemNeedCode);
      return;
    }
    setRedeemCdkSubmitting(true);
    try {
      const redeem = await onRedeemCdk(code);
      toast.success(labels.cdkRedeemSuccess(redeem.amount));
      setRedeemCdkCode("");
      setWalletPanel("none");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : labels.cdkRedeemNeedCode);
    } finally {
      setRedeemCdkSubmitting(false);
    }
  };

  const submitWithdrawal = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canOpenWithdrawPanel) {
      toast.error(labels.walletWithdrawDisabled);
      return;
    }
    if (!safeWithdrawAmount) {
      toast.error(labels.walletWithdrawNeedAmount);
      return;
    }
    if (withdrawBelowMinimum) {
      toast.error(labels.walletWithdrawMinAmount);
      return;
    }
    if (withdrawExceedsBalance) {
      toast.error(labels.walletWithdrawExceedBalance);
      return;
    }
    if (!withdrawAddress.trim()) {
      toast.error(labels.walletWithdrawNeedAddress);
      return;
    }
    setWithdrawSubmitting(true);
    try {
      await onWithdraw(safeWithdrawAmount, withdrawAddress.trim());
      toast.success(labels.walletWithdrawSuccess);
      setWithdrawAmount("");
      setWithdrawAddress("");
      setWalletPanel("none");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : labels.walletWithdrawNeedAmount);
    } finally {
      setWithdrawSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-auto max-h-none w-[min(94vw,680px)] max-w-[min(94vw,680px)] overflow-visible rounded-3xl p-5 sm:max-w-[min(94vw,680px)]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            {walletOnly ? <WalletIcon className="size-5 text-brand" /> : <BotIcon className="size-5 text-brand" />}
            {walletOnly ? labels.walletBadge : labels.loginTitle}
          </DialogTitle>
          <DialogDescription>
            {walletOnly ? labels.walletLedgerHint : labels.loginDesc}
          </DialogDescription>
        </DialogHeader>

        {user ? (
          <div className="flex min-w-0 flex-col gap-4 overflow-hidden">
            {!walletOnly && (
              <>
            <div className="rounded-3xl border border-success/25 bg-success/10 p-4 text-sm">
              <div className="flex items-center gap-3">
                <div className="flex size-10 items-center justify-center rounded-2xl bg-success text-white">
                  <UserCircleIcon className="size-5" />
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="font-semibold text-foreground">{user.displayName}</div>
                    {user.isPremium && <span className="rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-semibold text-brand">{getPublicUserPremiumLabel(user, labels)}</span>}
                  </div>
                  <div className="text-xs text-muted-foreground">Telegram ID: {user.telegramUserId}</div>
                  {user.isPremium && (
                    <div className="mt-1 text-xs font-medium text-brand">
                      {formatPremiumUntil(user.premiumUntil, labels)}
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className={cn(
              "rounded-3xl border p-4",
              user.isPremium ? "border-brand/25 bg-brand/10" : "border-border bg-muted/25"
            )}>
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex min-w-0 items-start gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-brand text-white">
                    <CrownIcon className="size-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="font-semibold text-foreground">{labels.premiumManageTitle}</div>
                      {user.isPremium && (
                        <span className="rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-semibold text-brand">
                          {getPublicUserPremiumLabel(user, labels)}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {user.isPremium ? labels.premiumActiveHint : labels.premiumManageDesc}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">{labels.premiumTrialHint}</p>
                  </div>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0 rounded-xl"
                  onClick={() => window.open(SCANNER_APPLY_URL, "_blank", "noopener,noreferrer")}
                >
                  <SendIcon data-icon="inline-start" />
                  {labels.scannerApply}
                </Button>
              </div>

              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                <Button
                  type="button"
                  className="rounded-xl"
                  disabled={premiumBuyDisabled}
                  onClick={() => void purchasePremium()}
                >
                  {premiumAction === "purchase" ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <CrownIcon data-icon="inline-start" />}
                  {premiumAction === "purchase" ? labels.premiumBuying : premiumSaleEnabled ? labels.premiumBuyLifetime(purchasePrice) : labels.premiumSaleDisabled}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="rounded-xl"
                  disabled={premiumTrialDisabled}
                  onClick={() => void claimPremiumTrial()}
                >
                  {premiumAction === "trial" ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <SparklesIcon data-icon="inline-start" />}
                  {premiumAction === "trial"
                    ? labels.premiumTrialClaiming
                    : premiumInfo?.trialClaimed
                      ? labels.premiumTrialClaimed
                      : labels.premiumTrialOneDay}
                </Button>
              </div>

              {!user.isPremium && !premiumSaleEnabled && (
                <div className="mt-3 rounded-2xl border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                  {labels.premiumSaleDisabled}
                </div>
              )}
              {!user.isPremium && premiumSaleEnabled && (wallet?.availableBalance ?? 0) < purchasePrice && (
                <div className="mt-3 rounded-2xl border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
                  {labels.premiumBuyInsufficient(purchasePrice)}
                </div>
              )}
            </div>
              </>
            )}

            {walletOnly && (
              <>
            <div className="rounded-3xl border border-border p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex size-10 items-center justify-center rounded-2xl bg-brand text-white">
                    <WalletIcon className="size-5" />
                  </div>
                  <div>
                    <div className="font-semibold text-foreground">{formatWalletDisplay(wallet?.availableBalance ?? 0)}</div>
                    <div className="text-xs text-muted-foreground">
                      {labels.walletFrozen} {formatWalletDisplay(wallet?.frozenBalance ?? 0)}
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:flex sm:shrink-0">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="rounded-xl"
                    onClick={onRefreshWallet}
                    disabled={refreshingWallet}
                  >
                    {refreshingWallet ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <RefreshCwIcon data-icon="inline-start" />}
                    <span className="hidden sm:inline">{labels.walletRefreshAction}</span>
                    <span className="sm:hidden">{labels.walletRefreshAction}</span>
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={walletPanel === "deposit" ? "default" : "outline"}
                    className="rounded-xl"
                    disabled={!canOpenDepositPanel}
                    title={canOpenDepositPanel ? undefined : labels.depositDisabled}
                    onClick={openDepositPanel}
                  >
                    {labels.walletDepositAction}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={walletPanel === "cdk" ? "default" : "outline"}
                    className="rounded-xl"
                    onClick={() => setWalletPanel((current) => current === "cdk" ? "none" : "cdk")}
                  >
                    {labels.cdkRedeemAction}
                  </Button>
                  {canOpenWithdrawPanel && (
                    <Button
                      type="button"
                      size="sm"
                      variant={walletPanel === "withdraw" ? "default" : "outline"}
                      className="rounded-xl"
                      onClick={() => setWalletPanel((current) => current === "withdraw" ? "none" : "withdraw")}
                    >
                      {labels.walletWithdrawAction}
                    </Button>
                  )}
                </div>
              </div>
            </div>

            <div className="rounded-3xl border border-destructive/25 bg-destructive/5 p-4 text-xs leading-relaxed text-destructive">
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 text-left"
                onClick={() => setDepositNoticeExpanded((current) => !current)}
                aria-expanded={depositNoticeExpanded}
              >
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <ShieldCheckIcon className="size-4 shrink-0" />
                  <span className="font-semibold">{labels.depositWarningNoticeTitle}</span>
                  <Badge variant={depositWarningSigned ? "default" : "destructive"} className="rounded-full">
                    {depositWarningSigned ? labels.depositWarningSignedBadge : labels.depositWarningUnsignedBadge}
                  </Badge>
                </span>
                <span className="flex shrink-0 items-center gap-1 text-[11px] font-semibold">
                  {depositNoticeExpanded ? labels.depositWarningCollapse : labels.depositWarningExpand}
                  <ChevronDownIcon className={cn("size-4 transition-transform", depositNoticeExpanded && "rotate-180")} />
                </span>
              </button>
              <p className="mt-2 text-destructive/85">{labels.depositWarningNoticeHint}</p>
              {depositNoticeExpanded && (
                <div className="mt-3 space-y-2 border-t border-destructive/15 pt-3">
                  <p>{labels.depositWarningDialogDesc}</p>
                  <p>{labels.depositWarningDialogFeeDesc}</p>
                  <p className="font-semibold">{labels.depositWarningDialogNoExcuseDesc}</p>
                  {settings.depositRiskSignedAt && (
                    <p className="text-[11px] text-destructive/75">
                      {labels.depositWarningSignedBadge}: {formatHistoryDate(settings.depositRiskSignedAt, labels)}
                    </p>
                  )}
                </div>
              )}
            </div>

            {walletPanel === "deposit" && (
              <div className="min-w-0 overflow-hidden rounded-3xl border border-border p-4">
                <div className="flex items-start gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-brand text-white">
                    <WalletIcon className="size-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-foreground">{labels.depositTitle}</div>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{labels.depositChooseAmount}</p>

                    {deposit?.configured && deposit.address ? (
                      <div className="mt-3 flex flex-col gap-3">
                        {depositOrder ? (
                          <div className="rounded-2xl border border-border bg-muted/30 p-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="font-medium text-foreground">{labels.depositOrderTitle}</div>
                              <span className={cn(
                                "rounded-full px-2 py-0.5 text-xs font-medium",
                                depositOrder.status === "PAID"
                                  ? "bg-success/10 text-success"
                                  : depositOrderActive
                                    ? "bg-warning/10 text-warning"
                                    : "bg-muted text-muted-foreground"
                              )}>
                                {depositOrder.status === "PAID"
                                  ? labels.depositOrderPaid
                                  : depositOrderActive
                                    ? labels.depositOrderPending
                                    : labels.depositOrderExpiredStatus}
                              </span>
                            </div>
                            <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                              <div className="rounded-xl bg-background/80 p-2">
                                <div>{labels.depositOrderNo}</div>
                                <div className="mt-1 break-all font-mono text-foreground">{depositOrder.orderNo}</div>
                              </div>
                              <div className="rounded-xl bg-background/80 p-2">
                                <div>{labels.depositPayAmount}</div>
                                <div className="mt-1 font-mono text-lg font-semibold text-brand">{depositOrder.payAmount.toFixed(2)} USDT</div>
                              </div>
                            </div>
                            {depositOrderActive ? (
                              <div className="mt-3 rounded-xl bg-warning/10 px-3 py-2 text-xs font-medium text-warning">
                                {labels.depositOrderExpiresIn(depositOrderRemainingSeconds)}
                              </div>
                            ) : depositOrder.status !== "PAID" ? (
                              <div className="mt-3 rounded-xl bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                                {labels.depositOrderExpired}
                              </div>
                            ) : null}
                          </div>
                        ) : null}

                        {depositOrderActive ? (
                          <>
                            <div className="text-xs font-medium text-muted-foreground">
                              {labels.depositAddressLabel} - BSC / BEP20 - {deposit.confirmations} confirmations
                            </div>
                            <div className="flex items-stretch gap-2 rounded-2xl bg-muted/50 p-2">
                              <div className="min-w-0 flex-1 break-all rounded-xl bg-background/70 p-3 font-mono text-xs text-foreground">
                                {deposit.address}
                              </div>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-auto shrink-0 rounded-xl px-3"
                                onClick={() => void openDepositAddressQr(deposit.address || "")}
                              >
                                <QrCodeIcon data-icon="inline-start" />
                                <span className="hidden sm:inline">{labels.depositAddressQr}</span>
                              </Button>
                            </div>
                            <div className="rounded-2xl bg-warning/10 p-3 text-xs leading-relaxed text-warning">
                              {labels.depositOrderHint}
                            </div>
                            <div className="rounded-2xl border border-warning/25 bg-warning/5 p-3 text-xs leading-relaxed text-warning">
                              {labels.depositExactAmountWarning}
                            </div>
                            <div className="grid gap-2 sm:grid-cols-2">
                              <Button type="button" variant="outline" className="rounded-xl" onClick={() => copyText(deposit.address || "", labels.depositAddressCopied)}>
                                <CopyIcon data-icon="inline-start" />
                                {labels.depositCopyAddress}
                              </Button>
                              <Button type="button" variant="outline" className="rounded-xl" onClick={() => copyText(depositOrder!.payAmount.toFixed(2), labels.depositAmountCopied)}>
                                <CopyIcon data-icon="inline-start" />
                                {labels.depositCopyAmount}
                              </Button>
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="rounded-2xl border border-warning/25 bg-warning/5 p-3 text-xs leading-relaxed text-warning">
                              {labels.depositExactAmountWarning}
                            </div>
                            <div className="grid gap-2 sm:grid-cols-3">
                            <Button type="button" className="rounded-xl" disabled={Boolean(depositCreatingAmount)} onClick={() => void createDepositOrder(1.8)}>
                              {depositCreatingAmount === 1.8 ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <WalletIcon data-icon="inline-start" />}
                              {depositCreatingAmount === 1.8 ? labels.depositCreating : labels.depositCreate18}
                            </Button>
                            <Button type="button" className="rounded-xl" disabled={Boolean(depositCreatingAmount)} onClick={() => void createDepositOrder(5)}>
                              {depositCreatingAmount === 5 ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <WalletIcon data-icon="inline-start" />}
                              {depositCreatingAmount === 5 ? labels.depositCreating : labels.depositCreate5}
                            </Button>
                            <Button type="button" className="rounded-xl" variant="outline" disabled={Boolean(depositCreatingAmount)} onClick={() => void createDepositOrder(10)}>
                              {depositCreatingAmount === 10 ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <WalletIcon data-icon="inline-start" />}
                              {depositCreatingAmount === 10 ? labels.depositCreating : labels.depositCreate10}
                            </Button>
                            </div>
                          </>
                        )}
                      </div>
                    ) : (
                      <div className="mt-3 rounded-2xl border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
                        {deposit?.message || labels.depositUnavailable}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {walletPanel === "cdk" && (
              <form className="min-w-0 overflow-hidden rounded-3xl border border-border p-4" onSubmit={submitCdkRedeem}>
                <div className="flex items-start gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-brand text-white">
                    <KeyRoundIcon className="size-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-foreground">{labels.cdkRedeemTitle}</div>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{labels.cdkRedeemDesc}</p>
                    <div className="mt-4 grid gap-3">
                      <Field>
                        <FieldLabel>CDK</FieldLabel>
                        <Input
                          value={redeemCdkCode}
                          placeholder={labels.cdkRedeemPlaceholder}
                          className="font-mono text-xs"
                          onChange={(event) => setRedeemCdkCode(event.target.value)}
                        />
                      </Field>
                      <Button type="submit" className="rounded-xl" disabled={redeemCdkSubmitting}>
                        {redeemCdkSubmitting ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <KeyRoundIcon data-icon="inline-start" />}
                        {redeemCdkSubmitting ? labels.cdkRedeemSubmitting : labels.cdkRedeemSubmit}
                      </Button>
                    </div>
                  </div>
                </div>
              </form>
            )}

            {walletPanel === "withdraw" && (
              <form className="min-w-0 overflow-hidden rounded-3xl border border-border p-4" onSubmit={submitWithdrawal}>
                <div className="flex items-start gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-warning text-white">
                    <WalletIcon className="size-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-foreground">{labels.walletWithdrawTitle}</div>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{labels.walletWithdrawDesc}</p>
                    <div className="mt-4 grid gap-3">
                      <Field>
                        <div className="flex items-center justify-between gap-3">
                          <FieldLabel>{labels.walletWithdrawAmount}</FieldLabel>
                          <button
                            type="button"
                            className="text-xs font-medium text-brand hover:underline disabled:text-muted-foreground disabled:no-underline"
                            disabled={maxWithdrawAmount < PUBLIC_MIN_WITHDRAWAL_AMOUNT}
                            onClick={() => setWithdrawAmount(maxWithdrawAmount >= PUBLIC_MIN_WITHDRAWAL_AMOUNT ? maxWithdrawAmount.toFixed(2) : "")}
                          >
                            {labels.walletWithdrawMax} {formatUsdt(maxWithdrawAmount)}
                          </button>
                        </div>
                        <Input
                          value={withdrawAmount}
                          type="number"
                          inputMode="decimal"
                          min={PUBLIC_MIN_WITHDRAWAL_AMOUNT}
                          max={maxWithdrawAmount || undefined}
                          step="0.01"
                          placeholder="0.00"
                          onChange={(event) => setWithdrawAmount(event.target.value)}
                        />
                      </Field>
                      <Field>
                        <FieldLabel>{labels.walletWithdrawAddress}</FieldLabel>
                        <Input
                          value={withdrawAddress}
                          placeholder={labels.walletWithdrawAddressPlaceholder}
                          className="font-mono text-xs"
                          onChange={(event) => setWithdrawAddress(event.target.value)}
                        />
                      </Field>
                      <div className="grid gap-2 rounded-2xl bg-muted/40 p-3 text-xs text-muted-foreground sm:grid-cols-2">
                        <div className="flex items-center justify-between gap-2">
                          <span>{labels.walletWithdrawFee}</span>
                          <span className="font-mono text-foreground">{PUBLIC_WITHDRAWAL_FEE.toFixed(2)} USDT</span>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <span>{labels.walletWithdrawTotal}</span>
                          <span className="font-mono font-semibold text-foreground">{withdrawTotal.toFixed(2)} USDT</span>
                        </div>
                      </div>
                      {withdrawBelowMinimum && (
                        <div className="rounded-2xl bg-warning/10 px-3 py-2 text-xs text-warning">
                          {labels.walletWithdrawMinAmount}
                        </div>
                      )}
                      {withdrawExceedsBalance && (
                        <div className="rounded-2xl bg-destructive/10 px-3 py-2 text-xs text-destructive">
                          {labels.walletWithdrawExceedBalance}
                        </div>
                      )}
                      <Button type="submit" className="rounded-xl" disabled={withdrawSubmitting || withdrawBelowMinimum || withdrawExceedsBalance}>
                        {withdrawSubmitting ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <WalletIcon data-icon="inline-start" />}
                        {withdrawSubmitting ? labels.walletWithdrawSubmitting : labels.walletWithdrawSubmit}
                      </Button>
                    </div>
                  </div>
                </div>
              </form>
            )}
              </>
            )}

            {!walletOnly && (
            <div className="min-w-0 overflow-hidden rounded-3xl border border-border p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="font-semibold text-foreground">{labels.successTgNotify}</div>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{labels.successTgNotifyDesc}</p>
                </div>
                <Switch
                  checked={settings.successTgNotifyEnabled}
                  onCheckedChange={onToggleSuccessNotify}
                  disabled={settingSaving}
                  aria-label={labels.successTgNotify}
                />
              </div>
            </div>
            )}

            {walletOnly && (
            <div className="rounded-3xl border border-border p-4">
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 text-left"
                onClick={() => setWalletHistoryExpanded((current) => !current)}
                aria-expanded={walletHistoryExpanded}
              >
                <span className="font-semibold text-foreground">{labels.walletLedgerTitle}</span>
                <span className="flex items-center gap-2">
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{walletHistory.length}</span>
                  <ChevronDownIcon className={cn("size-4 text-muted-foreground transition-transform", walletHistoryExpanded && "rotate-180")} />
                </span>
              </button>
              {walletHistoryExpanded && (
                <>
                  <p className="mt-2 text-xs text-muted-foreground">{labels.walletLedgerHint}</p>
                  <div className="mt-3 flex max-h-72 min-w-0 flex-col gap-2 overflow-y-auto overflow-x-hidden pb-2 pr-4 [scrollbar-gutter:stable]">
                    {walletHistory.length === 0 ? (
                      <div className="rounded-2xl bg-muted/40 p-3 text-sm text-muted-foreground">
                        {labels.walletLedgerEmpty}
                      </div>
                    ) : walletHistory.slice(0, 30).map((item) => (
                      <WalletLedgerItem key={item.id} item={item} labels={labels} />
                    ))}
                  </div>
                </>
              )}
            </div>
            )}
            {!walletOnly && (
            <Button type="button" variant="outline" className="rounded-xl" onClick={onLogout}>
              <LogOutIcon data-icon="inline-start" />
              {labels.accountLogout}
            </Button>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="rounded-3xl bg-muted/40 p-5 text-center">
              <div className="text-sm text-muted-foreground">{labels.loginCodeLabel}</div>
              <div className="mt-3 font-mono text-4xl font-semibold tracking-[0.18em] text-brand">
                {challenge?.code || "--------"}
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-center gap-2 text-sm text-muted-foreground">
                {loading ? <Loader2Icon className="size-4 animate-spin" /> : <ClockIcon className="size-4" />}
                <span>{statusText}</span>
                {challenge && !expired && status === "PENDING" && <span>{remainingSeconds}s</span>}
              </div>
            </div>

            <div className="rounded-2xl border border-border p-4">
              <div className="rounded-2xl bg-muted/40 px-4 py-3 font-mono text-sm">{command}</div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <Button type="button" onClick={onStartLogin} disabled={loading}>
                  {loading ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <SendIcon data-icon="inline-start" />}
                  {labels.loginOpenBot}
                </Button>
                <Button type="button" variant="outline" onClick={() => copyText(command, labels.loginCopied)} disabled={!challenge}>
                  <CopyIcon data-icon="inline-start" />
                  {labels.loginCopyCommand}
                </Button>
              </div>
              <div className="mt-2">
                <Button type="button" variant="ghost" size="sm" onClick={onNewCode} disabled={loading}>
                  <RotateCcwIcon data-icon="inline-start" />
                  {labels.loginNewCode}
                </Button>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{labels.loginManualTip}</p>
            </div>
          </div>
        )}

        <Dialog open={depositWarningOpen} onOpenChange={setDepositWarningOpen}>
          <DialogContent
            overlayClassName="z-[9998] bg-black/90 backdrop-blur-[2px]"
            className="z-[9999] max-w-[min(92vw,560px)] rounded-3xl border-destructive/35 p-5 shadow-[0_35px_120px_rgba(0,0,0,0.55)] sm:max-w-[min(92vw,560px)]"
          >
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-lg text-destructive">
                <AlertCircleIcon className="size-5" />
                {labels.depositWarningDialogTitle}
              </DialogTitle>
              <DialogDescription className="text-destructive/90">
                {labels.depositWarningDialogDesc}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3">
              <div className="rounded-2xl border border-destructive/30 bg-destructive/10 p-4 text-sm leading-relaxed text-destructive">
                <div className="font-semibold">{labels.depositWarningDialogFeeTitle}</div>
                <p className="mt-1">{labels.depositWarningDialogFeeDesc}</p>
              </div>
              <div className="rounded-2xl border border-destructive/40 bg-destructive/15 p-4 text-sm leading-relaxed text-destructive">
                <div className="font-semibold">{labels.depositWarningDialogNoRefundTitle}</div>
                <p className="mt-1">{labels.depositWarningDialogNoRefundDesc}</p>
                <p className="mt-2 font-semibold">{labels.depositWarningDialogNoExcuseDesc}</p>
              </div>
              <div className="rounded-2xl border border-warning/30 bg-warning/10 p-3 text-xs leading-relaxed text-warning">
                {labels.depositWarningDialogAsset}
              </div>
              <label className="flex cursor-pointer select-none items-center gap-2 rounded-2xl border border-destructive/35 bg-destructive/10 px-3 py-2 text-sm font-semibold text-destructive">
                <input
                  type="checkbox"
                  className="size-4 rounded border-destructive accent-current"
                  checked={depositWarningAgreed}
                  onChange={(event) => setDepositWarningAgreed(event.target.checked)}
                />
                <span>{labels.depositWarningAgreement}</span>
              </label>
            </div>

            <DialogFooter className="gap-2 sm:gap-2">
              <Button type="button" variant="outline" className="rounded-xl" onClick={() => setDepositWarningOpen(false)}>
                {labels.depositWarningCancel}
              </Button>
              <Button
                type="button"
                className="rounded-xl bg-destructive text-destructive-foreground hover:bg-destructive/90"
                disabled={depositWarningCountdown > 0 || !depositWarningAgreed || depositWarningSigning}
                onClick={() => void confirmDepositWarning()}
              >
                {depositWarningSigning && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
                {depositWarningCountdown > 0 ? labels.depositWarningCountdown(depositWarningCountdown) : labels.depositWarningConfirm}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={depositQrOpen} onOpenChange={setDepositQrOpen}>
          <DialogContent className="max-w-[min(92vw,420px)] rounded-3xl p-5 sm:max-w-[min(92vw,420px)]">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-lg">
                <QrCodeIcon className="size-5 text-brand" />
                {labels.depositAddressQrTitle}
              </DialogTitle>
              <DialogDescription>{labels.depositAddressQrDesc}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col items-center gap-4">
              <div className="flex size-[300px] max-w-full items-center justify-center rounded-3xl border border-border bg-white p-3 shadow-sm">
                {depositQrLoading ? (
                  <div className="flex flex-col items-center gap-3 text-sm text-muted-foreground">
                    <Loader2Icon className="size-6 animate-spin text-brand" />
                    {labels.depositAddressQrGenerating}
                  </div>
                ) : depositQrDataUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={depositQrDataUrl} alt={labels.depositAddressQrTitle} className="size-full rounded-2xl object-contain" />
                ) : (
                  <QrCodeIcon className="size-10 text-muted-foreground" />
                )}
              </div>
              <div className="w-full break-all rounded-2xl bg-muted/50 p-3 text-center font-mono text-xs text-foreground">
                {depositQrAddress}
              </div>
              <div className="grid w-full gap-2 sm:grid-cols-2">
                <Button type="button" variant="outline" className="rounded-xl" onClick={() => copyText(depositQrAddress, labels.depositAddressCopied)}>
                  <CopyIcon data-icon="inline-start" />
                  {labels.depositCopyAddress}
                </Button>
                <DialogClose render={<Button type="button" className="rounded-xl" />}>
                  OK
                </DialogClose>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  );
}

function WalletLedgerItem({ item, labels }: { item: PublicUserWalletHistoryItem; labels: typeof UI_TEXT[Lang] }) {
  const display = getWalletLedgerDisplay(item, labels);
  return (
    <div className="min-w-0 rounded-2xl bg-muted/40 p-3 text-sm">
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
        <div className="min-w-0">
          <div className="truncate font-medium text-foreground">{display.title}</div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{formatHistoryDate(item.createdAt, labels)}</span>
            {display.detail && <span className="min-w-0 truncate font-mono">{display.detail}</span>}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1 text-right">
          <span className={cn("font-mono text-sm font-semibold", display.amountClassName)}>{display.amountText}</span>
          {display.statusText && (
            <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", display.statusClassName)}>
              {display.statusText}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function PrivacyInfoDialog({ labels }: { labels: typeof UI_TEXT[Lang] }) {
  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-full bg-background/90 shadow-sm backdrop-blur"
          />
        }
      >
        <ShieldCheckIcon data-icon="inline-start" className="text-success" />
        {labels.privacyTitle}
      </DialogTrigger>

      <DialogContent className="max-w-[min(94vw,560px)] rounded-3xl p-5 sm:max-w-[min(94vw,560px)]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <ShieldCheckIcon className="size-5 text-success" />
            {labels.privacyTitle}
          </DialogTitle>
          <DialogDescription className="flex flex-col gap-3 leading-relaxed">
            <span>{labels.privacyText}</span>
            <span className="flex flex-col gap-2">
              {labels.privacyItems.map((item) => (
                <span key={item} className="flex gap-2 rounded-2xl bg-muted/40 p-3 text-left">
                  <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-success" />
                  <span>{item}</span>
                </span>
              ))}
            </span>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="-mx-5 -mb-5">
          <DialogClose render={<Button type="button" className="rounded-full" />}>
            OK
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


function getLocalizedFaqContent(settings: PublicSiteSettings, lang: Lang) {
  const zh = String(settings.faqContent || "").trim();
  const en = String(settings.faqContentEn || "").trim();
  return lang === "zh" ? (zh || en) : (en || zh);
}

function FaqDialog({ labels, content }: { labels: typeof UI_TEXT[Lang]; content?: string | null }) {
  const lines = String(content || "").trim().split(/\r?\n/).filter((line) => line.trim().length > 0);

  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-full bg-background/90 shadow-sm backdrop-blur"
          />
        }
      >
        <HelpCircleIcon data-icon="inline-start" className="text-brand" />
        {labels.faqButton}
      </DialogTrigger>

      <DialogContent className="max-w-[min(94vw,620px)] rounded-3xl p-5 sm:max-w-[min(94vw,620px)]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <HelpCircleIcon className="size-5 text-brand" />
            {labels.faqTitle}
          </DialogTitle>
          <DialogDescription className="sr-only">{labels.faqTitle}</DialogDescription>
          <div className="mt-3 flex max-h-[60vh] flex-col gap-2 overflow-y-auto pr-1 text-left leading-relaxed">
            {lines.length === 0 ? (
              <div className="rounded-2xl bg-muted/40 p-3 text-sm text-muted-foreground">{labels.faqEmpty}</div>
            ) : lines.map((line, index) => (
              <div key={`${index}-${line}`} className="rounded-2xl bg-muted/40 p-3 text-sm text-muted-foreground">
                {line}
              </div>
            ))}
          </div>
        </DialogHeader>
        <DialogFooter className="-mx-5 -mb-5">
          <DialogClose render={<Button type="button" className="rounded-full" />}>
            OK
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SuccessRateDialog({
  labels,
  guideOpenCount,
  onOpenGuide,
}: {
  labels: typeof UI_TEXT[Lang];
  guideOpenCount: number;
  onOpenGuide: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen && !open) void onOpenGuide();
  }, [onOpenGuide, open]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-full bg-background/90 shadow-sm backdrop-blur"
          />
        }
      >
        <SparklesIcon data-icon="inline-start" className="text-warning" />
        {labels.successTipsButton}
      </DialogTrigger>

      <DialogContent className="max-w-[min(94vw,680px)] rounded-3xl p-5 sm:max-w-[min(94vw,680px)]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <SparklesIcon className="size-5 text-warning" />
            {labels.successTipsTitle}
          </DialogTitle>
          <DialogDescription>
            {labels.successTipsIntro}
            <span className="mt-1 block text-xs text-muted-foreground">
              {labels.successTipsOpenedPrefix}{" "}
              <span className="font-bold text-brand">{formatCount(guideOpenCount)}</span>{" "}
              {labels.successTipsOpenedSuffix}
            </span>
          </DialogDescription>
        </DialogHeader>

        <ol className="space-y-3 text-sm">
          {labels.successTipsItems.map((item, index) => (
            <li key={item} className="flex gap-3 rounded-2xl border border-border bg-muted/35 p-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand text-xs font-semibold text-white">
                {index + 1}
              </span>
              <span className="leading-relaxed text-muted-foreground">{item}</span>
            </li>
          ))}
        </ol>

        <div className="rounded-2xl border border-success/30 bg-success/10 p-3 text-sm font-medium text-success">
          {labels.successTipsFooter}
        </div>

        <DialogFooter className="-mx-5 -mb-5">
          <DialogClose render={<Button type="button" className="rounded-full" />}>
            {labels.successTipsClose}
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BuffButton({
  labels,
  buffCount,
  bursts,
  onSendBuff,
}: {
  labels: typeof UI_TEXT[Lang];
  buffCount: number;
  bursts: BuffBurst[];
  onSendBuff: () => void | Promise<void>;
}) {
  return (
    <div className="relative">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="rounded-full bg-background/90 shadow-sm backdrop-blur"
        onClick={() => void onSendBuff()}
        aria-label={`${labels.giveBuff} · ${labels.buffTotal} ${formatCount(buffCount)}`}
      >
        <SparklesIcon data-icon="inline-start" className="text-brand" />
        <span>{labels.giveBuff}</span>
        <span className="rounded-full bg-warning/15 px-2 py-0.5 font-mono text-[11px] font-semibold text-warning">
          {formatCount(buffCount)}
        </span>
      </Button>

      <div className="pointer-events-none absolute inset-x-0 -top-2 flex justify-center">
        {bursts.map((burst) => (
          <span
            key={burst.id}
            className="upi-buff-float absolute rounded-full border border-warning/30 bg-warning px-2.5 py-1 text-xs font-bold text-white shadow-lg"
            style={{ "--buff-x": `${burst.offset}px` } as CSSProperties}
          >
            {burst.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function ExtractionProgressPanel({
  progress,
  elapsedSeconds,
  labels,
  extractMethod = "upi",
  accountEmail,
  accountPhone,
  untilSuccess = false,
  retryCount = 0,
  lastError,
  cancelling = false,
  onCancel,
}: {
  progress: UpiExtractProgress | null;
  elapsedSeconds: number;
  labels: typeof UI_TEXT[Lang];
  extractMethod?: PaymentExtractMethod;
  accountEmail?: string | null;
  accountPhone?: string | null;
  subscriptionPlan?: string | null;
  subscriptionIsPlus?: boolean | null;
  subscriptionCheckedAt?: string | null;
  subscriptionCheckError?: string | null;
  untilSuccess?: boolean;
  retryCount?: number;
  lastError?: string | null;
  cancelling?: boolean;
  onCancel?: () => void | Promise<void>;
}) {
  const rawStage = progress?.stage || "queued";
  const current = normalizeProgressForUi(progress);
  const currentStage = current.stage;
  const activeIndex = getProgressStageIndex(currentStage);
  const method = normalizePaymentExtractMethod(extractMethod);
  const stageLabel = (stage: UpiProgressStage) => method === "ideal" && stage === "stripe_confirm"
    ? labels.stageLabels.stripe_confirm.replace("UPI", "IDEAL")
    : labels.stageLabels[stage];
  const currentLabel = stageLabel(rawStage);
  const percent = Math.max(4, Math.min(100, Math.round(current.percent || 0)));

  return (
    <div className="rounded-2xl border border-sky-500/20 bg-sky-500/5 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-medium text-foreground">
          <Loader2Icon className="size-4 animate-spin text-sky-500" />
          <span>{labels.progressTitle}</span>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">{currentLabel}</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{labels.elapsed(elapsedSeconds)}</span>
          <span>·</span>
          <span>{labels.progressPercent} {percent}%</span>
          {!untilSuccess && onCancel && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-1 h-7 rounded-full px-2 text-destructive hover:bg-destructive/10"
              disabled={cancelling}
              onClick={() => void onCancel()}
            >
              {cancelling ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <XCircleIcon data-icon="inline-start" />}
              {cancelling ? labels.cancellingTask : labels.cancelTask}
            </Button>
          )}
        </div>
      </div>

      <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-sky-500 transition-all duration-500"
          style={{ width: `${percent}%` }}
        />
      </div>

      <AccountContactMeta accountEmail={accountEmail} accountPhone={accountPhone} labels={labels} className="mt-3" />

      {untilSuccess && (
        <div className="mt-3 rounded-2xl border border-brand/25 bg-background/80 p-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 text-xs text-muted-foreground">
              <div className="font-semibold text-foreground">{labels.untilSuccess}</div>
              <div className="mt-1">{labels.untilSuccessRetryCount(retryCount)}</div>
              {lastError && (
                <div className="mt-2 break-words rounded-xl bg-destructive/10 p-2 text-destructive">
                  <span className="font-medium">{labels.untilSuccessLastError}: </span>{lastError}
                </div>
              )}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0 rounded-xl"
              disabled={cancelling}
              onClick={() => void onCancel?.()}
            >
              {cancelling ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <XCircleIcon data-icon="inline-start" />}
              {cancelling ? labels.untilSuccessCancelling : labels.untilSuccessCancel}
            </Button>
          </div>
        </div>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {PROGRESS_STAGES.map((stage, index) => {
          const done = current.stage === "completed" || index < activeIndex;
          const active = current.stage !== "completed" && index === activeIndex;
          return (
            <div
              key={stage}
              className={cn(
                "flex items-center gap-2 rounded-xl border px-2 py-1.5 text-xs transition",
                done && "border-success/30 bg-success/10 text-success",
                active && "border-sky-500/30 bg-sky-500/10 text-sky-600",
                !done && !active && "border-border bg-background text-muted-foreground"
              )}
            >
              <span
                className={cn(
                  "flex size-4 shrink-0 items-center justify-center rounded-full text-[10px]",
                  done && "bg-success text-white",
                  active && "bg-sky-500 text-white",
                  !done && !active && "bg-muted text-muted-foreground"
                )}
              >
                {done ? "\u2713" : index + 1}
              </span>
              <span className="truncate">{stageLabel(stage)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MaintenanceView({ labels }: { labels: typeof UI_TEXT[Lang] }) {
  return (
    <CardContent className="pt-5">
      <div className="flex flex-col items-center rounded-3xl border border-warning/30 bg-warning/10 px-5 py-8 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-warning/15 text-warning">
          <ShieldCheckIcon className="size-6" />
        </div>
        <CardTitle className="mt-4 text-xl">{labels.maintenanceTitle}</CardTitle>
        <CardDescription className="mt-2 max-w-lg leading-relaxed">
          {labels.maintenanceDesc}
        </CardDescription>
      </div>
    </CardContent>
  );
}

function ExtractionDebugLogPanel({
  logs,
  error,
  labels,
  onRefresh,
}: {
  logs: UpiExtractDebugLogEntry[];
  error?: string | null;
  labels: typeof UI_TEXT[Lang];
  onRefresh: () => void | Promise<void>;
}) {
  const latestLogs = logs.slice(-240);

  return (
    <div className="w-full rounded-2xl border border-amber-500/25 bg-amber-500/5 p-3 text-xs">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 font-semibold text-foreground">
            <ClockIcon className="size-4 text-amber-500" />
            <span>{labels.debugLogsTitle}</span>
            <Badge variant="secondary" className="h-5 rounded-full px-2 text-[10px]">{latestLogs.length}</Badge>
          </div>
          <p className="mt-1 text-muted-foreground">{labels.debugLogsDesc}</p>
        </div>
        <Button type="button" size="sm" variant="outline" className="h-8 rounded-xl bg-background" onClick={() => void onRefresh()}>
          <RefreshCwIcon data-icon="inline-start" />
          {labels.debugLogsRefresh}
        </Button>
      </div>

      {error && (
        <div className="mt-3 rounded-xl border border-destructive/25 bg-destructive/10 px-3 py-2 text-destructive">
          {labels.debugLogsError}: {error}
        </div>
      )}

      <div className="mt-3 max-h-96 overflow-y-auto rounded-xl border border-border bg-slate-950 p-3 font-mono text-[11px] leading-relaxed text-slate-100 shadow-inner">
        {latestLogs.length === 0 ? (
          <div className="text-slate-400">{labels.debugLogsEmpty}</div>
        ) : (
          <div className="flex flex-col gap-2">
            {latestLogs.map((log) => (
              <div key={log.seq} className="border-b border-white/10 pb-2 last:border-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-slate-500">{formatDebugLogTime(log.at)}</span>
                  <span className={cn(
                    "rounded px-1.5 py-0.5 text-[10px] uppercase",
                    log.level === "error" && "bg-red-500/20 text-red-200",
                    log.level === "warn" && "bg-amber-500/20 text-amber-100",
                    log.level === "info" && "bg-sky-500/20 text-sky-100",
                    log.level === "debug" && "bg-slate-500/25 text-slate-200"
                  )}>
                    {log.level}
                  </span>
                  {log.stage && <span className="text-cyan-200">{log.stage}</span>}
                  {typeof log.percent === "number" && <span className="text-slate-400">{log.percent}%</span>}
                  {typeof log.attempt === "number" && (
                    <span className="text-slate-400">
                      attempt {log.attempt}{typeof log.maxAttempts === "number" ? `/${log.maxAttempts}` : ""}
                    </span>
                  )}
                  {log.proxy && <span className="max-w-full truncate text-emerald-200">{log.proxy}</span>}
                </div>
                <div className="mt-1 whitespace-pre-wrap break-words text-slate-50">{log.message}</div>
                {log.details !== undefined && (
                  <details className="mt-1 rounded-lg bg-white/5 px-2 py-1 text-slate-300">
                    <summary className="cursor-pointer select-none text-slate-400">{labels.debugLogsDetails}</summary>
                    <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words">{formatDebugLogDetails(log.details)}</pre>
                  </details>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RestoringView({ labels }: { labels: typeof UI_TEXT[Lang] }) {
  return (
    <CardContent className="pt-5">
      <div className="flex flex-col items-center rounded-3xl border border-sky-500/20 bg-sky-500/5 px-5 py-8 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-sky-500/10 text-sky-500">
          <Loader2Icon className="size-6 animate-spin" />
        </div>
        <CardTitle className="mt-4 text-xl">{labels.restoringTitle}</CardTitle>
        <CardDescription className="mt-2 max-w-lg leading-relaxed">
          {labels.restoringDesc}
        </CardDescription>
      </div>
    </CardContent>
  );
}

function FailureView({
  job,
  startNewExtraction,
  labels,
  debugLogPanel,
}: {
  job: SavedExtractJob;
  startNewExtraction: () => void;
  labels: typeof UI_TEXT[Lang];
  debugLogPanel?: ReactNode;
}) {
  const errorMessage = compactFailureMessage(job.error, labels, job.extractMethod || job.result?.extractMethod);
  return (
    <CardContent className="pt-5">
      <div className="flex flex-col gap-4">
        <div className="rounded-3xl border border-destructive/25 bg-destructive/10 p-5 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-destructive/15 text-destructive">
            <AlertCircleIcon className="size-6" />
          </div>
          <CardTitle className="mt-4 text-xl">{labels.failedTitle}</CardTitle>
          <CardDescription className="mt-2 leading-relaxed">
            {labels.failedDesc}
          </CardDescription>
          <AccountContactMeta
            accountEmail={job.accountEmail || job.result?.accountEmail || null}
            accountPhone={job.accountPhone || job.result?.accountPhone || null}
            labels={labels}
            className="mt-3 justify-center"
          />
          {errorMessage && (
            <div className="mt-4 rounded-2xl bg-background/80 p-3 text-left text-sm leading-relaxed text-destructive">
              {errorMessage}
            </div>
          )}
        </div>
        <Button type="button" variant="outline" className="rounded-xl" onClick={startNewExtraction}>
          <RotateCcwIcon data-icon="inline-start" />
          {labels.newExtraction}
        </Button>
        {debugLogPanel}
      </div>
    </CardContent>
  );
}

function ResultView({
  result,
  now,
  remainingText,
  copyText,
  startNewExtraction,
  labels,
  accountEmail,
  accountPhone,
  subscriptionPlan,
  subscriptionIsPlus,
  subscriptionCheckedAt,
  subscriptionCheckError,
  subscriptionChecking,
  onCheckSubscription,
  createdGuard,
  activeGuardId,
  creatingGuard,
  completingGuard,
  publicUser,
  wallet,
  autoPublishScanOrder,
  publishedScanOrder,
  publishingScanOrder,
  cancellingScanOrder,
  onCreateGuard,
  onCompleteGuard,
  onPublishScanOrder,
  onCancelScanOrder,
  debugLogPanel,
}: {
  result: UpiExtractResult;
  now: number;
  remainingText: string;
  copyText: (text: string, successMessage: string) => Promise<void>;
  startNewExtraction: () => void;
  labels: typeof UI_TEXT[Lang];
  accountEmail?: string | null;
  accountPhone?: string | null;
  subscriptionPlan?: string | null;
  subscriptionIsPlus?: boolean | null;
  subscriptionCheckedAt?: string | null;
  subscriptionCheckError?: string | null;
  subscriptionChecking?: boolean;
  onCheckSubscription?: () => void | Promise<void>;
  createdGuard: UpiGuardInfo | null;
  activeGuardId: string | null;
  creatingGuard: boolean;
  completingGuard: boolean;
  publicUser: PublicUserSession | null;
  wallet: PublicUserWalletSummary | null;
  autoPublishScanOrder: boolean;
  publishedScanOrder: PublicOrder | null;
  publishingScanOrder: boolean;
  cancellingScanOrder: boolean;
  onCreateGuard: (ttlHours: number) => void | Promise<void>;
  onCompleteGuard: (guardId: string) => void | Promise<void>;
  onPublishScanOrder: (token: string) => void | Promise<void>;
  onCancelScanOrder: (order: PublicOrder) => void | Promise<void>;
  debugLogPanel?: ReactNode;
}) {
  const resultMethod = normalizePaymentExtractMethod(result.extractMethod);
  const scanOrder = publishedScanOrder || result.scanOrder || null;
  const qrExpiresAtMs = new Date(result.expiresAt).getTime();
  const qrRemainingMs = qrExpiresAtMs - now;
  const qrStillValid = qrRemainingMs > 0;
  const qrHasEnoughTimeToPublish = qrRemainingMs > MIN_SCAN_ORDER_QR_REMAINING_MS;
  const showQrAfterCancelled = Boolean(scanOrder?.status === "CANCELLED" && qrStillValid);
  const activeScanOrder = scanOrder && !showQrAfterCancelled ? scanOrder : null;
  const canPublishScanOrder = Boolean(result.scanOrderCreateToken && !scanOrder && qrStillValid);
  const walletAvailable = wallet?.availableBalance ?? 0;
  const publishBlockedByTime = canPublishScanOrder && !qrHasEnoughTimeToPublish;
  const publishDisabled = publishingScanOrder || !publicUser || walletAvailable < SCAN_ORDER_PRICE || publishBlockedByTime;

  return (
    <>
      <CardHeader className="text-center">
        <CardTitle className="flex items-center justify-center gap-2 text-xl">
          <CheckCircle2Icon className="size-5 text-success" />
          {resultMethod === "ideal" ? labels.resultTitleIdeal : labels.resultTitle}
        </CardTitle>
        <CardDescription>
          {labels.qrRemaining}<span className="font-semibold text-foreground">{remainingText}</span>
        </CardDescription>
        <AccountContactMeta accountEmail={accountEmail} accountPhone={accountPhone} labels={labels} className="mt-2 justify-center" />
        <AccountSubscriptionMeta
          plan={subscriptionPlan}
          isPlus={subscriptionIsPlus}
          checkedAt={subscriptionCheckedAt}
          error={subscriptionCheckError}
          labels={labels}
          className="mt-2 justify-center"
        />
        {onCheckSubscription && (
          <div className="mt-2">
            <Button type="button" size="sm" variant="outline" className="rounded-xl" onClick={() => void onCheckSubscription()} disabled={subscriptionChecking}>
              {subscriptionChecking ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <RefreshCwIcon data-icon="inline-start" />}
              {subscriptionChecking ? labels.subscriptionChecking : labels.subscriptionCheckAction}
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="flex flex-col items-center gap-4">
        {activeScanOrder ? (
          <ScanOrderStatusPanel
            order={activeScanOrder}
            labels={labels}
            cancelling={cancellingScanOrder}
            onCancel={onCancelScanOrder}
          />
        ) : (
          <>
            <a href={result.qrImageUrl} target="_blank" rel="noreferrer" className="rounded-3xl border border-border bg-white p-3 shadow-sm">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={result.qrImageUrl} alt={resultMethod === "ideal" ? "IDEAL payment QR Code" : "UPI QR Code"} className="size-64 rounded-2xl object-contain" />
            </a>

            {scanOrder?.status === "CANCELLED" && (
              <div className="w-full rounded-2xl border border-warning/30 bg-warning/10 px-3 py-2 text-center text-xs font-medium text-warning">
                {labels.scanOrderCancelled}
              </div>
            )}
          </>
        )}

        {!activeScanOrder && (
          <>
            <div className="grid w-full gap-2 sm:grid-cols-2">
              <a href={result.paymentUrl} target="_blank" rel="noreferrer" className={cn(buttonVariants({ size: "lg" }), "h-10 w-full rounded-xl bg-foreground text-background hover:bg-foreground/90")}>
                <ExternalLinkIcon data-icon="inline-start" />
                {resultMethod === "ideal" ? labels.openPaymentIdeal : labels.openPayment}
              </a>
              <Button type="button" size="lg" variant="outline" className="h-10 rounded-xl" onClick={() => copyText(result.paymentUrl, resultMethod === "ideal" ? labels.paymentCopiedIdeal : labels.paymentCopied)}>
                <CopyIcon data-icon="inline-start" />
                {labels.copyPayment}
              </Button>
            </div>

            {(resultMethod === "ideal" || result.upiUri) && (
              <div className="w-full rounded-2xl bg-muted/40 p-3 text-xs text-muted-foreground">
                <div className="mb-1 flex items-center gap-2 font-medium text-foreground">
                  <AlertCircleIcon className="size-4" />
                  {resultMethod === "ideal" ? labels.idealContent : labels.upiContent}
                </div>
                <div className="max-h-24 overflow-y-auto break-all font-mono">{resultMethod === "ideal" ? result.paymentUrl : result.upiUri}</div>
              </div>
            )}
          </>
        )}

        {!activeScanOrder && (canPublishScanOrder || result.scanOrderError || autoPublishScanOrder || !publicUser) && (
        <div className="w-full rounded-3xl border border-border bg-muted/30 p-4 text-sm">
          <div className="flex items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-2xl bg-brand text-white">
              <QrCodeIcon className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-semibold text-foreground">{labels.scanOrderTitle}</div>
              <p className="mt-1 text-muted-foreground">{labels.scanOrderDesc}</p>
              {result.scanOrderError && (
                <p className="mt-2 rounded-2xl border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
                  {result.scanOrderError}
                </p>
              )}
              {canPublishScanOrder ? (
                <div className="mt-3 flex flex-col gap-2">
                  {!publicUser && <p className="text-xs text-warning">{labels.scanOrderLoginRequired}</p>}
                  {publicUser && walletAvailable < SCAN_ORDER_PRICE && <p className="text-xs text-warning">{labels.scanOrderInsufficientBalance}</p>}
                  {publishBlockedByTime && <p className="text-xs text-warning">{labels.scanOrderAlmostExpired}</p>}
                  <Button
                    type="button"
                    className="rounded-xl"
                    disabled={publishDisabled}
                    onClick={() => void onPublishScanOrder(result.scanOrderCreateToken || "")}
                  >
                    {publishingScanOrder ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <SendIcon data-icon="inline-start" />}
                    {publishingScanOrder ? labels.scanOrderPublishing : labels.publishScanOrder}
                  </Button>
                </div>
              ) : autoPublishScanOrder ? (
                <div className="mt-3 rounded-2xl border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
                  {labels.scanOrderAutoPending}
                </div>
              ) : !publicUser ? (
                <div className="mt-3 rounded-2xl border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
                  {labels.scanOrderLoginRequired}
                </div>
              ) : null}
            </div>
          </div>
        </div>
        )}

        {(result.guardCreateToken || createdGuard || activeGuardId) && (
          <GuardPanel
            result={result}
            createdGuard={createdGuard}
            activeGuardId={activeGuardId}
            creatingGuard={creatingGuard}
            completingGuard={completingGuard}
            labels={labels}
            copyText={copyText}
            onCreateGuard={onCreateGuard}
            onCompleteGuard={onCompleteGuard}
          />
        )}

        <Button type="button" variant="ghost" onClick={startNewExtraction}>
          <RotateCcwIcon data-icon="inline-start" />
          {resultMethod === "ideal" ? labels.newIdealExtraction : labels.newExtraction}
        </Button>

        {debugLogPanel}
      </CardContent>
    </>
  );
}

function ScanOrderStatusPanel({
  order,
  labels,
  cancelling,
  onCancel,
}: {
  order: PublicOrder;
  labels: typeof UI_TEXT[Lang];
  cancelling: boolean;
  onCancel: (order: PublicOrder) => void | Promise<void>;
}) {
  const canCancel = order.status === "PENDING";
  const isTerminal = ["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"].includes(order.status);
  return (
    <div className={cn(
      "w-full rounded-3xl border p-5 text-center",
      order.status === "COMPLETED"
        ? "border-success/30 bg-success/10"
        : isTerminal
          ? "border-warning/30 bg-warning/10"
          : "border-brand/25 bg-brand/10"
    )}>
      <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-background/80 text-brand">
        {order.status === "COMPLETED" ? <CheckCircle2Icon className="size-6 text-success" /> : <QrCodeIcon className="size-6" />}
      </div>
      <CardTitle className="mt-4 text-xl">{labels.scanOrderSent}</CardTitle>
      <CardDescription className="mt-2">
        <span className="font-mono font-semibold text-foreground">{order.orderNo}</span>
      </CardDescription>
      <div className="mt-4 rounded-2xl bg-background/80 p-3 text-sm">
        <div className="text-xs text-muted-foreground">{labels.scanOrderStatus}</div>
        <div className="mt-1 font-semibold text-foreground">{scanOrderStatusLabel(order.status, labels)}</div>
        {(order.assignedWorker ?? order.lastWorker) && (
          <div className="mt-1 text-xs text-muted-foreground">
            {(order.assignedWorker ?? order.lastWorker)?.displayName || (order.assignedWorker ?? order.lastWorker)?.username}
          </div>
        )}
        {order.problemReason && (
          <div className="mt-2 rounded-xl bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {order.problemReason}
          </div>
        )}
      </div>
      {canCancel && (
        <Button
          type="button"
          variant="outline"
          className="mt-4 rounded-xl border-destructive/30 text-destructive hover:bg-destructive/10"
          disabled={cancelling}
          onClick={() => void onCancel(order)}
        >
          {cancelling ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <XCircleIcon data-icon="inline-start" />}
          {cancelling ? labels.scanOrderCancelling : labels.scanOrderCancel}
        </Button>
      )}
    </div>
  );
}

function GuardPanel({
  result,
  createdGuard,
  activeGuardId,
  creatingGuard,
  completingGuard,
  labels,
  copyText,
  onCreateGuard,
  onCompleteGuard,
}: {
  result: UpiExtractResult;
  createdGuard: UpiGuardInfo | null;
  activeGuardId: string | null;
  creatingGuard: boolean;
  completingGuard: boolean;
  labels: typeof UI_TEXT[Lang];
  copyText: (text: string, successMessage: string) => Promise<void>;
  onCreateGuard: (ttlHours: number) => void | Promise<void>;
  onCompleteGuard: (guardId: string) => void | Promise<void>;
}) {
  const [ttlHours, setTtlHours] = useState<number>(24);
  const guardId = createdGuard?.guardId || activeGuardId || "";
  const canCreateGuard = Boolean(result.guardCreateToken && !createdGuard);
  const canCompleteGuard = Boolean(guardId && (!createdGuard || createdGuard.status === "ACTIVE"));

  return (
    <div className="w-full rounded-3xl border border-brand/20 bg-brand/5 p-4 text-sm">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-2xl bg-brand text-white">
          {activeGuardId && !createdGuard ? <KeyRoundIcon className="size-4" /> : <ShieldCheckIcon className="size-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-foreground">
            {activeGuardId && !createdGuard ? labels.activeGuardTitle : labels.guardPanelTitle}
          </div>
          <p className="mt-1 leading-relaxed text-muted-foreground">
            {labels.guardPanelDesc}
          </p>
          <p className="mt-2 rounded-2xl border border-warning/30 bg-warning/10 px-3 py-2 text-xs font-medium text-warning">
            {labels.guardStorageNotice}
          </p>
        </div>
      </div>

      {canCreateGuard && (
        <div className="mt-4 flex flex-col gap-3">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <ClockIcon className="size-4" />
              {labels.guardTtlLabel}
            </div>
            <div className="flex flex-wrap gap-2">
              {GUARD_TTL_OPTIONS.map((hours) => (
                <button
                  key={hours}
                  type="button"
                  onClick={() => setTtlHours(hours)}
                  className={cn(
                    "rounded-full border px-3 py-1.5 text-xs font-medium transition",
                    ttlHours === hours ? "border-brand bg-brand text-white" : "border-border bg-background text-muted-foreground hover:text-foreground"
                  )}
                >
                  {labels.guardTtlHours(hours)}
                </button>
              ))}
            </div>
          </div>
          <Button type="button" className="rounded-xl" disabled={creatingGuard} onClick={() => void onCreateGuard(ttlHours)}>
            {creatingGuard ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <KeyRoundIcon data-icon="inline-start" />}
            {creatingGuard ? labels.creatingGuard : labels.createGuard}
          </Button>
        </div>
      )}

      {createdGuard && (
        <div className="mt-4 flex flex-col gap-3 rounded-2xl border border-border bg-background/80 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{labels.guardIdLabel}</span>
            <span className="rounded-full bg-muted px-2 py-1 font-medium">
              {createdGuard.status === "COMPLETED" ? labels.guardCompletedState : createdGuard.status}
            </span>
          </div>
          <div className="break-all rounded-xl bg-muted/50 p-2 font-mono text-xs text-foreground">
            {createdGuard.guardId}
          </div>
          <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
            <div>{labels.guardExpiresAt}: <span className="font-medium text-foreground">{formatGuardDate(createdGuard.expiresAt, labels)}</span></div>
            <div>{labels.guardUseCount}: <span className="font-medium text-foreground">{createdGuard.useCount}</span></div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Button type="button" variant="outline" className="rounded-xl" onClick={() => copyText(createdGuard.guardId, labels.guardIdCopied)}>
              <CopyIcon data-icon="inline-start" />
              {labels.copyGuardId}
            </Button>
            <Button type="button" variant="outline" className="rounded-xl" onClick={() => copyText(makeGuardLink(createdGuard.guardId), labels.guardLinkCopied)}>
              <LinkIcon data-icon="inline-start" />
              {labels.copyGuardLink}
            </Button>
          </div>
        </div>
      )}

      {activeGuardId && !createdGuard && (
        <div className="mt-4 break-all rounded-2xl border border-border bg-background/80 p-3 font-mono text-xs text-foreground">
          {activeGuardId}
        </div>
      )}

      {canCompleteGuard && (
        <Button
          type="button"
          variant="outline"
          className="mt-3 w-full rounded-xl border-destructive/30 text-destructive hover:bg-destructive/10"
          disabled={completingGuard}
          onClick={() => void onCompleteGuard(guardId)}
        >
          {completingGuard ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <Trash2Icon data-icon="inline-start" />}
          {completingGuard ? labels.completingGuard : labels.completeGuard}
        </Button>
      )}
    </div>
  );
}

function AnimatedCardPage({ children }: { children: ReactNode }) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState<number | null>(null);

  useEffect(() => {
    const element = contentRef.current;
    if (!element) return;

    let frame = 0;
    const updateHeight = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        setHeight(element.getBoundingClientRect().height);
      });
    };

    updateHeight();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateHeight);
      return () => {
        window.cancelAnimationFrame(frame);
        window.removeEventListener("resize", updateHeight);
      };
    }

    const observer = new ResizeObserver(updateHeight);
    observer.observe(element);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  return (
    <div
      className="overflow-hidden transition-[height] duration-300 ease-out will-change-[height]"
      style={height === null ? undefined : { height }}
    >
      <div ref={contentRef} className="flex flex-col gap-(--card-spacing)">
        {children}
      </div>
    </div>
  );
}

function AccountTaskList({
  jobs,
  history,
  filter,
  counts,
  pagination,
  labels,
  now,
  cancellingJobId,
  subscriptionCheckingJobId,
  transitionPhase,
  onFilterChange,
  onPageChange,
  onViewJob,
  onCancelJob,
  onCheckSubscription,
}: {
  jobs: UpiExtractJob[];
  history: UserExtractHistoryItem[];
  filter: TaskHistoryFilter;
  counts: TaskHistoryCounts;
  pagination: TaskHistoryPagination | null;
  labels: typeof UI_TEXT[Lang];
  now: number;
  cancellingJobId: string | null;
  subscriptionCheckingJobId: string | null;
  transitionPhase: CardTransitionPhase;
  onFilterChange: (filter: TaskHistoryFilter) => void;
  onPageChange: (page: number) => void;
  onViewJob: (job: UpiExtractJob) => void;
  onCancelJob: (jobId: string) => void | Promise<void>;
  onCheckSubscription: (jobId: string) => void | Promise<void>;
}) {
  const liveJobById = new Map(jobs.map((job) => [job.jobId, job]));
  const historyJobIds = new Set(history.map((item) => item.jobId));
  const liveOnlyRows = (!pagination || pagination.page === 1)
    ? jobs.filter((job) => !historyJobIds.has(job.jobId) && matchesTaskHistoryFilter(job.status, filter))
    : [];
  const hasRows = liveOnlyRows.length > 0 || history.length > 0;
  const filterOptions: Array<{ value: TaskHistoryFilter; label: string; count: number }> = [
    { value: "all", label: labels.taskFilterAll, count: counts.all },
    { value: "active", label: labels.taskFilterActive, count: counts.active },
    { value: "completed", label: labels.taskFilterCompleted, count: counts.completed },
    { value: "failed", label: labels.taskFilterFailed, count: counts.failed },
  ];

  const renderJobRow = (job: UpiExtractJob) => {
    const canCancel = job.status === "queued" || job.status === "running";
    const scanOrder = job.result?.scanOrder || null;
    const canCheckSubscription = canShowSubscriptionCheckButton(job.status, job.result?.expiresAt || null, now);
    const createdAtMs = new Date(job.createdAt).getTime();
    const updatedAtMs = new Date(job.updatedAt || job.createdAt).getTime();
    const elapsedEndAt = canCancel ? now : Number.isFinite(updatedAtMs) ? updatedAtMs : now;
    const elapsed = Number.isFinite(createdAtMs) ? Math.max(0, Math.floor((elapsedEndAt - createdAtMs) / 1000)) : 0;
    const percent = Math.max(0, Math.min(100, Math.round(job.progress?.percent || (job.status === "completed" ? 100 : 0))));
    const cancelling = cancellingJobId === job.jobId;

    return (
      <div key={job.jobId} className="rounded-2xl border border-border bg-muted/25 p-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs font-semibold text-foreground">{shortJobId(job.jobId)}</span>
              <PaymentMethodPill method={job.extractMethod || job.result?.extractMethod} labels={labels} />
              <StatusPill status={job.status} labels={labels} />
              {canCancel && job.untilSuccess && (
                <span className="rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-semibold text-brand">
                  {labels.taskRetrying}
                </span>
              )}
              {scanOrder && (
                <span className="rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-semibold text-brand">
                  {labels.scanOrderSent}
                </span>
              )}
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>{labels.elapsed(elapsed)}</span>
              <span>{labels.progressPercent} {percent}%</span>
              <span>{formatShortTime(job.updatedAt, labels)}</span>
            </div>
            <AccountContactMeta
              accountEmail={job.accountEmail || job.result?.accountEmail || null}
              accountPhone={job.accountPhone || job.result?.accountPhone || null}
              labels={labels}
              className="mt-2"
            />
            <AccountSubscriptionMeta
              plan={job.subscriptionPlan}
              isPlus={job.subscriptionIsPlus}
              checkedAt={job.subscriptionCheckedAt}
              error={job.subscriptionCheckError}
              labels={labels}
              className="mt-2"
            />
            {scanOrder && (
              <div className="mt-2 flex flex-wrap gap-2 text-xs">
                <span className="font-mono text-muted-foreground">{scanOrder.orderNo}</span>
                <span className="font-semibold text-foreground">{scanOrderStatusLabel(scanOrder.status, labels)}</span>
              </div>
            )}
            {job.error && (
              <div className="mt-2 line-clamp-2 text-xs text-destructive">
                {compactFailureMessage(job.error, labels, job.extractMethod || job.result?.extractMethod)}
              </div>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" className="rounded-xl" onClick={() => onViewJob(job)}>
              <QrCodeIcon data-icon="inline-start" />
              {labels.taskView}
            </Button>
            {canCheckSubscription && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="rounded-xl"
                disabled={subscriptionCheckingJobId === job.jobId}
                onClick={() => void onCheckSubscription(job.jobId)}
              >
                {subscriptionCheckingJobId === job.jobId ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <RefreshCwIcon data-icon="inline-start" />}
                {subscriptionCheckingJobId === job.jobId ? labels.subscriptionChecking : labels.subscriptionCheckQuick}
              </Button>
            )}
            {canCancel && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="rounded-xl border-destructive/30 text-destructive hover:bg-destructive/10"
                disabled={cancelling}
                onClick={() => void onCancelJob(job.jobId)}
              >
                {cancelling ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <XCircleIcon data-icon="inline-start" />}
                {cancelling ? labels.cancellingTask : labels.cancelTask}
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  };

  const renderHistoryRow = (item: UserExtractHistoryItem) => {
    const resultExpiresAtMs = item.resultExpiresAt ? new Date(item.resultExpiresAt).getTime() : 0;
    const canOpenPayment = Boolean(item.resultPaymentUrl && Number.isFinite(resultExpiresAtMs) && resultExpiresAtMs > now);
    const canCheckSubscription = canShowSubscriptionCheckButton(item.status, item.resultExpiresAt || null, now);
    const canCancel = item.status === "queued" || item.status === "running";
    const cancelling = cancellingJobId === item.jobId;

    return (
      <div key={item.jobId} className="flex flex-col gap-2 rounded-2xl border border-border/70 bg-muted/15 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs font-semibold text-foreground">{shortJobId(item.jobId)}</span>
            <PaymentMethodPill method={item.extractMethod} labels={labels} />
            <StatusPill status={item.status} labels={labels} />
          </div>
          <div className="mt-1 text-xs text-muted-foreground">{formatHistoryDate(item.createdAt, labels)}</div>
          <AccountContactMeta
            accountEmail={item.accountEmail}
            accountPhone={item.accountPhone}
            labels={labels}
            className="mt-2"
          />
          <AccountSubscriptionMeta
            plan={item.subscriptionPlan}
            isPlus={item.subscriptionIsPlus}
            checkedAt={item.subscriptionCheckedAt}
            error={item.subscriptionCheckError}
            labels={labels}
            className="mt-2"
          />
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {canCheckSubscription && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="rounded-xl"
              disabled={subscriptionCheckingJobId === item.jobId}
              onClick={() => void onCheckSubscription(item.jobId)}
            >
              {subscriptionCheckingJobId === item.jobId ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <RefreshCwIcon data-icon="inline-start" />}
              {subscriptionCheckingJobId === item.jobId ? labels.subscriptionChecking : labels.subscriptionCheckQuick}
            </Button>
          )}
          {canOpenPayment && (
            <a href={item.resultPaymentUrl || "#"} target="_blank" rel="noreferrer" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "rounded-xl")}>
              <ExternalLinkIcon data-icon="inline-start" />
              {labels.openPayment}
            </a>
          )}
          {canCancel && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="rounded-xl border-destructive/30 text-destructive hover:bg-destructive/10"
              disabled={cancelling}
              onClick={() => void onCancelJob(item.jobId)}
            >
              {cancelling ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <XCircleIcon data-icon="inline-start" />}
              {cancelling ? labels.cancellingTask : labels.cancelTask}
            </Button>
          )}
        </div>
      </div>
    );
  };

  return (
    <CardContent className={cn("flex flex-col gap-3 pt-0", cardPageStaggerClass(transitionPhase))}>
      <div className="flex flex-wrap items-center gap-2">
        {filterOptions.map((option) => (
          <Button
            key={option.value}
            type="button"
            size="sm"
            variant={filter === option.value ? "default" : "outline"}
            className={cn(
              "rounded-xl",
              filter === option.value && "bg-brand/18 text-brand shadow-none hover:bg-brand/22"
            )}
            onClick={() => onFilterChange(option.value)}
          >
            {option.label}
            <span className={cn(
              "ml-1 rounded-full px-1.5 py-0.5 text-[11px] leading-none",
              filter === option.value ? "bg-brand/15 text-brand" : "bg-muted text-muted-foreground"
            )}>
              {option.count}
            </span>
          </Button>
        ))}
      </div>

      {!hasRows && (
        <div className="rounded-2xl bg-muted/40 p-4 text-sm text-muted-foreground">
          {labels.taskListEmpty}
        </div>
      )}

      {liveOnlyRows.map(renderJobRow)}
      {history.map((item) => {
        const liveJob = liveJobById.get(item.jobId);
        if (liveJob && matchesTaskHistoryFilter(liveJob.status, filter)) return renderJobRow(liveJob);
        if (liveJob) return null;
        return renderHistoryRow(item);
      })}

      {pagination && (
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1 text-sm">
          <div className="text-xs text-muted-foreground">
            {labels.taskPageSummary(pagination.page, pagination.totalPages, pagination.total, pagination.pageSize)}
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="rounded-xl"
              disabled={!pagination.hasPrev}
              onClick={() => onPageChange(Math.max(1, pagination.page - 1))}
            >
              {labels.taskPrevPage}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="rounded-xl"
              disabled={!pagination.hasNext}
              onClick={() => onPageChange(Math.min(pagination.totalPages, pagination.page + 1))}
            >
              {labels.taskNextPage}
            </Button>
          </div>
        </div>
      )}
    </CardContent>
  );
}

function canShowSubscriptionCheckButton(status: ActivityStatus, resultExpiresAt: string | null | undefined, now: number) {
  if (status === "queued" || status === "running") return false;
  const expiresAtMs = resultExpiresAt ? new Date(resultExpiresAt).getTime() : NaN;
  const hasValidExpiresAt = Number.isFinite(expiresAtMs);
  if (hasValidExpiresAt && expiresAtMs <= now) return false;

  // Failed records without a valid QR expiry are usually terminal extraction failures
  // or legacy expired failures. They no longer have a useful QR/session state for a
  // quick subscription check from the task list, so hide the button.
  if (status === "failed" && !hasValidExpiresAt) return false;

  return true;
}

function formatDebugLogTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString("en-US", { hour12: false });
}

function formatDebugLogDetails(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function ActivityHeatmap({
  items,
  counts,
  countsByChannel,
  labels,
}: {
  items: UpiExtractActivity[];
  counts: ActivityCounts;
  countsByChannel?: ActivityCountsByChannel;
  labels: typeof UI_TEXT[Lang];
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const previousStatusesRef = useRef<Map<string, ActivityStatus> | null>(null);
  const successPopSeqRef = useRef(0);
  const [successPop, setSuccessPop] = useState<{ id: number; amount: number } | null>(null);
  const maxColumns = getHeatmapMaxColumns(containerWidth, items.length);
  const columns = buildActivityColumns(items, maxColumns);
  const premiumRunningCount = countsByChannel?.premium?.running ?? items.filter((item) => item.status === "running" && item.channel === "premium").length;

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return undefined;

    const updateWidth = () => setContainerWidth(element.getBoundingClientRect().width);
    updateWidth();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateWidth);
      return () => window.removeEventListener("resize", updateWidth);
    }

    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const nextStatuses = new Map(items.map((item) => [item.jobId, item.status]));
    const previousStatuses = previousStatusesRef.current;

    if (previousStatuses) {
      const successDelta = items.filter((item) => (
        item.status === "completed" && previousStatuses.get(item.jobId) !== "completed"
      )).length;

      if (successDelta > 0 && successDelta <= 5) {
        const popId = successPopSeqRef.current + 1;
        successPopSeqRef.current = popId;
        setSuccessPop({ id: popId, amount: successDelta });
        const timer = window.setTimeout(() => {
          setSuccessPop((current) => current?.id === popId ? null : current);
        }, 1450);
        previousStatusesRef.current = nextStatuses;
        return () => window.clearTimeout(timer);
      }
    }

    previousStatusesRef.current = nextStatuses;
    return undefined;
  }, [items]);

  return (
    <div ref={containerRef} className="relative mx-auto w-full max-w-3xl rounded-3xl border border-border/60 bg-background/70 px-6 py-3 shadow-sm backdrop-blur">
      {successPop && (
        <div
          key={successPop.id}
          className="upi-success-pop pointer-events-none absolute left-1/2 top-5 z-10 -translate-x-1/2 text-xl font-black text-success drop-shadow-[0_2px_8px_rgba(0,0,0,0.18)]"
        >
          +{successPop.amount}
        </div>
      )}
      <div className="mb-3 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
        <LegendDot className="bg-success" label={`${counts.completed} ${labels.success}`} />
        <LegendDot className="bg-pink-500" label={`${counts.queued} ${labels.queued}`} />
        <LegendDot className="bg-sky-500" label={`${counts.running} ${labels.running}`} />
        <LegendDot className="bg-brand" label={`${premiumRunningCount} ${labels.premiumRunning}`} />
        <LegendDot className="bg-muted-foreground/45" label={`${counts.failed} ${labels.failed}`} />
      </div>
      <div
        className="mx-auto flex max-w-full justify-center overflow-hidden"
        style={{ columnGap: HEATMAP_CELL_GAP, rowGap: HEATMAP_WRAP_GAP }}
      >
        {columns.map((column) => (
          <div
            key={column.column}
            className="grid grid-rows-5"
            style={{ gap: HEATMAP_CELL_GAP }}
          >
            {Array.from({ length: HEATMAP_ROWS }, (_, row) => {
              const item = column.rows[row];
              const storageActive = item?.source === "storage" && (item.status === "queued" || item.status === "running");
              const premiumRunning = item?.status === "running" && item.channel === "premium";
              return (
                <div
                  key={`${column.column}-${row}`}
                  title={item ? `${storageActive ? labels.storageActive : statusLabel(item.status, labels)} - ${formatShortTime(item.updatedAt, labels)}` : undefined}
                  className={cn(
                    "rounded-[3px] transition-transform hover:scale-125",
                    !item && "invisible",
                    item?.status === "completed" && "bg-success",
                    item?.status === "queued" && !storageActive && "bg-pink-500",
                    item?.status === "running" && !storageActive && !premiumRunning && "animate-pulse bg-sky-500",
                    premiumRunning && "animate-pulse bg-brand",
                    storageActive && "animate-pulse bg-pink-500",
                    item?.status === "failed" && "bg-muted-foreground/45"
                  )}
                  style={{ width: HEATMAP_CELL_SIZE, height: HEATMAP_CELL_SIZE }}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function LegendDot({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className={cn("size-3 rounded-full", className)} />
      <span>{label}</span>
    </span>
  );
}

function AccountContactMeta({
  accountEmail,
  accountPhone,
  labels,
  className,
}: {
  accountEmail?: string | null;
  accountPhone?: string | null;
  labels: typeof UI_TEXT[Lang];
  className?: string;
}) {
  const email = String(accountEmail || "").trim();
  const phone = String(accountPhone || "").trim();
  if (!email && !phone) return null;

  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground", className)}>
      <span className="font-medium text-foreground">{labels.accountContact}</span>
      {email && (
        <span className="max-w-full truncate rounded-full bg-background px-2 py-0.5 font-mono text-[11px] text-foreground">
          {labels.accountEmail}: {email}
        </span>
      )}
      {phone && (
        <span className="max-w-full truncate rounded-full bg-background px-2 py-0.5 font-mono text-[11px] text-foreground">
          {labels.accountPhone}: {phone}
        </span>
      )}
    </div>
  );
}


function AccountSubscriptionMeta({
  plan,
  isPlus,
  checkedAt,
  error,
  labels,
  className,
}: {
  plan?: string | null;
  isPlus?: boolean | null;
  checkedAt?: string | null;
  error?: string | null;
  labels: typeof UI_TEXT[Lang];
  className?: string;
}) {
  const normalizedPlan = String(plan || "").trim();
  const hasChecked = Boolean(checkedAt || normalizedPlan || typeof isPlus === "boolean" || error);
  const statusText = isPlus === true
    ? labels.subscriptionPlus
    : isPlus === false
      ? (normalizedPlan && normalizedPlan !== "unknown" ? normalizedPlan : labels.subscriptionFree)
      : labels.subscriptionUnknown;

  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground", className)}>
      <span className="font-medium text-foreground">{labels.accountSubscription}</span>
      <span className={cn(
        "max-w-full truncate rounded-full px-2 py-0.5 font-mono text-[11px]",
        isPlus === true ? "bg-success/10 text-success" : error ? "bg-destructive/10 text-destructive" : "bg-background text-foreground"
      )}>
        {statusText}
      </span>
      {normalizedPlan && normalizedPlan !== statusText.toLowerCase() && (
        <span className="max-w-full truncate rounded-full bg-background px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
          {labels.subscriptionPlanLabel(normalizedPlan)}
        </span>
      )}
      {checkedAt && (
        <span className="rounded-full bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
          {labels.subscriptionCheckedAt(formatShortTime(checkedAt, labels))}
        </span>
      )}
      {error && (
        <span className="max-w-full truncate rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] text-destructive" title={error}>
          {compactFailureMessage(error, labels)}
        </span>
      )}
      {!hasChecked && (
        <span className="rounded-full bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
          {labels.subscriptionUnknown}
        </span>
      )}
    </div>
  );
}

function StatusPill({ status, labels }: { status: ActivityStatus; labels: typeof UI_TEXT[Lang] }) {
  const className = status === "completed"
    ? "bg-success/10 text-success"
    : status === "running"
      ? "bg-sky-500/10 text-sky-600"
      : status === "queued"
        ? "bg-warning/10 text-warning"
        : "bg-destructive/10 text-destructive";
  return (
    <span className={cn("shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium", className)}>
      {statusLabel(status, labels)}
    </span>
  );
}

function PaymentMethodPill({ method, labels }: { method?: PaymentExtractMethod | string | null; labels: typeof UI_TEXT[Lang] }) {
  const normalized = normalizePaymentExtractMethod(method);
  return (
    <span className={cn(
      "shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold",
      normalized === "ideal" ? "bg-violet-500/10 text-violet-600" : "bg-brand/10 text-brand"
    )}>
      {normalized === "ideal" ? labels.idealMethod : labels.upiMethod}
    </span>
  );
}

function getWalletLedgerDisplay(item: PublicUserWalletHistoryItem, labels: typeof UI_TEXT[Lang]) {
  const type = String(item.type || "");
  const availableDelta = Number(item.availableDelta || 0);
  const frozenDelta = Number(item.frozenDelta || 0);
  const frozenAmount = Math.abs(frozenDelta || Math.min(availableDelta, 0));
  const withdrawal = item.withdrawal;

  let title: string = labels.walletLedgerAdjustment;
  let amountValue = availableDelta || frozenDelta;
  let amountText: string = formatUsdtSigned(amountValue);
  let amountClassName: string = amountValue >= 0 ? "text-success" : "text-destructive";

  if (type === "CDK_REDEEM") {
    title = labels.walletLedgerCdkRedeem;
    amountValue = availableDelta;
    amountText = formatUsdtSigned(amountValue);
    amountClassName = "text-success";
  } else if (type === "CHAIN_DEPOSIT") {
    title = labels.walletLedgerDeposit;
    amountValue = availableDelta;
    amountText = formatUsdtSigned(amountValue);
    amountClassName = "text-success";
  } else if (type === "SCAN_ORDER_FREEZE") {
    title = labels.walletLedgerScanFreeze;
    amountValue = -frozenAmount;
    amountText = `${labels.walletLedgerFrozenAmount} ${formatUsdt(frozenAmount)}`;
    amountClassName = "text-warning";
  } else if (type === "SCAN_ORDER_REFUND") {
    title = labels.walletLedgerScanRefund;
    amountValue = Math.abs(availableDelta || frozenDelta);
    amountText = formatUsdtSigned(amountValue);
    amountClassName = "text-success";
  } else if (type === "SCAN_ORDER_SPEND") {
    title = labels.walletLedgerScanSpend;
    amountValue = -Math.abs(frozenDelta || availableDelta || SCAN_ORDER_PRICE);
    amountText = formatUsdtSigned(amountValue);
    amountClassName = "text-destructive";
  } else if (type === "WITHDRAWAL_FREEZE") {
    title = labels.walletLedgerWithdrawFreeze;
    amountValue = -Math.abs(withdrawal?.totalFrozen || frozenAmount || availableDelta);
    amountText = `${labels.walletLedgerFrozenAmount} ${formatUsdt(Math.abs(amountValue))}`;
    amountClassName = "text-warning";
  } else if (type === "WITHDRAWAL_REFUND") {
    title = labels.walletLedgerWithdrawRefund;
    amountValue = Math.abs(availableDelta || withdrawal?.totalFrozen || frozenDelta);
    amountText = formatUsdtSigned(amountValue);
    amountClassName = "text-success";
  } else if (type === "WITHDRAWAL_PAID") {
    title = labels.walletLedgerWithdrawPaid;
    amountValue = -Math.abs(frozenDelta || withdrawal?.totalFrozen || availableDelta);
    amountText = formatUsdtSigned(amountValue);
    amountClassName = "text-destructive";
  } else if (type === "ADMIN_ADJUSTMENT" && item.referenceId?.startsWith("pub_premium_purchase:")) {
    title = labels.walletLedgerPremiumPurchase;
    amountValue = availableDelta || frozenDelta;
    amountText = formatUsdtSigned(amountValue);
    amountClassName = "text-brand";
  } else if (type === "ADMIN_ADJUSTMENT") {
    title = labels.walletLedgerAdjustment;
    amountValue = availableDelta || frozenDelta;
    amountText = formatUsdtSigned(amountValue);
    amountClassName = amountValue >= 0 ? "text-success" : "text-destructive";
  }

  const statusText = withdrawal ? walletWithdrawalStatusLabel(withdrawal.status, labels) : "";
  const statusClassName = withdrawalStatusClassName(withdrawal?.status);
  const detail = walletLedgerDetail(item);

  return { title, amountText, amountClassName, statusText, statusClassName, detail };
}

function walletWithdrawalStatusLabel(status: PublicUserWithdrawalSummary["status"], labels: typeof UI_TEXT[Lang]) {
  if (status === "PAID") return labels.walletLedgerPaid;
  if (status === "REJECTED") return labels.walletLedgerRejected;
  if (status === "CANCELLED") return labels.walletLedgerCancelled;
  return labels.walletLedgerPending;
}

function withdrawalStatusClassName(status?: PublicUserWithdrawalSummary["status"]) {
  if (status === "PAID") return "bg-success/10 text-success";
  if (status === "REJECTED" || status === "CANCELLED") return "bg-destructive/10 text-destructive";
  return "bg-warning/10 text-warning";
}

function walletLedgerDetail(item: PublicUserWalletHistoryItem) {
  if (item.withdrawal?.withdrawalAddress) return maskMiddle(item.withdrawal.withdrawalAddress, 8, 6);
  if (item.orderId) return shortJobId(item.orderId);
  if (item.referenceId?.startsWith("0x")) return maskMiddle(item.referenceId, 10, 8);
  if (item.referenceId?.startsWith("pub_withdrawal:")) return shortJobId(item.referenceId.replace(/^pub_withdrawal:/, ""));
  return item.note || "";
}

function formatUsdt(value: number) {
  const amount = Number.isFinite(Number(value)) ? Math.abs(Number(value)) : 0;
  return `${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })} USDT`;
}

function formatCompactU(value: number) {
  const amount = Number.isFinite(Number(value)) ? Math.abs(Number(value)) : 0;
  return `${amount.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 6 })}U`;
}

function formatUsdtSigned(value: number) {
  const amount = Number.isFinite(Number(value)) ? Number(value) : 0;
  const sign = amount > 0 ? "+" : amount < 0 ? "-" : "";
  return `${sign}${formatUsdt(Math.abs(amount))}`;
}

function maskMiddle(value: string, head = 8, tail = 6) {
  const text = String(value || "");
  if (text.length <= head + tail + 3) return text;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

function shortJobId(jobId: string) {
  if (!jobId) return "-";
  return `${jobId.slice(0, 8)}…${jobId.slice(-6)}`;
}

function normalizeActivityItems(items?: Array<UpiExtractActivity | CompactActivityItem> | null): UpiExtractActivity[] {
  if (!Array.isArray(items)) return [];
  return items.map((item, index) => {
    if (!Array.isArray(item)) return { ...item, extractMethod: normalizePaymentExtractMethod(item.extractMethod) };
    const seq = Number(item[0]);
    const safeSeq = Number.isFinite(seq) ? seq : index;
    const updatedAtMs = Number(item[4]) * 1000;
    const updatedAt = Number.isFinite(updatedAtMs) && updatedAtMs > 0
      ? new Date(updatedAtMs).toISOString()
      : new Date().toISOString();
    return {
      jobId: `heatmap-${safeSeq}`,
      seq: safeSeq,
      status: decodeCompactActivityStatus(item[1]),
      channel: item[2] === "m" ? "premium" : "public",
      source: item[3] === "s" ? "storage" : "direct",
      createdAt: updatedAt,
      updatedAt,
    };
  });
}

function decodeCompactActivityStatus(status: CompactActivityStatus | undefined): ActivityStatus {
  if (status === "q") return "queued";
  if (status === "r") return "running";
  if (status === "c") return "completed";
  return "failed";
}

function countActivity(items: UpiExtractActivity[]) {
  const counts = emptyActivityCounts();
  for (const item of items) counts[item.status] += 1;
  return counts;
}

function countActivityByChannel(items: UpiExtractActivity[]): ActivityCountsByChannel {
  const counts = emptyActivityCountsByChannel();
  for (const item of items) {
    const channel = normalizeExtractChannel(item.channel);
    counts[channel][item.status] += 1;
  }
  return counts;
}

function emptyActivityCounts(): ActivityCounts {
  return { completed: 0, queued: 0, running: 0, failed: 0 };
}

function emptyActivityCountsByChannel(): ActivityCountsByChannel {
  return {
    public: emptyActivityCounts(),
    premium: emptyActivityCounts(),
  };
}

function normalizeActivityCounts(counts?: Partial<ActivityCounts> | null): ActivityCounts {
  return {
    completed: Math.max(0, Number(counts?.completed || 0)),
    queued: Math.max(0, Number(counts?.queued || 0)),
    running: Math.max(0, Number(counts?.running || 0)),
    failed: Math.max(0, Number(counts?.failed || 0)),
  };
}

function normalizeActivityCountsByChannel(counts?: Partial<Record<ExtractChannel, Partial<ActivityCounts>>> | null): ActivityCountsByChannel {
  return {
    public: normalizeActivityCounts(counts?.public),
    premium: normalizeActivityCounts(counts?.premium),
  };
}

function normalizeExtractChannel(channel?: string | null): ExtractChannel {
  return channel === "premium" ? "premium" : "public";
}

function normalizePaymentExtractMethod(method?: string | null): PaymentExtractMethod {
  return String(method || "").trim().toLowerCase() === "ideal" ? "ideal" : "upi";
}

function getSuccessToastForMethod(method: PaymentExtractMethod | string | null | undefined, labels: typeof UI_TEXT[Lang]) {
  return normalizePaymentExtractMethod(method) === "ideal" ? labels.successToastIdeal : labels.successToast;
}

function getFailedToastForMethod(method: PaymentExtractMethod | string | null | undefined, labels: typeof UI_TEXT[Lang]) {
  return normalizePaymentExtractMethod(method) === "ideal" ? labels.failedToastIdeal : labels.failedToast;
}

function isPremiumActive(user: PublicUserSession | null, now: number) {
  if (!user?.isPremium) return false;
  if (!user.premiumUntil) return true;
  const premiumUntilMs = new Date(user.premiumUntil).getTime();
  return Number.isFinite(premiumUntilMs) && premiumUntilMs > now;
}

function getPublicUserPremiumLabel(user: PublicUserSession | null | undefined, labels: typeof UI_TEXT[Lang]) {
  return user?.premiumTier === "premium_og" ? "Premium OG" : labels.premiumBadge;
}

function normalizePublicUserSettings(settings?: Partial<PublicUserSettings> | null): PublicUserSettings {
  return {
    successTgNotifyEnabled: Boolean(settings?.successTgNotifyEnabled),
    autoRetryUntilSuccessEnabled: Boolean(settings?.autoRetryUntilSuccessEnabled),
    depositRiskSigned: Boolean(settings?.depositRiskSigned),
    depositRiskSignedAt: settings?.depositRiskSignedAt || null,
  };
}

function normalizeExtractCapacity(capacity?: Partial<Record<ExtractChannel, Partial<ExtractCapacity[ExtractChannel]>>> | null): ExtractCapacity {
  return {
    public: {
      concurrency: normalizeCount(capacity?.public?.concurrency ?? DEFAULT_EXTRACT_CAPACITY.public.concurrency),
      proxyCount: normalizeCount(capacity?.public?.proxyCount ?? DEFAULT_EXTRACT_CAPACITY.public.proxyCount),
    },
    premium: {
      concurrency: normalizeCount(capacity?.premium?.concurrency ?? DEFAULT_EXTRACT_CAPACITY.premium.concurrency),
      proxyCount: normalizeCount(capacity?.premium?.proxyCount ?? DEFAULT_EXTRACT_CAPACITY.premium.proxyCount),
    },
  };
}

function isActiveScanOrder(order?: PublicOrder | null) {
  return Boolean(order && ["PENDING", "ASSIGNED", "CHECKING"].includes(order.status));
}

function scanOrderStatusLabel(status: PublicOrder["status"], labels: typeof UI_TEXT[Lang]) {
  switch (status) {
    case "PENDING":
      return labels.scanOrderPending;
    case "ASSIGNED":
      return labels.scanOrderAssigned;
    case "CHECKING":
      return labels.scanOrderChecking;
    case "COMPLETED":
      return labels.scanOrderCompleted;
    case "FAILED":
      return labels.scanOrderFailed;
    case "CANCELLED":
      return labels.scanOrderCancelled;
    case "EXPIRED":
      return labels.scanOrderExpired;
    default:
      return status;
  }
}

function cardPageStaggerClass(phase: CardTransitionPhase) {
  if (phase === "leaving") return "upi-card-page-leave";
  if (phase === "entering") return "upi-card-page-enter";
  return "";
}

function normalizeCount(value: unknown) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

function normalizeApprovalParallelism(value: unknown) {
  const parsed = Number(value ?? 1);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.floor(parsed));
}

function compactFailureMessage(error: string | null | undefined, labels: typeof UI_TEXT[Lang], extractMethod?: PaymentExtractMethod | null) {
  const message = String(error || "").trim();
  if (!message) return "";
  const lower = message.toLowerCase();
  const method = normalizePaymentExtractMethod(extractMethod);

  if (lower.includes("deposit is temporarily closed") || message.includes("充值功能暂时关闭")) {
    return labels.depositDisabled;
  }

  if (lower.includes("maintenance") || lower.includes("temporarily under maintenance") || message.includes("UPI 提取功能暂时关闭")) {
    return labels.maintenanceDesc;
  }

  if (
    lower.includes("no valid session token") ||
    lower.includes("session token") && lower.includes("invalid") ||
    lower.includes("session cookie") && lower.includes("invalid") ||
    lower.includes("session json") && lower.includes("invalid") ||
    message.includes("没有识别到有效的 session token")
  ) {
    return labels.failedReasonInvalidSession;
  }

  if (
    lower.includes("no_free_trial") ||
    lower.includes("does not have the free trial offer") ||
    lower.includes("no free trial") ||
    message.includes("没有免费试用")
  ) {
    return labels.failedReasonNoFreeTrial;
  }

  if (
    lower.includes("payment_method_unavailable") ||
    lower.includes("available_payment_method_types") ||
    lower.includes("cannot create a upi payment") ||
    lower.includes("cannot create an ideal payment") ||
    lower.includes("cannot create this payment method") ||
    message.includes("无法创建当前渠道的支付")
  ) {
    return labels.failedReasonPaymentMethodUnavailable;
  }

  if (
    lower.includes("billing country must match request country") ||
    lower.includes("billing country") && lower.includes("request country") ||
    lower.includes("region is locked") ||
    message.includes("账号地区已被 OpenAI 锁定")
  ) {
    return labels.failedReasonBillingCountry;
  }

  if (lower.includes('"result":"blocked"') || lower.includes("approve") || lower.includes("approval") || lower.includes("approve_attempts")) {
    return labels.failedReasonApproveBlocked;
  }

  if (
    lower.includes("econnrefused") ||
    lower.includes("socks5://") ||
    lower.includes("socks5") ||
    lower.includes("authentication timeout") ||
    lower.includes("fetch failed") ||
    lower.includes("connect timeout") ||
    lower.includes("exit nodes are failing")
  ) {
    return labels.failedReasonProxy;
  }

  if (method === "ideal" && (lower.includes("upi qr generation failed") || lower.includes("ideal payment link generation failed"))) {
    return labels.failedReasonGenericIdeal;
  }

  if (lower.includes("upi://") || lower.includes("upi data") || lower.includes("no upi") || lower.includes("payment response")) {
    if (method === "ideal") return labels.failedReasonGenericIdeal;
    return labels.failedReasonNoQr;
  }

  if (isPlainAsciiMessage(message) && !lower.includes("approve_attempts") && !lower.includes("socks5://")) {
    return message;
  }

  return labels.failedReasonGeneric;
}

function isPlainAsciiMessage(message: string) {
  if (message.length > 180) return false;
  return Array.from(message).every((char) => {
    const code = char.charCodeAt(0);
    return code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126);
  });
}

function activitySeq(item: UpiExtractActivity, fallback: number) {
  return Number.isFinite(item.seq) ? Number(item.seq) : fallback;
}

function getHeatmapMaxColumns(containerWidth: number, itemCount: number) {
  if (containerWidth <= 0) return Math.max(1, Math.ceil(Math.min(itemCount, 60) / HEATMAP_ROWS));
  const horizontalPadding = 48;
  const availableWidth = Math.max(0, containerWidth - horizontalPadding);
  return Math.max(
    1,
    Math.floor((availableWidth + HEATMAP_CELL_GAP) / (HEATMAP_CELL_SIZE + HEATMAP_CELL_GAP))
  );
}

function buildActivityColumns(items: UpiExtractActivity[], maxColumns: number) {
  const capacity = Math.max(HEATMAP_ROWS, maxColumns * HEATMAP_ROWS);
  const sorted = items
    .map((item, index) => ({ item, seq: activitySeq(item, index) }))
    .sort((a, b) => a.seq - b.seq || a.item.createdAt.localeCompare(b.item.createdAt));
  const visible = selectVisibleActivityItems(sorted, capacity);
  const byColumn = new Map<number, Array<UpiExtractActivity | undefined>>();

  visible.forEach(({ item }, displayIndex) => {
    const columnIndex = Math.floor(displayIndex / HEATMAP_ROWS);
    const rowIndex = displayIndex % HEATMAP_ROWS;
    const column = byColumn.get(columnIndex) || Array<UpiExtractActivity | undefined>(HEATMAP_ROWS).fill(undefined);
    column[rowIndex] = item;
    byColumn.set(columnIndex, column);
  });

  if (byColumn.size === 0) return [];

  const maxColumnIndex = Math.max(...byColumn.keys());
  return Array.from({ length: maxColumnIndex + 1 }, (_, column) => {
    return {
      column,
      rows: byColumn.get(column) || Array<UpiExtractActivity | undefined>(HEATMAP_ROWS).fill(undefined),
    };
  });
}

function selectVisibleActivityItems(
  sorted: Array<{ item: UpiExtractActivity; seq: number }>,
  capacity: number
) {
  const safeCapacity = Math.max(HEATMAP_ROWS, Math.floor(capacity));
  if (sorted.length <= safeCapacity) return sorted;

  const activeItems = sorted.filter(({ item }) => item.status === "queued" || item.status === "running");
  if (activeItems.length >= safeCapacity) return activeItems.slice(-safeCapacity);

  const activeJobIds = new Set(activeItems.map(({ item }) => item.jobId));
  const terminalItems = sorted.filter(({ item }) => !activeJobIds.has(item.jobId));
  return [...terminalItems.slice(-(safeCapacity - activeItems.length)), ...activeItems]
    .sort((a, b) => a.seq - b.seq || a.item.createdAt.localeCompare(b.item.createdAt));
}

function nextMockSeq(items: UpiExtractActivity[]) {
  return items.reduce((max, item, index) => Math.max(max, activitySeq(item, index)), -1) + 1;
}

function normalizeProgressForUi(progress: UpiExtractProgress | null): UpiExtractProgress {
  const current = progress || { stage: "queued" as const, percent: 4 };
  if (current.stage === "queued") return { ...current, stage: "validating", percent: Math.max(current.percent, 4) };
  if (current.stage === "retrying") return { ...current, stage: "validating", percent: Math.max(current.percent, 8) };
  if (current.stage === "hydrating") return { ...current, stage: "waiting_qr", percent: Math.max(current.percent, 90) };
  if (current.stage === "completed") return { ...current, stage: "completed", percent: 100 };
  return current;
}

function getProgressStageIndex(stage: UpiProgressStage) {
  if (stage === "completed") return PROGRESS_STAGES.length;
  const index = PROGRESS_STAGES.indexOf(stage);
  return index >= 0 ? index : 0;
}

function getOrCreateViewerId() {
  if (typeof window === "undefined") return "";
  try {
    const existing = window.sessionStorage.getItem(VIEWER_STORAGE_KEY);
    if (existing) return existing;
    const next = `viewer_${window.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
    window.sessionStorage.setItem(VIEWER_STORAGE_KEY, next);
    return next;
  } catch {
    return `viewer_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }
}

function getInitialLanguage(): Lang {
  if (typeof window === "undefined") return "zh";
  try {
    const saved = window.localStorage.getItem(LANG_STORAGE_KEY);
    if (saved === "zh" || saved === "en") return saved;
  } catch {
    // Ignore unavailable storage.
  }
  return window.navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

function getInitialSuppressCompletedAutoView() {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SUPPRESS_COMPLETED_AUTO_VIEW_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function saveSuppressCompletedAutoView(value: boolean) {
  if (typeof window === "undefined") return;
  try {
    if (value) window.localStorage.setItem(SUPPRESS_COMPLETED_AUTO_VIEW_STORAGE_KEY, "1");
    else window.localStorage.removeItem(SUPPRESS_COMPLETED_AUTO_VIEW_STORAGE_KEY);
  } catch {
    // Ignore unavailable storage.
  }
}

function getInitialGuardIdFromUrl() {
  if (typeof window === "undefined") return "";
  try {
    return new URLSearchParams(window.location.search).get(GUARD_QUERY_PARAM)?.trim() || "";
  } catch {
    return "";
  }
}

function makeMockActivity(seedAt = Date.now()): UpiExtractActivity[] {
  const now = seedAt;
  const statuses: ActivityStatus[] = [];
  for (let i = 0; i < 190; i += 1) {
    if (i % 31 === 0 || i % 37 === 0) statuses.push("queued");
    else if (i % 17 === 0 || i % 23 === 0) statuses.push("running");
    else if (i % 5 === 0 || i % 9 === 0 || i % 29 === 0) statuses.push("completed");
    else statuses.push("failed");
  }
  return statuses.map((status, index) => ({
    jobId: `mock-${index}`,
    seq: index,
    status,
    source: index % 13 === 0 ? "storage" as const : "direct" as const,
    createdAt: new Date(now - (statuses.length - index) * 45_000).toISOString(),
    updatedAt: new Date(now - (statuses.length - index) * 45_000).toISOString(),
  }));
}

function makeMockResult(issueGuardCreateToken = true, method: PaymentExtractMethod = "upi"): UpiExtractResult {
  if (method === "ideal") {
    const paymentUrl = "https://hooks.stripe.com/redirect/mock_ideal_payment";
    return {
      qrImageUrl: makeMockQrSvg(paymentUrl),
      checkoutSessionId: "cs_mock_ideal_extract",
      processorEntity: "openai_llc",
      paymentUrl,
      extractMethod: "ideal",
      chatGptPaymentUrl: "https://chatgpt.com/checkout/openai_llc/cs_mock_ideal_extract",
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      createdAt: new Date().toISOString(),
    };
  }
  const upiUri = "upi://mandate?ver=01&pa=openai&pn=OpenAI&tr=mock-order&am=1999.00&cu=INR&tn=OpenAI%20subscription";
  return {
    qrImageUrl: makeMockQrSvg(),
    upiUri,
    checkoutSessionId: "cs_mock_upi_extract",
    processorEntity: "openai_llc",
    paymentUrl: "https://payments.stripe.com/upi/instructions/mock_upi_extract",
    extractMethod: "upi",
    chatGptPaymentUrl: "https://chatgpt.com/checkout/openai_llc/cs_mock_upi_extract",
    stripeInstructionsUrl: "https://payments.stripe.com/upi/instructions/mock_upi_extract",
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    createdAt: new Date().toISOString(),
    ...(issueGuardCreateToken ? { guardCreateToken: "mock_guard_create_token" } : {}),
  };
}

function makeMockScanOrder(): PublicOrder {
  const now = new Date().toISOString();
  return {
    id: `mock-scan-order-${Date.now()}`,
    orderNo: `UPI-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-MOCK`,
    source: "PUBLIC_SCAN",
    scanPrice: SCAN_ORDER_PRICE,
    qrImageUrl: makeMockQrSvg(),
    qrVersion: 1,
    qrDecodedText: "upi://pay?pa=mock",
    qrIsUpi: true,
    upiExtractionStatus: "READY",
    upiExpiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    hasSessionCredential: true,
    holdsFrozenCount: true,
    status: "PENDING",
    createdAt: now,
    updatedAt: now,
    cdk: null,
    assignedWorker: null,
  };
}

function toSavedJob(job: UpiExtractJob | SavedExtractJob): SavedExtractJob {
  return {
    jobId: job.jobId,
    status: job.status,
    source: job.source,
    channel: normalizeExtractChannel(job.channel),
    extractMethod: normalizePaymentExtractMethod(job.extractMethod || job.result?.extractMethod),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    progress: job.progress,
    result: job.result,
    error: job.error,
    accountEmail: job.accountEmail || job.result?.accountEmail || null,
    accountPhone: job.accountPhone || job.result?.accountPhone || null,
    untilSuccess: job.untilSuccess,
    retryCount: job.retryCount,
    cancelled: job.cancelled,
  };
}

function mergeExtractJobs(current: UpiExtractJob[], updates: UpiExtractJob[]) {
  if (updates.length === 0) return current;
  const mergedById = new Map<string, UpiExtractJob>();
  for (const job of current) {
    if (!job.cancelled) mergedById.set(job.jobId, job);
  }
  for (const job of updates) {
    if (job.cancelled) {
      mergedById.delete(job.jobId);
      continue;
    }
    const existing = mergedById.get(job.jobId);
    mergedById.set(job.jobId, {
      ...existing,
      ...job,
      extractMethod: normalizePaymentExtractMethod(job.extractMethod || job.result?.extractMethod || existing?.extractMethod || existing?.result?.extractMethod),
      result: job.result || existing?.result,
      progress: job.progress || existing?.progress,
      accountEmail: job.accountEmail || job.result?.accountEmail || existing?.accountEmail || existing?.result?.accountEmail || null,
      accountPhone: job.accountPhone || job.result?.accountPhone || existing?.accountPhone || existing?.result?.accountPhone || null,
    });
  }
  return Array.from(mergedById.values())
    .filter((job) => !job.cancelled)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 20);
}

function emptyTaskHistoryCounts(): TaskHistoryCounts {
  return { all: 0, active: 0, completed: 0, failed: 0 };
}

function normalizeTaskHistoryCounts(counts?: Partial<TaskHistoryCounts> | null): TaskHistoryCounts {
  return {
    all: Math.max(0, Number(counts?.all || 0)),
    active: Math.max(0, Number(counts?.active || 0)),
    completed: Math.max(0, Number(counts?.completed || 0)),
    failed: Math.max(0, Number(counts?.failed || 0)),
  };
}

function matchesTaskHistoryFilter(status: ActivityStatus, filter: TaskHistoryFilter) {
  if (filter === "active") return status === "queued" || status === "running";
  if (filter === "completed") return status === "completed";
  if (filter === "failed") return status === "failed";
  return true;
}

function formatWalletDisplay(value: number) {
  const amount = Number.isFinite(Number(value)) ? Number(value) : 0;
  return `$${amount.toLocaleString("en-US", {
    minimumFractionDigits: amount % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

function saveCurrentJob(job: UpiExtractJob | SavedExtractJob) {
  if (typeof window === "undefined") return;
  try {
    if (job.cancelled) {
      window.localStorage.removeItem(CURRENT_JOB_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(CURRENT_JOB_STORAGE_KEY, JSON.stringify(toSavedJob(job)));
  } catch {
    // Ignore unavailable storage.
  }
}

function loadCurrentJob() {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CURRENT_JOB_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedExtractJob;
    if (!parsed?.jobId || !parsed.status || !parsed.createdAt) return null;
    if (parsed.cancelled) {
      window.localStorage.removeItem(CURRENT_JOB_STORAGE_KEY);
      return null;
    }
    parsed.channel = normalizeExtractChannel(parsed.channel);
    const ageMs = Date.now() - new Date(parsed.createdAt).getTime();
    if (!Number.isFinite(ageMs) || ageMs > 24 * 60 * 60 * 1000) {
      window.localStorage.removeItem(CURRENT_JOB_STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function clearCurrentJob() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(CURRENT_JOB_STORAGE_KEY);
  } catch {
    // Ignore unavailable storage.
  }
}

function makeMockGuard(ttlHours: number, fixedGuardId?: string): UpiGuardInfo {
  return {
    guardId: fixedGuardId || `guard_mock${Math.random().toString(36).slice(2, 18).padEnd(16, "x")}`,
    status: "ACTIVE",
    expiresAt: new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString(),
    useCount: 0,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };
}

function makeMockQrSvg(content = "") {
  const seed = content.length;
  const cells = Array.from({ length: 21 * 21 }, (_, index) => {
    const x = index % 21;
    const y = Math.floor(index / 21);
    const finder = (x < 7 && y < 7) || (x >= 14 && y < 7) || (x < 7 && y >= 14);
    const on = finder
      ? x % 6 === 0 || y % 6 === 0 || (x % 6 >= 2 && x % 6 <= 4 && y % 6 >= 2 && y % 6 <= 4)
      : (x * 7 + y * 11 + x * y + seed) % 5 < 2;
    return on ? `<rect x="${x + 2}" y="${y + 2}" width="1" height="1"/>` : "";
  }).join("");
  return `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 25 25"><rect width="25" height="25" fill="white"/><g fill="black">${cells}</g></svg>`)}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function formatCount(value: number) {
  return new Intl.NumberFormat("en-US").format(Math.max(0, Math.floor(Number(value) || 0)));
}

function formatRemaining(expiresAt: string, now: number, labels: typeof UI_TEXT[Lang]) {
  const remaining = Math.max(0, new Date(expiresAt).getTime() - now);
  if (remaining <= 0) return labels.expired;
  const totalSeconds = Math.ceil(remaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatDuration(seconds: number) {
  const totalSeconds = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(totalSeconds / 60);
  const rest = totalSeconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function formatShortTime(value: string, labels: typeof UI_TEXT[Lang]) {
  const locale = labels === UI_TEXT.zh ? "zh-CN" : "en-US";
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function formatHistoryDate(value: string, labels: typeof UI_TEXT[Lang]) {
  const locale = labels === UI_TEXT.zh ? "zh-CN" : "en-US";
  return new Intl.DateTimeFormat(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatGuardDate(value: string, labels: typeof UI_TEXT[Lang]) {
  const locale = labels === UI_TEXT.zh ? "zh-CN" : "en-US";
  return new Intl.DateTimeFormat(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatPremiumUntil(value: string | null | undefined, labels: typeof UI_TEXT[Lang]) {
  if (!value) return `${labels.premiumUntilLabel}: ${labels.premiumPermanent}`;
  const locale = labels === UI_TEXT.zh ? "zh-CN" : "en-US";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return `${labels.premiumUntilLabel}: ${labels.premiumPermanent}`;
  return `${labels.premiumUntilLabel}: ${new Intl.DateTimeFormat(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)}`;
}

function makeGuardLink(guardId: string) {
  if (typeof window === "undefined") return `/?${GUARD_QUERY_PARAM}=${encodeURIComponent(guardId)}`;
  const url = new URL(window.location.href);
  url.searchParams.delete("mock");
  url.searchParams.set(GUARD_QUERY_PARAM, guardId);
  return url.toString();
}

function makeTelegramLoginLink(code: string) {
  return `https://t.me/${TELEGRAM_BOT_USERNAME}?start=${encodeURIComponent(`login_${code}`)}`;
}

function statusLabel(status: ActivityStatus, labels: typeof UI_TEXT[Lang]) {
  if (status === "completed") return labels.success;
  if (status === "queued") return labels.queued;
  if (status === "running") return labels.running;
  return labels.failed;
}
