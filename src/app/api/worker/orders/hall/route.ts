import { requireWorkerSession } from "@/lib/server/auth";
import { expireStaleOrders, orderInclude } from "@/lib/server/orders";
import { prisma } from "@/lib/server/prisma";
import { fail, handleRouteError, ok } from "@/lib/server/responses";
import { serializeWorkerOrder } from "@/lib/server/serializers";

export const runtime = "nodejs";

export async function GET() {
  try {
    const worker = await requireWorkerSession();
    const current = await prisma.worker.findUnique({ where: { id: worker.id } });
    if (!current) return fail("接单方不存在", 404);
    if (current.status !== "ONLINE") return ok({ orders: [], gated: true, message: "上线后才能查看订单大厅" });

    await expireStaleOrders();

    const orders = await prisma.order.findMany({
      where: { status: "PENDING" },
      orderBy: { createdAt: "asc" },
      take: 50,
      include: orderInclude,
    });
    return ok({ orders: orders.map(serializeWorkerOrder), gated: false });
  } catch (error) {
    if (error instanceof Response) return fail("未登录", 401);
    return handleRouteError(error);
  }
}
