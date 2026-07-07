import { requireAdminSession } from "@/lib/server/auth";
import {
  getPublicSiteSettings,
  setPublicDepositEnabled,
  setPublicFaqContent,
  setPublicFaqContentEn,
  setPublicCustomProxyEnabled,
  setPublicExtractMethodSelectionEnabled,
  setPublicPremiumPurchasePrice,
  setPublicPremiumSaleEnabled,
  setPublicTgInviteEnabled,
  setPublicWithdrawEnabled,
} from "@/lib/server/site-settings";
import { fail, handleRouteError, ok } from "@/lib/server/responses";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireAdminSession();
    return ok(await getPublicSiteSettings());
  } catch (error) {
    if (error instanceof Response) return fail("未授权", 401);
    return handleRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    await requireAdminSession();
    const body = (await request.json().catch(() => ({}))) as {
      tgInviteEnabled?: unknown;
      depositEnabled?: unknown;
      withdrawEnabled?: unknown;
      premiumSaleEnabled?: unknown;
      premiumPurchasePrice?: unknown;
      faqContent?: unknown;
      faqContentEn?: unknown;
      extractMethodSelectionEnabled?: unknown;
      customProxyEnabled?: unknown;
    };

    if ("tgInviteEnabled" in body) {
      await setPublicTgInviteEnabled(body.tgInviteEnabled === true);
    }
    if ("depositEnabled" in body) {
      await setPublicDepositEnabled(body.depositEnabled === true);
    }
    if ("withdrawEnabled" in body) {
      await setPublicWithdrawEnabled(body.withdrawEnabled === true);
    }
    if ("premiumSaleEnabled" in body) {
      await setPublicPremiumSaleEnabled(body.premiumSaleEnabled === true);
    }
    if ("premiumPurchasePrice" in body) {
      await setPublicPremiumPurchasePrice(Number(body.premiumPurchasePrice));
    }
    if ("extractMethodSelectionEnabled" in body) {
      await setPublicExtractMethodSelectionEnabled(body.extractMethodSelectionEnabled === true);
    }
    if ("customProxyEnabled" in body) {
      await setPublicCustomProxyEnabled(body.customProxyEnabled === true);
    }
    if ("faqContent" in body) {
      await setPublicFaqContent(String(body.faqContent || ""));
    }
    if ("faqContentEn" in body) {
      await setPublicFaqContentEn(String(body.faqContentEn || ""));
    }

    return ok(await getPublicSiteSettings());
  } catch (error) {
    if (error instanceof Response) return fail("未授权", 401);
    if (error instanceof Error && error.message.includes("Premium")) return fail(error.message, 400);
    return handleRouteError(error);
  }
}
