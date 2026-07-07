import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/server/auth";
import { prisma } from "@/lib/server/prisma";
import { decimalToNumber } from "@/lib/server/serializers";

export const runtime = "nodejs";

function csvCell(value: unknown) {
  const text = value == null ? "" : String(value);
  return '"' + text.replace(/"/g, '""') + '"';
}

export async function GET(_request: Request, context: { params: Promise<{ batchId: string }> }) {
  try {
    await requireAdminSession();
    const { batchId } = await context.params;

    const batch = await prisma.cdkBatch.findUnique({ where: { id: batchId } });
    if (!batch) {
      return NextResponse.json({ ok: false, message: "CDK batch not found" }, { status: 404 });
    }

    const cdks = await prisma.cdk.findMany({
      where: { batchId },
      orderBy: { createdAt: "asc" },
    });
    const rows = [
      ["key", "amount", "status", "redeemed", "redeemedByTelegramId", "redeemedByTelegramName", "redeemedAt", "remark", "createdAt"],
      ...cdks.map((cdk) => [
        cdk.code,
        decimalToNumber(cdk.amount).toFixed(2),
        cdk.status,
        cdk.redeemedAt ? "YES" : "NO",
        cdk.redeemedByTelegramId || "",
        cdk.redeemedByTelegramName || "",
        cdk.redeemedAt?.toISOString() || "",
        cdk.remark || "",
        cdk.createdAt.toISOString(),
      ]),
    ];
    const csv = "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
    const safeName = (batch.name || batch.id).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 60) || batch.id;

    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="recharge-cdk-batch-${safeName}.csv"`,
      },
    });
  } catch {
    return NextResponse.json({ ok: false, message: "Admin login required" }, { status: 401 });
  }
}
