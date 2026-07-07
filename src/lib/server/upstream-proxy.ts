import { ProxyAgent, Socks5ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import { prisma } from "@/lib/server/prisma";

const DEFAULT_PROXY_TIMEOUT_MS = 15_000;
const DEFAULT_EXPECTED_COUNTRY = "JP";
const PROXY_SELECTION_KEYS = {
  public: "upstream_proxy_selection",
  premium: "premium_upstream_proxy_selection",
} as const;
const PROXY_LIST_SETTING_KEYS = {
  public: "upstream_proxy_list_public",
  premium: "upstream_proxy_list_premium",
} as const;
export const AUTO_PROXY_SELECTION = "AUTO";

const agentCache = new Map<string, Dispatcher>();
const roundRobinCursorByPool: Record<UpstreamProxyPool, number> = { public: 0, premium: 0 };

export type UpstreamProxyPool = "public" | "premium";
type UpstreamProxySource =
  | "UPSTREAM_PROXY_LIST"
  | "UPI_PROXY_LIST"
  | "UPSTREAM_PROXY"
  | "PREMIUM_UPSTREAM_PROXY_LIST"
  | "PREMIUM_UPI_PROXY_LIST"
  | "PREMIUM_UPSTREAM_PROXY"
  | "ADMIN_PUBLIC_PROXY_LIST"
  | "ADMIN_PREMIUM_PROXY_LIST"
  | "CUSTOM_USER_PROXY";

export type UpstreamProxyEntry = {
  id: string;
  index: number;
  source: UpstreamProxySource;
  url: string;
  redactedUrl: string;
  scheme: string;
  host: string;
  port: string;
};

export type PublicUpstreamProxy = Omit<UpstreamProxyEntry, "url">;

export type UpstreamProxyCheckResult = PublicUpstreamProxy & {
  ok: boolean;
  expectedCountry: string;
  checkedAt: string;
  latencyMs: number;
  ip?: string;
  country?: string;
  countryCode?: string;
  region?: string;
  city?: string;
  org?: string;
  asn?: string;
  chatgptStatus?: number;
  stripeStatus?: number;
  telegramStatus?: number;
  error?: string;
  warnings: string[];
};

export type UpstreamProxyCheckSummary = {
  checkedAt: string;
  total: number;
  ok: number;
  failed: number;
  expectedCountry: string;
  results: UpstreamProxyCheckResult[];
};

export type UpstreamProxySelection = {
  selectedProxyId: string;
  selectedProxy: PublicUpstreamProxy | null;
  mode: "AUTO" | "MANUAL";
};

function splitProxyList(value: string) {
  return value
    .split(/[\n,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseProxyUrl(rawUrl: string, index: number, source: UpstreamProxyEntry["source"]): UpstreamProxyEntry | null {
  const value = rawUrl.trim();
  if (!value) return null;
  const normalized = (() => {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
    const parts = value.split(":");
    if (parts.length >= 4 && /^\d+$/.test(parts[1] || "")) {
      const [host, port, username, ...passwordParts] = parts;
      const password = passwordParts.join(":");
      return `socks5://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
    }
    return `socks5://${value}`;
  })();
  try {
    const url = new URL(normalized);
    return {
      id: String(index),
      index,
      source,
      url: normalized,
      redactedUrl: redactProxyUrl(normalized),
      scheme: url.protocol.replace(/:$/, ""),
      host: url.hostname,
      port: url.port,
    };
  } catch {
    return null;
  }
}

export function redactProxyUrl(rawUrl: string) {
  if (!rawUrl) return "DIRECT";
  try {
    const url = new URL(rawUrl);
    const username = url.username ? decodeURIComponent(url.username) : "";
    const auth = username ? `${username}${url.password ? ":<PASSWORD_REDACTED>" : ""}@` : "";
    const path = url.pathname && url.pathname !== "/" ? url.pathname : "";
    return `${url.protocol}//${auth}${url.host}${path}${url.search}${url.hash}`;
  } catch {
    return rawUrl.replace(/(:\/\/[^:@/]+):([^@/]+)@/, "$1:<PASSWORD_REDACTED>@");
  }
}

export function describeUpstreamProxy(rawUrl?: string) {
  return rawUrl ? redactProxyUrl(rawUrl) : "DIRECT";
}

const CUSTOM_PROXY_PROTOCOLS = new Set(["http:", "https:", "socks:", "socks5:"]);

export function createCustomUpstreamProxyEntry(rawUrl: string, index = 0): UpstreamProxyEntry {
  const parsed = parseProxyUrl(rawUrl, index, "CUSTOM_USER_PROXY");
  if (!parsed) throw new Error(`Invalid proxy URL: ${redactProxyUrl(rawUrl)}`);
  const protocol = (() => {
    try { return new URL(parsed.url).protocol.toLowerCase(); } catch { return ""; }
  })();
  if (!CUSTOM_PROXY_PROTOCOLS.has(protocol)) {
    throw new Error("Proxy protocol must be http, https, socks, or socks5.");
  }
  return parsed;
}

export function normalizeCustomUpstreamProxyUrl(rawUrl?: string | null) {
  const value = String(rawUrl || "").trim();
  if (!value) return "";
  return createCustomUpstreamProxyEntry(value).url;
}

function getProxySourcePairs(pool: UpstreamProxyPool): Array<[UpstreamProxyEntry["source"], string]> {
  const publicPairs: Array<[UpstreamProxyEntry["source"], string]> = [
    ["UPSTREAM_PROXY_LIST", process.env.UPSTREAM_PROXY_LIST || ""],
    ["UPI_PROXY_LIST", process.env.UPI_PROXY_LIST || ""],
    ["UPSTREAM_PROXY", process.env.UPSTREAM_PROXY || ""],
  ];

  if (pool === "public") return publicPairs;

  const premiumPairs: Array<[UpstreamProxyEntry["source"], string]> = [
    ["PREMIUM_UPSTREAM_PROXY_LIST", process.env.PREMIUM_UPSTREAM_PROXY_LIST || ""],
    ["PREMIUM_UPI_PROXY_LIST", process.env.PREMIUM_UPI_PROXY_LIST || ""],
    ["PREMIUM_UPSTREAM_PROXY", process.env.PREMIUM_UPSTREAM_PROXY || ""],
  ];

  // Premium 先保留独立代理池入口；未单独配置时临时复用公共池。
  return premiumPairs.some(([, value]) => splitProxyList(value).length > 0) ? premiumPairs : publicPairs;
}

function entriesFromProxyUrls(urls: string[], source: UpstreamProxyEntry["source"]) {
  const seen = new Set<string>();
  const entries: UpstreamProxyEntry[] = [];
  for (const proxy of urls) {
    const parsed = parseProxyUrl(proxy, entries.length, source);
    if (!parsed || seen.has(parsed.url)) continue;
    seen.add(parsed.url);
    entries.push(parsed);
  }
  return entries;
}

function getEnvConfiguredUpstreamProxies(pool: UpstreamProxyPool = "public"): UpstreamProxyEntry[] {
  const pairs = getProxySourcePairs(pool);
  const urls: string[] = [];
  for (const [, value] of pairs) {
    for (const proxy of splitProxyList(value)) {
      urls.push(proxy);
    }
  }
  return entriesFromProxyUrls(urls, pairs[0]?.[0] || "UPSTREAM_PROXY_LIST");
}

async function getStoredProxyUrls(pool: UpstreamProxyPool) {
  const setting = await prisma.systemSetting.findUnique({
    where: { key: PROXY_LIST_SETTING_KEYS[pool] },
    select: { value: true },
  });
  return typeof setting?.value === "string" ? splitProxyList(setting.value) : null;
}

export async function getConfiguredUpstreamProxies(pool: UpstreamProxyPool = "public"): Promise<UpstreamProxyEntry[]> {
  const storedUrls = await getStoredProxyUrls(pool);
  if (storedUrls) {
    return entriesFromProxyUrls(storedUrls, pool === "premium" ? "ADMIN_PREMIUM_PROXY_LIST" : "ADMIN_PUBLIC_PROXY_LIST");
  }
  return getEnvConfiguredUpstreamProxies(pool);
}

export async function getEditableUpstreamProxyUrls(pool: UpstreamProxyPool = "public") {
  const storedUrls = await getStoredProxyUrls(pool);
  if (storedUrls) return storedUrls;
  return getEnvConfiguredUpstreamProxies(pool).map((entry) => entry.url);
}

function normalizeProxyUrlsFromInput(input: string | string[]) {
  const rawUrls = Array.isArray(input) ? input : splitProxyList(input);
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const raw of rawUrls) {
    const parsed = parseProxyUrl(raw, urls.length, "ADMIN_PUBLIC_PROXY_LIST");
    if (!parsed) throw new Error(`代理地址格式错误：${redactProxyUrl(raw)}`);
    if (seen.has(parsed.url)) continue;
    seen.add(parsed.url);
    urls.push(parsed.url);
  }
  return urls;
}

export async function setEditableUpstreamProxyUrls(pool: UpstreamProxyPool, input: string | string[]) {
  const urls = normalizeProxyUrlsFromInput(input);
  await prisma.systemSetting.upsert({
    where: { key: PROXY_LIST_SETTING_KEYS[pool] },
    update: { value: urls.join("\n") },
    create: { key: PROXY_LIST_SETTING_KEYS[pool], value: urls.join("\n") },
  });
  await setUpstreamProxySelection(AUTO_PROXY_SELECTION, pool);
  return getConfiguredUpstreamProxies(pool);
}

export async function addEditableUpstreamProxy(pool: UpstreamProxyPool, proxyUrl: string) {
  const current = await getEditableUpstreamProxyUrls(pool);
  return setEditableUpstreamProxyUrls(pool, [...current, proxyUrl]);
}

export async function deleteEditableUpstreamProxy(pool: UpstreamProxyPool, proxyId: string) {
  const entries = await getConfiguredUpstreamProxies(pool);
  const target = entries.find((entry) => entry.id === proxyId);
  if (!target) throw new Error("代理不存在或已被删除");
  const urls = entries.filter((entry) => entry.id !== proxyId).map((entry) => entry.url);
  return setEditableUpstreamProxyUrls(pool, urls);
}

export function toPublicUpstreamProxy(entry: UpstreamProxyEntry): PublicUpstreamProxy {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { url, ...publicEntry } = entry;
  return publicEntry;
}

export function selectUpstreamProxy() {
  const proxies = getEnvConfiguredUpstreamProxies();
  if (proxies.length === 0) return "";
  const selected = proxies[roundRobinCursorByPool.public % proxies.length];
  roundRobinCursorByPool.public = (roundRobinCursorByPool.public + 1) % Math.max(proxies.length, 1);
  return selected.url;
}

async function getStoredProxySelection(pool: UpstreamProxyPool = "public") {
  const setting = await prisma.systemSetting.findUnique({
    where: { key: PROXY_SELECTION_KEYS[pool] },
    select: { value: true },
  });
  return setting?.value || AUTO_PROXY_SELECTION;
}

export async function getUpstreamProxySelection(pool: UpstreamProxyPool = "public"): Promise<UpstreamProxySelection> {
  const proxies = await getConfiguredUpstreamProxies(pool);
  const selectedProxyId = await getStoredProxySelection(pool);
  const selectedProxy = proxies.find((proxy) => proxy.id === selectedProxyId) || null;
  return {
    selectedProxyId: selectedProxy ? selectedProxy.id : AUTO_PROXY_SELECTION,
    selectedProxy: selectedProxy ? toPublicUpstreamProxy(selectedProxy) : null,
    mode: selectedProxy ? "MANUAL" : "AUTO",
  };
}

export async function setUpstreamProxySelection(selectedProxyId: string, pool: UpstreamProxyPool = "public") {
  const proxies = await getConfiguredUpstreamProxies(pool);
  const normalized = selectedProxyId === AUTO_PROXY_SELECTION || !selectedProxyId ? AUTO_PROXY_SELECTION : selectedProxyId;
  if (normalized !== AUTO_PROXY_SELECTION && !proxies.some((proxy) => proxy.id === normalized)) {
    throw new Error("代理不存在或已不在当前代理列表中");
  }

  await prisma.systemSetting.upsert({
    where: { key: PROXY_SELECTION_KEYS[pool] },
    update: { value: normalized },
    create: { key: PROXY_SELECTION_KEYS[pool], value: normalized },
  });

  return getUpstreamProxySelection(pool);
}

export async function getUpstreamProxyPlan(pool: UpstreamProxyPool = "public") {
  const proxies = await getConfiguredUpstreamProxies(pool);
  if (proxies.length === 0) return [] as UpstreamProxyEntry[];

  const selectedProxyId = await getStoredProxySelection(pool);
  const selected = selectedProxyId !== AUTO_PROXY_SELECTION ? proxies.find((proxy) => proxy.id === selectedProxyId) : null;
  if (selected) {
    return [selected, ...proxies.filter((proxy) => proxy.id !== selected.id)];
  }

  const start = roundRobinCursorByPool[pool] % proxies.length;
  roundRobinCursorByPool[pool] = (roundRobinCursorByPool[pool] + 1) % Math.max(proxies.length, 1);
  return [...proxies.slice(start), ...proxies.slice(0, start)];
}

function proxyAgent(proxyUrl: string) {
  if (!agentCache.has(proxyUrl)) {
    const protocol = (() => {
      try {
        return new URL(proxyUrl).protocol.toLowerCase();
      } catch {
        return "";
      }
    })();
    agentCache.set(proxyUrl, protocol === "socks5:" || protocol === "socks:" ? new Socks5ProxyAgent(proxyUrl) : new ProxyAgent(proxyUrl));
  }
  return agentCache.get(proxyUrl);
}

export async function fetchWithUpstreamProxy(url: string, init: RequestInit = {}, proxyUrl = "") {
  const dispatcher = proxyUrl ? proxyAgent(proxyUrl) : undefined;
  if (!dispatcher) return fetch(url, init);
  return undiciFetch(url, {
    ...init,
    dispatcher,
  } as unknown as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
}

async function fetchWithProbeTimeout(url: string, init: RequestInit, proxyUrl: string, timeoutMs: number, label: string) {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error(`${label} 超时 ${Math.ceil(timeoutMs / 1000)} 秒`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      fetchWithUpstreamProxy(
        url,
        {
          ...init,
          signal: controller.signal,
        },
        proxyUrl
      ),
      timeoutPromise,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function compactError(error: unknown) {
  const cause = error && typeof error === "object" && "cause" in error ? String((error as { cause?: unknown }).cause || "") : "";
  const text = error instanceof Error ? `${error.name}: ${error.message}${cause ? ` | cause: ${cause}` : ""}` : String(error);
  return text.replace(/(:\/\/[^:@/]+):([^@/]+)@/g, "$1:<PASSWORD_REDACTED>@").slice(0, 400);
}

async function fetchStatus(url: string, proxyUrl: string, timeoutMs: number) {
  const response = await fetchWithProbeTimeout(
    url,
    {
      headers: {
        Accept: "application/json,text/html,*/*",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      },
      cache: "no-store",
    },
    proxyUrl,
    timeoutMs,
    url
  );
  await response.arrayBuffer().catch(() => null);
  return response.status;
}

function getString(data: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

type ExitProbeInfo = {
  ip: string;
  country: string;
  countryCode: string;
  region: string;
  city: string;
  org: string;
  asn: string;
};

function getRecord(data: Record<string, unknown>, key: string) {
  const value = data[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parseIpWhoIs(data: Record<string, unknown>): ExitProbeInfo {
  if (data.success === false) {
    const message = getString(data, ["message"]) || getString(data, ["error"]) || "ipwho.is failed";
    throw new Error(message);
  }
  const connection = getRecord(data, "connection");
  return {
    ip: getString(data, ["ip"]),
    country: getString(data, ["country"]),
    countryCode: getString(data, ["country_code"]).toUpperCase(),
    region: getString(data, ["region"]),
    city: getString(data, ["city"]),
    org: getString(connection, ["org", "isp"]),
    asn: getString(connection, ["asn"]),
  };
}

function parseIpify(data: Record<string, unknown>): ExitProbeInfo {
  return {
    ip: getString(data, ["ip"]),
    country: "",
    countryCode: "",
    region: "",
    city: "",
    org: "",
    asn: "",
  };
}

function parseIfconfig(data: Record<string, unknown>): ExitProbeInfo {
  return {
    ip: getString(data, ["ip"]),
    country: getString(data, ["country"]),
    countryCode: getString(data, ["country_iso", "country_code"]).toUpperCase(),
    region: getString(data, ["region"]),
    city: getString(data, ["city"]),
    org: getString(data, ["asn_org", "org"]),
    asn: getString(data, ["asn"]),
  };
}

const EXIT_PROBES = [
  { label: "ipwho.is", url: "https://ipwho.is/", parse: parseIpWhoIs },
  { label: "api.ipify.org", url: "https://api.ipify.org?format=json", parse: parseIpify },
  { label: "ifconfig.co", url: "https://ifconfig.co/json", parse: parseIfconfig },
] as const;

async function probeProxyExitInfo(proxyUrl: string, timeoutMs: number) {
  const failures: string[] = [];
  for (const probe of EXIT_PROBES) {
    try {
      const response = await fetchWithProbeTimeout(
        probe.url,
        {
          headers: { Accept: "application/json,text/plain,*/*", "User-Agent": "Mozilla/5.0" },
          cache: "no-store",
        },
        proxyUrl,
        timeoutMs,
        `出口检测 ${probe.label}`
      );
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 120)}`);
      const data = JSON.parse(text) as Record<string, unknown>;
      const info = probe.parse(data);
      if (!info.ip) throw new Error("missing ip in response");
      return { info, failures };
    } catch (error) {
      failures.push(`${probe.label}: ${compactError(error)}`);
    }
  }
  throw new Error(failures.join(" | ") || "出口检测失败");
}

export async function checkUpstreamProxy(entry: UpstreamProxyEntry, options?: { timeoutMs?: number; expectedCountry?: string }): Promise<UpstreamProxyCheckResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_PROXY_TIMEOUT_MS;
  const expectedCountryInput = Object.prototype.hasOwnProperty.call(options || {}, "expectedCountry")
    ? options?.expectedCountry
    : process.env.UPSTREAM_PROXY_EXPECTED_COUNTRY || DEFAULT_EXPECTED_COUNTRY;
  const expectedCountry = String(expectedCountryInput || "").trim().toUpperCase();
  const started = Date.now();
  const checkedAt = new Date().toISOString();
  const warnings: string[] = [];

  let ip = "";
  let country = "";
  let countryCode = "";
  let region = "";
  let city = "";
  let org = "";
  let asn = "";
  let chatgptStatus: number | undefined;
  let stripeStatus: number | undefined;
  let telegramStatus: number | undefined;
  let error = "";

  await Promise.all([
    (async () => {
      try {
        const exit = await probeProxyExitInfo(entry.url, timeoutMs);
        ip = exit.info.ip;
        country = exit.info.country;
        countryCode = exit.info.countryCode;
        region = exit.info.region;
        city = exit.info.city;
        org = exit.info.org;
        asn = exit.info.asn;
        if (exit.failures.length > 0) {
          warnings.push(...exit.failures.map((item) => `出口检测备用源: ${item}`));
        }
      } catch (checkError) {
        error = compactError(checkError);
      }
    })(),
    (async () => {
      try {
        chatgptStatus = await fetchStatus("https://chatgpt.com/api/auth/session", entry.url, timeoutMs);
      } catch (checkError) {
        warnings.push(`ChatGPT: ${compactError(checkError)}`);
      }
    })(),
    (async () => {
      try {
        stripeStatus = await fetchStatus("https://api.stripe.com/", entry.url, timeoutMs);
      } catch (checkError) {
        warnings.push(`Stripe: ${compactError(checkError)}`);
      }
    })(),
    (async () => {
      try {
        telegramStatus = await fetchStatus("https://api.telegram.org/", entry.url, timeoutMs);
      } catch (checkError) {
        warnings.push(`Telegram: ${compactError(checkError)}`);
      }
    })(),
  ]);

  if (expectedCountry && countryCode && countryCode !== expectedCountry) {
    warnings.push(`出口国家为 ${countryCode}，不是预期的 ${expectedCountry}`);
  }

  const chatgptReachable = typeof chatgptStatus === "number" && chatgptStatus < 500;
  const stripeReachable = typeof stripeStatus === "number" && stripeStatus < 500;
  const countryOk = !expectedCountry || countryCode === expectedCountry || (!countryCode && country.toUpperCase() === expectedCountry);
  const ok = Boolean(ip && countryOk && chatgptReachable && stripeReachable && !error);

  return {
    ...toPublicUpstreamProxy(entry),
    ok,
    expectedCountry,
    checkedAt,
    latencyMs: Date.now() - started,
    ip,
    country,
    countryCode,
    region,
    city,
    org,
    asn,
    chatgptStatus,
    stripeStatus,
    telegramStatus,
    error: error || undefined,
    warnings,
  };
}

export async function checkConfiguredUpstreamProxies(options?: { timeoutMs?: number; expectedCountry?: string; pool?: UpstreamProxyPool }): Promise<UpstreamProxyCheckSummary> {
  const proxies = await getConfiguredUpstreamProxies(options?.pool || "public");
  const expectedCountryInput = Object.prototype.hasOwnProperty.call(options || {}, "expectedCountry")
    ? options?.expectedCountry
    : process.env.UPSTREAM_PROXY_EXPECTED_COUNTRY || DEFAULT_EXPECTED_COUNTRY;
  const expectedCountry = String(expectedCountryInput || "").trim().toUpperCase();
  const checkedAt = new Date().toISOString();
  const results = await Promise.all(proxies.map((entry) => checkUpstreamProxy(entry, { ...options, expectedCountry })));
  const okCount = results.filter((result) => result.ok).length;
  return {
    checkedAt,
    total: results.length,
    ok: okCount,
    failed: results.length - okCount,
    expectedCountry,
    results,
  };
}
