import { AdminWorkersClient } from "@/components/app/admin-client";
import { TelegramLoginClient } from "@/components/app/telegram-login-client";
import { getAdminSession } from "@/lib/server/auth";

export default async function AdminWorkersPage() {
  const admin = await getAdminSession();
  if (!admin) return <TelegramLoginClient purpose="admin" />;
  return <AdminWorkersClient />;
}
