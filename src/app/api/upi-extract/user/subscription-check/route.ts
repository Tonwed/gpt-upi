import { getPublicUserSession } from "@/lib/server/auth";
import { checkPublicUpiExtractJobSubscription } from "@/lib/server/public-upi-extract-queue";
import { fail, handleRouteError, ok } from "@/lib/server/responses";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const user = await getPublicUserSession();
    if (!user) return fail("Please login first.", 401);

    const body = (await request.json().catch(() => ({}))) as { jobId?: unknown };
    const jobId = String(body.jobId || "").trim();
    if (!jobId) return fail("Missing jobId", 400);

    const job = await checkPublicUpiExtractJobSubscription(jobId, user.telegramUserId);
    return ok(job);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "Subscription check failed");
    if (
      message.includes("wait") ||
      message.includes("own task") ||
      message.includes("Task not found") ||
      message.includes("temporary session") ||
      message.includes("saved session data") ||
      message.includes("still being processed")
    ) {
      return fail(message, message.includes("wait") ? 429 : 400);
    }
    return handleRouteError(error);
  }
}
