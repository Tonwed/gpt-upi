import { requireWorkerSession } from "@/lib/server/auth";
import { prisma } from "@/lib/server/prisma";
import { fail, handleRouteError, ok } from "@/lib/server/responses";
import { serializeWorker } from "@/lib/server/serializers";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const worker = await requireWorkerSession();
    if (worker.binanceUserId) return fail("Binance 用户 ID 已绑定，绑定后不可修改");
    const body = await request.json().catch(() => ({}));
    const binanceUserId = String(body.binanceUserId || "").trim();
    if (!binanceUserId) return fail("请填写 Binance 用户 ID");
    if (!/^[A-Za-z0-9_.-]{3,64}$/.test(binanceUserId)) return fail("Binance 用户 ID 格式不正确");

    const updated = await prisma.worker.update({
      where: { id: worker.id },
      data: { binanceUserId, lastSeenAt: new Date() },
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
    if (error instanceof Response) return fail("Unauthorized", 401);
    return handleRouteError(error);
  }
}
