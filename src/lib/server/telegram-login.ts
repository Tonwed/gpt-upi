import { createHash, randomInt } from "crypto";
import { Prisma, TelegramLoginPurpose } from "@prisma/client";
import { prisma } from "@/lib/server/prisma";

const LOGIN_CODE_TTL_MS = 5 * 60 * 1000;
const LOGIN_CODE_LENGTH = 8;
const LOGIN_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LOGIN_ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_ATTEMPT_LIMIT = 3;

export type LoginPurpose = "worker" | "admin" | "user";

export type TelegramLoginActor = {
  id: string;
  username?: string | null;
  firstName?: string | null;
};

export function normalizeTelegramUsername(username?: string | null) {
  return username?.trim().replace(/^@/, "").toLowerCase() || null;
}

export function parseLoginPurpose(value: unknown): TelegramLoginPurpose | null {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "worker") return TelegramLoginPurpose.WORKER;
  if (normalized === "admin") return TelegramLoginPurpose.ADMIN;
  if (normalized === "user") return TelegramLoginPurpose.USER;
  return null;
}

export function publicPurpose(purpose: TelegramLoginPurpose): LoginPurpose {
  if (purpose === TelegramLoginPurpose.ADMIN) return "admin";
  if (purpose === TelegramLoginPurpose.USER) return "user";
  return "worker";
}

function hashLoginCode(code: string) {
  return createHash("sha256").update(normalizeLoginCode(code)).digest("hex");
}

function normalizeLoginCode(code: string) {
  return code.trim().replace(/\s+/g, "").toUpperCase();
}

function generateLoginCode() {
  while (true) {
    const code = Array.from({ length: LOGIN_CODE_LENGTH }, () => LOGIN_CODE_ALPHABET[randomInt(LOGIN_CODE_ALPHABET.length)]).join("");
    if (/[A-Z]/.test(code) && /\d/.test(code)) return code;
  }
}

function isUniqueError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "P2002";
}

async function recordTelegramLoginAttempt(actor: TelegramLoginActor, code: string) {
  const cutoff = new Date(Date.now() - LOGIN_ATTEMPT_WINDOW_MS);
  const telegramUsername = normalizeTelegramUsername(actor.username);

  return prisma.$transaction(
    async (tx) => {
      const recentAttempts = await tx.telegramLoginAttempt.count({
        where: {
          telegramUserId: actor.id,
          attemptedAt: { gte: cutoff },
        },
      });

      if (recentAttempts >= LOGIN_ATTEMPT_LIMIT) {
        return { allowed: false as const };
      }

      const attempt = await tx.telegramLoginAttempt.create({
        data: {
          telegramUserId: actor.id,
          telegramUsername,
          code,
        },
        select: { id: true },
      });

      return { allowed: true as const, attemptId: attempt.id };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

export async function createTelegramLoginChallenge(purpose: TelegramLoginPurpose) {
  for (let index = 0; index < 5; index += 1) {
    const code = generateLoginCode();
    try {
      const challenge = await prisma.telegramLoginChallenge.create({
        data: {
          codeHash: hashLoginCode(code),
          purpose,
          expiresAt: new Date(Date.now() + LOGIN_CODE_TTL_MS),
        },
        select: {
          id: true,
          purpose: true,
          status: true,
          expiresAt: true,
        },
      });
      return { ...challenge, code, purpose: publicPurpose(challenge.purpose) };
    } catch (error) {
      if (!isUniqueError(error)) throw error;
    }
  }

  throw new Error("Failed to generate a login code. Please try again.");
}

export async function getTelegramLoginChallenge(challengeId: string, purpose: TelegramLoginPurpose) {
  const challenge = await prisma.telegramLoginChallenge.findUnique({
    where: { id: challengeId },
    select: {
      id: true,
      purpose: true,
      status: true,
      telegramUserId: true,
      telegramUsername: true,
      workerId: true,
      expiresAt: true,
      approvedAt: true,
      usedAt: true,
    },
  });

  if (!challenge || challenge.purpose !== purpose) return null;
  if (challenge.status === "PENDING" && challenge.expiresAt.getTime() <= Date.now()) {
    return prisma.telegramLoginChallenge.update({
      where: { id: challenge.id },
      data: { status: "EXPIRED" },
      select: {
        id: true,
        purpose: true,
        status: true,
        telegramUserId: true,
        telegramUsername: true,
        workerId: true,
        expiresAt: true,
        approvedAt: true,
        usedAt: true,
      },
    });
  }

  return challenge;
}

export async function markTelegramLoginChallengeUsed(challengeId: string) {
  return prisma.telegramLoginChallenge.update({
    where: { id: challengeId },
    data: { status: "USED", usedAt: new Date() },
  });
}

export function isAllowedAdmin(actor: TelegramLoginActor) {
  const adminId = process.env.TELEGRAM_ADMIN_ID;
  const adminUsername = normalizeTelegramUsername(process.env.TELEGRAM_ADMIN_USERNAME);
  if (!adminId || !adminUsername) return false;
  return actor.id === adminId && normalizeTelegramUsername(actor.username) === adminUsername;
}

async function findRegisteredWorker(actor: TelegramLoginActor) {
  const telegramUsername = normalizeTelegramUsername(actor.username);

  const boundWorker = await prisma.worker.findUnique({
    where: { telegramUserId: actor.id },
    select: {
      id: true,
      username: true,
      displayName: true,
      telegramUserId: true,
      telegramUsername: true,
      isDisabled: true,
    },
  });

  if (boundWorker) {
    if (boundWorker.isDisabled) return null;
    if (telegramUsername && boundWorker.telegramUsername !== telegramUsername) {
      await prisma.worker.update({
        where: { id: boundWorker.id },
        data: {
          telegramUsername,
          lastSeenAt: new Date(),
        },
      });
    }
    return boundWorker;
  }

  if (!telegramUsername) return null;

  const unboundWorker = await prisma.worker.findFirst({
    where: {
      telegramUsername,
      telegramUserId: null,
    },
    select: {
      id: true,
      username: true,
      displayName: true,
      telegramUserId: true,
      telegramUsername: true,
      isDisabled: true,
    },
  });

  if (!unboundWorker || unboundWorker.isDisabled) return null;

  await prisma.worker.update({
    where: { id: unboundWorker.id },
    data: {
      telegramUserId: actor.id,
      telegramUsername,
      lastSeenAt: new Date(),
    },
  });

  return {
    ...unboundWorker,
    telegramUserId: actor.id,
    telegramUsername,
  };
}

export async function approveTelegramLoginCode(code: string, actor: TelegramLoginActor) {
  const normalizedCode = normalizeLoginCode(code);
  const attempt = await recordTelegramLoginAttempt(actor, normalizedCode);

  if (!attempt.allowed) {
    return { ok: false as const, message: "Too many login attempts. You can try at most 3 codes every 5 minutes. Please wait and try again." };
  }

  if (!/^[A-Z0-9]{8}$/.test(normalizedCode) || !/[A-Z]/.test(normalizedCode)) {
    return { ok: false as const, message: "Invalid login code. Please send the 8-character letter/number code shown on the web page." };
  }

  const challenge = await prisma.telegramLoginChallenge.findFirst({
    where: {
      codeHash: hashLoginCode(normalizedCode),
      status: "PENDING",
    },
  });

  if (!challenge) {
    return { ok: false as const, message: "This login code does not exist or has already been used. Please refresh the web page and get a new code." };
  }

  if (challenge.expiresAt.getTime() <= Date.now()) {
    await prisma.telegramLoginChallenge.update({
      where: { id: challenge.id },
      data: { status: "EXPIRED" },
    });
    return { ok: false as const, message: "This login code has expired. Please get a new code on the web page." };
  }

  const telegramUsername = normalizeTelegramUsername(actor.username);
  if (challenge.purpose === TelegramLoginPurpose.ADMIN) {
    if (!isAllowedAdmin(actor)) {
      return { ok: false as const, message: "This Telegram account does not have admin permission." };
    }

    await prisma.telegramLoginChallenge.update({
      where: { id: challenge.id },
      data: {
        status: "APPROVED",
        telegramUserId: actor.id,
        telegramUsername,
        approvedAt: new Date(),
      },
    });
    await prisma.telegramLoginAttempt.update({ where: { id: attempt.attemptId }, data: { success: true } });
    return { ok: true as const, message: "Admin login confirmed. Please return to the web page; it will continue automatically.", purpose: "admin" as const };
  }

  if (challenge.purpose === TelegramLoginPurpose.USER) {
    await prisma.telegramLoginChallenge.update({
      where: { id: challenge.id },
      data: {
        status: "APPROVED",
        telegramUserId: actor.id,
        telegramUsername,
        approvedAt: new Date(),
      },
    });
    await prisma.telegramLoginAttempt.update({ where: { id: attempt.attemptId }, data: { success: true } });
    return { ok: true as const, message: "Account login confirmed. Please return to the web page; it will continue automatically.", purpose: "user" as const };
  }

  const worker = await findRegisteredWorker(actor);
  if (!worker) {
    return { ok: false as const, message: "This Telegram account is not registered as a worker. Please ask the admin to register it first." };
  }

  await prisma.telegramLoginChallenge.update({
    where: { id: challenge.id },
    data: {
      status: "APPROVED",
      telegramUserId: actor.id,
      telegramUsername,
      workerId: worker.id,
      approvedAt: new Date(),
    },
  });
  await prisma.telegramLoginAttempt.update({ where: { id: attempt.attemptId }, data: { success: true } });

  return {
    ok: true as const,
    message: `Worker ${worker.displayName} login confirmed. Please return to the web page; it will continue automatically.`,
    purpose: "worker" as const,
    worker,
  };
}
