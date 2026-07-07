import { randomInt } from "node:crypto";
import { GENERATED_CDK_PREFIX, GENERATED_CDK_RANDOM_LENGTH } from "@/lib/cdk-code";
import { prisma } from "@/lib/server/prisma";

const CDK_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function generateCdkCode() {
  let suffix = "";
  for (let index = 0; index < GENERATED_CDK_RANDOM_LENGTH; index += 1) {
    suffix += CDK_ALPHABET[randomInt(CDK_ALPHABET.length)];
  }
  return `${GENERATED_CDK_PREFIX}${suffix}`;
}

export async function generateUniqueCdkCodes(count: number) {
  const codes = new Set<string>();

  while (codes.size < count) {
    const candidates = new Set<string>();
    while (candidates.size < count - codes.size) {
      candidates.add(generateCdkCode());
    }

    const existing = await prisma.cdk.findMany({
      where: { code: { in: Array.from(candidates) } },
      select: { code: true },
    });
    const existingCodes = new Set(existing.map((cdk) => cdk.code));

    for (const code of candidates) {
      if (!existingCodes.has(code)) {
        codes.add(code);
      }
    }
  }

  return Array.from(codes);
}

