import { randomBytes } from "crypto";
import { Prisma } from "@prisma/client";
import bcrypt from "bcryptjs";
import { requireAdminSession } from "@/lib/server/auth";
import { containsInsensitive, paginatedPayload, parseAdminPagination } from "@/lib/server/admin-pagination";
import { prisma } from "@/lib/server/prisma";
import { fail, handleRouteError, ok } from "@/lib/server/responses";
import { decimalToNumber, serializeWorker } from "@/lib/server/serializers";
import { getWorkerWalletSummary } from "@/lib/server/wallet";

export const runtime = "nodejs";

function parseUnitPrice(value: unknown) {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return amount.toFixed(2);
}

export async function GET(request: Request) {
  try {
    await requireAdminSession();
    const { isPaged, page, pageSize, skip, take, search } = parseAdminPagination(request);
    const where: Prisma.WorkerWhereInput = search
      ? {
          OR: [
            { username: containsInsensitive(search) },
            { displayName: containsInsensitive(search) },
            { telegramUserId: containsInsensitive(search) },
            { telegramUsername: containsInsensitive(search) },
            { binanceUserId: containsInsensitive(search) },
          ],
        }
      : {};
    const [workers, completedStats, unsettledStats, settledStats] = await Promise.all([
      prisma.worker.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: isPaged ? skip : undefined,
        take: isPaged ? take : undefined,
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
          activeOrders: {
            orderBy: { createdAt: "asc" },
            select: {
              orderId: true,
              createdAt: true,
              order: {
                select: {
                  orderNo: true,
                },
              },
            },
          },
          _count: { select: { records: true } },
        },
      }),
      prisma.workerOrderRecord.groupBy({
        by: ["workerId"],
        where: { result: "COMPLETED" },
        _count: { _all: true },
        _sum: { unitPriceSnapshot: true },
      }),
      prisma.workerOrderRecord.groupBy({
        by: ["workerId"],
        where: { result: "COMPLETED", settledAt: null },
        _count: { _all: true },
        _sum: { unitPriceSnapshot: true },
      }),
      prisma.workerOrderRecord.groupBy({
        by: ["workerId"],
        where: { result: "COMPLETED", settledAt: { not: null } },
        _count: { _all: true },
        _sum: { unitPriceSnapshot: true },
      }),
    ]);

    const completedMap = new Map(completedStats.map((stat) => [stat.workerId, stat]));
    const unsettledMap = new Map(unsettledStats.map((stat) => [stat.workerId, stat]));
    const settledMap = new Map(settledStats.map((stat) => [stat.workerId, stat]));
    const walletEntries = await Promise.all(workers.map(async (worker) => [worker.id, await getWorkerWalletSummary(worker.id)] as const));
    const walletMap = new Map(walletEntries);

    const items =
      workers.map((worker) => {
        const completed = completedMap.get(worker.id);
        const unsettled = unsettledMap.get(worker.id);
        const settled = settledMap.get(worker.id);
        return {
          ...serializeWorker(worker),
          activeOrder: worker.activeOrders[0]
            ? {
                orderId: worker.activeOrders[0].orderId,
                orderNo: worker.activeOrders[0].order.orderNo,
                createdAt: worker.activeOrders[0].createdAt,
              }
            : null,
          activeOrders: worker.activeOrders.map((activeOrder) => ({
            orderId: activeOrder.orderId,
            orderNo: activeOrder.order.orderNo,
            createdAt: activeOrder.createdAt,
          })),
          _count: worker._count,
          completedCount: completed?._count._all ?? 0,
          totalAmount: decimalToNumber(completed?._sum.unitPriceSnapshot),
          unsettledCompleted: unsettled?._count._all ?? 0,
          unsettledAmount: decimalToNumber(unsettled?._sum.unitPriceSnapshot),
          settledCompleted: settled?._count._all ?? 0,
          settledAmount: decimalToNumber(settled?._sum.unitPriceSnapshot),
          wallet: walletMap.get(worker.id),
        };
      });

    if (!isPaged) return ok(items);

    const total = await prisma.worker.count({ where });
    return ok(paginatedPayload(items, { page, pageSize, total, search }));
  } catch (error) {
    if (error instanceof Response) return fail("未登录管理员", 401);
    return handleRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    await requireAdminSession();
    const body = await request.json();
    const username = String(body.username || "").trim();
    const displayName = String(body.displayName || "").trim() || username;
    const telegramUserId = String(body.telegramUserId || "").trim() || null;
    const telegramUsername = String(body.telegramUsername || "").trim().replace(/^@/, "").toLowerCase() || null;
    const unitPrice = parseUnitPrice(body.unitPrice);
    const payoutMode = body.payoutMode === "PREPAID" ? "PREPAID" : "POSTPAID";
    const binanceUserId = String(body.binanceUserId || "").trim() || null;
    if (!username) return fail("请输入账号标识");
    if (!telegramUserId && !telegramUsername) return fail("请至少填写 Telegram ID 或 Telegram 用户名");
    if (unitPrice === null) return fail("单价必须是大于或等于 0 的数字");

    const passwordHash = await bcrypt.hash(randomBytes(24).toString("base64url"), 10);
    const worker = await prisma.worker.create({
      data: { username, displayName, passwordHash, unitPrice, payoutMode, binanceUserId, telegramUserId, telegramUsername },
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
    return ok({
      ...serializeWorker(worker),
      _count: { records: 0 },
      completedCount: 0,
      totalAmount: 0,
      unsettledCompleted: 0,
      unsettledAmount: 0,
      settledCompleted: 0,
      settledAmount: 0,
      wallet: await getWorkerWalletSummary(worker.id),
    });
  } catch (error) {
    if (error instanceof Response) return fail("未登录管理员", 401);
    const message = error instanceof Error ? error.message : "创建接单账号失败";
    if (message.includes("Unique")) return fail("账号已存在");
    return handleRouteError(error);
  }
}
