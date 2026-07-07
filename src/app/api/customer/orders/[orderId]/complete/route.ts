import { fail } from "@/lib/server/responses";

export const runtime = "nodejs";

export async function POST() {
  return fail("客户不能确认完成订单，请等待接单方处理", 403);
}

