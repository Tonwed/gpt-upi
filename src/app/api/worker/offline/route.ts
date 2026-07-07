import { requireWorkerSession } from "@/lib/server/auth";
import { prisma } from "@/lib/server/prisma";
import { fail, handleRouteError, ok } from "@/lib/server/responses";
import { serializeWorker } from "@/lib/server/serializers";

export const runtime = "nodejs";

export async function POST() {
  try {
    const worker = await requireWorkerSession();
    const activeCount = await prisma.workerActiveOrder.count({ where: { workerId: worker.id } });
    if (activeCount > 0) return fail("当前有进行中的订单，完成后才能下线");

    const updated = await prisma.worker.update({
      where: { id: worker.id },
      data: { status: "OFFLINE", autoAcceptEnabled: false, lastSeenAt: new Date() },
      select: {
        id: true,
        username: true,
        displayName: true,
        unitPrice: true,
        payoutMode: true,
        binanceUserId: true,
        telegramUserId: true,
        telegramUsername: true,
        status: true,
        isDisabled: true,
        autoAcceptEnabled: true,
        autoAcceptNotifyEnabled: true,
        newOrderSoundEnabled: true,
        lastSeenAt: true,
        createdAt: true,
      },
    });
    return ok(serializeWorker(updated));
  } catch (error) {
    if (error instanceof Response) return fail("未登录", 401);
    return handleRouteError(error);
  }
}
