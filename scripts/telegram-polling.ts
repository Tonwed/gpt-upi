import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { ProxyAgent, setGlobalDispatcher } from "undici";

function loadDotEnv() {
  for (const filename of [".env.local", ".env"]) {
    try {
      const content = readFileSync(resolve(process.cwd(), filename), "utf8");
      for (const line of content.split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
        if (!match) continue;
        const [, key, rawValue] = match;
        if (process.env[key]) continue;
        process.env[key] = rawValue.trim().replace(/^"(.*)"$/, "$1");
      }
    } catch {
      // optional env files
    }
  }
}

loadDotEnv();
process.env.UPI_EXTRACT_RUNNER ||= "external";

function ensureProxyUrl(proxy: string) {
  if (/^[a-z]+:\/\//i.test(proxy)) return proxy;
  return `http://${proxy}`;
}

function readWindowsProxy() {
  if (process.platform !== "win32") return null;

  try {
    const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
    const enabledOutput = execFileSync("reg", ["query", key, "/v", "ProxyEnable"], { encoding: "utf8" });
    if (!/\bProxyEnable\b[\s\S]*0x1/i.test(enabledOutput)) return null;

    const serverOutput = execFileSync("reg", ["query", key, "/v", "ProxyServer"], { encoding: "utf8" });
    const match = serverOutput.match(/\bProxyServer\b\s+REG_SZ\s+(.+)\s*$/im);
    const proxyServer = match?.[1]?.trim();
    if (!proxyServer) return null;

    const entries = proxyServer.split(";").map((entry) => entry.trim()).filter(Boolean);
    const httpsEntry = entries.find((entry) => entry.toLowerCase().startsWith("https="));
    const httpEntry = entries.find((entry) => entry.toLowerCase().startsWith("http="));
    const selected = (httpsEntry || httpEntry)?.split("=").slice(1).join("=") || entries[0];
    return ensureProxyUrl(selected);
  } catch {
    return null;
  }
}

function getProxyUrl() {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    readWindowsProxy()
  );
}

function redactProxy(proxyUrl: string) {
  try {
    const url = new URL(proxyUrl);
    if (url.username) url.username = "***";
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return proxyUrl;
  }
}

const proxyUrl = getProxyUrl();
if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
  console.log(`Telegram polling using proxy: ${redactProxy(proxyUrl)}`);
} else {
  console.log("Telegram polling proxy not configured. If Telegram is unreachable, set HTTPS_PROXY, e.g. HTTPS_PROXY=http://127.0.0.1:7890");
}

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is not configured");
  process.exit(1);
}

async function callTelegram<T>(method: string, payload: unknown): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = (await response.json().catch(async () => ({
    ok: false,
    description: await response.text().catch(() => ""),
  }))) as { ok: boolean; result?: T; description?: string };

  if (!response.ok || !data.ok) {
    throw new Error(`${method} failed: HTTP ${response.status} ${data.description || JSON.stringify(data)}`);
  }

  return data.result as T;
}

function formatError(error: unknown) {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? ` | cause: ${error.cause.name}: ${error.cause.message}` : "";
  return `${error.name}: ${error.message}${cause}`;
}

async function main() {
  const { handleTelegramUpdate, setTelegramBotCommands } = await import("../src/lib/server/telegram-bot");
  const { startBscDepositWatcher } = await import("../src/lib/server/bsc-deposit-watcher");
  const { autoAssignPendingOrder, expireStaleOrders } = await import("../src/lib/server/orders");
  const { autoCheckPublicScanGraceOrders } = await import("../src/lib/server/subscription-checks");
  const { retryAutoPublishedScanOrdersReturnedBeforeAcceptance } = await import("../src/lib/server/public-upi-extract-queue");
  const { notifyWorkerAutoAccepted } = await import("../src/lib/server/telegram-notifications");
  let offset = 0;
  let autoAssignRunning = false;
  let autoSubscriptionCheckRunning = false;

  async function runServerAutoAssign() {
    if (autoAssignRunning) return;
    autoAssignRunning = true;
    try {
      await expireStaleOrders();
      await retryAutoPublishedScanOrdersReturnedBeforeAcceptance();

      for (let index = 0; index < 20; index += 1) {
        const result = await autoAssignPendingOrder();
        if (!result) break;

        console.log(`Server auto-assigned ${result.order.orderNo} to worker ${result.worker.id}`);
        if (result.worker.autoAcceptNotifyEnabled && result.worker.telegramUserId) {
          try {
            await notifyWorkerAutoAccepted({ chatId: result.worker.telegramUserId, order: result.order });
          } catch (notifyError) {
            console.error(`Telegram auto-accept notification failed: ${formatError(notifyError)}`);
          }
        }
      }
    } catch (error) {
      console.error(`Server auto-assign failed: ${formatError(error)}`);
    } finally {
      autoAssignRunning = false;
    }
  }

  async function runServerAutoSubscriptionCheck() {
    if (autoSubscriptionCheckRunning) return;
    autoSubscriptionCheckRunning = true;
    try {
      const result = await autoCheckPublicScanGraceOrders();
      if (result.checked > 0) {
        console.log(`Auto subscription check: checked=${result.checked}, completed=${result.completed}, failed=${result.failed}`);
      }
    } catch (error) {
      console.error(`Auto subscription check failed: ${formatError(error)}`);
    } finally {
      autoSubscriptionCheckRunning = false;
    }
  }

  try {
    await setTelegramBotCommands();
    console.log("Telegram bot commands registered.");
  } catch (error) {
    console.error(`Telegram bot command registration failed: ${formatError(error)}`);
  }

  void runServerAutoAssign();
  void runServerAutoSubscriptionCheck();
  setInterval(() => void runServerAutoAssign(), 3000);
  setInterval(() => void runServerAutoSubscriptionCheck(), 5000);
  console.log("Server-side auto-assign loop started.");
  console.log("Server-side auto subscription check loop started.");
  startBscDepositWatcher();

  console.log("Telegram polling started. Handling updates directly.");

  while (true) {
    try {
      const updates = await callTelegram<Array<{ update_id: number }>>("getUpdates", {
        offset,
        timeout: 25,
        allowed_updates: ["message", "callback_query"],
      });

      for (const update of updates) {
        offset = update.update_id + 1;
        await handleTelegramUpdate(update);
      }
    } catch (error) {
      console.error(formatError(error));
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 3000));
    }
  }
}

void main();
