import { Prisma, type Cdk, type CdkBatch, type Order, type Worker, type WorkerWithdrawalRequest } from "@prisma/client";

export type OrderWorkerSummary = Pick<Worker, "id" | "username" | "displayName">;

export type OrderWithRelations = Order & {
  cdk: Cdk | null;
  assignedWorker: OrderWorkerSummary | null;
  records?: Array<{
    worker: OrderWorkerSummary | null;
  }>;
};

export function decimalToNumber(value: Prisma.Decimal | number | string | null | undefined) {
  if (value == null) return 0;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

export function getCdkAvailable(cdk: Pick<Cdk, "totalCount" | "usedCount" | "frozenCount">) {
  return Math.max(0, cdk.totalCount - cdk.usedCount - cdk.frozenCount);
}

export function serializeCdk(cdk: Cdk) {
  return {
    id: cdk.id,
    code: cdk.code,
    batchId: cdk.batchId,
    amount: decimalToNumber(cdk.amount),
    totalCount: cdk.totalCount,
    usedCount: cdk.usedCount,
    frozenCount: cdk.frozenCount,
    availableCount: getCdkAvailable(cdk),
    status: cdk.status,
    remark: cdk.remark,
    expiresAt: cdk.expiresAt,
    redeemedByTelegramId: cdk.redeemedByTelegramId,
    redeemedByTelegramName: cdk.redeemedByTelegramName,
    redeemedAt: cdk.redeemedAt,
    createdAt: cdk.createdAt,
  };
}

export function serializeCdkBatch(batch: CdkBatch & { _count?: { cdks: number } }) {
  return {
    id: batch.id,
    name: batch.name,
    keyCount: batch.keyCount,
    amount: decimalToNumber(batch.amount),
    totalCount: batch.totalCount,
    remark: batch.remark,
    cdkCount: batch._count?.cdks ?? batch.keyCount,
    createdAt: batch.createdAt,
  };
}

export function serializeWorker(
  worker: Pick<
    Worker,
    | "id"
    | "username"
    | "displayName"
    | "unitPrice"
    | "payoutMode"
    | "binanceUserId"
    | "telegramUserId"
    | "telegramUsername"
    | "status"
    | "isDisabled"
    | "autoAcceptEnabled"
    | "autoAcceptNotifyEnabled"
    | "newOrderSoundEnabled"
    | "lastSeenAt"
    | "createdAt"
  >
) {
  return {
    id: worker.id,
    username: worker.username,
    displayName: worker.displayName,
    unitPrice: decimalToNumber(worker.unitPrice),
    payoutMode: worker.payoutMode,
    binanceUserId: worker.binanceUserId,
    telegramUserId: worker.telegramUserId,
    telegramUsername: worker.telegramUsername,
    status: worker.status,
    isDisabled: worker.isDisabled,
    autoAcceptEnabled: worker.autoAcceptEnabled,
    autoAcceptNotifyEnabled: worker.autoAcceptNotifyEnabled,
    newOrderSoundEnabled: worker.newOrderSoundEnabled,
    lastSeenAt: worker.lastSeenAt,
    createdAt: worker.createdAt,
  };
}

export function serializeWorkerWithdrawalRequest(
  request: WorkerWithdrawalRequest & {
    worker?: Pick<Worker, "id" | "username" | "displayName" | "binanceUserId"> | null;
  }
) {
  return {
    id: request.id,
    workerId: request.workerId,
    worker: request.worker || null,
    amount: decimalToNumber(request.amount),
    status: request.status,
    binanceUserIdSnapshot: request.binanceUserIdSnapshot,
    note: request.note,
    adminNote: request.adminNote,
    requestedAt: request.requestedAt,
    processedAt: request.processedAt,
    processedBy: request.processedBy,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };
}

export function serializeOrder(order: OrderWithRelations) {
  const lastWorker = order.records?.[0]?.worker ?? null;

  return {
    id: order.id,
    orderNo: order.orderNo,
    source: order.source,
    publicUserTelegramId: order.publicUserTelegramId,
    publicUserTelegramName: order.publicUserTelegramName,
    scanPrice: decimalToNumber(order.scanPrice),
    qrImageUrl: order.qrImageUrl,
    qrVersion: order.qrVersion,
    qrDecodedText: order.qrDecodedText,
    qrIsUpi: order.qrIsUpi,
    paymentUrl: order.paymentUrl,
    upiExtractionStatus: order.upiExtractionStatus,
    upiExtractError: order.upiExtractError,
    upiExtractedAt: order.upiExtractedAt,
    upiExpiresAt: order.upiExpiresAt,
    subscriptionCheckStatus: order.subscriptionCheckStatus,
    subscriptionCheckRounds: order.subscriptionCheckRounds,
    subscriptionCheckAttemptCount: order.subscriptionCheckAttemptCount,
    subscriptionCheckLastPlan: order.subscriptionCheckLastPlan,
    subscriptionCheckLastError: order.subscriptionCheckLastError,
    subscriptionCheckedAt: order.subscriptionCheckedAt,
    hasSessionCredential: Boolean(order.sessionCredentialEncrypted),
    holdsFrozenCount: order.holdsFrozenCount,
    status: order.status,
    customerNote: order.customerNote,
    problemReason: order.problemReason,
    completedBy: order.completedBy,
    assignedAt: order.assignedAt,
    completedAt: order.completedAt,
    failedAt: order.failedAt,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    cdk: order.cdk ? serializeCdk(order.cdk) : null,
    assignedWorker: order.assignedWorker,
    lastWorker,
  };
}

export function serializeWorkerOrder(order: OrderWithRelations) {
  const serialized = serializeOrder(order);
  return {
    ...serialized,
    cdk: undefined,
  };
}

export function makeOrderNo() {
  const now = new Date();
  const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `UPI-${date}-${suffix}`;
}

export function getShanghaiDayRange(now = new Date()) {
  const offsetMs = 8 * 60 * 60 * 1000;
  const shifted = new Date(now.getTime() + offsetMs);
  const startUtcMs = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
    0,
    0,
    0,
    0
  ) - offsetMs;
  return {
    start: new Date(startUtcMs),
    end: new Date(startUtcMs + 24 * 60 * 60 * 1000),
  };
}
