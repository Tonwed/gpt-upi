import { getPublicUserSession } from "@/lib/server/auth";
import { cancelOrder } from "@/lib/server/orders";
import { prisma } from "@/lib/server/prisma";
import { createPublicScanOrderFromTicket } from "@/lib/server/public-scan-orders";
import { updatePublicUpiExtractJobScanOrder } from "@/lib/server/public-upi-extract-queue";
import { fail, handleRouteError, ok } from "@/lib/server/responses";
import { serializeWorkerOrder } from "@/lib/server/serializers";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const user = await getPublicUserSession();
    if (!user) return fail("请先登录 Telegram 账户，再发布扫码订单。", 401);

    const body = (await request.json().catch(() => ({}))) as { scanOrderCreateToken?: string };
    const token = String(body.scanOrderCreateToken || "").trim();
    if (!token) return fail("缺少二维码发布凭证，请重新提取。", 400);

    const { order, jobId } = await createPublicScanOrderFromTicket({
      token,
      telegramUserId: user.telegramUserId,
      telegramUsername: user.telegramUsername,
    });
    updatePublicUpiExtractJobScanOrder(jobId, order);

    return ok(serializeWorkerOrder(order), { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "发布扫码订单失败";
    if (
      message.includes("余额不足") ||
      message.includes("二维码") ||
      message.includes("发布") ||
      message.includes("凭证") ||
      message.includes("账号") ||
      message.includes("过期")
    ) {
      return fail(message);
    }
    return handleRouteError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const user = await getPublicUserSession();
    if (!user) return fail("Please login first.", 401);

    const url = new URL(request.url);
    const orderId = url.searchParams.get("orderId")?.trim() || "";
    const jobId = url.searchParams.get("jobId")?.trim() || "";
    if (!orderId) return fail("Missing orderId", 400);

    const existing = await prisma.order.findUnique({
      where: { id: orderId },
      select: { source: true, publicUserTelegramId: true, status: true },
    });
    if (!existing) return fail("Scan order not found.", 404);
    if (existing.source !== "PUBLIC_SCAN" || existing.publicUserTelegramId !== user.telegramUserId) {
      return fail("You can only cancel your own scan order.", 403);
    }
    if (existing.status === "ASSIGNED" || existing.status === "CHECKING") {
      return fail(
        "This scan order has already been accepted and cannot be cancelled now. It will be completed or refunded automatically after the check window.",
        409
      );
    }

    const result = await cancelOrder(orderId);
    if (jobId) updatePublicUpiExtractJobScanOrder(jobId, result.order);
    return ok(serializeWorkerOrder(result.order));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cancel scan order failed";
    if (message.includes("接取") || message.includes("取消") || message.toLowerCase().includes("cancel")) {
      return fail(message);
    }
    return handleRouteError(error);
  }
}
