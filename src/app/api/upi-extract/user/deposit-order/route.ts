import { getPublicUserSession } from "@/lib/server/auth";
import {
  createPublicUserDepositOrder,
  getLatestPublicUserDepositOrder,
  getPublicUnifiedDepositInfo,
  getPublicUserWalletHistory,
  getPublicUserWalletSummary,
} from "@/lib/server/public-user-wallet";
import { isPublicDepositEnabled } from "@/lib/server/site-settings";
import { fail, handleRouteError, ok } from "@/lib/server/responses";

export const runtime = "nodejs";

export async function GET() {
  try {
    const user = await getPublicUserSession();
    if (!user) return fail("Please log in with Telegram first.", 401);
    const wallet = await getPublicUserWalletSummary(user);
    const deposit = getPublicUnifiedDepositInfo();
    const depositOrder = await getLatestPublicUserDepositOrder(user);
    const walletHistory = await getPublicUserWalletHistory(user);
    return ok({ wallet, deposit, depositOrder, walletHistory });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = await getPublicUserSession();
    if (!user) return fail("Please log in with Telegram first.", 401);
    if (!(await isPublicDepositEnabled())) return fail("Deposit is temporarily closed. Please try again later.", 503);

    const body = await request.json().catch(() => ({}));
    const depositOrder = await createPublicUserDepositOrder(user, { baseAmount: body.baseAmount });
    const wallet = await getPublicUserWalletSummary(user);
    const deposit = getPublicUnifiedDepositInfo();
    const walletHistory = await getPublicUserWalletHistory(user);
    return ok({ wallet, deposit, depositOrder, walletHistory });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create deposit order";
    if (message.includes("USDT") || message.includes("\u5145\u503c") || message.includes("BSC")) {
      return fail(message);
    }
    return handleRouteError(error);
  }
}
