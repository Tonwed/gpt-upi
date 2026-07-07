import { fail, ok } from "@/lib/server/responses";

export const runtime = "nodejs";

const PRESENCE_TTL_MS = 30_000;
const MAX_PRESENCE_ITEMS = 5_000;
const SESSION_ID_RE = /^[A-Za-z0-9_.:-]{8,160}$/;

type PresenceStore = Map<string, number>;

type PresenceGlobal = typeof globalThis & {
  __upiExtractPresence?: PresenceStore;
};

const presenceStore = (globalThis as PresenceGlobal).__upiExtractPresence ?? new Map<string, number>();
(globalThis as PresenceGlobal).__upiExtractPresence = presenceStore;

function cleanupPresence() {
  const now = Date.now();
  for (const [sessionId, lastSeenAt] of presenceStore.entries()) {
    if (now - lastSeenAt > PRESENCE_TTL_MS) presenceStore.delete(sessionId);
  }

  while (presenceStore.size > MAX_PRESENCE_ITEMS) {
    let oldestKey = "";
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [sessionId, lastSeenAt] of presenceStore.entries()) {
      if (lastSeenAt < oldestAt) {
        oldestAt = lastSeenAt;
        oldestKey = sessionId;
      }
    }
    if (!oldestKey) break;
    presenceStore.delete(oldestKey);
  }
}

function normalizeSessionId(value: unknown) {
  const sessionId = String(value || "").trim();
  if (!SESSION_ID_RE.test(sessionId)) return "";
  return sessionId;
}

async function readBody(request: Request) {
  return request.json().catch(() => ({})) as Promise<Record<string, unknown>>;
}

export async function GET() {
  cleanupPresence();
  return ok({ count: presenceStore.size, ttlSeconds: Math.ceil(PRESENCE_TTL_MS / 1000) });
}

export async function POST(request: Request) {
  const body = await readBody(request);
  const sessionId = normalizeSessionId(body.sessionId);
  if (!sessionId) return fail("页面在线统计会话无效", 400);

  if (body.leave === true) {
    presenceStore.delete(sessionId);
  } else {
    presenceStore.set(sessionId, Date.now());
  }

  cleanupPresence();
  return ok({ count: presenceStore.size, ttlSeconds: Math.ceil(PRESENCE_TTL_MS / 1000) });
}
