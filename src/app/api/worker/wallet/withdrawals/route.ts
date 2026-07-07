import { Prisma, WorkerWithdrawalStatus } from "@prisma/client";
import { requireWorkerSession } from "@/lib/server/auth";
import { containsInsensitive, createPaginationMeta, parseAdminPagination } from "@/lib/server/admin-pagination";
import { prisma } from "@/lib/server/prisma";
import { fail, handleRouteError, ok } from "@/lib/server/responses";
import { serializeWorkerWithdrawalRequest } from "@/lib/server/serializers";

export const runtime = "nodejs";

const SEARCHABLE_WITHDRAWAL_STATUSES: WorkerWithdrawalStatus[] = ["PENDING", "PAID", "REJECTED", "CANCELLED"];

const STATUS_ALIASES: Record<string, WorkerWithdrawalStatus> = {
  pending: "PENDING",
  wait: "PENDING",
  waiting: "PENDING",
  待处理: "PENDING",
  待审核: "PENDING",
  待打款: "PENDING",
  paid: "PAID",
  payout: "PAID",
  completed: "PAID",
  已支付: "PAID",
  已打款: "PAID",
  已完成: "PAID",
  rejected: "REJECTED",
  reject: "REJECTED",
  failed: "REJECTED",
  拒绝: "REJECTED",
  已拒绝: "REJECTED",
  失败: "REJECTED",
  cancelled: "CANCELLED",
  canceled: "CANCELLED",
  cancel: "CANCELLED",
  取消: "CANCELLED",
  已取消: "CANCELLED",
};

function normalizeSearchKey(search: string) {
  return search.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function workerWithdrawalWhere(workerId: string, search: string): Prisma.WorkerWithdrawalRequestWhereInput {
  const trimmed = search.trim();
  if (!trimmed) return { workerId };

  const normalized = normalizeSearchKey(trimmed);
  const upper = normalized.toUpperCase();
  const alias = STATUS_ALIASES[normalized];
  const statusMatches = SEARCHABLE_WITHDRAWAL_STATUSES.filter((status) => status.includes(upper));
  if (alias && !statusMatches.includes(alias)) statusMatches.push(alias);

  const or: Prisma.WorkerWithdrawalRequestWhereInput[] = [
    { id: containsInsensitive(trimmed) },
    { binanceUserIdSnapshot: containsInsensitive(trimmed) },
    { note: containsInsensitive(trimmed) },
    { adminNote: containsInsensitive(trimmed) },
    { processedBy: containsInsensitive(trimmed) },
  ];

  if (statusMatches.length > 0) or.push({ status: { in: statusMatches } });

  return { workerId, OR: or };
}

export async function GET(request: Request) {
  try {
    const worker = await requireWorkerSession();
    const { isPaged, page, pageSize, search } = parseAdminPagination(request, { defaultPageSize: 10, maxPageSize: 50 });

    if (!isPaged) {
      const requests = await prisma.workerWithdrawalRequest.findMany({
        where: { workerId: worker.id },
        orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
        take: 20,
      });
      return ok(requests.map(serializeWorkerWithdrawalRequest));
    }

    const where = workerWithdrawalWhere(worker.id, search);
    const total = await prisma.workerWithdrawalRequest.count({ where });
    const pagination = createPaginationMeta({ page, pageSize, total, search });
    const requests = await prisma.workerWithdrawalRequest.findMany({
      where,
      orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
      skip: (pagination.page - 1) * pageSize,
      take: pageSize,
    });
    return ok({ items: requests.map(serializeWorkerWithdrawalRequest), pagination });
  } catch (error) {
    if (error instanceof Response) return fail("Unauthorized", 401);
    return handleRouteError(error);
  }
}
