import { AdminUsersClient } from "@/components/app/admin-users-client";
import { TelegramLoginClient } from "@/components/app/telegram-login-client";
import { getAdminSession } from "@/lib/server/auth";

export default async function AdminUsersPage() {
  const admin = await getAdminSession();
  if (!admin) return <TelegramLoginClient purpose="admin" />;
  return <AdminUsersClient />;
}
