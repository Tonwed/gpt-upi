import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export const LOCAL_TEST_ENV_FILE = resolve(process.cwd(), ".env.local.test");

function parseEnv(content) {
  const values = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  return parseEnv(readFileSync(path, "utf8"));
}

function withSchema(databaseUrl, schema) {
  const url = new URL(databaseUrl);
  url.searchParams.set("schema", schema);
  return url.toString();
}

export function buildLocalTestEnv() {
  const baseEnv = {
    ...loadEnvFile(resolve(process.cwd(), ".env")),
    ...loadEnvFile(resolve(process.cwd(), ".env.local")),
    ...loadEnvFile(LOCAL_TEST_ENV_FILE),
  };

  const sourceDatabaseUrl = baseEnv.LOCAL_TEST_DATABASE_URL || baseEnv.DATABASE_URL || process.env.DATABASE_URL;
  if (!sourceDatabaseUrl) {
    throw new Error("缺少 DATABASE_URL，无法创建本地测试环境");
  }

  const localTestSchema = process.env.LOCAL_TEST_SCHEMA || baseEnv.LOCAL_TEST_SCHEMA || "gpt_upi_local_test";
  const databaseUrl = withSchema(sourceDatabaseUrl, localTestSchema);

  return {
    ...process.env,
    ...baseEnv,
    DATABASE_URL: databaseUrl,
    NEXT_PUBLIC_APP_URL: baseEnv.NEXT_PUBLIC_APP_URL || "http://127.0.0.1:3001",
    APP_URL: baseEnv.APP_URL || baseEnv.NEXT_PUBLIC_APP_URL || "http://127.0.0.1:3001",
    UPSTREAM_PROXY: baseEnv.UPSTREAM_PROXY || "http://127.0.0.1:7890",
    UPSTREAM_PROXY_LIST: baseEnv.UPSTREAM_PROXY_LIST || baseEnv.UPSTREAM_PROXY || "http://127.0.0.1:7890",
    PREMIUM_UPSTREAM_PROXY: baseEnv.PREMIUM_UPSTREAM_PROXY || baseEnv.UPSTREAM_PROXY || "http://127.0.0.1:7890",
    PREMIUM_UPSTREAM_PROXY_LIST: baseEnv.PREMIUM_UPSTREAM_PROXY_LIST || baseEnv.UPSTREAM_PROXY_LIST || baseEnv.UPSTREAM_PROXY || "http://127.0.0.1:7890",
    PUBLIC_UPI_EXTRACT_CONCURRENCY: baseEnv.PUBLIC_UPI_EXTRACT_CONCURRENCY || "1",
    PREMIUM_UPI_EXTRACT_CONCURRENCY: baseEnv.PREMIUM_UPI_EXTRACT_CONCURRENCY || "1",
    UPI_EXTRACT_CONCURRENCY: baseEnv.UPI_EXTRACT_CONCURRENCY || "1",
    UPI_EXTRACT_RUNNER: baseEnv.UPI_EXTRACT_RUNNER || "inline",
    ENABLE_EXTRACT_METHOD_SELECTION: "1",
    NEXT_PUBLIC_ENABLE_EXTRACT_METHOD_SELECTION: "1",
    LOCAL_TEST_SCHEMA: localTestSchema,
    GPT_UPI_LOCAL_TEST_ENV: "1",
  };
}

export function getLocalTestSchema(env) {
  return env?.LOCAL_TEST_SCHEMA || process.env.LOCAL_TEST_SCHEMA || "gpt_upi_local_test";
}

export function redactedDatabaseUrl(databaseUrl) {
  return String(databaseUrl || "").replace(/:\/\/([^:@/]+):([^@/]+)@/, "://$1:<PASSWORD_REDACTED>@");
}
