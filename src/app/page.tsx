import { UpiExtractClient } from "@/components/app/upi-extract-client";

export const dynamic = "force-dynamic";

const MOCK_ACTIVITY_SEED_AT = 1781635200000;

function isMaintenancePageEnabled() {
  const value = String(process.env.SITE_MAINTENANCE_PAGE || "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function MaintenancePage() {
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[radial-gradient(circle_at_top,#fff7ed_0,#ffffff_42%,#f8fafc_100%)] px-6 py-12 text-slate-950">
      <div className="absolute left-1/2 top-0 h-72 w-72 -translate-x-1/2 rounded-full bg-orange-300/25 blur-3xl" />
      <section className="relative w-full max-w-xl rounded-[2rem] border border-orange-100 bg-white/85 p-8 text-center shadow-2xl shadow-orange-100/70 backdrop-blur md:p-10">
        <div className="mx-auto mb-5 flex size-16 items-center justify-center rounded-2xl bg-orange-500 text-3xl font-black text-white shadow-lg shadow-orange-200">
          UPI
        </div>
        <p className="mb-3 text-sm font-semibold uppercase tracking-[0.28em] text-orange-500">
          Maintenance
        </p>
        <h1 className="text-3xl font-black tracking-tight md:text-4xl">
          系统维护升级中
        </h1>
        <p className="mt-4 text-base leading-7 text-slate-600">
          我们正在进行内部调整和稳定性测试，提取服务暂时关闭。请稍后再回来查看。
        </p>
        <div className="mt-7 rounded-2xl border border-orange-100 bg-orange-50 px-4 py-3 text-sm font-medium text-orange-700">
          We are tuning the service. Please check back later.
        </div>
      </section>
    </main>
  );
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  if (isMaintenancePageEnabled()) return <MaintenancePage />;

  const params = await searchParams;
  const mockMode = params.mock === "1";

  return <UpiExtractClient mockMode={mockMode} mockSeedAt={mockMode ? MOCK_ACTIVITY_SEED_AT : undefined} />;
}
