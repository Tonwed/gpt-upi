import { WorkerStatus } from "@prisma/client";
import { expireStaleOrders } from "@/lib/server/orders";
import { prisma } from "@/lib/server/prisma";
import { handleRouteError, ok } from "@/lib/server/responses";

export const runtime = "nodejs";

export async function GET() {
  try {
    await expireStaleOrders();
    const count = await prisma.worker.count({
      where: { status: WorkerStatus.ONLINE },
    });
    return ok({ count });
  } catch (error) {
    return handleRouteError(error);
  }
}
