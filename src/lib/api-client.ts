import type { ApiResult } from "@/lib/types/app";

function compactResponseText(text: string) {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function nonJsonErrorMessage(response: Response, text: string) {
  const compact = compactResponseText(text);
  const status = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
  if (compact) return `Server returned non-JSON (${status}): ${compact}`;
  return `Server returned non-JSON (${status}). Please check the server logs.`;
}

export async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const isFormData = init?.body instanceof FormData;
  const response = await fetch(url, {
    cache: init?.cache ?? "no-store",
    credentials: init?.credentials ?? "same-origin",
    ...init,
    headers: isFormData
      ? { Accept: "application/json", ...(init?.headers || {}) }
      : { Accept: "application/json", "Content-Type": "application/json", ...(init?.headers || {}) },
  });

  const text = await response.text();
  let payload: ApiResult<T> | null = null;
  try {
    payload = JSON.parse(text || "{}") as ApiResult<T>;
  } catch {
    throw new Error(nonJsonErrorMessage(response, text));
  }

  if (!payload || typeof payload !== "object" || !("ok" in payload)) {
    throw new Error(nonJsonErrorMessage(response, text));
  }
  if (!payload.ok) {
    const fallback = `Request failed (HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""})`;
    throw new Error(payload.message || fallback);
  }
  return payload.data;
}

export function formatDateTime(value?: string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function formatFullDate(value?: string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

export function formatMoney(value?: number | string | null) {
  const amount = Number(value ?? 0);
  return `$${Number.isFinite(amount) ? amount.toFixed(2) : "0.00"}`;
}
