"use client";

import Link from "next/link";
import { useCallback, useDeferredValue, useEffect, useState } from "react";
import { ArrowLeftIcon, Globe2Icon, HistoryIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import { toast } from "sonner";
import { AppFrame } from "@/components/app/app-frame";
import { OrderStatusBadge } from "@/components/app/status-badge";
import { TelegramLoginClient } from "@/components/app/telegram-login-client";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiFetch, formatMoney } from "@/lib/api-client";
import { useAppLanguage, type AppLanguage } from "@/lib/client/language";
import type { AdminPaginatedResponse, AdminPaginationMeta, PublicOrder } from "@/lib/types/app";

const HISTORY_PAGE_SIZE = 10;

type HistoryRecord = {
  id: string;
  result: "COMPLETED" | "PROBLEM" | "FAILED" | "CANCELLED" | "EXPIRED";
  note?: string | null;
  unitPriceSnapshot?: number;
  settledAt?: string | null;
  settledBy?: string | null;
  completedAt: string;
  order: Pick<PublicOrder, "id" | "orderNo" | "status" | "createdAt" | "completedAt">;
};

type Copy = {
  title: string;
  subtitle: string;
  refresh: string;
  refreshed: string;
  refreshFailed: string;
  back: string;
  order: string;
  result: string;
  price: string;
  settlement: string;
  time: string;
  note: string;
  empty: string;
  settled: string;
  unsettled: string;
  switchLanguage: string;
  searchPlaceholder: string;
  pageSummary: (page: number, totalPages: number, total: number, pageSize: number) => string;
  totalSummary: (total: number) => string;
  prevPage: string;
  nextPage: string;
};

const COPY: Record<AppLanguage, Copy> = {
  zh: {
    title: "历史记录",
    subtitle: "支持搜索和分页查看已处理、异常、取消与超时记录。",
    refresh: "刷新",
    refreshed: "历史记录已刷新",
    refreshFailed: "刷新失败",
    back: "返回工作台",
    order: "订单",
    result: "处理结果",
    price: "单价快照",
    settlement: "结单状态",
    time: "完成时间",
    note: "备注",
    empty: "暂无历史记录",
    settled: "已结",
    unsettled: "未结",
    switchLanguage: "EN",
    searchPlaceholder: "搜索订单号 / 状态 / 备注",
    pageSummary: (page, totalPages, total, pageSize) => `第 ${page} / ${totalPages} 页，共 ${total} 条，每页 ${pageSize} 条`,
    totalSummary: (total) => `共 ${total} 条`,
    prevPage: "上一页",
    nextPage: "下一页",
  },
  en: {
    title: "History",
    subtitle: "Search and browse processed, issue, cancelled, and expired order records.",
    refresh: "Refresh",
    refreshed: "History refreshed",
    refreshFailed: "Refresh failed",
    back: "Back to workbench",
    order: "Order",
    result: "Result",
    price: "Rate snapshot",
    settlement: "Settlement",
    time: "Completed at",
    note: "Note",
    empty: "No history yet",
    settled: "Settled",
    unsettled: "Unsettled",
    switchLanguage: "中文",
    searchPlaceholder: "Search order / status / note",
    pageSummary: (page, totalPages, total, pageSize) => `Page ${page} / ${totalPages}, ${total} total, ${pageSize} per page`,
    totalSummary: (total) => `${total} total`,
    prevPage: "Previous",
    nextPage: "Next",
  },
};

const resultLabels: Record<AppLanguage, Record<HistoryRecord["result"], string>> = {
  zh: { COMPLETED: "完成", PROBLEM: "异常重传", FAILED: "失败", CANCELLED: "取消", EXPIRED: "超时" },
  en: { COMPLETED: "Completed", PROBLEM: "Issue", FAILED: "Failed", CANCELLED: "Cancelled", EXPIRED: "Expired" },
};

function historyUrl(input: { page: number; search: string }) {
  const params = new URLSearchParams({
    paged: "1",
    page: String(input.page),
    pageSize: String(HISTORY_PAGE_SIZE),
  });
  if (input.search.trim()) params.set("search", input.search.trim());
  return `/api/worker/history?${params.toString()}`;
}

export function WorkerHistoryClient() {
  const { language, toggleLanguage } = useAppLanguage();
  const copy = COPY[language];
  const [records, setRecords] = useState<HistoryRecord[]>([]);
  const [pagination, setPagination] = useState<AdminPaginationMeta | null>(null);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [unauthorized, setUnauthorized] = useState(false);

  const refresh = useCallback(async (silent = false) => {
    try {
      setLoading(true);
      const data = await apiFetch<AdminPaginatedResponse<HistoryRecord>>(historyUrl({ page, search: deferredSearch }));
      setRecords(data.items);
      setPagination(data.pagination);
      if (data.pagination.page !== page) setPage(data.pagination.page);
      setUnauthorized(false);
      if (!silent) toast.success(COPY[language].refreshed);
    } catch (error) {
      if (error instanceof Error && (error.message.includes("未登录") || error.message.toLowerCase().includes("unauthorized"))) {
        setUnauthorized(true);
        return;
      }
      toast.error(error instanceof Error ? error.message : COPY[language].refreshFailed);
    } finally {
      setLoading(false);
    }
  }, [deferredSearch, language, page]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(true), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  if (unauthorized) return <TelegramLoginClient purpose="worker" />;

  return (
    <AppFrame
      audience="worker"
      title={copy.title}
      subtitle={copy.subtitle}
      onRefresh={() => refresh()}
      language={language}
      headerActions={<Button variant="outline" size="sm" onClick={toggleLanguage}><Globe2Icon data-icon="inline-start" />{copy.switchLanguage}</Button>}
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Link href="/worker" className={buttonVariants({ variant: "outline" })}><ArrowLeftIcon data-icon="inline-start" />{copy.back}</Link>
        <Button variant="outline" onClick={() => refresh()} disabled={loading}><RefreshCwIcon data-icon="inline-start" />{copy.refresh}</Button>
      </div>

      <Card className="rounded-3xl bg-background shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><HistoryIcon className="size-5 text-brand" />{copy.title}</CardTitle>
          <CardDescription>{copy.subtitle}</CardDescription>
          <CardAction>{pagination?.total ?? records.length}</CardAction>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="relative w-full sm:max-w-sm">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              placeholder={copy.searchPlaceholder}
              className="pl-9"
            />
          </div>

          <div className="overflow-hidden rounded-3xl border border-border">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader><TableRow><TableHead>{copy.order}</TableHead><TableHead>{copy.result}</TableHead><TableHead>{copy.price}</TableHead><TableHead>{copy.settlement}</TableHead><TableHead>{copy.time}</TableHead><TableHead>{copy.note}</TableHead></TableRow></TableHeader>
                <TableBody>
                  {records.length === 0 ? (
                    <TableRow><TableCell colSpan={6} className="h-36 text-center text-muted-foreground">{copy.empty}</TableCell></TableRow>
                  ) : records.map((record) => (
                    <TableRow key={record.id}>
                      <TableCell><div><div className="font-semibold">{record.order.orderNo}</div><div className="mt-1"><OrderStatusBadge status={record.order.status} language={language} /></div></div></TableCell>
                      <TableCell>{resultLabels[language][record.result]}</TableCell>
                      <TableCell>{record.result === "COMPLETED" ? formatMoney(record.unitPriceSnapshot) : "-"}</TableCell>
                      <TableCell>{record.result === "COMPLETED" ? (record.settledAt ? copy.settled : copy.unsettled) : "-"}</TableCell>
                      <TableCell>{formatDateTimeForLanguage(record.completedAt, language)}</TableCell>
                      <TableCell className="max-w-[260px] truncate">{record.note || "-"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>

          <WorkerHistoryPagination pagination={pagination} loading={loading} copy={copy} onPageChange={setPage} />
        </CardContent>
      </Card>
    </AppFrame>
  );
}

function WorkerHistoryPagination({
  pagination,
  loading,
  copy,
  onPageChange,
}: {
  pagination: AdminPaginationMeta | null;
  loading: boolean;
  copy: Copy;
  onPageChange: (page: number) => void;
}) {
  if (!pagination) return null;

  if (pagination.totalPages <= 1 && pagination.total <= pagination.pageSize) {
    return <div className="flex items-center justify-end text-xs text-muted-foreground">{copy.totalSummary(pagination.total)}</div>;
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
      <div className="text-xs text-muted-foreground">
        {copy.pageSummary(pagination.page, pagination.totalPages, pagination.total, pagination.pageSize)}
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loading || !pagination.hasPrev}
          onClick={() => onPageChange(Math.max(1, pagination.page - 1))}
        >
          {copy.prevPage}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loading || !pagination.hasNext}
          onClick={() => onPageChange(Math.min(pagination.totalPages, pagination.page + 1))}
        >
          {copy.nextPage}
        </Button>
      </div>
    </div>
  );
}

function formatDateTimeForLanguage(value: string | null | undefined, language: AppLanguage) {
  if (!value) return "-";
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-US", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}
