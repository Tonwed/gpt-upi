import { randomBytes } from "crypto";
import { Prisma, UpiGuardStatus } from "@prisma/client";
import { decryptSessionCredential } from "@/lib/server/credential-vault";
import { prisma } from "@/lib/server/prisma";

const MAX_GUARD_TTL_HOURS = 72;
const MIN_GUARD_TTL_HOURS = 1;
const DEFAULT_GUARD_TTL_HOURS = 24;
const GUARD_ID_ALPHABET = "abcdefghijkmnopqrstuvwxyz23456789";
const GUARD_ID_RE = /^guard_[a-z2-9]{16,32}$/;

export type PublicUpiGuardTask = {
  guardId: string;
  status: UpiGuardStatus;
  expiresAt: string;
  useCount: number;
  createdAt: string;
  lastUsedAt?: string | null;
};

export class UpiGuardError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "UpiGuardError";
    this.status = status;
  }
}

function normalizeTtlHours(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_GUARD_TTL_HOURS;
  return Math.min(MAX_GUARD_TTL_HOURS, Math.max(MIN_GUARD_TTL_HOURS, Math.floor(parsed)));
}

function makeGuardId() {
  const bytes = randomBytes(18);
  let suffix = "";
  for (const byte of bytes) suffix += GUARD_ID_ALPHABET[byte % GUARD_ID_ALPHABET.length];
  return `guard_${suffix}`;
}

function normalizeGuardId(value: unknown) {
  const guardId = String(value || "").trim().toLowerCase();
  if (!GUARD_ID_RE.test(guardId)) return "";
  return guardId;
}

function toPublicGuard(task: {
  guardId: string;
  status: UpiGuardStatus;
  expiresAt: Date;
  useCount: number;
  createdAt: Date;
  lastUsedAt: Date | null;
}): PublicUpiGuardTask {
  return {
    guardId: task.guardId,
    status: task.status,
    expiresAt: task.expiresAt.toISOString(),
    useCount: task.useCount,
    createdAt: task.createdAt.toISOString(),
    lastUsedAt: task.lastUsedAt?.toISOString() ?? null,
  };
}

export async function purgeExpiredUpiGuards() {
  const now = new Date();
  await prisma.upiGuardTask.updateMany({
    where: {
      status: UpiGuardStatus.ACTIVE,
      expiresAt: { lte: now },
    },
    data: {
      status: UpiGuardStatus.EXPIRED,
      credentialEncrypted: "",
      purgedAt: now,
      lastError: "Expired automatically.",
    },
  });
}

export async function disableActiveUpiGuards() {
  return prisma.upiGuardTask.updateMany({
    where: { status: UpiGuardStatus.ACTIVE },
    data: {
      status: UpiGuardStatus.CANCELLED,
      purgedAt: new Date(),
      lastError: "暂存功能已下线",
    },
  });
}

export async function createUpiGuardTask(input: {
  credentialEncrypted: string;
  credentialHash: string;
  ttlHours?: unknown;
}) {
  await purgeExpiredUpiGuards();

  const ttlHours = normalizeTtlHours(input.ttlHours);
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const guardId = makeGuardId();
    try {
      const task = await prisma.upiGuardTask.create({
        data: {
          guardId,
          credentialEncrypted: input.credentialEncrypted,
          credentialHash: input.credentialHash,
          expiresAt,
        },
        select: {
          guardId: true,
          status: true,
          expiresAt: true,
          useCount: true,
          createdAt: true,
          lastUsedAt: true,
        },
      });
      return toPublicGuard(task);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") continue;
      throw error;
    }
  }

  throw new UpiGuardError("生成暂存 ID 失败，请重试。", 500);
}

export async function claimUpiGuardCredential(value: unknown) {
  await purgeExpiredUpiGuards();

  const guardId = normalizeGuardId(value);
  if (!guardId) throw new UpiGuardError("暂存 ID 格式不正确。", 400);

  const task = await prisma.upiGuardTask.findUnique({
    where: { guardId },
    select: {
      id: true,
      guardId: true,
      credentialEncrypted: true,
      status: true,
      expiresAt: true,
    },
  });

  if (!task) throw new UpiGuardError("暂存 ID 不存在。", 404);

  if (task.status !== UpiGuardStatus.ACTIVE) {
    const message = task.status === UpiGuardStatus.COMPLETED
      ? "这个暂存已完成并清除，不能继续使用。"
      : "这个暂存已失效，不能继续使用。";
    throw new UpiGuardError(message, 410);
  }

  const now = new Date();
  if (task.expiresAt.getTime() <= now.getTime() || !task.credentialEncrypted) {
    await prisma.upiGuardTask.update({
      where: { id: task.id },
      data: {
        status: UpiGuardStatus.EXPIRED,
        credentialEncrypted: "",
        purgedAt: now,
        lastError: "Expired when claimed.",
      },
    });
    throw new UpiGuardError("这个暂存已过期，不能继续使用。", 410);
  }

  let credential = "";
  try {
    credential = decryptSessionCredential(task.credentialEncrypted);
  } catch {
    await prisma.upiGuardTask.update({
      where: { id: task.id },
      data: {
        status: UpiGuardStatus.CANCELLED,
        credentialEncrypted: "",
        purgedAt: now,
        lastError: "Stored credential cannot be decrypted.",
      },
    });
    throw new UpiGuardError("暂存数据无法读取，请重新创建暂存。", 410);
  }

  await prisma.upiGuardTask.update({
    where: { id: task.id },
    data: {
      useCount: { increment: 1 },
      lastUsedAt: now,
      lastError: null,
    },
  });

  return { guardId: task.guardId, credential };
}

export async function recordUpiGuardUseSuccess(guardId: string) {
  await prisma.upiGuardTask.updateMany({
    where: { guardId },
    data: { lastError: null },
  });
}

export async function recordUpiGuardUseFailure(guardId: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "UPI extraction failed");
  await prisma.upiGuardTask.updateMany({
    where: { guardId },
    data: { lastError: message.slice(0, 700) },
  });
}

export async function completeUpiGuardTask(value: unknown) {
  await purgeExpiredUpiGuards();

  const guardId = normalizeGuardId(value);
  if (!guardId) throw new UpiGuardError("暂存 ID 格式不正确。", 400);

  const task = await prisma.upiGuardTask.findUnique({
    where: { guardId },
    select: {
      id: true,
      guardId: true,
      status: true,
      expiresAt: true,
      useCount: true,
      createdAt: true,
      lastUsedAt: true,
    },
  });
  if (!task) throw new UpiGuardError("暂存 ID 不存在。", 404);

  const now = new Date();
  const next = await prisma.upiGuardTask.update({
    where: { id: task.id },
    data: {
      status: UpiGuardStatus.COMPLETED,
      credentialEncrypted: "",
      completedAt: now,
      purgedAt: now,
      lastError: null,
    },
    select: {
      guardId: true,
      status: true,
      expiresAt: true,
      useCount: true,
      createdAt: true,
      lastUsedAt: true,
    },
  });

  return toPublicGuard(next);
}
