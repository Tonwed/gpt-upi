import { formatUnits, getAddress, isAddress, JsonRpcProvider } from "ethers";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/server/prisma";
import {
  creditPublicUserChainDeposit,
  creditPublicUserDepositOrder,
  getBscDepositConfirmations,
  getBscRpcUrl,
  getBscUsdtContract,
  getUnifiedBscDepositAddress,
} from "@/lib/server/public-user-wallet";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const LAST_SCANNED_BLOCK_KEY = "bsc_deposit_last_scanned_block";
const DEFAULT_INITIAL_LOOKBACK_BLOCKS = 100;
const DEFAULT_SCAN_RANGE_BLOCKS = 100;
const DEFAULT_MAX_BACKFILL_BLOCKS = 50;
const DEFAULT_MIN_SCAN_RANGE_BLOCKS = 10;
const DEFAULT_ADDRESS_TOPIC_CHUNK = 1;
const DEFAULT_POLL_MS = 15_000;
const USDT_DECIMALS = 18;

type StoreGlobal = typeof globalThis & {
  __bscDepositWatcherStarted?: boolean;
  __bscDepositWatcherRunning?: boolean;
};

type DepositAddressRow = {
  telegramUserId: string;
  telegramUsername: string | null;
  address: string;
};

type ProviderLog = Awaited<ReturnType<JsonRpcProvider["getLogs"]>>[number];

type BscTransferLogQuery = {
  address: string;
  fromBlock: number;
  toBlock: number;
  topics: Array<string | string[] | null>;
};

function parsePositiveInt(value: string | undefined, fallback: number) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function redactRpcUrl(message: string) {
  const rpcUrl = getBscRpcUrl();
  return rpcUrl ? message.replaceAll(rpcUrl, "<REDACTED_RPC>") : message;
}

function isHistoricalLogError(error: unknown) {
  const message = redactRpcUrl(error instanceof Error ? `${error.name}: ${error.message}` : String(error)).toLowerCase();
  return (
    message.includes("archive, debug and trace requests are not available") ||
    message.includes("historical") ||
    message.includes("not available on your current plan")
  );
}

function isLogLimitError(error: unknown) {
  const message = redactRpcUrl(error instanceof Error ? `${error.name}: ${error.message}` : String(error)).toLowerCase();
  return (
    message.includes("limit exceeded") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("request timeout") ||
    message.includes("too many results") ||
    message.includes("response size exceeded")
  );
}

async function getLogsWithAdaptiveRange(
  provider: JsonRpcProvider,
  query: BscTransferLogQuery,
  options?: { minBlockSpan?: number }
): Promise<ProviderLog[]> {
  const minBlockSpan = Math.max(1, options?.minBlockSpan || 1);
  const fromBlock = Number(query.fromBlock);
  const toBlock = Number(query.toBlock);

  try {
    return await provider.getLogs({ ...query, fromBlock, toBlock });
  } catch (error) {
    if (isHistoricalLogError(error)) {
      const wrapped = new Error("historical_log_range_unavailable");
      (wrapped as Error & { cause?: unknown }).cause = error;
      throw wrapped;
    }
    if (!isLogLimitError(error)) throw error;

    const span = toBlock - fromBlock + 1;
    if (span <= minBlockSpan) throw error;

    const leftToBlock = fromBlock + Math.floor(span / 2) - 1;
    const rightFromBlock = leftToBlock + 1;
    const leftLogs = await getLogsWithAdaptiveRange(provider, { ...query, fromBlock, toBlock: leftToBlock }, options);
    const rightLogs = await getLogsWithAdaptiveRange(provider, { ...query, fromBlock: rightFromBlock, toBlock }, options);
    return [...leftLogs, ...rightLogs];
  }
}

export function isBscDepositWatcherDisabled() {
  const value = String(process.env.BSC_DEPOSIT_WATCHER_DISABLED || "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function normalizeAddress(value: string) {
  const raw = String(value || "").trim();
  if (isAddress(raw)) return getAddress(raw).toLowerCase();
  return String(raw).toLowerCase();
}

function addressTopic(address: string) {
  const normalized = normalizeAddress(address).replace(/^0x/, "");
  return `0x${normalized.padStart(64, "0")}`;
}

function addressFromTopic(topic: string) {
  const raw = `0x${String(topic || "").slice(-40)}`;
  return isAddress(raw) ? getAddress(raw) : String(raw).toLowerCase();
}

function chunkArray<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function getProvider() {
  return new JsonRpcProvider(getBscRpcUrl(), { chainId: 56, name: "bnb" }, { staticNetwork: true });
}

function getUnifiedDepositAddressOrNull() {
  try {
    const address = getUnifiedBscDepositAddress();
    return address ? getAddress(address) : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`BSC unified deposit address unavailable: ${message}`);
    return null;
  }
}

async function readLastScannedBlock(latestConfirmedBlock: number) {
  const initialLookback = parsePositiveInt(process.env.BSC_DEPOSIT_INITIAL_LOOKBACK_BLOCKS, DEFAULT_INITIAL_LOOKBACK_BLOCKS);
  const fallback = Math.max(0, latestConfirmedBlock - initialLookback);
  const setting = await prisma.systemSetting.findUnique({
    where: { key: LAST_SCANNED_BLOCK_KEY },
    select: { value: true },
  });
  const parsed = Math.floor(Number(setting?.value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

async function writeLastScannedBlock(blockNumber: number) {
  await prisma.systemSetting.upsert({
    where: { key: LAST_SCANNED_BLOCK_KEY },
    update: { value: String(blockNumber) },
    create: { key: LAST_SCANNED_BLOCK_KEY, value: String(blockNumber) },
  });
}

function getSafeBackfillFloor(latestConfirmedBlock: number) {
  const maxBackfillBlocks = parsePositiveInt(process.env.BSC_DEPOSIT_MAX_BACKFILL_BLOCKS, DEFAULT_MAX_BACKFILL_BLOCKS);
  return Math.max(0, latestConfirmedBlock - maxBackfillBlocks);
}

async function loadDepositAddresses() {
  return prisma.publicUserDepositAddress.findMany({
    select: {
      telegramUserId: true,
      telegramUsername: true,
      address: true,
    },
  });
}

async function creditLegacyLog(input: {
  row: DepositAddressRow;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  fromAddress: string;
  toAddress: string;
  amount: string;
  confirmations: number;
  tokenContract: string;
}) {
  return prisma.$transaction(
    async (tx) => creditPublicUserChainDeposit(tx, {
      telegramUserId: input.row.telegramUserId,
      telegramUsername: input.row.telegramUsername,
      txHash: input.txHash,
      logIndex: input.logIndex,
      blockNumber: input.blockNumber,
      fromAddress: input.fromAddress,
      toAddress: input.toAddress,
      tokenContract: input.tokenContract,
      amount: input.amount,
      confirmations: input.confirmations,
    }),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

async function creditUnifiedLog(input: {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  fromAddress: string;
  toAddress: string;
  amount: string;
  confirmations: number;
  tokenContract: string;
  paidAt: Date;
}) {
  return prisma.$transaction(
    async (tx) => creditPublicUserDepositOrder(tx, input),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

async function getBlockTime(provider: JsonRpcProvider, blockNumber: number, cache: Map<number, Date>) {
  const cached = cache.get(blockNumber);
  if (cached) return cached;
  const block = await provider.getBlock(blockNumber);
  const paidAt = block?.timestamp ? new Date(block.timestamp * 1000) : new Date();
  cache.set(blockNumber, paidAt);
  return paidAt;
}

function getLogIndex(log: unknown) {
  return Number((log as { index?: number; logIndex?: number }).index ?? (log as { logIndex?: number }).logIndex ?? 0);
}

export async function scanBscUsdtDepositsOnce() {
  const provider = getProvider();
  const confirmations = getBscDepositConfirmations();
  const latestBlock = await provider.getBlockNumber();
  const latestConfirmedBlock = latestBlock - confirmations;
  if (latestConfirmedBlock <= 0) return { scanned: 0, credited: 0, latestBlock, latestConfirmedBlock };

  let lastScannedBlock = await readLastScannedBlock(latestConfirmedBlock);
  const safeBackfillFloor = getSafeBackfillFloor(latestConfirmedBlock);
  if (lastScannedBlock < safeBackfillFloor) {
    console.warn(
      `BSC deposit watcher cursor is too old (${lastScannedBlock}); fast-forwarding to safe floor ${safeBackfillFloor}.`
    );
    lastScannedBlock = safeBackfillFloor;
    await writeLastScannedBlock(lastScannedBlock);
  }
  if (lastScannedBlock >= latestConfirmedBlock) return { scanned: 0, credited: 0, latestBlock, latestConfirmedBlock };

  const unifiedAddress = getUnifiedDepositAddressOrNull();
  const unifiedAddressKey = unifiedAddress ? normalizeAddress(unifiedAddress) : null;
  const legacyAddresses = (await loadDepositAddresses()).filter((row) => normalizeAddress(row.address) !== unifiedAddressKey);

  if (legacyAddresses.length === 0 && !unifiedAddress) {
    await writeLastScannedBlock(latestConfirmedBlock);
    return { scanned: latestConfirmedBlock - lastScannedBlock, credited: 0, latestBlock, latestConfirmedBlock };
  }

  const legacyAddressMap = new Map(legacyAddresses.map((row) => [normalizeAddress(row.address), row]));
  const tokenContract = getBscUsdtContract();
  const scanRange = parsePositiveInt(process.env.BSC_DEPOSIT_SCAN_RANGE_BLOCKS, DEFAULT_SCAN_RANGE_BLOCKS);
  const minScanRange = parsePositiveInt(process.env.BSC_DEPOSIT_MIN_SCAN_RANGE_BLOCKS, DEFAULT_MIN_SCAN_RANGE_BLOCKS);
  const addressChunkSize = parsePositiveInt(process.env.BSC_DEPOSIT_ADDRESS_TOPIC_CHUNK, DEFAULT_ADDRESS_TOPIC_CHUNK);
  const legacyTopicChunks = chunkArray(legacyAddresses.map((row) => addressTopic(row.address)), addressChunkSize);
  const blockTimeCache = new Map<number, Date>();
  let credited = 0;
  let scanned = 0;

  try {
    while (lastScannedBlock < latestConfirmedBlock) {
      const fromBlock = lastScannedBlock + 1;
      const toBlock = Math.min(latestConfirmedBlock, fromBlock + scanRange - 1);

      if (unifiedAddress) {
        const logs = await getLogsWithAdaptiveRange(provider, {
          address: tokenContract,
          fromBlock,
          toBlock,
          topics: [TRANSFER_TOPIC, null, addressTopic(unifiedAddress)],
        }, { minBlockSpan: minScanRange });

        for (const log of logs) {
          const toAddress = addressFromTopic(log.topics[2]);
          const fromAddress = addressFromTopic(log.topics[1]);
          const amount = formatUnits(BigInt(log.data), USDT_DECIMALS);
          const logIndex = getLogIndex(log);
          const paidAt = await getBlockTime(provider, log.blockNumber, blockTimeCache);
          const result = await creditUnifiedLog({
            txHash: log.transactionHash,
            logIndex,
            blockNumber: log.blockNumber,
            fromAddress,
            toAddress,
            amount,
            confirmations: Math.max(0, latestBlock - log.blockNumber),
            tokenContract,
            paidAt,
          });
          if (result.credited) {
            credited += 1;
            console.log(`BSC unified USDT deposit credited: ${amount} USDT -> ${result.telegramUserId} / ${result.orderNo} (${log.transactionHash}:${logIndex})`);
          }
        }
      }

      for (const topicChunk of legacyTopicChunks) {
        const toTopic = topicChunk.length === 1 ? topicChunk[0] : topicChunk;
        const logs = await getLogsWithAdaptiveRange(provider, {
          address: tokenContract,
          fromBlock,
          toBlock,
          topics: [TRANSFER_TOPIC, null, toTopic],
        }, { minBlockSpan: minScanRange });

        for (const log of logs) {
          const toAddress = addressFromTopic(log.topics[2]);
          const row = legacyAddressMap.get(normalizeAddress(toAddress));
          if (!row) continue;

          const fromAddress = addressFromTopic(log.topics[1]);
          const amount = formatUnits(BigInt(log.data), USDT_DECIMALS);
          const logIndex = getLogIndex(log);
          const result = await creditLegacyLog({
            row,
            txHash: log.transactionHash,
            logIndex,
            blockNumber: log.blockNumber,
            fromAddress,
            toAddress,
            amount,
            confirmations: Math.max(0, latestBlock - log.blockNumber),
            tokenContract,
          });
          if (result.credited) {
            credited += 1;
            console.log(`BSC legacy USDT deposit credited: ${amount} USDT -> ${row.telegramUserId} (${log.transactionHash}:${logIndex})`);
          }
        }
      }

      scanned += toBlock - fromBlock + 1;
      lastScannedBlock = toBlock;
      await writeLastScannedBlock(lastScannedBlock);
    }
  } catch (error) {
    if (error instanceof Error && error.message === "historical_log_range_unavailable") {
      console.warn(
        `BSC deposit watcher hit historical log limits; fast-forwarding cursor to safe floor ${safeBackfillFloor}.`
      );
      await writeLastScannedBlock(safeBackfillFloor);
      return { scanned, credited, latestBlock, latestConfirmedBlock };
    }
    throw error;
  }

  return { scanned, credited, latestBlock, latestConfirmedBlock };
}

export function startBscDepositWatcher() {
  const globalStore = globalThis as StoreGlobal;
  if (globalStore.__bscDepositWatcherStarted) return;
  globalStore.__bscDepositWatcherStarted = true;

  if (isBscDepositWatcherDisabled()) {
    console.log("BSC USDT deposit watcher disabled by BSC_DEPOSIT_WATCHER_DISABLED.");
    return;
  }

  const pollMs = parsePositiveInt(process.env.BSC_DEPOSIT_POLL_MS, DEFAULT_POLL_MS);

  async function run() {
    if (globalStore.__bscDepositWatcherRunning) return;
    globalStore.__bscDepositWatcherRunning = true;
    try {
      const result = await scanBscUsdtDepositsOnce();
      if (result.credited > 0) {
        console.log(`BSC USDT deposit scan finished: scanned=${result.scanned}, credited=${result.credited}, latest=${result.latestBlock}`);
      }
    } catch (error) {
      const rawMessage = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      const message = redactRpcUrl(rawMessage);
      console.error(`BSC USDT deposit watcher failed: ${message}`);
    } finally {
      globalStore.__bscDepositWatcherRunning = false;
    }
  }

  setTimeout(() => void run(), 3000);
  setInterval(() => void run(), pollMs);
  console.log(`BSC USDT deposit watcher started. RPC=<REDACTED_RPC>, confirmations=${getBscDepositConfirmations()}, pollMs=${pollMs}, unified=${Boolean(getUnifiedDepositAddressOrNull())}`);
}
