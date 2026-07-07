import { fail } from "@/lib/server/responses";

export const runtime = "nodejs";

export async function POST() {
  return fail("UPI Scanner 已停用，请前往 /。", 410);
}
