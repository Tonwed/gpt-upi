"use client";

import Link from "next/link";
import { useCallback, useDeferredValue, useEffect, useState } from "react";
import { ArrowLeftIcon, Globe2Icon, RefreshCwIcon, SearchIcon, WalletIcon, XCircleIcon } from "lucide-react";
import { toast } from "sonner";
import { AppFrame } from "@/components/app/app-frame";
import { TelegramLoginClient } from "@/components/app/telegram-login-client";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiFetch, formatMoney } from "@/lib/api-client";
import { useAppLanguage, type AppLanguage } from "@/lib/client/language";
import type { AdminPaginatedResponse, AdminPaginationMeta, PublicWorkerWithdrawalRequest } from "@/lib/types/app";

const WITHDRAWALS_PAGE_SIZE = 10;

type Copy = {
  title: string;
  subtitle: string;
  refresh: string;
  refreshed: string;
  refreshFailed: string;
  back: string;
  searchPlaceholder: string;
  amount: string;
  status: string;
  binanceUid: string;
  requestedAt: string;
  processedAt: string;
  note: string;
  action: string;
  cancel: string;
  cancelling: string;
  cancelSuccess: string;
  cancelFailed: string;
  empty: string;
  switchLanguage: string;
  pageSummary: (page: number, totalPages: number, total: number, pageSize: number) => string;
  totalSummary: (total: number) => string;
  prevPage: string;
  nextPage: string;
};

const COPY: Record<AppLanguage, Copy> = {
  zh: {
    title: "提现申请记录",
    subtitle: "按时间倒序查看提现申请，支持状态、Binance UID、备注和申请 ID 搜索。",
    refresh: "刷新",
    refreshed: "提现记录已刷新",
    refreshFailed: "刷新失败",
    back: "返回工作台",
    searchPlaceholder: "搜索状态 / Binance UID / 备注 / 申请 ID",
    amount: "金额",
    status: "状态",
    binanceUid: "Binance UID",
    requestedAt: "申请时间",
    processedAt: "处理时间",
    note: "备注",
    action: "操作",
    cancel: "取消申请",
    cancelling: "取消中...",
    cancelSuccess: "提现申请已取消，可提余额已恢复",
    cancelFailed: "取消提现失败",
    empty: "暂无提现申请",
    switchLanguage: "EN",
    pageSummary: (page, totalPages, total, pageSize) => `第 ${page} / ${totalPages} 页，共 ${total} 条，每页 ${pageSize} 条`,
    totalSummary: (total) => `共 ${total} 条`,
    prevPage: "上一页",
    nextPage: "下一页",
  },
  en: {
    title: "Withdrawal requests",
    subtitle: "Browse withdrawal requests by time. Search status, Binance UID, notes, or request ID.",
    refresh: "Refresh",
    refreshed: "Withdrawal requests refreshed",
    refreshFailed: "Refresh failed",
    back: "Back to workbench",
    searchPlaceholder: "Search status / Binance UID / note / request ID",
    amount: "Amount",
    status: "Status",
    binanceUid: "Binance UID",
    requestedAt: "Requested at",
    processedAt: "Processed at",
    note: "Note",
    action: "Action",
    cancel: "Cancel",
    cancelling: "Cancelling...",
    cancelSuccess: "Withdrawal request cancelled. Available balance restored.",
    cancelFailed: "Failed to cancel withdrawal",
    empty: "No withdrawal requests yet",
    switchLanguage: "中文",
    pageSummary: (page, totalPages, total, pageSize) => `Page ${page} / ${totalPages}, ${total} total, ${pageSize} per page`,
    totalSummary: (total) => `${total} total`,
    prevPage: "Previous",
    nextPage: "Next",
  },
};

const STATUS_TEXT: Record<AppLanguage, Record<PublicWorkerWithdrawalRequest["status"], string>> = {
  zh: {
    PENDING: "待处理",
    PAID: "已打款",
    REJECTED: "已拒绝",
    CANCELLED: "已取消",
  },
  en: {
    PENDING: "Pending",
    PAID: "Paid",
    REJECTED: "Rejected",
    CANCELLED: "Cancelled",
  },
};

function withdrawalsUrl(input: { page: number; search: string }) {
  const params = new URLSearchParams({
    paged: "1",
    page: String(input.page),
    pageSize: String(WITHDRAWALS_PAGE_SIZE),
  });
  if (input.search.trim()) params.set("search", input.search.trim());
  return `/api/worker/wallet/withdrawals?${params.toString()}`;
}

function withdrawalStatusBadgeVariant(status: PublicWorkerWithdrawalRequest["status"]): "default" | "secondary" | "destructive" | "outline" {
  if (status === "PAID") return "default";
  if (status === "REJECTED") return "destructive";
  if (status === "CANCELLED") return "outline";
  return "secondary";
}

function formatDateTimeForLanguage(value: string | null | undefined, language: AppLanguage) {
  if (!value) return "-";
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-US", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function compactRequestId(id: string) {
  if (id.length <= 14) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

export function WorkerWithdrawalsClient() {
  const { language, toggleLanguage } = useAppLanguage();
  const copy = COPY[language];
  const [records, setRecords] = useState<PublicWorkerWithdrawalRequest[]>([]);
  const [pagination, setPagination] = useState<AdminPaginationMeta | null>(null);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);

  const refresh = useCallback(async (silent = false) => {
    try {
      setLoading(true);
      const data = await apiFetch<AdminPaginatedResponse<PublicWorkerWithdrawalRequest>>(
        withdrawalsUrl({ page, search: deferredSearch })
      );
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

  async function cancelWithdrawal(request: PublicWorkerWithdrawalRequest) {
    if (request.status !== "PENDING") return;
    try {
      setCancellingId(request.id);
      const updated = await apiFetch<PublicWorkerWithdrawalRequest>(
        "/api/worker/wallet/withdrawals/" + request.id + "/cancel",
        { method: "POST" }
      );
      setRecords((current) => current.map((item) => item.id === updated.id ? updated : item));
      toast.success(copy.cancelSuccess);
      void refresh(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy.cancelFailed);
    } finally {
      setCancellingId(null);
    }
  }

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
        <Link href="/worker" className={buttonVariants({ variant: "outline" })}>
          <ArrowLeftIcon data-icon="inline-start" />
          {copy.back}
        </Link>
        <Button variant="outline" onClick={() => refresh()} disabled={loading}>
          <RefreshCwIcon data-icon="inline-start" className={loading ? "animate-spin" : undefined} />
          {copy.refresh}
        </Button>
      </div>

      <Card className="rounded-3xl bg-background shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <WalletIcon className="size-5 text-brand" />
            {copy.title}
          </CardTitle>
          <CardDescription>{copy.subtitle}</CardDescription>
          <CardAction>{pagination?.total ?? records.length}</CardAction>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="relative w-full sm:max-w-md">
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
                <TableHeader>
                  <TableRow>
                    <TableHead>{copy.amount}</TableHead>
                    <TableHead>{copy.status}</TableHead>
                    <TableHead>{copy.binanceUid}</TableHead>
                    <TableHead>{copy.requestedAt}</TableHead>
                    <TableHead>{copy.processedAt}</TableHead>
                    <TableHead>{copy.note}</TableHead>
                    <TableHead className="text-right">{copy.action}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {records.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="h-36 text-center text-muted-foreground">{copy.empty}</TableCell>
                    </TableRow>
                  ) : records.map((record) => (
                    <TableRow key={record.id}>
                      <TableCell>
                        <div className="font-semibold">{formatMoney(record.amount)}</div>
                        <div className="font-mono text-xs text-muted-foreground" title={record.id}>{compactRequestId(record.id)}</div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={withdrawalStatusBadgeVariant(record.status)}>{STATUS_TEXT[language][record.status]}</Badge>
                      </TableCell>
                      <TableCell>
                        <span className="font-mono text-xs">{record.binanceUserIdSnapshot || "-"}</span>
                      </TableCell>
                      <TableCell>{formatDateTimeForLanguage(record.requestedAt, language)}</TableCell>
                      <TableCell>
                        <div>{formatDateTimeForLanguage(record.processedAt, language)}</div>
                        {record.processedBy && <div className="text-xs text-muted-foreground">{record.processedBy}</div>}
                      </TableCell>
                      <TableCell className="max-w-[320px]">
                        <div className="truncate">{record.note || "-"}</div>
                        {record.adminNote && <div className="truncate text-xs text-muted-foreground">Admin: {record.adminNote}</div>}
                      </TableCell>
                      <TableCell className="text-right">
                        {record.status === "PENDING" ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => cancelWithdrawal(record)}
                            disabled={Boolean(cancellingId)}
                          >
                            <XCircleIcon data-icon="inline-start" />
                            {cancellingId === record.id ? copy.cancelling : copy.cancel}
                          </Button>
                        ) : (
                          <span className="text-sm text-muted-foreground">-</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>

          <WorkerWithdrawalPagination pagination={pagination} loading={loading || Boolean(cancellingId)} copy={copy} onPageChange={setPage} />
        </CardContent>
      </Card>
    </AppFrame>
  );
}

function WorkerWithdrawalPagination({
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
