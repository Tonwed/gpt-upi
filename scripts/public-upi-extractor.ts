import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
process.env.UPI_EXTRACT_RUNNER ||= "worker";

async function main() {
  const { startPublicUpiExtractWorkerLoop, runPublicUpiExtractWorkerTick } = await import("../src/lib/server/public-upi-extract-queue");
  const intervalMs = Math.max(1000, Math.floor(Number(process.env.UPI_EXTRACT_WORKER_INTERVAL_MS || 2000) || 2000));

  console.log(`Public UPI extractor worker starting. runner=${process.env.UPI_EXTRACT_RUNNER} interval=${intervalMs}ms`);
  const firstState = await runPublicUpiExtractWorkerTick();
  console.log(`Public UPI extractor worker ready. queued=${firstState.queuedCount} active=${firstState.activeExtractionCount}`);
  const stop = startPublicUpiExtractWorkerLoop({ intervalMs });

  const shutdown = (signal: string) => {
    console.log(`Public UPI extractor worker received ${signal}, stopping poll loop.`);
    stop();
    setTimeout(() => process.exit(0), 250);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

void main().catch((error) => {
  console.error("Public UPI extractor worker failed to start", error);
  process.exit(1);
});
