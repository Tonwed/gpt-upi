"use client";

import Link from "next/link";
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { ActivityIcon, ArrowLeftIcon, CheckCircle2Icon, PauseCircleIcon, PlayCircleIcon, RefreshCwIcon, RotateCcwIcon, SearchIcon, ShieldAlertIcon, TimerIcon } from "lucide-react";
import { toast } from "sonner";
import { AppFrame } from "@/components/app/app-frame";
import { AdminListPagination } from "@/components/app/admin-list-pagination";
import { MetricCard } from "@/components/app/metric-card";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiFetch, formatDateTime } from "@/lib/api-client";
import type { AdminPaginationMeta } from "@/lib/types/app";

type ExtractStatus = "queued" | "running" | "completed" | "failed";
type ExtractSource = "direct" | "storage";
type ExtractChannel = "public" | "premium";

type ExtractProgress = {
  stage: string;
  percent: number;
  proxy?: string;
  updatedAt?: string;
};

type AdminExtractJob = {
  jobId: string;
  status: ExtractStatus;
  source: ExtractSource;
  channel: ExtractChannel;
  createdAt: string;
  updatedAt: string;
  progress?: ExtractProgress;
  error?: string;
  hasPayload: boolean;
  hasResult: boolean;
  canStart: boolean;
  canStop: boolean;
};

type ExtractActivity = {
  jobId: string;
  seq: number;
  status: ExtractStatus;
  source: ExtractSource;
  channel: ExtractChannel;
  createdAt: string;
  updatedAt: string;
};

type ExtractCounts = Record<ExtractStatus, number>;

type AdminExtractState = {
  paused: boolean;
  pausedByChannel?: Record<ExtractChannel, boolean>;
  maxConcurrent: number;
  maxConcurrentByChannel?: Record<ExtractChannel, number>;
  activeExtractionCount: number;
  activeExtractionCountByChannel?: Record<ExtractChannel, number>;
  queuedCount: number;
  queuedCountByChannel?: Record<ExtractChannel, number>;
  liveJobCount: number;
  jobs: AdminExtractJob[];
  items: ExtractActivity[];
  jobsPagination?: AdminPaginationMeta;
  itemsPagination?: AdminPaginationMeta;
  counts: ExtractCounts;
  storageActiveCount: number;
  changed?: number;
};

const emptyCounts: ExtractCounts = { completed: 0, queued: 0, running: 0, failed: 0 };
const ADMIN_PAGE_SIZE = 20;

function adminExtractUrl(input: { page: number; search?: string }) {
  const params = new URLSearchParams();
  params.set("paged", "1");
  params.set("page", String(input.page));
  params.set("pageSize", String(ADMIN_PAGE_SIZE));
  if (input.search?.trim()) params.set("search", input.search.trim());
  return `/api/admin/upi-extract?${params.toString()}`;
}

export function AdminUpiExtractClient() {
  const [state, setState] = useState<AdminExtractState | null>(null);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [concurrencyDraft, setConcurrencyDraft] = useState<Record<ExtractChannel, string>>({ public: "10", premium: "5" });
  const [concurrencyDirty, setConcurrencyDirty] = useState<Record<ExtractChannel, boolean>>({ public: false, premium: false });

  const refresh = useCallback(async (silent = false) => {
    try {
      setLoading(true);
      const next = await apiFetch<AdminExtractState>(adminExtractUrl({ page, search: deferredSearch }));
      setState(next);
      setConcurrencyDraft((current) => ({
        public: concurrencyDirty.public ? current.public : String(channelMaxConcurrent(next, "public")),
        premium: concurrencyDirty.premium ? current.premium : String(channelMaxConcurrent(next, "premium")),
      }));
      if (!silent) toast.success("提取任务列表已刷新");
    } catch (error) {
      if (!silent) toast.error(error instanceof Error ? error.message : "刷新提取任务失败");
    } finally {
      setLoading(false);
    }
  }, [concurrencyDirty.premium, concurrencyDirty.public, deferredSearch, page]);

  const control = useCallback(async (action: "pause" | "resume" | "start" | "stop" | "stopAll", jobId?: string, channel?: ExtractChannel) => {
    try {
      setActing(jobId ? `${action}:${jobId}` : channel ? `${action}:${channel}` : action);
      const next = await apiFetch<AdminExtractState>("/api/admin/upi-extract", {
        method: "POST",
        body: JSON.stringify({ action, jobId, channel }),
      });
      setState(next);
      if (action === "pause") toast.success(`${channelLabel(channel)}提取入口已暂停`);
      else if (action === "resume") toast.success(`${channelLabel(channel)}提取入口已恢复`);
      else if (action === "stopAll") toast.success(`已将 ${next.changed ?? 0} 个任务转为等待中`);
      else if (action === "stop") toast.success("任务已转为等待中");
      else toast.success("任务已启动");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作失败");
    } finally {
      setActing(null);
    }
  }, []);

  const saveConcurrency = useCallback(async (channel: ExtractChannel) => {
    try {
      setActing(`setConcurrency:${channel}`);
      const next = await apiFetch<AdminExtractState>("/api/admin/upi-extract", {
        method: "POST",
        body: JSON.stringify({ action: "setConcurrency", channel, concurrency: Number(concurrencyDraft[channel]) }),
      });
      setState(next);
      setConcurrencyDirty((current) => ({ ...current, [channel]: false }));
      toast.success(`${channelLabel(channel)}并发上限已保存`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存并发上限失败");
    } finally {
      setActing(null);
    }
  }, [concurrencyDraft]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(true), 0);
    const interval = window.setInterval(() => void refresh(true), 5000);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(interval);
    };
  }, [refresh]);

  const counts = state?.counts || emptyCounts;
  const jobsById = useMemo(() => new Map((state?.jobs || []).map((job) => [job.jobId, job])), [state?.jobs]);
  const recentItems = state?.items || [];
  const isBusy = loading || Boolean(acting);

  return (
    <AppFrame audience="admin" title="UPI 提取管理" subtitle="查看公益提取任务，暂停入口，或把正在处理的任务转回等待中。" onRefresh={() => refresh()}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Link href="/admin" className={buttonVariants({ variant: "outline" })}>
          <ArrowLeftIcon data-icon="inline-start" />返回管理首页
        </Link>
        <div className="flex flex-wrap gap-2">
          <div className="relative w-full sm:w-72">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="搜索任务 ID / 状态 / 错误" className="pl-9" />
          </div>
          <Button variant="outline" onClick={() => refresh()} disabled={isBusy}>
            <RefreshCwIcon data-icon="inline-start" />刷新
          </Button>
          <ChannelPauseButton
            channel="public"
            paused={Boolean(state?.pausedByChannel?.public ?? state?.paused)}
            disabled={isBusy}
            acting={acting}
            onControl={control}
          />
          <ChannelPauseButton
            channel="premium"
            paused={Boolean(state?.pausedByChannel?.premium)}
            disabled={isBusy}
            acting={acting}
            onControl={control}
          />
          <Button variant="outline" onClick={() => control("stopAll")} disabled={isBusy}>
            <RotateCcwIcon data-icon="inline-start" />一键停止并转等待
          </Button>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-5">
        <MetricCard title="入口状态" value={pauseSummary(state)} description="公共和 Premium 可单独暂停；已转等待的任务可手动启动。" icon={isAnyChannelPaused(state) ? ShieldAlertIcon : CheckCircle2Icon} tone={isAnyChannelPaused(state) ? "warning" : "success"} />
        <MetricCard title="正在提取" value={state?.activeExtractionCount ?? 0} description={`公共 ${state?.activeExtractionCountByChannel?.public ?? 0}/${channelMaxConcurrent(state, "public")} / Premium ${state?.activeExtractionCountByChannel?.premium ?? 0}/${channelMaxConcurrent(state, "premium")}`} icon={ActivityIcon} tone="info" />
        <MetricCard title="等待中" value={state?.queuedCount ?? counts.queued} description={`公共 ${state?.queuedCountByChannel?.public ?? 0} / Premium ${state?.queuedCountByChannel?.premium ?? 0}`} icon={TimerIcon} tone="warning" />
        <MetricCard title="成功 / 失败" value={`${counts.completed} / ${counts.failed}`} description="按全部历史活动统计" icon={CheckCircle2Icon} tone="brand" />
        <MetricCard title="暂存中" value={state?.storageActiveCount ?? 0} description="当前仍有效的暂存 ID 数量" icon={RotateCcwIcon} tone="brand" />
      </div>

      <Card className="mt-4 rounded-3xl bg-background shadow-sm">
        <CardHeader>
          <CardTitle>通道并发设置</CardTitle>
          <CardDescription>分别设置公共通道和 Premium 通道同时提取的任务数量；保存后立即生效，已在运行的任务不会被中断。</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 md:grid-cols-2">
            {(["public", "premium"] as const).map((channel) => {
              const active = state?.activeExtractionCountByChannel?.[channel] ?? 0;
              const queued = state?.queuedCountByChannel?.[channel] ?? 0;
              const isSaving = acting === `setConcurrency:${channel}`;
              return (
                <div key={channel} className="rounded-3xl border border-border p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="font-semibold">{channelLabel(channel)}通道</div>
                      <div className="mt-1 text-xs text-muted-foreground">当前运行 {active}，等待 {queued}</div>
                    </div>
                    <Badge variant={channel === "premium" ? "default" : "outline"}>当前上限 {channelMaxConcurrent(state, channel)}</Badge>
                  </div>
                  <div className="mt-4 flex gap-2">
                    <Input
                      type="number"
                      min={1}
                      value={concurrencyDraft[channel]}
                      onChange={(event) => {
                        setConcurrencyDraft((current) => ({ ...current, [channel]: event.target.value }));
                        setConcurrencyDirty((current) => ({ ...current, [channel]: true }));
                      }}
                      className="h-10 rounded-xl"
                    />
                    <Button
                      type="button"
                      onClick={() => void saveConcurrency(channel)}
                      disabled={isBusy || isSaving || !concurrencyDirty[channel]}
                      className="rounded-xl"
                    >
                      {isSaving ? "保存中" : "保存"}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card className="mt-4 rounded-3xl bg-background shadow-sm">
        <CardHeader>
          <CardTitle>实时提取任务</CardTitle>
          <CardDescription>
            这里只显示当前进程内仍可控制的任务；停止不会把任务记为失败，而是转回等待中。重启服务后，历史记录仍可查看，但临时数据不会恢复。
          </CardDescription>
          <CardAction>
            <div className="flex flex-wrap gap-2">
              <Badge variant={state?.pausedByChannel?.public ? "secondary" : "default"}>公共{state?.pausedByChannel?.public ? "暂停" : "运行"}</Badge>
              <Badge variant={state?.pausedByChannel?.premium ? "secondary" : "default"}>Premium{state?.pausedByChannel?.premium ? "暂停" : "运行"}</Badge>
            </div>
          </CardAction>
        </CardHeader>
        <CardContent>
          <div className="overflow-hidden rounded-3xl border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>任务</TableHead>
                  <TableHead>通道</TableHead>
                  <TableHead>来源</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>进度</TableHead>
                  <TableHead>创建</TableHead>
                  <TableHead>更新</TableHead>
                  <TableHead>错误</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(state?.jobs || []).map((job) => (
                  <TableRow key={job.jobId}>
                    <TableCell>
                      <div className="font-mono text-xs">{shortJobId(job.jobId)}</div>
                      <div className="mt-1 text-xs text-muted-foreground">{job.hasPayload ? "可恢复" : "无临时数据"}{job.hasResult ? " / 已有结果" : ""}</div>
                    </TableCell>
                    <TableCell><ChannelBadge channel={job.channel} /></TableCell>
                    <TableCell><SourceBadge source={job.source} /></TableCell>
                    <TableCell><StatusBadge status={job.status} /></TableCell>
                    <TableCell>
                      <div className="min-w-[140px]">
                        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                          <span>{stageText(job.progress?.stage)}</span>
                          <span>{Math.round(Number(job.progress?.percent || 0))}%</span>
                        </div>
                        <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
                          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.max(0, Math.min(100, Number(job.progress?.percent || 0)))}%` }} />
                        </div>
                        {job.progress?.proxy ? <div className="mt-1 max-w-[220px] truncate text-xs text-muted-foreground">{job.progress.proxy}</div> : null}
                      </div>
                    </TableCell>
                    <TableCell>{formatDateTime(job.createdAt)}</TableCell>
                    <TableCell>{formatDateTime(job.updatedAt)}</TableCell>
                    <TableCell className="max-w-[280px]">
                      {job.error ? <div className="truncate text-sm text-destructive" title={job.error}>{job.error}</div> : <span className="text-muted-foreground">-</span>}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button variant="outline" size="sm" onClick={() => control("start", job.jobId)} disabled={isBusy || !job.canStart}>
                          <PlayCircleIcon data-icon="inline-start" />启动
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => control("stop", job.jobId)} disabled={isBusy || !job.canStop}>
                          <PauseCircleIcon data-icon="inline-start" />停止
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {(!state?.jobs || state.jobs.length === 0) && (
                  <TableRow><TableCell colSpan={9} className="h-28 text-center text-muted-foreground">当前没有可控制的实时任务</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <AdminListPagination pagination={state?.jobsPagination} loading={loading} onPageChange={setPage} className="mt-4" />
        </CardContent>
      </Card>

      <Card className="mt-4 rounded-3xl bg-background shadow-sm">
        <CardHeader>
          <CardTitle>最近提取记录</CardTitle>
          <CardDescription>用于核对热力图状态，列表不包含用户凭证和二维码内容。</CardDescription>
          <CardAction>{recentItems.length} 条</CardAction>
        </CardHeader>
        <CardContent>
          <div className="overflow-hidden rounded-3xl border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>任务</TableHead>
                  <TableHead>通道</TableHead>
                  <TableHead>来源</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>创建</TableHead>
                  <TableHead>更新</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentItems.map((item) => {
                  const liveJob = jobsById.get(item.jobId);
                  const canStart = item.status === "queued" && Boolean(liveJob?.canStart);
                  return (
                    <TableRow key={`${item.seq}-${item.jobId}`}>
                      <TableCell>{item.seq}</TableCell>
                      <TableCell className="font-mono text-xs">{shortJobId(item.jobId)}</TableCell>
                      <TableCell><ChannelBadge channel={item.channel} /></TableCell>
                      <TableCell><SourceBadge source={item.source} /></TableCell>
                      <TableCell><StatusBadge status={item.status} /></TableCell>
                      <TableCell>{formatDateTime(item.createdAt)}</TableCell>
                      <TableCell>{formatDateTime(item.updatedAt)}</TableCell>
                      <TableCell className="text-right">
                        {item.status === "queued" ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => control("start", item.jobId)}
                            disabled={isBusy || !canStart}
                            title={canStart ? "启动该等待任务" : "该记录没有可恢复的临时数据，无法启动"}
                          >
                            <PlayCircleIcon data-icon="inline-start" />启动
                          </Button>
                        ) : (
                          <span className="text-sm text-muted-foreground">-</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {recentItems.length === 0 && <TableRow><TableCell colSpan={8} className="h-28 text-center text-muted-foreground">暂无提取记录</TableCell></TableRow>}
              </TableBody>
            </Table>
          </div>
          <AdminListPagination pagination={state?.itemsPagination} loading={loading} onPageChange={setPage} className="mt-4" />
        </CardContent>
      </Card>
    </AppFrame>
  );
}

function ChannelPauseButton({
  channel,
  paused,
  disabled,
  acting,
  onControl,
}: {
  channel: ExtractChannel;
  paused: boolean;
  disabled: boolean;
  acting: string | null;
  onControl: (action: "pause" | "resume" | "start" | "stop" | "stopAll", jobId?: string, channel?: ExtractChannel) => void;
}) {
  const label = channelLabel(channel);
  const isActing = acting === `pause:${channel}` || acting === `resume:${channel}`;
  return paused ? (
    <Button onClick={() => onControl("resume", undefined, channel)} disabled={disabled || isActing}>
      <PlayCircleIcon data-icon="inline-start" />恢复{label}
    </Button>
  ) : (
    <Button variant="outline" onClick={() => onControl("pause", undefined, channel)} disabled={disabled || isActing}>
      <PauseCircleIcon data-icon="inline-start" />暂停{label}
    </Button>
  );
}

function ChannelBadge({ channel }: { channel?: ExtractChannel }) {
  return <Badge variant={channel === "premium" ? "default" : "outline"}>{channel === "premium" ? "Premium" : "公共"}</Badge>;
}

function channelLabel(channel?: ExtractChannel) {
  if (channel === "premium") return "Premium";
  if (channel === "public") return "公共";
  return "公益";
}

function channelMaxConcurrent(state: AdminExtractState | null, channel: ExtractChannel) {
  return state?.maxConcurrentByChannel?.[channel] ?? state?.maxConcurrent ?? (channel === "premium" ? 5 : 10);
}

function isAnyChannelPaused(state: AdminExtractState | null) {
  return Boolean(state?.pausedByChannel?.public || state?.pausedByChannel?.premium || state?.paused);
}

function pauseSummary(state: AdminExtractState | null) {
  const publicPaused = Boolean(state?.pausedByChannel?.public ?? state?.paused);
  const premiumPaused = Boolean(state?.pausedByChannel?.premium);
  if (publicPaused && premiumPaused) return "全部暂停";
  if (publicPaused) return "公共暂停";
  if (premiumPaused) return "Premium 暂停";
  return "运行中";
}

function StatusBadge({ status }: { status: ExtractStatus }) {
  const meta: Record<ExtractStatus, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
    completed: { label: "成功", variant: "default" },
    queued: { label: "等待中", variant: "secondary" },
    running: { label: "提取中", variant: "outline" },
    failed: { label: "失败", variant: "destructive" },
  };
  return <Badge variant={meta[status].variant}>{meta[status].label}</Badge>;
}

function SourceBadge({ source }: { source: ExtractSource }) {
  return <Badge variant={source === "storage" ? "secondary" : "outline"}>{source === "storage" ? "暂存" : "直接提交"}</Badge>;
}

function shortJobId(jobId: string) {
  if (!jobId) return "-";
  return `${jobId.slice(0, 8)}…${jobId.slice(-6)}`;
}

function stageText(stage?: string) {
  const map: Record<string, string> = {
    queued: "准备任务",
    validating: "验证凭证",
    checkout: "创建 checkout",
    stripe_init: "初始化 Stripe",
    stripe_confirm: "确认支付方式",
    approval: "Approve 阶段",
    waiting_qr: "等待二维码",
    hydrating: "读取二维码",
    rendering_qr: "渲染二维码",
    completed: "完成",
  };
  return map[stage || "queued"] || stage || "准备任务";
}
