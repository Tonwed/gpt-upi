import { createHash, randomBytes } from "crypto";
import {
  CompletedBy,
  OrderResult,
  OrderStatus,
  Prisma,
  WorkerStatus,
  type Cdk,
  type Worker,
} from "@prisma/client";
import { normalizeCdkCode } from "@/lib/cdk-code";
import { prisma } from "@/lib/server/prisma";
import { refundPublicScanOrderFunds, spendPublicScanOrderFunds } from "@/lib/server/public-user-wallet";
import { makeOrderNo, type OrderWithRelations } from "@/lib/server/serializers";
import { getWorkerWalletSummary } from "@/lib/server/wallet";

export const orderInclude = {
  cdk: true,
  assignedWorker: {
    select: {
      id: true,
      username: true,
      displayName: true,
    },
  },
  records: {
    orderBy: { completedAt: "desc" },
    take: 1,
    include: {
      worker: {
        select: {
          id: true,
          username: true,
          displayName: true,
        },
      },
    },
  },
} satisfies Prisma.OrderInclude;

const activeStatuses: OrderStatus[] = ["PENDING", "ASSIGNED"];
export const ORDER_TTL_MS = 5 * 60 * 1000;
export const PUBLIC_SCAN_ASSIGNED_CHECK_GRACE_MS = 5 * 60 * 1000;
export const PUBLIC_SCAN_PENDING_AUTO_RETURN_BEFORE_MS = 60 * 1000;
export const PUBLIC_SCAN_PENDING_AUTO_RETURN_REASON =
  "扫码订单未被接取，二维码剩余有效期不足 1 分钟，系统已自动退回并退款。";
export const MAX_ACTIVE_ORDERS_PER_WORKER = 3;

export function generateCustomerOrderToken() {
  return randomBytes(32).toString("base64url");
}

export function hashCustomerOrderToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function verifyCustomerOrderToken(order: Pick<OrderWithRelations, "customerTokenHash">, token?: string | null) {
  if (!order.customerTokenHash || !token) return false;
  return hashCustomerOrderToken(token) === order.customerTokenHash;
}

function assertAvailableCdk(cdk: Cdk) {
  if (cdk.status !== "ACTIVE") {
    throw new Error("CDK 不可用或已停用");
  }
  if (cdk.expiresAt && cdk.expiresAt.getTime() <= Date.now()) {
    throw new Error("CDK 已过期");
  }
  const available = cdk.totalCount - cdk.usedCount - cdk.frozenCount;
  if (available <= 0) {
    throw new Error("CDK 可用次数不足");
  }
}

async function lockCdk(tx: Prisma.TransactionClient, code: string) {
  const rows = await tx.$queryRaw<Cdk[]>`
    SELECT * FROM "cdks"
    WHERE "code" = ${code}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

async function lockCdkById(tx: Prisma.TransactionClient, cdkId: string) {
  const rows = await tx.$queryRaw<Cdk[]>`
    SELECT * FROM "cdks"
    WHERE "id" = ${cdkId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

type LockedOrder = {
  id: string;
  source: "CDK" | "PUBLIC_SCAN";
  status: OrderStatus;
  cdkId: string | null;
  publicUserTelegramId: string | null;
  scanPrice: Prisma.Decimal;
  assignedWorkerId: string | null;
  createdAt: Date;
  holdsFrozenCount: boolean;
  sessionCredentialEncrypted: string | null;
  upiExtractionStatus: "PENDING" | "GENERATING" | "READY" | "FAILED";
  upiExpiresAt: Date | null;
  subscriptionCheckRounds: number;
  qrImageUrl: string;
};

async function lockOrder(tx: Prisma.TransactionClient, orderId: string) {
  const rows = await tx.$queryRaw<LockedOrder[]>`
    SELECT
      "id",
      "source",
      "status",
      "cdkId",
      "publicUserTelegramId",
      "scanPrice",
      "assignedWorkerId",
      "createdAt",
      "holdsFrozenCount",
      "sessionCredentialEncrypted",
      "upiExtractionStatus",
      "upiExpiresAt",
      "subscriptionCheckRounds",
      "qrImageUrl"
    FROM "orders"
    WHERE "id" = ${orderId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

function getPublicScanAutoExpireAtMs(locked: Pick<LockedOrder, "source" | "status" | "upiExpiresAt">) {
  if (!locked.upiExpiresAt) return 0;
  const qrExpiresAtMs = locked.upiExpiresAt.getTime();
  if (locked.source === "PUBLIC_SCAN" && (locked.status === "ASSIGNED" || locked.status === "CHECKING")) {
    return qrExpiresAtMs + PUBLIC_SCAN_ASSIGNED_CHECK_GRACE_MS;
  }
  return qrExpiresAtMs;
}

function isWithinPublicScanAssignedCheckGrace(locked: Pick<LockedOrder, "source" | "status" | "upiExpiresAt">) {
  if (locked.source !== "PUBLIC_SCAN" || locked.status !== "ASSIGNED" || !locked.upiExpiresAt) return false;
  const nowMs = Date.now();
  const qrExpiresAtMs = locked.upiExpiresAt.getTime();
  return qrExpiresAtMs <= nowMs && nowMs < qrExpiresAtMs + PUBLIC_SCAN_ASSIGNED_CHECK_GRACE_MS;
}

async function finalizeCompletedOrder(
  tx: Prisma.TransactionClient,
  locked: LockedOrder,
  input: {
    orderId: string;
    completedBy: CompletedBy;
    note: string;
    planType?: string;
  }
) {
  await consumeFrozenUseIfHeld(tx, locked);

  if (locked.assignedWorkerId) {
    const assignedWorker = await tx.worker.findUnique({
      where: { id: locked.assignedWorkerId },
      select: { unitPrice: true, payoutMode: true },
    });

    await tx.workerOrderRecord.create({
      data: {
        workerId: locked.assignedWorkerId,
        orderId: input.orderId,
        result: OrderResult.COMPLETED,
        note: input.note,
        unitPriceSnapshot: assignedWorker?.unitPrice ?? 0,
      },
    });

    if (assignedWorker?.payoutMode === "PREPAID") {
      const wallet = await getWorkerWalletSummary(locked.assignedWorkerId, tx);
      if (wallet.balance >= 0) {
        await tx.worker.update({
          where: { id: locked.assignedWorkerId },
          data: { payoutMode: "POSTPAID" },
        });
      }
    }

    await tx.workerActiveOrder.deleteMany({ where: { orderId: input.orderId } });
  }

  await tx.order.update({
    where: { id: input.orderId },
    data: {
      status: "COMPLETED",
      holdsFrozenCount: false,
      completedBy: input.completedBy,
      completedAt: new Date(),
      subscriptionCheckStatus: locked.sessionCredentialEncrypted ? "VERIFIED" : undefined,
      subscriptionCheckLastPlan: input.planType || undefined,
      subscriptionCheckLastError: null,
      subscriptionCheckedAt: locked.sessionCredentialEncrypted ? new Date() : undefined,
    },
  });

  return getOrderOrThrow(tx, input.orderId);
}

async function lockWorker(tx: Prisma.TransactionClient, workerId: string) {
  const rows = await tx.$queryRaw<Worker[]>`
    SELECT * FROM "workers"
    WHERE "id" = ${workerId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

async function getOrderOrThrow(tx: Prisma.TransactionClient, orderId: string) {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    include: orderInclude,
  });
  if (!order) throw new Error("订单不存在");
  return order as OrderWithRelations;
}

async function releaseFrozenUseIfHeld(tx: Prisma.TransactionClient, locked: LockedOrder) {
  if (!locked.holdsFrozenCount) return false;
  if (locked.source === "PUBLIC_SCAN") {
    if (locked.publicUserTelegramId) {
      await refundPublicScanOrderFunds(tx, {
        telegramUserId: locked.publicUserTelegramId,
        orderId: locked.id,
        amount: locked.scanPrice,
      });
    }
    locked.holdsFrozenCount = false;
    return true;
  }
  if (!locked.cdkId) return false;
  await tx.cdk.updateMany({
    where: { id: locked.cdkId, frozenCount: { gt: 0 } },
    data: { frozenCount: { decrement: 1 } },
  });
  locked.holdsFrozenCount = false;
  return true;
}

async function consumeFrozenUseIfHeld(tx: Prisma.TransactionClient, locked: LockedOrder) {
  if (!locked.holdsFrozenCount) return false;
  if (locked.source === "PUBLIC_SCAN") {
    if (locked.publicUserTelegramId) {
      await spendPublicScanOrderFunds(tx, {
        telegramUserId: locked.publicUserTelegramId,
        orderId: locked.id,
        amount: locked.scanPrice,
      });
    }
    locked.holdsFrozenCount = false;
    return true;
  }

  await releaseFrozenUseIfHeld(tx, locked);
  if (locked.cdkId) {
    await tx.cdk.update({
      where: { id: locked.cdkId },
      data: { usedCount: { increment: 1 } },
    });
  }
  return true;
}

async function expireLockedOrderIfNeeded(tx: Prisma.TransactionClient, locked: LockedOrder) {
  // New token-based UPI orders do not expire automatically. Customers may cancel
  // while the order is still waiting, but assigned orders remain worker-controlled.
  void tx;
  void locked;
  return false;
}

export async function expireStaleOrders() {
  const now = new Date();
  const pendingCutoff = new Date(now.getTime() + PUBLIC_SCAN_PENDING_AUTO_RETURN_BEFORE_MS);
  const assignedCheckCutoff = new Date(now.getTime() - PUBLIC_SCAN_ASSIGNED_CHECK_GRACE_MS);
  const candidates = await prisma.order.findMany({
    where: {
      source: "PUBLIC_SCAN",
      OR: [
        { status: "PENDING", upiExpiresAt: { lte: pendingCutoff } },
        { status: "ASSIGNED", upiExpiresAt: { lte: assignedCheckCutoff } },
        { status: "CHECKING", upiExpiresAt: { lte: assignedCheckCutoff } },
      ],
    },
    select: { id: true },
    take: 100,
  });
  let changed = 0;
  for (const candidate of candidates) {
    const didExpire = await prisma.$transaction(async (tx) => {
      const locked = await lockOrder(tx, candidate.id);
      if (!locked || locked.source !== "PUBLIC_SCAN") return false;
      if (!["PENDING", "ASSIGNED", "CHECKING"].includes(locked.status)) return false;
      if (!locked.upiExpiresAt) return false;

      const nowMs = Date.now();
      const isPendingAutoReturn =
        locked.status === "PENDING" &&
        locked.upiExpiresAt.getTime() - nowMs <= PUBLIC_SCAN_PENDING_AUTO_RETURN_BEFORE_MS;
      const isWorkerHeldExpired =
        (locked.status === "ASSIGNED" || locked.status === "CHECKING") &&
        getPublicScanAutoExpireAtMs(locked) <= nowMs;
      if (!isPendingAutoReturn && !isWorkerHeldExpired) return false;

      await releaseFrozenUseIfHeld(tx, locked);
      if (locked.assignedWorkerId) {
        await tx.workerOrderRecord.create({
          data: {
            workerId: locked.assignedWorkerId,
            orderId: locked.id,
            result: OrderResult.EXPIRED,
            note: "UPI 二维码过期，扫码订单已自动关闭并退回用户冻结余额。",
          },
        });
      }
      const updateData: Prisma.OrderUpdateInput = {
        status: "EXPIRED",
        holdsFrozenCount: false,
        completedBy: "SYSTEM",
        failedAt: new Date(),
        problemReason: isPendingAutoReturn ? PUBLIC_SCAN_PENDING_AUTO_RETURN_REASON : undefined,
      };
      if (locked.status === "CHECKING") {
        updateData.subscriptionCheckStatus = "FAILED";
        updateData.subscriptionCheckLastError = "Scan order subscription check timed out; system closed it automatically.";
        updateData.subscriptionCheckedAt = new Date();
      }
      await tx.workerActiveOrder.deleteMany({ where: { orderId: locked.id } });
      await tx.order.update({
        where: { id: locked.id },
        data: updateData,
      });
      return true;
    });
    if (didExpire) changed += 1;
  }
  return changed;
}

export async function createCustomerOrder(input: {
  code: string;
  qrImageUrl?: string;
  qrDecodedText?: string | null;
  qrIsUpi?: boolean | null;
  sessionCredentialEncrypted?: string | null;
  sessionCredentialHash?: string | null;
  customerTokenHash?: string | null;
  customerNote?: string | null;
}) {
  const code = normalizeCdkCode(input.code);
  return prisma.$transaction(
    async (tx) => {
      const cdk = await lockCdk(tx, code);
      if (!cdk) throw new Error("CDK 不存在");
      assertAvailableCdk(cdk);

      await tx.cdk.update({
        where: { id: cdk.id },
        data: { frozenCount: { increment: 1 } },
      });

      return (await tx.order.create({
        data: {
          orderNo: makeOrderNo(),
          cdkId: cdk.id,
          qrImageUrl: input.qrImageUrl || "",
          qrDecodedText: input.qrDecodedText || null,
          qrIsUpi: input.qrIsUpi,
          sessionCredentialEncrypted: input.sessionCredentialEncrypted || null,
          sessionCredentialHash: input.sessionCredentialHash || null,
          customerTokenHash: input.customerTokenHash || null,
          customerNote: input.customerNote || null,
        },
        include: orderInclude,
      })) as OrderWithRelations;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

export async function getCustomerOrder(orderId: string) {
  await prisma.$transaction(async (tx) => {
    const locked = await lockOrder(tx, orderId);
    if (!locked) return;
    if (locked.status === "NEED_REUPLOAD" && locked.holdsFrozenCount) {
      await releaseFrozenUseIfHeld(tx, locked);
      await tx.order.update({
        where: { id: locked.id },
        data: { holdsFrozenCount: false },
      });
      return;
    }
    await expireLockedOrderIfNeeded(tx, locked);
  });
  return prisma.order.findUnique({ where: { id: orderId }, include: orderInclude }) as Promise<OrderWithRelations | null>;
}

export async function reuploadOrder(input: {
  orderId: string;
  qrImageUrl: string;
  qrDecodedText?: string | null;
  qrIsUpi?: boolean | null;
}) {
  return prisma.$transaction(async (tx) => {
    const locked = await lockOrder(tx, input.orderId);
    if (!locked) throw new Error("订单不存在");
    if (await expireLockedOrderIfNeeded(tx, locked)) {
      throw new Error("订单已超过 5 分钟有效期，请重新提交");
    }
    if (locked.status !== "NEED_REUPLOAD") {
      throw new Error("当前订单不需要重新上传二维码");
    }

    if (locked.holdsFrozenCount) {
      await releaseFrozenUseIfHeld(tx, locked);
    }

    if (!locked.cdkId) throw new Error("该订单不是 CDK 订单，不能重新上传。");
    const cdk = await lockCdkById(tx, locked.cdkId);
    if (!cdk) throw new Error("CDK 不存在");
    assertAvailableCdk(cdk);

    await tx.cdk.update({
      where: { id: locked.cdkId },
      data: { frozenCount: { increment: 1 } },
    });

    await tx.order.update({
      where: { id: input.orderId },
      data: {
        qrImageUrl: input.qrImageUrl,
        qrVersion: { increment: 1 },
        qrDecodedText: input.qrDecodedText || null,
        qrIsUpi: input.qrIsUpi,
        status: "PENDING",
        holdsFrozenCount: true,
        problemReason: null,
        assignedWorkerId: null,
        assignedAt: null,
        createdAt: new Date(),
        failedAt: null,
      },
    });

    return getOrderOrThrow(tx, input.orderId);
  });
}

export async function completeOrder(input: {
  orderId: string;
  completedBy: CompletedBy;
  workerId?: string;
}) {
  return prisma.$transaction(async (tx) => {
    const locked = await lockOrder(tx, input.orderId);
    if (!locked) throw new Error("订单不存在");

    if (await expireLockedOrderIfNeeded(tx, locked)) {
      throw new Error("订单已超过 5 分钟有效期，冻结次数已退回");
    }
    if (locked.status === "COMPLETED") {
      return { order: await getOrderOrThrow(tx, input.orderId), changed: false };
    }
    if (!activeStatuses.includes(locked.status)) {
      throw new Error("当前订单状态不能完成");
    }
    if (input.workerId && locked.assignedWorkerId !== input.workerId) {
      throw new Error("只能完成自己正在处理的订单");
    }
    if (input.workerId && locked.status !== "ASSIGNED") {
      throw new Error("只能完成自己已接取的订单");
    }
    if (locked.sessionCredentialEncrypted && locked.upiExtractionStatus !== "READY") {
      throw new Error("请先生成 UPI 二维码，生成成功后才能完成订单");
    }
    if (locked.sessionCredentialEncrypted && !locked.qrImageUrl) {
      throw new Error("UPI 二维码尚未生成，不能完成订单");
    }
    if (
      locked.sessionCredentialEncrypted &&
      (!locked.upiExpiresAt || (locked.upiExpiresAt.getTime() <= Date.now() && !isWithinPublicScanAssignedCheckGrace(locked)))
    ) {
      throw new Error("UPI 二维码已过期，请重新生成后再完成订单");
    }

    const order = await finalizeCompletedOrder(tx, locked, {
      orderId: input.orderId,
      completedBy: input.completedBy,
      note: input.completedBy === "CUSTOMER" ? "客户确认完成" : "接单方确认完成",
    });

    return { order, changed: true };
  });
}

export async function prepareSubscriptionCheck(input: {
  orderId: string;
  workerId: string;
}) {
  return prisma.$transaction(
    async (tx) => {
      const locked = await lockOrder(tx, input.orderId);
      if (!locked) throw new Error("订单不存在");
      if (locked.status === "COMPLETED") {
        return {
          type: "completed" as const,
          order: await getOrderOrThrow(tx, input.orderId),
        };
      }
      if (locked.status === "CHECKING") {
        throw new Error("订单正在检测订阅状态，请稍后刷新");
      }
      if (locked.status !== "ASSIGNED" || locked.assignedWorkerId !== input.workerId) {
        throw new Error("只能检测自己已接取的订单");
      }
      if (!locked.sessionCredentialEncrypted) {
        throw new Error("该订单没有可用于检测的 session token");
      }
      if (locked.upiExtractionStatus !== "READY" || !locked.qrImageUrl) {
        throw new Error("请先生成 UPI 二维码，生成成功后再检测订阅");
      }
      if (!locked.upiExpiresAt) {
        throw new Error("UPI 二维码已过期，请重新生成后再检测");
      }
      if (locked.upiExpiresAt.getTime() <= Date.now() && !isWithinPublicScanAssignedCheckGrace(locked)) {
        throw new Error("二维码检查等待期已结束，请重新生成或报告问题 / QR check grace period has ended. Please regenerate or report the order issue.");
      }
      await tx.order.update({
        where: { id: input.orderId },
        data: {
          status: "CHECKING",
          subscriptionCheckStatus: "CHECKING",
          subscriptionCheckRounds: { increment: 1 },
          subscriptionCheckAttemptCount: 0,
          subscriptionCheckLastError: null,
          subscriptionCheckedAt: new Date(),
        },
      });

      return {
        type: "checking" as const,
        encryptedCredential: locked.sessionCredentialEncrypted,
        round: locked.subscriptionCheckRounds + 1,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

export async function completeSubscriptionCheckedOrder(input: {
  orderId: string;
  workerId: string;
  planType: string;
  attempts: number;
}) {
  return prisma.$transaction(async (tx) => {
    const locked = await lockOrder(tx, input.orderId);
    if (!locked) throw new Error("订单不存在");
    if (locked.status === "COMPLETED") {
      return { order: await getOrderOrThrow(tx, input.orderId), changed: false };
    }
    if (locked.status !== "CHECKING" || locked.assignedWorkerId !== input.workerId) {
      throw new Error("订单检测状态已变化，请刷新后重试");
    }

    await tx.order.update({
      where: { id: input.orderId },
      data: {
        subscriptionCheckAttemptCount: input.attempts,
        subscriptionCheckLastPlan: input.planType,
        subscriptionCheckLastError: null,
        subscriptionCheckedAt: new Date(),
      },
    });

    const order = await finalizeCompletedOrder(tx, locked, {
      orderId: input.orderId,
      completedBy: "WORKER",
      note: `订阅状态已更新为 ${input.planType || "plus"}，系统检测完成`,
      planType: input.planType,
    });
    return { order, changed: true };
  });
}

export async function failSubscriptionCheck(input: {
  orderId: string;
  workerId: string;
  planType: string;
  attempts: number;
  message: string;
}) {
  return prisma.$transaction(async (tx) => {
    const locked = await lockOrder(tx, input.orderId);
    if (!locked) throw new Error("订单不存在");
    if (locked.status === "COMPLETED") {
      return { order: await getOrderOrThrow(tx, input.orderId), canRetry: false };
    }
    if (locked.status !== "CHECKING" || locked.assignedWorkerId !== input.workerId) {
      throw new Error("订单检测状态已变化，请刷新后重试");
    }

    await tx.order.update({
      where: { id: input.orderId },
      data: {
        status: "ASSIGNED",
        subscriptionCheckStatus: "FAILED",
        subscriptionCheckAttemptCount: input.attempts,
        subscriptionCheckLastPlan: input.planType || null,
        subscriptionCheckLastError: input.message,
        subscriptionCheckedAt: new Date(),
      },
    });

    const order = await getOrderOrThrow(tx, input.orderId);
    return {
      order,
      canRetry: true,
    };
  });
}

export async function cancelOrder(orderId: string) {
  return prisma.$transaction(async (tx) => {
    const locked = await lockOrder(tx, orderId);
    if (!locked) throw new Error("订单不存在");
    if (await expireLockedOrderIfNeeded(tx, locked)) {
      return { order: await getOrderOrThrow(tx, orderId), changed: false };
    }
    if (locked.status === "COMPLETED") throw new Error("已完成订单不能取消");
    if (["CANCELLED", "FAILED", "EXPIRED"].includes(locked.status)) {
      return { order: await getOrderOrThrow(tx, orderId), changed: false };
    }
    if (locked.status !== "PENDING") {
      throw new Error("只能取消尚未被接取的订单");
    }

    await releaseFrozenUseIfHeld(tx, locked);

    if (locked.assignedWorkerId) {
      await tx.workerOrderRecord.create({
        data: {
          workerId: locked.assignedWorkerId,
          orderId,
          result: OrderResult.CANCELLED,
          note: "客户取消，冻结次数已退回",
        },
      });
    }

    await tx.workerActiveOrder.deleteMany({ where: { orderId } });
    await tx.order.update({
      where: { id: orderId },
      data: { status: "CANCELLED", holdsFrozenCount: false, completedBy: "CUSTOMER", failedAt: new Date() },
    });

    return { order: await getOrderOrThrow(tx, orderId), changed: true };
  });
}

export async function releaseAssignedOrder(input: { orderId: string; workerId: string }) {
  return prisma.$transaction(
    async (tx) => {
      const locked = await lockOrder(tx, input.orderId);
      if (!locked) throw new Error("订单不存在");
      if (locked.status !== "ASSIGNED" || locked.assignedWorkerId !== input.workerId) {
        throw new Error("只能释放自己已接取且未进入检测的订单");
      }

      await tx.workerActiveOrder.deleteMany({ where: { orderId: input.orderId, workerId: input.workerId } });
      const resetData: Prisma.OrderUpdateInput = locked.source === "PUBLIC_SCAN"
        ? {
          status: "PENDING",
          assignedWorker: { disconnect: true },
          assignedAt: null,
          subscriptionCheckStatus: "IDLE",
          subscriptionCheckRounds: 0,
          subscriptionCheckAttemptCount: 0,
          subscriptionCheckLastPlan: null,
          subscriptionCheckLastError: null,
          subscriptionCheckedAt: null,
        }
        : {
          status: "PENDING",
          assignedWorker: { disconnect: true },
          assignedAt: null,
          qrImageUrl: "",
          qrVersion: { increment: 1 },
          qrDecodedText: null,
          qrIsUpi: null,
          upiExtractionStatus: "PENDING",
          upiExtractError: null,
          upiExtractedAt: null,
          upiExpiresAt: null,
          subscriptionCheckStatus: "IDLE",
          subscriptionCheckRounds: 0,
          subscriptionCheckAttemptCount: 0,
          subscriptionCheckLastPlan: null,
          subscriptionCheckLastError: null,
          subscriptionCheckedAt: null,
        };
      await tx.order.update({
        where: { id: input.orderId },
        data: resetData,
      });
      await tx.worker.update({
        where: { id: input.workerId },
        data: {
          autoAcceptEnabled: false,
          lastSeenAt: new Date(),
        },
      });

      return getOrderOrThrow(tx, input.orderId);
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

export async function acceptOrder(orderId: string, workerId: string) {
  const result = await prisma.$transaction(
    async (tx) => {
      const worker = await lockWorker(tx, workerId);
      if (!worker) throw new Error("Worker does not exist");
      if (worker.status !== WorkerStatus.ONLINE) throw new Error("Please go online before accepting orders");

      const activeCount = await tx.workerActiveOrder.count({ where: { workerId } });
      if (activeCount >= MAX_ACTIVE_ORDERS_PER_WORKER) {
        throw new Error(`Active order limit reached (${MAX_ACTIVE_ORDERS_PER_WORKER}).`);
      }

      const lockedCandidate = await lockOrder(tx, orderId);
      if (!lockedCandidate || lockedCandidate.status !== "PENDING") {
        throw new Error("Order has already been accepted or its status changed");
      }
      if (
        lockedCandidate.source === "PUBLIC_SCAN" &&
        lockedCandidate.upiExpiresAt &&
        lockedCandidate.upiExpiresAt.getTime() - Date.now() <= PUBLIC_SCAN_PENDING_AUTO_RETURN_BEFORE_MS
      ) {
        await releaseFrozenUseIfHeld(tx, lockedCandidate);
        await tx.order.update({
          where: { id: lockedCandidate.id },
          data: {
            status: "EXPIRED",
            holdsFrozenCount: false,
            completedBy: "SYSTEM",
            failedAt: new Date(),
            assignedWorkerId: null,
            assignedAt: null,
            problemReason: PUBLIC_SCAN_PENDING_AUTO_RETURN_REASON,
          },
        });
        return { type: "autoReturned" as const };
      }

      const updated = await tx.order.updateMany({
        where: { id: orderId, status: "PENDING" },
        data: {
          status: "ASSIGNED",
          assignedWorkerId: workerId,
          assignedAt: new Date(),
        },
      });
      if (updated.count !== 1) {
        const locked = await lockOrder(tx, orderId);
        if (locked && await expireLockedOrderIfNeeded(tx, locked)) {
          throw new Error("Order has exceeded the valid window");
        }
        throw new Error("Order has already been accepted or its status changed");
      }

      await tx.workerActiveOrder.create({ data: { workerId, orderId } });
      await tx.worker.update({ where: { id: workerId }, data: { lastSeenAt: new Date() } });

      return { type: "accepted" as const, order: await getOrderOrThrow(tx, orderId) };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );

  if (result.type === "autoReturned") {
    throw new Error("Scan order QR has less than 1 minute remaining. It has been returned automatically; please accept another order.");
  }
  return result.order;
}

type AutoPickTargetWorker = Pick<Worker, "id" | "telegramUserId" | "autoAcceptNotifyEnabled">;

export type AutoAssignResult = {
  order: OrderWithRelations;
  worker: AutoPickTargetWorker;
};

export async function autoAssignPendingOrder(): Promise<AutoAssignResult | null> {
  return prisma.$transaction(
    async (tx) => {
      const pendingCutoff = new Date(Date.now() + PUBLIC_SCAN_PENDING_AUTO_RETURN_BEFORE_MS);
      const candidate = await tx.order.findFirst({
        where: {
          status: "PENDING",
          OR: [
            { source: { not: "PUBLIC_SCAN" } },
            { source: "PUBLIC_SCAN", upiExpiresAt: { gt: pendingCutoff } },
          ],
        },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });
      if (!candidate) return null;

      const targetRows = await tx.$queryRaw<AutoPickTargetWorker[]>`
        SELECT w."id", w."telegramUserId", w."autoAcceptNotifyEnabled"
        FROM "workers" w
        WHERE w."status" = ${WorkerStatus.ONLINE}::"WorkerStatus"
          AND w."autoAcceptEnabled" = true
          AND (
            SELECT COUNT(*)::int
            FROM "worker_active_orders" active
            WHERE active."workerId" = w."id"
          ) < ${MAX_ACTIVE_ORDERS_PER_WORKER}
        ORDER BY
          (
            SELECT COUNT(*)::int
            FROM "worker_active_orders" active
            WHERE active."workerId" = w."id"
          ) ASC,
          COALESCE(
            (
              SELECT MAX(o."assignedAt")
              FROM "orders" o
              WHERE o."assignedWorkerId" = w."id"
            ),
            '-infinity'::timestamp
          ) ASC,
          w."createdAt" ASC,
          w."id" ASC
        LIMIT 1
        FOR UPDATE OF w SKIP LOCKED
      `;

      const targetWorker = targetRows[0];
      if (!targetWorker) return null;

      const updated = await tx.order.updateMany({
        where: { id: candidate.id, status: "PENDING" },
        data: {
          status: "ASSIGNED",
          assignedWorkerId: targetWorker.id,
          assignedAt: new Date(),
        },
      });
      if (updated.count !== 1) return null;

      await tx.workerActiveOrder.create({ data: { workerId: targetWorker.id, orderId: candidate.id } });
      await tx.worker.update({ where: { id: targetWorker.id }, data: { lastSeenAt: new Date() } });

      return {
        order: await getOrderOrThrow(tx, candidate.id),
        worker: targetWorker,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

export async function autoPickOrder(workerId: string) {
  const requester = await prisma.$transaction(async (tx) => {
    const locked = await lockWorker(tx, workerId);
    if (!locked) throw new Error("接单方不存在");
    if (locked.status !== WorkerStatus.ONLINE) throw new Error("请先上线再开启自动接单");
    if (!locked.autoAcceptEnabled) return null;

    const activeCount = await tx.workerActiveOrder.count({ where: { workerId } });
    if (activeCount >= MAX_ACTIVE_ORDERS_PER_WORKER) return null;

    return { id: locked.id };
  });

  if (!requester) return null;

  const result = await autoAssignPendingOrder();
  if (!result) return null;

  return {
    ...result,
    assignedToRequester: result.worker.id === requester.id,
  };
}
export async function markOrderProblem(input: {
  orderId: string;
  workerId: string;
  reason: string;
}) {
  return prisma.$transaction(async (tx) => {
    const locked = await lockOrder(tx, input.orderId);
    if (!locked) throw new Error("订单不存在");
    if (await expireLockedOrderIfNeeded(tx, locked)) {
      throw new Error("订单已超过 5 分钟有效期");
    }
    if (locked.status !== "ASSIGNED" || locked.assignedWorkerId !== input.workerId) {
      throw new Error("只能处理自己已接取的订单");
    }

    await tx.workerOrderRecord.create({
      data: {
        workerId: input.workerId,
        orderId: input.orderId,
        result: OrderResult.PROBLEM,
        note: input.reason,
      },
    });
    await tx.workerActiveOrder.deleteMany({ where: { orderId: input.orderId } });
    await releaseFrozenUseIfHeld(tx, locked);
    await tx.order.update({
      where: { id: input.orderId },
      data: {
        status: "FAILED",
        holdsFrozenCount: false,
        problemReason: input.reason,
        upiExtractionStatus: "FAILED",
        upiExtractError: input.reason,
        failedAt: new Date(),
      },
    });

    return getOrderOrThrow(tx, input.orderId);
  });
}
