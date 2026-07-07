import { Prisma } from "@prisma/client";
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

export async function POST(_request: Request, context: { params: Promise<{ workerId: string }> }) {
  try {
    await requireAdminSession();
    const { workerId } = await context.params;

    const result = await prisma.$transaction(
      async (tx) => {
        const worker = await tx.worker.findUnique({
          where: { id: workerId },
          select: { id: true },
        });
        if (!worker) return { type: "notFound" as const };

        const updated = await tx.worker.updateMany({
          where: {
            id: workerId,
            activeOrders: { none: {} },
          },
          data: {
            status: "OFFLINE",
            autoAcceptEnabled: false,
            lastSeenAt: new Date(),
          },
        });

        if (updated.count === 0) {
          const activeOrder = await tx.workerActiveOrder.findFirst({
            where: { workerId },
            select: {
              order: {
                select: {
                  orderNo: true,
                },
              },
            },
          });
          return { type: "hasActiveOrder" as const, orderNo: activeOrder?.order.orderNo };
        }

        const nextWorker = await tx.worker.findUniqueOrThrow({
          where: { id: workerId },
          select: workerSelect,
        });
        return { type: "ok" as const, worker: nextWorker };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );

    if (result.type === "notFound") return fail("接单账号不存在", 404);
    if (result.type === "hasActiveOrder") {
      return fail(result.orderNo ? `该接单方有进行中订单 ${result.orderNo}，完成或退回后才能下线` : "该接单方有进行中订单，完成或退回后才能下线");
    }

    return ok(serializeWorker(result.worker));
  } catch (error) {
    if (error instanceof Response) return fail("未登录管理员", 401);
    return handleRouteError(error);
  }
}
