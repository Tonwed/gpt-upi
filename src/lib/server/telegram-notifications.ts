import type { OrderWithRelations } from "@/lib/server/serializers";
import { sendTelegramMessage } from "@/lib/server/telegram-bot";

export async function notifyWorkerAutoAccepted({
  chatId,
  order,
}: {
  chatId: string;
  order: OrderWithRelations;
}) {
  const riskLine = order.qrIsUpi === false ? "\n⚠️ This QR code may not be a UPI QR code. Please verify it before processing." : "";
  await sendTelegramMessage(
    chatId,
    [
      "✅ Auto-accepted a new order",
      "",
      `Order No: ${order.orderNo}`,
      `QR version: v${order.qrVersion}`,
      `Accepted at: ${new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai", hour12: false })} (Asia/Shanghai)`,
      riskLine,
      "Please return to the Worker page to process the current order.",
    ].filter(Boolean).join("\n")
  );
}