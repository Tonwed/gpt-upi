import { spawn } from "node:child_process";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const DEFAULT_PORT = "3001";
const DEFAULT_HOST = "0.0.0.0";

function getPort() {
  const portIndex = args.findIndex((arg) => arg === "-p" || arg === "--port");
  if (portIndex >= 0 && args[portIndex + 1]) return args[portIndex + 1];

  const inlinePort = args.find((arg) => arg.startsWith("--port="));
  if (inlinePort) return inlinePort.split("=")[1];

  return DEFAULT_PORT;
}

function getHost() {
  const hostIndex = args.findIndex((arg) => arg === "-H" || arg === "--hostname" || arg === "--host");
  if (hostIndex >= 0 && args[hostIndex + 1]) return args[hostIndex + 1];

  const inlineHost = args.find((arg) => arg.startsWith("--hostname=") || arg.startsWith("--host="));
  if (inlineHost) return inlineHost.split("=")[1];

  return DEFAULT_HOST;
}

function withDefaultNetworkArgs(nextArgs) {
  const hasPort = nextArgs.some((arg) => arg === "-p" || arg === "--port" || arg.startsWith("--port="));
  const hasHost = nextArgs.some((arg) => arg === "-H" || arg === "--hostname" || arg === "--host" || arg.startsWith("--hostname=") || arg.startsWith("--host="));

  return [
    ...nextArgs,
    ...(hasHost ? [] : ["-H", DEFAULT_HOST]),
    ...(hasPort ? [] : ["-p", DEFAULT_PORT]),
  ];
}

const port = getPort();
const host = getHost();
const env = {
  ...process.env,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL || `http://${host}:${port}`,
  APP_URL: process.env.APP_URL || `http://${host}:${port}`,
};

const children = [];

function start(name, command, commandArgs) {
  const child = spawn(command, commandArgs, {
    cwd: process.cwd(),
    env,
    stdio: ["inherit", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[${name}] ${chunk}`);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[${name}] ${chunk}`);
  });
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.log(`[${name}] exited with ${signal || code}`);
    shutdown(code || 0);
  });

  children.push(child);
}

let shuttingDown = false;
function shutdown(code = 0) {
  shuttingDown = true;
  for (const child of children) {
    if (child.killed) continue;
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      child.kill();
    }
  }
  setTimeout(() => process.exit(code), 250);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log(`Starting web server and Telegram bot polling on http://${host}:${port}`);

start("web", process.execPath, [resolve("node_modules/next/dist/bin/next"), "dev", ...withDefaultNetworkArgs(args)]);
start("bot", process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), resolve("scripts/telegram-polling.ts")]);
