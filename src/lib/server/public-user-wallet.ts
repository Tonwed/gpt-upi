import { HDNodeWallet, getAddress, isAddress } from "ethers";
import { Prisma, PublicUserWalletLedgerType } from "@prisma/client";
import { normalizeCdkCode } from "@/lib/cdk-code";
import { prisma } from "@/lib/server/prisma";
import {
  getPublicUserPremiumPurchaseInfo,
  getPublicUserPremiumStatus,
  publicUserPremiumSettingKey,
} from "@/lib/server/public-user-premium";
import { decimalToNumber } from "@/lib/server/serializers";

export const PUBLIC_SCAN_ORDER_PRICE = 0.6;
export const PUBLIC_USER_WITHDRAWAL_FEE = 0.01;
export const PUBLIC_USER_MIN_WITHDRAWAL_AMOUNT = 1.5;
export const PUBLIC_USER_DEPOSIT_ORDER_TTL_MS = 20 * 60 * 1000;
export const PUBLIC_USER_DEPOSIT_ORDER_BASE_AMOUNTS = [1.8, 5, 10] as const;

function formatCompactUsdt(value: number) {
  const amount = Number.isFinite(Number(value)) ? Math.abs(Number(value)) : 0;
  return `${amount.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 6 })} USDT`;
}

export type PublicUserWalletSummary = {
  availableBalance: number;
  frozenBalance: number;
  totalDeposited: number;
  totalSpent: number;
};

export type PublicUserDepositAddressInfo = {
  configured: boolean;
  network: "BSC";
  chainId: 56;
  tokenSymbol: "USDT";
  tokenContract: string;
  confirmations: number;
  address?: string;
  message?: string;
};

export type PublicUserDepositOrderInfo = {
  id: string;
  orderNo: string;
  baseAmount: number;
  payAmount: number;
  status: "PENDING" | "PAID" | "EXPIRED" | "CANCELLED";
  chain: string;
  tokenSymbol: string;
  depositAddress: string;
  txHash?: string | null;
  fromAddress?: string | null;
  blockNumber?: number | null;
  confirmations?: number | null;
  expiresAt: Date;
  paidAt?: Date | null;
  createdAt: Date;
};

export type PublicUserWithdrawalSummary = {
  id: string;
  amount: number;
  fee: number;
  totalFrozen: number;
  status: "PENDING" | "PAID" | "REJECTED" | "CANCELLED";
  chain: string;
  tokenSymbol: string;
  withdrawalAddress: string;
  requestedAt: Date;
  processedAt?: Date | null;
};

export type PublicUserWalletHistoryItem = {
  id: string;
  type: string;
  availableDelta: number;
  frozenDelta: number;
  orderId?: string | null;
  referenceId?: string | null;
  note?: string | null;
  createdAt: Date;
  withdrawal?: PublicUserWithdrawalSummary | null;
};

export type PublicUserCdkRedeemResult = {
  amount: number;
  code: string;
  wallet: PublicUserWalletSummary;
};

type PublicUserIdentity = {
  telegramUserId: string;
  telegramUsername?: string | null;
};

type Tx = Prisma.TransactionClient;

function money(value: number) {
  return Number(value.toFixed(6));
}

function decimal(value: number | string | Prisma.Decimal) {
  return new Prisma.Decimal(value);
}

function capScanOrderFrozenMovementAmount(walletFrozenBalance: number | string | Prisma.Decimal, outstandingFrozen: Prisma.Decimal, requestedAmount: Prisma.Decimal) {
  if (outstandingFrozen.lte(0) || requestedAmount.lte(0)) return null;
  const walletFrozen = decimal(walletFrozenBalance);
  if (walletFrozen.lte(0)) return null;

  let amount = requestedAmount;
  if (outstandingFrozen.lt(amount)) amount = outstandingFrozen;
  if (walletFrozen.lt(amount)) amount = walletFrozen;
  return amount.gt(0) ? amount : null;
}

export function getBscRpcUrl() {
  return process.env.BSC_RPC_URL || "https://bsc-rpc.publicnode.com";
}

export function getBscUsdtContract() {
  return process.env.BSC_USDT_CONTRACT || "0x55d398326f99059fF775485246999027B3197955";
}

export function getBscDepositConfirmations() {
  const value = Math.floor(Number(process.env.BSC_DEPOSIT_CONFIRMATIONS || 20));
  return Number.isFinite(value) && value >= 1 ? value : 20;
}

function getDepositMnemonic() {
  return String(process.env.BSC_DEPOSIT_MNEMONIC || "").trim();
}

export function getUnifiedBscDepositAddress() {
  if (!getDepositMnemonic()) return "";
  return deriveBscDepositAddress(0);
}

export function isUnifiedBscDepositConfigured() {
  return Boolean(getUnifiedBscDepositAddress());
}

export function isBscDepositConfigured() {
  const mnemonic = getDepositMnemonic();
  return Boolean(mnemonic);
}

function deriveBscDepositAddress(index: number) {
  const mnemonic = getDepositMnemonic();
  if (!mnemonic) {
    throw new Error("BSC_DEPOSIT_MNEMONIC is not configured");
  }
  const wallet = HDNodeWallet.fromPhrase(mnemonic, undefined, `m/44'/60'/0'/0/${index}`);
  if (!isAddress(wallet.address)) throw new Error("Failed to derive a valid BSC deposit address");
  return wallet.address;
}

function toSummary(wallet: {
  availableBalance: Prisma.Decimal | number | string;
  frozenBalance: Prisma.Decimal | number | string;
  totalDeposited: Prisma.Decimal | number | string;
  totalSpent: Prisma.Decimal | number | string;
}): PublicUserWalletSummary {
  return {
    availableBalance: money(decimalToNumber(wallet.availableBalance)),
    frozenBalance: money(decimalToNumber(wallet.frozenBalance)),
    totalDeposited: money(decimalToNumber(wallet.totalDeposited)),
    totalSpent: money(decimalToNumber(wallet.totalSpent)),
  };
}

function toDepositOrderInfo(order: {
  id: string;
  orderNo: string;
  baseAmount: Prisma.Decimal | number | string;
  payAmount: Prisma.Decimal | number | string;
  status: "PENDING" | "PAID" | "EXPIRED" | "CANCELLED";
  chain: string;
  tokenSymbol: string;
  depositAddress: string;
  txHash?: string | null;
  fromAddress?: string | null;
  blockNumber?: number | null;
  confirmations?: number | null;
  expiresAt: Date;
  paidAt?: Date | null;
  createdAt: Date;
}): PublicUserDepositOrderInfo {
  return {
    id: order.id,
    orderNo: order.orderNo,
    baseAmount: Number(decimalToNumber(order.baseAmount).toFixed(2)),
    payAmount: Number(decimalToNumber(order.payAmount).toFixed(2)),
    status: order.status,
    chain: order.chain,
    tokenSymbol: order.tokenSymbol,
    depositAddress: order.depositAddress,
    txHash: order.txHash ?? null,
    fromAddress: order.fromAddress ?? null,
    blockNumber: order.blockNumber ?? null,
    confirmations: order.confirmations ?? null,
    expiresAt: order.expiresAt,
    paidAt: order.paidAt ?? null,
    createdAt: order.createdAt,
  };
}

export async function getOrCreatePublicUserWallet(
  user: PublicUserIdentity,
  tx: Tx = prisma
) {
  try {
    return await tx.publicUserWallet.upsert({
      where: { telegramUserId: user.telegramUserId },
      update: {
        telegramUsername: user.telegramUsername || undefined,
      },
      create: {
        telegramUserId: user.telegramUserId,
        telegramUsername: user.telegramUsername || null,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return tx.publicUserWallet.update({
        where: { telegramUserId: user.telegramUserId },
        data: { telegramUsername: user.telegramUsername || undefined },
      });
    }
    throw error;
  }
}

export async function getPublicUserWalletSummary(user: PublicUserIdentity) {
  const wallet = await getOrCreatePublicUserWallet(user);
  return toSummary(wallet);
}

export function getPublicUnifiedDepositInfo(): PublicUserDepositAddressInfo {
  const tokenContract = getBscUsdtContract();
  const baseInfo = {
    configured: false,
    network: "BSC" as const,
    chainId: 56 as const,
    tokenSymbol: "USDT" as const,
    tokenContract,
    confirmations: getBscDepositConfirmations(),
  };

  try {
    const address = getUnifiedBscDepositAddress();
    if (!address) {
      return {
        ...baseInfo,
        message: "BSC unified deposit address is not configured.",
      };
    }
    return {
      ...baseInfo,
      configured: true,
      address,
    };
  } catch (error) {
    return {
      ...baseInfo,
      message: error instanceof Error ? error.message : "BSC unified deposit address is not available.",
    };
  }
}

export async function getPublicUserDepositAddress(user: PublicUserIdentity): Promise<PublicUserDepositAddressInfo> {
  const tokenContract = getBscUsdtContract();
  const baseInfo = {
    configured: false,
    network: "BSC" as const,
    chainId: 56 as const,
    tokenSymbol: "USDT" as const,
    tokenContract,
    confirmations: getBscDepositConfirmations(),
  };

  if (!isBscDepositConfigured()) {
    return {
      ...baseInfo,
      message: "BSC deposit wallet is not configured.",
    };
  }

  const existing = await prisma.publicUserDepositAddress.findUnique({
    where: { telegramUserId: user.telegramUserId },
  });
  if (existing) {
    if (existing.telegramUsername !== (user.telegramUsername || null)) {
      await prisma.publicUserDepositAddress.update({
        where: { id: existing.id },
        data: { telegramUsername: user.telegramUsername || null },
      }).catch(() => undefined);
    }
    return {
      ...baseInfo,
      configured: true,
      address: existing.address,
    };
  }

  const created = await prisma.$transaction(
    async (tx) => {
      await getOrCreatePublicUserWallet(user, tx);
      await tx.systemSetting.upsert({
        where: { key: "bsc_deposit_next_derivation_index" },
        update: {},
        create: { key: "bsc_deposit_next_derivation_index", value: "0" },
      });
      const rows = await tx.$queryRaw<Array<{ value: string }>>`
        SELECT "value"
        FROM "system_settings"
        WHERE "key" = 'bsc_deposit_next_derivation_index'
        FOR UPDATE
      `;
      const index = Math.max(0, Math.floor(Number(rows[0]?.value || 0)));
      const address = deriveBscDepositAddress(index);
      const addressRow = await tx.publicUserDepositAddress.create({
        data: {
          telegramUserId: user.telegramUserId,
          telegramUsername: user.telegramUsername || null,
          chain: "BSC",
          address,
          derivationIndex: index,
        },
      });
      await tx.systemSetting.update({
        where: { key: "bsc_deposit_next_derivation_index" },
        data: { value: String(index + 1) },
      });
      return addressRow;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  ).catch((error) => {
    console.error("Failed to create BSC deposit address", error);
    return null;
  });

  if (!created) {
    return {
      ...baseInfo,
      message: "BSC deposit wallet is not available.",
    };
  }

  return {
    ...baseInfo,
    configured: true,
    address: created.address,
  };
}

async function lockWallet(tx: Tx, telegramUserId: string) {
  const rows = await tx.$queryRaw<Array<{
    id: string;
    telegramUserId: string;
    availableBalance: Prisma.Decimal;
    frozenBalance: Prisma.Decimal;
    totalDeposited: Prisma.Decimal;
    totalSpent: Prisma.Decimal;
  }>>`
    SELECT
      "id",
      "telegramUserId",
      "availableBalance",
      "frozenBalance",
      "totalDeposited",
      "totalSpent"
    FROM "public_user_wallets"
    WHERE "telegramUserId" = ${telegramUserId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

async function getPublicScanOrderWalletMovement(tx: Tx, input: { telegramUserId: string; orderId: string }) {
  const rows = await tx.$queryRaw<Array<{
    frozenDelta: Prisma.Decimal | null;
    terminalCount: bigint | number | null;
  }>>`
    SELECT
      COALESCE(SUM("frozenDelta"), 0) AS "frozenDelta",
      COUNT(*) FILTER (
        WHERE "type" IN ('SCAN_ORDER_REFUND', 'SCAN_ORDER_SPEND')
      ) AS "terminalCount"
    FROM "public_user_wallet_ledgers"
    WHERE "telegramUserId" = ${input.telegramUserId}
      AND "orderId" = ${input.orderId}
      AND "type" IN ('SCAN_ORDER_FREEZE', 'SCAN_ORDER_REFUND', 'SCAN_ORDER_SPEND')
  `;
  const row = rows[0];
  return {
    outstandingFrozen: decimal(row?.frozenDelta ?? 0),
    terminalCount: Number(row?.terminalCount ?? 0),
  };
}

async function attachLatestPublicScanOrderReservationFreeze(
  tx: Tx,
  input: { telegramUserId: string; orderId: string }
) {
  const rows = await tx.$queryRaw<Array<{ migratedCount: bigint | number | null }>>`
    WITH activity AS (
      SELECT "jobId"
      FROM "public_upi_extract_activities"
      WHERE "scanOrderId" = ${input.orderId}
        AND "publicUserTelegramId" = ${input.telegramUserId}
      ORDER BY "updatedAt" DESC NULLS LAST, "id" DESC
      LIMIT 1
    ),
    candidate AS (
      SELECT l."id"
      FROM "public_user_wallet_ledgers" l
      INNER JOIN activity a ON a."jobId" = l."orderId"
      WHERE l."telegramUserId" = ${input.telegramUserId}
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
          "referenceId" = COALESCE(l."referenceId", (
            SELECT CONCAT('auto_publish:', "jobId")
            FROM activity
          ))
      WHERE l."id" IN (SELECT "id" FROM candidate)
      RETURNING l."id"
    )
    SELECT COUNT(*)::int AS "migratedCount"
    FROM moved
  `;
  return Number(rows[0]?.migratedCount ?? 0) > 0;
}

async function lockRechargeCdk(tx: Tx, code: string) {
  const rows = await tx.$queryRaw<Array<{
    id: string;
    code: string;
    amount: Prisma.Decimal;
    usedCount: number;
    status: "ACTIVE" | "DISABLED" | "EXPIRED";
    expiresAt: Date | null;
    redeemedAt: Date | null;
  }>>`
    SELECT
      "id",
      "code",
      "amount",
      "usedCount",
      "status",
      "expiresAt",
      "redeemedAt"
    FROM "cdks"
    WHERE "code" = ${code}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

export async function redeemRechargeCdk(
  user: PublicUserIdentity,
  input: { code: unknown }
): Promise<PublicUserCdkRedeemResult> {
  const code = normalizeCdkCode(String(input.code || ""));
  if (!code) throw new Error("请输入 CDK。");

  return prisma.$transaction(
    async (tx) => {
      await getOrCreatePublicUserWallet(user, tx);
      const wallet = await lockWallet(tx, user.telegramUserId);
      if (!wallet) throw new Error("用户钱包不存在，请重新登录后再试。");

      const cdk = await lockRechargeCdk(tx, code);
      if (!cdk) throw new Error("CDK 不存在。");
      if (cdk.status !== "ACTIVE") throw new Error("CDK 已停用或不可用。");
      if (cdk.expiresAt && cdk.expiresAt.getTime() <= Date.now()) throw new Error("CDK 已过期。");
      if (cdk.redeemedAt || cdk.usedCount > 0) throw new Error("CDK 已被兑换。");

      const amount = decimal(cdk.amount);
      if (amount.lte(0)) throw new Error("该 CDK 没有配置充值金额，请联系管理员。");

      await tx.cdk.update({
        where: { id: cdk.id },
        data: {
          usedCount: { increment: 1 },
          redeemedByTelegramId: user.telegramUserId,
          redeemedByTelegramName: user.telegramUsername ? `@${user.telegramUsername}` : null,
          redeemedAt: new Date(),
        },
      });

      const updatedWallet = await tx.publicUserWallet.update({
        where: { id: wallet.id },
        data: {
          telegramUsername: user.telegramUsername || undefined,
          availableBalance: { increment: amount },
          totalDeposited: { increment: amount },
        },
      });

      await tx.publicUserWalletLedger.create({
        data: {
          walletId: wallet.id,
          telegramUserId: user.telegramUserId,
          type: PublicUserWalletLedgerType.CDK_REDEEM,
          availableDelta: amount,
          frozenDelta: 0,
          referenceId: `cdk:${cdk.id}`,
          note: `Recharge CDK ${cdk.code}`,
        },
      });

      return {
        code: cdk.code,
        amount: money(decimalToNumber(amount)),
        wallet: toSummary(updatedWallet),
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}


export function parsePublicUserWithdrawalAmount(value: unknown) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return money(amount);
}

function parseDepositBaseAmount(value: unknown) {
  const amount = Number(value);
  if (!PUBLIC_USER_DEPOSIT_ORDER_BASE_AMOUNTS.some((item) => Math.round(item * 100) === Math.round(amount * 100))) return null;
  return amount as typeof PUBLIC_USER_DEPOSIT_ORDER_BASE_AMOUNTS[number];
}

function centsToDecimal(cents: number) {
  return new Prisma.Decimal(cents).div(100).toDecimalPlaces(2);
}

function decimalToCents(value: Prisma.Decimal | number | string) {
  return Math.round(decimalToNumber(value) * 100);
}

function makeDepositOrderNo(now = new Date()) {
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("");
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `DEP-${date}-${suffix}`;
}

async function ensureDepositAmountAllocationLock(tx: Tx) {
  await tx.systemSetting.upsert({
    where: { key: "public_user_deposit_order_amount_lock" },
    update: {},
    create: { key: "public_user_deposit_order_amount_lock", value: "1" },
  });
  await tx.$queryRaw<Array<{ key: string }>>`
    SELECT "key"
    FROM "system_settings"
    WHERE "key" = 'public_user_deposit_order_amount_lock'
    FOR UPDATE
  `;
}

export async function expirePublicUserDepositOrders(tx: Tx = prisma, now = new Date()) {
  return tx.publicUserDepositOrder.updateMany({
    where: {
      status: "PENDING",
      expiresAt: { lt: now },
    },
    data: { status: "EXPIRED" },
  });
}

export async function getLatestPublicUserDepositOrder(user: PublicUserIdentity): Promise<PublicUserDepositOrderInfo | null> {
  await expirePublicUserDepositOrders();
  const order = await prisma.publicUserDepositOrder.findFirst({
    where: { telegramUserId: user.telegramUserId },
    orderBy: { createdAt: "desc" },
  });
  return order ? toDepositOrderInfo(order) : null;
}

export async function createPublicUserDepositOrder(
  user: PublicUserIdentity,
  input: { baseAmount: unknown }
): Promise<PublicUserDepositOrderInfo> {
  const baseAmount = parseDepositBaseAmount(input.baseAmount);
  if (!baseAmount) throw new Error("Please choose a valid deposit amount.");

  const depositAddress = getUnifiedBscDepositAddress();
  if (!depositAddress) throw new Error("The unified BSC deposit address is not configured yet. Please try again later.");

  const now = new Date();
  const expiresAt = new Date(now.getTime() + PUBLIC_USER_DEPOSIT_ORDER_TTL_MS);
  const order = await prisma.$transaction(
    async (tx) => {
      await ensureDepositAmountAllocationLock(tx);
      await expirePublicUserDepositOrders(tx, now);
      const wallet = await getOrCreatePublicUserWallet(user, tx);
      const activeOrders = await tx.publicUserDepositOrder.findMany({
        where: {
          status: "PENDING",
          expiresAt: { gt: now },
        },
        select: { payAmount: true },
      });
      const occupied = new Set(activeOrders.map((item) => decimalToCents(item.payAmount)));
      let payCents = Math.round(baseAmount * 100);
      while (occupied.has(payCents)) payCents += 1;

      return tx.publicUserDepositOrder.create({
        data: {
          orderNo: makeDepositOrderNo(now),
          walletId: wallet.id,
          telegramUserId: user.telegramUserId,
          telegramUsername: user.telegramUsername || null,
          baseAmount: centsToDecimal(Math.round(baseAmount * 100)),
          payAmount: centsToDecimal(payCents),
          chain: "BSC",
          tokenSymbol: "USDT",
          depositAddress,
          expiresAt,
        },
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );

  return toDepositOrderInfo(order);
}

export async function getPublicUserWalletHistory(user: PublicUserIdentity, take = 50): Promise<PublicUserWalletHistoryItem[]> {
  await getOrCreatePublicUserWallet(user);
  const ledgers = await prisma.publicUserWalletLedger.findMany({
    where: { telegramUserId: user.telegramUserId },
    orderBy: { createdAt: "desc" },
    take,
    select: {
      id: true,
      type: true,
      availableDelta: true,
      frozenDelta: true,
      orderId: true,
      referenceId: true,
      note: true,
      createdAt: true,
    },
  });

  const withdrawalIds = ledgers
    .map((item) => item.referenceId)
    .filter((value): value is string => Boolean(value && value.startsWith("pub_withdrawal:")))
    .map((value) => value.replace(/^pub_withdrawal:/, ""));
  const withdrawals = withdrawalIds.length > 0
    ? await prisma.publicUserWithdrawalRequest.findMany({
      where: { id: { in: withdrawalIds }, telegramUserId: user.telegramUserId },
      select: {
        id: true,
        amount: true,
        fee: true,
        totalFrozen: true,
        status: true,
        chain: true,
        tokenSymbol: true,
        withdrawalAddress: true,
        requestedAt: true,
        processedAt: true,
      },
    })
    : [];
  const withdrawalMap = new Map(withdrawals.map((item) => [item.id, item]));

  return ledgers.map((item) => {
    const withdrawalId = item.referenceId?.startsWith("pub_withdrawal:") ? item.referenceId.replace(/^pub_withdrawal:/, "") : null;
    const withdrawal = withdrawalId ? withdrawalMap.get(withdrawalId) : null;
    return {
      id: item.id,
      type: item.type,
      availableDelta: money(decimalToNumber(item.availableDelta)),
      frozenDelta: money(decimalToNumber(item.frozenDelta)),
      orderId: item.orderId,
      referenceId: item.referenceId,
      note: item.note,
      createdAt: item.createdAt,
      withdrawal: withdrawal ? {
        id: withdrawal.id,
        amount: money(decimalToNumber(withdrawal.amount)),
        fee: money(decimalToNumber(withdrawal.fee)),
        totalFrozen: money(decimalToNumber(withdrawal.totalFrozen)),
        status: withdrawal.status,
        chain: withdrawal.chain,
        tokenSymbol: withdrawal.tokenSymbol,
        withdrawalAddress: withdrawal.withdrawalAddress,
        requestedAt: withdrawal.requestedAt,
        processedAt: withdrawal.processedAt,
      } : null,
    };
  });
}

export async function createPublicUserWithdrawalRequest(
  user: PublicUserIdentity,
  input: {
    amount: number;
    withdrawalAddress: string;
    note?: string | null;
  }
): Promise<PublicUserWithdrawalSummary> {
  const amount = decimal(input.amount);
  const fee = decimal(PUBLIC_USER_WITHDRAWAL_FEE);
  const totalFrozen = amount.add(fee);
  const withdrawalAddress = String(input.withdrawalAddress || "").trim();

  if (amount.lte(0)) throw new Error("\u8bf7\u8f93\u5165\u6b63\u786e\u7684\u63d0\u73b0\u91d1\u989d\u3002");
  if (amount.lt(PUBLIC_USER_MIN_WITHDRAWAL_AMOUNT)) {
    throw new Error(`最低提现金额为 ${PUBLIC_USER_MIN_WITHDRAWAL_AMOUNT.toFixed(2)} USDT。`);
  }
  if (!isAddress(withdrawalAddress)) throw new Error("\u8bf7\u8f93\u5165\u6b63\u786e\u7684 BEP20 / BSC \u63d0\u73b0\u5730\u5740\u3002");

  const withdrawal = await prisma.$transaction(
    async (tx) => {
      await getOrCreatePublicUserWallet(user, tx);
      const wallet = await lockWallet(tx, user.telegramUserId);
      if (!wallet) throw new Error("\u7528\u6237\u94b1\u5305\u4e0d\u5b58\u5728\uff0c\u8bf7\u91cd\u65b0\u767b\u5f55\u540e\u518d\u8bd5\u3002");
      if (wallet.availableBalance.lessThan(totalFrozen)) {
        throw new Error(`\u4f59\u989d\u4e0d\u8db3\uff0c\u63d0\u73b0\u91d1\u989d\u548c\u624b\u7eed\u8d39\u5408\u8ba1\u9700\u8981 ${totalFrozen.toFixed(2)} USDT\u3002`);
      }

      const withdrawal = await tx.publicUserWithdrawalRequest.create({
        data: {
          walletId: wallet.id,
          telegramUserId: user.telegramUserId,
          telegramUsername: user.telegramUsername || null,
          amount,
          fee,
          totalFrozen,
          withdrawalAddress,
          note: input.note || null,
        },
      });

      await tx.publicUserWallet.update({
        where: { id: wallet.id },
        data: {
          telegramUsername: user.telegramUsername || undefined,
          availableBalance: { decrement: totalFrozen },
          frozenBalance: { increment: totalFrozen },
        },
      });
      await tx.publicUserWalletLedger.create({
        data: {
          walletId: wallet.id,
          telegramUserId: user.telegramUserId,
          type: PublicUserWalletLedgerType.WITHDRAWAL_FREEZE,
          availableDelta: totalFrozen.negated(),
          frozenDelta: totalFrozen,
          referenceId: `pub_withdrawal:${withdrawal.id}`,
          note: input.note || "\u63d0\u73b0\u7533\u8bf7\u51bb\u7ed3",
        },
      });

      return withdrawal;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );

  return {
    id: withdrawal.id,
    amount: money(decimalToNumber(withdrawal.amount)),
    fee: money(decimalToNumber(withdrawal.fee)),
    totalFrozen: money(decimalToNumber(withdrawal.totalFrozen)),
    status: withdrawal.status,
    chain: withdrawal.chain,
    tokenSymbol: withdrawal.tokenSymbol,
    withdrawalAddress: withdrawal.withdrawalAddress,
    requestedAt: withdrawal.requestedAt,
    processedAt: withdrawal.processedAt,
  };
}

export async function purchasePublicUserLifetimePremium(user: PublicUserIdentity) {
  const currentPremium = await getPublicUserPremiumStatus(user);
  if (currentPremium.isPremium && !currentPremium.premiumUntil) {
    throw new Error("Premium is already lifetime for this account.");
  }

  const premiumPurchase = await getPublicUserPremiumPurchaseInfo();
  if (!premiumPurchase.saleEnabled) {
    throw new Error("Premium sale is currently disabled.");
  }

  const amount = decimal(premiumPurchase.purchasePrice);
  const now = new Date();
  const premiumKey = publicUserPremiumSettingKey(user.telegramUserId);
  await prisma.$transaction(
    async (tx) => {
      await getOrCreatePublicUserWallet(user, tx);
      const wallet = await lockWallet(tx, user.telegramUserId);
      if (!wallet) throw new Error("用户钱包不存在，请重新登录后再试。");
      await tx.systemSetting.upsert({
        where: { key: premiumKey },
        update: {},
        create: { key: premiumKey, value: JSON.stringify({ enabled: false, premiumUntil: null, tier: "none" }) },
      });
      const premiumRows = await tx.$queryRaw<Array<{ key: string; value: string }>>`
        SELECT "key", "value"
        FROM "system_settings"
        WHERE "key" = ${premiumKey}
        FOR UPDATE
      `;
      const storedPremium = JSON.parse(premiumRows[0]?.value || "{}") as { enabled?: boolean; premiumUntil?: string | null; tier?: string | null };
      if (storedPremium.enabled === true && !storedPremium.premiumUntil) {
        throw new Error("Premium is already lifetime for this account.");
      }
      if (wallet.availableBalance.lessThan(amount)) {
        throw new Error(`余额不足，购买长期 Premium 需要 ${formatCompactUsdt(premiumPurchase.purchasePrice)}。`);
      }

      await tx.publicUserWallet.update({
        where: { id: wallet.id },
        data: {
          telegramUsername: user.telegramUsername || undefined,
          availableBalance: { decrement: amount },
          totalSpent: { increment: amount },
        },
      });
      await tx.publicUserWalletLedger.create({
        data: {
          walletId: wallet.id,
          telegramUserId: user.telegramUserId,
          type: PublicUserWalletLedgerType.ADMIN_ADJUSTMENT,
          availableDelta: amount.negated(),
          frozenDelta: 0,
          referenceId: `pub_premium_purchase:${now.getTime()}`,
          note: "Premium lifetime purchase",
        },
      });

      const premiumValue = JSON.stringify({
        enabled: true,
        premiumUntil: null,
        tier: "premium",
        updatedBy: "public_purchase",
        updatedAt: now.toISOString(),
      });
      await tx.systemSetting.update({
        where: { key: premiumKey },
        data: { value: premiumValue },
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );

  return getPublicUserPremiumStatus(user);
}

export async function assertPublicUserCanPayScanOrder(user: PublicUserIdentity) {
  const wallet = await getOrCreatePublicUserWallet(user);
  if (decimalToNumber(wallet.availableBalance) < PUBLIC_SCAN_ORDER_PRICE) {
    throw new Error(`\u4f59\u989d\u4e0d\u8db3\uff0c\u53d1\u5e03\u626b\u7801\u8ba2\u5355\u9700\u8981 ${PUBLIC_SCAN_ORDER_PRICE.toFixed(1)} USDT\u3002`);
  }
  return toSummary(wallet);
}

export async function freezePublicScanOrderFunds(
  tx: Tx,
  user: PublicUserIdentity,
  input: {
    orderId: string;
    referenceId?: string | null;
    amount?: number;
    note?: string;
    allowAdditionalHold?: boolean;
  }
) {
  await getOrCreatePublicUserWallet(user, tx);
  const wallet = await lockWallet(tx, user.telegramUserId);
  if (!wallet) throw new Error("\u7528\u6237\u94b1\u5305\u4e0d\u5b58\u5728\uff0c\u8bf7\u91cd\u65b0\u767b\u5f55\u540e\u518d\u8bd5\u3002");

  const amount = decimal(input.amount ?? PUBLIC_SCAN_ORDER_PRICE);
  const movement = await getPublicScanOrderWalletMovement(tx, {
    telegramUserId: user.telegramUserId,
    orderId: input.orderId,
  });
  if (!input.allowAdditionalHold && movement.outstandingFrozen.gt(0)) {
    return false;
  }
  if (wallet.availableBalance.lessThan(amount)) {
    throw new Error(`\u4f59\u989d\u4e0d\u8db3\uff0c\u53d1\u5e03\u626b\u7801\u8ba2\u5355\u9700\u8981 ${amount.toFixed(1)} USDT\u3002`);
  }

  await tx.publicUserWallet.update({
    where: { id: wallet.id },
    data: {
      telegramUsername: user.telegramUsername || undefined,
      availableBalance: { decrement: amount },
      frozenBalance: { increment: amount },
    },
  });
  await tx.publicUserWalletLedger.create({
    data: {
      walletId: wallet.id,
      telegramUserId: user.telegramUserId,
      type: PublicUserWalletLedgerType.SCAN_ORDER_FREEZE,
      availableDelta: amount.negated(),
      frozenDelta: amount,
      orderId: input.orderId,
      referenceId: input.referenceId || null,
      note: input.note || "\u53d1\u5e03\u626b\u7801\u8ba2\u5355\u51bb\u7ed3",
    },
  });
  return true;
}

export async function refundPublicScanOrderFunds(
  tx: Tx,
  input: {
    telegramUserId: string;
    orderId: string;
    amount?: number | Prisma.Decimal;
    note?: string;
  }
) {
  const wallet = await lockWallet(tx, input.telegramUserId);
  if (!wallet) return false;
  let amount = decimal(input.amount ?? PUBLIC_SCAN_ORDER_PRICE);
  if (amount.lte(0)) return false;
  let movement = await getPublicScanOrderWalletMovement(tx, input);
  if (movement.outstandingFrozen.lte(0)) {
    const migrated = await attachLatestPublicScanOrderReservationFreeze(tx, input);
    if (migrated) movement = await getPublicScanOrderWalletMovement(tx, input);
  }
  const cappedAmount = capScanOrderFrozenMovementAmount(wallet.frozenBalance, movement.outstandingFrozen, amount);
  if (!cappedAmount) return false;
  amount = cappedAmount;

  await tx.publicUserWallet.update({
    where: { id: wallet.id },
    data: {
      availableBalance: { increment: amount },
      frozenBalance: { decrement: amount },
    },
  });
  await tx.publicUserWalletLedger.create({
    data: {
      walletId: wallet.id,
      telegramUserId: input.telegramUserId,
      type: PublicUserWalletLedgerType.SCAN_ORDER_REFUND,
      availableDelta: amount,
      frozenDelta: amount.negated(),
      orderId: input.orderId,
      note: input.note || "\u626b\u7801\u8ba2\u5355\u9000\u56de\u51bb\u7ed3\u4f59\u989d",
    },
  });
  return true;
}

export async function spendPublicScanOrderFunds(
  tx: Tx,
  input: {
    telegramUserId: string;
    orderId: string;
    amount?: number | Prisma.Decimal;
    note?: string;
  }
) {
  const wallet = await lockWallet(tx, input.telegramUserId);
  if (!wallet) return false;
  let amount = decimal(input.amount ?? PUBLIC_SCAN_ORDER_PRICE);
  if (amount.lte(0)) return false;
  let movement = await getPublicScanOrderWalletMovement(tx, input);
  if (movement.outstandingFrozen.lte(0)) {
    const migrated = await attachLatestPublicScanOrderReservationFreeze(tx, input);
    if (migrated) movement = await getPublicScanOrderWalletMovement(tx, input);
  }
  const cappedAmount = capScanOrderFrozenMovementAmount(wallet.frozenBalance, movement.outstandingFrozen, amount);
  if (!cappedAmount) return false;
  amount = cappedAmount;

  await tx.publicUserWallet.update({
    where: { id: wallet.id },
    data: {
      frozenBalance: { decrement: amount },
      totalSpent: { increment: amount },
    },
  });
  await tx.publicUserWalletLedger.create({
    data: {
      walletId: wallet.id,
      telegramUserId: input.telegramUserId,
      type: PublicUserWalletLedgerType.SCAN_ORDER_SPEND,
      frozenDelta: amount.negated(),
      orderId: input.orderId,
      note: input.note || "\u626b\u7801\u8ba2\u5355\u5b8c\u6210\u6263\u6b3e",
    },
  });
  return true;
}

export async function creditPublicUserDepositOrder(
  tx: Tx,
  input: {
    txHash: string;
    logIndex: number;
    blockNumber: number;
    fromAddress: string;
    toAddress: string;
    tokenContract: string;
    amount: string | number | Prisma.Decimal;
    confirmations: number;
    paidAt: Date;
  }
) {
  const exists = await tx.publicChainDeposit.findUnique({
    where: { txHash_logIndex: { txHash: input.txHash, logIndex: input.logIndex } },
    select: { id: true },
  });
  if (exists) return { credited: false as const, reason: "duplicate" as const };

  const amount = decimal(input.amount);
  if (amount.lte(0)) return { credited: false as const, reason: "invalid_amount" as const };
  const roundedAmount = amount.toDecimalPlaces(2);
  if (!amount.equals(roundedAmount)) return { credited: false as const, reason: "amount_not_cent" as const };

  const normalizedToAddress = isAddress(input.toAddress) ? getAddress(input.toAddress) : input.toAddress;
  const order = await tx.publicUserDepositOrder.findFirst({
    where: {
      depositAddress: normalizedToAddress,
      payAmount: roundedAmount,
      status: { in: ["PENDING", "EXPIRED"] },
      createdAt: { lte: input.paidAt },
      expiresAt: { gte: input.paidAt },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!order) return { credited: false as const, reason: "no_matching_order" as const };

  const wallet = await lockWallet(tx, order.telegramUserId);
  if (!wallet) return { credited: false as const, reason: "wallet_missing" as const };

  await tx.publicChainDeposit.create({
    data: {
      telegramUserId: order.telegramUserId,
      telegramUsername: order.telegramUsername || null,
      chain: "BSC",
      tokenSymbol: "USDT",
      tokenContract: input.tokenContract,
      txHash: input.txHash,
      logIndex: input.logIndex,
      blockNumber: input.blockNumber,
      fromAddress: input.fromAddress,
      toAddress: normalizedToAddress,
      amount: roundedAmount,
      confirmations: input.confirmations,
      status: "CONFIRMED",
      creditedAt: new Date(),
    },
  });
  await tx.publicUserDepositOrder.update({
    where: { id: order.id },
    data: {
      status: "PAID",
      txHash: input.txHash,
      logIndex: input.logIndex,
      fromAddress: input.fromAddress,
      blockNumber: input.blockNumber,
      confirmations: input.confirmations,
      paidAt: input.paidAt,
    },
  });
  await tx.publicUserWallet.update({
    where: { id: wallet.id },
    data: {
      availableBalance: { increment: roundedAmount },
      totalDeposited: { increment: roundedAmount },
    },
  });
  await tx.publicUserWalletLedger.create({
    data: {
      walletId: wallet.id,
      telegramUserId: order.telegramUserId,
      type: PublicUserWalletLedgerType.CHAIN_DEPOSIT,
      availableDelta: roundedAmount,
      frozenDelta: 0,
      referenceId: `pub_deposit_order:${order.id}`,
      note: `BSC USDT deposit ${order.orderNo} from ${input.fromAddress}`,
    },
  });

  return { credited: true as const, orderNo: order.orderNo, telegramUserId: order.telegramUserId };
}

export async function creditPublicUserChainDeposit(
  tx: Tx,
  input: {
    telegramUserId: string;
    telegramUsername?: string | null;
    txHash: string;
    logIndex: number;
    blockNumber: number;
    fromAddress: string;
    toAddress: string;
    tokenContract: string;
    amount: string | number | Prisma.Decimal;
    confirmations: number;
  }
) {
  const exists = await tx.publicChainDeposit.findUnique({
    where: { txHash_logIndex: { txHash: input.txHash, logIndex: input.logIndex } },
    select: { id: true },
  });
  if (exists) return { credited: false as const, reason: "duplicate" as const };

  const amount = decimal(input.amount);
  if (amount.lte(0)) return { credited: false as const, reason: "invalid_amount" as const };

  const wallet = await getOrCreatePublicUserWallet({
    telegramUserId: input.telegramUserId,
    telegramUsername: input.telegramUsername,
  }, tx);

  await tx.publicChainDeposit.create({
    data: {
      telegramUserId: input.telegramUserId,
      telegramUsername: input.telegramUsername || null,
      chain: "BSC",
      tokenSymbol: "USDT",
      tokenContract: input.tokenContract,
      txHash: input.txHash,
      logIndex: input.logIndex,
      blockNumber: input.blockNumber,
      fromAddress: input.fromAddress,
      toAddress: input.toAddress,
      amount,
      confirmations: input.confirmations,
      status: "CONFIRMED",
      creditedAt: new Date(),
    },
  });
  await tx.publicUserWallet.update({
    where: { id: wallet.id },
    data: {
      telegramUsername: input.telegramUsername || undefined,
      availableBalance: { increment: amount },
      totalDeposited: { increment: amount },
    },
  });
  await tx.publicUserWalletLedger.create({
    data: {
      walletId: wallet.id,
      telegramUserId: input.telegramUserId,
      type: PublicUserWalletLedgerType.CHAIN_DEPOSIT,
      availableDelta: amount,
      frozenDelta: 0,
      referenceId: `${input.txHash}:${input.logIndex}`,
      note: `BSC USDT deposit from ${input.fromAddress}`,
    },
  });

  return { credited: true as const };
}

