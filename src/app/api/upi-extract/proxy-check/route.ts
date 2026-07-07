import { fail, handleRouteError, ok } from "@/lib/server/responses";
import { getPublicSiteSettings } from "@/lib/server/site-settings";
import { checkUpstreamProxy, createCustomUpstreamProxyEntry } from "@/lib/server/upstream-proxy";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const settings = await getPublicSiteSettings();
    if (!settings.customProxyEnabled) {
      return fail("自定义代理功能已关闭，请使用服务端代理池。", 410);
    }

    const body = (await request.json().catch(() => ({}))) as { proxyUrl?: unknown };
    const proxyUrl = String(body.proxyUrl || "").trim();
    if (!proxyUrl) return fail("请先填写代理地址。", 400);

    const entry = (() => {
      try {
        return createCustomUpstreamProxyEntry(proxyUrl);
      } catch {
        return null;
      }
    })();
    if (!entry) return fail("代理地址格式错误。", 400);
    const result = await checkUpstreamProxy(entry, { timeoutMs: 15_000, expectedCountry: "" });
    return ok({ result });
  } catch (error) {
    return handleRouteError(error);
  }
}
