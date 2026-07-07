import { requireWorkerSession } from "@/lib/server/auth";
import { prisma } from "@/lib/server/prisma";
import { fail, handleRouteError, ok } from "@/lib/server/responses";
import { serializeWorker } from "@/lib/server/serializers";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const worker = await requireWorkerSession();
    const body = await request.json();
    const enabled = Boolean(body.enabled);
    const current = await prisma.worker.findUnique({ where: { id: worker.id } });
    if (!current) return fail("接单方不存在", 404);
    if (enabled && current.status !== "ONLINE") return fail("请先上线再开启自动接单");

    const updated = await prisma.worker.update({
      where: { id: worker.id },
      data: { autoAcceptEnabled: enabled, lastSeenAt: new Date() },
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
