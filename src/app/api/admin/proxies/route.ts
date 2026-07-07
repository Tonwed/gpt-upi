import { requireAdminSession } from "@/lib/server/auth";
import { paginateArray, parseAdminPagination } from "@/lib/server/admin-pagination";
import { fail, handleRouteError, ok } from "@/lib/server/responses";
import { addEditableUpstreamProxy, deleteEditableUpstreamProxy, getConfiguredUpstreamProxies, getEditableUpstreamProxyUrls, getUpstreamProxySelection, setEditableUpstreamProxyUrls, setUpstreamProxySelection, toPublicUpstreamProxy, type UpstreamProxyPool } from "@/lib/server/upstream-proxy";

export const runtime = "nodejs";

function normalizeProxyPool(value: unknown): UpstreamProxyPool {
  return value === "premium" ? "premium" : "public";
}

async function proxyConfigPayload(pool: UpstreamProxyPool) {
  const [proxies, editableProxyList] = await Promise.all([
    getConfiguredUpstreamProxies(pool),
    getEditableUpstreamProxyUrls(pool),
  ]);
  return {
    pool,
    proxies: proxies.map(toPublicUpstreamProxy),
    editableProxyList,
    total: proxies.length,
    expectedCountry: (process.env.UPSTREAM_PROXY_EXPECTED_COUNTRY || "JP").trim().toUpperCase(),
    hasList: proxies.length > 0,
  };
}

export async function GET(request: Request) {
  try {
    await requireAdminSession();
    const pagination = parseAdminPagination(request, { defaultPageSize: 20, maxPageSize: 200 });
    const pool = normalizeProxyPool(pagination.url.searchParams.get("pool"));
    const selection = await getUpstreamProxySelection(pool);
    const payload = await proxyConfigPayload(pool);
    const proxies = pagination.search
      ? payload.proxies.filter((proxy) => [
          proxy.id,
          proxy.redactedUrl,
          proxy.source,
          proxy.scheme,
          proxy.host,
          proxy.port,
        ].some((value) => String(value || "").toLowerCase().includes(pagination.search.toLowerCase())))
      : payload.proxies;
    const pagedProxies = pagination.isPaged ? paginateArray(proxies, pagination) : null;
    return ok({
      ...payload,
      proxies: pagedProxies ? pagedProxies.items : proxies,
      pagination: pagedProxies?.pagination,
      selection,
    });
  } catch (error) {
    if (error instanceof Response) return fail("未登录", 401);
    return handleRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    await requireAdminSession();
    const body = (await request.json().catch(() => ({}))) as { action?: string; selectedProxyId?: string | null; pool?: string; proxyUrl?: string; proxyId?: string; proxyList?: string };
    const pool = normalizeProxyPool(body.pool);
    const action = String(body.action || "select");

    if (action === "add") {
      const proxyUrl = String(body.proxyUrl || "").trim();
      if (!proxyUrl) return fail("请输入代理地址", 400);
      await addEditableUpstreamProxy(pool, proxyUrl);
    } else if (action === "delete") {
      const proxyId = String(body.proxyId || "").trim();
      if (!proxyId) return fail("缺少代理 ID", 400);
      await deleteEditableUpstreamProxy(pool, proxyId);
    } else if (action === "replace") {
      await setEditableUpstreamProxyUrls(pool, String(body.proxyList || ""));
    } else {
      await setUpstreamProxySelection(String(body.selectedProxyId || "AUTO"), pool);
    }

    const selection = await getUpstreamProxySelection(pool);
    return ok({
      ...(await proxyConfigPayload(pool)),
      selection,
    });
  } catch (error) {
    if (error instanceof Response) return fail("未登录", 401);
    const message = error instanceof Error ? error.message : "保存代理选择失败";
    return fail(message, 400);
  }
}
