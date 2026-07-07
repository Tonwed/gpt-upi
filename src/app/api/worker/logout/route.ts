import { NextResponse } from "next/server";
import { clearWorkerCookie, getWorkerSession } from "@/lib/server/auth";
import { prisma } from "@/lib/server/prisma";

export const runtime = "nodejs";

export async function POST() {
  const worker = await getWorkerSession();
  if (worker) {
    const activeCount = await prisma.workerActiveOrder.count({ where: { workerId: worker.id } });
    if (activeCount === 0) {
      await prisma.worker.update({
        where: { id: worker.id },
        data: { status: "OFFLINE", autoAcceptEnabled: false, lastSeenAt: new Date() },
      });
    }
  }
  const response = NextResponse.json({ ok: true, data: null });
  clearWorkerCookie(response);
  return response;
}
