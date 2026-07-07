"use client";

import { useCallback, useDeferredValue, useEffect, useState } from "react";
import { AlertTriangleIcon, ArrowDownToLineIcon, ArrowUpFromLineIcon, CheckCircle2Icon, DatabaseIcon, RefreshCwIcon, ReceiptTextIcon, SearchIcon, WalletIcon, WrenchIcon } from "lucide-react";
import { toast } from "sonner";
import { AppFrame } from "@/components/app/app-frame";
import { AdminListPagination } from "@/components/app/admin-list-pagination";
import { MetricCard } from "@/components/app/metric-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiFetch, formatDateTime } from "@/lib/api-client";
import type { AdminPaginationMeta } from "@/lib/types/app";

type BillingLedger = {
  id: string;
  walletId: string;
  telegramUserId: string;
  telegramUsername?: string | null;
  type: string;
  availableDelta: number;
  frozenDelta: number;
  orderId?: string | null;
  referenceId?: string | null;
  note?: string | null;
  createdAt: string;
  walletAvailableBalance: number;
  walletFrozenBalance: number;
};

type BillingDepositOrder = {
  id: string;
  orderNo: string;
  walletId: string;
  telegramUserId: string;
  telegramUsername?: string | null;
  baseAmount: number;
  payAmount: number;
  status: "PENDING" | "PAID" | "EXPIRED" | "CANCELLED";
  chain: string;
  tokenSymbol: string;
  depositAddress: string;
  txHash?: string | null;
  logIndex?: number | null;
  fromAddress?: string | null;
  blockNumber?: number | null;
  confirmations?: number | null;
  expiresAt: string;
  paidAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

type BillingWithdrawal = {
  id: string;
  walletId: string;
  telegramUserId: string;
  telegramUsername?: string | null;
  amount: number;
  fee: number;
  totalFrozen: number;
  status: "PENDING" | "PAID" | "REJECTED" | "CANCELLED";
  chain: string;
  tokenSymbol: string;
  withdrawalAddress: string;
  note?: string | null;
  adminNote?: string | null;
  requestedAt: string;
  processedAt?: string | null;
  processedBy?: string | null;
};

type BillingChainDeposit = {
  id: string;
  telegramUserId: string;
  telegramUsername?: string | null;
  chain: string;
  tokenSymbol: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  fromAddress: string;
  toAddress: string;
  amount: number;
  confirmations: number;
  status: "CONFIRMED" | "IGNORED";
  creditedAt?: string | null;
  createdAt: string;
};

type BillingTab = "deposits" | "ledgers" | "withdrawals" | "chain";

type DepositCorrectionOrder = {
  id: string;
  orderNo: string;
  status: BillingDepositOrder["status"];
  baseAmount: number;
  payAmount: number;
  txHash?: string | null;
  logIndex?: number | null;
  createdAt: string;
  expiresAt: string;
  paidAt?: string | null;
  canBind: boolean;
};

type DepositCorrectionPreview = {
  tx: {
    txHash: string;
    logIndex: number;
    amount: number;
    fromAddress: string;
    toAddress: string;
    blockNumber: number;
    confirmations: number;
    creditedAt?: string | null;
  };
  current: {
    telegramUserId: string;
    telegramUsername?: string | null;
    walletId: string;
    availableBalance: number;
    totalDeposited: number;
    order?: Pick<DepositCorrectionOrder, "id" | "orderNo" | "status" | "payAmount" | "txHash" | "logIndex"> | null;
    ledger?: { id: string; referenceId?: string | null; availableDelta: number } | null;
  };
  target: {
    telegramUserId: string;
    telegramUsername?: string | null;
    walletId: string;
    availableBalance: number;
    totalDeposited: number;
  };
  candidateOrders: DepositCorrectionOrder[];
  selectedTargetOrderId?: string | null;
  recommendedTargetOrderId?: string | null;
  plan: {
    amount: number;
    debit: { telegramUserId: string; beforeAvailable: number; afterAvailable: number; beforeTotalDeposited: number; afterTotalDeposited: number };
    credit: { telegramUserId: string; beforeAvailable: number; afterAvailable: number; beforeTotalDeposited: number; afterTotalDeposited: number };
    wrongOrderAction: string;
    targetOrderAction: string;
    chainDepositAction: string;
    ledgerAction: string;
    canExecute: boolean;
    errors: string[];
    warnings: string[];
  };
};

type AdminBillingResponse = {
  summary: {
    walletCount: number;
    ledgerCount: number;
    chainDepositCount: number;
    availableBalance: number;
    frozenBalance: number;
    totalDeposited: number;
    totalSpent: number;
    depositOrderCount: number;
    depositOrderAmount: number;
    pendingDepositOrderCount: number;
    pendingDepositOrderAmount: number;
    paidDepositOrderCount: number;
    paidDepositOrderAmount: number;
    withdrawalCount: number;
    withdrawalAmount: number;
    pendingWithdrawalCount: number;
    pendingWithdrawalAmount: number;
  };
  ledgers: BillingLedger[];
  depositOrders: BillingDepositOrder[];
  withdrawals: BillingWithdrawal[];
  chainDeposits: BillingChainDeposit[];
  activeTab?: BillingTab;
  pagination?: AdminPaginationMeta;
};

const EMPTY_DATA: AdminBillingResponse = {
  summary: {
    walletCount: 0,
    ledgerCount: 0,
    chainDepositCount: 0,
    availableBalance: 0,
    frozenBalance: 0,
    totalDeposited: 0,
    totalSpent: 0,
    depositOrderCount: 0,
    depositOrderAmount: 0,
    pendingDepositOrderCount: 0,
    pendingDepositOrderAmount: 0,
    paidDepositOrderCount: 0,
    paidDepositOrderAmount: 0,
    withdrawalCount: 0,
    withdrawalAmount: 0,
    pendingWithdrawalCount: 0,
    pendingWithdrawalAmount: 0,
  },
  ledgers: [],
  depositOrders: [],
  withdrawals: [],
  chainDeposits: [],
};

const ADMIN_PAGE_SIZE = 20;

function pagedBillingUrl(input: { tab: BillingTab; page: number; search?: string }) {
  const params = new URLSearchParams();
  params.set("paged", "1");
  params.set("tab", input.tab);
  params.set("page", String(input.page));
  params.set("pageSize", String(ADMIN_PAGE_SIZE));
  if (input.search?.trim()) params.set("search", input.search.trim());
  return `/api/admin/billing?${params.toString()}`;
}

function depositCorrectionUrl(input: { txHash: string; logIndex?: string; target: string; targetOrderId?: string }) {
  const params = new URLSearchParams();
  params.set("txHash", input.txHash.trim());
  params.set("target", input.target.trim());
  if (input.logIndex?.trim()) params.set("logIndex", input.logIndex.trim());
  if (input.targetOrderId?.trim()) params.set("targetOrderId", input.targetOrderId.trim());
  return `/api/admin/billing/deposit-correction?${params.toString()}`;
}

function formatUsdt(value?: number | null) {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount)) return "0.000000 USDT";
  return `${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })} USDT`;
}

function shortValue(value?: string | null, start = 8, end = 8) {
  if (!value) return "-";
  if (value.length <= start + end + 3) return value;
  return `${value.slice(0, start)}...${value.slice(-end)}`;
}

function userLabel(item: { telegramUserId: string; telegramUsername?: string | null }) {
  return item.telegramUsername ? `@${item.telegramUsername}` : item.telegramUserId;
}

function depositStatusVariant(status: BillingDepositOrder["status"]): "default" | "secondary" | "destructive" | "outline" {
  if (status === "PAID") return "default";
  if (status === "PENDING") return "secondary";
  if (status === "EXPIRED") return "outline";
  return "destructive";
}

function withdrawalStatusVariant(status: BillingWithdrawal["status"]): "default" | "secondary" | "destructive" | "outline" {
  if (status === "PAID") return "default";
  if (status === "PENDING") return "secondary";
  if (status === "REJECTED") return "destructive";
  return "outline";
}

function ledgerTypeText(type: string) {
  const map: Record<string, string> = {
    CHAIN_DEPOSIT: "链上充值",
    CDK_REDEEM: "CDK 兑换",
    ADMIN_ADJUSTMENT: "余额调整 / Premium",
    SCAN_ORDER_FREEZE: "扫码订单冻结",
    SCAN_ORDER_REFUND: "扫码订单退款",
    SCAN_ORDER_SPEND: "扫码订单支付",
    WITHDRAWAL_FREEZE: "提现冻结",
    WITHDRAWAL_REFUND: "提现退回",
    WITHDRAWAL_PAID: "提现已支付",
  };
  return map[type] || type;
}

async function copyText(value?: string | null) {
  if (!value) return;
  await navigator.clipboard.writeText(value);
  toast.success("已复制");
}

export function AdminBillingClient() {
  const [data, setData] = useState<AdminBillingResponse>(EMPTY_DATA);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [activeTab, setActiveTab] = useState<BillingTab>("deposits");
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState<AdminPaginationMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [correctionTxHash, setCorrectionTxHash] = useState("");
  const [correctionLogIndex, setCorrectionLogIndex] = useState("");
  const [correctionTarget, setCorrectionTarget] = useState("");
  const [correctionTargetOrderId, setCorrectionTargetOrderId] = useState("");
  const [correctionConfirmText, setCorrectionConfirmText] = useState("");
  const [correctionNote, setCorrectionNote] = useState("");
  const [correctionPreview, setCorrectionPreview] = useState<DepositCorrectionPreview | null>(null);
  const [correctionLoading, setCorrectionLoading] = useState(false);
  const [correctionExecuting, setCorrectionExecuting] = useState(false);

  const refresh = useCallback(async (silent = false) => {
    try {
      setLoading(true);
      const nextData = await apiFetch<AdminBillingResponse>(pagedBillingUrl({ tab: activeTab, page, search: deferredSearch }));
      setData(nextData);
      setPagination(nextData.pagination || null);
      if (!silent) toast.success("账单数据已刷新");
    } catch (error) {
      if (!silent) toast.error(error instanceof Error ? error.message : "加载账单数据失败");
    } finally {
      setLoading(false);
    }
  }, [activeTab, deferredSearch, page]);

  const resetCorrectionPreview = useCallback(() => {
    setCorrectionPreview(null);
    setCorrectionTargetOrderId("");
    setCorrectionConfirmText("");
  }, []);

  const previewCorrection = useCallback(async () => {
    if (!correctionTxHash.trim() || !correctionTarget.trim()) {
      toast.error("请先填写交易哈希和正确入账用户");
      return;
    }
    try {
      setCorrectionLoading(true);
      const preview = await apiFetch<DepositCorrectionPreview>(depositCorrectionUrl({
        txHash: correctionTxHash,
        logIndex: correctionLogIndex,
        target: correctionTarget,
        targetOrderId: correctionTargetOrderId,
      }));
      setCorrectionPreview(preview);
      if (!correctionTargetOrderId && preview.recommendedTargetOrderId) {
        setCorrectionTargetOrderId(preview.recommendedTargetOrderId);
      }
      toast.success("充值纠错预览已生成");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "生成充值纠错预览失败");
    } finally {
      setCorrectionLoading(false);
    }
  }, [correctionLogIndex, correctionTarget, correctionTargetOrderId, correctionTxHash]);

  const executeCorrection = useCallback(async () => {
    if (!correctionPreview?.plan.canExecute) {
      toast.error("当前预览不可执行，请先处理错误提示");
      return;
    }
    try {
      setCorrectionExecuting(true);
      const result = await apiFetch<DepositCorrectionPreview>("/api/admin/billing/deposit-correction", {
        method: "POST",
        body: JSON.stringify({
          txHash: correctionTxHash,
          logIndex: correctionLogIndex,
          target: correctionTarget,
          targetOrderId: correctionTargetOrderId,
          confirmText: correctionConfirmText,
          adminNote: correctionNote,
        }),
      });
      setCorrectionPreview(result);
      setCorrectionConfirmText("");
      toast.success("充值纠错已执行");
      void refresh(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "执行充值纠错失败");
    } finally {
      setCorrectionExecuting(false);
    }
  }, [correctionConfirmText, correctionLogIndex, correctionNote, correctionPreview?.plan.canExecute, correctionTarget, correctionTargetOrderId, correctionTxHash, refresh]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(true), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  const filteredDepositOrders = data.depositOrders;
  const filteredLedgers = data.ledgers;
  const filteredWithdrawals = data.withdrawals;
  const filteredChainDeposits = data.chainDeposits;

  return (
    <AppFrame audience="admin" title="充值账单" subtitle="查看用户钱包、充值订单、链上入账、提现申请和钱包流水。" onRefresh={() => refresh()}>
      <div className="grid gap-4 xl:grid-cols-4">
        <MetricCard title="用户钱包" value={data.summary.walletCount} description={`可用 ${formatUsdt(data.summary.availableBalance)} · 冻结 ${formatUsdt(data.summary.frozenBalance)}`} icon={WalletIcon} tone="brand" />
        <MetricCard title="已入账充值" value={formatUsdt(data.summary.totalDeposited)} description={`${data.summary.paidDepositOrderCount} 个充值订单已支付`} icon={ArrowDownToLineIcon} tone="success" />
        <MetricCard title="待支付充值" value={data.summary.pendingDepositOrderCount} description={`等待 ${formatUsdt(data.summary.pendingDepositOrderAmount)}`} icon={ReceiptTextIcon} tone="warning" />
        <MetricCard title="提现待处理" value={data.summary.pendingWithdrawalCount} description={`冻结 ${formatUsdt(data.summary.pendingWithdrawalAmount)}`} icon={ArrowUpFromLineIcon} tone="info" />
      </div>

      <Card className="mt-4 rounded-3xl bg-background shadow-sm">
        <CardHeader>
          <CardTitle>钱包记录</CardTitle>
          <CardDescription>
            最近 300 条充值订单、钱包流水、提现申请和链上入账记录。搜索支持 TG、订单号、地址、交易哈希和备注。
          </CardDescription>
          <CardAction>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setCorrectionOpen(true)}>
                <WrenchIcon data-icon="inline-start" />充值纠错
              </Button>
              <div className="relative w-80 max-w-full">
                <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="搜索用户 / 地址 / TX / 订单" className="pl-9" />
              </div>
              <Button variant="outline" size="sm" onClick={() => refresh()} disabled={loading}>
                <RefreshCwIcon data-icon="inline-start" className={loading ? "animate-spin" : undefined} />刷新
              </Button>
            </div>
          </CardAction>
        </CardHeader>
        <CardContent>
          <Tabs value={activeTab} onValueChange={(value) => { setActiveTab(value as BillingTab); setPage(1); }} className="gap-4">
            <TabsList className="flex w-full flex-wrap justify-start rounded-2xl p-1">
              <TabsTrigger value="deposits" className="min-w-28">充值订单 {activeTab === "deposits" && pagination ? pagination.total : data.summary.depositOrderCount}</TabsTrigger>
              <TabsTrigger value="ledgers" className="min-w-28">钱包流水 {activeTab === "ledgers" && pagination ? pagination.total : data.summary.ledgerCount}</TabsTrigger>
              <TabsTrigger value="withdrawals" className="min-w-28">提现申请 {activeTab === "withdrawals" && pagination ? pagination.total : data.summary.withdrawalCount}</TabsTrigger>
              <TabsTrigger value="chain" className="min-w-28">链上入账 {activeTab === "chain" && pagination ? pagination.total : data.summary.chainDepositCount}</TabsTrigger>
            </TabsList>

            <TabsContent value="deposits">
              <div className="overflow-hidden rounded-3xl border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>订单</TableHead>
                      <TableHead>用户</TableHead>
                      <TableHead>金额</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>地址 / TX</TableHead>
                      <TableHead>时间</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredDepositOrders.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell>
                          <div className="font-semibold">{item.orderNo}</div>
                          <div className="text-xs text-muted-foreground">{item.chain} / {item.tokenSymbol}</div>
                        </TableCell>
                        <TableCell>
                          <div className="font-semibold">{userLabel(item)}</div>
                          <div className="font-mono text-xs text-muted-foreground">{item.telegramUserId}</div>
                        </TableCell>
                        <TableCell>
                          <div className="font-semibold">{formatUsdt(item.payAmount)}</div>
                          <div className="text-xs text-muted-foreground">基础金额 {formatUsdt(item.baseAmount)}</div>
                        </TableCell>
                        <TableCell><Badge variant={depositStatusVariant(item.status)}>{item.status}</Badge></TableCell>
                        <TableCell>
                          <button className="font-mono text-xs underline-offset-4 hover:underline" onClick={() => copyText(item.depositAddress)}>{shortValue(item.depositAddress)}</button>
                          {item.txHash && <div><button className="font-mono text-xs text-muted-foreground underline-offset-4 hover:underline" onClick={() => copyText(item.txHash)}>{shortValue(item.txHash, 10, 10)}</button></div>}
                          {item.fromAddress && <div className="font-mono text-xs text-muted-foreground">from {shortValue(item.fromAddress)}</div>}
                        </TableCell>
                        <TableCell>
                          <div className="text-sm">创建 {formatDateTime(item.createdAt)}</div>
                          <div className="text-xs text-muted-foreground">过期 {formatDateTime(item.expiresAt)}</div>
                          {item.paidAt && <div className="text-xs text-success">支付 {formatDateTime(item.paidAt)}</div>}
                        </TableCell>
                      </TableRow>
                    ))}
                    {filteredDepositOrders.length === 0 && <TableRow><TableCell colSpan={6} className="h-32 text-center text-muted-foreground">暂无充值订单</TableCell></TableRow>}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>

            <TabsContent value="ledgers">
              <div className="overflow-hidden rounded-3xl border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>用户</TableHead>
                      <TableHead>类型</TableHead>
                      <TableHead>变动</TableHead>
                      <TableHead>关联</TableHead>
                      <TableHead>备注</TableHead>
                      <TableHead>时间</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredLedgers.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell>
                          <div className="font-semibold">{userLabel(item)}</div>
                          <div className="font-mono text-xs text-muted-foreground">{item.telegramUserId}</div>
                        </TableCell>
                        <TableCell><Badge variant="secondary">{ledgerTypeText(item.type)}</Badge></TableCell>
                        <TableCell>
                          <div className="text-sm">可用 <span className={item.availableDelta >= 0 ? "text-success" : "text-destructive"}>{formatUsdt(item.availableDelta)}</span></div>
                          <div className="text-xs text-muted-foreground">冻结 {formatUsdt(item.frozenDelta)}</div>
                        </TableCell>
                        <TableCell>
                          <div className="font-mono text-xs">{item.orderId ? shortValue(item.orderId, 8, 6) : "-"}</div>
                          {item.referenceId && <div className="font-mono text-xs text-muted-foreground">{shortValue(item.referenceId, 14, 10)}</div>}
                        </TableCell>
                        <TableCell className="max-w-[340px] truncate">{item.note || "-"}</TableCell>
                        <TableCell>{formatDateTime(item.createdAt)}</TableCell>
                      </TableRow>
                    ))}
                    {filteredLedgers.length === 0 && <TableRow><TableCell colSpan={6} className="h-32 text-center text-muted-foreground">暂无钱包流水</TableCell></TableRow>}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>

            <TabsContent value="withdrawals">
              <div className="overflow-hidden rounded-3xl border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>用户</TableHead>
                      <TableHead>金额</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>提现地址</TableHead>
                      <TableHead>备注</TableHead>
                      <TableHead>时间</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredWithdrawals.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell>
                          <div className="font-semibold">{userLabel(item)}</div>
                          <div className="font-mono text-xs text-muted-foreground">{item.telegramUserId}</div>
                        </TableCell>
                        <TableCell>
                          <div className="font-semibold">{formatUsdt(item.amount)}</div>
                          <div className="text-xs text-muted-foreground">手续费 {formatUsdt(item.fee)} / 冻结 {formatUsdt(item.totalFrozen)}</div>
                        </TableCell>
                        <TableCell><Badge variant={withdrawalStatusVariant(item.status)}>{item.status}</Badge></TableCell>
                        <TableCell>
                          <button className="font-mono text-xs underline-offset-4 hover:underline" onClick={() => copyText(item.withdrawalAddress)}>{shortValue(item.withdrawalAddress)}</button>
                          <div className="text-xs text-muted-foreground">{item.chain} / {item.tokenSymbol}</div>
                        </TableCell>
                        <TableCell className="max-w-[300px] truncate">{item.adminNote || item.note || "-"}</TableCell>
                        <TableCell>
                          <div className="text-sm">申请 {formatDateTime(item.requestedAt)}</div>
                          {item.processedAt && <div className="text-xs text-muted-foreground">处理 {formatDateTime(item.processedAt)}</div>}
                        </TableCell>
                      </TableRow>
                    ))}
                    {filteredWithdrawals.length === 0 && <TableRow><TableCell colSpan={6} className="h-32 text-center text-muted-foreground">暂无提现申请</TableCell></TableRow>}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>

            <TabsContent value="chain">
              <div className="overflow-hidden rounded-3xl border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>用户</TableHead>
                      <TableHead>金额</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>交易</TableHead>
                      <TableHead>地址</TableHead>
                      <TableHead>时间</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredChainDeposits.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell>
                          <div className="font-semibold">{userLabel(item)}</div>
                          <div className="font-mono text-xs text-muted-foreground">{item.telegramUserId}</div>
                        </TableCell>
                        <TableCell className="font-semibold">{formatUsdt(item.amount)}</TableCell>
                        <TableCell><Badge variant={item.status === "CONFIRMED" ? "default" : "outline"}>{item.status}</Badge></TableCell>
                        <TableCell>
                          <button className="font-mono text-xs underline-offset-4 hover:underline" onClick={() => copyText(item.txHash)}>{shortValue(item.txHash, 10, 10)}</button>
                          <div className="text-xs text-muted-foreground">Block {item.blockNumber} · {item.confirmations} conf</div>
                        </TableCell>
                        <TableCell>
                          <div className="font-mono text-xs">from {shortValue(item.fromAddress)}</div>
                          <div className="font-mono text-xs text-muted-foreground">to {shortValue(item.toAddress)}</div>
                        </TableCell>
                        <TableCell>
                          <div className="text-sm">发现 {formatDateTime(item.createdAt)}</div>
                          {item.creditedAt && <div className="text-xs text-success">入账 {formatDateTime(item.creditedAt)}</div>}
                        </TableCell>
                      </TableRow>
                    ))}
                    {filteredChainDeposits.length === 0 && <TableRow><TableCell colSpan={6} className="h-32 text-center text-muted-foreground">暂无链上入账</TableCell></TableRow>}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>
          </Tabs>
          <AdminListPagination pagination={pagination} loading={loading} onPageChange={setPage} className="mt-4" />

          <div className="mt-4 flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-3 py-1"><DatabaseIcon className="size-3.5" />流水总数 {data.summary.ledgerCount}</span>
            <span className="rounded-full bg-muted px-3 py-1">充值订单总数 {data.summary.depositOrderCount}</span>
            <span className="rounded-full bg-muted px-3 py-1">链上记录总数 {data.summary.chainDepositCount}</span>
            <span className="rounded-full bg-muted px-3 py-1">用户总消费 {formatUsdt(data.summary.totalSpent)}</span>
          </div>
        </CardContent>
      </Card>

      <Dialog open={correctionOpen} onOpenChange={setCorrectionOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>充值纠错</DialogTitle>
            <DialogDescription>
              用于处理统一收款地址下金额撞单、错误入账等情况。请先预览影响范围，确认无误后再执行。
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 md:grid-cols-[1.4fr_0.7fr]">
            <div className="space-y-3">
              <div className="grid gap-2">
                <Label htmlFor="correction-tx">交易哈希</Label>
                <Input
                  id="correction-tx"
                  value={correctionTxHash}
                  onChange={(event) => { setCorrectionTxHash(event.target.value); resetCorrectionPreview(); }}
                  placeholder="0x..."
                  className="font-mono"
                />
              </div>
              <div className="grid gap-2 md:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="correction-log-index">LogIndex（可选）</Label>
                  <Input
                    id="correction-log-index"
                    value={correctionLogIndex}
                    onChange={(event) => { setCorrectionLogIndex(event.target.value); resetCorrectionPreview(); }}
                    placeholder="多条 Transfer 时填写"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="correction-target">正确入账用户</Label>
                  <Input
                    id="correction-target"
                    value={correctionTarget}
                    onChange={(event) => { setCorrectionTarget(event.target.value); resetCorrectionPreview(); }}
                    placeholder="Telegram ID 或 @username"
                  />
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="correction-note">备注（可选）</Label>
                <Input
                  id="correction-note"
                  value={correctionNote}
                  onChange={(event) => setCorrectionNote(event.target.value)}
                  placeholder="留空则自动生成纠错备注"
                />
              </div>
              <Button type="button" variant="outline" onClick={() => void previewCorrection()} disabled={correctionLoading || !correctionTxHash.trim() || !correctionTarget.trim()}>
                <SearchIcon data-icon="inline-start" className={correctionLoading ? "animate-spin" : undefined} />
                {correctionLoading ? "正在预览..." : "预览纠错"}
              </Button>
            </div>

            <div className="rounded-2xl border border-warning/30 bg-warning/5 p-3 text-xs text-muted-foreground">
              <div className="mb-2 flex items-center gap-2 font-semibold text-warning">
                <AlertTriangleIcon className="size-4" />
                安全规则
              </div>
              <ul className="list-disc space-y-1 pl-4">
                <li>执行前会再次校验当前钱包、订单、流水和 tx 状态。</li>
                <li>错误用户余额不足时不会执行。</li>
                <li>CONFIRM 输入错误不会执行；请复制正确的 CONFIRM。</li>
                <li>建议只处理已经和用户确认过的交易。</li>
              </ul>
            </div>
          </div>

          {correctionPreview && (
            <div className="space-y-4 rounded-3xl border border-border bg-muted/20 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="font-semibold">纠错预览</div>
                  <div className="font-mono text-xs text-muted-foreground">{shortValue(correctionPreview.tx.txHash, 14, 12)} · logIndex {correctionPreview.tx.logIndex}</div>
                </div>
                <Badge variant={correctionPreview.plan.canExecute ? "default" : "destructive"}>
                  {correctionPreview.plan.canExecute ? "可执行" : "不可执行"}
                </Badge>
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                <div className="rounded-2xl bg-background p-3">
                  <div className="text-xs text-muted-foreground">链上金额</div>
                  <div className="mt-1 text-lg font-semibold">{formatUsdt(correctionPreview.tx.amount)}</div>
                  <div className="mt-1 font-mono text-xs text-muted-foreground">from {shortValue(correctionPreview.tx.fromAddress)}</div>
                </div>
                <div className="rounded-2xl bg-background p-3">
                  <div className="text-xs text-muted-foreground">当前错误归属</div>
                  <div className="mt-1 font-semibold">{userLabel(correctionPreview.current)}</div>
                  <div className="text-xs text-muted-foreground">可用 {formatUsdt(correctionPreview.current.availableBalance)} → {formatUsdt(correctionPreview.plan.debit.afterAvailable)}</div>
                  <div className="text-xs text-muted-foreground">总充值 {formatUsdt(correctionPreview.current.totalDeposited)} → {formatUsdt(correctionPreview.plan.debit.afterTotalDeposited)}</div>
                </div>
                <div className="rounded-2xl bg-background p-3">
                  <div className="text-xs text-muted-foreground">正确入账用户</div>
                  <div className="mt-1 font-semibold">{userLabel(correctionPreview.target)}</div>
                  <div className="text-xs text-muted-foreground">可用 {formatUsdt(correctionPreview.target.availableBalance)} → {formatUsdt(correctionPreview.plan.credit.afterAvailable)}</div>
                  <div className="text-xs text-muted-foreground">总充值 {formatUsdt(correctionPreview.target.totalDeposited)} → {formatUsdt(correctionPreview.plan.credit.afterTotalDeposited)}</div>
                </div>
              </div>

              <div className="grid gap-2 text-sm">
                <div className="rounded-2xl bg-background p-3">{correctionPreview.plan.wrongOrderAction}</div>
                <div className="rounded-2xl bg-background p-3">{correctionPreview.plan.chainDepositAction}</div>
                <div className="rounded-2xl bg-background p-3">{correctionPreview.plan.ledgerAction}</div>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="correction-target-order">目标充值单绑定</Label>
                <select
                  id="correction-target-order"
                  value={correctionTargetOrderId}
                  onChange={(event) => { setCorrectionTargetOrderId(event.target.value); setCorrectionPreview(null); setCorrectionConfirmText(""); }}
                  className="h-10 rounded-xl border border-input bg-background px-3 text-sm"
                >
                  <option value="">不绑定订单，只按 tx 补余额</option>
                  {correctionPreview.candidateOrders.map((order) => (
                    <option key={order.id} value={order.id} disabled={!order.canBind}>
                      {order.orderNo} · {order.status} · 应付 {formatUsdt(order.payAmount)}{order.canBind ? "" : " · 已被其他交易支付"}
                    </option>
                  ))}
                </select>
                <div className="text-xs text-muted-foreground">切换绑定目标后，请重新点击“预览纠错”。</div>
              </div>

              {(correctionPreview.plan.errors.length > 0 || correctionPreview.plan.warnings.length > 0) && (
                <div className="space-y-2">
                  {correctionPreview.plan.errors.map((item) => (
                    <div key={item} className="rounded-2xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{item}</div>
                  ))}
                  {correctionPreview.plan.warnings.map((item) => (
                    <div key={item} className="rounded-2xl border border-warning/30 bg-warning/5 p-3 text-sm text-warning">{item}</div>
                  ))}
                </div>
              )}

              <div className="grid gap-2">
                <Label htmlFor="correction-confirm">确认文本</Label>
                <Input
                  id="correction-confirm"
                  value={correctionConfirmText}
                  onChange={(event) => setCorrectionConfirmText(event.target.value)}
                  placeholder="输入 CONFIRM 后才能执行"
                />
              </div>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setCorrectionOpen(false)} disabled={correctionExecuting}>关闭</Button>
            <Button
              type="button"
              disabled={!correctionPreview?.plan.canExecute || correctionConfirmText !== "CONFIRM" || correctionExecuting}
              onClick={() => void executeCorrection()}
            >
              {correctionExecuting ? <RefreshCwIcon data-icon="inline-start" className="animate-spin" /> : <CheckCircle2Icon data-icon="inline-start" />}
              {correctionExecuting ? "正在执行..." : "确认执行纠错"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppFrame>
  );
}
