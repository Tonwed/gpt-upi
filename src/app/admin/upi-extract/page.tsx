import { AdminUpiExtractClient } from "@/components/app/admin-upi-extract-client";
import { TelegramLoginClient } from "@/components/app/telegram-login-client";
import { getAdminSession } from "@/lib/server/auth";

export default async function AdminUpiExtractPage() {
  const admin = await getAdminSession();
  if (!admin) return <TelegramLoginClient purpose="admin" />;
  return <AdminUpiExtractClient />;
}
