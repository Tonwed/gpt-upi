import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/server/auth";
import { prisma } from "@/lib/server/prisma";
import { decimalToNumber } from "@/lib/server/serializers";

export const runtime = "nodejs";

function csvCell(value: unknown) {
  const text = value == null ? "" : String(value);
  return '"' + text.replace(/"/g, '""') + '"';
}

export async function GET() {
  try {
    await requireAdminSession();
    const cdks = await prisma.cdk.findMany({ orderBy: { createdAt: "desc" } });
    const rows = [
      ["code", "amount", "batchId", "status", "redeemed", "redeemedByTelegramId", "redeemedByTelegramName", "redeemedAt", "remark", "expiresAt", "createdAt"],
      ...cdks.map((cdk) => [
        cdk.code,
        decimalToNumber(cdk.amount).toFixed(2),
        cdk.batchId || "",
        cdk.status,
        cdk.redeemedAt ? "YES" : "NO",
        cdk.redeemedByTelegramId || "",
        cdk.redeemedByTelegramName || "",
        cdk.redeemedAt?.toISOString() || "",
        cdk.remark || "",
        cdk.expiresAt?.toISOString() || "",
        cdk.createdAt.toISOString(),
      ]),
    ];
    const csv = "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="recharge-cdks-' + new Date().toISOString().slice(0, 10) + '.csv"',
      },
    });
  } catch {
    return NextResponse.json({ ok: false, message: "Admin login required" }, { status: 401 });
  }
}
