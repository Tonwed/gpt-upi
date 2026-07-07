import { assertCustomerOrderAccess } from "@/lib/server/customer-order-access";
import { cancelOrder, getCustomerOrder } from "@/lib/server/orders";
import { fail, handleRouteError, ok } from "@/lib/server/responses";
import { serializeOrder } from "@/lib/server/serializers";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ orderId: string }> }) {
  try {
    const { orderId } = await context.params;
    const existing = await getCustomerOrder(orderId);
    if (!existing) return fail("Order not found", 404);
    assertCustomerOrderAccess(request, existing);

    const result = await cancelOrder(orderId);
    return ok({ order: serializeOrder(result.order), changed: result.changed });
  } catch (error) {
    if (error instanceof Response && error.status === 403) return fail("You do not have access to this order", 403);
    const message = error instanceof Error ? error.message : "Cancel order failed";
    if (message.includes("订单") || message.toLowerCase().includes("order")) return fail(message);
    return handleRouteError(error);
  }
}