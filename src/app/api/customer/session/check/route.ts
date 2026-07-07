import { EmailBoundError, validateCredentialForUpiExtraction } from "@/lib/server/chatgpt-upi";
import { fail, handleRouteError, ok } from "@/lib/server/responses";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const credential = String(body.sessionToken || body.credential || "").trim();
    if (!credential) return fail("请输入 session token");

    await validateCredentialForUpiExtraction(credential);
    return ok({ canSubmit: true });
  } catch (error) {
    if (error instanceof EmailBoundError) {
      return fail(error.message, 403, { email: error.email });
    }
    const message = error instanceof Error ? error.message : "session token 校验失败";
    if (message.includes("session") || message.includes("邮箱") || message.includes("token") || message.includes("Cloudflare")) {
      return fail(message);
    }
    return handleRouteError(error);
  }
}
