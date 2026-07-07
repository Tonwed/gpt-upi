import { requireWorkerSession } from "@/lib/server/auth";
import { expireStaleOrders } from "@/lib/server/orders";
import { prisma } from "@/lib/server/prisma";
import { fail, handleRouteError, ok } from "@/lib/server/responses";
import { decimalToNumber, getShanghaiDayRange } from "@/lib/server/serializers";
import { getWorkerWalletSummary } from "@/lib/server/wallet";

export const runtime = "nodejs";

export async function GET() {
  try {
    const worker = await requireWorkerSession();
    await expireStaleOrders();

    const { start, end } = getShanghaiDayRange();
    const [
      todayCompleted,
      todayAmount,
      totalCompleted,
      totalAmount,
      problemCount,
      activeOrderCount,
      unsettledCompleted,
      unsettledAmount,
      settledCompleted,
      settledAmount,
    ] = await Promise.all([
      prisma.workerOrderRecord.count({
        where: { workerId: worker.id, result: "COMPLETED", completedAt: { gte: start, lt: end } },
      }),
      prisma.workerOrderRecord.aggregate({
        where: { workerId: worker.id, result: "COMPLETED", completedAt: { gte: start, lt: end } },
        _sum: { unitPriceSnapshot: true },
      }),
      prisma.workerOrderRecord.count({ where: { workerId: worker.id, result: "COMPLETED" } }),
      prisma.workerOrderRecord.aggregate({
        where: { workerId: worker.id, result: "COMPLETED" },
        _sum: { unitPriceSnapshot: true },
      }),
      prisma.workerOrderRecord.count({ where: { workerId: worker.id, result: "PROBLEM" } }),
      prisma.workerActiveOrder.count({ where: { workerId: worker.id } }),
      prisma.workerOrderRecord.count({ where: { workerId: worker.id, result: "COMPLETED", settledAt: null } }),
      prisma.workerOrderRecord.aggregate({
        where: { workerId: worker.id, result: "COMPLETED", settledAt: null },
        _sum: { unitPriceSnapshot: true },
      }),
      prisma.workerOrderRecord.count({ where: { workerId: worker.id, result: "COMPLETED", settledAt: { not: null } } }),
      prisma.workerOrderRecord.aggregate({
        where: { workerId: worker.id, result: "COMPLETED", settledAt: { not: null } },
        _sum: { unitPriceSnapshot: true },
      }),
    ]);
    const wallet = await getWorkerWalletSummary(worker.id);
    return ok({
      unitPrice: decimalToNumber(worker.unitPrice),
      wallet,
      todayCompleted,
      todayAmount: decimalToNumber(todayAmount._sum.unitPriceSnapshot),
      totalCompleted,
      totalAmount: decimalToNumber(totalAmount._sum.unitPriceSnapshot),
      problemCount,
      activeOrderCount,
      unsettledCompleted,
      unsettledAmount: decimalToNumber(unsettledAmount._sum.unitPriceSnapshot),
      settledCompleted,
      settledAmount: decimalToNumber(settledAmount._sum.unitPriceSnapshot),
      dayStart: start,
      dayEnd: end,
    });
  } catch (error) {
    if (error instanceof Response) return fail("Unauthorized", 401);
    return handleRouteError(error);
  }
}
