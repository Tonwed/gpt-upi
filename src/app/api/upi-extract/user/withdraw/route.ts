import { getPublicUserSession } from "@/lib/server/auth";
import {
  createPublicUserWithdrawalRequest,
  getLatestPublicUserDepositOrder,
  getPublicUnifiedDepositInfo,
  getPublicUserWalletHistory,
  getPublicUserWalletSummary,
  parsePublicUserWithdrawalAmount,
  PUBLIC_USER_WITHDRAWAL_FEE,
} from "@/lib/server/public-user-wallet";
import { fail, handleRouteError, ok } from "@/lib/server/responses";
import { isPublicWithdrawEnabled } from "@/lib/server/site-settings";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const user = await getPublicUserSession();
    if (!user) return fail("\u8bf7\u5148\u767b\u5f55 Telegram \u8d26\u6237\u3002", 401);
    if (!(await isPublicWithdrawEnabled())) return fail("Withdrawals are temporarily unavailable. Please try again later.", 403);

    const body = await request.json().catch(() => ({}));
    const amount = parsePublicUserWithdrawalAmount(body.amount);
    const withdrawalAddress = String(body.withdrawalAddress || "").trim();
    const note = String(body.note || "").trim();

    if (!amount) return fail("\u8bf7\u8f93\u5165\u6b63\u786e\u7684\u63d0\u73b0\u91d1\u989d\u3002");
    if (!withdrawalAddress) return fail("\u8bf7\u8f93\u5165\u63d0\u73b0\u5730\u5740\u3002");

    const withdrawal = await createPublicUserWithdrawalRequest(user, {
      amount,
      withdrawalAddress,
      note: note || null,
    });
    const wallet = await getPublicUserWalletSummary(user);
    const deposit = getPublicUnifiedDepositInfo();
    const depositOrder = await getLatestPublicUserDepositOrder(user);
    const walletHistory = await getPublicUserWalletHistory(user);

    return ok({ withdrawal, wallet, deposit, depositOrder, walletHistory, fee: PUBLIC_USER_WITHDRAWAL_FEE });
  } catch (error) {
    const message = error instanceof Error ? error.message : "\u63d0\u73b0\u7533\u8bf7\u5931\u8d25";
    if (message.includes("\u4f59\u989d\u4e0d\u8db3") || message.includes("\u63d0\u73b0") || message.includes("\u5730\u5740") || message.includes("\u94b1\u5305")) {
      return fail(message);
    }
    return handleRouteError(error);
  }
}
