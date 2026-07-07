import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SignJWT, jwtVerify } from "jose";
import { prisma } from "@/lib/server/prisma";
import { getPublicUserPremiumStatus } from "@/lib/server/public-user-premium";
import { normalizeTelegramUsername } from "@/lib/server/telegram-login";

const WORKER_COOKIE_NAME = "gpt_upi_worker";
const ADMIN_COOKIE_NAME = "gpt_upi_admin";
const PUBLIC_USER_COOKIE_NAME = "gpt_upi_public_user";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const LOCAL_TEST_PUBLIC_USER_ID = "1000000000";
const LOCAL_TEST_PUBLIC_USER_USERNAME = "demo";

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not configured");
  }
  return new TextEncoder().encode(secret);
}

export async function createWorkerToken(workerId: string) {
  return new SignJWT({ workerId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(getJwtSecret());
}

export async function createAdminToken(telegramUserId: string) {
  return new SignJWT({ admin: true, telegramUserId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(getJwtSecret());
}

export async function createPublicUserToken(input: { telegramUserId: string; telegramUsername?: string | null }) {
  return new SignJWT({
    publicUser: true,
    telegramUserId: input.telegramUserId,
    telegramUsername: input.telegramUsername || null,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(getJwtSecret());
}

export async function setWorkerCookie(response: NextResponse, workerId: string) {
  const token = await createWorkerToken(workerId);
  response.cookies.set(WORKER_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_SECONDS,
    path: "/",
  });
}

export async function setAdminCookie(response: NextResponse, telegramUserId: string) {
  const token = await createAdminToken(telegramUserId);
  response.cookies.set(ADMIN_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_SECONDS,
    path: "/",
  });
}

export async function setPublicUserCookie(response: NextResponse, input: { telegramUserId: string; telegramUsername?: string | null }) {
  const token = await createPublicUserToken(input);
  response.cookies.set(PUBLIC_USER_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_SECONDS,
    path: "/",
  });
}

export function clearWorkerCookie(response: NextResponse) {
  response.cookies.set(WORKER_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 0,
    path: "/",
  });
}

export function clearAdminCookie(response: NextResponse) {
  response.cookies.set(ADMIN_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 0,
    path: "/",
  });
}

export function clearPublicUserCookie(response: NextResponse) {
  response.cookies.set(PUBLIC_USER_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 0,
    path: "/",
  });
}

export async function getWorkerSession() {
  const cookieStore = await cookies();
  const token = cookieStore.get(WORKER_COOKIE_NAME)?.value;
  if (!token) return null;

  try {
    const verified = await jwtVerify(token, getJwtSecret());
    const workerId = verified.payload.workerId;
    if (typeof workerId !== "string") return null;

    const worker = await prisma.worker.findUnique({
      where: { id: workerId },
      select: {
        id: true,
        username: true,
        displayName: true,
        unitPrice: true,
        payoutMode: true,
        binanceUserId: true,
        telegramUserId: true,
        telegramUsername: true,
        status: true,
        isDisabled: true,
        autoAcceptEnabled: true,
        autoAcceptNotifyEnabled: true,
        newOrderSoundEnabled: true,
        lastSeenAt: true,
        createdAt: true,
      },
    });

    if (worker?.isDisabled) return null;
    return worker;
  } catch {
    return null;
  }
}

export async function getAdminSession() {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_COOKIE_NAME)?.value;
  if (!token) return null;

  try {
    const verified = await jwtVerify(token, getJwtSecret());
    if (verified.payload.admin !== true) return null;
    const telegramUserId = verified.payload.telegramUserId;
    if (typeof telegramUserId !== "string") return null;

    const adminId = process.env.TELEGRAM_ADMIN_ID;
    if (!adminId || telegramUserId !== adminId) return null;

    return { telegramUserId, username: process.env.TELEGRAM_ADMIN_USERNAME || "admin" };
  } catch {
    return null;
  }
}

export async function getPublicUserSession() {
  async function getLocalTestPublicUserSession() {
    if (process.env.GPT_UPI_LOCAL_TEST_ENV !== "1") return null;
    const telegramUserId = process.env.LOCAL_TEST_PUBLIC_USER_ID || process.env.TELEGRAM_ADMIN_ID || LOCAL_TEST_PUBLIC_USER_ID;
    const telegramUsername = normalizeTelegramUsername(
      process.env.LOCAL_TEST_PUBLIC_USER_USERNAME || process.env.TELEGRAM_ADMIN_USERNAME || LOCAL_TEST_PUBLIC_USER_USERNAME
    );
    const premium = await getPublicUserPremiumStatus({ telegramUserId, telegramUsername });
    return {
      telegramUserId,
      telegramUsername,
      displayName: telegramUsername ? `@${telegramUsername}` : `TG ${telegramUserId}`,
      isPremium: premium.isPremium,
      premiumUntil: premium.premiumUntil,
      premiumSource: premium.premiumSource,
      premiumTier: premium.premiumTier,
    };
  }

  const cookieStore = await cookies();
  const token = cookieStore.get(PUBLIC_USER_COOKIE_NAME)?.value;
  if (!token) return getLocalTestPublicUserSession();

  try {
    const verified = await jwtVerify(token, getJwtSecret());
    if (verified.payload.publicUser !== true) return null;
    const telegramUserId = verified.payload.telegramUserId;
    if (typeof telegramUserId !== "string") return null;
    const telegramUsername = typeof verified.payload.telegramUsername === "string"
      ? verified.payload.telegramUsername
      : null;

    const premium = await getPublicUserPremiumStatus({ telegramUserId, telegramUsername });

    return {
      telegramUserId,
      telegramUsername,
      displayName: telegramUsername ? `@${telegramUsername}` : `TG ${telegramUserId}`,
      isPremium: premium.isPremium,
      premiumUntil: premium.premiumUntil,
      premiumSource: premium.premiumSource,
      premiumTier: premium.premiumTier,
    };
  } catch {
    return getLocalTestPublicUserSession();
  }
}

export async function requireAdminSession() {
  const admin = await getAdminSession();
  if (!admin) {
    throw new Response("Unauthorized", { status: 401 });
  }
  return admin;
}

export async function requireWorkerSession() {
  const worker = await getWorkerSession();
  if (!worker) {
    throw new Response("Unauthorized", { status: 401 });
  }
  return worker;
}
