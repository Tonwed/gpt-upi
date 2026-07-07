import { OrderResult, OrderStatus, Prisma } from "@prisma/client";
import { requireWorkerSession } from "@/lib/server/auth";
import { containsInsensitive, createPaginationMeta, parseAdminPagination } from "@/lib/server/admin-pagination";
import { prisma } from "@/lib/server/prisma";
import { fail, handleRouteError, ok } from "@/lib/server/responses";
import { decimalToNumber } from "@/lib/server/serializers";

export const runtime = "nodejs";

const SEARCHABLE_RESULTS: OrderResult[] = ["COMPLETED", "PROBLEM", "FAILED", "CANCELLED", "EXPIRED"];
const SEARCHABLE_ORDER_STATUSES: OrderStatus[] = ["PENDING", "ASSIGNED", "CHECKING", "NEED_REUPLOAD", "COMPLETED", "FAILED", "CANCELLED", "EXPIRED"];

const RESULT_ALIASES: Record<string, OrderResult> = {
  完成: "COMPLETED",
  已完成: "COMPLETED",
  completed: "COMPLETED",
  issue: "PROBLEM",
  problem: "PROBLEM",
  异常: "PROBLEM",
  异常重传: "PROBLEM",
  问题: "PROBLEM",
  failed: "FAILED",
  fail: "FAILED",
  失败: "FAILED",
  cancelled: "CANCELLED",
  canceled: "CANCELLED",
  cancel: "CANCELLED",
  取消: "CANCELLED",
  已取消: "CANCELLED",
  expired: "EXPIRED",
  timeout: "EXPIRED",
  超时: "EXPIRED",
  过期: "EXPIRED",
};

const ORDER_STATUS_ALIASES: Record<string, OrderStatus> = {
  pending: "PENDING",
  等待: "PENDING",
  等待接单: "PENDING",
  assigned: "ASSIGNED",
  处理中: "ASSIGNED",
  已接单: "ASSIGNED",
  checking: "CHECKING",
  检测: "CHECKING",
  正在检测: "CHECKING",
  need_reupload: "NEED_REUPLOAD",
  reupload: "NEED_REUPLOAD",
  重传: "NEED_REUPLOAD",
  completed: "COMPLETED",
  完成: "COMPLETED",
  已完成: "COMPLETED",
  failed: "FAILED",
  失败: "FAILED",
  cancelled: "CANCELLED",
  canceled: "CANCELLED",
  取消: "CANCELLED",
  已取消: "CANCELLED",
  expired: "EXPIRED",
  超时: "EXPIRED",
  过期: "EXPIRED",
};

const SETTLED_SEARCH_KEYS = new Set(["settled", "paid", "已结", "已结单"]);
const UNSETTLED_SEARCH_KEYS = new Set(["unsettled", "unpaid", "未结", "未结单"]);

function normalizeSearchKey(search: string) {
  return search.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function workerHistoryWhere(workerId: string, search: string): Prisma.WorkerOrderRecordWhereInput {
  const trimmed = search.trim();
  if (!trimmed) return { workerId };

  const normalized = normalizeSearchKey(trimmed);
  const upper = normalized.toUpperCase();
  const resultAlias = RESULT_ALIASES[normalized];
  const statusAlias = ORDER_STATUS_ALIASES[normalized];
  const resultMatches = SEARCHABLE_RESULTS.filter((result) => result.includes(upper));
  const statusMatches = SEARCHABLE_ORDER_STATUSES.filter((status) => status.includes(upper));
  if (resultAlias && !resultMatches.includes(resultAlias)) resultMatches.push(resultAlias);
  if (statusAlias && !statusMatches.includes(statusAlias)) statusMatches.push(statusAlias);

  const or: Prisma.WorkerOrderRecordWhereInput[] = [
    { note: containsInsensitive(trimmed) },
    { settledBy: containsInsensitive(trimmed) },
    { order: { orderNo: containsInsensitive(trimmed) } },
    { order: { publicUserTelegramId: containsInsensitive(trimmed) } },
    { order: { publicUserTelegramName: containsInsensitive(trimmed) } },
  ];

  if (resultMatches.length > 0) or.push({ result: { in: resultMatches } });
  if (statusMatches.length > 0) or.push({ order: { status: { in: statusMatches } } });
  if (SETTLED_SEARCH_KEYS.has(normalized)) or.push({ settledAt: { not: null } });
  if (UNSETTLED_SEARCH_KEYS.has(normalized)) or.push({ settledAt: null });

  return { workerId, OR: or };
}

function serializeRecord(record: Awaited<ReturnType<typeof prisma.workerOrderRecord.findMany>>[number]) {
  return {
    ...record,
    unitPriceSnapshot: decimalToNumber(record.unitPriceSnapshot),
  };
}

export async function GET(request: Request) {
  try {
    const worker = await requireWorkerSession();
    const { isPaged, page, pageSize, search } = parseAdminPagination(request, { defaultPageSize: 10, maxPageSize: 50 });
    const where = workerHistoryWhere(worker.id, search);

    if (!isPaged) {
      const records = await prisma.workerOrderRecord.findMany({
        where: { workerId: worker.id },
        orderBy: { completedAt: "desc" },
        take: 100,
        include: {
          order: {
            select: {
              id: true,
              orderNo: true,
              status: true,
              createdAt: true,
              completedAt: true,
            },
          },
        },
      });
      return ok(records.map(serializeRecord));
    }

    const total = await prisma.workerOrderRecord.count({ where });
    const pagination = createPaginationMeta({ page, pageSize, total, search });
    const records = await prisma.workerOrderRecord.findMany({
      where,
      orderBy: { completedAt: "desc" },
      skip: (pagination.page - 1) * pageSize,
      take: pageSize,
      include: {
        order: {
          select: {
            id: true,
            orderNo: true,
            status: true,
            createdAt: true,
            completedAt: true,
          },
        },
      },
    });

    return ok({ items: records.map(serializeRecord), pagination });
  } catch (error) {
    if (error instanceof Response) return fail("未登录", 401);
    return handleRouteError(error);
  }
}
