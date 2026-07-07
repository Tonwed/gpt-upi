import { TelegramLoginClient } from "@/components/app/telegram-login-client";
import { WorkerHistoryClient } from "@/components/app/worker-history-client";
import { getWorkerSession } from "@/lib/server/auth";

export default async function WorkerHistoryPage() {
  const worker = await getWorkerSession();
  if (!worker) return <TelegramLoginClient purpose="worker" />;
  return <WorkerHistoryClient />;
}
