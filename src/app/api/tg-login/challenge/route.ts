import { createTelegramLoginChallenge, parseLoginPurpose } from "@/lib/server/telegram-login";
import { fail, handleRouteError, ok } from "@/lib/server/responses";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const purpose = parseLoginPurpose(body.purpose);
    if (!purpose) return fail("登录类型无效");

    const challenge = await createTelegramLoginChallenge(purpose);
    return ok(challenge);
  } catch (error) {
    return handleRouteError(error);
  }
}
