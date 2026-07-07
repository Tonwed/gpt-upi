import { requireWorkerSession } from "@/lib/server/auth";
import { markOrderProblem } from "@/lib/server/orders";
import { fail, handleRouteError, ok } from "@/lib/server/responses";
import { serializeWorkerOrder } from "@/lib/server/serializers";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ orderId: string }> }) {
  try {
    const worker = await requireWorkerSession();
    const { orderId } = await context.params;
    const body = await request.json();
    const reason = String(body.reason || "").trim() || "UPI 二维码无法生成或无法处理，请更换 session token 后重新提交。";
    const order = await markOrderProblem({ orderId, workerId: worker.id, reason });
    return ok(serializeWorkerOrder(order));
  } catch (error) {
    if (error instanceof Response) return fail("未登录", 401);
    const message = error instanceof Error ? error.message : "标记异常失败";
    if (message.includes("订单") || message.includes("自己")) return fail(message);
    return handleRouteError(error);
  }
}
