import { checkChatGptSubscription } from "@/lib/server/chatgpt-upi";
import { decryptSessionCredential } from "@/lib/server/credential-vault";
import {
  completeSubscriptionCheckedOrder,
  prepareSubscriptionCheck,
  PUBLIC_SCAN_ASSIGNED_CHECK_GRACE_MS,
  failSubscriptionCheck,
} from "@/lib/server/orders";
import { prisma } from "@/lib/server/prisma";
import type { OrderWithRelations } from "@/lib/server/serializers";

export const SUBSCRIPTION_CHECK_ATTEMPTS = 5;
export const SUBSCRIPTION_CHECK_INTERVAL_MS = 5_000;
const AUTO_CHECK_THROTTLE_MS = 8_000;

export type WorkerSubscriptionCheckResult = {
  order: OrderWithRelations;
  changed: boolean;
  verified: boolean;
  canRetry: boolean;
  planType?: string;
  attempts: number;
  message: string;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compactThrownError(error: unknown) {
  const text = error instanceof Error ? error.message : String(error || "");
  return text
    .replace(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+/g, "<SESSION_TOKEN_REDACTED>")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "<JWT_REDACTED>")
    .replace(/(:\/\/[^:@/]+):([^@/]+)@/g, "$1:<PASSWORD_REDACTED>@")
    .slice(0, 700);
}

function isTransientSubscriptionCheckError(message: string) {
  const text = message.toLowerCase();
  return (
    text.includes("accounts/check subscription check failed") ||
    text.includes("cloudflare") ||
    text.includes("json") ||
    text.includes("non-json") ||
    text.includes("not json") ||
    text.includes("timeout") ||
    text.includes("timed out") ||
    text.includes("fetch failed") ||
    text.includes("socket") ||
    text.includes("econn") ||
    text.includes("http 502") ||
    text.includes("http 503") ||
    text.includes("http 504") ||
    text.includes("http 524")
  );
}

export function normalizeSubscriptionCheckError(error: unknown) {
  const raw = compactThrownError(error);
  if (isTransientSubscriptionCheckError(raw)) {
    return "订阅检测服务暂时异常，系统会在等待期内自动重试。 / Subscription check service returned a temporary error; retrying automatically during the check window.";
  }
  return raw || "订阅状态检测失败 / Subscription check failed";
}

export async function runWorkerSubscriptionCheck(input: {
  orderId: string;
  workerId: string;
  attempts?: number;
  intervalMs?: number;
}): Promise<WorkerSubscriptionCheckResult> {
  const attempts = Math.max(1, Math.floor(input.attempts ?? SUBSCRIPTION_CHECK_ATTEMPTS));
  const intervalMs = Math.max(0, Math.floor(input.intervalMs ?? SUBSCRIPTION_CHECK_INTERVAL_MS));
  const prepared = await prepareSubscriptionCheck({ orderId: input.orderId, workerId: input.workerId });

  if (prepared.type === "completed") {
    return {
      order: prepared.order,
      changed: false,
      verified: true,
      canRetry: false,
      attempts: 0,
      message: "订单此前已完成 / The order was already completed.",
    };
  }

  const credential = decryptSessionCredential(prepared.encryptedCredential);
  let lastPlan = "";
  let lastError = "";
  let performedAttempts = 0;

  try {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      performedAttempts = attempt;
      if (attempt > 1 && intervalMs > 0) await sleep(intervalMs);
      try {
        const result = await checkChatGptSubscription(credential);
        lastPlan = result.planType;
        if (result.isPlus) {
          const completed = await completeSubscriptionCheckedOrder({
            orderId: input.orderId,
            workerId: input.workerId,
            planType: result.planType,
            attempts: attempt,
          });
          return {
            order: completed.order,
            changed: completed.changed,
            verified: true,
            canRetry: false,
            planType: result.planType,
            attempts: attempt,
            message: "已检测到账号订阅更新为 Plus，订单已完成 / Plus detected. The order has been completed.",
          };
        }
      } catch (error) {
        lastError = normalizeSubscriptionCheckError(error);
      }
    }

    const message = lastError
      ? `订阅状态检测失败：${lastError}`
      : `暂未检测到 Plus，当前检测到的订阅等级为 ${lastPlan || "unknown"}。系统会在等待期内继续自动检测。`;
    const failed = await failSubscriptionCheck({
      orderId: input.orderId,
      workerId: input.workerId,
      planType: lastPlan,
      attempts,
      message,
    });

    return {
      order: failed.order,
      changed: false,
      verified: false,
      canRetry: failed.canRetry,
      planType: lastPlan || "unknown",
      attempts,
      message: failed.canRetry
        ? "暂未检测到 Plus；如果订单仍在检查窗口内，系统会继续自动检测。 / Plus not detected yet; auto-check will continue while the order is still in the check window."
        : "暂未检测到 Plus，请重新生成二维码或报告订单问题。 / Plus not detected. Please regenerate the QR code or report the order issue.",
    };
  } catch (error) {
    const message = `订阅状态检测失败：${normalizeSubscriptionCheckError(error)}`;
    try {
      const failed = await failSubscriptionCheck({
        orderId: input.orderId,
        workerId: input.workerId,
        planType: lastPlan,
        attempts: Math.max(1, performedAttempts),
        message,
      });
      return {
        order: failed.order,
        changed: false,
        verified: false,
        canRetry: failed.canRetry,
        planType: lastPlan || "unknown",
        attempts: Math.max(1, performedAttempts),
        message,
      };
    } catch {
      throw error;
    }
  }
}

async function listPublicScanOrdersInAutoCheckWindow(limit: number) {
  const now = new Date();
  const graceStartedAfter = new Date(now.getTime() - PUBLIC_SCAN_ASSIGNED_CHECK_GRACE_MS);
  const throttleBefore = new Date(now.getTime() - AUTO_CHECK_THROTTLE_MS);
  return prisma.order.findMany({
    where: {
      source: "PUBLIC_SCAN",
      status: "ASSIGNED",
      assignedWorkerId: { not: null },
      sessionCredentialEncrypted: { not: null },
      upiExtractionStatus: "READY",
      qrImageUrl: { not: "" },
      upiExpiresAt: {
        lte: now,
        gt: graceStartedAfter,
      },
      subscriptionCheckStatus: { not: "CHECKING" },
      OR: [
        { subscriptionCheckedAt: null },
        { subscriptionCheckedAt: { lt: throttleBefore } },
      ],
    },
    orderBy: [
      { upiExpiresAt: "asc" },
      { createdAt: "asc" },
    ],
    select: {
      id: true,
      orderNo: true,
      assignedWorkerId: true,
    },
    take: Math.max(1, Math.min(20, limit)),
  });
}

export async function autoCheckPublicScanGraceOrders(limit = 6) {
  const candidates = await listPublicScanOrdersInAutoCheckWindow(limit);
  const results = await Promise.allSettled(
    candidates
      .filter((candidate) => Boolean(candidate.assignedWorkerId))
      .map(async (candidate) => {
        const result = await runWorkerSubscriptionCheck({
          orderId: candidate.id,
          workerId: candidate.assignedWorkerId!,
          attempts: 1,
          intervalMs: 0,
        });
        return { candidate, result };
      })
  );

  let completed = 0;
  let failed = 0;
  for (const result of results) {
    if (result.status === "fulfilled") {
      if (result.value.result.verified) completed += 1;
      continue;
    }
    failed += 1;
    console.warn("Auto subscription check failed", {
      error: normalizeSubscriptionCheckError(result.reason),
    });
  }

  return { checked: results.length, completed, failed };
}
