import { requireWorkerSession } from "@/lib/server/auth";
import { autoPickOrder, expireStaleOrders } from "@/lib/server/orders";
import { fail, handleRouteError, ok } from "@/lib/server/responses";
import { serializeWorkerOrder } from "@/lib/server/serializers";
import { notifyWorkerAutoAccepted } from "@/lib/server/telegram-notifications";

export const runtime = "nodejs";

export async function POST() {
  try {
    const worker = await requireWorkerSession();
    await expireStaleOrders();
    const result = await autoPickOrder(worker.id);

    if (result?.order && result.worker.autoAcceptNotifyEnabled && result.worker.telegramUserId) {
      try {
        await notifyWorkerAutoAccepted({ chatId: result.worker.telegramUserId, order: result.order });
      } catch (notifyError) {
        console.error("Telegram auto-accept notification failed", notifyError);
      }
    }

    return ok(result?.assignedToRequester ? serializeWorkerOrder(result.order) : null);
  } catch (error) {
    if (error instanceof Response) return fail("Unauthorized", 401);
    const message = error instanceof Error ? error.message : "Auto-accept failed";
    if (message.includes("上线") || message.includes("接单")) return fail(message);
    return handleRouteError(error);
  }
}