import { getWorkerSession } from "@/lib/server/auth";
import { fail, handleRouteError, ok } from "@/lib/server/responses";
import { prisma } from "@/lib/server/prisma";
import { expireStaleOrders, orderInclude } from "@/lib/server/orders";
import { serializeWorkerOrder, serializeWorker } from "@/lib/server/serializers";

export const runtime = "nodejs";

export async function GET() {
  try {
    const worker = await getWorkerSession();
    if (!worker) return fail("Unauthorized", 401);

    await expireStaleOrders();

    const activeOrders = await prisma.workerActiveOrder.findMany({
      where: { workerId: worker.id },
      include: { order: { include: orderInclude } },
      orderBy: { createdAt: "asc" },
    });
    const serializedActiveOrders = activeOrders.map((entry) => serializeWorkerOrder(entry.order));

    return ok({
      worker: serializeWorker(worker),
      activeOrder: serializedActiveOrders[0] ?? null,
      activeOrders: serializedActiveOrders,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
