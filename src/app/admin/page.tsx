import { AdminDashboardClient } from "@/components/app/admin-client";
import { TelegramLoginClient } from "@/components/app/telegram-login-client";
import { getAdminSession } from "@/lib/server/auth";

export default async function AdminPage() {
  const admin = await getAdminSession();
  if (!admin) return <TelegramLoginClient purpose="admin" />;
  return <AdminDashboardClient />;
}
