import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { buildLocalTestEnv, getLocalTestSchema, redactedDatabaseUrl } from "./local-test-env.mjs";

const env = buildLocalTestEnv();
console.log("Pushing Prisma schema to isolated local test schema");
console.log(`Schema: ${getLocalTestSchema(env)}`);
console.log(`Database: ${redactedDatabaseUrl(env.DATABASE_URL)}`);

const child = spawn(process.execPath, [resolve("node_modules/prisma/build/index.js"), "db", "push"], {
  cwd: process.cwd(),
  env,
  stdio: "inherit",
});

child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

