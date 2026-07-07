import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Wallet } from "ethers";

const envPath = resolve(process.cwd(), ".env.local");
const force = process.argv.includes("--force");

function parseKey(line) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
  return match?.[1] ?? null;
}

function upsertEnvValue(lines, key, value) {
  const escapedValue = `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const nextLine = `${key}=${escapedValue}`;
  const index = lines.findIndex((line) => parseKey(line) === key);
  if (index >= 0) {
    lines[index] = nextLine;
  } else {
    if (lines.length > 0 && lines[lines.length - 1].trim() !== "") lines.push("");
    lines.push(nextLine);
  }
}

const lines = existsSync(envPath)
  ? readFileSync(envPath, "utf8").split(/\r?\n/)
  : [];

const hasMnemonic = lines.some((line) => parseKey(line) === "BSC_DEPOSIT_MNEMONIC" && !/^\s*BSC_DEPOSIT_MNEMONIC\s*=\s*"?\s*"?\s*$/.test(line));

if (hasMnemonic && !force) {
  console.log("BSC_DEPOSIT_MNEMONIC already exists in .env.local; skipped. Use --force only if you intentionally rotate deposit wallets.");
  process.exit(0);
}

const wallet = Wallet.createRandom();
const phrase = wallet.mnemonic?.phrase;
if (!phrase) {
  throw new Error("Failed to generate mnemonic.");
}

upsertEnvValue(lines, "BSC_DEPOSIT_MNEMONIC", phrase);
writeFileSync(envPath, lines.join("\n").replace(/\n+$/, "\n"), "utf8");

console.log("BSC_DEPOSIT_MNEMONIC has been written to .env.local. The mnemonic was not printed.");
