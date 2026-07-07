import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { decryptSessionCredential, encryptSessionCredential, hashSessionCredential } from "@/lib/server/credential-vault";
import { orderInclude } from "@/lib/server/orders";
import { PUBLIC_SCAN_ORDER_PRICE, freezePublicScanOrderFunds } from "@/lib/server/public-user-wallet";
import { prisma } from "@/lib/server/prisma";
import { makeOrderNo, type OrderWithRelations } from "@/lib/server/serializers";

const SCAN_ORDER_TICKET_TTL_MS = 15 * 60 * 1000;
export const MIN_SCAN_ORDER_QR_REMAINING_MS = 60 * 1000;

async function ensurePublicUpiExtractReservationColumns() {
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "public_upi_extract_activities"
      ADD COLUMN IF NOT EXISTS "scanOrderId" TEXT,
      ADD COLUMN IF NOT EXISTS "scanOrderFundsReserved" BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS "scanOrderFundsReservedAmount" DECIMAL(10, 2),
      ADD COLUMN IF NOT EXISTS "scanOrderFundsReservedAt" TIMESTAMP(3),
      ADD COLUMN IF NOT EXISTS "scanOrderFundsReleasedAt" TIMESTAMP(3),
      ADD COLUMN IF NOT EXISTS "scanOrderFundsTransferredAt" TIMESTAMP(3)
  `);
}

type ScanOrderTicket = {
  token: string;
  jobId: string;
  credential: string;
  qrImageUrl: string;
  upiUri: string;
  paymentUrl: string;
  expiresAt: string;
  publicUserTelegramId: string;
  publicUserTelegramName?: string | null;
  channel: "public" | "premium";
  createdAt: number;
  consumedAt?: number;
  orderId?: string;
};

type PersistedScanOrderTicketRow = {
  jobId: string;
  token: string | null;
  publicUserTelegramId: string | null;
  publicUserTelegramName: string | null;
  channel: string | null;
  credentialEncrypted: string | null;
  resultQrImageUrl: string | null;
  resultUpiUri: string | null;
  resultPaymentUrl: string | null;
  resultExpiresAt: Date | string | null;
  scanOrderId: string | null;
  scanOrderCreateTokenConsumedAt: Date | string | null;
  scanOrderCreateTokenExpiresAt: Date | string | null;
};

type StoreGlobal = typeof globalThis & {
  __publicScanOrderTickets?: Map<string, ScanOrderTicket>;
};

const tickets = ((globalThis as StoreGlobal).__publicScanOrderTickets ??= new Map());

function cleanupTickets() {
  const now = Date.now();
  for (const [token, ticket] of tickets.entries()) {
    if (ticket.consumedAt || now - ticket.createdAt > SCAN_ORDER_TICKET_TTL_MS) {
      tickets.delete(token);
    }
  }
}

function toIso(value: Date | string | null | undefined) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

async function persistConsumedTicket(token: string, orderId: string) {
  try {
    await prisma.$executeRaw`
      UPDATE "public_upi_extract_activities"
      SET "scanOrderId" = ${orderId},
          "scanOrderCreateTokenConsumedAt" = NOW(),
          "updatedAt" = NOW()
      WHERE "scanOrderCreateToken" = ${token}
    `;
  } catch (error) {
    console.warn("Failed to persist consumed public scan order ticket", error);
  }
}

async function findPersistedTicket(token: string) {
  const rows = await prisma.$queryRaw<PersistedScanOrderTicketRow[]>`
    SELECT
      "jobId",
      "scanOrderCreateToken" AS "token",
      "publicUserTelegramId",
      "publicUserTelegramName",
      "channel",
      "credentialEncrypted",
      "resultQrImageUrl",
      "resultUpiUri",
      "resultPaymentUrl",
      "resultExpiresAt",
      "scanOrderId",
      "scanOrderCreateTokenConsumedAt",
      "scanOrderCreateTokenExpiresAt"
    FROM "public_upi_extract_activities"
    WHERE "scanOrderCreateToken" = ${token}
      AND "scanOrderCreateTokenConsumedAt" IS NULL
      AND "scanOrderCreateTokenExpiresAt" > NOW()
    ORDER BY "id" DESC
    LIMIT 1
  `;
  return rows[0] || null;
}

function persistedRowToTicket(row: PersistedScanOrderTicketRow): ScanOrderTicket {
  const expiresAt = toIso(row.resultExpiresAt) || toIso(row.scanOrderCreateTokenExpiresAt);
  if (!row.credentialEncrypted || !row.resultQrImageUrl || !row.resultUpiUri || !row.resultPaymentUrl || !expiresAt) {
    throw new Error("Scan order publish token data is incomplete. Please extract a new QR code.");
  }
  return {
    token: row.token || "",
    jobId: row.jobId,
    credential: decryptSessionCredential(row.credentialEncrypted),
    qrImageUrl: row.resultQrImageUrl,
    upiUri: row.resultUpiUri,
    paymentUrl: row.resultPaymentUrl,
    expiresAt,
    publicUserTelegramId: row.publicUserTelegramId || "",
    publicUserTelegramName: row.publicUserTelegramName || null,
    channel: row.channel === "premium" ? "premium" : "public",
    createdAt: Date.now(),
    consumedAt: row.scanOrderCreateTokenConsumedAt ? Date.now() : undefined,
    orderId: row.scanOrderId || undefined,
  };
}

async function transferLatestReservedScanOrderFreeze(
  tx: Prisma.TransactionClient,
  input: {
    telegramUserId: string;
    jobId: string;
    orderId: string;
  }
) {
  const rows = await tx.$queryRaw<Array<{ migratedCount: bigint | number | null }>>`
    WITH candidate AS (
      SELECT l."id"
      FROM "public_user_wallet_ledgers" l
      WHERE l."telegramUserId" = ${input.telegramUserId}
        AND l."orderId" = ${input.jobId}
        AND l."type" = 'SCAN_ORDER_FREEZE'
        AND NOT EXISTS (
          SELECT 1
          FROM "public_user_wallet_ledgers" terminal
          WHERE terminal."telegramUserId" = l."telegramUserId"
            AND terminal."orderId" = l."orderId"
            AND terminal."type" IN ('SCAN_ORDER_REFUND', 'SCAN_ORDER_SPEND')
            AND terminal."createdAt" >= l."createdAt"
        )
      ORDER BY l."createdAt" DESC, l."id" DESC
      LIMIT 1
    ),
    moved AS (
      UPDATE "public_user_wallet_ledgers" l
      SET "orderId" = ${input.orderId},
          "referenceId" = COALESCE(l."referenceId", ${`auto_publish:${input.jobId}`})
      WHERE l."id" IN (SELECT "id" FROM candidate)
      RETURNING l."id"
    )
    SELECT COUNT(*)::int AS "migratedCount"
    FROM moved
  `;
  return Number(rows[0]?.migratedCount ?? 0);
}

async function createPublicScanOrderFromTicketData(input: {
  token?: string;
  jobId: string;
  credential: string;
  qrImageUrl: string;
  upiUri: string;
  paymentUrl: string;
  expiresAt: string;
  publicUserTelegramId: string;
  publicUserTelegramName?: string | null;
  channel: "public" | "premium";
}) {
  const expiresAt = new Date(input.expiresAt);
  const remainingMs = expiresAt.getTime() - Date.now();
  if (!Number.isFinite(expiresAt.getTime()) || remainingMs <= 0) {
    throw new Error("The QR code has expired. Please extract a new QR code before publishing a scan order.");
  }
  if (remainingMs <= MIN_SCAN_ORDER_QR_REMAINING_MS) {
    throw new Error("The QR code has less than 1 minute remaining. Please extract a new QR code before publishing a scan order.");
  }

  await ensurePublicUpiExtractReservationColumns();
  const order = await prisma.$transaction(
    async (tx) => {
      const reservationRows = await tx.$queryRaw<Array<{
        scanOrderId: string | null;
        scanOrderFundsReserved: boolean | null;
        scanOrderFundsReleasedAt: Date | null;
        scanOrderFundsTransferredAt: Date | null;
      }>>`
        SELECT
          "scanOrderId",
          "scanOrderFundsReserved",
          "scanOrderFundsReleasedAt",
          "scanOrderFundsTransferredAt"
        FROM "public_upi_extract_activities"
        WHERE "jobId" = ${input.jobId}
          AND "publicUserTelegramId" = ${input.publicUserTelegramId}
        FOR UPDATE
      `;
      const reservation = reservationRows[0] || null;
      const useReservedFunds = Boolean(
        reservation?.scanOrderFundsReserved &&
        !reservation.scanOrderFundsReleasedAt &&
        !reservation.scanOrderFundsTransferredAt &&
        !reservation.scanOrderId
      );

      const created = await tx.order.create({
        data: {
          orderNo: makeOrderNo(),
          source: "PUBLIC_SCAN",
          cdkId: null,
          publicUserTelegramId: input.publicUserTelegramId,
          publicUserTelegramName: input.publicUserTelegramName || null,
          scanPrice: PUBLIC_SCAN_ORDER_PRICE,
          qrImageUrl: input.qrImageUrl,
          qrDecodedText: input.upiUri,
          qrIsUpi: true,
          paymentUrl: input.paymentUrl,
          sessionCredentialEncrypted: encryptSessionCredential(input.credential),
          sessionCredentialHash: hashSessionCredential(input.credential),
          upiExtractionStatus: "READY",
          upiExtractedAt: new Date(),
          upiExpiresAt: expiresAt,
          customerNote: `UPI Extract ${input.channel}`,
        },
        include: orderInclude,
      });

      if (useReservedFunds) {
        await tx.$executeRaw`
          UPDATE "public_upi_extract_activities"
          SET "scanOrderId" = ${created.id},
              "scanOrderFundsTransferredAt" = NOW(),
              "updatedAt" = NOW()
          WHERE "jobId" = ${input.jobId}
            AND "publicUserTelegramId" = ${input.publicUserTelegramId}
        `;
        const migratedCount = await transferLatestReservedScanOrderFreeze(tx, {
          telegramUserId: input.publicUserTelegramId,
          jobId: input.jobId,
          orderId: created.id,
        });
        if (migratedCount <= 0) {
          const frozen = await freezePublicScanOrderFunds(tx, {
            telegramUserId: input.publicUserTelegramId,
            telegramUsername: input.publicUserTelegramName || null,
          }, {
            orderId: created.id,
            referenceId: input.jobId,
            amount: PUBLIC_SCAN_ORDER_PRICE,
            note: "Publish UPI scan order",
          });
          if (!frozen) throw new Error("Failed to reserve scan order funds for the created order.");
        }
      } else {
        await freezePublicScanOrderFunds(tx, {
          telegramUserId: input.publicUserTelegramId,
          telegramUsername: input.publicUserTelegramName || null,
        }, {
          orderId: created.id,
          referenceId: input.jobId,
          amount: PUBLIC_SCAN_ORDER_PRICE,
          note: "Publish UPI scan order",
        });
      }

      return created as OrderWithRelations;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );

  if (input.token) {
    await persistConsumedTicket(input.token, order.id);
  }

  return { order, jobId: input.jobId };
}

export function createPublicScanOrderTicket(input: Omit<ScanOrderTicket, "token" | "createdAt">) {
  cleanupTickets();
  const token = randomUUID();
  tickets.set(token, {
    ...input,
    token,
    createdAt: Date.now(),
  });
  return token;
}

export async function createPublicScanOrderFromTicket(input: {
  token: string;
  telegramUserId: string;
  telegramUsername?: string | null;
}) {
  cleanupTickets();
  const token = String(input.token || "").trim();
  const ticket = token ? tickets.get(token) : null;
  const persistedTicket = ticket ? null : token ? await findPersistedTicket(token) : null;
  const effectiveTicket = ticket || (persistedTicket ? persistedRowToTicket(persistedTicket) : null);
  if (!effectiveTicket) throw new Error("The QR publish token does not exist or has expired. Please extract a new QR code.");
  if (effectiveTicket.consumedAt || effectiveTicket.orderId) throw new Error("This QR code has already been published as a scan order.");
  if (effectiveTicket.publicUserTelegramId !== input.telegramUserId) {
    throw new Error("You can only publish QR codes extracted from your own account.");
  }

  const result = await createPublicScanOrderFromTicketData({
    token,
    jobId: effectiveTicket.jobId,
    credential: effectiveTicket.credential,
    qrImageUrl: effectiveTicket.qrImageUrl,
    upiUri: effectiveTicket.upiUri,
    paymentUrl: effectiveTicket.paymentUrl,
    expiresAt: effectiveTicket.expiresAt,
    publicUserTelegramId: input.telegramUserId,
    publicUserTelegramName: input.telegramUsername || effectiveTicket.publicUserTelegramName || null,
    channel: effectiveTicket.channel,
  });

  tickets.set(token, {
    ...effectiveTicket,
    consumedAt: Date.now(),
    orderId: result.order.id,
  });
  cleanupTickets();

  return result;
}
