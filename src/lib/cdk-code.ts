export const GENERATED_CDK_PREFIX = "upi_";
export const GENERATED_CDK_RANDOM_LENGTH = 16;

export function normalizeCdkCode(input: string) {
  const compact = input.trim().replace(/\s+/g, "");
  if (compact.toLowerCase().startsWith(GENERATED_CDK_PREFIX)) {
    return compact.toLowerCase();
  }
  return compact.toUpperCase();
}

