import { requireWorkerSession } from "@/lib/server/auth";
import { fail, handleRouteError, ok } from "@/lib/server/responses";
import { serializeWorkerOrder } from "@/lib/server/serializers";
import { runWorkerSubscriptionCheck } from "@/lib/server/subscription-checks";

export const runtime = "nodejs";

export async function POST(_request: Request, context: { params: Promise<{ orderId: string }> }) {
  try {
    const worker = await requireWorkerSession();
    const { orderId } = await context.params;
    const result = await runWorkerSubscriptionCheck({ orderId, workerId: worker.id });

    return ok({
      ...result,
      order: serializeWorkerOrder(result.order),
    });
  } catch (error) {
    if (error instanceof Response) return fail("未登录 / Unauthorized", 401);
    const message = error instanceof Error ? error.message : "完成失败 / Complete failed";
    if (
      message.includes("订单") ||
      message.includes("自己") ||
      message.includes("状态") ||
      message.includes("UPI") ||
      message.includes("二维码") ||
      message.includes("过期") ||
      message.includes("生成") ||
      message.includes("订阅") ||
      message.includes("检测") ||
      message.includes("session") ||
      message.toLowerCase().includes("order") ||
      message.toLowerCase().includes("subscription") ||
      message.toLowerCase().includes("session")
    ) return fail(message);
    return handleRouteError(error);
  }
}
