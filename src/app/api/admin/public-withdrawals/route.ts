import type { Prisma } from "@prisma/client";
import { requireAdminSession } from "@/lib/server/auth";
import { containsInsensitive, paginatedPayload, parseAdminPagination } from "@/lib/server/admin-pagination";
import { prisma } from "@/lib/server/prisma";
import { fail, handleRouteError, ok } from "@/lib/server/responses";
import { decimalToNumber } from "@/lib/server/serializers";

export const runtime = "nodejs";

function money(value: unknown) {
  const amount = decimalToNumber(value as never);
  return Number(amount.toFixed(6));
}

type PublicWithdrawalWithWallet = Prisma.PublicUserWithdrawalRequestGetPayload<{
  include: {
    wallet: {
      select: {
        availableBalance: true;
        frozenBalance: true;
        totalDeposited: true;
        totalSpent: true;
      };
    };
  };
}>;

function serializePublicWithdrawal(request: PublicWithdrawalWithWallet) {
  return {
    id: request.id,
    telegramUserId: request.telegramUserId,
    telegramUsername: request.telegramUsername,
    amount: money(request.amount),
    fee: money(request.fee),
    totalFrozen: money(request.totalFrozen),
    status: request.status,
    chain: request.chain,
    tokenSymbol: request.tokenSymbol,
    withdrawalAddress: request.withdrawalAddress,
    note: request.note,
    adminNote: request.adminNote,
    requestedAt: request.requestedAt,
    processedAt: request.processedAt,
    processedBy: request.processedBy,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    wallet: request.wallet
      ? {
          availableBalance: money(request.wallet.availableBalance),
          frozenBalance: money(request.wallet.frozenBalance),
          totalDeposited: money(request.wallet.totalDeposited),
          totalSpent: money(request.wallet.totalSpent),
        }
      : null,
  };
}

export async function GET(request: Request) {
  try {
    await requireAdminSession();
    const { isPaged, page, pageSize, skip, take, search } = parseAdminPagination(request);
    const where: Prisma.PublicUserWithdrawalRequestWhereInput = search
      ? {
          OR: [
            { id: containsInsensitive(search) },
            { telegramUserId: containsInsensitive(search) },
            { telegramUsername: containsInsensitive(search) },
            { withdrawalAddress: containsInsensitive(search) },
            { note: containsInsensitive(search) },
            { adminNote: containsInsensitive(search) },
          ],
        }
      : {};
    const requests = await prisma.publicUserWithdrawalRequest.findMany({
      where,
      orderBy: [{ status: "asc" }, { requestedAt: "desc" }],
      skip: isPaged ? skip : undefined,
      take: isPaged ? take : 200,
      include: {
        wallet: {
          select: {
            availableBalance: true,
            frozenBalance: true,
            totalDeposited: true,
            totalSpent: true,
          },
        },
      },
    });
    const items = requests.map(serializePublicWithdrawal);
    if (!isPaged) return ok(items);
    const total = await prisma.publicUserWithdrawalRequest.count({ where });
    return ok(paginatedPayload(items, { page, pageSize, total, search }));
  } catch (error) {
    if (error instanceof Response) return fail("未登录管理员", 401);
    return handleRouteError(error);
  }
}
