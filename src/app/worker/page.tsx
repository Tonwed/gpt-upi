import { TelegramLoginClient } from "@/components/app/telegram-login-client";
import { WorkerClient } from "@/components/app/worker-client";
import { getWorkerSession } from "@/lib/server/auth";

export default async function WorkerPage() {
  const worker = await getWorkerSession();
  if (!worker) return <TelegramLoginClient purpose="worker" />;
  return <WorkerClient />;
}
