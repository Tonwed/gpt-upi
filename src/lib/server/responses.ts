import { NextResponse } from "next/server";

const JWT_RE = /(?<![A-Za-z0-9_-])(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)(?!\.[A-Za-z0-9_-])/g;
const SESSION_TOKEN_RE = /[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+/g;

const JSON_NO_STORE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  Pragma: "no-cache",
  Expires: "0",
};

function withNoStoreHeaders(init?: ResponseInit) {
  return {
    ...init,
    headers: {
      ...JSON_NO_STORE_HEADERS,
      ...(init?.headers || {}),
    },
  };
}

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ ok: true, data }, withNoStoreHeaders(init));
}

export function fail(message: string, status = 400, details?: unknown) {
  return NextResponse.json({ ok: false, message, details }, withNoStoreHeaders({ status }));
}

export function isResponseError(error: unknown): error is Response {
  return error instanceof Response;
}

function compactRouteError(error: unknown) {
  const cause = error && typeof error === "object" && "cause" in error ? String((error as { cause?: unknown }).cause || "") : "";
  const text = error instanceof Error ? `${error.name}: ${error.message}${cause ? ` | cause: ${cause}` : ""}` : String(error);
  return text
    .replace(JWT_RE, "<JWT_REDACTED>")
    .replace(SESSION_TOKEN_RE, "<SESSION_TOKEN_REDACTED>")
    .replace(/(:\/\/[^:@/]+):([^@/]+)@/g, "$1:<PASSWORD_REDACTED>@")
    .slice(0, 700);
}

export function handleRouteError(error: unknown) {
  if (isResponseError(error)) return error;
  console.error(error);
  return fail(`Server processing failed: ${compactRouteError(error)}`, 500);
}
