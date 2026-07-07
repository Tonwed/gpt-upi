import { fail } from "@/lib/server/responses";

export const runtime = "nodejs";

export async function POST() {
  return fail("暂存功能已下线。", 410);
}

export async function PATCH() {
  return fail("暂存功能已下线。", 410);
}
