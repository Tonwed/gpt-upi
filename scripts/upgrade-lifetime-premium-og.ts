import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

const PREMIUM_PREFIX = "public_user_premium:";

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
      // optional env file
    }
  }
}

type PremiumSettingRow = {
  key: string;
  value: string;
};

type StoredPremiumSetting = {
  enabled?: boolean;
  premiumUntil?: string | null;
  tier?: string | null;
  updatedBy?: string | null;
  updatedAt?: string | null;
};

function parsePremiumSetting(value: string): StoredPremiumSetting | null {
  try {
    const parsed = JSON.parse(value) as StoredPremiumSetting;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function isLifetimePremium(setting: StoredPremiumSetting) {
  if (setting.enabled === false) return false;
  if (!setting.premiumUntil) return true;
  const date = new Date(setting.premiumUntil);
  return Number.isNaN(date.getTime()) ? true : false;
}

async function main() {
  loadDotEnv();
  const prisma = new PrismaClient();
  const now = new Date().toISOString();

  try {
    const settings: PremiumSettingRow[] = await prisma.systemSetting.findMany({
      where: { key: { startsWith: PREMIUM_PREFIX } },
      select: { key: true, value: true },
      orderBy: { key: "asc" },
    });

    const targets = settings
      .map((row) => ({ row, parsed: parsePremiumSetting(row.value) }))
      .filter((item): item is { row: typeof settings[number]; parsed: StoredPremiumSetting } => {
        if (!item.parsed) return false;
        if (!isLifetimePremium(item.parsed)) return false;
        return item.parsed.tier !== "premium_og";
      });

    await mkdir("outputs", { recursive: true });
    const backupPath = resolve("outputs", `premium-og-upgrade-${now.replace(/[:.]/g, "-")}.json`);
    await writeFile(
      backupPath,
      JSON.stringify(
        {
          upgradedAt: now,
          count: targets.length,
          items: targets.map(({ row, parsed }) => ({
            key: row.key,
            telegramUserId: row.key.slice(PREMIUM_PREFIX.length),
            previousValue: row.value,
            parsed,
          })),
        },
        null,
        2
      ),
      "utf8"
    );

    for (const { row, parsed } of targets) {
      await prisma.systemSetting.update({
        where: { key: row.key },
        data: {
          value: JSON.stringify({
            ...parsed,
            enabled: true,
            premiumUntil: null,
            tier: "premium_og",
            updatedBy: parsed.updatedBy || "premium_og_migration",
            updatedAt: now,
          } satisfies StoredPremiumSetting),
        },
      });
    }

    console.log(`Premium OG upgrade complete. Updated ${targets.length} lifetime Premium setting(s).`);
    console.log(`Backup: ${backupPath}`);
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
