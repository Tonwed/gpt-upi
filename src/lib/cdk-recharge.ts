export const RECHARGE_CDK_AMOUNTS = [1.8, 5, 10] as const;

export type RechargeCdkAmount = typeof RECHARGE_CDK_AMOUNTS[number];

export function parseRechargeCdkAmount(value: unknown): RechargeCdkAmount | null {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  const cents = Math.round(amount * 100);
  return RECHARGE_CDK_AMOUNTS.find((item) => Math.round(item * 100) === cents) ?? null;
}

export function formatRechargeCdkAmount(value: number) {
  return `${value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}U`;
}
