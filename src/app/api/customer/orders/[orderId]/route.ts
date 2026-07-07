import { assertCustomerOrderAccess } from "@/lib/server/customer-order-access";
import { getCustomerOrder } from "@/lib/server/orders";
import { fail, handleRouteError, ok } from "@/lib/server/responses";
import { serializeOrder } from "@/lib/server/serializers";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ orderId: string }> }) {
  try {
    const { orderId } = await context.params;
    const order = await getCustomerOrder(orderId);
    if (!order) return fail("Order not found", 404);
    assertCustomerOrderAccess(request, order);
    return ok(serializeOrder(order));
  } catch (error) {
    if (error instanceof Response && error.status === 403) return fail("You do not have access to this order", 403);
    return handleRouteError(error);
  }
}