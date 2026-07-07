"use client";

import Link from "next/link";
import { FormEvent, useCallback, useDeferredValue, useEffect, useMemo, useState, type ComponentType } from "react";
import { ActivityIcon, AlertTriangleIcon, CheckCircle2Icon, ClipboardListIcon, DatabaseIcon, DownloadIcon, Globe2Icon, KeyRoundIcon, Loader2Icon, PlusIcon, RefreshCwIcon, SaveIcon, SearchIcon, ShieldCheckIcon, Trash2Icon, UserPlusIcon, UsersRoundIcon, WalletIcon, XCircleIcon } from "lucide-react";
import { toast } from "sonner";
import { AppFrame } from "@/components/app/app-frame";
import { AdminListPagination } from "@/components/app/admin-list-pagination";
import { MetricCard } from "@/components/app/metric-card";
import { OrderStatusBadge, WorkerStatusBadge } from "@/components/app/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch, formatDateTime, formatMoney } from "@/lib/api-client";
import type { AdminPaginatedResponse, AdminPaginationMeta, OrderStatus, PublicCdk, PublicCdkBatch, PublicOrder, PublicProxyCheckSummary, PublicProxySelection, PublicUpstreamProxy, PublicWorker, PublicWorkerWithdrawalRequest, WorkerWalletSummary } from "@/lib/types/app";
import { cn } from "@/lib/utils";

type AdminWorker = PublicWorker & {
  activeOrder?: { orderId: string; orderNo: string; createdAt: string } | null;
  _count?: { records: number };
  completedCount?: number;
  totalAmount?: number;
  unsettledCompleted?: number;
  unsettledAmount?: number;
  settledCompleted?: number;
  settledAmount?: number;
  wallet?: WorkerWalletSummary;
};

type NavIcon = ComponentType<{ className?: string }>;
const ADMIN_PAGE_SIZE = 20;

function pagedAdminUrl(path: string, input: { page: number; search?: string; pageSize?: number; extra?: Record<string, string | number | boolean | null | undefined> }) {
  const params = new URLSearchParams();
  params.set("paged", "1");
  params.set("page", String(input.page));
  params.set("pageSize", String(input.pageSize ?? ADMIN_PAGE_SIZE));
  if (input.search?.trim()) params.set("search", input.search.trim());
  for (const [key, value] of Object.entries(input.extra || {})) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  return `${path}?${params.toString()}`;
}

type PublicSiteSettings = {
  tgInviteEnabled: boolean;
  tgInviteUrl: string;
  depositEnabled: boolean;
  extractMethodSelectionEnabled: boolean;
  customProxyEnabled: boolean;
};

export function AdminDashboardClient() {
  const [cdks, setCdks] = useState<PublicCdk[]>([]);
  const [workers, setWorkers] = useState<AdminWorker[]>([]);
  const [settings, setSettings] = useState<PublicSiteSettings>({
    tgInviteEnabled: false,
    tgInviteUrl: "https://t.me/your_group",
    depositEnabled: true,
    extractMethodSelectionEnabled: false,
    customProxyEnabled: false,
  });
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async (silent = false) => {
    try {
      setLoading(true);
      const [nextCdks, nextWorkers, nextSettings] = await Promise.all([
        apiFetch<PublicCdk[]>("/api/admin/cdks"),
        apiFetch<AdminWorker[]>("/api/admin/workers"),
        apiFetch<PublicSiteSettings>("/api/admin/settings"),
      ]);
      setCdks(nextCdks);
      setWorkers(nextWorkers);
      setSettings(nextSettings);
      if (!silent) toast.success("管理数据已刷新");
    } catch (error) {
      if (!silent) toast.error(error instanceof Error ? error.message : "刷新失败");
    } finally {
      setLoading(false);
    }
  }, []);

  const setTgInviteEnabled = useCallback(async (enabled: boolean) => {
    const previous = settings;
    try {
      setSettings((current) => ({ ...current, tgInviteEnabled: enabled }));
      const nextSettings = await apiFetch<PublicSiteSettings>("/api/admin/settings", {
        method: "POST",
        body: JSON.stringify({ tgInviteEnabled: enabled }),
      });
      setSettings(nextSettings);
      toast.success(enabled ? "公益站 TG 群组按钮已显示" : "公益站 TG 群组按钮已隐藏");
    } catch (error) {
      setSettings(previous);
      toast.error(error instanceof Error ? error.message : "设置失败");
    }
  }, [settings]);

  const setDepositEnabled = useCallback(async (enabled: boolean) => {
    const previous = settings;
    try {
      setSettings((current) => ({ ...current, depositEnabled: enabled }));
      const nextSettings = await apiFetch<PublicSiteSettings>("/api/admin/settings", {
        method: "POST",
        body: JSON.stringify({ depositEnabled: enabled }),
      });
      setSettings(nextSettings);
      toast.success(enabled ? "充值功能已开启" : "充值功能已关闭");
    } catch (error) {
      setSettings(previous);
      toast.error(error instanceof Error ? error.message : "保存充值设置失败");
    }
  }, [settings]);

  const setExtractMethodSelectionEnabled = useCallback(async (enabled: boolean) => {
    const previous = settings;
    try {
      setSettings((current) => ({ ...current, extractMethodSelectionEnabled: enabled }));
      const nextSettings = await apiFetch<PublicSiteSettings>("/api/admin/settings", {
        method: "POST",
        body: JSON.stringify({ extractMethodSelectionEnabled: enabled }),
      });
      setSettings(nextSettings);
      toast.success(enabled ? "提取渠道选择已开启" : "提取渠道选择已关闭，前台默认 UPI 渠道");
    } catch (error) {
      setSettings(previous);
      toast.error(error instanceof Error ? error.message : "保存提取渠道设置失败");
    }
  }, [settings]);

  const setCustomProxyEnabled = useCallback(async (enabled: boolean) => {
    const previous = settings;
    try {
      setSettings((current) => ({ ...current, customProxyEnabled: enabled }));
      const nextSettings = await apiFetch<PublicSiteSettings>("/api/admin/settings", {
        method: "POST",
        body: JSON.stringify({ customProxyEnabled: enabled }),
      });
      setSettings(nextSettings);
      toast.success(enabled ? "用户自定义代理功能已开启" : "用户自定义代理功能已关闭");
    } catch (error) {
      setSettings(previous);
      toast.error(error instanceof Error ? error.message : "保存自定义代理设置失败");
    }
  }, [settings]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(true), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  const onlineWorkers = workers.filter((worker) => worker.status === "ONLINE").length;
  const unsettledAmount = workers.reduce((sum, worker) => sum + (worker.unsettledAmount ?? 0), 0);

  return (
    <AppFrame audience="admin" title="全局管理" subtitle="查看系统概览，并进入充值 CDK、接单账号、订单、代理、提取和用户管理等页面。" onRefresh={() => refresh()}>
      <div className="grid gap-4 xl:grid-cols-3">
        <MetricCard title="充值 CDK 数量" value={cdks.length} description="进入充值 CDK 页面可批量生成、查看和按批次导出。" icon={KeyRoundIcon} tone="brand" />
        <MetricCard title="未兑换价值" value={`${cdks.reduce((sum, cdk) => sum + (!cdk.redeemedAt && cdk.status === "ACTIVE" ? cdk.amount : 0), 0).toFixed(2)}U`} description="全部未兑换充值 CDK 的金额合计。" icon={DatabaseIcon} tone="success" />
        <MetricCard title="未结金额" value={formatMoney(unsettledAmount)} description="已完成但未结单的 worker 收入。" icon={ShieldCheckIcon} tone="warning" />
      </div>

      <Card className="mt-4 rounded-3xl bg-background shadow-sm">
        <CardHeader>
          <CardTitle>公益站设置</CardTitle>
          <CardDescription>控制 UPI 公益二维码提取页右下角按钮、用户充值入口等公开页面功能。</CardDescription>
          <CardAction><Globe2Icon className="size-5 text-muted-foreground" /></CardAction>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-col gap-3 rounded-2xl border border-border bg-muted/30 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="font-medium">显示 TG 群组按钮</div>
              <div className="mt-1 text-sm text-muted-foreground">
                开启后，公益提取页右下角会显示 TG 群组按钮，点击打开 {settings.tgInviteUrl}
              </div>
            </div>
            <Switch checked={settings.tgInviteEnabled} onCheckedChange={setTgInviteEnabled} disabled={loading} />
          </div>
          <div className="flex flex-col gap-3 rounded-2xl border border-border bg-muted/30 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="font-medium">开启用户充值</div>
              <div className="mt-1 text-sm text-muted-foreground">
                关闭后，UPI 提取页的钱包充值入口会禁用，服务端也会拒绝创建新的充值订单。
              </div>
            </div>
            <Switch checked={settings.depositEnabled} onCheckedChange={setDepositEnabled} disabled={loading} />
          </div>
          <div className="flex flex-col gap-3 rounded-2xl border border-border bg-muted/30 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="font-medium">显示提取渠道选择</div>
              <div className="mt-1 text-sm text-muted-foreground">
                关闭后，用户侧默认 UPI 渠道，后端也会忽略其它渠道参数。
              </div>
            </div>
            <Switch checked={settings.extractMethodSelectionEnabled} onCheckedChange={setExtractMethodSelectionEnabled} disabled={loading} />
          </div>
          <div className="flex flex-col gap-3 rounded-2xl border border-border bg-muted/30 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="font-medium">允许用户自定义代理</div>
              <div className="mt-1 text-sm text-muted-foreground">
                关闭后，用户侧隐藏自定义 checkout/provider 代理，后端也会忽略用户代理参数。
              </div>
            </div>
            <Switch checked={settings.customProxyEnabled} onCheckedChange={setCustomProxyEnabled} disabled={loading} />
          </div>
        </CardContent>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-[420px_1fr]">
        <Card className="rounded-3xl bg-background shadow-sm">
          <CardHeader>
            <CardTitle>接单账号</CardTitle>
            <CardDescription>账号总数和当前在线接单方放在同一个卡片内。</CardDescription>
            <CardAction><UsersRoundIcon className="size-5 text-muted-foreground" /></CardAction>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-2xl bg-muted/40 p-4"><div className="text-sm text-muted-foreground">接单账号</div><div className="mt-2 text-4xl font-semibold tracking-tight">{workers.length}</div></div>
              <div className="rounded-2xl bg-muted/40 p-4"><div className="text-sm text-muted-foreground">在线接单方</div><div className="mt-2 text-4xl font-semibold tracking-tight">{onlineWorkers}</div></div>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              <Link href="/admin/workers" className={buttonVariants({ variant: "outline" })}><UsersRoundIcon data-icon="inline-start" />管理接单账号</Link>
              <Link href="/admin/cdks" className={buttonVariants({ variant: "outline" })}><KeyRoundIcon data-icon="inline-start" />管理充值 CDK</Link>
              <Link href="/admin/orders" className={buttonVariants({ variant: "outline" })}><ClipboardListIcon data-icon="inline-start" />查看订单</Link>
              <Link href="/admin/proxies" className={buttonVariants({ variant: "outline" })}><Globe2Icon data-icon="inline-start" />代理列表</Link>
              <Link href="/admin/upi-extract" className={buttonVariants({ variant: "outline" })}><ActivityIcon data-icon="inline-start" />提取管理</Link>
              <Link href="/admin/users" className={buttonVariants({ variant: "outline" })}><UsersRoundIcon data-icon="inline-start" />用户管理</Link>
              <Link href="/admin/billing" className={buttonVariants({ variant: "outline" })}><WalletIcon data-icon="inline-start" />充值账单</Link>
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-3xl bg-background shadow-sm">
          <CardHeader><CardTitle>管理入口</CardTitle><CardDescription>常用管理功能已经拆分为独立页面。</CardDescription></CardHeader>
          <CardContent>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              <AdminNavCard title="充值 CDK" description="批量生成 upi_ 充值 key、按批次导出、查看兑换状态。" href="/admin/cdks" icon={KeyRoundIcon} />
              <AdminNavCard title="接单账号" description="创建 Telegram worker、设置单价、结单和钱包。" href="/admin/workers" icon={UserPlusIcon} />
              <AdminNavCard title="全部订单" description="查看订单大厅、进行中、需重传和历史订单。" href="/admin/orders" icon={ClipboardListIcon} />
              <AdminNavCard title="代理列表" description="管理公共提取代理池，检测出口国家和连通性。" href="/admin/proxies" icon={Globe2Icon} />
              <AdminNavCard title="提取管理" description="暂停提取入口，查看实时任务，调整并发上限。" href="/admin/upi-extract" icon={ActivityIcon} />
              <AdminNavCard title="用户管理" description="管理用户身份、余额、提现申请和充值设置。" href="/admin/users" icon={UsersRoundIcon} />
              <AdminNavCard title="充值账单" description="查看用户钱包流水、充值订单、链上入账和提现记录。" href="/admin/billing" icon={WalletIcon} />
            </div>
            {loading && <p className="mt-4 text-sm text-muted-foreground">正在刷新数据…</p>}
          </CardContent>
        </Card>
      </div>
    </AppFrame>
  );
}

export function AdminCdksClient() {
  const rechargeAmounts = [1.8, 5, 10] as const;
  const formatCdkAmount = (value: number) => `${Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}U`;
  const makeRechargeCdkCode = () => {
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return `upi_${Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("")}`;
  };
  const [cdks, setCdks] = useState<PublicCdk[]>([]);
  const [batches, setBatches] = useState<PublicCdkBatch[]>([]);
  const [cdkSearch, setCdkSearch] = useState("");
  const [batchSearch, setBatchSearch] = useState("");
  const deferredCdkSearch = useDeferredValue(cdkSearch);
  const deferredBatchSearch = useDeferredValue(batchSearch);
  const [cdkPage, setCdkPage] = useState(1);
  const [batchPage, setBatchPage] = useState(1);
  const [cdkPagination, setCdkPagination] = useState<AdminPaginationMeta | null>(null);
  const [batchPagination, setBatchPagination] = useState<AdminPaginationMeta | null>(null);
  const [cdkCode, setCdkCode] = useState("upi_custom_recharge_key");
  const [cdkAmount, setCdkAmount] = useState<(typeof rechargeAmounts)[number]>(1.8);
  const [cdkRemark, setCdkRemark] = useState("");
  const [batchName, setBatchName] = useState("");
  const [batchKeyCount, setBatchKeyCount] = useState(20);
  const [batchAmount, setBatchAmount] = useState<(typeof rechargeAmounts)[number]>(1.8);
  const [batchRemark, setBatchRemark] = useState("");
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async (silent = false) => {
    try {
      const [nextCdks, nextBatches] = await Promise.all([
        apiFetch<AdminPaginatedResponse<PublicCdk>>(pagedAdminUrl("/api/admin/cdks", { page: cdkPage, search: deferredCdkSearch })),
        apiFetch<AdminPaginatedResponse<PublicCdkBatch>>(pagedAdminUrl("/api/admin/cdks/batches", { page: batchPage, search: deferredBatchSearch })),
      ]);
      setCdks(nextCdks.items);
      setBatches(nextBatches.items);
      setCdkPagination(nextCdks.pagination);
      setBatchPagination(nextBatches.pagination);
      if (!silent) toast.success("充值 CDK 数据已刷新");
    } catch (error) {
      if (!silent) toast.error(error instanceof Error ? error.message : "刷新失败");
    }
  }, [batchPage, cdkPage, deferredBatchSearch, deferredCdkSearch]);

  async function createCdk(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      setLoading(true);
      await apiFetch<PublicCdk>("/api/admin/cdks", {
        method: "POST",
        body: JSON.stringify({ code: cdkCode, amount: cdkAmount, remark: cdkRemark }),
      });
      setCdkPage(1);
      await refresh(true);
      toast.success(`充值 CDK 已创建：${formatCdkAmount(cdkAmount)}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "创建 CDK 失败");
    } finally {
      setLoading(false);
    }
  }

  async function createBatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      setLoading(true);
      const result = await apiFetch<{ batch: PublicCdkBatch; cdks: PublicCdk[] }>("/api/admin/cdks/batches", {
        method: "POST",
        body: JSON.stringify({
          count: batchKeyCount,
          amount: batchAmount,
          name: batchName,
          remark: batchRemark,
        }),
      });
      setBatchPage(1);
      setCdkPage(1);
      await refresh(true);
      toast.success(`已生成 ${result.batch.cdkCount} 个 ${formatCdkAmount(result.batch.amount)} 充值 CDK`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "批量生成 CDK 失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(true), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  const redeemedCount = cdks.filter((cdk) => Boolean(cdk.redeemedAt)).length;
  const activeValue = cdks.reduce((sum, cdk) => sum + (!cdk.redeemedAt && cdk.status === "ACTIVE" ? cdk.amount : 0), 0);
  const redeemedValue = cdks.reduce((sum, cdk) => sum + (cdk.redeemedAt ? cdk.amount : 0), 0);

  return (
    <AppFrame audience="admin" title="充值 CDK" subtitle="生成 upi_ 开头的充值券，用户可在钱包内兑换为 USDT 余额。当前支持 1.8U、5U、10U。" onRefresh={() => refresh()}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2 text-sm text-muted-foreground">
          <Badge variant="secondary">总数 {cdkPagination?.total ?? cdks.length}</Badge>
          <Badge variant="outline">本页已兑换 {redeemedCount}</Badge>
          <Badge variant="outline">本页未兑换价值 {formatCdkAmount(activeValue)}</Badge>
          <Badge variant="outline">本页已兑换价值 {formatCdkAmount(redeemedValue)}</Badge>
        </div>
        <a href="/api/admin/cdks/export" download className={buttonVariants({ variant: "outline" })}>
          <DownloadIcon data-icon="inline-start" />导出全部 CSV
        </a>
      </div>

      <div className="grid gap-4 xl:grid-cols-[420px_1fr]">
        <div className="flex flex-col gap-4">
          <Card className="rounded-3xl bg-background shadow-sm">
            <CardHeader>
              <CardTitle>批量生成充值 CDK</CardTitle>
              <CardDescription>自动生成 upi_xxxxxxxxxxxxxxxx 格式 key，并给每个 key 绑定固定充值金额。</CardDescription>
              <CardAction><KeyRoundIcon className="size-5 text-muted-foreground" /></CardAction>
            </CardHeader>
            <CardContent>
              <form onSubmit={createBatch} className="flex flex-col gap-5">
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="batch-key-count">生成数量</FieldLabel>
                    <Input id="batch-key-count" type="number" min={1} max={1000} value={batchKeyCount} onChange={(event) => setBatchKeyCount(Number(event.target.value))} />
                    <FieldDescription>单批最多 1000 个。</FieldDescription>
                  </Field>
                  <Field>
                    <FieldLabel>充值金额</FieldLabel>
                    <div className="grid grid-cols-3 gap-2">
                      {rechargeAmounts.map((amount) => (
                        <Button key={amount} type="button" variant={batchAmount === amount ? "default" : "outline"} className="rounded-xl" onClick={() => setBatchAmount(amount)}>
                          {formatCdkAmount(amount)}
                        </Button>
                      ))}
                    </div>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="batch-name">批次名称</FieldLabel>
                    <Input id="batch-name" value={batchName} onChange={(event) => setBatchName(event.target.value)} placeholder="例如 2026-06 活动批次" />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="batch-remark">备注</FieldLabel>
                    <Input id="batch-remark" value={batchRemark} onChange={(event) => setBatchRemark(event.target.value)} placeholder="非必填，会同步写入本批 CDK" />
                  </Field>
                </FieldGroup>
                <Button type="submit" disabled={loading}><PlusIcon data-icon="inline-start" />生成批次</Button>
              </form>
            </CardContent>
          </Card>

          <Card className="rounded-3xl bg-background shadow-sm">
            <CardHeader>
              <CardTitle>手动创建充值 CDK</CardTitle>
              <CardDescription>创建单个充值券；自定义 key 也建议使用 upi_ 前缀。</CardDescription>
              <CardAction><KeyRoundIcon className="size-5 text-muted-foreground" /></CardAction>
            </CardHeader>
            <CardContent>
              <form onSubmit={createCdk} className="flex flex-col gap-5">
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="cdk-code">CDK</FieldLabel>
                    <div className="flex gap-2">
                      <Input id="cdk-code" value={cdkCode} onChange={(event) => setCdkCode(event.target.value)} />
                      <Button type="button" variant="outline" className="shrink-0 rounded-xl" onClick={() => setCdkCode(makeRechargeCdkCode())}>
                        随机生成
                      </Button>
                    </div>
                    <FieldDescription>每个充值 CDK 只能兑换一次。</FieldDescription>
                  </Field>
                  <Field>
                    <FieldLabel>充值金额</FieldLabel>
                    <div className="grid grid-cols-3 gap-2">
                      {rechargeAmounts.map((amount) => (
                        <Button key={amount} type="button" variant={cdkAmount === amount ? "default" : "outline"} className="rounded-xl" onClick={() => setCdkAmount(amount)}>
                          {formatCdkAmount(amount)}
                        </Button>
                      ))}
                    </div>
                  </Field>
                  <Field><FieldLabel htmlFor="cdk-remark">备注</FieldLabel><Input id="cdk-remark" value={cdkRemark} onChange={(event) => setCdkRemark(event.target.value)} placeholder="非必填" /></Field>
                </FieldGroup>
                <Button type="submit" disabled={loading}><PlusIcon data-icon="inline-start" />创建充值 CDK</Button>
              </form>
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <Card className="rounded-3xl bg-background shadow-sm">
            <CardHeader>
              <CardTitle>生成批次</CardTitle>
              <CardDescription>每个批次都可以单独导出。</CardDescription>
              <CardAction><Button variant="outline" size="sm" onClick={() => refresh()}><RefreshCwIcon data-icon="inline-start" />刷新</Button></CardAction>
            </CardHeader>
            <CardContent>
              <div className="mb-3 flex items-center gap-2">
                <SearchIcon className="size-4 text-muted-foreground" />
                <Input value={batchSearch} onChange={(event) => { setBatchSearch(event.target.value); setBatchPage(1); }} placeholder="搜索批次 ID / 名称 / 备注" />
              </div>
              <div className="overflow-hidden rounded-3xl border border-border">
                <Table>
                  <TableHeader><TableRow><TableHead>批次</TableHead><TableHead>数量</TableHead><TableHead>金额</TableHead><TableHead>创建时间</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {batches.map((batch) => (
                      <TableRow key={batch.id}>
                        <TableCell><div className="font-semibold">{batch.name || batch.id}</div><div className="text-xs text-muted-foreground">{batch.remark || "无备注"}</div></TableCell>
                        <TableCell><Badge variant="secondary">{batch.cdkCount}</Badge></TableCell>
                        <TableCell>{formatCdkAmount(batch.amount)}</TableCell>
                        <TableCell>{formatDateTime(batch.createdAt)}</TableCell>
                        <TableCell className="text-right"><a href={`/api/admin/cdks/batches/${batch.id}/export`} download className={buttonVariants({ variant: "outline", size: "sm" })}><DownloadIcon data-icon="inline-start" />导出</a></TableCell>
                      </TableRow>
                    ))}
                    {batches.length === 0 && <TableRow><TableCell colSpan={5} className="h-28 text-center text-muted-foreground">暂无批次</TableCell></TableRow>}
                  </TableBody>
                </Table>
              </div>
              <AdminListPagination pagination={batchPagination} loading={loading} onPageChange={setBatchPage} className="mt-4" />
            </CardContent>
          </Card>

          <Card className="rounded-3xl bg-background shadow-sm">
            <CardHeader><CardTitle>充值 CDK 列表</CardTitle><CardDescription>未兑换的 ACTIVE key 可以在用户钱包中兑换余额，同一个 key 只能兑换一次。</CardDescription><CardAction><Button variant="outline" size="sm" onClick={() => refresh()}><RefreshCwIcon data-icon="inline-start" />刷新</Button></CardAction></CardHeader>
            <CardContent>
              <div className="mb-3 flex items-center gap-2">
                <SearchIcon className="size-4 text-muted-foreground" />
                <Input value={cdkSearch} onChange={(event) => { setCdkSearch(event.target.value); setCdkPage(1); }} placeholder="搜索 CDK / 兑换用户 / 备注" />
              </div>
              <div className="overflow-hidden rounded-3xl border border-border">
                <Table>
                  <TableHeader><TableRow><TableHead>CDK</TableHead><TableHead>金额</TableHead><TableHead>状态</TableHead><TableHead>兑换用户</TableHead><TableHead>创建时间</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {cdks.map((cdk) => {
                      const redeemed = Boolean(cdk.redeemedAt);
                      return (
                        <TableRow key={cdk.id}>
                          <TableCell><div className="font-semibold">{cdk.code}</div><div className="text-xs text-muted-foreground">{cdk.remark || (cdk.batchId ? `批次：${cdk.batchId}` : "-")}</div></TableCell>
                          <TableCell>{formatCdkAmount(cdk.amount)}</TableCell>
                          <TableCell><Badge variant={redeemed ? "secondary" : cdk.status === "ACTIVE" ? "default" : "outline"}>{redeemed ? "已兑换" : cdk.status === "ACTIVE" ? "未兑换" : cdk.status}</Badge></TableCell>
                          <TableCell>{redeemed ? <div><div className="font-medium">{cdk.redeemedByTelegramName || "-"}</div><div className="text-xs text-muted-foreground">{cdk.redeemedByTelegramId || "-"} - {formatDateTime(cdk.redeemedAt || cdk.createdAt)}</div></div> : "-"}</TableCell>
                          <TableCell>{formatDateTime(cdk.createdAt)}</TableCell>
                        </TableRow>
                      );
                    })}
                    {cdks.length === 0 && <TableRow><TableCell colSpan={5} className="h-28 text-center text-muted-foreground">暂无充值 CDK</TableCell></TableRow>}
                  </TableBody>
                </Table>
              </div>
              <AdminListPagination pagination={cdkPagination} loading={loading} onPageChange={setCdkPage} className="mt-4" />
            </CardContent>
          </Card>
        </div>
      </div>
    </AppFrame>
  );
}

type AdminOrderFilter = "ALL" | "HALL" | "ACTIVE" | "REUPLOAD" | "HISTORY";

const historyOrderStatuses: OrderStatus[] = ["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"];
const orderFilterLabels: Record<AdminOrderFilter, string> = {
  ALL: "全部",
  HALL: "订单大厅",
  ACTIVE: "正在进行",
  REUPLOAD: "需重传",
  HISTORY: "历史",
};

export function AdminOrdersClient() {
  const [orders, setOrders] = useState<PublicOrder[]>([]);
  const [filter, setFilter] = useState<AdminOrderFilter>("ALL");
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState<AdminPaginationMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async (silent = false) => {
    try {
      setLoading(true);
      const response = await apiFetch<AdminPaginatedResponse<PublicOrder>>(pagedAdminUrl("/api/admin/orders", {
        page,
        search: deferredSearch,
        extra: { filter },
      }));
      setOrders(response.items);
      setPagination(response.pagination);
      if (!silent) toast.success("订单数据已刷新");
    } catch (error) {
      if (!silent) toast.error(error instanceof Error ? error.message : "刷新失败");
    } finally {
      setLoading(false);
    }
  }, [deferredSearch, filter, page]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(true), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const filteredOrders = orders;

  const hallCount = orders.filter((order) => order.status === "PENDING").length;
  const activeCount = orders.filter((order) => order.status === "ASSIGNED" || order.status === "CHECKING").length;
  const reuploadCount = orders.filter((order) => order.status === "NEED_REUPLOAD").length;
  const historyCount = orders.filter((order) => historyOrderStatuses.includes(order.status)).length;

  return (
    <AppFrame audience="admin" title="全部订单" subtitle="查看订单大厅、正在进行、需重传和历史订单。" onRefresh={() => refresh()}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Button variant="outline" onClick={() => refresh()} disabled={loading}><RefreshCwIcon data-icon="inline-start" />刷新</Button>
      </div>

      <div className="grid gap-4 xl:grid-cols-4">
        <MetricCard title="订单大厅" value={hallCount} description="等待 worker 接取的订单" icon={ClipboardListIcon} tone="warning" />
        <MetricCard title="正在进行" value={activeCount} description="已接取但未完成" icon={ShieldCheckIcon} tone="info" />
        <MetricCard title="需重传" value={reuploadCount} description="worker 已退回等待客户重传" icon={AlertTriangleIcon} tone="warning" />
        <MetricCard title="历史订单" value={historyCount} description="完成、取消、失败或超时" icon={DatabaseIcon} tone="brand" />
      </div>

      <Card className="mt-4 rounded-3xl bg-background shadow-sm">
        <CardHeader>
          <CardTitle>订单列表</CardTitle>
          <CardDescription>订单列表只展示订单状态与处理信息；二维码在接单方当前订单区域生成。</CardDescription>
          <CardAction>{pagination ? `${filteredOrders.length} / ${pagination.total}` : filteredOrders.length}</CardAction>
        </CardHeader>
        <CardContent>
          <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap gap-2">
              {(Object.keys(orderFilterLabels) as AdminOrderFilter[]).map((item) => (
                <Button key={item} type="button" size="sm" variant={filter === item ? "default" : "outline"} onClick={() => { setFilter(item); setPage(1); }}>
                  {orderFilterLabels[item]}
                </Button>
              ))}
            </div>
            <div className="relative w-full lg:max-w-sm">
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="搜索订单号、CDK 或接单方" className="pl-9" />
            </div>
          </div>

          <div className="overflow-hidden rounded-3xl border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>订单</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>CDK</TableHead>
                  <TableHead>接单方</TableHead>
                  <TableHead>时间</TableHead>
                  <TableHead>备注</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredOrders.map((order) => {
                  const displayWorker = order.assignedWorker ?? order.lastWorker;
                  const isHistoryWorker = !order.assignedWorker && Boolean(order.lastWorker);
                  const qrRemainingText = formatOrderQrRemaining(order.upiExpiresAt, now);
                  return (
                    <TableRow key={order.id}>
                      <TableCell>
                        <div>
                          <div className="font-semibold">{order.orderNo}</div>
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            {order.hasSessionCredential && <Badge variant="secondary">{order.upiExtractionStatus || "PENDING"}</Badge>}
                            {order.qrIsUpi === false && <Badge variant="destructive"><AlertTriangleIcon data-icon="inline-start" />疑似非 UPI</Badge>}
                            {qrRemainingText && <Badge variant={qrRemainingText === "已过期" ? "outline" : "secondary"}>二维码 {qrRemainingText}</Badge>}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell><OrderStatusBadge status={order.status} language="zh" /></TableCell>
                      <TableCell>
                        {order.cdk ? (
                          <div><div className="font-mono text-xs">{order.cdk.code}</div><div className="text-xs text-muted-foreground">可用 {order.cdk.availableCount}</div></div>
                        ) : (
                          <div><Badge variant="secondary">扫码单</Badge><div className="mt-1 text-xs text-muted-foreground">{formatMoney(order.scanPrice ?? 0)}</div></div>
                        )}
                      </TableCell>
                      <TableCell>{displayWorker ? <div><div className="font-semibold">{displayWorker.displayName}</div><div className="text-xs text-muted-foreground">@{displayWorker.username}{isHistoryWorker ? " · 历史接单" : ""}</div></div> : <span className="text-muted-foreground">未接取</span>}</TableCell>
                      <TableCell><div className="text-sm">{formatDateTime(order.createdAt)}</div><div className="text-xs text-muted-foreground">更新 {formatDateTime(order.updatedAt)}</div></TableCell>
                      <TableCell className="max-w-[260px] truncate">{order.problemReason || order.customerNote || "-"}</TableCell>
                    </TableRow>
                  );
                })}
                {filteredOrders.length === 0 && <TableRow><TableCell colSpan={6} className="h-40 text-center text-muted-foreground">暂无订单</TableCell></TableRow>}
              </TableBody>
            </Table>
          </div>
          <AdminListPagination pagination={pagination} loading={loading} onPageChange={setPage} className="mt-4" />
        </CardContent>
      </Card>
    </AppFrame>
  );
}

export function AdminWorkersClient() {
  type WorkerAdminSection = "workers" | "withdrawals";
  const [workers, setWorkers] = useState<AdminWorker[]>([]);
  const [withdrawals, setWithdrawals] = useState<PublicWorkerWithdrawalRequest[]>([]);
  const [activeSection, setActiveSection] = useState<WorkerAdminSection>("workers");
  const [workerSearch, setWorkerSearch] = useState("");
  const [withdrawalSearch, setWithdrawalSearch] = useState("");
  const deferredWorkerSearch = useDeferredValue(workerSearch);
  const deferredWithdrawalSearch = useDeferredValue(withdrawalSearch);
  const [workerPage, setWorkerPage] = useState(1);
  const [withdrawalPage, setWithdrawalPage] = useState(1);
  const [workerPagination, setWorkerPagination] = useState<AdminPaginationMeta | null>(null);
  const [withdrawalPagination, setWithdrawalPagination] = useState<AdminPaginationMeta | null>(null);
  const [workerPriceDrafts, setWorkerPriceDrafts] = useState<Record<string, string>>({});
  const [workerUsername, setWorkerUsername] = useState("worker");
  const [workerName, setWorkerName] = useState("接单员");
  const [workerUnitPrice, setWorkerUnitPrice] = useState("0.70");
  const [workerPayoutMode, setNewWorkerPayoutMode] = useState<"POSTPAID" | "PREPAID">("POSTPAID");
  const [workerBinanceUserId, setWorkerBinanceUserId] = useState("");
  const [workerTelegramId, setWorkerTelegramId] = useState("");
  const [workerTelegramUsername, setWorkerTelegramUsername] = useState("");
  const [createWorkerOpen, setCreateWorkerOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async (silent = false) => {
    try {
      const [nextWorkers, nextWithdrawals] = await Promise.all([
        apiFetch<AdminPaginatedResponse<AdminWorker>>(pagedAdminUrl("/api/admin/workers", { page: workerPage, search: deferredWorkerSearch })),
        apiFetch<AdminPaginatedResponse<PublicWorkerWithdrawalRequest>>(pagedAdminUrl("/api/admin/withdrawals", { page: withdrawalPage, search: deferredWithdrawalSearch })),
      ]);
      setWorkers(nextWorkers.items);
      setWithdrawals(nextWithdrawals.items);
      setWorkerPagination(nextWorkers.pagination);
      setWithdrawalPagination(nextWithdrawals.pagination);
      if (!silent) toast.success("接单账号已刷新");
    } catch (error) {
      if (!silent) toast.error(error instanceof Error ? error.message : "刷新失败");
    }
  }, [deferredWithdrawalSearch, deferredWorkerSearch, withdrawalPage, workerPage]);

  async function createWorker(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      setLoading(true);
      const worker = await apiFetch<AdminWorker>("/api/admin/workers", { method: "POST", body: JSON.stringify({ username: workerUsername, displayName: workerName, unitPrice: workerUnitPrice, payoutMode: workerPayoutMode, binanceUserId: workerBinanceUserId, telegramUserId: workerTelegramId, telegramUsername: workerTelegramUsername }) });
      setWorkers((current) => [worker, ...current].slice(0, ADMIN_PAGE_SIZE));
      setWorkerPage(1);
      setCreateWorkerOpen(false);
      toast.success("接单账号已创建");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "创建接单账号失败");
    } finally {
      setLoading(false);
    }
  }

  async function settleWorker(worker: AdminWorker) {
    if ((worker.unsettledCompleted ?? 0) <= 0) {
      toast.info("该接单方暂无未结订单");
      return;
    }
    try {
      setLoading(true);
      const result = await apiFetch<{ settledCount: number; settledAmount: number }>("/api/admin/workers/" + worker.id + "/settle", { method: "POST" });
      toast.success("已结单 " + result.settledCount + " 单，金额 " + formatMoney(result.settledAmount));
      setWorkers((current) => current.map((item) => item.id === worker.id
        ? {
            ...item,
            unsettledCompleted: Math.max(0, (item.unsettledCompleted ?? 0) - result.settledCount),
            unsettledAmount: Math.max(0, (item.unsettledAmount ?? 0) - result.settledAmount),
            settledCompleted: (item.settledCompleted ?? 0) + result.settledCount,
            settledAmount: (item.settledAmount ?? 0) + result.settledAmount,
          }
        : item));
      await refresh(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "结单失败");
    } finally {
      setLoading(false);
    }
  }

  async function offlineWorker(worker: AdminWorker) {
    if (worker.status !== "ONLINE") {
      toast.info("该接单方当前已离线");
      return;
    }
    if (worker.activeOrder) {
      toast.error(`该接单方有进行中订单 ${worker.activeOrder.orderNo}，完成或退回后才能下线`);
      return;
    }
    try {
      setLoading(true);
      await apiFetch<PublicWorker>("/api/admin/workers/" + worker.id + "/offline", { method: "POST" });
      toast.success(`已将 ${worker.displayName} 下线，并关闭自动接单`);
      await refresh(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "下线失败");
    } finally {
      setLoading(false);
    }
  }

  async function disableWorkerAutoAccept(worker: AdminWorker) {
    if (!worker.autoAcceptEnabled) {
      toast.info("该接单方自动接单已关闭");
      return;
    }
    try {
      setLoading(true);
      await apiFetch<PublicWorker>("/api/admin/workers/" + worker.id + "/auto-accept", {
        method: "POST",
        body: JSON.stringify({ enabled: false }),
      });
      toast.success(`已关闭 ${worker.displayName} 的自动接单`);
      await refresh(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "关闭自动接单失败");
    } finally {
      setLoading(false);
    }
  }

  async function updateWorkerUnitPrice(worker: AdminWorker) {
    const unitPrice = workerPriceDrafts[worker.id] ?? String(worker.unitPrice ?? 0);
    try {
      setLoading(true);
      await apiFetch<PublicWorker>("/api/admin/workers/" + worker.id + "/unit-price", {
        method: "POST",
        body: JSON.stringify({ unitPrice }),
      });
      toast.success(`${worker.displayName} 单价已更新为 ${formatMoney(unitPrice)}`);
      setWorkerPriceDrafts((current) => {
        const next = { ...current };
        delete next[worker.id];
        return next;
      });
      await refresh(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "修改单价失败");
    } finally {
      setLoading(false);
    }
  }

  async function setWorkerDisabled(worker: AdminWorker, disabled: boolean) {
    try {
      setLoading(true);
      await apiFetch<PublicWorker>("/api/admin/workers/" + worker.id + "/disabled", {
        method: "POST",
        body: JSON.stringify({ disabled }),
      });
      toast.success(disabled ? `${worker.displayName} 已停用` : `${worker.displayName} 已启用`);
      await refresh(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : (disabled ? "停用账号失败" : "启用账号失败"));
    } finally {
      setLoading(false);
    }
  }

  async function setWorkerPayoutMode(worker: AdminWorker, payoutMode: "POSTPAID" | "PREPAID") {
    try {
      setLoading(true);
      await apiFetch<PublicWorker>("/api/admin/workers/" + worker.id + "/payout-mode", {
        method: "POST",
        body: JSON.stringify({ payoutMode }),
      });
      toast.success(`${worker.displayName} 已切换为${payoutMode === "PREPAID" ? "预付费" : "后付费"}模式`);
      await refresh(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "切换付款模式失败");
    } finally {
      setLoading(false);
    }
  }

  async function advanceWorker(worker: AdminWorker) {
    const amount = window.prompt(`给 ${worker.displayName} 记录预支金额（USD）`, "10.00");
    if (!amount) return;
    try {
      setLoading(true);
      await apiFetch<WorkerWalletSummary>("/api/admin/workers/" + worker.id + "/advance", {
        method: "POST",
        body: JSON.stringify({ amount, note: "管理员预支款" }),
      });
      toast.success(`已给 ${worker.displayName} 记录预支款 ${formatMoney(amount)}`);
      await refresh(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "记录预支款失败");
    } finally {
      setLoading(false);
    }
  }

  async function markWithdrawalPaid(request: PublicWorkerWithdrawalRequest) {
    try {
      setLoading(true);
      await apiFetch<PublicWorkerWithdrawalRequest>("/api/admin/withdrawals/" + request.id + "/paid", { method: "POST" });
      toast.success("提现申请已标记为已付款");
      await refresh(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "处理提现失败");
    } finally {
      setLoading(false);
    }
  }

  async function rejectWithdrawal(request: PublicWorkerWithdrawalRequest) {
    const adminNote = window.prompt("拒绝原因", request.adminNote || "");
    if (adminNote === null) return;
    try {
      setLoading(true);
      await apiFetch<PublicWorkerWithdrawalRequest>("/api/admin/withdrawals/" + request.id + "/reject", {
        method: "POST",
        body: JSON.stringify({ adminNote }),
      });
      toast.success("提现申请已拒绝");
      await refresh(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "拒绝提现失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(true), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  const onlineWorkers = workers.filter((worker) => worker.status === "ONLINE").length;
  const pendingWithdrawals = withdrawals.filter((request) => request.status === "PENDING");
  const pendingWithdrawalAmount = pendingWithdrawals.reduce((sum, request) => sum + request.amount, 0);

  return (
    <AppFrame audience="admin" title="接单账号" subtitle="创建 Telegram worker、设置单价，并结算已完成订单。" onRefresh={() => refresh()}>
      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Card className="rounded-3xl bg-background shadow-sm">
          <CardHeader>
            <CardTitle>接单账号 / 在线接单方</CardTitle>
            <CardDescription>账号总数和当前在线人数统一显示。</CardDescription>
            <CardAction>
              <Button size="sm" onClick={() => setCreateWorkerOpen(true)}>
                <UserPlusIcon data-icon="inline-start" />
                创建接单账号
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-2xl bg-muted/40 p-4"><div className="text-sm text-muted-foreground">接单账号</div><div className="mt-2 text-4xl font-semibold tracking-tight">{workerPagination?.total ?? workers.length}</div></div>
              <div className="rounded-2xl bg-muted/40 p-4"><div className="text-sm text-muted-foreground">在线接单方</div><div className="mt-2 text-4xl font-semibold tracking-tight">{onlineWorkers}</div></div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Sheet open={createWorkerOpen} onOpenChange={setCreateWorkerOpen}>
        <SheetContent className="overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>创建接单账号</SheetTitle>
            <SheetDescription>已关闭账号密码登录；接单方只通过 Telegram Bot 登录。</SheetDescription>
          </SheetHeader>
          <form onSubmit={createWorker} className="flex flex-col gap-5">
            <FieldGroup>
              <Field><FieldLabel htmlFor="worker-username">账号标识</FieldLabel><Input id="worker-username" value={workerUsername} onChange={(event) => setWorkerUsername(event.target.value)} /></Field>
              <Field><FieldLabel htmlFor="worker-name">昵称</FieldLabel><Input id="worker-name" value={workerName} onChange={(event) => setWorkerName(event.target.value)} /></Field>
              <Field><FieldLabel htmlFor="worker-unit-price">单价（USD/单）</FieldLabel><Input id="worker-unit-price" inputMode="decimal" value={workerUnitPrice} onChange={(event) => setWorkerUnitPrice(event.target.value)} placeholder="0.70" /><FieldDescription>完成订单时会保存当时单价，后续改价不影响历史。</FieldDescription></Field>
              <Field>
                <FieldLabel htmlFor="worker-binance">Binance 用户 ID</FieldLabel>
                <Input id="worker-binance" value={workerBinanceUserId} onChange={(event) => setWorkerBinanceUserId(event.target.value)} placeholder="可先留空，worker 登录后会弹窗提醒绑定" />
              </Field>
              <Field>
                <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-muted/30 p-3">
                  <div>
                    <FieldLabel>预付费模式</FieldLabel>
                    <FieldDescription>开启后可先记录预支款，钱包余额会从负数开始，完成订单后自动抵扣。</FieldDescription>
                  </div>
                  <Switch checked={workerPayoutMode === "PREPAID"} onCheckedChange={(checked) => setNewWorkerPayoutMode(checked ? "PREPAID" : "POSTPAID")} />
                </div>
              </Field>
              <Field><FieldLabel htmlFor="worker-telegram-id">Telegram ID</FieldLabel><Input id="worker-telegram-id" value={workerTelegramId} onChange={(event) => setWorkerTelegramId(event.target.value)} placeholder="例如 1000000000，可选" /></Field>
              <Field><FieldLabel htmlFor="worker-telegram-username">Telegram 用户名</FieldLabel><Input id="worker-telegram-username" value={workerTelegramUsername} onChange={(event) => setWorkerTelegramUsername(event.target.value)} placeholder="@username，可选" /><FieldDescription>至少填写 Telegram ID 或用户名之一，worker 才能用 Bot 登录。</FieldDescription></Field>
            </FieldGroup>
            <Button type="submit" disabled={loading}><UserPlusIcon data-icon="inline-start" />创建账号</Button>
          </form>
        </SheetContent>
      </Sheet>

      <Tabs
        value={activeSection}
        onValueChange={(value) => setActiveSection(value as WorkerAdminSection)}
        className="gap-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList className="flex w-full flex-wrap justify-start rounded-2xl p-1 sm:w-auto">
            <TabsTrigger value="workers" className="min-w-32">
              接单账号 {workerPagination?.total ?? workers.length}
            </TabsTrigger>
            <TabsTrigger value="withdrawals" className="min-w-32">
              提现申请 {withdrawalPagination?.total ?? withdrawals.length}
            </TabsTrigger>
          </TabsList>
          <Button variant="outline" size="sm" onClick={() => refresh()} disabled={loading}>
            <RefreshCwIcon data-icon="inline-start" />
            刷新
          </Button>
        </div>

        <TabsContent value="workers">
        <Card className="rounded-3xl bg-background shadow-sm">
          <CardHeader><CardTitle>接单账号列表</CardTitle><CardDescription>查看单价、在线状态、完成金额，并对未结完成单执行结单。</CardDescription></CardHeader>
          <CardContent>
            <div className="mb-3 flex items-center gap-2">
              <SearchIcon className="size-4 text-muted-foreground" />
              <Input value={workerSearch} onChange={(event) => { setWorkerSearch(event.target.value); setWorkerPage(1); }} placeholder="搜索账号 / Telegram / Binance UID" />
            </div>
            <div className="overflow-hidden rounded-3xl border border-border">
              <Table><TableHeader><TableRow><TableHead>账号</TableHead><TableHead>Telegram</TableHead><TableHead>单价</TableHead><TableHead>模式</TableHead><TableHead>钱包</TableHead><TableHead>状态</TableHead><TableHead>自动接单</TableHead><TableHead>完成/记录</TableHead><TableHead>未结记录</TableHead><TableHead>已结</TableHead><TableHead>最后在线</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
                <TableBody>
                  {workers.map((worker) => (
                    <TableRow key={worker.id}>
                      <TableCell>
                        <div className="font-semibold">{worker.displayName}</div>
                        <div className="text-xs text-muted-foreground">@{worker.username}</div>
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">{worker.telegramUserId || "-"}</div>
                        <div className="text-xs text-muted-foreground">{worker.telegramUsername ? "@" + worker.telegramUsername : "未绑定"}</div>
                      </TableCell>
                      <TableCell>
                        <div className="flex min-w-32 items-center gap-2">
                          <Input
                            className="h-8 w-24"
                            inputMode="decimal"
                            value={workerPriceDrafts[worker.id] ?? Number(worker.unitPrice ?? 0).toFixed(2)}
                            onChange={(event) => setWorkerPriceDrafts((current) => ({ ...current, [worker.id]: event.target.value }))}
                          />
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => updateWorkerUnitPrice(worker)}
                            disabled={loading || (workerPriceDrafts[worker.id] ?? Number(worker.unitPrice ?? 0).toFixed(2)) === Number(worker.unitPrice ?? 0).toFixed(2)}
                          >
                            保存
                          </Button>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <Badge variant={worker.payoutMode === "PREPAID" ? "secondary" : "outline"}>{worker.payoutMode === "PREPAID" ? "预付费" : "后付费"}</Badge>
                          <button className="text-left text-xs text-muted-foreground underline" onClick={() => setWorkerPayoutMode(worker, worker.payoutMode === "PREPAID" ? "POSTPAID" : "PREPAID")} disabled={loading}>
                            切换
                          </button>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="font-semibold">{formatBalance(worker.wallet?.balance)}</div>
                        <div className="text-xs text-muted-foreground">可提 {formatBalance(worker.wallet?.availableBalance)}</div>
                        <div className="text-xs text-muted-foreground">Binance: {worker.binanceUserId || "未绑定"}</div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col items-start gap-1">
                          <WorkerStatusBadge status={worker.status} />
                          {worker.isDisabled && <Badge variant="destructive">已停用</Badge>}
                        </div>
                        {worker.activeOrder && <div className="mt-1 text-xs text-muted-foreground">进行中：{worker.activeOrder.orderNo}</div>}
                      </TableCell>
                      <TableCell>{worker.autoAcceptEnabled ? "开启" : "关闭"}</TableCell>
                      <TableCell>{worker.completedCount ?? 0} / {worker._count?.records ?? 0}</TableCell>
                      <TableCell><div className="font-semibold">{formatMoney(worker.unsettledAmount)}</div><div className="text-xs text-muted-foreground">{worker.unsettledCompleted ?? 0} 单</div></TableCell>
                      <TableCell><div>{formatMoney(worker.settledAmount)}</div><div className="text-xs text-muted-foreground">{worker.settledCompleted ?? 0} 单</div></TableCell>
                      <TableCell>{formatDateTime(worker.lastSeenAt)}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex flex-wrap justify-end gap-2">
                          <Button variant="outline" size="sm" onClick={() => disableWorkerAutoAccept(worker)} disabled={loading || !worker.autoAcceptEnabled}>关闭自动</Button>
                          <Button variant="outline" size="sm" onClick={() => offlineWorker(worker)} disabled={loading || worker.status !== "ONLINE" || Boolean(worker.activeOrder)} title={worker.activeOrder ? "有进行中订单，暂不能下线" : undefined}>下线</Button>
                          <Button
                            variant={worker.isDisabled ? "outline" : "destructive"}
                            size="sm"
                            onClick={() => setWorkerDisabled(worker, !worker.isDisabled)}
                            disabled={loading || Boolean(worker.activeOrder)}
                            title={worker.activeOrder ? "有进行中订单，暂不能停用" : undefined}
                          >
                            {worker.isDisabled ? "启用" : "停用"}
                          </Button>
                          <Button variant="outline" size="sm" onClick={() => advanceWorker(worker)} disabled={loading}>预支</Button>
                          <Button variant="outline" size="sm" onClick={() => settleWorker(worker)} disabled={loading || worker.payoutMode === "PREPAID" || (worker.unsettledCompleted ?? 0) <= 0} title={worker.payoutMode === "PREPAID" ? "预付费模式通过钱包负余额自动抵扣，不使用旧结单" : undefined}>结单</Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {workers.length === 0 && <TableRow><TableCell colSpan={12} className="h-28 text-center text-muted-foreground">暂无接单账号</TableCell></TableRow>}
                </TableBody>
              </Table>
            </div>
            <AdminListPagination pagination={workerPagination} loading={loading} onPageChange={setWorkerPage} className="mt-4" />
          </CardContent>
        </Card>
        </TabsContent>

        <TabsContent value="withdrawals">
      <Card className="rounded-3xl bg-background shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><WalletIcon className="size-5 text-muted-foreground" />提现申请</CardTitle>
          <CardDescription>
            当前页待处理 {pendingWithdrawals.length} 笔 / {formatBalance(pendingWithdrawalAmount)}。标记已付款后会写入钱包流水并扣减余额；拒绝不会扣款。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-3 flex items-center gap-2">
            <SearchIcon className="size-4 text-muted-foreground" />
            <Input value={withdrawalSearch} onChange={(event) => { setWithdrawalSearch(event.target.value); setWithdrawalPage(1); }} placeholder="搜索接单方 / Binance UID / 备注" />
          </div>
          <div className="overflow-hidden rounded-3xl border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>接单方</TableHead>
                  <TableHead>金额</TableHead>
                  <TableHead>Binance UID</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>申请时间</TableHead>
                  <TableHead>处理时间</TableHead>
                  <TableHead>备注</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {withdrawals.map((request) => (
                  <TableRow key={request.id}>
                    <TableCell>
                      <div className="font-semibold">{request.worker?.displayName || request.workerId}</div>
                      <div className="text-xs text-muted-foreground">@{request.worker?.username || "-"}</div>
                    </TableCell>
                    <TableCell className="font-semibold">{formatBalance(request.amount)}</TableCell>
                    <TableCell>
                      <div className="font-mono text-xs">{request.binanceUserIdSnapshot}</div>
                      {request.worker?.binanceUserId && request.worker.binanceUserId !== request.binanceUserIdSnapshot ? (
                        <div className="mt-1 text-xs text-warning">当前 UID：{request.worker.binanceUserId}</div>
                      ) : null}
                    </TableCell>
                    <TableCell><Badge variant={withdrawalStatusBadgeVariant(request.status)}>{withdrawalStatusText(request.status)}</Badge></TableCell>
                    <TableCell>{formatDateTime(request.requestedAt)}</TableCell>
                    <TableCell>{formatDateTime(request.processedAt)}</TableCell>
                    <TableCell className="max-w-[280px]">
                      <div className="truncate text-sm">{request.note || "-"}</div>
                      {request.adminNote ? <div className="mt-1 truncate text-xs text-muted-foreground">管理员：{request.adminNote}</div> : null}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button variant="outline" size="sm" onClick={() => markWithdrawalPaid(request)} disabled={loading || request.status !== "PENDING"}>已付款</Button>
                        <Button variant="outline" size="sm" onClick={() => rejectWithdrawal(request)} disabled={loading || request.status !== "PENDING"}>拒绝</Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {withdrawals.length === 0 && <TableRow><TableCell colSpan={8} className="h-28 text-center text-muted-foreground">暂无提现申请</TableCell></TableRow>}
              </TableBody>
            </Table>
          </div>
          <AdminListPagination pagination={withdrawalPagination} loading={loading} onPageChange={setWithdrawalPage} className="mt-4" />
        </CardContent>
      </Card>
        </TabsContent>
      </Tabs>
    </AppFrame>
  );
}


export function AdminProxiesClient() {
  const [proxyPool, setProxyPool] = useState<"public" | "premium">("public");
  const [proxies, setProxies] = useState<PublicUpstreamProxy[]>([]);
  const [proxyListText, setProxyListText] = useState("");
  const [newProxyUrl, setNewProxyUrl] = useState("");
  const [expectedCountry, setExpectedCountry] = useState("JP");
  const [selection, setSelection] = useState<PublicProxySelection | null>(null);
  const [proxySearch, setProxySearch] = useState("");
  const deferredProxySearch = useDeferredValue(proxySearch);
  const [proxyPage, setProxyPage] = useState(1);
  const [proxyPagination, setProxyPagination] = useState<AdminPaginationMeta | null>(null);
  const [checkResult, setCheckResult] = useState<PublicProxyCheckSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkingProxyId, setCheckingProxyId] = useState<string | null>(null);

  const refresh = useCallback(async (silent = false) => {
    try {
      setLoading(true);
      const data = await apiFetch<{ pool: "public" | "premium"; proxies: PublicUpstreamProxy[]; editableProxyList: string[]; total: number; expectedCountry: string; hasList: boolean; selection: PublicProxySelection; pagination?: AdminPaginationMeta }>(pagedAdminUrl("/api/admin/proxies", {
        page: proxyPage,
        search: deferredProxySearch,
        pageSize: 20,
        extra: { pool: proxyPool },
      }));
      setProxies(data.proxies);
      setProxyPagination(data.pagination || null);
      setProxyListText((data.editableProxyList || []).join("\n"));
      setExpectedCountry(data.expectedCountry || "JP");
      setSelection(data.selection);
      if (!silent) toast.success("代理列表已刷新");
    } catch (error) {
      if (!silent) toast.error(error instanceof Error ? error.message : "刷新代理列表失败");
    } finally {
      setLoading(false);
    }
  }, [deferredProxySearch, proxyPage, proxyPool]);

  function mergeProxyCheckSummary(current: PublicProxyCheckSummary | null, next: PublicProxyCheckSummary): PublicProxyCheckSummary {
    if (!current) return next;
    const merged = new Map(current.results.map((result) => [result.index, result]));
    for (const result of next.results) merged.set(result.index, result);
    const results = Array.from(merged.values()).sort((left, right) => left.index - right.index);
    const ok = results.filter((result) => result.ok).length;
    return {
      checkedAt: next.checkedAt,
      total: results.length,
      ok,
      failed: results.length - ok,
      expectedCountry: next.expectedCountry || current.expectedCountry,
      results,
    };
  }

  async function checkProxies() {
    try {
      setChecking(true);
      const result = await apiFetch<PublicProxyCheckSummary>("/api/admin/proxies/check", {
        method: "POST",
        body: JSON.stringify({ pool: proxyPool }),
      });
      setCheckResult(result);
      if (result.failed > 0) toast.warning(`代理检测完成：${result.ok}/${result.total} 可用`);
      else toast.success(`代理检测完成：${result.ok}/${result.total} 可用`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "代理检测失败");
    } finally {
      setChecking(false);
    }
  }

  async function checkProxy(proxy: PublicUpstreamProxy) {
    try {
      setCheckingProxyId(proxy.id);
      const result = await apiFetch<PublicProxyCheckSummary>("/api/admin/proxies/check", {
        method: "POST",
        body: JSON.stringify({ pool: proxyPool, proxyId: proxy.id }),
      });
      setCheckResult((current) => mergeProxyCheckSummary(current, result));
      const first = result.results[0];
      if (first?.ok) toast.success(`代理 #${proxy.index + 1} 检测可用`);
      else toast.warning(`代理 #${proxy.index + 1} 检测异常`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "代理检测失败");
    } finally {
      setCheckingProxyId(null);
    }
  }

  async function saveProxySelection(selectedProxyId: string) {
    try {
      setLoading(true);
      const data = await apiFetch<{ pool: "public" | "premium"; proxies: PublicUpstreamProxy[]; editableProxyList: string[]; total: number; expectedCountry: string; hasList: boolean; selection: PublicProxySelection }>("/api/admin/proxies", {
        method: "POST",
        body: JSON.stringify({ selectedProxyId, pool: proxyPool }),
      });
      setProxies(data.proxies);
      setProxyListText((data.editableProxyList || []).join("\n"));
      setExpectedCountry(data.expectedCountry || "JP");
      setSelection(data.selection);
      toast.success(data.selection.mode === "AUTO" ? "已切换为自动轮询代理" : "已切换当前代理");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存代理选择失败");
    } finally {
      setLoading(false);
    }
  }

  async function mutateProxyPool(action: "add" | "delete" | "replace", payload: Record<string, unknown>, successMessage: string) {
    try {
      setLoading(true);
      const data = await apiFetch<{ pool: "public" | "premium"; proxies: PublicUpstreamProxy[]; editableProxyList: string[]; total: number; expectedCountry: string; hasList: boolean; selection: PublicProxySelection }>("/api/admin/proxies", {
        method: "POST",
        body: JSON.stringify({ action, pool: proxyPool, ...payload }),
      });
      setProxies(data.proxies);
      setProxyListText((data.editableProxyList || []).join("\n"));
      setExpectedCountry(data.expectedCountry || "JP");
      setSelection(data.selection);
      setCheckResult(null);
      if (action === "add") setNewProxyUrl("");
      toast.success(successMessage);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存代理池失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(true), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  const selectProxyPool = useCallback((pool: "public" | "premium") => {
    setProxyPool(pool);
    setProxyPage(1);
    setCheckResult(null);
  }, []);

  const resultsByIndex = useMemo(() => new Map(checkResult?.results.map((result) => [result.index, result]) || []), [checkResult]);
  const okCount = checkResult?.ok ?? 0;
  const failedCount = checkResult?.failed ?? 0;
  const selectedProxy = selection?.selectedProxyId ? proxies.find((proxy) => proxy.id === selection.selectedProxyId) : null;
  const selectionLabel = selection?.mode === "MANUAL" && selectedProxy ? `#${selectedProxy.index + 1}` : "自动轮询";

  return (
    <AppFrame audience="admin" title="代理列表" subtitle="公共提取和 Premium 提取使用独立代理池，可分别检测和选择当前代理。" onRefresh={() => refresh()}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => refresh()} disabled={loading}><RefreshCwIcon data-icon="inline-start" />刷新列表</Button>
          <Button variant={selection?.mode === "AUTO" ? "default" : "outline"} onClick={() => saveProxySelection("AUTO")} disabled={loading}>自动轮询</Button>
          <Button onClick={checkProxies} disabled={checking || proxies.length === 0}><ActivityIcon data-icon="inline-start" />{checking ? "检测中..." : "检测代理"}</Button>
        </div>
      </div>

      <Card className="mb-4 rounded-3xl bg-background shadow-sm">
        <CardContent className="pt-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="font-semibold">代理池</div>
              <p className="mt-1 text-sm text-muted-foreground">
                当前查看：{proxyPool === "premium" ? "Premium 提取代理池" : "公共提取代理池"}。两个池子的当前代理选择互不影响。
              </p>
            </div>
            <div className="flex rounded-full border border-border bg-muted/50 p-1 text-sm">
              <button
                type="button"
                onClick={() => selectProxyPool("public")}
                className={cn("rounded-full px-4 py-1.5 font-medium transition", proxyPool === "public" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
              >
                公共代理池
              </button>
              <button
                type="button"
                onClick={() => selectProxyPool("premium")}
                className={cn("rounded-full px-4 py-1.5 font-medium transition", proxyPool === "premium" ? "bg-brand text-white shadow-sm" : "text-muted-foreground hover:text-foreground")}
              >
                Premium 代理池
              </button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="mb-4 rounded-3xl bg-background shadow-sm">
        <CardHeader>
          <CardTitle>编辑代理池</CardTitle>
          <CardDescription>
            保存后会写入数据库配置并立即生效，不需要改 .env；添加/删除/批量保存后当前代理会自动切回自动轮询，避免索引错位。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.8fr)]">
          <div className="rounded-3xl border border-border p-4">
            <div className="font-semibold">添加单个代理</div>
            <p className="mt-1 text-sm text-muted-foreground">支持 socks5://、http://、https://；不写协议会按 socks5:// 处理。</p>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <Input
                value={newProxyUrl}
                onChange={(event) => setNewProxyUrl(event.target.value)}
                placeholder="socks5://user:password@127.0.0.1:24015"
                className="font-mono text-xs"
                disabled={loading}
              />
              <Button
                type="button"
                onClick={() => mutateProxyPool("add", { proxyUrl: newProxyUrl }, "代理已添加")}
                disabled={loading || !newProxyUrl.trim()}
              >
                <PlusIcon data-icon="inline-start" />添加
              </Button>
            </div>
          </div>

          <div className="rounded-3xl border border-border p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="font-semibold">批量编辑</div>
                <p className="mt-1 text-sm text-muted-foreground">一行一个代理；保存会替换当前代理池。</p>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => mutateProxyPool("replace", { proxyList: proxyListText }, "代理池已保存")}
                disabled={loading}
              >
                <SaveIcon data-icon="inline-start" />保存
              </Button>
            </div>
            <Textarea
              value={proxyListText}
              onChange={(event) => setProxyListText(event.target.value)}
              className="mt-3 h-40 min-h-40 resize-y font-mono text-xs"
              placeholder="socks5://user:password@127.0.0.1:24015"
              disabled={loading}
            />
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-4">
        <MetricCard title="代理数量" value={proxyPagination?.total ?? proxies.length} description={proxyPool === "premium" ? "来自 PREMIUM_UPSTREAM_PROXY_LIST / PREMIUM_UPI_PROXY_LIST / PREMIUM_UPSTREAM_PROXY" : "来自 UPSTREAM_PROXY_LIST / UPI_PROXY_LIST / UPSTREAM_PROXY"} icon={Globe2Icon} tone="brand" />
        <MetricCard title="当前策略" value={selectionLabel} description={selection?.mode === "MANUAL" && selectedProxy ? selectedProxy.redactedUrl : "每次生成按列表轮询；失败会自动尝试其它代理"} icon={ShieldCheckIcon} tone="info" />
        <MetricCard title="检测可用" value={checkResult ? okCount : "-"} description={`预期出口国家：${expectedCountry}`} icon={CheckCircle2Icon} tone="success" />
        <MetricCard title="检测失败" value={checkResult ? failedCount : "-"} description={checkResult ? `检测时间：${formatDateTime(checkResult.checkedAt)}` : "点击检测代理后显示"} icon={XCircleIcon} tone="warning" />
      </div>

      <Card className="mt-4 rounded-3xl bg-background shadow-sm">
        <CardHeader>
          <CardTitle>{proxyPool === "premium" ? "Premium 提取代理" : "公共提取代理"}</CardTitle>
          <CardDescription>检测会验证出口 IP、国家，以及 ChatGPT / Stripe / Telegram 基础连通性；代理密码不会展示。</CardDescription>
          <CardAction>{checkResult ? `${okCount} / ${checkResult.total}` : `${proxies.length} 个`}</CardAction>
        </CardHeader>
        <CardContent>
          <div className="mb-3 flex items-center gap-2">
            <SearchIcon className="size-4 text-muted-foreground" />
            <Input value={proxySearch} onChange={(event) => { setProxySearch(event.target.value); setProxyPage(1); }} placeholder="搜索代理地址 / 来源 / 标签" />
          </div>
          <div className="overflow-hidden rounded-3xl border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>代理</TableHead>
                  <TableHead>来源</TableHead>
                  <TableHead>检测</TableHead>
                   <TableHead>操作</TableHead>
                  <TableHead>出口</TableHead>
                  <TableHead>连通性</TableHead>
                  <TableHead>耗时</TableHead>
                  <TableHead>备注</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {proxies.map((proxy) => {
                  const result = resultsByIndex.get(proxy.index);
                  return (
                    <TableRow key={proxy.id}>
                      <TableCell>{proxy.index + 1}</TableCell>
                      <TableCell>
                        <div className="max-w-[360px] truncate font-mono text-xs">{proxy.redactedUrl}</div>
                        <div className="text-xs text-muted-foreground">{proxy.scheme} / {proxy.host}:{proxy.port || "-"}</div>
                      </TableCell>
                      <TableCell><Badge variant="secondary">{proxy.source}</Badge></TableCell>
                      <TableCell>
                        {result ? (
                          <Badge variant={result.ok ? "default" : "destructive"}>
                            {result.ok ? <CheckCircle2Icon data-icon="inline-start" /> : <XCircleIcon data-icon="inline-start" />}
                            {result.ok ? "可用" : "异常"}
                          </Badge>
                        ) : <span className="text-muted-foreground">未检测</span>}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant={selection?.selectedProxyId === proxy.id ? "default" : "outline"}
                            size="sm"
                            onClick={() => saveProxySelection(proxy.id)}
                            disabled={loading}
                          >
                            {selection?.selectedProxyId === proxy.id ? "当前" : "设为当前"}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => checkProxy(proxy)}
                            disabled={loading || checking || checkingProxyId === proxy.id}
                          >
                            {checkingProxyId === proxy.id ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <SearchIcon data-icon="inline-start" />}
                            {checkingProxyId === proxy.id ? "检测中..." : "单独检测"}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => mutateProxyPool("delete", { proxyId: proxy.id }, "代理已删除")}
                            disabled={loading}
                            className="text-destructive hover:text-destructive"
                          >
                            <Trash2Icon data-icon="inline-start" />删除
                          </Button>
                        </div>
                      </TableCell>
                      <TableCell>
                        {result ? (
                          <div>
                            <div className="font-mono text-xs">{result.ip || "-"}</div>
                            <div className="text-xs text-muted-foreground">{result.country || result.countryCode || "-"}{result.city ? ` / ${result.city}` : ""}</div>
                          </div>
                        ) : <span className="text-muted-foreground">-</span>}
                      </TableCell>
                      <TableCell>
                        {result ? (
                          <div className="text-xs">
                            <div>ChatGPT: {result.chatgptStatus ?? "-"}</div>
                            <div>Stripe: {result.stripeStatus ?? "-"}</div>
                            <div>TG: {result.telegramStatus ?? "-"}</div>
                          </div>
                        ) : <span className="text-muted-foreground">-</span>}
                      </TableCell>
                      <TableCell>{result ? `${result.latencyMs}ms` : "-"}</TableCell>
                      <TableCell className="max-w-[280px]">
                        {result?.error ? <div className="truncate text-sm text-destructive">{result.error}</div> : null}
                        {result?.warnings?.length ? <div className="truncate text-xs text-muted-foreground">{result.warnings.join("；")}</div> : null}
                        {!result?.error && !result?.warnings?.length ? <span className="text-muted-foreground">-</span> : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {proxies.length === 0 && <TableRow><TableCell colSpan={9} className="h-32 text-center text-muted-foreground">暂无代理配置，请在服务端环境变量中配置 {proxyPool === "premium" ? "PREMIUM_UPSTREAM_PROXY_LIST" : "UPSTREAM_PROXY_LIST"}。</TableCell></TableRow>}
              </TableBody>
            </Table>
          </div>
          <AdminListPagination pagination={proxyPagination} loading={loading} onPageChange={setProxyPage} className="mt-4" />
        </CardContent>
      </Card>
    </AppFrame>
  );
}

function withdrawalStatusText(status: PublicWorkerWithdrawalRequest["status"]) {
  if (status === "PENDING") return "待处理";
  if (status === "PAID") return "已付款";
  if (status === "REJECTED") return "已拒绝";
  return "已取消";
}

function withdrawalStatusBadgeVariant(status: PublicWorkerWithdrawalRequest["status"]): "default" | "secondary" | "destructive" | "outline" {
  if (status === "PENDING") return "secondary";
  if (status === "PAID") return "default";
  if (status === "REJECTED") return "destructive";
  return "outline";
}

function formatOrderQrRemaining(expiresAt: string | null | undefined, now: number) {
  if (!expiresAt) return "";
  const expiresAtMs = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiresAtMs)) return "";
  const remainingMs = expiresAtMs - now;
  if (remainingMs <= 0) return "已过期";
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatBalance(value?: number | null) {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount)) return "$0.00";
  const prefix = amount < 0 ? "-" : "";
  return `${prefix}$${Math.abs(amount).toFixed(2)}`;
}

function AdminNavCard({ title, description, href, icon: Icon }: { title: string; description: string; href: string; icon: NavIcon }) {
  return <Link href={href} className="rounded-3xl border border-border bg-muted/30 p-5 transition hover:bg-muted/60"><div className="flex items-center gap-3"><div className="grid size-11 place-items-center rounded-2xl bg-background text-muted-foreground shadow-sm"><Icon className="size-5" /></div><div><div className="font-semibold">{title}</div><p className="mt-1 text-sm text-muted-foreground">{description}</p></div></div></Link>;
}

export const AdminClient = AdminDashboardClient;

