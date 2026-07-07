import { EmailBoundError, hasRecognizedSessionCredential, validateCredentialForUpiExtraction } from "@/lib/server/chatgpt-upi";
import { getPublicUserSession } from "@/lib/server/auth";
import { cancelOrder } from "@/lib/server/orders";
import { cancelPublicUpiExtractJob, checkPublicUpiExtractRateLimit, countPublicUpiExtractUserActiveJobs, createPublicUpiExtractJob, getPublicUpiExtractHeatmapOverview, getPublicUpiExtractJob, isPublicUpiExtractPaused, normalizePublicUpiExtractChannel, normalizePublicUpiExtractMethod, updatePublicUpiExtractJobScanOrder } from "@/lib/server/public-upi-extract-queue";
import { assertPublicUserCanPayScanOrder } from "@/lib/server/public-user-wallet";
import { fail, handleRouteError, ok } from "@/lib/server/responses";
import { serializeWorkerOrder } from "@/lib/server/serializers";
import { getPublicSiteSettings } from "@/lib/server/site-settings";
import { normalizeCustomUpstreamProxyUrl } from "@/lib/server/upstream-proxy";
import { UpiGuardError } from "@/lib/server/upi-guard";

export const runtime = "nodejs";

const NORMAL_USER_MAX_ACTIVE_EXTRACT_JOBS = 1;
const PREMIUM_USER_MAX_ACTIVE_EXTRACT_JOBS = 5;

const PUBLIC_UPI_APPROVAL_PARALLELISM = 1;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const jobId = url.searchParams.get("jobId")?.trim() || "";

  if (!jobId) {
    const rawChannel = url.searchParams.get("channel");
    const channel = rawChannel ? normalizePublicUpiExtractChannel(rawChannel) : null;
    return ok(await getPublicUpiExtractHeatmapOverview(channel));
  }

  const job = await getPublicUpiExtractJob(jobId);
  if (!job) return fail("Task not found or expired.", 404);
  return ok(job);
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const publicUser = await getPublicUserSession();
    const siteSettings = await getPublicSiteSettings();
    const channel = publicUser?.isPremium ? "premium" : "public";
    const extractMethod = siteSettings.extractMethodSelectionEnabled ? normalizePublicUpiExtractMethod(body.extractMethod) : "upi";
    if (await isPublicUpiExtractPaused(channel)) {
      return fail("UPI extraction is temporarily under maintenance. Please try again later.", 503);
    }
    const guardId = String(body.guardId || "").trim();
    if (guardId) {
      return fail("Temporary storage has been disabled. Please paste the Session Token and start a new extraction.", 410);
    }

    const credential = String(body.sessionToken || body.credential || "").trim();
    if (!credential) return fail("Please enter the session token.");
    if (!hasRecognizedSessionCredential(credential)) {
      return fail("No valid session token / session cookie / session JSON was recognized.");
    }

    if (!publicUser) {
      const rateLimit = await checkPublicUpiExtractRateLimit(request, channel);
      if (!rateLimit.allowed) {
        return fail(`Too many requests. Please try again in ${rateLimit.remainingSeconds} seconds.`, 429, {
          remainingSeconds: rateLimit.remainingSeconds,
        });
      }
    }

    const credentialInfo = await validateCredentialForUpiExtraction(credential);
    const approvalParallelism = PUBLIC_UPI_APPROVAL_PARALLELISM;
    let checkoutProxyUrl = "";
    let providerProxyUrl = "";
    if (siteSettings.customProxyEnabled) {
      try {
        checkoutProxyUrl = normalizeCustomUpstreamProxyUrl(body.checkoutProxyUrl);
        providerProxyUrl = normalizeCustomUpstreamProxyUrl(body.providerProxyUrl);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid custom proxy.";
        return fail(message.replace(/(:\/\/[^:@/]+):([^@/]+)@/g, "$1:<PASSWORD_REDACTED>@"), 400);
      }
    }
    const autoPublishScanOrder = extractMethod === "upi" && Boolean(body.autoPublishScanOrder);
    const untilSuccess = Boolean(publicUser?.isPremium && body.untilSuccess);
    if (publicUser) {
      const activeCount = await countPublicUpiExtractUserActiveJobs(publicUser.telegramUserId);
      const maxActive = publicUser.isPremium ? PREMIUM_USER_MAX_ACTIVE_EXTRACT_JOBS : NORMAL_USER_MAX_ACTIVE_EXTRACT_JOBS;
      if (activeCount >= maxActive) {
        return fail(
          publicUser.isPremium
            ? `A Premium account can run up to ${PREMIUM_USER_MAX_ACTIVE_EXTRACT_JOBS} extraction tasks at the same time. Please wait for an existing task to finish or cancel one before submitting again.`
            : "A normal account can run only 1 extraction task at a time. Please wait for the current task to finish or cancel it before submitting again.",
          429,
          { activeCount, maxActive }
        );
      }
    }
    if (autoPublishScanOrder) {
      if (!publicUser) return fail("Please log in with Telegram before enabling auto-publish scan orders.", 401);
      await assertPublicUserCanPayScanOrder(publicUser);
    }

    const job = await createPublicUpiExtractJob({
      credential,
      issueGuardCreateToken: false,
      source: "direct",
      channel,
      extractMethod,
      publicUserTelegramId: publicUser?.telegramUserId || null,
      publicUserTelegramName: publicUser?.telegramUsername || null,
      accountEmail: credentialInfo.accountEmail || null,
      accountPhone: credentialInfo.accountPhone || null,
      autoPublishScanOrder,
      untilSuccess,
      approvalParallelism,
      checkoutProxyUrl,
      providerProxyUrl,
    });

    return ok(job, { status: 202 });
  } catch (error) {
    if (error instanceof EmailBoundError) return fail(error.message, 403, { email: error.email });
    if (error instanceof UpiGuardError) return fail(error.message, error.status);
    return handleRouteError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const url = new URL(request.url);
    const jobId = url.searchParams.get("jobId")?.trim() || "";
    if (!jobId) return fail("Missing jobId", 400);

    const publicUser = await getPublicUserSession();
    const job = await getPublicUpiExtractJob(jobId);
    if (!job) return fail("Task not found or expired.", 404);
    if (job.publicUserTelegramId && !publicUser) return fail("Please login first.", 401);
    if (job.publicUserTelegramId && job.publicUserTelegramId !== publicUser?.telegramUserId) {
      return fail("You can only cancel your own task.", 403);
    }

    const scanOrder = job.result?.scanOrder || null;
    if (scanOrder?.id) {
      if (scanOrder.status === "PENDING") {
        const result = await cancelOrder(scanOrder.id);
        updatePublicUpiExtractJobScanOrder(job.jobId, result.order);
        return ok({
          ...job,
          result: job.result
            ? {
              ...job.result,
              scanOrder: serializeWorkerOrder(result.order),
              scanOrderCreateToken: undefined,
            }
            : job.result,
        });
      }
      if (scanOrder.status === "ASSIGNED" || scanOrder.status === "CHECKING") {
        return fail(
          "This scan order has already been accepted and cannot be cancelled now. It will be completed or refunded automatically after the check window.",
          409,
          { job }
        );
      }
      if (scanOrder.status === "COMPLETED") {
        return fail("This scan order has already been completed and cannot be cancelled.", 409, { job });
      }
    }

    const cancelled = await cancelPublicUpiExtractJob(jobId, "Cancelled by user");
    if (!cancelled) return fail("Task not found or expired.", 404);
    if (!cancelled.cancelled) {
      return fail("This task can no longer be cancelled.", 409, { job: cancelled });
    }
    return ok(cancelled);
  } catch (error) {
    return handleRouteError(error);
  }
}
