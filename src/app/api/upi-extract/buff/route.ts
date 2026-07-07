import { prisma } from "@/lib/server/prisma";
import { fail, handleRouteError, ok } from "@/lib/server/responses";

export const runtime = "nodejs";

const BUFF_TOTAL_KEY = "public_upi_buff_total";
const GUIDE_OPEN_TOTAL_KEY = "public_upi_guide_open_total";
const MAX_BUFF_EVENTS = 300;
const VIEWER_ID_RE = /^[A-Za-z0-9_.:-]{8,160}$/;

type BuffEvent = {
  seq: number;
  viewerId: string;
  createdAt: string;
};

type BuffGlobal = typeof globalThis & {
  __upiExtractBuffEvents?: BuffEvent[];
};

const buffEvents = (globalThis as BuffGlobal).__upiExtractBuffEvents ?? [];
(globalThis as BuffGlobal).__upiExtractBuffEvents = buffEvents;

function normalizeViewerId(value: unknown) {
  const viewerId = String(value || "").trim();
  if (!VIEWER_ID_RE.test(viewerId)) return "";
  return viewerId;
}

function normalizeSince(value: string | null) {
  const since = Number(value || "");
  return Number.isFinite(since) && since >= 0 ? Math.floor(since) : null;
}

function normalizeCounter(value: string | null | undefined) {
  const count = Number(value || 0);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

async function getCounter(key: string) {
  const setting = await prisma.systemSetting.findUnique({
    where: { key },
    select: { value: true },
  });
  return normalizeCounter(setting?.value);
}

async function incrementCounter(key: string) {
  const rows = await prisma.$queryRaw<Array<{ value: string }>>`
    INSERT INTO "system_settings" ("key", "value", "createdAt", "updatedAt")
    VALUES (${key}, '1', NOW(), NOW())
    ON CONFLICT ("key") DO UPDATE
    SET
      "value" = ((COALESCE(NULLIF("system_settings"."value", ''), '0')::bigint + 1)::text),
      "updatedAt" = NOW()
    RETURNING "value"
  `;

  return normalizeCounter(rows[0]?.value);
}

function pushBuffEvent(event: BuffEvent) {
  buffEvents.push(event);
  while (buffEvents.length > MAX_BUFF_EVENTS) buffEvents.shift();
}

async function getStats(since: number | null, viewerId: string) {
  const [buffCount, guideOpenCount] = await Promise.all([
    getCounter(BUFF_TOTAL_KEY),
    getCounter(GUIDE_OPEN_TOTAL_KEY),
  ]);

  const events = since === null
    ? []
    : buffEvents.filter((event) => event.seq > since && (!viewerId || event.viewerId !== viewerId));

  return {
    buffCount,
    guideOpenCount,
    latestEventSeq: buffCount,
    events,
  };
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const since = normalizeSince(url.searchParams.get("since"));
    const viewerId = normalizeViewerId(url.searchParams.get("viewerId"));

    return ok(await getStats(since, viewerId));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const type = String(body.type || "").trim();
    const viewerId = normalizeViewerId(body.viewerId);
    if (!viewerId) return fail("Buff 会话无效", 400);

    if (type === "buff") {
      const buffCount = await incrementCounter(BUFF_TOTAL_KEY);
      pushBuffEvent({
        seq: buffCount,
        viewerId,
        createdAt: new Date().toISOString(),
      });
      return ok(await getStats(buffCount, viewerId));
    }

    if (type === "guide-open") {
      await incrementCounter(GUIDE_OPEN_TOTAL_KEY);
      return ok(await getStats(null, viewerId));
    }

    return fail("未知 Buff 操作", 400);
  } catch (error) {
    return handleRouteError(error);
  }
}
