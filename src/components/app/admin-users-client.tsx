"use client";

import { useCallback, useDeferredValue, useEffect, useState } from "react";
import { CheckCircle2Icon, CrownIcon, SearchIcon, UsersRoundIcon, WalletIcon, XCircleIcon } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch, formatDateTime } from "@/lib/api-client";
import type { AdminPaginatedResponse, AdminPaginationMeta } from "@/lib/types/app";

type AdminPublicUser = {
  id: string;
  telegramUserId: string;
  telegramUsername?: string | null;
  hasWallet?: boolean;
  isPremium?: boolean;
  premiumEnabled?: boolean;
  premiumUntil?: string | null;
  premiumSource?: "manual" | "default" | "none";
  premiumTier?: "premium" | "premium_og" | "none";
  premiumExpired?: boolean;
  depositRiskSigned?: boolean;
  depositRiskSignedAt?: string | null;
  availableBalance: number;
  frozenBalance: number;
  totalDeposited: number;
  totalSpent: number;
  withdrawalCount: number;
  pendingWithdrawalCount: number;
  pendingWithdrawalAmount: number;
  ledgerCount: number;
  extractCount: number;
  scanOrderCount: number;
  createdAt: string;
  updatedAt: string;
};

type AdminPublicUsersResponse = {
  users: AdminPublicUser[];
  pagination?: AdminPaginationMeta;
  summary: {
    userCount: number;
    walletCount?: number;
    availableBalance: number;
    frozenBalance: number;
    totalDeposited: number;
    totalSpent: number;
  };
};

const ADMIN_PAGE_SIZE = 20;

function pagedAdminUrl(path: string, input: { page: number; search?: string; pageSize?: number }) {
  const params = new URLSearchParams();
  params.set("paged", "1");
  params.set("page", String(input.page));
  params.set("pageSize", String(input.pageSize ?? ADMIN_PAGE_SIZE));
  if (input.search?.trim()) params.set("search", input.search.trim());
  return `${path}?${params.toString()}`;
}

type PublicSiteSettings = {
  tgInviteEnabled: boolean;
  tgInviteUrl: string;
  depositEnabled: boolean;
  withdrawEnabled: boolean;
  premiumSaleEnabled: boolean;
  premiumPurchasePrice: number;
  faqContent: string;
  faqContentEn: string;
  extractMethodSelectionEnabled: boolean;
  customProxyEnabled: boolean;
};

type PublicUserWithdrawalStatus = "PENDING" | "PAID" | "REJECTED" | "CANCELLED";

type AdminPublicWithdrawalRequest = {
  id: string;
  telegramUserId: string;
  telegramUsername?: string | null;
  amount: number;
  fee: number;
  totalFrozen: number;
  status: PublicUserWithdrawalStatus;
  chain: string;
  tokenSymbol: string;
  withdrawalAddress: string;
  note?: string | null;
  adminNote?: string | null;
  requestedAt: string;
  processedAt?: string | null;
  processedBy?: string | null;
  createdAt: string;
  updatedAt: string;
  wallet?: {
    availableBalance: number;
    frozenBalance: number;
    totalDeposited: number;
    totalSpent: number;
  } | null;
};

function formatUsdt(value?: number | null) {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount)) return "0.000000 USDT";
  return `${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })} USDT`;
}

function shortAddress(value?: string | null) {
  if (!value) return "-";
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}...${value.slice(-8)}`;
}

function formatPremiumUntil(value?: string | null) {
  if (!value) return "永久";
  return formatDateTime(value);
}

function premiumTierLabel(tier?: AdminPublicUser["premiumTier"]) {
  return tier === "premium_og" ? "Premium OG" : "Premium";
}

function defaultPremiumDateValue(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function parsePremiumDateValue(value: string) {
  const text = value.trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return new Date(`${text}T23:59:59+08:00`).toISOString();
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function withdrawalStatusText(status: PublicUserWithdrawalStatus) {
  if (status === "PENDING") return "待处理";
  if (status === "PAID") return "已支付";
  if (status === "REJECTED") return "已拒绝";
  return "已取消";
}

function withdrawalStatusVariant(status: PublicUserWithdrawalStatus): "default" | "secondary" | "destructive" | "outline" {
  if (status === "PENDING") return "secondary";
  if (status === "PAID") return "default";
  if (status === "REJECTED") return "destructive";
  return "outline";
}

async function copyText(text?: string | null) {
  if (!text) return;
  await navigator.clipboard.writeText(text);
  toast.success("已复制");
}

export function AdminUsersClient() {
  type AdminUsersSection = "users" | "withdrawals" | "settings";
  const [users, setUsers] = useState<AdminPublicUser[]>([]);
  const [summary, setSummary] = useState<AdminPublicUsersResponse["summary"]>({
    userCount: 0,
    availableBalance: 0,
    frozenBalance: 0,
    totalDeposited: 0,
    totalSpent: 0,
  });
  const [withdrawals, setWithdrawals] = useState<AdminPublicWithdrawalRequest[]>([]);
  const [activeSection, setActiveSection] = useState<AdminUsersSection>("users");
  const [settings, setSettings] = useState<PublicSiteSettings>({
    tgInviteEnabled: false,
    tgInviteUrl: "https://t.me/your_group",
    depositEnabled: true,
    withdrawEnabled: false,
    premiumSaleEnabled: true,
    premiumPurchasePrice: 1.5,
    faqContent: "",
    faqContentEn: "",
    extractMethodSelectionEnabled: false,
    customProxyEnabled: false,
  });
  const [search, setSearch] = useState("");
  const [withdrawalSearch, setWithdrawalSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const deferredWithdrawalSearch = useDeferredValue(withdrawalSearch);
  const [page, setPage] = useState(1);
  const [withdrawalPage, setWithdrawalPage] = useState(1);
  const [pagination, setPagination] = useState<AdminPaginationMeta | null>(null);
  const [withdrawalPagination, setWithdrawalPagination] = useState<AdminPaginationMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const [premiumDialogOpen, setPremiumDialogOpen] = useState(false);
  const [premiumDialogUser, setPremiumDialogUser] = useState<AdminPublicUser | null>(null);
  const [premiumDialogEnabled, setPremiumDialogEnabled] = useState(true);
  const [premiumDialogTier, setPremiumDialogTier] = useState<"premium" | "premium_og">("premium");
  const [premiumUntilInput, setPremiumUntilInput] = useState("");
  const [premiumPermanent, setPremiumPermanent] = useState(true);
  const [premiumSaving, setPremiumSaving] = useState(false);
  const [withdrawalDialogOpen, setWithdrawalDialogOpen] = useState(false);
  const [withdrawalDialogRequest, setWithdrawalDialogRequest] = useState<AdminPublicWithdrawalRequest | null>(null);
  const [withdrawalDialogAction, setWithdrawalDialogAction] = useState<"paid" | "reject">("paid");
  const [withdrawalAdminNote, setWithdrawalAdminNote] = useState("");
  const [withdrawalSaving, setWithdrawalSaving] = useState(false);
  const [premiumPriceDraft, setPremiumPriceDraft] = useState("1.5");
  const [premiumPriceDirty, setPremiumPriceDirty] = useState(false);
  const [premiumSaleSaving, setPremiumSaleSaving] = useState(false);
  const [faqDraft, setFaqDraft] = useState("");
  const [faqDraftEn, setFaqDraftEn] = useState("");
  const [faqLang, setFaqLang] = useState<"zh" | "en">("zh");
  const [faqDirty, setFaqDirty] = useState(false);
  const [faqSaving, setFaqSaving] = useState(false);

  const refresh = useCallback(async (silent = false) => {
    try {
      setLoading(true);
      const [usersData, withdrawalData, settingsData] = await Promise.all([
        apiFetch<AdminPublicUsersResponse>(pagedAdminUrl("/api/admin/public-users", { page, search: deferredSearch })),
        apiFetch<AdminPaginatedResponse<AdminPublicWithdrawalRequest>>(pagedAdminUrl("/api/admin/public-withdrawals", { page: withdrawalPage, search: deferredWithdrawalSearch })),
        apiFetch<PublicSiteSettings>("/api/admin/settings"),
      ]);
      setUsers(usersData.users);
      setPagination(usersData.pagination || null);
      setSummary(usersData.summary);
      setWithdrawals(withdrawalData.items);
      setWithdrawalPagination(withdrawalData.pagination);
      setSettings(settingsData);
      if (!premiumPriceDirty) setPremiumPriceDraft(String(settingsData.premiumPurchasePrice));
      if (!faqDirty) setFaqDraft(settingsData.faqContent || "");
      if (!faqDirty) setFaqDraftEn(settingsData.faqContentEn || "");
      if (!silent) toast.success("用户数据已刷新");
    } catch (error) {
      if (!silent) toast.error(error instanceof Error ? error.message : "加载用户数据失败");
    } finally {
      setLoading(false);
    }
  }, [deferredSearch, deferredWithdrawalSearch, faqDirty, page, premiumPriceDirty, withdrawalPage]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(true), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

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

  const setWithdrawEnabled = useCallback(async (enabled: boolean) => {
    const previous = settings;
    try {
      setSettings((current) => ({ ...current, withdrawEnabled: enabled }));
      const nextSettings = await apiFetch<PublicSiteSettings>("/api/admin/settings", {
        method: "POST",
        body: JSON.stringify({ withdrawEnabled: enabled }),
      });
      setSettings(nextSettings);
      toast.success(enabled ? "提现入口已显示" : "提现入口已隐藏");
    } catch (error) {
      setSettings(previous);
      toast.error(error instanceof Error ? error.message : "保存提现设置失败");
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

  async function saveFaqContent() {
    try {
      setFaqSaving(true);
      const nextSettings = await apiFetch<PublicSiteSettings>("/api/admin/settings", {
        method: "POST",
        body: JSON.stringify({ faqContent: faqDraft, faqContentEn: faqDraftEn }),
      });
      setSettings(nextSettings);
      setFaqDraft(nextSettings.faqContent || "");
      setFaqDraftEn(nextSettings.faqContentEn || "");
      setFaqDirty(false);
      toast.success("常见问题已保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存常见问题失败");
    } finally {
      setFaqSaving(false);
    }
  }

  const setPremiumSaleEnabled = useCallback(async (enabled: boolean) => {
    const previous = settings;
    try {
      setPremiumSaleSaving(true);
      setSettings((current) => ({ ...current, premiumSaleEnabled: enabled }));
      const nextSettings = await apiFetch<PublicSiteSettings>("/api/admin/settings", {
        method: "POST",
        body: JSON.stringify({ premiumSaleEnabled: enabled }),
      });
      setSettings(nextSettings);
      if (!premiumPriceDirty) setPremiumPriceDraft(String(nextSettings.premiumPurchasePrice));
      toast.success(enabled ? "Premium 售卖已开启" : "Premium 售卖已关闭");
    } catch (error) {
      setSettings(previous);
      toast.error(error instanceof Error ? error.message : "保存 Premium 售卖设置失败");
    } finally {
      setPremiumSaleSaving(false);
    }
  }, [premiumPriceDirty, settings]);

  const savePremiumPurchasePrice = useCallback(async () => {
    const price = Number(premiumPriceDraft);
    if (!Number.isFinite(price) || price <= 0) {
      toast.error("Premium 售卖价格必须大于 0");
      return;
    }

    try {
      setPremiumSaleSaving(true);
      const nextSettings = await apiFetch<PublicSiteSettings>("/api/admin/settings", {
        method: "POST",
        body: JSON.stringify({ premiumPurchasePrice: price }),
      });
      setSettings(nextSettings);
      setPremiumPriceDraft(String(nextSettings.premiumPurchasePrice));
      setPremiumPriceDirty(false);
      toast.success("Premium 售卖价格已保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存 Premium 售卖价格失败");
    } finally {
      setPremiumSaleSaving(false);
    }
  }, [premiumPriceDraft]);

  const filteredUsers = users;

  const pendingWithdrawals = withdrawals.filter((item) => item.status === "PENDING");
  const pendingWithdrawalAmount = pendingWithdrawals.reduce((sum, item) => sum + item.totalFrozen, 0);
  const premiumUserCount = users.filter((user) => user.isPremium).length;

  function openPremiumDialog(user: AdminPublicUser, enabled: boolean) {
    setPremiumDialogUser(user);
    setPremiumDialogEnabled(enabled);
    setPremiumDialogTier(user.premiumTier === "premium_og" ? "premium_og" : "premium");
    setPremiumUntilInput(defaultPremiumDateValue(user.premiumUntil));
    setPremiumPermanent(!user.premiumUntil);
    setPremiumDialogOpen(true);
  }

  function openWithdrawalDialog(request: AdminPublicWithdrawalRequest, action: "paid" | "reject") {
    setWithdrawalDialogRequest(request);
    setWithdrawalDialogAction(action);
    setWithdrawalAdminNote(request.adminNote || "");
    setWithdrawalDialogOpen(true);
  }

  async function submitWithdrawalDialog() {
    if (!withdrawalDialogRequest) return;
    const adminNote = withdrawalAdminNote.trim();
    const endpoint = withdrawalDialogAction === "paid" ? "paid" : "reject";

    try {
      setWithdrawalSaving(true);
      setLoading(true);
      await apiFetch(`/api/admin/public-withdrawals/${withdrawalDialogRequest.id}/${endpoint}`, {
        method: "POST",
        body: JSON.stringify({ adminNote }),
      });
      toast.success(withdrawalDialogAction === "paid" ? "提现已标记为已支付" : "提现已拒绝并退回冻结余额");
      setWithdrawalDialogOpen(false);
      await refresh(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "处理提现申请失败");
    } finally {
      setWithdrawalSaving(false);
      setLoading(false);
    }
  }

  async function submitPremiumDialog() {
    if (!premiumDialogUser) return;
    let premiumUntil: string | null = null;

    if (premiumDialogEnabled) {
      const parsed = premiumPermanent ? null : parsePremiumDateValue(premiumUntilInput);
      if (parsed === undefined) {
        toast.error("Premium 有效期格式无效，请使用 YYYY-MM-DD");
        return;
      }
      if (parsed === null && !premiumPermanent) {
        toast.error("请选择 Premium 有效期，或开启永久有效");
        return;
      }
      premiumUntil = parsed;
    }

    try {
      setPremiumSaving(true);
      setLoading(true);
      await apiFetch(`/api/admin/public-users/${encodeURIComponent(premiumDialogUser.telegramUserId)}/premium`, {
        method: "POST",
        body: JSON.stringify({ enabled: premiumDialogEnabled, premiumUntil, premiumTier: premiumDialogTier }),
      });
      toast.success(premiumDialogEnabled ? "Premium 身份已更新" : "Premium 身份已取消");
      setPremiumDialogOpen(false);
      await refresh(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存 Premium 身份失败");
    } finally {
      setPremiumSaving(false);
      setLoading(false);
    }
  }

  return (
    <AppFrame audience="admin" title="用户管理" subtitle="管理公益站 Telegram 用户、钱包余额、提现申请和订单数据。" onRefresh={() => refresh()}>
      <div className="grid gap-4 xl:grid-cols-4">
        <MetricCard title="用户数量" value={summary.userCount} description={`已登录 / 已开钱包 Telegram 用户：${summary.walletCount ?? 0}`} icon={UsersRoundIcon} tone="brand" />
        <MetricCard title="可用余额" value={formatUsdt(summary.availableBalance)} description="用户钱包当前可用余额合计" icon={WalletIcon} tone="success" />
        <MetricCard title="冻结余额" value={formatUsdt(summary.frozenBalance)} description="提现和扫码订单冻结金额合计" icon={WalletIcon} tone="warning" />
        <MetricCard title="Premium 用户" value={premiumUserCount} description={`待处理提现 ${pendingWithdrawals.length} / ${formatUsdt(pendingWithdrawalAmount)}`} icon={CrownIcon} tone="info" />
      </div>

      <Tabs
        value={activeSection}
        onValueChange={(value) => setActiveSection(value as AdminUsersSection)}
        className="mt-4 gap-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList className="flex w-full flex-wrap justify-start rounded-2xl p-1 sm:w-auto">
            <TabsTrigger value="users" className="min-w-32">
              用户列表 {pagination?.total ?? users.length}
            </TabsTrigger>
            <TabsTrigger value="withdrawals" className="min-w-32">
              提现申请 {withdrawalPagination?.total ?? withdrawals.length}
            </TabsTrigger>
            <TabsTrigger value="settings" className="min-w-28">
              配置
            </TabsTrigger>
          </TabsList>
          <Button variant="outline" size="sm" onClick={() => refresh()} disabled={loading}>
            刷新
          </Button>
        </div>

        <TabsContent value="users">
      <Card className="rounded-3xl bg-background shadow-sm">
        <CardHeader>
          <CardTitle>用户列表</CardTitle>
          <CardDescription>按 Telegram 账户聚合用户、钱包、提取次数、扫码订单和账本数据。</CardDescription>
          <CardAction>
            <div className="relative w-72 max-w-full">
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="搜索 TG ID / 用户名" className="pl-9" />
            </div>
          </CardAction>
        </CardHeader>
        <CardContent>
          <div className="overflow-hidden rounded-3xl border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>用户</TableHead>
                  <TableHead>身份</TableHead>
                  <TableHead>充值签署</TableHead>
                  <TableHead>钱包</TableHead>
                  <TableHead>数据</TableHead>
                  <TableHead>提现</TableHead>
                  <TableHead>时间</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredUsers.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell>
                      <div className="font-semibold">{user.telegramUsername ? `@${user.telegramUsername}` : user.telegramUserId}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs text-muted-foreground">{user.telegramUserId}</span>
                        <Badge variant={user.hasWallet ? "default" : "outline"}>{user.hasWallet ? "已开钱包" : "未开钱包"}</Badge>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={user.isPremium ? "default" : user.premiumExpired ? "destructive" : "outline"}>
                          {user.isPremium ? premiumTierLabel(user.premiumTier) : user.premiumExpired ? `${premiumTierLabel(user.premiumTier)} 已过期` : "普通"}
                        </Badge>
                        {user.premiumSource === "default" && <Badge variant="secondary">默认</Badge>}
                      </div>
                      {(user.premiumEnabled || user.premiumUntil) && (
                        <div className="mt-1 text-xs text-muted-foreground">
                          有效期：{formatPremiumUntil(user.premiumUntil)}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={user.depositRiskSigned ? "default" : "outline"}>
                        {user.depositRiskSigned ? "已签署" : "未签署"}
                      </Badge>
                      {user.depositRiskSignedAt && (
                        <div className="mt-1 text-xs text-muted-foreground">
                          {formatDateTime(user.depositRiskSignedAt)}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="text-sm">可用 <span className="font-semibold">{formatUsdt(user.availableBalance)}</span></div>
                      <div className="text-xs text-muted-foreground">冻结 {formatUsdt(user.frozenBalance)}</div>
                      <div className="text-xs text-muted-foreground">充值 {formatUsdt(user.totalDeposited)} / 消费 {formatUsdt(user.totalSpent)}</div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-2">
                        <Badge variant="secondary">提取 {user.extractCount}</Badge>
                        <Badge variant="secondary">扫码单 {user.scanOrderCount}</Badge>
                        <Badge variant="outline">账本 {user.ledgerCount}</Badge>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="text-sm">提现 {user.withdrawalCount}</div>
                      <div className="text-xs text-muted-foreground">待处理 {user.pendingWithdrawalCount} / {formatUsdt(user.pendingWithdrawalAmount)}</div>
                    </TableCell>
                    <TableCell>
                      <div className="text-sm">{formatDateTime(user.createdAt)}</div>
                      <div className="text-xs text-muted-foreground">更新 {formatDateTime(user.updatedAt)}</div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="outline" onClick={() => openPremiumDialog(user, true)} disabled={loading}>
                          <CrownIcon data-icon="inline-start" />{user.isPremium ? "续期" : "开通"}
                        </Button>
                        {(user.premiumEnabled || user.isPremium) && (
                          <Button size="sm" variant="ghost" onClick={() => openPremiumDialog(user, false)} disabled={loading}>取消</Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {filteredUsers.length === 0 && <TableRow><TableCell colSpan={8} className="h-32 text-center text-muted-foreground">暂无用户</TableCell></TableRow>}
              </TableBody>
            </Table>
          </div>
          <AdminListPagination pagination={pagination} loading={loading} onPageChange={setPage} className="mt-4" />
        </CardContent>
      </Card>
        </TabsContent>

        <TabsContent value="withdrawals">
      <Card className="rounded-3xl bg-background shadow-sm">
        <CardHeader>
          <CardTitle>提现申请</CardTitle>
          <CardDescription>用户提交 BEP20 / BSC USDT 提现申请，手续费 0.01 USDT。确认链上转账后标记为已支付；拒绝会退回冻结余额。</CardDescription>
          <CardAction>{pendingWithdrawals.length} 待处理</CardAction>
        </CardHeader>
        <CardContent>
          <div className="mb-3 flex items-center gap-2">
            <SearchIcon className="size-4 text-muted-foreground" />
            <Input value={withdrawalSearch} onChange={(event) => { setWithdrawalSearch(event.target.value); setWithdrawalPage(1); }} placeholder="搜索 TG / 地址 / 备注" />
          </div>
          <div className="overflow-hidden rounded-3xl border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>用户</TableHead>
                  <TableHead>金额</TableHead>
                  <TableHead>提现地址</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>时间</TableHead>
                  <TableHead>备注</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {withdrawals.map((request) => (
                  <TableRow key={request.id}>
                    <TableCell>
                      <div className="font-semibold">{request.telegramUsername ? `@${request.telegramUsername}` : request.telegramUserId}</div>
                      <div className="font-mono text-xs text-muted-foreground">{request.telegramUserId}</div>
                    </TableCell>
                    <TableCell>
                      <div className="font-semibold">{formatUsdt(request.amount)}</div>
                      <div className="text-xs text-muted-foreground">手续费 {formatUsdt(request.fee)} / 冻结 {formatUsdt(request.totalFrozen)}</div>
                    </TableCell>
                    <TableCell>
                      <button type="button" className="font-mono text-xs underline-offset-4 hover:underline" title={request.withdrawalAddress} onClick={() => copyText(request.withdrawalAddress)}>
                        {shortAddress(request.withdrawalAddress)}
                      </button>
                      <div className="text-xs text-muted-foreground">{request.chain} / {request.tokenSymbol}</div>
                    </TableCell>
                    <TableCell><Badge variant={withdrawalStatusVariant(request.status)}>{withdrawalStatusText(request.status)}</Badge></TableCell>
                    <TableCell>
                      <div className="text-sm">{formatDateTime(request.requestedAt)}</div>
                      {request.processedAt && <div className="text-xs text-muted-foreground">处理 {formatDateTime(request.processedAt)}</div>}
                    </TableCell>
                    <TableCell className="max-w-[260px]">
                      <div className="truncate text-sm">{request.note || "-"}</div>
                      {request.adminNote && <div className="truncate text-xs text-muted-foreground">Admin: {request.adminNote}</div>}
                    </TableCell>
                    <TableCell className="text-right">
                      {request.status === "PENDING" ? (
                        <div className="flex justify-end gap-2">
                          <Button size="sm" onClick={() => openWithdrawalDialog(request, "paid")} disabled={loading}>
                            <CheckCircle2Icon data-icon="inline-start" />标记已支付
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => openWithdrawalDialog(request, "reject")} disabled={loading}>
                            <XCircleIcon data-icon="inline-start" />拒绝
                          </Button>
                        </div>
                      ) : (
                        <span className="text-sm text-muted-foreground">{request.processedBy || "-"}</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {withdrawals.length === 0 && <TableRow><TableCell colSpan={7} className="h-32 text-center text-muted-foreground">暂无提现申请</TableCell></TableRow>}
              </TableBody>
            </Table>
          </div>
          <AdminListPagination pagination={withdrawalPagination} loading={loading} onPageChange={setWithdrawalPage} className="mt-4" />
        </CardContent>
      </Card>
        </TabsContent>

        <TabsContent value="settings" className="flex flex-col gap-4">
          <Card className="rounded-3xl bg-background shadow-sm">
            <CardHeader>
              <CardTitle>提取功能设置</CardTitle>
              <CardDescription>控制用户侧是否显示渠道选择和自定义代理。关闭后前台不显示入口，后端也会强制默认 UPI 或忽略用户代理参数。</CardDescription>
              <CardAction><UsersRoundIcon className="size-5 text-muted-foreground" /></CardAction>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-col gap-3 rounded-2xl border border-border bg-muted/30 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="font-medium">显示提取渠道选择</div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    当前状态：{settings.extractMethodSelectionEnabled ? "已开启" : "已关闭"}。关闭后用户侧默认 UPI 渠道，不显示 IDEAL/UPI 选择。
                  </div>
                </div>
                <Switch checked={settings.extractMethodSelectionEnabled} onCheckedChange={setExtractMethodSelectionEnabled} disabled={loading} />
              </div>
              <div className="flex flex-col gap-3 rounded-2xl border border-border bg-muted/30 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="font-medium">允许用户自定义代理</div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    当前状态：{settings.customProxyEnabled ? "已开启" : "已关闭"}。关闭后用户侧隐藏自定义 checkout/provider 代理，后端也不会接收用户代理参数。
                  </div>
                </div>
                <Switch checked={settings.customProxyEnabled} onCheckedChange={setCustomProxyEnabled} disabled={loading} />
              </div>
            </CardContent>
          </Card>

          <Card className="rounded-3xl bg-background shadow-sm">
            <CardHeader>
              <CardTitle>钱包功能设置</CardTitle>
              <CardDescription>控制 UPI 提取页用户钱包的充值和提现入口；关闭入口不会影响已有订单和历史记录。</CardDescription>
              <CardAction><WalletIcon className="size-5 text-muted-foreground" /></CardAction>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-col gap-3 rounded-2xl border border-border bg-muted/30 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="font-medium">开启用户充值</div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    当前状态：{settings.depositEnabled ? "已开启" : "已关闭"}。关闭期间不影响已有充值订单和余额刷新。
                  </div>
                </div>
                <Switch checked={settings.depositEnabled} onCheckedChange={setDepositEnabled} disabled={loading} />
              </div>
              <div className="flex flex-col gap-3 rounded-2xl border border-border bg-muted/30 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="font-medium">显示用户提现入口</div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    当前状态：{settings.withdrawEnabled ? "已显示" : "已隐藏"}。隐藏后用户侧不显示提现按钮，后端也会拒绝新提现申请。
                  </div>
                </div>
                <Switch checked={settings.withdrawEnabled} onCheckedChange={setWithdrawEnabled} disabled={loading} />
              </div>
            </CardContent>
          </Card>

          <Card className="rounded-3xl bg-background shadow-sm">
            <CardHeader>
              <CardTitle>常见问题配置</CardTitle>
              <CardDescription>分别配置公开提取页中英文“常见问题”内容，前台会根据用户当前界面语言显示。</CardDescription>
              <CardAction>FAQ</CardAction>
            </CardHeader>
            <CardContent>
              <Tabs value={faqLang} onValueChange={(value) => setFaqLang(value as "zh" | "en")} className="gap-3">
                <TabsList className="rounded-2xl p-1">
                  <TabsTrigger value="zh" className="min-w-24">中文</TabsTrigger>
                  <TabsTrigger value="en" className="min-w-24">English</TabsTrigger>
                </TabsList>
                <TabsContent value="zh">
                  <Textarea
                    value={faqDraft}
                    onChange={(event) => {
                      setFaqDraft(event.target.value);
                      setFaqDirty(true);
                    }}
                    rows={8}
                    className="min-h-40"
                    placeholder={"Q: 应该转账多少？\nA: ..."}
                  />
                </TabsContent>
                <TabsContent value="en">
                  <Textarea
                    value={faqDraftEn}
                    onChange={(event) => {
                      setFaqDraftEn(event.target.value);
                      setFaqDirty(true);
                    }}
                    rows={8}
                    className="min-h-40"
                    placeholder={"Q: What amount should I transfer?\nA: ..."}
                  />
                </TabsContent>
              </Tabs>
              <div className="mt-3 flex justify-end">
                <Button type="button" onClick={() => void saveFaqContent()} disabled={loading || faqSaving || !faqDirty}>
                  {faqSaving ? "保存中..." : "保存常见问题"}
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card className="rounded-3xl bg-background shadow-sm">
            <CardHeader>
              <CardTitle>Premium 售卖设置</CardTitle>
              <CardDescription>控制用户自助购买长期 Premium 的入口和扣款价格；关闭售卖不影响已开通用户、免费体验或管理员手动开通。</CardDescription>
              <CardAction><CrownIcon className="size-5 text-muted-foreground" /></CardAction>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-4 rounded-2xl border border-border bg-muted/30 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="font-medium">开启 Premium 自助售卖</div>
                    <div className="mt-1 text-sm text-muted-foreground">
                      当前状态：{settings.premiumSaleEnabled ? "已开启" : "已关闭"}。关闭后用户侧购买按钮会禁用，后端也会拒绝购买请求。
                    </div>
                  </div>
                  <Switch checked={settings.premiumSaleEnabled} onCheckedChange={setPremiumSaleEnabled} disabled={loading || premiumSaleSaving} />
                </div>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <Label htmlFor="premium-purchase-price">长期 Premium 售价（USDT）</Label>
                    <Input
                      id="premium-purchase-price"
                      type="number"
                      min={0.000001}
                      step="0.1"
                      value={premiumPriceDraft}
                      onChange={(event) => {
                        setPremiumPriceDraft(event.target.value);
                        setPremiumPriceDirty(true);
                      }}
                      disabled={loading || premiumSaleSaving}
                      className="mt-2 max-w-xs"
                    />
                    <div className="mt-1 text-xs text-muted-foreground">当前生效价格：{formatUsdt(settings.premiumPurchasePrice)}</div>
                  </div>
                  <Button type="button" onClick={() => void savePremiumPurchasePrice()} disabled={loading || premiumSaleSaving || !premiumPriceDirty}>
                    {premiumSaleSaving ? "保存中..." : "保存价格"}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={withdrawalDialogOpen} onOpenChange={(open) => {
        if (!open && withdrawalSaving) return;
        setWithdrawalDialogOpen(open);
      }}>
        <DialogContent className="w-[min(94vw,560px)] max-w-[min(94vw,560px)] rounded-3xl p-5 sm:max-w-[min(94vw,560px)]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-lg">
              {withdrawalDialogAction === "paid" ? (
                <CheckCircle2Icon className="size-5 text-emerald-600" />
              ) : (
                <XCircleIcon className="size-5 text-destructive" />
              )}
              {withdrawalDialogAction === "paid" ? "确认提现已支付" : "拒绝提现申请"}
            </DialogTitle>
            <DialogDescription>
              {withdrawalDialogAction === "paid"
                ? "确认你已经完成链上转账后，再将该提现申请标记为已支付。"
                : "拒绝后会自动退回用户冻结余额，并保留管理员备注。"}
            </DialogDescription>
          </DialogHeader>

          {withdrawalDialogRequest && (
            <div className="space-y-4">
              <div className="rounded-3xl border border-border bg-muted/30 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <div className="text-sm text-muted-foreground">申请用户</div>
                    <div className="mt-1 text-base font-semibold">
                      {withdrawalDialogRequest.telegramUsername ? `@${withdrawalDialogRequest.telegramUsername}` : withdrawalDialogRequest.telegramUserId}
                    </div>
                    <div className="mt-1 font-mono text-xs text-muted-foreground">{withdrawalDialogRequest.telegramUserId}</div>
                  </div>
                  <Badge variant={withdrawalStatusVariant(withdrawalDialogRequest.status)}>
                    {withdrawalStatusText(withdrawalDialogRequest.status)}
                  </Badge>
                </div>

                <div className="mt-4 grid gap-3 rounded-2xl bg-background/70 p-3 text-sm sm:grid-cols-2">
                  <div>
                    <div className="text-muted-foreground">到账金额</div>
                    <div className="mt-1 font-medium">{formatUsdt(withdrawalDialogRequest.amount)}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">手续费 / 冻结</div>
                    <div className="mt-1 font-medium">{formatUsdt(withdrawalDialogRequest.fee)} / {formatUsdt(withdrawalDialogRequest.totalFrozen)}</div>
                  </div>
                  <div className="sm:col-span-2">
                    <div className="text-muted-foreground">提现地址</div>
                    <button
                      type="button"
                      className="mt-1 break-all font-mono text-xs underline-offset-4 hover:underline"
                      onClick={() => copyText(withdrawalDialogRequest.withdrawalAddress)}
                    >
                      {withdrawalDialogRequest.withdrawalAddress}
                    </button>
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="withdrawal-admin-note">
                  {withdrawalDialogAction === "paid" ? "交易哈希 / 管理员备注" : "拒绝原因"}
                </Label>
                <Textarea
                  id="withdrawal-admin-note"
                  value={withdrawalAdminNote}
                  onChange={(event) => setWithdrawalAdminNote(event.target.value)}
                  placeholder={withdrawalDialogAction === "paid" ? "可填写链上交易哈希，方便后续核对" : "可填写拒绝原因，便于后续追踪"}
                  className="min-h-24 resize-none"
                  disabled={withdrawalSaving}
                />
              </div>

              {withdrawalDialogAction === "reject" && (
                <div className="rounded-2xl border border-destructive/20 bg-destructive/5 p-3 text-sm text-muted-foreground">
                  拒绝后会退回冻结金额 {formatUsdt(withdrawalDialogRequest.totalFrozen)} 到用户可用余额。
                </div>
              )}
            </div>
          )}

          <DialogFooter className="-mx-5 -mb-5">
            <Button type="button" variant="outline" onClick={() => setWithdrawalDialogOpen(false)} disabled={withdrawalSaving}>
              取消
            </Button>
            <Button
              type="button"
              variant={withdrawalDialogAction === "paid" ? "default" : "destructive"}
              onClick={() => void submitWithdrawalDialog()}
              disabled={!withdrawalDialogRequest || withdrawalSaving}
            >
              {withdrawalDialogAction === "paid" ? <CheckCircle2Icon data-icon="inline-start" /> : <XCircleIcon data-icon="inline-start" />}
              {withdrawalSaving ? "处理中..." : withdrawalDialogAction === "paid" ? "确认已支付" : "确认拒绝"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={premiumDialogOpen} onOpenChange={(open) => {
        if (!open && premiumSaving) return;
        setPremiumDialogOpen(open);
      }}>
        <DialogContent className="w-[min(94vw,560px)] max-w-[min(94vw,560px)] rounded-3xl p-5 sm:max-w-[min(94vw,560px)]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-lg">
              <CrownIcon className="size-5 text-primary" />
              修改用户身份
            </DialogTitle>
            <DialogDescription>
              为 Telegram 用户开通、续期或取消 Premium 身份。
            </DialogDescription>
          </DialogHeader>

          {premiumDialogUser && (
            <div className="space-y-4">
              <div className="rounded-3xl border border-border bg-muted/30 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <div className="text-sm text-muted-foreground">当前用户</div>
                    <div className="mt-1 text-base font-semibold">
                      {premiumDialogUser.telegramUsername ? `@${premiumDialogUser.telegramUsername}` : premiumDialogUser.telegramUserId}
                    </div>
                    <div className="mt-1 font-mono text-xs text-muted-foreground">{premiumDialogUser.telegramUserId}</div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant={premiumDialogUser.isPremium ? "default" : premiumDialogUser.premiumExpired ? "destructive" : "outline"}>
                      {premiumDialogUser.isPremium ? premiumTierLabel(premiumDialogUser.premiumTier) : premiumDialogUser.premiumExpired ? `${premiumTierLabel(premiumDialogUser.premiumTier)} 已过期` : "普通"}
                    </Badge>
                    {premiumDialogUser.premiumSource === "default" && <Badge variant="secondary">默认</Badge>}
                    <Badge variant={premiumDialogUser.hasWallet ? "default" : "outline"}>
                      {premiumDialogUser.hasWallet ? "已开钱包" : "未开钱包"}
                    </Badge>
                  </div>
                </div>
                <div className="mt-4 grid gap-3 rounded-2xl bg-background/70 p-3 text-sm sm:grid-cols-2">
                  <div>
                    <div className="text-muted-foreground">当前有效期</div>
                    <div className="mt-1 font-medium">{formatPremiumUntil(premiumDialogUser.premiumUntil)}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">可用余额</div>
                    <div className="mt-1 font-medium">{formatUsdt(premiumDialogUser.availableBalance)}</div>
                  </div>
                </div>
              </div>

              {premiumDialogEnabled ? (
                <div className="space-y-4 rounded-3xl border border-primary/20 bg-primary/5 p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="font-medium">开通 / 续期 Premium</div>
                      <div className="mt-1 text-sm text-muted-foreground">
                        选择永久有效，或指定当天 23:59:59 后过期。
                      </div>
                    </div>
                    <Badge variant="secondary">{premiumTierLabel(premiumDialogTier)}</Badge>
                  </div>

                  <div className="rounded-2xl bg-background/80 p-3">
                    <div className="mb-2 text-sm font-medium">身份名称</div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant={premiumDialogTier === "premium" ? "default" : "outline"}
                        onClick={() => setPremiumDialogTier("premium")}
                        disabled={premiumSaving}
                      >
                        Premium
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={premiumDialogTier === "premium_og" ? "default" : "outline"}
                        onClick={() => setPremiumDialogTier("premium_og")}
                        disabled={premiumSaving}
                      >
                        Premium OG
                      </Button>
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">
                      Premium OG 与 Premium 权益完全一致，只改变展示身份名称。
                    </p>
                  </div>

                  <div className="flex items-center justify-between gap-4 rounded-2xl bg-background/80 p-3">
                    <Label htmlFor="premium-permanent" className="flex flex-col items-start gap-1">
                      <span>永久有效</span>
                      <span className="text-xs font-normal text-muted-foreground">开启后不设置到期时间。</span>
                    </Label>
                    <Switch id="premium-permanent" checked={premiumPermanent} onCheckedChange={setPremiumPermanent} disabled={premiumSaving} />
                  </div>

                  {!premiumPermanent && (
                    <div className="space-y-2">
                      <Label htmlFor="premium-until">Premium 到期日期</Label>
                      <Input
                        id="premium-until"
                        type="date"
                        value={premiumUntilInput}
                        onChange={(event) => setPremiumUntilInput(event.target.value)}
                        disabled={premiumSaving}
                      />
                      <p className="text-xs text-muted-foreground">
                        例如 2026-12-31，保存后会按 Asia/Shanghai 当天结束时间计算。
                      </p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="rounded-3xl border border-destructive/20 bg-destructive/5 p-4">
                  <div className="flex items-start gap-3">
                    <XCircleIcon className="mt-0.5 size-5 text-destructive" />
                    <div>
                      <div className="font-medium text-destructive">确认取消 Premium 身份？</div>
                      <div className="mt-1 text-sm text-muted-foreground">
                        保存后该用户会恢复为普通用户，Premium 通道和自动重试等专属能力将立即失效。
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          <DialogFooter className="-mx-5 -mb-5">
            <Button type="button" variant="outline" onClick={() => setPremiumDialogOpen(false)} disabled={premiumSaving}>
              取消
            </Button>
            <Button
              type="button"
              variant={premiumDialogEnabled ? "default" : "destructive"}
              onClick={() => void submitPremiumDialog()}
              disabled={!premiumDialogUser || premiumSaving}
            >
              {premiumDialogEnabled ? <CrownIcon data-icon="inline-start" /> : <XCircleIcon data-icon="inline-start" />}
              {premiumSaving ? "保存中..." : premiumDialogEnabled ? "保存身份" : "确认取消"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppFrame>
  );
}
