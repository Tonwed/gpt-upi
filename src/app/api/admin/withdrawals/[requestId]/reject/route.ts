import { requireAdminSession } from "@/lib/server/auth";
import { prisma } from "@/lib/server/prisma";
import { fail, handleRouteError, ok } from "@/lib/server/responses";
import { serializeWorkerWithdrawalRequest } from "@/lib/server/serializers";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ requestId: string }> }) {
  try {
    const admin = await requireAdminSession();
    const { requestId } = await context.params;
    const body = await request.json().catch(() => ({}));
    const adminNote = String(body.adminNote || "").trim() || "Rejected";
    const current = await prisma.workerWithdrawalRequest.findUnique({
      where: { id: requestId },
      select: { id: true, status: true },
    });
    if (!current) return fail("提现申请不存在", 404);
    if (current.status !== "PENDING") return fail("该提现申请已处理");

    const withdrawal = await prisma.workerWithdrawalRequest.update({
      where: { id: requestId },
      data: {
        status: "REJECTED",
        adminNote,
        processedAt: new Date(),
        processedBy: admin.username,
      },
      include: {
        worker: { select: { id: true, username: true, displayName: true, binanceUserId: true } },
      },
    });
    return ok(serializeWorkerWithdrawalRequest(withdrawal));
  } catch (error) {
    if (error instanceof Response) return fail("未登录管理员", 401);
    if (error && typeof error === "object" && "code" in error && error.code === "P2025") return fail("提现申请不存在", 404);
    return handleRouteError(error);
  }
}
