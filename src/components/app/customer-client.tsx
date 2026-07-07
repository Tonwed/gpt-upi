"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  CopyIcon,
  ExternalLinkIcon,
  Globe2Icon,
  KeyRoundIcon,
  Loader2Icon,
  RotateCcwIcon,
  SendIcon,
  ShieldCheckIcon,
  UsersRoundIcon,
  XCircleIcon,
} from "lucide-react";
import { toast } from "sonner";
import { OrderStatusBadge } from "@/components/app/status-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch } from "@/lib/api-client";
import { normalizeCdkCode } from "@/lib/cdk-code";
import { cn } from "@/lib/utils";
import type { PublicCdk, PublicOrder } from "@/lib/types/app";

const CDK_SESSION_KEY = "gpt_upi_customer_cdk";
const ORDER_SESSION_KEY = "gpt_upi_customer_order";
const ORDER_TOKEN_SESSION_KEY = "gpt_upi_customer_order_token";
const LANG_STORAGE_KEY = "gpt_upi_lang";
const AUTH_SESSION_URL = "https://chatgpt.com/api/auth/session";
const activeStatuses = new Set(["PENDING", "ASSIGNED", "CHECKING"]);

type Lang = "zh" | "en";
type CustomerView = "submit" | "orders";
type TokenStatus = "idle" | "checking" | "valid" | "bound" | "error";
type CdkMessage =
  | { type: "prompt" }
  | { type: "input" }
  | { type: "noRemaining" }
  | { type: "bound"; count: number }
  | { type: "error"; message: string };

const COPY = {
  zh: {
    titlePrefix: "UPI",
    titleSuffix: "Scanner",
    tagline: "提交未绑定邮箱的 ChatGPT session token，接单方会在后台生成 UPI 二维码。",
    tokenTitle: "Session Token",
    submitView: "提交订单",
    ordersView: "订单列表",
    tokenDesc: "粘贴 ChatGPT session token、session cookie 或 session JSON。系统只会加密保存，接单方无法查看。",
    tokenGuideTitle: "如何获取 Session Token",
    tokenGuideLoginPrefix: "1. 在浏览器打开",
    tokenGuideLoginSuffix: "并登录需要提取的账号。",
    tokenGuideOpen: "2. 打开 session 页面后，复制页面里显示的全部内容并粘贴到下方。",
    copySessionUrl: "复制 session 地址",
    copySessionUrlSuccess: "session 地址已复制",
    copySessionUrlFailed: "复制失败，请手动复制地址",
    tokenPlaceholder: "粘贴 session token / Cookie / Session JSON",
    checkToken: "校验 Token",
    tokenPrompt: "提交前需要确认该账号没有绑定邮箱。",
    tokenChecking: "正在校验 session token…",
    tokenValid: "校验通过：未检测到绑定邮箱，可以提交订单。",
    tokenBound: "该账号已绑定邮箱，无法提取 UPI 链接。请更换未绑定邮箱的账号。",
    tokenError: "session token 校验失败，请检查内容是否完整。",
    tokenSecretHint: "Token 会被服务端加密保存；worker 只能看到订单号和生成后的二维码。",
    noWorkerWarning: "当前暂无工作人员在线。你仍可提交订单，订单会先进入等待队列；工作人员上线后会看到并处理。未被接单前，你可以随时取消。",
    orderTitle: "当前订单",
    orderListTitle: "订单列表",
    orderListDesc: "绑定 CDK 后会显示该 CDK 下的订单历史，刷新页面后也会自动重新获取。",
    activeOrdersTitle: "进行中",
    historyOrdersTitle: "历史记录",
    localHistoryHint: "订单历史来自当前绑定 CDK，不依赖浏览器本地记录。",
    noActiveOrders: "暂无进行中的订单",
    noCdkOrders: "请先在提交订单界面绑定 CDK，然后这里会显示该 CDK 的订单历史。",
    noOrder: "还没有提交订单",
    orderPendingHint: "订单等待接单中，未被接单前可随时取消。",
    orderAssignedHint: "订单已被接单，正在等待工作人员生成 UPI 二维码。",
    orderReadyHint: "UPI 二维码已生成，等待工作人员处理完成。",
    orderCheckingHint: "工作人员已提交完成，系统正在检测账号订阅是否已更新为 Plus。",
    orderFailedHint: "UPI 二维码生成失败，工作人员可能会退回订单。",
    orderReturnedHint: "订单已退回，冻结次数已返还。你可以更换 session token 后重新提交。",
    orderCompletedHint: "订单已完成。",
    orderCancelledHint: "订单已取消，冻结次数已返还。",
    orderExpiredHint: "订单已过期。",
    orderGenericFailedHint: "订单失败，冻结次数已返还。",
    updatedAt: "更新时间：",
    cancel: "取消订单",
    refreshStatus: "刷新状态",
    submitOrder: "提交订单",
    cdkTitle: "填写 CDK",
    cdkPlaceholder: "请输入 CDK",
    bindCdk: "校验并绑定",
    cdkPrompt: "请输入 CDK 并校验",
    cdkInput: "请输入 CDK",
    cdkNoRemaining: "该 CDK 已无剩余次数，请更换 CDK",
    cdkBound: (count: number) => `已绑定本次会话，剩余 ${count} 次`,
    cdkCurrent: (code: string, count: number) => `当前 CDK：${code}，剩余 ${count} 次`,
    cdkEmptyHint: "无剩余次数时请更换 CDK",
    onlineWorkers: "当前在线工作人员",
    joinTg: "添加 TG 群",
    switchLanguage: "EN",
    tokenEmptyToast: "请先粘贴 session token",
    tokenValidToast: "Token 校验通过",
    cdkNoRemainingToast: "CDK 已无剩余次数",
    cdkBoundToast: "CDK 已绑定本次会话",
    cdkCheckFailed: "CDK 校验失败",
    noWorkerToast: "当前暂无工作人员在线，订单会先进入等待队列",
    submitSuccess: "订单已提交，正在等待接单",
    submitFailed: "提交失败",
    refreshSuccess: "状态已刷新",
    refreshFailed: "刷新失败",
    cancelSuccess: "订单已取消，冻结次数已退回",
    alreadyEnded: "订单此前已结束",
    cancelFailed: "取消失败",
  },
  en: {
    titlePrefix: "UPI",
    titleSuffix: "Scanner",
    tagline: "Submit an unbound ChatGPT session token. Workers generate the UPI QR in the background.",
    tokenTitle: "Session Token",
    submitView: "Submit",
    ordersView: "Orders",
    tokenDesc: "Paste a ChatGPT session token, session cookie, or session JSON. It is encrypted; workers cannot view it.",
    tokenGuideTitle: "How to get the Session Token",
    tokenGuideLoginPrefix: "1. Open",
    tokenGuideLoginSuffix: "in your browser and sign in to the target account.",
    tokenGuideOpen: "2. Open the session page, copy all content shown there, then paste it below.",
    copySessionUrl: "Copy session URL",
    copySessionUrlSuccess: "Session URL copied",
    copySessionUrlFailed: "Copy failed. Please copy the URL manually.",
    tokenPlaceholder: "Paste session token / cookie / session JSON",
    checkToken: "Check token",
    tokenPrompt: "Before submitting, the account must be verified as not email-bound.",
    tokenChecking: "Checking session token…",
    tokenValid: "Check passed: no bound email was detected. You may submit the order.",
    tokenBound: "This account already has a bound email, so UPI link extraction is not allowed.",
    tokenError: "Session token check failed. Please make sure the content is complete.",
    tokenSecretHint: "The token is encrypted on the server. Workers only see the order number and generated QR.",
    noWorkerWarning: "No workers are online right now. You can still submit the order; it will wait in the queue. You may cancel it anytime before a worker accepts it.",
    orderTitle: "Current order",
    orderListTitle: "Order list",
    orderListDesc: "After binding a CDK, this list shows the order history under that CDK.",
    activeOrdersTitle: "Active",
    historyOrdersTitle: "History",
    localHistoryHint: "Order history is loaded from the currently bound CDK, not local browser history.",
    noActiveOrders: "No active orders",
    noCdkOrders: "Bind a CDK on the submit page first, then this page will show that CDK's order history.",
    noOrder: "No order yet",
    orderPendingHint: "Waiting for a worker. You can cancel before it is accepted.",
    orderAssignedHint: "Accepted by a worker. Waiting for UPI QR generation.",
    orderReadyHint: "UPI QR has been generated. Waiting for worker completion.",
    orderCheckingHint: "The worker marked it complete. The system is checking whether the account is now Plus.",
    orderFailedHint: "UPI QR generation failed. The worker may return the order.",
    orderReturnedHint: "The order was returned and the frozen use has been released. You may submit a new session token.",
    orderCompletedHint: "The order is completed.",
    orderCancelledHint: "The order was cancelled and the frozen use has been returned.",
    orderExpiredHint: "The order has expired.",
    orderGenericFailedHint: "The order failed and the frozen use has been returned.",
    updatedAt: "Updated: ",
    cancel: "Cancel order",
    refreshStatus: "Refresh status",
    submitOrder: "Submit order",
    cdkTitle: "Enter CDK",
    cdkPlaceholder: "Enter CDK",
    bindCdk: "Check and bind",
    cdkPrompt: "Enter a CDK and check it",
    cdkInput: "Enter a CDK",
    cdkNoRemaining: "No remaining uses. Please use another CDK.",
    cdkBound: (count: number) => `Bound to this session. ${count} use(s) remaining.`,
    cdkCurrent: (code: string, count: number) => `Current CDK: ${code}, ${count} use(s) remaining`,
    cdkEmptyHint: "Use another CDK if this one has no remaining uses.",
    onlineWorkers: "Online workers",
    joinTg: "Join TG group",
    switchLanguage: "中文",
    tokenEmptyToast: "Paste a session token first",
    tokenValidToast: "Token check passed",
    cdkNoRemainingToast: "This CDK has no remaining uses",
    cdkBoundToast: "CDK bound to this session",
    cdkCheckFailed: "CDK check failed",
    noWorkerToast: "No workers are online; the order will wait in the queue",
    submitSuccess: "Order submitted. Waiting for a worker.",
    submitFailed: "Submit failed",
    refreshSuccess: "Status refreshed",
    refreshFailed: "Refresh failed",
    cancelSuccess: "Cancelled. The frozen use has been returned.",
    alreadyEnded: "The order had already ended",
    cancelFailed: "Cancel failed",
  },
} as const;

export function CustomerClient() {
  const [lang, setLang] = useState<Lang>("zh");
  const [code, setCode] = useState("");
  const [cdk, setCdk] = useState<PublicCdk | null>(null);
  const [cdkMessage, setCdkMessage] = useState<CdkMessage>({ type: "prompt" });
  const [sessionToken, setSessionToken] = useState("");
  const [view, setView] = useState<CustomerView>("submit");
  const [tokenStatus, setTokenStatus] = useState<TokenStatus>("idle");
  const [tokenMessage, setTokenMessage] = useState("");
  const [orders, setOrders] = useState<PublicOrder[]>([]);
  const [onlineWorkers, setOnlineWorkers] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const hasLoadedSession = useRef(false);
  const ordersRef = useRef<PublicOrder[]>([]);

  const copy = COPY[lang];
  const cdkCode = cdk?.code || "";
  const activeOrders = useMemo(() => orders.filter((item) => activeStatuses.has(String(item.status).toUpperCase())), [orders]);
  const finishedOrders = useMemo(() => orders.filter((item) => !activeStatuses.has(String(item.status).toUpperCase())), [orders]);
  const activeOrderIdsKey = useMemo(() => activeOrders.map((item) => item.id).join("|"), [activeOrders]);
  const hasKnownNoOnlineWorkers = onlineWorkers === 0;
  const cdkMessageText = useMemo(() => getCdkMessageText(cdkMessage, copy), [cdkMessage, copy]);
  const tokenStatusText = tokenMessage || getTokenStatusText(tokenStatus, copy);
  const canSubmit = Boolean(cdk && cdk.availableCount > 0 && sessionToken.trim() && tokenStatus === "valid");

  const commitOrders = useCallback((nextOrders: PublicOrder[]) => {
    const sortedOrders = sortCustomerOrders(nextOrders);

    ordersRef.current = sortedOrders;
    setOrders(sortedOrders);

    const primaryActive = sortedOrders.find((item) => activeStatuses.has(String(item.status).toUpperCase())) ?? sortedOrders[0];
    if (primaryActive) {
      window.sessionStorage.setItem(ORDER_SESSION_KEY, primaryActive.id);
    } else {
      window.sessionStorage.removeItem(ORDER_SESSION_KEY);
    }
  }, []);

  const upsertOrder = useCallback((nextOrder: PublicOrder) => {
    if (nextOrder.customerToken) {
      window.sessionStorage.setItem(ORDER_SESSION_KEY, nextOrder.id);
      window.sessionStorage.setItem(ORDER_TOKEN_SESSION_KEY, nextOrder.customerToken);
    }
    const merged = [nextOrder, ...ordersRef.current.filter((item) => item.id !== nextOrder.id)];
    commitOrders(merged);
  }, [commitOrders]);

  const getCustomerOrderHeaders = useCallback((nextOrderId: string) => {
    const token = window.sessionStorage.getItem(ORDER_SESSION_KEY) === nextOrderId
      ? window.sessionStorage.getItem(ORDER_TOKEN_SESSION_KEY)
      : null;
    const headers: Record<string, string> = {};
    if (token) headers["x-customer-order-token"] = token;
    if (cdkCode) headers["x-customer-cdk-code"] = cdkCode;
    return Object.keys(headers).length > 0 ? headers : undefined;
  }, [cdkCode]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const saved = window.localStorage.getItem(LANG_STORAGE_KEY);
      if (saved === "zh" || saved === "en") setLang(saved);
      else setLang(window.navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en");
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const toggleLanguage = useCallback(() => {
    setLang((current) => {
      const next = current === "zh" ? "en" : "zh";
      window.localStorage.setItem(LANG_STORAGE_KEY, next);
      return next;
    });
  }, []);

  const refreshOnlineWorkers = useCallback(async () => {
    try {
      const data = await apiFetch<{ count: number }>("/api/customer/workers/online");
      setOnlineWorkers(data.count);
    } catch {
      setOnlineWorkers(null);
    }
  }, []);

  useEffect(() => {
    const firstTimer = window.setTimeout(() => void refreshOnlineWorkers(), 0);
    const timer = window.setInterval(() => void refreshOnlineWorkers(), 10000);
    return () => {
      window.clearTimeout(firstTimer);
      window.clearInterval(timer);
    };
  }, [refreshOnlineWorkers]);

  const refreshCdkOrders = useCallback(async (targetCode?: string, silent = false) => {
    const nextCode = normalizeCdkCode(targetCode || cdkCode || code);
    if (!nextCode) {
      commitOrders([]);
      return null;
    }

    try {
      const data = await apiFetch<{ cdk: PublicCdk; orders: PublicOrder[] }>("/api/customer/cdk/orders", {
        method: "POST",
        body: JSON.stringify({ code: nextCode }),
      });
      commitOrders(data.orders);
      setCdk(data.cdk);
      setCode(data.cdk.code);
      setCdkMessage(data.cdk.availableCount <= 0 ? { type: "noRemaining" } : { type: "bound", count: data.cdk.availableCount });
      if (!silent) toast.success(copy.refreshSuccess);
      return data;
    } catch (error) {
      if (!silent) toast.error(error instanceof Error ? error.message : copy.refreshFailed);
      return null;
    }
  }, [cdkCode, code, commitOrders, copy.refreshFailed, copy.refreshSuccess]);

  const bindCdkSession = useCallback((nextCdk: PublicCdk | null) => {
    if (!nextCdk) {
      window.sessionStorage.removeItem(CDK_SESSION_KEY);
      window.sessionStorage.removeItem(ORDER_SESSION_KEY);
      window.sessionStorage.removeItem(ORDER_TOKEN_SESSION_KEY);
      setCdk(null);
      commitOrders([]);
      setCdkMessage({ type: "input" });
      return;
    }

    window.sessionStorage.setItem(CDK_SESSION_KEY, nextCdk.code);
    setCdk(nextCdk);
    setCode(nextCdk.code);
    setCdkMessage(nextCdk.availableCount <= 0 ? { type: "noRemaining" } : { type: "bound", count: nextCdk.availableCount });
  }, [commitOrders]);

  const checkCdk = useCallback(async (candidateCode?: string) => {
    const nextCode = normalizeCdkCode(candidateCode ?? code);
    if (!nextCode) {
      bindCdkSession(null);
      setCdkMessage({ type: "input" });
      return null;
    }

    try {
      setLoading(true);
      const data = await apiFetch<PublicCdk>("/api/customer/cdk/check", {
        method: "POST",
        body: JSON.stringify({ code: nextCode }),
      });

      if (data.availableCount <= 0) {
        bindCdkSession(data);
        void refreshCdkOrders(data.code, true);
        toast.error(copy.cdkNoRemainingToast);
        return null;
      }

      bindCdkSession(data);
      void refreshCdkOrders(data.code, true);
      toast.success(copy.cdkBoundToast);
      return data;
    } catch (error) {
      bindCdkSession(null);
      const message = error instanceof Error ? error.message : copy.cdkCheckFailed;
      setCdkMessage({ type: "error", message });
      toast.error(message);
      return null;
    } finally {
      setLoading(false);
    }
  }, [bindCdkSession, code, copy, refreshCdkOrders]);

  const checkSessionToken = useCallback(async () => {
    const credential = sessionToken.trim();
    if (!credential) {
      toast.error(copy.tokenEmptyToast);
      setTokenStatus("error");
      setTokenMessage(copy.tokenError);
      return false;
    }

    try {
      setTokenStatus("checking");
      setTokenMessage("");
      await apiFetch<{ canSubmit: boolean }>("/api/customer/session/check", {
        method: "POST",
        body: JSON.stringify({ sessionToken: credential }),
      });
      setTokenStatus("valid");
      setTokenMessage(copy.tokenValid);
      toast.success(copy.tokenValidToast);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : copy.tokenError;
      const bound = message.includes("绑定邮箱") || message.toLowerCase().includes("bound email");
      setTokenStatus(bound ? "bound" : "error");
      setTokenMessage(message);
      toast.error(message);
      return false;
    }
  }, [copy, sessionToken]);

  const copyAuthSessionUrl = useCallback(async () => {
    try {
      if (window.navigator.clipboard?.writeText) {
        await window.navigator.clipboard.writeText(AUTH_SESSION_URL);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = AUTH_SESSION_URL;
        textarea.setAttribute("readonly", "true");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }
      toast.success(copy.copySessionUrlSuccess);
    } catch {
      toast.error(copy.copySessionUrlFailed);
    }
  }, [copy]);

  useEffect(() => {
    if (hasLoadedSession.current) return;
    hasLoadedSession.current = true;
    const savedCode = window.sessionStorage.getItem(CDK_SESSION_KEY);
    if (savedCode) {
      const timer = window.setTimeout(() => {
        setCode(savedCode);
        void checkCdk(savedCode);
      }, 0);
      return () => window.clearTimeout(timer);
    }
  }, [checkCdk]);

  async function submitOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const activeCdk = cdk ?? await checkCdk();
    if (!activeCdk) return;

    if (tokenStatus !== "valid") {
      const ok = await checkSessionToken();
      if (!ok) return;
    }

    try {
      setLoading(true);
      if (hasKnownNoOnlineWorkers) toast.warning(copy.noWorkerToast);
      const data = await apiFetch<PublicOrder>("/api/customer/orders", {
        method: "POST",
        body: JSON.stringify({ code: activeCdk.code, sessionToken: sessionToken.trim() }),
      });
      upsertOrder(data);
      setSessionToken("");
      setTokenStatus("idle");
      setTokenMessage("");
      bindCdkSession(data.cdk || null);
      if (data.cdk?.code) void refreshCdkOrders(data.cdk.code, true);
      setView("orders");
      toast.success(copy.submitSuccess);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy.submitFailed);
    } finally {
      setLoading(false);
    }
  }

  const refreshOrderById = useCallback(async (nextOrderId: string, silent = false, syncCdk = true) => {
    try {
      const data = await apiFetch<PublicOrder>(`/api/customer/orders/${nextOrderId}`, {
        headers: getCustomerOrderHeaders(nextOrderId),
      });
      upsertOrder(data);
      if (syncCdk) bindCdkSession(data.cdk || null);
      if (!silent) toast.success(copy.refreshSuccess);
      return data;
    } catch (error) {
      if (!silent) toast.error(error instanceof Error ? error.message : copy.refreshFailed);
      return null;
    }
  }, [bindCdkSession, copy.refreshFailed, copy.refreshSuccess, getCustomerOrderHeaders, upsertOrder]);

  const refreshActiveOrders = useCallback(async (silent = false) => {
    if (cdkCode) {
      await refreshCdkOrders(cdkCode, silent);
      return;
    }
    const targets = ordersRef.current.filter((item) => activeStatuses.has(String(item.status).toUpperCase()));
    await Promise.all(targets.map((item) => refreshOrderById(item.id, silent, false)));
  }, [cdkCode, refreshCdkOrders, refreshOrderById]);

  async function cancelOrderById(nextOrderId: string) {
    try {
      setLoading(true);
      const data = await apiFetch<{ order: PublicOrder; changed: boolean }>(`/api/customer/orders/${nextOrderId}/cancel`, {
        method: "POST",
        headers: getCustomerOrderHeaders(nextOrderId),
      });
      upsertOrder(data.order);
      bindCdkSession(data.order.cdk || null);
      if (data.order.cdk?.code) void refreshCdkOrders(data.order.cdk.code, true);
      toast.success(data.changed ? copy.cancelSuccess : copy.alreadyEnded);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy.cancelFailed);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!activeOrderIdsKey) return;
    const timer = window.setInterval(() => void refreshActiveOrders(true), 3000);
    return () => window.clearInterval(timer);
  }, [activeOrderIdsKey, refreshActiveOrders]);

  return (
    <div className="relative min-h-dvh overflow-x-hidden bg-soft text-foreground">
      <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col justify-center gap-3 px-5 py-6">
        <div className="text-center">
          <h1 className="text-4xl font-semibold tracking-tight md:text-5xl">
            <span className="text-brand">{copy.titlePrefix}</span> {copy.titleSuffix}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">{copy.tagline}</p>
        </div>

        <div className="mx-auto grid w-full max-w-md grid-cols-2 rounded-full border border-border bg-background/80 p-1 shadow-sm backdrop-blur">
          <button
            type="button"
            className={cn(
              "rounded-full px-4 py-2 text-sm font-medium transition",
              view === "submit" ? "bg-foreground text-background shadow-sm" : "text-muted-foreground hover:text-foreground"
            )}
            onClick={() => setView("submit")}
          >
            {copy.submitView}
          </button>
          <button
            type="button"
            className={cn(
              "rounded-full px-4 py-2 text-sm font-medium transition",
              view === "orders" ? "bg-foreground text-background shadow-sm" : "text-muted-foreground hover:text-foreground"
            )}
            onClick={() => setView("orders")}
          >
            {copy.ordersView}
            {activeOrders.length > 0 ? <span className="ml-1">({activeOrders.length})</span> : null}
          </button>
        </div>

        {view === "submit" ? (
          <>
            <Card size="sm" className="rounded-3xl bg-background shadow-sm">
              <CardHeader className="text-center">
                <CardTitle className="text-xl">{copy.tokenTitle}</CardTitle>
                <CardDescription>{copy.tokenDesc}</CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={submitOrder} className="flex flex-col gap-3">
                  {hasKnownNoOnlineWorkers && (
                    <div className="flex gap-3 rounded-2xl border border-warning/30 bg-warning/10 p-3 text-sm text-muted-foreground">
                      <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-warning" />
                      <p>{copy.noWorkerWarning}</p>
                    </div>
                  )}

                  <FieldGroup>
                    <Field>
                      <FieldLabel htmlFor="session-token" className="sr-only">Session token</FieldLabel>
                      <div className="mb-3 rounded-2xl border border-border bg-muted/40 p-3 text-left text-sm">
                        <div className="font-semibold">{copy.tokenGuideTitle}</div>
                        <div className="mt-2 space-y-1 text-muted-foreground">
                          <p>
                            {copy.tokenGuideLoginPrefix}{" "}
                            <a href="https://chatgpt.com/" target="_blank" rel="noreferrer" className="font-medium text-brand underline-offset-4 hover:underline">
                              chatgpt.com
                            </a>{" "}
                            {copy.tokenGuideLoginSuffix}
                          </p>
                          <p>{copy.tokenGuideOpen}</p>
                        </div>
                        <Button type="button" variant="outline" size="sm" className="mt-3 rounded-full bg-background" onClick={copyAuthSessionUrl}>
                          <CopyIcon data-icon="inline-start" />
                          {copy.copySessionUrl}
                        </Button>
                      </div>
                      <Textarea
                        id="session-token"
                        value={sessionToken}
                        onChange={(event) => {
                          setSessionToken(event.target.value);
                          setTokenStatus("idle");
                          setTokenMessage("");
                        }}
                        placeholder={copy.tokenPlaceholder}
                        className="h-36 min-h-36 max-h-36 resize-none overflow-y-auto overscroll-contain break-all font-mono text-xs leading-relaxed [field-sizing:fixed]"
                      />
                      <FieldDescription className="text-center">{copy.tokenSecretHint}</FieldDescription>
                    </Field>
                  </FieldGroup>

                  <div className={cn(
                    "flex gap-3 rounded-2xl border p-3 text-sm",
                    tokenStatus === "valid" && "border-success/30 bg-success/10 text-success",
                    tokenStatus === "bound" && "border-destructive/30 bg-destructive/10 text-destructive",
                    tokenStatus === "checking" && "border-border bg-muted/40 text-muted-foreground",
                    (tokenStatus === "idle" || tokenStatus === "error") && "border-border bg-muted/40 text-muted-foreground"
                  )}>
                    {tokenStatus === "checking" ? <Loader2Icon className="mt-0.5 size-4 shrink-0 animate-spin" /> : tokenStatus === "valid" ? <CheckCircle2Icon className="mt-0.5 size-4 shrink-0" /> : <ShieldCheckIcon className="mt-0.5 size-4 shrink-0" />}
                    <p>{tokenStatusText}</p>
                  </div>

                  <div className="grid gap-2 sm:grid-cols-2">
                    <Button type="button" size="lg" variant="outline" onClick={checkSessionToken} disabled={loading || tokenStatus === "checking"}>
                      {tokenStatus === "checking" ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <ShieldCheckIcon data-icon="inline-start" />}
                      {copy.checkToken}
                    </Button>
                    <Button type="submit" size="lg" disabled={loading || !canSubmit}>
                      {loading ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <SendIcon data-icon="inline-start" />}
                      {copy.submitOrder}
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>

            <Card size="sm" className="rounded-3xl bg-background shadow-sm">
              <CardHeader className="text-center">
                <CardTitle className="text-xl">{copy.cdkTitle}</CardTitle>
                <CardDescription>{cdkMessageText}</CardDescription>
              </CardHeader>
              <CardContent>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="cdk" className="sr-only">CDK</FieldLabel>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <Input
                        id="cdk"
                        value={code}
                        onChange={(event) => {
                          setCode(event.target.value);
                          setCdk(null);
                          window.sessionStorage.removeItem(CDK_SESSION_KEY);
                          window.sessionStorage.removeItem(ORDER_SESSION_KEY);
                          window.sessionStorage.removeItem(ORDER_TOKEN_SESSION_KEY);
                          commitOrders([]);
                          setCdkMessage({ type: "prompt" });
                        }}
                        placeholder={copy.cdkPlaceholder}
                        className="h-11 text-center text-base sm:text-left"
                      />
                      <Button type="button" size="lg" variant="outline" onClick={() => checkCdk()} disabled={loading}>
                        <KeyRoundIcon data-icon="inline-start" />
                        {copy.bindCdk}
                      </Button>
                    </div>
                    <FieldDescription className="text-center">
                      {cdk ? copy.cdkCurrent(cdk.code, cdk.availableCount) : copy.cdkEmptyHint}
                    </FieldDescription>
                  </Field>
                </FieldGroup>
              </CardContent>
            </Card>
          </>
        ) : (
          <Card size="sm" className="rounded-3xl bg-background shadow-sm">
          <CardHeader className="text-center">
            <CardTitle className="text-xl">{copy.orderListTitle}</CardTitle>
            <CardDescription>{copy.orderListDesc}</CardDescription>
          </CardHeader>
          <CardContent>
            <CustomerOrderList
              activeOrders={activeOrders}
              finishedOrders={finishedOrders}
              hasCdk={Boolean(cdk)}
              labels={copy}
              lang={lang}
              loading={loading}
              onCancel={cancelOrderById}
              onRefresh={(nextOrderId) => refreshOrderById(nextOrderId)}
            />
          </CardContent>
          </Card>
        )}
      </main>

      <div className="fixed bottom-5 right-5 flex max-w-[calc(100vw-2.5rem)] flex-col items-end gap-2">
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" size="sm" className="rounded-full bg-background/95 shadow-sm backdrop-blur-xl" onClick={toggleLanguage}>
            <Globe2Icon data-icon="inline-start" />
            {copy.switchLanguage}
          </Button>
          <a href={process.env.NEXT_PUBLIC_TG_INVITE_URL || "https://t.me/your_group"} target="_blank" rel="noreferrer" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "rounded-full bg-background/95 shadow-sm backdrop-blur-xl")}>
            <ExternalLinkIcon data-icon="inline-start" />
            {copy.joinTg}
          </a>
        </div>
        <div className="flex items-center gap-2 rounded-full border border-border bg-background/95 px-4 py-2 text-sm shadow-[0_12px_40px_rgba(0,0,0,0.12)] backdrop-blur-xl">
          <UsersRoundIcon className="size-4 text-muted-foreground" />
          <span className="text-muted-foreground">{copy.onlineWorkers}</span>
          <span className="font-semibold">{onlineWorkers ?? "-"}</span>
        </div>
      </div>
    </div>
  );
}

function CustomerOrderList({
  activeOrders,
  finishedOrders,
  hasCdk,
  labels,
  lang,
  loading,
  onCancel,
  onRefresh,
}: {
  activeOrders: PublicOrder[];
  finishedOrders: PublicOrder[];
  hasCdk: boolean;
  labels: typeof COPY[Lang];
  lang: Lang;
  loading: boolean;
  onCancel: (orderId: string) => void | Promise<void>;
  onRefresh: (orderId: string) => void | Promise<unknown>;
}) {
  const hasOrders = activeOrders.length > 0 || finishedOrders.length > 0;

  if (!hasOrders) {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
        {hasCdk ? labels.noOrder : labels.noCdkOrders}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-center text-xs text-muted-foreground">{labels.localHistoryHint}</p>

      <OrderListSection
        title={labels.activeOrdersTitle}
        emptyText={labels.noActiveOrders}
        orders={activeOrders}
        labels={labels}
        lang={lang}
        loading={loading}
        onCancel={onCancel}
        onRefresh={onRefresh}
      />

      {finishedOrders.length > 0 && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">{labels.historyOrdersTitle}</h3>
          </div>
          <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
            {finishedOrders.map((item) => (
              <OrderListItem
                key={item.id}
                order={item}
                labels={labels}
                lang={lang}
                loading={loading}
                onCancel={onCancel}
                onRefresh={onRefresh}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function OrderListSection({
  title,
  emptyText,
  orders,
  labels,
  lang,
  loading,
  onCancel,
  onRefresh,
}: {
  title: string;
  emptyText: string;
  orders: PublicOrder[];
  labels: typeof COPY[Lang];
  lang: Lang;
  loading: boolean;
  onCancel: (orderId: string) => void | Promise<void>;
  onRefresh: (orderId: string) => void | Promise<unknown>;
}) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {orders.length === 0 ? (
        <div className="rounded-2xl bg-muted/30 p-4 text-center text-sm text-muted-foreground">{emptyText}</div>
      ) : (
        <div className="space-y-2">
          {orders.map((item) => (
            <OrderListItem
              key={item.id}
              order={item}
              labels={labels}
              lang={lang}
              loading={loading}
              onCancel={onCancel}
              onRefresh={onRefresh}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function OrderListItem({
  order,
  labels,
  lang,
  loading,
  onCancel,
  onRefresh,
}: {
  order: PublicOrder;
  labels: typeof COPY[Lang];
  lang: Lang;
  loading: boolean;
  onCancel: (orderId: string) => void | Promise<void>;
  onRefresh: (orderId: string) => void | Promise<unknown>;
}) {
  const isPending = order.status === "PENDING";
  const isActive = activeStatuses.has(String(order.status).toUpperCase());

  return (
    <div className="rounded-2xl border border-border/70 bg-muted/30 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-semibold">{order.orderNo}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {labels.updatedAt}{formatClientDateTime(order.updatedAt, lang)}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            CDK: {order.cdk?.code || "-"}
          </div>
        </div>
        <OrderStatusBadge status={order.status} audience="customer" language={lang} />
      </div>

      <p className="mt-3 text-sm text-muted-foreground">{getOrderHint(order, labels)}</p>
      {(order.assignedWorker ?? order.lastWorker) && (
        <p className="mt-1 text-xs text-muted-foreground">
          Worker: {(order.assignedWorker ?? order.lastWorker)?.displayName || (order.assignedWorker ?? order.lastWorker)?.username}
        </p>
      )}
      {order.problemReason && <p className="mt-2 text-sm text-destructive">{order.problemReason}</p>}
      {order.upiExtractError && <p className="mt-2 text-sm text-destructive">{order.upiExtractError}</p>}
      {order.subscriptionCheckLastError && <p className="mt-2 text-sm text-destructive">{order.subscriptionCheckLastError}</p>}

      <div className="mt-3 flex flex-wrap justify-end gap-2">
        {isPending && (
          <Button type="button" variant="outline" size="sm" onClick={() => void onCancel(order.id)} disabled={loading}>
            <XCircleIcon data-icon="inline-start" />
            {labels.cancel}
          </Button>
        )}
        <Button type="button" variant={isActive ? "outline" : "ghost"} size="sm" onClick={() => void onRefresh(order.id)} disabled={loading}>
          <RotateCcwIcon data-icon="inline-start" />
          {labels.refreshStatus}
        </Button>
      </div>
    </div>
  );
}

function getCdkMessageText(message: CdkMessage, copy: typeof COPY[Lang]) {
  if (message.type === "input") return copy.cdkInput;
  if (message.type === "noRemaining") return copy.cdkNoRemaining;
  if (message.type === "bound") return copy.cdkBound(message.count);
  if (message.type === "error") return message.message;
  return copy.cdkPrompt;
}

function getTokenStatusText(status: TokenStatus, copy: typeof COPY[Lang]) {
  if (status === "checking") return copy.tokenChecking;
  if (status === "valid") return copy.tokenValid;
  if (status === "bound") return copy.tokenBound;
  if (status === "error") return copy.tokenError;
  return copy.tokenPrompt;
}

function getOrderHint(order: PublicOrder, copy: typeof COPY[Lang]) {
  if (order.status === "PENDING") return copy.orderPendingHint;
  if (order.status === "NEED_REUPLOAD") return copy.orderReturnedHint;
  if (order.status === "CHECKING") return copy.orderCheckingHint;
  if (order.status === "COMPLETED") return copy.orderCompletedHint;
  if (order.status === "CANCELLED") return copy.orderCancelledHint;
  if (order.status === "EXPIRED") return copy.orderExpiredHint;
  if (order.status === "FAILED") return copy.orderGenericFailedHint;
  if (order.upiExtractionStatus === "READY") return copy.orderReadyHint;
  if (order.upiExtractionStatus === "FAILED") return copy.orderFailedHint;
  if (order.status === "ASSIGNED") return copy.orderAssignedHint;
  return copy.noOrder;
}

function formatClientDateTime(value: string | null | undefined, lang: Lang) {
  if (!value) return "-";
  return new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : "en-US", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function sortCustomerOrders(items: PublicOrder[]) {
  return [...items].sort((a, b) => {
    const aActive = activeStatuses.has(String(a.status).toUpperCase());
    const bActive = activeStatuses.has(String(b.status).toUpperCase());
    if (aActive !== bActive) return aActive ? -1 : 1;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}
