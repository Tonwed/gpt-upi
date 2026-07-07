import { randomBytes } from "crypto";
import { execFileSync } from "node:child_process";
import bcrypt from "bcryptjs";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { prisma } from "@/lib/server/prisma";
import {
  approveTelegramLoginCode,
  isAllowedAdmin,
  normalizeTelegramUsername,
  type TelegramLoginActor,
} from "@/lib/server/telegram-login";
import {
  getPublicUpiExtractUserHistoryPage,
  type PublicUpiExtractActivity,
  type PublicUpiExtractUserHistoryFilter,
} from "@/lib/server/public-upi-extract-queue";

type TelegramUser = {
  id: number;
  username?: string;
  first_name?: string;
};

type TelegramMessage = {
  message_id: number;
  chat: { id: number };
  from?: TelegramUser;
  text?: string;
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: {
    id: string;
    from: TelegramUser;
    data?: string;
    message?: TelegramMessage;
  };
};

export const TELEGRAM_BOT_COMMANDS = [
  { command: "start", description: "Show login instructions" },
  { command: "login", description: "Confirm a web login code" },
  { command: "worker", description: "Confirm a worker login code" },
  { command: "tasks", description: "View extraction tasks" },
  { command: "help", description: "Show help" },
];

export const TELEGRAM_ADMIN_BOT_COMMANDS = [
  ...TELEGRAM_BOT_COMMANDS,
  { command: "admin", description: "Confirm an admin login code" },
  { command: "reg", description: "Admin: register or update a worker" },
];

let proxyConfigured = false;
const TASKS_PAGE_SIZE = 5;
const TASK_FILTERS: PublicUpiExtractUserHistoryFilter[] = ["all", "active", "completed", "failed"];

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

function configureTelegramProxy() {
  if (proxyConfigured) return;
  proxyConfigured = true;

  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    readWindowsProxy();

  if (proxyUrl) setGlobalDispatcher(new ProxyAgent(ensureProxyUrl(proxyUrl)));
}

function getTelegramBotToken() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  return token;
}

function extractLoginCode(text: string) {
  const trimmed = text.trim();
  const startPayloadMatch = trimmed.match(/^\/start(?:@\w+)?\s+(?:login_)?([a-z0-9]{8})$/i);
  if (startPayloadMatch) return startPayloadMatch[1];

  const commandMatch = trimmed.match(/^\/(?:login|worker|admin)(?:@\w+)?\s+([a-z0-9]{1,32})$/i);
  if (commandMatch) return commandMatch[1];

  const codeMatch = trimmed.match(/^[a-z0-9]{8}$/i);
  if (codeMatch) return trimmed;

  return null;
}

function parseRegCommand(text: string) {
  if (!/^\/reg(?:@\w+)?(?:\s|$)/i.test(text)) return null;
  const match = text.trim().match(/^\/reg(?:@\w+)?\s+@?([a-z0-9_]{1,32})\s+(\d+(?:\.\d{1,4})?)$/i);
  if (!match) {
    return { ok: false as const, message: "Invalid format. Usage: /reg @username 0.70" };
  }

  const telegramUsername = normalizeTelegramUsername(match[1]);
  const unitPrice = Number(match[2]);
  if (!telegramUsername) return { ok: false as const, message: "Invalid Telegram username." };
  if (!Number.isFinite(unitPrice) || unitPrice < 0) return { ok: false as const, message: "Unit price must be a number greater than or equal to 0." };

  return {
    ok: true as const,
    telegramUsername,
    unitPrice: unitPrice.toFixed(2),
  };
}

function getHelpText(isAdmin = false) {
  return [
    "UPI Scanner Login Bot",
    "",
    "1. Open /, /worker, or /admin in the web app.",
    "2. Copy the 8-character login code shown on the page.",
    "3. Send it here, for example: /login A7K9Q2P4",
    "You can also use the page button to open this bot with the code prefilled.",
    "",
    "Each Telegram account can try at most 3 login codes every 5 minutes.",
    "/admin can only be confirmed by the configured admin Telegram account.",
    "/worker can only be confirmed by registered worker Telegram accounts.",
    "",
    "Useful commands:",
    "/tasks  View your extraction tasks.",
    ...(isAdmin
      ? [
          "",
          "Admin commands:",
          "/admin CODE  Confirm an admin login code.",
          "/reg @username 0.70  Register or update a worker and set the unit price.",
        ]
      : []),
  ].join("\n");
}

async function registerWorkerByTelegram(actor: TelegramLoginActor, telegramUsername: string, unitPrice: string) {
  if (!isAllowedAdmin(actor)) {
    return "This Telegram account is not allowed to register workers.";
  }

  const existing = await prisma.worker.findFirst({
    where: {
      OR: [
        { username: telegramUsername },
        { telegramUsername },
      ],
    },
    select: { id: true },
  });

  if (existing) {
    await prisma.worker.update({
      where: { id: existing.id },
      data: {
        username: telegramUsername,
        displayName: `@${telegramUsername}`,
        telegramUsername,
        unitPrice,
      },
    });
  } else {
    const passwordHash = await bcrypt.hash(randomBytes(24).toString("base64url"), 10);
    await prisma.worker.create({
      data: {
        username: telegramUsername,
        displayName: `@${telegramUsername}`,
        passwordHash,
        telegramUsername,
        unitPrice,
      },
    });
  }

  return `Worker @${telegramUsername} has been registered/updated with unit price $${Number(unitPrice).toFixed(2)} per order. Ask them to open /worker and send the 8-character login code shown on the page to this bot.`;
}

async function callTelegramMethod<T>(method: string, payload: unknown, timeoutMs = 8000): Promise<T> {
  configureTelegramProxy();
  const token = getTelegramBotToken();
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(async () => ({
    ok: false,
    description: await response.text().catch(() => ""),
  })) as { ok: boolean; result?: T; description?: string };

  if (!response.ok || !data.ok) {
    throw new Error(`Telegram ${method} failed: ${response.status} ${data.description || JSON.stringify(data)}`);
  }

  return data.result as T;
}

export async function sendTelegramMessage(chatId: number | string, text: string, replyMarkup?: unknown) {
  await callTelegramMethod("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

async function editTelegramMessageText(chatId: number | string, messageId: number, text: string, replyMarkup?: unknown) {
  await callTelegramMethod("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

async function answerCallbackQuery(callbackQueryId: string, text?: string) {
  await callTelegramMethod("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
  });
}

export async function setTelegramBotCommands() {
  await callTelegramMethod("deleteWebhook", { drop_pending_updates: false });
  await callTelegramMethod("setMyCommands", { commands: TELEGRAM_BOT_COMMANDS });
  const adminId = process.env.TELEGRAM_ADMIN_ID;
  if (adminId) {
    await callTelegramMethod("setMyCommands", {
      commands: TELEGRAM_ADMIN_BOT_COMMANDS,
      scope: { type: "chat", chat_id: adminId },
    });
  }
}

async function sendTelegramPhotoRequest(chatId: number | string, photo: Buffer | Uint8Array, caption?: string) {
  configureTelegramProxy();
  const token = getTelegramBotToken();
  const form = new FormData();
  const bytes = new Uint8Array(Buffer.from(photo));
  form.set("chat_id", String(chatId));
  form.set("photo", new Blob([bytes], { type: "image/png" }), "upi-qr.png");
  if (caption) form.set("caption", caption.slice(0, 1024));

  const response = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: "POST",
    signal: AbortSignal.timeout(15000),
    body: form,
  });

  if (!response.ok) {
    const payload = await response.text().catch(() => "");
    throw new Error(`Telegram sendPhoto failed: ${response.status} ${payload}`);
  }
}

export async function sendTelegramPhoto(chatId: number | string, photo: Buffer | Uint8Array, caption?: string) {
  await sendTelegramPhotoRequest(chatId, photo, caption);
}

function parseTaskFilter(value?: string | null): PublicUpiExtractUserHistoryFilter {
  const normalized = String(value || "").trim().toLowerCase();
  return TASK_FILTERS.includes(normalized as PublicUpiExtractUserHistoryFilter)
    ? normalized as PublicUpiExtractUserHistoryFilter
    : "all";
}

function taskStatusLabel(status: PublicUpiExtractActivity["status"]) {
  if (status === "completed") return "Success";
  if (status === "failed") return "Failed";
  if (status === "running") return "Running";
  return "Queued";
}

function shortJobId(jobId: string) {
  return jobId.length <= 12 ? jobId : `${jobId.slice(0, 8)}…${jobId.slice(-6)}`;
}

function formatTaskTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "-";
  return date.toLocaleString("en-US", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatTaskLine(item: PublicUpiExtractActivity, index: number) {
  const account = item.accountEmail || item.accountPhone || "account hidden";
  const subscription = item.subscriptionIsPlus === true
    ? "Plus"
    : item.subscriptionIsPlus === false
      ? (item.subscriptionPlan || "Free")
      : "Unknown";
  const error = item.error ? `\n   Reason: ${item.error.slice(0, 120)}` : "";
  return [
    `${index}. ${shortJobId(item.jobId)} · ${taskStatusLabel(item.status)}`,
    `   ${account}`,
    `   Subscription: ${subscription}`,
    `   Updated: ${formatTaskTime(item.updatedAt)}`,
    error,
  ].join("\n");
}

function taskFilterTitle(filter: PublicUpiExtractUserHistoryFilter) {
  if (filter === "active") return "Active";
  if (filter === "completed") return "Success";
  if (filter === "failed") return "Failed";
  return "All";
}

function buildTaskListKeyboard(filter: PublicUpiExtractUserHistoryFilter, page: number, totalPages: number) {
  const filterRow = TASK_FILTERS.map((item) => ({
    text: `${item === filter ? "● " : ""}${taskFilterTitle(item)}`,
    callback_data: `tasks:${item}:1`,
  }));
  const navRow = [
    {
      text: "‹ Prev",
      callback_data: `tasks:${filter}:${Math.max(1, page - 1)}`,
    },
    {
      text: `${page}/${totalPages}`,
      callback_data: `tasks:${filter}:${page}`,
    },
    {
      text: "Next ›",
      callback_data: `tasks:${filter}:${Math.min(totalPages, page + 1)}`,
    },
  ];
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "http://127.0.0.1:3001").replace(/\/+$/, "");
  return {
    inline_keyboard: [
      filterRow,
      navRow,
      [{ text: "Open web page", url: `${appUrl}/` }],
    ],
  };
}

async function buildTaskListMessage(telegramUserId: string, filter: PublicUpiExtractUserHistoryFilter, page: number) {
  const history = await getPublicUpiExtractUserHistoryPage({
    telegramUserId,
    status: filter,
    page,
    pageSize: TASKS_PAGE_SIZE,
  });
  const safePage = history.pagination.page;
  const totalPages = history.pagination.totalPages;
  const lines = history.items.map((item, index) => formatTaskLine(item, (safePage - 1) * history.pagination.pageSize + index + 1));
  const text = [
    `UPI extraction tasks · ${taskFilterTitle(history.filter)}`,
    `Page ${safePage}/${totalPages} · ${history.pagination.total} total`,
    "",
    lines.length > 0 ? lines.join("\n\n") : "No tasks in this filter.",
  ].join("\n");

  return {
    text,
    keyboard: buildTaskListKeyboard(history.filter, safePage, totalPages),
  };
}

async function sendTaskList(chatId: number | string, telegramUserId: string, filter = "all", page = 1) {
  const parsedFilter = parseTaskFilter(filter);
  const message = await buildTaskListMessage(telegramUserId, parsedFilter, page);
  await sendTelegramMessage(chatId, message.text, message.keyboard);
}

async function handleTaskListCallback(update: NonNullable<TelegramUpdate["callback_query"]>) {
  const data = String(update.data || "");
  const match = data.match(/^tasks:(all|active|completed|failed):(\d+)$/);
  if (!match || !update.message) return false;
  const filter = parseTaskFilter(match[1]);
  const page = Math.max(1, Math.floor(Number(match[2]) || 1));
  const chatId = update.message.chat.id;
  const messageId = update.message.message_id;
  const telegramUserId = String(update.from.id);
  const message = await buildTaskListMessage(telegramUserId, filter, page);
  await editTelegramMessageText(chatId, messageId, message.text, message.keyboard);
  await answerCallbackQuery(update.id);
  return true;
}

export async function handleTelegramUpdate(update: TelegramUpdate) {
  if (update.callback_query) {
    if (await handleTaskListCallback(update.callback_query)) return { handled: true };
    await answerCallbackQuery(update.callback_query.id).catch(() => undefined);
    return { handled: false };
  }

  const message = update.message;
  if (!message?.text || !message.from) return { handled: false };

  const text = message.text.trim();
  const chatId = message.chat.id;
  const actor: TelegramLoginActor = {
    id: String(message.from.id),
    username: message.from.username,
    firstName: message.from.first_name,
  };

  const regCommand = parseRegCommand(text);
  if (regCommand) {
    if (!isAllowedAdmin(actor)) {
      await sendTelegramMessage(chatId, "This command is not available.");
      return { handled: true };
    }
    const reply = regCommand.ok
      ? await registerWorkerByTelegram(actor, regCommand.telegramUsername, regCommand.unitPrice)
      : regCommand.message;
    await sendTelegramMessage(chatId, reply);
    return { handled: true };
  }

  const tasksMatch = text.match(/^\/tasks(?:@\w+)?(?:\s+(all|active|completed|failed))?(?:\s+(\d+))?$/i);
  if (tasksMatch) {
    await sendTaskList(chatId, actor.id, tasksMatch[1] || "all", Number(tasksMatch[2] || 1));
    return { handled: true };
  }

  const code = extractLoginCode(text);

  if (!code) {
    if (/^\/(?:start|help|worker|admin|reg|tasks)(?:@\w+)?$/i.test(text)) {
      await sendTelegramMessage(chatId, getHelpText(isAllowedAdmin(actor)));
      return { handled: true };
    }
    return { handled: false };
  }

  const result = await approveTelegramLoginCode(code, actor);
  await sendTelegramMessage(chatId, result.message);
  return { handled: true, result };
}
