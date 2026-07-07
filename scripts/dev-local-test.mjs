import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { buildLocalTestEnv, getLocalTestSchema, redactedDatabaseUrl } from "./local-test-env.mjs";

const env = buildLocalTestEnv();
const args = process.argv.slice(2);
const hasHost = args.some((arg) => arg === "-H" || arg === "--hostname" || arg === "--host" || arg.startsWith("--hostname=") || arg.startsWith("--host="));
const hasPort = args.some((arg) => arg === "-p" || arg === "--port" || arg.startsWith("--port="));
const nextArgs = ["dev", ...args, ...(hasHost ? [] : ["-H", "0.0.0.0"]), ...(hasPort ? [] : ["-p", "3001"])]

console.log("Starting isolated local test web server");
console.log(`Schema: ${getLocalTestSchema(env)}`);
console.log(`Database: ${redactedDatabaseUrl(env.DATABASE_URL)}`);
console.log(`Proxy: ${env.UPSTREAM_PROXY}`);
console.log("Telegram bot polling is not started in local-test mode.");

const child = spawn(process.execPath, [resolve("node_modules/next/dist/bin/next"), ...nextArgs], {
  cwd: process.cwd(),
  env,
  stdio: "inherit",
});

child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

