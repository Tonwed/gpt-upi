import Redis, { type RedisOptions } from "ioredis";

type LocalCacheEntry<T> = {
  expiresAt: number;
  value: T;
};

type RedisCacheGlobal = {
  __gptUpiRedisClient?: Redis | null;
  __gptUpiRedisDisabledUntil?: number;
  __gptUpiRedisWarnedAt?: number;
  __gptUpiLocalCache?: Map<string, LocalCacheEntry<unknown>>;
  __gptUpiCacheInFlight?: Map<string, Promise<unknown>>;
};

const globalForRedis = globalThis as unknown as RedisCacheGlobal;

const DEFAULT_LOCAL_TTL_MS = 500;
const DEFAULT_REDIS_DISABLE_MS = 15_000;
const REDIS_CONNECT_TIMEOUT_MS = 800;
const REDIS_COMMAND_TIMEOUT_MS = 800;

function readRuntimeEnv(nameParts: string[]) {
  const key = nameParts.join("_");
  const env = process.env as Record<string, string | undefined>;
  return env[key];
}

function cachePrefix() {
  return readRuntimeEnv(["REDIS", "KEY", "PREFIX"]) || readRuntimeEnv(["UPI", "REDIS", "KEY", "PREFIX"]) || "gpt_upi:";
}

function getRedisUrl() {
  return readRuntimeEnv(["REDIS", "URL"]) || readRuntimeEnv(["UPI", "REDIS", "URL"]) || "";
}

function getRedisHost() {
  return readRuntimeEnv(["REDIS", "HOST"]) || readRuntimeEnv(["UPI", "REDIS", "HOST"]) || "";
}

function getRedisOptions(): RedisOptions {
  return {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
    commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
    retryStrategy: () => null,
  };
}

function getRedisClient() {
  const now = Date.now();
  if ((globalForRedis.__gptUpiRedisDisabledUntil || 0) > now) return null;
  if (globalForRedis.__gptUpiRedisClient !== undefined) return globalForRedis.__gptUpiRedisClient;

  const url = getRedisUrl();
  const host = getRedisHost();
  if (!url && !host) {
    globalForRedis.__gptUpiRedisClient = null;
    return null;
  }

  const options = getRedisOptions();
  const client = url
    ? new Redis(url, options)
    : new Redis({
        ...options,
        host,
        port: Number(readRuntimeEnv(["REDIS", "PORT"]) || readRuntimeEnv(["UPI", "REDIS", "PORT"]) || 6379),
        password: readRuntimeEnv(["REDIS", "PASSWORD"]) || readRuntimeEnv(["UPI", "REDIS", "PASSWORD"]) || undefined,
        db: Number(readRuntimeEnv(["REDIS", "DB"]) || readRuntimeEnv(["UPI", "REDIS", "DB"]) || 0),
      });

  client.on("error", (error) => {
    markRedisUnavailable(error);
  });
  globalForRedis.__gptUpiRedisClient = client;
  return client;
}

function localCache() {
  return (globalForRedis.__gptUpiLocalCache ??= new Map<string, LocalCacheEntry<unknown>>());
}

function inFlightCache() {
  return (globalForRedis.__gptUpiCacheInFlight ??= new Map<string, Promise<unknown>>());
}

function prefixedKey(key: string) {
  return `${cachePrefix()}${key}`;
}

function markRedisUnavailable(error?: unknown) {
  const now = Date.now();
  globalForRedis.__gptUpiRedisDisabledUntil = now + DEFAULT_REDIS_DISABLE_MS;

  const lastWarnedAt = globalForRedis.__gptUpiRedisWarnedAt || 0;
  if (now - lastWarnedAt > 60_000) {
    globalForRedis.__gptUpiRedisWarnedAt = now;
    console.warn("Redis cache unavailable; falling back to local cache/database", {
      error: error instanceof Error ? error.message : String(error || ""),
    });
  }

  const client = globalForRedis.__gptUpiRedisClient;
  globalForRedis.__gptUpiRedisClient = undefined;
  try {
    client?.disconnect();
  } catch {
    // Ignore disconnect failures.
  }
}

async function safeRedisGet(key: string) {
  const client = getRedisClient();
  if (!client) return null;
  try {
    if (client.status === "wait") await client.connect();
    return await client.get(prefixedKey(key));
  } catch (error) {
    markRedisUnavailable(error);
    return null;
  }
}

async function safeRedisSet(key: string, value: string, ttlMs: number) {
  const client = getRedisClient();
  if (!client) return;
  try {
    if (client.status === "wait") await client.connect();
    await client.set(prefixedKey(key), value, "PX", Math.max(100, Math.floor(ttlMs)));
  } catch (error) {
    markRedisUnavailable(error);
  }
}

async function safeRedisDel(keys: string[]) {
  const client = getRedisClient();
  if (!client || keys.length === 0) return;
  try {
    if (client.status === "wait") await client.connect();
    await client.del(...keys.map(prefixedKey));
  } catch (error) {
    markRedisUnavailable(error);
  }
}

export async function getCachedJson<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
  options?: {
    localTtlMs?: number;
  }
): Promise<T> {
  const safeTtlMs = Math.max(0, Math.floor(ttlMs));
  if (safeTtlMs <= 0) return loader();

  const now = Date.now();
  const local = localCache();
  const localEntry = local.get(key) as LocalCacheEntry<T> | undefined;
  if (localEntry && localEntry.expiresAt > now) return localEntry.value;

  const inFlight = inFlightCache();
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const promise = (async () => {
    const cached = await safeRedisGet(key);
    if (cached) {
      try {
        const value = JSON.parse(cached) as T;
        local.set(key, {
          value,
          expiresAt: Date.now() + Math.max(50, Math.min(options?.localTtlMs ?? DEFAULT_LOCAL_TTL_MS, safeTtlMs)),
        });
        return value;
      } catch {
        // Fall through and rebuild corrupt cache values.
      }
    }

    const value = await loader();
    local.set(key, {
      value,
      expiresAt: Date.now() + Math.max(50, Math.min(options?.localTtlMs ?? DEFAULT_LOCAL_TTL_MS, safeTtlMs)),
    });
    void safeRedisSet(key, JSON.stringify(value), safeTtlMs);
    return value;
  })();

  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}

export async function deleteCachedJson(keys: string[]) {
  if (keys.length === 0) return;
  const local = localCache();
  for (const key of keys) local.delete(key);
  await safeRedisDel(keys);
}

export function deleteLocalCachedJson(keys: string[]) {
  if (keys.length === 0) return;
  const local = localCache();
  for (const key of keys) local.delete(key);
}
