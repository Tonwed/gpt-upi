import { getPublicSiteSettings } from "@/lib/server/site-settings";
import { handleRouteError, ok } from "@/lib/server/responses";

export const runtime = "nodejs";

export async function GET() {
  try {
    return ok(await getPublicSiteSettings());
  } catch (error) {
    return handleRouteError(error);
  }
}
