import { TelegramLoginClient } from "@/components/app/telegram-login-client";
import { WorkerWithdrawalsClient } from "@/components/app/worker-withdrawals-client";
import { getWorkerSession } from "@/lib/server/auth";

export default async function WorkerWithdrawalsPage() {
  const worker = await getWorkerSession();
  if (!worker) return <TelegramLoginClient purpose="worker" />;
  return <WorkerWithdrawalsClient />;
}
