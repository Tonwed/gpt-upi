import { requireWorkerSession } from "@/lib/server/auth";
import { releaseAssignedOrder } from "@/lib/server/orders";
import { fail, handleRouteError, ok } from "@/lib/server/responses";
import { serializeWorkerOrder } from "@/lib/server/serializers";

export const runtime = "nodejs";

export async function POST(_request: Request, context: { params: Promise<{ orderId: string }> }) {
  try {
    const worker = await requireWorkerSession();
    const { orderId } = await context.params;
    const order = await releaseAssignedOrder({ orderId, workerId: worker.id });
    return ok(serializeWorkerOrder(order));
  } catch (error) {
    if (error instanceof Response) return fail("未登录", 401);
    const message = error instanceof Error ? error.message : "释放订单失败";
    if (message.includes("订单") || message.includes("自己") || message.includes("释放") || message.includes("检测")) return fail(message);
    return handleRouteError(error);
  }
}
