import { requireWorkerSession } from "@/lib/server/auth";
import { expireStaleOrders, orderInclude } from "@/lib/server/orders";
import { prisma } from "@/lib/server/prisma";
import { fail, handleRouteError, ok } from "@/lib/server/responses";
import { serializeWorkerOrder } from "@/lib/server/serializers";

export const runtime = "nodejs";

export async function GET() {
  try {
    const worker = await requireWorkerSession();

    await expireStaleOrders();

    const active = await prisma.workerActiveOrder.findFirst({
      where: { workerId: worker.id },
      include: { order: { include: orderInclude } },
      orderBy: { createdAt: "asc" },
    });
    return ok(active?.order ? serializeWorkerOrder(active.order) : null);
  } catch (error) {
    if (error instanceof Response) return fail("Unauthorized", 401);
    return handleRouteError(error);
  }
}
