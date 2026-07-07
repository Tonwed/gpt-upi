import { requireAdminSession } from "@/lib/server/auth";
import { prisma } from "@/lib/server/prisma";
import { fail, handleRouteError, ok } from "@/lib/server/responses";
import { getWorkerWalletSummary, parseMoneyAmount } from "@/lib/server/wallet";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ workerId: string }> }) {
  try {
    const admin = await requireAdminSession();
    const { workerId } = await context.params;
    const body = await request.json().catch(() => ({}));
    const amount = parseMoneyAmount(body.amount);
    const note = String(body.note || "").trim();
    if (!amount) return fail("请输入正确的预支金额");

    const worker = await prisma.worker.findUnique({ where: { id: workerId }, select: { id: true } });
    if (!worker) return fail("接单账号不存在", 404);

    await prisma.workerWalletLedger.create({
      data: {
        workerId,
        type: "ADMIN_ADVANCE",
        amount: (-Number(amount)).toFixed(2),
        note: note || "管理员预支款",
        createdBy: admin.username,
      },
    });
    await prisma.worker.update({ where: { id: workerId }, data: { payoutMode: "PREPAID" } });

    return ok(await getWorkerWalletSummary(workerId));
  } catch (error) {
    if (error instanceof Response) return fail("未登录管理员", 401);
    return handleRouteError(error);
  }
}
