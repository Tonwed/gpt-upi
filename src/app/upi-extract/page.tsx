import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function LegacyUpiExtractPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const next = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) next.append(key, item);
    } else if (value !== undefined) {
      next.set(key, value);
    }
  }
  const query = next.toString();
  redirect(query ? `/?${query}` : "/");
}
