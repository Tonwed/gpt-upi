/* eslint-disable @typescript-eslint/no-require-imports */
const { Prisma, PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const LIMIT_ARG = process.argv.find((arg) => arg.startsWith("--limit="));
const LIMIT = LIMIT_ARG ? Math.max(1, Number(LIMIT_ARG.slice("--limit=".length)) || 0) : 0;
const FIX_PREFIX = "scan_order_overrefund_fix:";

function decimal(value) {
  return new Prisma.Decimal(value || 0);
}

function toNumber(value) {
  return Number(decimal(value).toFixed(6));
}

async function loadCandidates() {
  const rows = await prisma.$queryRaw`
    WITH grouped AS (
      SELECT
        "telegramUserId",
        "orderId",
        COUNT(*) FILTER (WHERE "type" = 'SCAN_ORDER_FREEZE')::int AS freezes,
        COUNT(*) FILTER (WHERE "type" = 'SCAN_ORDER_REFUND')::int AS refunds,
        COUNT(*) FILTER (WHERE "type" = 'SCAN_ORDER_SPEND')::int AS spends,
        COALESCE(SUM("availableDelta"), 0) AS "availableDelta",
        COALESCE(SUM("frozenDelta"), 0) AS "frozenDelta",
        MIN("createdAt") AS "firstAt",
        MAX("createdAt") AS "lastAt"
      FROM "public_user_wallet_ledgers"
      WHERE "type" IN ('SCAN_ORDER_FREEZE', 'SCAN_ORDER_REFUND', 'SCAN_ORDER_SPEND')
        AND "orderId" IS NOT NULL
      GROUP BY "telegramUserId", "orderId"
    )
    SELECT g.*
    FROM grouped g
    WHERE g.freezes > 0
      AND g."frozenDelta" < 0
      AND g."availableDelta" > 0
      AND NOT EXISTS (
        SELECT 1
        FROM "public_user_wallet_ledgers" fixed
        WHERE fixed."telegramUserId" = g."telegramUserId"
          AND fixed."orderId" = g."orderId"
          AND fixed."type" = 'ADMIN_ADJUSTMENT'
          AND fixed."referenceId" = CONCAT(${FIX_PREFIX}, g."orderId")
      )
    ORDER BY g."lastAt" DESC
  `;

  const candidates = rows.map((row) => {
    const availableDelta = decimal(row.availableDelta);
    const frozenDelta = decimal(row.frozenDelta);
    const correction = Prisma.Decimal.min(availableDelta, frozenDelta.negated());
    return {
      telegramUserId: row.telegramUserId,
      orderId: row.orderId,
      freezes: Number(row.freezes),
      refunds: Number(row.refunds),
      spends: Number(row.spends),
      availableDelta: toNumber(availableDelta),
      frozenDelta: toNumber(frozenDelta),
      correctionAmount: toNumber(correction),
      firstAt: row.firstAt,
      lastAt: row.lastAt,
    };
  }).filter((item) => item.correctionAmount > 0);

  return LIMIT > 0 ? candidates.slice(0, LIMIT) : candidates;
}

function summarize(candidates) {
  const byUser = new Map();
  for (const item of candidates) {
    const current = byUser.get(item.telegramUserId) || { telegramUserId: item.telegramUserId, count: 0, amount: 0 };
    current.count += 1;
    current.amount = Number((current.amount + item.correctionAmount).toFixed(6));
    byUser.set(item.telegramUserId, current);
  }
  const totalCorrection = candidates.reduce((sum, item) => sum + item.correctionAmount, 0);
  return {
    mode: APPLY ? "apply" : "dry-run",
    count: candidates.length,
    totalCorrection: Number(totalCorrection.toFixed(6)),
    byUser: [...byUser.values()].sort((a, b) => b.amount - a.amount),
    sample: candidates.slice(0, 50),
  };
}

async function applyFix(candidates) {
  for (const item of candidates) {
    await prisma.$transaction(
      async (tx) => {
        const existing = await tx.publicUserWalletLedger.findFirst({
          where: {
            telegramUserId: item.telegramUserId,
            orderId: item.orderId,
            type: "ADMIN_ADJUSTMENT",
            referenceId: `${FIX_PREFIX}${item.orderId}`,
          },
          select: { id: true },
        });
        if (existing) return;

        const walletRows = await tx.$queryRaw`
          SELECT "id"
          FROM "public_user_wallets"
          WHERE "telegramUserId" = ${item.telegramUserId}
          FOR UPDATE
        `;
        const wallet = walletRows[0] || null;
        if (!wallet) throw new Error(`wallet not found: ${item.telegramUserId}`);

        const amount = decimal(item.correctionAmount);
        await tx.publicUserWallet.update({
          where: { id: wallet.id },
          data: {
            availableBalance: { decrement: amount },
            frozenBalance: { increment: amount },
          },
        });
        await tx.publicUserWalletLedger.create({
          data: {
            walletId: wallet.id,
            telegramUserId: item.telegramUserId,
            type: "ADMIN_ADJUSTMENT",
            availableDelta: amount.negated(),
            frozenDelta: amount,
            orderId: item.orderId,
            referenceId: `${FIX_PREFIX}${item.orderId}`,
            note: `Correct duplicate scan-order refund: reverse ${amount.toFixed(6)} USDT over-refund`,
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }
}

(async () => {
  const candidates = await loadCandidates();
  const before = summarize(candidates);
  console.log(JSON.stringify(before, null, 2));
  if (!APPLY) {
    console.log("\nDry-run only. Re-run with --apply to write ADMIN_ADJUSTMENT ledgers and wallet balance corrections.");
    return;
  }
  await applyFix(candidates);
  const remaining = await loadCandidates();
  console.log(JSON.stringify({ applied: candidates.length, remaining: summarize(remaining) }, null, 2));
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
