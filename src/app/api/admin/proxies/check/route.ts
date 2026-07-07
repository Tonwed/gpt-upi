import { requireAdminSession } from "@/lib/server/auth";
import { checkConfiguredUpstreamProxies, checkUpstreamProxy, getConfiguredUpstreamProxies } from "@/lib/server/upstream-proxy";
import { fail, handleRouteError, ok } from "@/lib/server/responses";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    await requireAdminSession();
    const body = (await request.json().catch(() => ({}))) as { pool?: string; proxyId?: string; proxyIndex?: number };
    const pool = body.pool === "premium" ? "premium" : "public";

    if (typeof body.proxyId === "string" && body.proxyId.trim()) {
      const proxies = await getConfiguredUpstreamProxies(pool);
      const target = proxies.find((proxy) => proxy.id === body.proxyId);
      if (!target) return fail("代理不存在", 404);

      const result = await checkUpstreamProxy(target, { timeoutMs: 15_000 });
      return ok({
        checkedAt: result.checkedAt,
        total: 1,
        ok: result.ok ? 1 : 0,
        failed: result.ok ? 0 : 1,
        expectedCountry: result.expectedCountry,
        results: [result],
      });
    }

    if (typeof body.proxyIndex === "number" && Number.isFinite(body.proxyIndex)) {
      const proxies = await getConfiguredUpstreamProxies(pool);
      const target = proxies[body.proxyIndex];
      if (!target) return fail("代理不存在", 404);

      const result = await checkUpstreamProxy(target, { timeoutMs: 15_000 });
      return ok({
        checkedAt: result.checkedAt,
        total: 1,
        ok: result.ok ? 1 : 0,
        failed: result.ok ? 0 : 1,
        expectedCountry: result.expectedCountry,
        results: [result],
      });
    }

    const result = await checkConfiguredUpstreamProxies({ timeoutMs: 15_000, pool });
    return ok(result);
  } catch (error) {
    if (error instanceof Response) return fail("未登录管理员", 401);
    return handleRouteError(error);
  }
}
