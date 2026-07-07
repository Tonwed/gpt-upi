import { requireAdminSession } from "@/lib/server/auth";
import { prisma } from "@/lib/server/prisma";
import { fail, handleRouteError, ok } from "@/lib/server/responses";
import { serializeWorker } from "@/lib/server/serializers";

export const runtime = "nodejs";

const workerSelect = {
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
} as const;

export async function POST(request: Request, context: { params: Promise<{ workerId: string }> }) {
  try {
    await requireAdminSession();
    const { workerId } = await context.params;
    const body = await request.json().catch(() => ({}));
    const enabled = Boolean(body.enabled);

    if (enabled) {
      return fail("管理员只能关闭 worker 自动接单；开启需由 worker 本人上线后操作");
    }

    const updated = await prisma.worker.update({
      where: { id: workerId },
      data: {
        autoAcceptEnabled: false,
        lastSeenAt: new Date(),
      },
      select: workerSelect,
    });

    return ok(serializeWorker(updated));
  } catch (error) {
    if (error instanceof Response) return fail("未登录管理员", 401);
    if (error && typeof error === "object" && "code" in error && error.code === "P2025") {
      return fail("接单账号不存在", 404);
    }
    return handleRouteError(error);
  }
}
