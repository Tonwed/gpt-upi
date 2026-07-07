import { Prisma } from "@prisma/client";
import { requireWorkerSession } from "@/lib/server/auth";
import { EmailBoundError, extractUpiQrFromCredential } from "@/lib/server/chatgpt-upi";
import { decryptSessionCredential } from "@/lib/server/credential-vault";
import { orderInclude } from "@/lib/server/orders";
import { prisma } from "@/lib/server/prisma";
import { fail, handleRouteError, ok } from "@/lib/server/responses";
import { serializeWorkerOrder } from "@/lib/server/serializers";
import { saveGeneratedQrPng } from "@/lib/server/upload";

export const runtime = "nodejs";
const GENERATED_QR_TTL_MS = 5 * 60 * 1000;

export async function POST(_request: Request, context: { params: Promise<{ orderId: string }> }) {
  const worker = await requireWorkerSession().catch(() => null);
  if (!worker) return fail("Unauthorized", 401);

  const { orderId } = await context.params;
  let encryptedCredential = "";

  try {
    const prepared = await prisma.$transaction(
      async (tx) => {
        const order = await tx.order.findFirst({
          where: {
            id: orderId,
            status: "ASSIGNED",
            assignedWorkerId: worker.id,
          },
          select: {
            id: true,
            source: true,
            sessionCredentialEncrypted: true,
            upiExtractionStatus: true,
          },
        });

        if (!order) return { type: "notFound" as const };
        if (order.source === "PUBLIC_SCAN") return { type: "publicScan" as const };
        if (!order.sessionCredentialEncrypted) return { type: "missingCredential" as const };
        if (order.upiExtractionStatus === "GENERATING") return { type: "generating" as const };

        await tx.order.update({
          where: { id: order.id },
          data: {
            qrImageUrl: "",
            qrDecodedText: null,
            qrIsUpi: null,
            upiExtractionStatus: "GENERATING",
            upiExtractError: null,
            upiExtractedAt: null,
            upiExpiresAt: null,
            subscriptionCheckStatus: "IDLE",
            subscriptionCheckRounds: 0,
            subscriptionCheckAttemptCount: 0,
            subscriptionCheckLastPlan: null,
            subscriptionCheckLastError: null,
            subscriptionCheckedAt: null,
          },
        });

        return { type: "ok" as const, encryptedCredential: order.sessionCredentialEncrypted };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );

    if (prepared.type === "notFound") return fail("订单不存在，或不属于当前接单方", 404);
    if (prepared.type === "publicScan") return fail("该订单的二维码由用户发布，接单方无需重新生成。");
    if (prepared.type === "missingCredential") return fail("该订单没有可用于提取的 session token");
    if (prepared.type === "generating") return fail("UPI 二维码正在生成中，请稍后刷新");
    encryptedCredential = prepared.encryptedCredential;
  } catch (error) {
    return handleRouteError(error);
  }

  try {
    const credential = decryptSessionCredential(encryptedCredential);
    const extracted = await extractUpiQrFromCredential(credential, { maxProxyAttempts: 2 });
    const qrImageUrl = await saveGeneratedQrPng(extracted.qrPngBuffer);
    const upiExpiresAt = new Date(Date.now() + GENERATED_QR_TTL_MS);

    const updated = await prisma.order.updateMany({
      where: {
        id: orderId,
        status: "ASSIGNED",
        assignedWorkerId: worker.id,
        upiExtractionStatus: "GENERATING",
      },
      data: {
        qrImageUrl,
        qrVersion: { increment: 1 },
        qrDecodedText: extracted.upiUri,
        qrIsUpi: true,
        upiExtractionStatus: "READY",
        upiExtractError: null,
        upiExtractedAt: new Date(),
        upiExpiresAt,
      },
    });
    if (updated.count !== 1) {
      return fail("订单状态已变化，请刷新后重试", 409);
    }

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: orderInclude,
    });
    if (!order) return fail("订单不存在", 404);

    return ok(serializeWorkerOrder(order));
  } catch (error) {
    const message = error instanceof Error ? error.message : "UPI 二维码生成失败";
    await prisma.order.updateMany({
      where: {
        id: orderId,
        status: "ASSIGNED",
        assignedWorkerId: worker.id,
        upiExtractionStatus: "GENERATING",
      },
      data: {
        upiExtractionStatus: "FAILED",
        upiExtractError: message,
      },
    });

    if (error instanceof EmailBoundError) return fail(error.message, 403);
    if (
      message.includes("UPI") ||
      message.includes("upi://") ||
      message.includes("Stripe") ||
      message.includes("checkout") ||
      message.includes("session") ||
      message.includes("Cloudflare") ||
      message.includes("协议响应") ||
      message.includes("二维码")
    ) {
      return fail(message);
    }
    return handleRouteError(error);
  }
}
