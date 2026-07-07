import { requireAdminSession } from "@/lib/server/auth";
import { paginateArray, parseAdminPagination } from "@/lib/server/admin-pagination";
import { fail, handleRouteError, ok } from "@/lib/server/responses";
import { failAllPublicUpiExtractJobs, getAdminPublicUpiExtractState, normalizePublicUpiExtractChannel, setPublicUpiExtractConcurrency, setPublicUpiExtractPaused, startPublicUpiExtractJob, stopAllPublicUpiExtractJobs, stopPublicUpiExtractJob } from "@/lib/server/public-upi-extract-queue";

export const runtime = "nodejs";

type AdminUpiExtractAction = "pause" | "resume" | "start" | "stop" | "stopAll" | "failAll" | "setConcurrency";

export async function GET(request: Request) {
  try {
    await requireAdminSession();
    const pagination = parseAdminPagination(request, { defaultPageSize: 20, maxPageSize: 100 });
    const state = await getAdminPublicUpiExtractState();
    if (!pagination.isPaged) return ok(state);

    const normalizedSearch = pagination.search.toLowerCase();
    const matches = (item: { jobId?: string | null; status?: string | null; source?: string | null; channel?: string | null; error?: string | null }) => {
      if (!normalizedSearch) return true;
      return [item.jobId, item.status, item.source, item.channel, item.error]
        .some((value) => String(value || "").toLowerCase().includes(normalizedSearch));
    };
    const jobs = state.jobs.filter(matches);
    const items = [...state.items].reverse().filter(matches);
    const pagedJobs = paginateArray(jobs, pagination);
    const pagedItems = paginateArray(items, pagination);
    return ok({
      ...state,
      jobs: pagedJobs.items,
      items: pagedItems.items,
      jobsPagination: pagedJobs.pagination,
      itemsPagination: pagedItems.pagination,
    });
  } catch (error) {
    if (error instanceof Response) return fail("未授权", 401);
    return handleRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    await requireAdminSession();
    const body = (await request.json().catch(() => ({}))) as { action?: AdminUpiExtractAction; jobId?: string; reason?: string; channel?: string; concurrency?: number };
    const action = String(body.action || "") as AdminUpiExtractAction;
    const jobId = String(body.jobId || "").trim();
    const channel = normalizePublicUpiExtractChannel(body.channel);

    if (action === "pause") {
      await setPublicUpiExtractPaused(true, channel);
      return ok(await getAdminPublicUpiExtractState());
    }
    if (action === "resume") {
      await setPublicUpiExtractPaused(false, channel);
      return ok(await getAdminPublicUpiExtractState());
    }
    if (action === "setConcurrency") {
      await setPublicUpiExtractConcurrency(channel, body.concurrency);
      return ok(await getAdminPublicUpiExtractState());
    }
    if (action === "stopAll") {
      const result = await stopAllPublicUpiExtractJobs();
      return ok({ ...(await getAdminPublicUpiExtractState()), changed: result.changed });
    }
    if (action === "failAll") {
      const result = await failAllPublicUpiExtractJobs(String(body.reason || "管理员已停止提取任务"));
      return ok({ ...(await getAdminPublicUpiExtractState()), changed: result.changed });
    }
    if (action === "start") {
      if (!jobId) return fail("缺少任务 ID");
      await startPublicUpiExtractJob(jobId);
      return ok(await getAdminPublicUpiExtractState());
    }
    if (action === "stop") {
      if (!jobId) return fail("缺少任务 ID");
      await stopPublicUpiExtractJob(jobId);
      return ok(await getAdminPublicUpiExtractState());
    }

    return fail("未知操作");
  } catch (error) {
    if (error instanceof Response) return fail("未授权", 401);
    return handleRouteError(error);
  }
}
