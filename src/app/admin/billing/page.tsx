import { AdminBillingClient } from "@/components/app/admin-billing-client";
import { TelegramLoginClient } from "@/components/app/telegram-login-client";
import { getAdminSession } from "@/lib/server/auth";

export default async function AdminBillingPage() {
  const admin = await getAdminSession();
  if (!admin) return <TelegramLoginClient purpose="admin" />;
  return <AdminBillingClient />;
}
