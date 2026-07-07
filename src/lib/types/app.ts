export type CdkStatus = "ACTIVE" | "DISABLED" | "EXPIRED";
export type WorkerStatus = "ONLINE" | "OFFLINE";
export type WorkerPayoutMode = "POSTPAID" | "PREPAID";
export type OrderStatus = "PENDING" | "ASSIGNED" | "CHECKING" | "NEED_REUPLOAD" | "COMPLETED" | "FAILED" | "CANCELLED" | "EXPIRED";
export type OrderSource = "CDK" | "PUBLIC_SCAN";
export type UpiExtractionStatus = "PENDING" | "GENERATING" | "READY" | "FAILED";
export type SubscriptionCheckStatus = "IDLE" | "CHECKING" | "FAILED" | "VERIFIED";
export type WorkerWithdrawalStatus = "PENDING" | "PAID" | "REJECTED" | "CANCELLED";

export type PublicCdk = {
  id: string;
  code: string;
  batchId?: string | null;
  amount: number;
  totalCount: number;
  usedCount: number;
  frozenCount: number;
  availableCount: number;
  status: CdkStatus;
  remark?: string | null;
  expiresAt?: string | null;
  redeemedByTelegramId?: string | null;
  redeemedByTelegramName?: string | null;
  redeemedAt?: string | null;
  createdAt: string;
};

export type PublicCdkBatch = {
  id: string;
  name?: string | null;
  keyCount: number;
  amount: number;
  totalCount: number;
  remark?: string | null;
  cdkCount: number;
  createdAt: string;
};

export type PublicWorker = {
  id: string;
  username: string;
  displayName: string;
  unitPrice: number;
  payoutMode: WorkerPayoutMode;
  binanceUserId?: string | null;
  telegramUserId?: string | null;
  telegramUsername?: string | null;
  status: WorkerStatus;
  isDisabled?: boolean;
  autoAcceptEnabled: boolean;
  autoAcceptNotifyEnabled: boolean;
  newOrderSoundEnabled: boolean;
  lastSeenAt?: string | null;
  createdAt?: string;
};

export type WorkerWalletSummary = {
  balance: number;
  availableBalance: number;
  pendingWithdrawalAmount: number;
  completedEarnings: number;
  settledAmount: number;
  ledgerAmount: number;
  advanceAmount: number;
};

export type PublicWorkerWithdrawalRequest = {
  id: string;
  workerId: string;
  worker?: Pick<PublicWorker, "id" | "username" | "displayName" | "binanceUserId"> | null;
  amount: number;
  status: WorkerWithdrawalStatus;
  binanceUserIdSnapshot: string;
  note?: string | null;
  adminNote?: string | null;
  requestedAt: string;
  processedAt?: string | null;
  processedBy?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PublicOrder = {
  id: string;
  customerToken?: string;
  orderNo: string;
  source?: OrderSource;
  publicUserTelegramId?: string | null;
  publicUserTelegramName?: string | null;
  scanPrice?: number;
  qrImageUrl: string;
  qrVersion: number;
  qrDecodedText?: string | null;
  qrIsUpi?: boolean | null;
  paymentUrl?: string | null;
  upiExtractionStatus?: UpiExtractionStatus;
  upiExtractError?: string | null;
  upiExtractedAt?: string | null;
  upiExpiresAt?: string | null;
  subscriptionCheckStatus?: SubscriptionCheckStatus;
  subscriptionCheckRounds?: number;
  subscriptionCheckAttemptCount?: number;
  subscriptionCheckLastPlan?: string | null;
  subscriptionCheckLastError?: string | null;
  subscriptionCheckedAt?: string | null;
  hasSessionCredential?: boolean;
  holdsFrozenCount?: boolean;
  status: OrderStatus;
  customerNote?: string | null;
  problemReason?: string | null;
  completedBy?: "CUSTOMER" | "WORKER" | "SYSTEM" | null;
  assignedAt?: string | null;
  completedAt?: string | null;
  failedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  cdk?: PublicCdk | null;
  assignedWorker?: Pick<PublicWorker, "id" | "username" | "displayName"> | null;
  lastWorker?: Pick<PublicWorker, "id" | "username" | "displayName"> | null;
};

export type WorkerStats = {
  unitPrice: number;
  wallet: WorkerWalletSummary;
  todayCompleted: number;
  todayAmount: number;
  totalCompleted: number;
  problemCount: number;
  activeOrderCount: number;
  unsettledCompleted: number;
  unsettledAmount: number;
  settledCompleted: number;
  settledAmount: number;
  totalAmount: number;
  dayStart: string;
  dayEnd: string;
};

export type PublicUpstreamProxy = {
  id: string;
  index: number;
  source:
    | "UPSTREAM_PROXY_LIST"
    | "UPI_PROXY_LIST"
    | "UPSTREAM_PROXY"
    | "PREMIUM_UPSTREAM_PROXY_LIST"
    | "PREMIUM_UPI_PROXY_LIST"
    | "PREMIUM_UPSTREAM_PROXY"
    | "ADMIN_PUBLIC_PROXY_LIST"
    | "ADMIN_PREMIUM_PROXY_LIST";
  redactedUrl: string;
  scheme: string;
  host: string;
  port: string;
};

export type PublicProxyCheckResult = PublicUpstreamProxy & {
  ok: boolean;
  expectedCountry: string;
  checkedAt: string;
  latencyMs: number;
  ip?: string;
  country?: string;
  countryCode?: string;
  region?: string;
  city?: string;
  org?: string;
  asn?: string;
  chatgptStatus?: number;
  stripeStatus?: number;
  telegramStatus?: number;
  error?: string;
  warnings: string[];
};

export type PublicProxyCheckSummary = {
  checkedAt: string;
  total: number;
  ok: number;
  failed: number;
  expectedCountry: string;
  results: PublicProxyCheckResult[];
};

export type PublicProxySelection = {
  selectedProxyId: string;
  selectedProxy: PublicUpstreamProxy | null;
  mode: "AUTO" | "MANUAL";
};

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; message: string; details?: unknown };

export type AdminPaginationMeta = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasPrev: boolean;
  hasNext: boolean;
  search: string;
};

export type AdminPaginatedResponse<T> = {
  items: T[];
  pagination: AdminPaginationMeta;
};
