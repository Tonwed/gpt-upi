import type { OrderWithRelations } from "@/lib/server/serializers";
import { verifyCustomerOrderToken } from "@/lib/server/orders";
import { normalizeCdkCode } from "@/lib/cdk-code";

const CUSTOMER_ORDER_TOKEN_HEADER = "x-customer-order-token";
const CUSTOMER_CDK_CODE_HEADER = "x-customer-cdk-code";

export function getCustomerOrderToken(request: Request) {
  return request.headers.get(CUSTOMER_ORDER_TOKEN_HEADER);
}

export function assertCustomerOrderAccess(request: Request, order: OrderWithRelations) {
  if (verifyCustomerOrderToken(order, getCustomerOrderToken(request))) return;
  const cdkCode = normalizeCdkCode(request.headers.get(CUSTOMER_CDK_CODE_HEADER) || "");
  if (cdkCode && order.cdk?.code && normalizeCdkCode(order.cdk.code) === cdkCode) return;
  throw new Response("Forbidden", { status: 403 });
}
