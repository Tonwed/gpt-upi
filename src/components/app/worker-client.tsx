"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangleIcon,
  BellRingIcon,
  BotIcon,
  CheckCircle2Icon,
  ClipboardCheckIcon,
  CopyIcon,
  Clock3Icon,
  DollarSignIcon,
  ExternalLinkIcon,
  Globe2Icon,
  HistoryIcon,
  Loader2Icon,
  LogOutIcon,
  PackageOpenIcon,
  PlayCircleIcon,
  QrCodeIcon,
  RefreshCwIcon,
  SearchIcon,
  Undo2Icon,
  WalletIcon,
  Volume2Icon,
  WifiIcon,
  WifiOffIcon,
} from "lucide-react";
import { toast } from "sonner";
import { AppFrame } from "@/components/app/app-frame";
import { MetricCard } from "@/components/app/metric-card";
import { OrderImagePreview } from "@/components/app/order-image-preview";
import { OrderStatusBadge, WorkerStatusBadge } from "@/components/app/status-badge";
import { TelegramLoginClient } from "@/components/app/telegram-login-client";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch, formatMoney } from "@/lib/api-client";
import { useAppLanguage, type AppLanguage } from "@/lib/client/language";
import type { PublicOrder, PublicWorker, WorkerStats } from "@/lib/types/app";
import { cn } from "@/lib/utils";

const DEFAULT_PROBLEM_REASON: Record<AppLanguage, string> = {
  zh: "UPI 二维码无法生成或无法处理，请更换 session token 后重新提交。",
  en: "The UPI QR could not be generated or processed. Please submit a new session token.",
};
const PUBLIC_SCAN_ASSIGNED_CHECK_GRACE_MS = 5 * 60 * 1000;
const MAX_ACTIVE_ORDERS_PER_WORKER = 3;

type WakeLockSentinelLike = {
  release: () => Promise<void>;
  addEventListener: (type: "release", listener: () => void) => void;
};

type NavigatorWithWakeLock = Navigator & {
  wakeLock?: {
    request: (type: "screen") => Promise<WakeLockSentinelLike>;
  };
};

type MeData = { worker: PublicWorker; activeOrder?: PublicOrder | null; activeOrders?: PublicOrder[] };
type HallData = { orders: PublicOrder[]; gated: boolean; message?: string };

type WorkerCopy = {
  pageTitle: string;
  pageSubtitle: string;
  loading: string;
  refreshSuccess: string;
  refreshFailed: string;
  loggedOut: string;
  logoutFailed: string;
  onlineSuccess: string;
  onlineFailed: string;
  offlineSuccess: string;
  offlineFailed: string;
  autoOn: string;
  autoOff: string;
  autoNotifyOn: string;
  autoNotifyOff: string;
  settingFailed: string;
  acceptSuccess: string;
  acceptFailed: string;
  completeUpdated: string;
  completeAlready: string;
  completeFailed: string;
  problemSuccess: string;
  problemFailed: string;
  todayCompleted: string;
  todayCompletedDesc: string;
  todayAmount: string;
  currentUnitPrice: (price: string) => string;
  totalCompleted: string;
  totalCompletedDesc: (amount: string, problems: number) => string;
  unsettledAmount: string;
  unsettledDesc: (count: number) => string;
  goHistory: string;
  online: string;
  offline: string;
  logout: string;
  autoAccept: string;
  autoAcceptDesc: string;
  autoAcceptNotify: string;
  autoAcceptNotifyDesc: string;
  autoAcceptNotifyNoTelegram: string;
  currentOrder: string;
  noActiveOrder: string;
  noActiveDesc: string;
  riskTitle: string;
  riskDesc: string;
  qrAlt: string;
  qrVersion: string;
  acceptedAt: string;
  completed: string;
  checkingSubscription: string;
  recheckSubscription: string;
  subscriptionCheckFailedTitle: string;
  subscriptionCheckRetryDesc: (rounds: number) => string;
  problemReason: string;
  needReupload: string;
  generateUpi: string;
  generatingUpi: string;
  generateUpiSuccess: string;
  generateUpiFailed: string;
  upiPendingTitle: string;
  upiPendingDesc: string;
  upiFailedTitle: string;
  qrValidFor: (time: string) => string;
  qrExpiredTitle: string;
  qrExpiredDesc: string;
  regenerateUpi: string;
  regenerateUpiShort: string;
  hallTitle: string;
  hallOnlineDesc: string;
  hallOfflineDesc: string;
  refresh: string;
  searchPlaceholder: string;
  offlineTitle: string;
  offlineDesc: string;
  order: string;
  createdAt: string;
  status: string;
  action: string;
  noOrders: string;
  version: (version: number) => string;
  accept: string;
  switchLanguage: string;
};

const COPY: Record<AppLanguage, WorkerCopy> = {
  zh: {
    pageTitle: "接单方工作台",
    pageSubtitle: "上线后进入订单大厅；开启自动接单后，空闲时会自动接取最早订单。",
    loading: "加载账户状态中…",
    refreshSuccess: "工作台已刷新",
    refreshFailed: "刷新失败",
    loggedOut: "已退出登录",
    logoutFailed: "退出失败",
    onlineSuccess: "已上线，可以查看订单大厅",
    onlineFailed: "上线失败",
    offlineSuccess: "已下线，自动接单已关闭",
    offlineFailed: "下线失败",
    autoOn: "自动接单已开启",
    autoOff: "自动接单已关闭",
    autoNotifyOn: "自动接单 TG 通知已开启",
    autoNotifyOff: "自动接单 TG 通知已关闭",
    settingFailed: "设置失败",
    acceptSuccess: "接单成功，请处理当前订单",
    acceptFailed: "接单失败",
    completeUpdated: "订单已完成，统计已更新",
    completeAlready: "订单此前已完成",
    completeFailed: "完成失败",
    problemSuccess: "已退回订单，冻结次数已返还，当前席位已释放",
    problemFailed: "标记异常失败",
    todayCompleted: "今日完成",
    todayCompletedDesc: "按 Asia/Shanghai 当天统计",
    todayAmount: "今日收入",
    currentUnitPrice: (price) => "当前单价 " + price + "/单",
    totalCompleted: "历史完成",
    totalCompletedDesc: (amount, problems) => "累计收入 " + amount + "，异常反馈 " + problems + " 次",
    unsettledAmount: "未结金额",
    unsettledDesc: (count) => count + " 单待管理员结单",
    goHistory: "查看历史",
    online: "上线",
    offline: "下线",
    logout: "退出",
    autoAccept: "自动接单",
    autoAcceptDesc: "在线且空闲时由服务端自动接单，关闭网页也会继续生效。",
    autoAcceptNotify: "自动接单 TG 通知",
    autoAcceptNotifyDesc: "自动接到订单后，通过 Telegram 通知你处理。",
    autoAcceptNotifyNoTelegram: "当前账号未绑定 Telegram ID，无法开启通知。",
    currentOrder: "当前订单",
    noActiveOrder: "暂无进行中的订单",
    noActiveDesc: "上线后从右侧大厅手动接取，或开启自动接单。",
    riskTitle: "二维码内容异常",
    riskDesc: "系统生成的二维码未识别到 upi:// 协议，请优先核对；如无法处理，可退回订单。",
    qrAlt: "当前订单二维码",
    qrVersion: "二维码版本",
    acceptedAt: "接单时间",
    completed: "已完成，检测订阅",
    checkingSubscription: "正在检测订阅...",
    recheckSubscription: "再次检测订阅",
    subscriptionCheckFailedTitle: "账号订阅未更新",
    subscriptionCheckRetryDesc: (rounds) => `系统暂未检测到 Plus。已检测 ${rounds} 轮；扫码订单处于检测窗口内时，系统也会自动持续检测。`,
    problemReason: "问题原因",
    needReupload: "有问题，退回订单",
    generateUpi: "生成 UPI 二维码",
    generatingUpi: "正在生成 UPI 二维码...",
    generateUpiSuccess: "UPI 二维码已生成",
    generateUpiFailed: "UPI 二维码生成失败",
    upiPendingTitle: "等待生成 UPI 二维码",
    upiPendingDesc: "该订单只保存了加密 session token。你无法查看 token，请点击下方按钮由系统后台提取并生成二维码。",
    upiFailedTitle: "UPI 二维码生成失败",
    qrValidFor: (time) => "二维码剩余有效期 " + time,
    qrExpiredTitle: "UPI 二维码已过期",
    qrExpiredDesc: "二维码生成后仅 5 分钟内有效；请重新生成后再完成订单。",
    regenerateUpi: "重新生成 UPI 二维码",
    regenerateUpiShort: "重新生成二维码",
    hallTitle: "订单大厅",
    hallOnlineDesc: "仅展示等待接单的订单",
    hallOfflineDesc: "请先上线后查看大厅",
    refresh: "刷新",
    searchPlaceholder: "搜索订单号...",
    offlineTitle: "当前离线",
    offlineDesc: "上线后才能查看订单大厅、手动接单或开启自动接单。",
    order: "订单",
    createdAt: "创建时间",
    status: "状态",
    action: "操作",
    noOrders: "暂无等待接单的订单",
    version: (version) => "版本 v" + version,
    accept: "接取",
    switchLanguage: "EN",
  },
  en: {
    pageTitle: "Worker Workbench",
    pageSubtitle: "Go online to enter the order hall. Auto-accept picks the earliest order while you are idle.",
    loading: "Loading account state…",
    refreshSuccess: "Workbench refreshed",
    refreshFailed: "Refresh failed",
    loggedOut: "Logged out",
    logoutFailed: "Logout failed",
    onlineSuccess: "You are online. The order hall is available.",
    onlineFailed: "Failed to go online",
    offlineSuccess: "You are offline. Auto-accept is disabled.",
    offlineFailed: "Failed to go offline",
    autoOn: "Auto-accept enabled",
    autoOff: "Auto-accept disabled",
    autoNotifyOn: "Auto-accept TG notifications enabled",
    autoNotifyOff: "Auto-accept TG notifications disabled",
    settingFailed: "Setting failed",
    acceptSuccess: "Order accepted. Please process it now.",
    acceptFailed: "Accept failed",
    completeUpdated: "Order completed. Stats updated.",
    completeAlready: "The order was already completed",
    completeFailed: "Complete failed",
    problemSuccess: "Order returned. The frozen use was released and your active slot is free.",
    problemFailed: "Failed to mark issue",
    todayCompleted: "Today completed",
    todayCompletedDesc: "Based on Asia/Shanghai day",
    todayAmount: "Today earnings",
    currentUnitPrice: (price) => "Current rate " + price + "/order",
    totalCompleted: "Total completed",
    totalCompletedDesc: (amount, problems) => "Total earnings " + amount + ", " + problems + " issue report(s)",
    unsettledAmount: "Unsettled",
    unsettledDesc: (count) => count + " order(s) waiting for settlement",
    goHistory: "View history",
    online: "Online",
    offline: "Offline",
    logout: "Log out",
    autoAccept: "Auto-accept",
    autoAcceptDesc: "Server-side auto-accept while online and idle; it keeps working after closing the page.",
    autoAcceptNotify: "Auto-accept TG notification",
    autoAcceptNotifyDesc: "Notify you on Telegram after an order is auto-accepted.",
    autoAcceptNotifyNoTelegram: "This account is not bound to a Telegram ID, so notifications cannot be enabled.",
    currentOrder: "Current order",
    noActiveOrder: "No active order",
    noActiveDesc: "Go online and accept manually from the hall, or enable auto-accept.",
    riskTitle: "QR content issue",
    riskDesc: "The generated QR content was not recognized as upi://. Verify it first; return the order if it cannot be processed.",
    qrAlt: "Current order QR code",
    qrVersion: "QR version",
    acceptedAt: "Accepted at",
    completed: "Completed, check subscription",
    checkingSubscription: "Checking subscription...",
    recheckSubscription: "Check subscription again",
    subscriptionCheckFailedTitle: "Subscription not updated",
    subscriptionCheckRetryDesc: (rounds) => `Plus was not detected yet. Checked ${rounds} round(s); the system will also keep checking automatically while the scan order is in its check window.`,
    problemReason: "Issue reason",
    needReupload: "Return as issue",
    generateUpi: "Generate UPI QR",
    generatingUpi: "Generating UPI QR...",
    generateUpiSuccess: "UPI QR generated",
    generateUpiFailed: "Failed to generate UPI QR",
    upiPendingTitle: "Waiting for UPI QR generation",
    upiPendingDesc: "This order only stores an encrypted session token. You cannot view the token; click below to let the server extract and generate the QR.",
    upiFailedTitle: "UPI QR generation failed",
    qrValidFor: (time) => "QR valid for " + time,
    qrExpiredTitle: "UPI QR expired",
    qrExpiredDesc: "A generated QR is valid for 5 minutes only. Regenerate it before completing the order.",
    regenerateUpi: "Regenerate UPI QR",
    regenerateUpiShort: "Regenerate QR",
    hallTitle: "Order hall",
    hallOnlineDesc: "Only waiting orders are shown",
    hallOfflineDesc: "Go online to view the hall",
    refresh: "Refresh",
    searchPlaceholder: "Search order number...",
    offlineTitle: "Offline",
    offlineDesc: "Go online to view the hall, accept orders, or enable auto-accept.",
    order: "Order",
    createdAt: "Created at",
    status: "Status",
    action: "Action",
    noOrders: "No waiting orders",
    version: (version) => "Version v" + version,
    accept: "Accept",
    switchLanguage: "中文",
  },
};

export function WorkerClient() {
  const { language, toggleLanguage } = useAppLanguage();
  const copy = COPY[language];
  const [worker, setWorker] = useState<PublicWorker | null>(null);
  const [activeOrder, setActiveOrder] = useState<PublicOrder | null>(null);
  const [activeOrders, setActiveOrders] = useState<PublicOrder[]>([]);
  const [orders, setOrders] = useState<PublicOrder[]>([]);
  const [stats, setStats] = useState<WorkerStats | null>(null);
  const [search, setSearch] = useState("");
  const [problemReason, setProblemReason] = useState(DEFAULT_PROBLEM_REASON.zh);
  const [problemTouched, setProblemTouched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [generatingUpi, setGeneratingUpi] = useState(false);
  const [binanceUserIdInput, setBinanceUserIdInput] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [bindWalletOpen, setBindWalletOpen] = useState(false);
  const [booted, setBooted] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const soundEnabledRef = useRef(false);
  const browserNotifyEnabledRef = useRef(false);
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const knownHallOrderIdsRef = useRef<Set<string>>(new Set());
  const hallReadyRef = useRef(false);
  const meReadyRef = useRef(false);
  const previousActiveOrderIdsRef = useRef<Set<string>>(new Set());
  const walletPromptShownRef = useRef(false);
  const refreshSeqRef = useRef(0);
  const [browserNotifyPermission, setBrowserNotifyPermission] = useState<NotificationPermission | "unsupported">("default");

  useEffect(() => {
    if (problemTouched) return;
    const timer = window.setTimeout(() => {
      setProblemReason(DEFAULT_PROBLEM_REASON[language]);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [language, problemTouched]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    soundEnabledRef.current = Boolean(worker?.newOrderSoundEnabled);
  }, [worker?.newOrderSoundEnabled]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const supported = typeof window !== "undefined" && "Notification" in window;
      const permission = supported ? Notification.permission : "unsupported";
      setBrowserNotifyPermission(permission);
      browserNotifyEnabledRef.current = Boolean(worker?.newOrderSoundEnabled && supported && permission === "granted");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [worker?.newOrderSoundEnabled]);

  const walletWorkerId = worker?.id || "";
  const walletWorkerBinanceUserId = worker?.binanceUserId || "";

  useEffect(() => {
    const shouldPrompt = Boolean(walletWorkerId && booted && !walletWorkerBinanceUserId && !walletPromptShownRef.current);
    const timer = window.setTimeout(() => {
      setBinanceUserIdInput(walletWorkerBinanceUserId);
      if (shouldPrompt) {
        walletPromptShownRef.current = true;
        setBindWalletOpen(true);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [walletWorkerId, walletWorkerBinanceUserId, booted]);

  const getAudioContext = useCallback(() => {
    if (typeof window === "undefined") return null;
    const AudioContextClass = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return null;
    if (!audioContextRef.current) audioContextRef.current = new AudioContextClass();
    return audioContextRef.current;
  }, []);

  const primeNotificationSound = useCallback(() => {
    const context = getAudioContext();
    if (!context) return;
    if (context.state === "suspended") void context.resume();
  }, [getAudioContext]);

  const playNotificationSound = useCallback((force = false) => {
    if (!force && !soundEnabledRef.current) return;
    const context = getAudioContext();
    if (!context) return;
    if (context.state === "suspended") void context.resume();

    const now = context.currentTime;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.22, now + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);
    gain.connect(context.destination);

    for (const [index, frequency] of [880, 1175].entries()) {
      const oscillator = context.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(frequency, now + index * 0.16);
      oscillator.connect(gain);
      oscillator.start(now + index * 0.16);
      oscillator.stop(now + index * 0.16 + 0.18);
    }
  }, [getAudioContext]);

  const showBrowserNotification = useCallback((title: string, body?: string) => {
    if (!browserNotifyEnabledRef.current) return;
    if (typeof window === "undefined" || !("Notification" in window) || Notification.permission !== "granted") return;
    try {
      const notification = new Notification(title, {
        body,
        tag: "upi-worker-order",
      });
      window.setTimeout(() => notification.close(), 9000);
    } catch {
      // Browser notification support is best-effort.
    }
  }, []);

  const requestWakeLock = useCallback(async () => {
    if (typeof navigator === "undefined" || typeof document === "undefined") return;
    if (document.visibilityState !== "visible" || worker?.status !== "ONLINE") return;
    const wakeLock = (navigator as NavigatorWithWakeLock).wakeLock;
    if (!wakeLock || wakeLockRef.current) return;
    try {
      const sentinel = await wakeLock.request("screen");
      wakeLockRef.current = sentinel;
      sentinel.addEventListener("release", () => {
        wakeLockRef.current = null;
      });
    } catch {
      wakeLockRef.current = null;
    }
  }, [worker?.status]);

  useEffect(() => {
    void requestWakeLock();
    return () => {
      const sentinel = wakeLockRef.current;
      wakeLockRef.current = null;
      void sentinel?.release().catch(() => undefined);
    };
  }, [requestWakeLock]);

  const filteredOrders = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return orders;
    return orders.filter((order) => order.orderNo.toLowerCase().includes(keyword));
  }, [orders, search]);

  const refreshAll = useCallback(async (silent = false) => {
    const refreshSeq = ++refreshSeqRef.current;
    const isCurrentRefresh = () => refreshSeq === refreshSeqRef.current;

    try {
      const me = await apiFetch<MeData>("/api/worker/me");
      if (!isCurrentRefresh()) return;

      setWorker(me.worker);
      const nextActiveOrders = me.activeOrders ?? (me.activeOrder ? [me.activeOrder] : []);
      setActiveOrders(nextActiveOrders);
      setActiveOrder((current) => {
        if (current) {
          const updatedCurrent = nextActiveOrders.find((order) => order.id === current.id);
          if (updatedCurrent) return updatedCurrent;
        }
        return nextActiveOrders[0] ?? null;
      });
      const previousActiveOrderIds = previousActiveOrderIdsRef.current;
      const newActiveOrder = nextActiveOrders.find((order) => !previousActiveOrderIds.has(order.id));
      if (meReadyRef.current && newActiveOrder && me.worker.autoAcceptEnabled) {
        playNotificationSound();
        showBrowserNotification(
          textFor(language, "已接到新订单", "New order accepted"),
          newActiveOrder.orderNo
        );
      }
      previousActiveOrderIdsRef.current = new Set(nextActiveOrders.map((order) => order.id));
      meReadyRef.current = true;

      const [hallResult, statsResult] = await Promise.allSettled([
        apiFetch<HallData>("/api/worker/orders/hall"),
        apiFetch<WorkerStats>("/api/worker/stats"),
      ]);
      if (!isCurrentRefresh()) return;

      const refreshErrors: string[] = [];
      if (hallResult.status === "fulfilled") {
        const hall = hallResult.value;
        const nextHallIds = new Set(hall.orders.map((order) => order.id));
        const hasNewHallOrder = hallReadyRef.current
          && me.worker.status === "ONLINE"
          && !me.worker.autoAcceptEnabled
          && hall.orders.some((order) => !knownHallOrderIdsRef.current.has(order.id));
        if (hasNewHallOrder) {
          const newHallOrder = hall.orders.find((order) => !knownHallOrderIdsRef.current.has(order.id));
          playNotificationSound();
          showBrowserNotification(
            textFor(language, "订单大厅有新订单", "New order in hall"),
            newHallOrder?.orderNo
          );
        }
        knownHallOrderIdsRef.current = nextHallIds;
        hallReadyRef.current = true;
        setOrders(hall.orders);
      } else {
        refreshErrors.push(hallResult.reason instanceof Error ? hallResult.reason.message : COPY[language].refreshFailed);
      }

      if (statsResult.status === "fulfilled") {
        setStats(statsResult.value);
      } else {
        refreshErrors.push(statsResult.reason instanceof Error ? statsResult.reason.message : COPY[language].refreshFailed);
      }

      if (!silent) {
        if (refreshErrors.length) toast.error(refreshErrors[0] || COPY[language].refreshFailed);
        else toast.success(COPY[language].refreshSuccess);
      }
    } catch (error) {
      if (!isCurrentRefresh()) return;
      if (!silent) toast.error(error instanceof Error ? error.message : COPY[language].refreshFailed);
      if (error instanceof Error && (error.message.includes("\u672a\u767b\u5f55") || error.message.toLowerCase().includes("unauthorized"))) {
        setWorker(null);
        setActiveOrder(null);
        setActiveOrders([]);
      }
    } finally {
      if (isCurrentRefresh()) setBooted(true);
    }
  }, [language, playNotificationSound, showBrowserNotification]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void requestWakeLock();
        void refreshAll(true);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onVisibilityChange);
    };
  }, [refreshAll, requestWakeLock]);

  const invalidateRefreshes = useCallback(() => {
    refreshSeqRef.current += 1;
  }, []);

  async function logout() {
    try {
      setLoading(true);
      await apiFetch<null>("/api/worker/logout", { method: "POST" });
      invalidateRefreshes();
      setWorker(null);
      setActiveOrder(null);
      setActiveOrders([]);
      setOrders([]);
      toast.success(copy.loggedOut);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy.logoutFailed);
    } finally {
      setLoading(false);
    }
  }

  async function goOnline() {
    try {
      setLoading(true);
      const data = await apiFetch<PublicWorker>("/api/worker/online", { method: "POST" });
      invalidateRefreshes();
      setWorker(data);
      toast.success(copy.onlineSuccess);
      void refreshAll(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy.onlineFailed);
    } finally {
      setLoading(false);
    }
  }

  async function goOffline() {
    try {
      setLoading(true);
      const data = await apiFetch<PublicWorker>("/api/worker/offline", { method: "POST" });
      invalidateRefreshes();
      setWorker(data);
      setOrders([]);
      toast.success(copy.offlineSuccess);
      void refreshAll(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy.offlineFailed);
    } finally {
      setLoading(false);
    }
  }

  async function setAutoAccept(enabled: boolean) {
    try {
      const data = await apiFetch<PublicWorker>("/api/worker/auto-accept", {
        method: "POST",
        body: JSON.stringify({ enabled }),
      });
      invalidateRefreshes();
      setWorker(data);
      toast.success(enabled ? copy.autoOn : copy.autoOff);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy.settingFailed);
    }
  }

  async function setAutoAcceptNotify(enabled: boolean) {
    try {
      const data = await apiFetch<PublicWorker>("/api/worker/auto-accept-notify", {
        method: "POST",
        body: JSON.stringify({ enabled }),
      });
      invalidateRefreshes();
      setWorker(data);
      toast.success(enabled ? copy.autoNotifyOn : copy.autoNotifyOff);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy.settingFailed);
    }
  }

  async function syncBrowserNotificationsWithSound(enabled: boolean) {
    if (!enabled) {
      browserNotifyEnabledRef.current = false;
      const supported = typeof window !== "undefined" && "Notification" in window;
      setBrowserNotifyPermission(supported ? Notification.permission : "unsupported");
      return false;
    }

    if (typeof window === "undefined" || !("Notification" in window)) {
      browserNotifyEnabledRef.current = false;
      setBrowserNotifyPermission("unsupported");
      return false;
    }

    let permission = Notification.permission;
    if (permission === "default") {
      permission = await Notification.requestPermission();
    }

    setBrowserNotifyPermission(permission);
    const granted = permission === "granted";
    browserNotifyEnabledRef.current = granted;
    if (granted) void requestWakeLock();
    return granted;
  }

  async function setNewOrderSound(enabled: boolean) {
    try {
      if (enabled) primeNotificationSound();
      const notificationEnabled = await syncBrowserNotificationsWithSound(enabled);
      soundEnabledRef.current = enabled;
      const data = await apiFetch<PublicWorker>("/api/worker/new-order-sound", {
        method: "POST",
        body: JSON.stringify({ enabled }),
      });
      invalidateRefreshes();
      setWorker(data);
      toast.success(enabled
        ? textFor(language, "新订单提醒已开启", "New order alerts enabled")
        : textFor(language, "新订单提醒已关闭", "New order alerts disabled"));
      if (enabled) {
        playNotificationSound(true);
        if (!notificationEnabled && typeof window !== "undefined" && "Notification" in window) {
          toast.info(textFor(language, "提醒音已开启；如需系统通知，请在浏览器权限中允许通知。", "Sound is enabled. To receive system notifications, allow notifications in the browser permission panel."));
        }
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy.settingFailed);
    }
  }

  function testNotificationSound() {
    primeNotificationSound();
    playNotificationSound(true);
    showBrowserNotification(
      textFor(language, "UPI Scanner 测试提醒", "UPI Scanner test alert"),
      textFor(language, "这是一个测试提醒。", "This is a test alert.")
    );
  }

  async function saveBinanceUserId() {
    try {
      setLoading(true);
      const data = await apiFetch<PublicWorker>("/api/worker/wallet/binance", {
        method: "POST",
        body: JSON.stringify({ binanceUserId: binanceUserIdInput }),
      });
      invalidateRefreshes();
      setWorker(data);
      setBindWalletOpen(false);
      toast.success(textFor(language, "Binance 用户 ID 已绑定", "Binance user ID saved"));
      void refreshAll(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : textFor(language, "绑定失败", "Bind failed"));
    } finally {
      setLoading(false);
    }
  }

  async function requestWithdrawal() {
    try {
      setLoading(true);
      await apiFetch("/api/worker/wallet/withdraw", {
        method: "POST",
        body: JSON.stringify({ amount: withdrawAmount }),
      });
      setWithdrawAmount("");
      toast.success(textFor(language, "提现申请已提交", "Withdrawal request submitted"));
      void refreshAll(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : textFor(language, "提现申请失败", "Withdrawal request failed"));
    } finally {
      setLoading(false);
    }
  }

  async function accept(orderId: string) {
    try {
      setLoading(true);
      const data = await apiFetch<PublicOrder>("/api/worker/orders/" + orderId + "/accept", { method: "POST" });
      invalidateRefreshes();
      setActiveOrders((current) => upsertActiveOrder(current, data));
      setActiveOrder(data);
      previousActiveOrderIdsRef.current = new Set([...Array.from(previousActiveOrderIdsRef.current), data.id]);
      toast.success(copy.acceptSuccess);
      void refreshAll(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy.acceptFailed);
      void refreshAll(true);
    } finally {
      setLoading(false);
    }
  }

  async function completeActive() {
    if (!activeOrder) return;
    try {
      setLoading(true);
      const data = await apiFetch<{
        order: PublicOrder;
        changed: boolean;
        verified: boolean;
        canRetry: boolean;
        message?: string;
      }>("/api/worker/orders/" + activeOrder.id + "/complete", { method: "POST" });
      invalidateRefreshes();
      if (data.verified) {
        setActiveOrders((current) => {
          const next = current.filter((order) => order.id !== activeOrder.id);
          setActiveOrder((selected) => selected?.id === activeOrder.id ? next[0] ?? null : selected);
          previousActiveOrderIdsRef.current = new Set(next.map((order) => order.id));
          return next;
        });
        toast.success(data.changed ? copy.completeUpdated : copy.completeAlready);
      } else {
        setActiveOrders((current) => upsertActiveOrder(current, data.order));
        setActiveOrder(data.order);
        toast.warning(data.message || copy.completeFailed);
      }
      void refreshAll(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy.completeFailed);
    } finally {
      setLoading(false);
    }
  }

  async function markProblem() {
    if (!activeOrder) return;
    try {
      setLoading(true);
      await apiFetch<PublicOrder>("/api/worker/orders/" + activeOrder.id + "/problem", {
        method: "POST",
        body: JSON.stringify({ reason: problemReason.trim() || DEFAULT_PROBLEM_REASON[language] }),
      });
      invalidateRefreshes();
      setActiveOrders((current) => {
        const next = current.filter((order) => order.id !== activeOrder.id);
        setActiveOrder((selected) => selected?.id === activeOrder.id ? next[0] ?? null : selected);
        previousActiveOrderIdsRef.current = new Set(next.map((order) => order.id));
        return next;
      });
      toast.success(copy.problemSuccess);
      void refreshAll(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy.problemFailed);
    } finally {
      setLoading(false);
    }
  }

  async function releaseActive() {
    if (!activeOrder) return;
    try {
      setLoading(true);
      await apiFetch<PublicOrder>("/api/worker/orders/" + activeOrder.id + "/release", { method: "POST" });
      invalidateRefreshes();
      setActiveOrders((current) => {
        const next = current.filter((order) => order.id !== activeOrder.id);
        setActiveOrder((selected) => selected?.id === activeOrder.id ? next[0] ?? null : selected);
        previousActiveOrderIdsRef.current = new Set(next.map((order) => order.id));
        return next;
      });
      setWorker((current) => current ? { ...current, autoAcceptEnabled: false } : current);
      toast.success(textFor(language, "订单已释放，并已关闭自动接单，避免马上重新接回", "Order released. Auto-accept was disabled to avoid immediately picking it again."));
      void refreshAll(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : textFor(language, "释放订单失败", "Release order failed"));
    } finally {
      setLoading(false);
    }
  }

  async function generateUpiQr() {
    if (!activeOrder) return;
    try {
      setGeneratingUpi(true);
      const data = await apiFetch<PublicOrder>("/api/worker/orders/" + activeOrder.id + "/generate-upi", { method: "POST" });
      invalidateRefreshes();
      setActiveOrders((current) => upsertActiveOrder(current, data));
      setActiveOrder(data);
      toast.success(copy.generateUpiSuccess);
      void refreshAll(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy.generateUpiFailed);
      void refreshAll(true);
    } finally {
      setGeneratingUpi(false);
    }
  }

  async function copyPaymentLink(url?: string | null) {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast.success(textFor(language, "支付链接已复制", "Payment link copied"));
    } catch {
      toast.error(textFor(language, "复制失败，请手动打开后复制", "Copy failed. Please open the link and copy it manually."));
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshAll(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshAll]);

  const workerId = worker?.id;
  const workerStatus = worker?.status;
  const autoAcceptEnabled = worker?.autoAcceptEnabled;
  const activeOrderCount = activeOrders.length;
  const canAcceptMoreOrders = activeOrderCount < MAX_ACTIVE_ORDERS_PER_WORKER;
  const activeOrderIsPublicScan = activeOrder?.source === "PUBLIC_SCAN";
  const activeOrderQrExpiresAtMs = activeOrder?.upiExpiresAt ? new Date(activeOrder.upiExpiresAt).getTime() : 0;
  const activeOrderHasGeneratedQr = Boolean(activeOrder?.qrImageUrl && activeOrder?.upiExtractionStatus === "READY");
  const activeOrderQrExpired = Boolean(activeOrderHasGeneratedQr && (!activeOrderQrExpiresAtMs || activeOrderQrExpiresAtMs <= nowMs));
  const activeOrderPublicScanGraceUntilMs = activeOrderIsPublicScan && activeOrderQrExpiresAtMs
    ? activeOrderQrExpiresAtMs + PUBLIC_SCAN_ASSIGNED_CHECK_GRACE_MS
    : 0;
  const activeOrderInPublicScanGrace = Boolean(activeOrderQrExpired && activeOrderPublicScanGraceUntilMs > nowMs);
  const activeOrderQrReady = Boolean(activeOrderHasGeneratedQr && !activeOrderQrExpired);
  const activeOrderQrRemainingText = formatDuration(Math.max(0, activeOrderQrExpiresAtMs - nowMs));
  const activeOrderCheckGraceRemainingText = formatDuration(Math.max(0, activeOrderPublicScanGraceUntilMs - nowMs));
  const activeOrderGenerating = activeOrder?.upiExtractionStatus === "GENERATING";
  const activeOrderUpiFailed = activeOrder?.upiExtractionStatus === "FAILED";
  const activeOrderChecking = activeOrder?.status === "CHECKING" || activeOrder?.subscriptionCheckStatus === "CHECKING";
  const activeOrderCheckFailed = activeOrder?.subscriptionCheckStatus === "FAILED";
  const activeOrderCheckRounds = activeOrder?.subscriptionCheckRounds ?? 0;
  const activeOrderCanCheckSubscription = Boolean((activeOrderQrReady || activeOrderInPublicScanGrace) && !activeOrderChecking);
  const walletBalance = stats?.wallet.balance ?? 0;
  const workerAdvanceDebt = Math.max(0, -walletBalance);
  const workerInAdvance = Boolean(worker?.payoutMode === "PREPAID" && workerAdvanceDebt > 0);

  const completeButtonLabel = activeOrderChecking
    ? copy.checkingSubscription
    : activeOrderCheckFailed
      ? copy.recheckSubscription
      : copy.completed;

  useEffect(() => {
    if (!workerId) return;
    const timer = window.setInterval(async () => {
      if (workerStatus === "ONLINE" && autoAcceptEnabled && activeOrderCount < MAX_ACTIVE_ORDERS_PER_WORKER) {
        const picked = await apiFetch<PublicOrder | null>("/api/worker/auto-pick", { method: "POST" }).catch(() => null);
        if (picked) {
          setActiveOrders((current) => upsertActiveOrder(current, picked));
          setActiveOrder(picked);
          previousActiveOrderIdsRef.current = new Set([...Array.from(previousActiveOrderIdsRef.current), picked.id]);
          playNotificationSound();
          showBrowserNotification(
            textFor(language, "已接到新订单", "New order accepted"),
            picked.orderNo
          );
        }
      }
      await refreshAll(true);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [workerId, workerStatus, autoAcceptEnabled, activeOrderCount, refreshAll, playNotificationSound, showBrowserNotification, language]);

  if (!booted) {
    return (
      <AppFrame audience="worker" title={copy.pageTitle} subtitle={copy.loading} language={language} headerActions={<LanguageButton label={copy.switchLanguage} onClick={toggleLanguage} />}>
        <div className="h-[540px] rounded-3xl bg-background shadow-sm" />
      </AppFrame>
    );
  }

  if (!worker) {
    return <TelegramLoginClient purpose="worker" />;
  }

  return (
    <AppFrame audience="worker" title={copy.pageTitle} subtitle={copy.pageSubtitle} onRefresh={() => refreshAll()} language={language} headerActions={<LanguageButton label={copy.switchLanguage} onClick={toggleLanguage} />}>
      <Dialog open={bindWalletOpen} onOpenChange={setBindWalletOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{textFor(language, "绑定 Binance 用户 ID", "Bind Binance user ID")}</DialogTitle>
            <DialogDescription>
              {textFor(language, "提现需要绑定 Binance 用户 ID。绑定后，提现申请会记录当前 UID 快照，方便管理员打款核对。", "Withdrawals require a Binance user ID. Each request stores a snapshot for admin payout verification.")}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="binance-user-id">Binance UID</FieldLabel>
              <Input id="binance-user-id" value={binanceUserIdInput} onChange={(event) => setBinanceUserIdInput(event.target.value)} placeholder="123456789" />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBindWalletOpen(false)}>{textFor(language, "稍后再说", "Later")}</Button>
            <Button onClick={saveBinanceUserId} disabled={loading || !binanceUserIdInput.trim()}>
              {textFor(language, "保存绑定", "Save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <div className="grid gap-4 xl:grid-cols-4">
        <MetricCard title={copy.todayCompleted} value={stats?.todayCompleted ?? 0} description={copy.todayCompletedDesc} icon={ClipboardCheckIcon} tone="success" />
        <MetricCard title={copy.todayAmount} value={formatMoney(stats?.todayAmount)} description={copy.currentUnitPrice(formatMoney(stats?.unitPrice))} icon={DollarSignIcon} tone="warning" />
        <MetricCard title={copy.totalCompleted} value={stats?.totalCompleted ?? 0} description={copy.totalCompletedDesc(formatMoney(stats?.totalAmount), stats?.problemCount ?? 0)} icon={HistoryIcon} tone="brand" />
        <MetricCard title={copy.unsettledAmount} value={formatMoney(stats?.unsettledAmount)} description={copy.unsettledDesc(stats?.unsettledCompleted ?? 0)} icon={Clock3Icon} tone="info" />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[420px_1fr]">
        <div className="flex flex-col gap-4">
          <Card className="rounded-3xl bg-background shadow-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-3">
                <Avatar className="size-10"><AvatarFallback>{worker.displayName.slice(0, 2)}</AvatarFallback></Avatar>
                <span>{worker.displayName}</span>
              </CardTitle>
              <CardDescription>@{worker.username}</CardDescription>
              <CardAction><WorkerStatusBadge status={worker.status} language={language} /></CardAction>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-4">
                <div className="grid grid-cols-2 gap-2">
                  {worker.status === "ONLINE" ? (
                    <Button variant="outline" onClick={goOffline} disabled={loading || activeOrderCount > 0}><WifiOffIcon data-icon="inline-start" />{copy.offline}</Button>
                  ) : (
                    <Button onClick={goOnline} disabled={loading}><WifiIcon data-icon="inline-start" />{copy.online}</Button>
                  )}
                  <Button variant="outline" onClick={logout} disabled={loading}><LogOutIcon data-icon="inline-start" />{copy.logout}</Button>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Link href="/worker/history" className={buttonVariants({ variant: "outline" })}><HistoryIcon data-icon="inline-start" />{copy.goHistory}</Link>
                  <Link href="/worker/withdrawals" className={buttonVariants({ variant: "outline" })}><WalletIcon data-icon="inline-start" />{textFor(language, "提现记录", "Withdrawals")}</Link>
                </div>
                <Separator />
                <div className="flex items-center justify-between gap-3 rounded-2xl bg-muted/40 p-4">
                  <div className="flex items-center gap-3">
                    <div className="grid size-10 place-items-center rounded-2xl bg-background text-muted-foreground shadow-sm"><BotIcon className="size-5" /></div>
                    <div><div className="font-semibold">{copy.autoAccept}</div><div className="text-sm text-muted-foreground">{copy.autoAcceptDesc}</div></div>
                  </div>
                  <Switch
                    checked={worker.autoAcceptEnabled}
                    onCheckedChange={setAutoAccept}
                    disabled={loading || worker.status !== "ONLINE"}
                  />
                </div>
                <div className="flex items-center justify-between gap-3 rounded-2xl bg-muted/40 p-4">
                  <div className="flex items-center gap-3">
                    <div className="grid size-10 place-items-center rounded-2xl bg-background text-muted-foreground shadow-sm"><BellRingIcon className="size-5" /></div>
                    <div>
                      <div className="font-semibold">{copy.autoAcceptNotify}</div>
                      <div className="text-sm text-muted-foreground">
                        {worker.telegramUserId ? copy.autoAcceptNotifyDesc : copy.autoAcceptNotifyNoTelegram}
                      </div>
                    </div>
                  </div>
                  <Switch
                    checked={worker.autoAcceptNotifyEnabled}
                    onCheckedChange={setAutoAcceptNotify}
                    disabled={loading || !worker.telegramUserId}
                  />
                </div>
                <div className="flex items-center justify-between gap-3 rounded-2xl bg-muted/40 p-4">
                  <div className="flex items-center gap-3">
                    <div className="grid size-10 place-items-center rounded-2xl bg-background text-muted-foreground shadow-sm"><Volume2Icon className="size-5" /></div>
                    <div>
                      <div className="font-semibold">{textFor(language, "新订单提醒音", "New order sound")}</div>
                      <div className="text-sm text-muted-foreground">
                        {browserNotifyPermission === "unsupported"
                          ? textFor(language, "开启后播放提醒音；当前浏览器不支持系统通知。", "Play a sound when enabled. This browser does not support system notifications.")
                          : worker.autoAcceptEnabled
                            ? textFor(language, "自动接单开启时，成功接到订单后播放提醒音并发送浏览器通知。", "When auto-accept is on, alerts are sent only after an order is assigned.")
                            : textFor(language, "订单大厅出现新订单时播放提醒音并发送浏览器通知。", "Play a sound and send a browser notification when a new order appears in the hall.")}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="icon-sm"
                      onClick={testNotificationSound}
                      aria-label={textFor(language, "试听提醒", "Test notification sound")}
                      title={textFor(language, "试听提醒", "Test notification sound")}
                    >
                      <Volume2Icon />
                    </Button>
                    <Switch
                      checked={worker.newOrderSoundEnabled}
                      onCheckedChange={setNewOrderSound}
                      disabled={loading}
                    />
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="rounded-3xl bg-background shadow-sm">
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2"><WalletIcon className="size-5 text-brand" />{textFor(language, "钱包", "Wallet")}{workerInAdvance && <Badge variant="secondary">{textFor(language, "预支中", "Advanced")}</Badge>}</CardTitle>
              <CardDescription>
                {worker.payoutMode === "PREPAID"
                  ? textFor(language, "预付费模式：预支款会显示为负余额，完成订单后自动抵扣。", "Prepaid mode: advances show as negative balance and are offset by completed orders.")
                  : textFor(language, "后付费模式：完成订单累计为可结算/可提现余额。", "Postpaid mode: completed orders accumulate into payable/withdrawable balance.")}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-4">
                <div className="grid grid-cols-3 gap-2">
                  <InfoBox label={textFor(language, "钱包余额", "Balance")} value={formatBalance(stats?.wallet.balance)} />
                  <InfoBox label={textFor(language, "可提现", "Available")} value={formatBalance(stats?.wallet.availableBalance)} />
                  <InfoBox label={textFor(language, "待处理提现", "Pending")} value={formatBalance(stats?.wallet.pendingWithdrawalAmount)} />
                </div>
                {workerInAdvance && (
                  <div className="rounded-2xl border border-warning/30 bg-warning/10 p-3 text-sm text-muted-foreground">
                    <div className="font-semibold text-foreground">{textFor(language, "当前处于预支状态", "Currently in advance state")}</div>
                    <div className="mt-1">
                      {textFor(language, "还需抵扣", "Remaining advance to offset")} {formatBalance(workerAdvanceDebt)}
                      {textFor(language, "，完成订单收入会优先自动抵扣预支余额。", ". Completed order earnings will offset this advance first.")}
                    </div>
                  </div>
                )}
                <div className="rounded-2xl bg-muted/40 p-3 text-sm text-muted-foreground">
                  <div className="font-semibold text-foreground">Binance UID</div>
                  <div className="mt-1">{worker.binanceUserId || textFor(language, "未绑定，进入 worker 界面会提醒绑定。", "Not bound. You will be prompted to bind it.")}</div>
                  {worker.binanceUserId ? (
                    <div className="mt-2 text-xs text-muted-foreground">{textFor(language, "已绑定，绑定后不可修改。", "Bound. It cannot be changed after binding.")}</div>
                  ) : (
                    <Button className="mt-3" variant="outline" size="sm" onClick={() => { setBinanceUserIdInput(""); setBindWalletOpen(true); }}>
                      {textFor(language, "绑定 Binance UID", "Bind Binance UID")}
                    </Button>
                  )}
                </div>
                <div className="flex flex-col gap-2 rounded-2xl bg-muted/40 p-3">
                  <FieldGroup>
                    <Field>
                      <FieldLabel htmlFor="withdraw-amount">{textFor(language, "提现金额（USD）", "Withdrawal amount (USD)")}</FieldLabel>
                      <div className="flex gap-2">
                        <Input id="withdraw-amount" className="flex-1" inputMode="decimal" value={withdrawAmount} onChange={(event) => setWithdrawAmount(event.target.value)} placeholder="10.00" />
                        <Button type="button" variant="outline" onClick={() => setWithdrawAmount(formatWithdrawInput(stats?.wallet.availableBalance))} disabled={(stats?.wallet.availableBalance ?? 0) <= 0}>
                          {textFor(language, "全部", "All")}
                        </Button>
                      </div>
                    </Field>
                  </FieldGroup>
                  <Button onClick={requestWithdrawal} disabled={loading || !worker.binanceUserId || Number(withdrawAmount) <= 0}>
                    <DollarSignIcon data-icon="inline-start" />
                    {textFor(language, "申请提现", "Request withdrawal")}
                  </Button>
                </div>
                <div className="flex flex-col gap-3 rounded-2xl bg-muted/40 p-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="font-semibold text-foreground">{textFor(language, "提现记录", "Withdrawal requests")}</div>
                    <div className="mt-1">{textFor(language, "提现申请已移到独立页面，可分页查询并取消待处理申请。", "Withdrawal requests now have a dedicated page with search, pagination, and pending request cancellation.")}</div>
                  </div>
                  <Link href="/worker/withdrawals" className={buttonVariants({ variant: "outline" })}>
                    <WalletIcon data-icon="inline-start" />
                    {textFor(language, "查看提现记录", "View withdrawals")}
                  </Link>
                </div>
              </div>
            </CardContent>
          </Card>


        </div>

        <div className="flex flex-col gap-4">
        {activeOrder && (
        <Card className="rounded-3xl bg-background shadow-sm">
          <CardHeader>
            <CardTitle>{copy.currentOrder}</CardTitle>
            <CardDescription>
              {activeOrder.orderNo} · {activeOrderCount}/{MAX_ACTIVE_ORDERS_PER_WORKER}
            </CardDescription>
            <CardAction>{activeOrder && <OrderStatusBadge status={activeOrder.status} language={language} />}</CardAction>
          </CardHeader>
          <CardContent>
            <div className="mb-4 flex flex-wrap gap-2">
              {activeOrders.map((order, index) => (
                <Button
                  key={order.id}
                  type="button"
                  size="sm"
                  variant={order.id === activeOrder.id ? "default" : "outline"}
                  onClick={() => setActiveOrder(order)}
                  className="rounded-full"
                >
                  #{index + 1} {order.orderNo}
                </Button>
              ))}
            </div>
            {!activeOrder ? (
              <div className="grid min-h-[280px] place-items-center rounded-3xl bg-muted/40 text-center">
                <div className="flex max-w-xs flex-col items-center gap-3"><PackageOpenIcon className="size-10 text-muted-foreground" /><p className="text-sm text-muted-foreground">{copy.noActiveDesc}</p></div>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {activeOrderQrReady ? (
                  <div className="flex flex-col gap-3">
                    <OrderImagePreview
                      src={activeOrder.qrImageUrl}
                      alt={copy.qrAlt}
                      title={activeOrder.orderNo}
                      description={copy.currentOrder}
                      width={420}
                      height={420}
                      className="mx-auto w-full max-w-sm rounded-3xl"
                      imageClassName="aspect-square w-full rounded-3xl bg-muted/40 p-3"
                    />
                    <div className="flex items-center gap-2 rounded-2xl border border-success/30 bg-success/10 p-3 text-sm text-muted-foreground">
                      <Clock3Icon className="size-4 shrink-0 text-success" />
                      <span>{copy.qrValidFor(activeOrderQrRemainingText)}</span>
                    </div>
                    {activeOrder.paymentUrl && (
                      <div className="grid gap-2 sm:grid-cols-2">
                        <a
                          href={activeOrder.paymentUrl}
                          target="_blank"
                          rel="noreferrer"
                          className={buttonVariants({ variant: "outline" })}
                        >
                          <ExternalLinkIcon data-icon="inline-start" />
                          {textFor(language, "打开支付链接", "Open payment link")}
                        </a>
                        <Button variant="outline" onClick={() => copyPaymentLink(activeOrder.paymentUrl)}>
                          <CopyIcon data-icon="inline-start" />
                          {textFor(language, "复制支付链接", "Copy payment link")}
                        </Button>
                      </div>
                    )}
                    {!activeOrderIsPublicScan && (
                      <Button variant="outline" onClick={generateUpiQr} disabled={loading || generatingUpi || activeOrderGenerating || activeOrderChecking}>
                        {generatingUpi || activeOrderGenerating ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <QrCodeIcon data-icon="inline-start" />}
                        {generatingUpi || activeOrderGenerating ? copy.generatingUpi : copy.regenerateUpiShort}
                      </Button>
                    )}
                  </div>
                ) : activeOrderInPublicScanGrace ? (
                  <div className="grid min-h-[300px] place-items-center rounded-3xl border border-warning/30 bg-warning/10 p-6 text-center">
                    <div className="flex max-w-sm flex-col items-center gap-3">
                      <AlertTriangleIcon className="size-10 text-warning" />
                      <div>
                        <div className="font-semibold">
                          {textFor(language, "二维码已到期，正在自动检测", "QR expired, auto-check active")}
                        </div>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {textFor(
                            language,
                            "该扫码订单已被接取，二维码到期后系统会在 5 分钟等待期内自动持续检测订阅状态；检测到 Plus 会自动完成订单。等待期结束仍未成功则订单会自动过期并退款。",
                            "This accepted scan order is checked automatically for 5 minutes after QR expiry. If Plus is detected, the order completes automatically; otherwise it expires and the user hold is refunded."
                          )}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 rounded-2xl border border-warning/30 bg-background/70 px-3 py-2 text-sm text-muted-foreground">
                        <Clock3Icon className="size-4 shrink-0 text-warning" />
                        <span>
                          {textFor(language, "自动检测剩余 ", "Auto-check left ") + activeOrderCheckGraceRemainingText}
                        </span>
                      </div>
                    </div>
                  </div>
                ) : activeOrderQrExpired ? (
                  <div className="grid min-h-[300px] place-items-center rounded-3xl border border-warning/30 bg-warning/10 p-6 text-center">
                    <div className="flex max-w-sm flex-col items-center gap-3">
                      <AlertTriangleIcon className="size-10 text-warning" />
                      <div>
                        <div className="font-semibold">{copy.qrExpiredTitle}</div>
                        <p className="mt-1 text-sm text-muted-foreground">{copy.qrExpiredDesc}</p>
                      </div>
                      {!activeOrderIsPublicScan && (
                        <Button onClick={generateUpiQr} disabled={loading || generatingUpi || activeOrderGenerating}>
                          {generatingUpi || activeOrderGenerating ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <QrCodeIcon data-icon="inline-start" />}
                          {generatingUpi || activeOrderGenerating ? copy.generatingUpi : copy.regenerateUpi}
                        </Button>
                      )}
                      {activeOrderIsPublicScan && (
                        <p className="text-sm text-muted-foreground">
                          {textFor(language, "扫码订单会自动过期并退回用户冻结余额。", "The scan order will expire automatically and refund the user hold.")}
                        </p>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className={cn(
                    "grid min-h-[300px] place-items-center rounded-3xl border p-6 text-center",
                    activeOrderUpiFailed ? "border-destructive/30 bg-destructive/10" : "border-border bg-muted/40"
                  )}>
                    <div className="flex max-w-sm flex-col items-center gap-3">
                      {activeOrderGenerating || generatingUpi ? (
                        <Loader2Icon className="size-10 animate-spin text-muted-foreground" />
                      ) : (
                        <QrCodeIcon className={cn("size-10", activeOrderUpiFailed ? "text-destructive" : "text-muted-foreground")} />
                      )}
                      <div>
                        <div className="font-semibold">
                          {activeOrderIsPublicScan
                            ? textFor(language, "等待用户二维码", "Waiting for user QR")
                            : activeOrderUpiFailed ? copy.upiFailedTitle : copy.upiPendingTitle}
                        </div>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {activeOrderIsPublicScan
                            ? textFor(language, "该扫码订单应由用户发布二维码；如果暂时未显示，请刷新或释放订单。", "This scan order should already include a user QR. Refresh or release it if it is not visible.")
                            : copy.upiPendingDesc}
                        </p>
                        {activeOrder.upiExtractError && <p className="mt-2 text-sm text-destructive">{activeOrder.upiExtractError}</p>}
                      </div>
                      {!activeOrderIsPublicScan && (
                        <Button onClick={generateUpiQr} disabled={loading || generatingUpi || activeOrderGenerating}>
                          {generatingUpi || activeOrderGenerating ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <QrCodeIcon data-icon="inline-start" />}
                          {generatingUpi || activeOrderGenerating ? copy.generatingUpi : copy.generateUpi}
                        </Button>
                      )}
                    </div>
                  </div>
                )}
                {activeOrderQrReady && activeOrder.qrIsUpi === false && (
                  <div className="flex gap-3 rounded-2xl border border-warning/30 bg-warning/10 p-3 text-sm text-muted-foreground">
                    <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-warning" />
                    <div><div className="font-semibold text-foreground">{copy.riskTitle}</div><p className="mt-1">{copy.riskDesc}</p></div>
                  </div>
                )}
                {activeOrderCheckFailed && (
                  <div className="flex gap-3 rounded-2xl border border-warning/30 bg-warning/10 p-3 text-sm text-muted-foreground">
                    <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-warning" />
                    <div>
                      <div className="font-semibold text-foreground">{copy.subscriptionCheckFailedTitle}</div>
                      <p className="mt-1">{copy.subscriptionCheckRetryDesc(activeOrderCheckRounds)}</p>
                      {activeOrder.subscriptionCheckLastPlan && <p className="mt-1">Plan: {activeOrder.subscriptionCheckLastPlan}</p>}
                      {activeOrder.subscriptionCheckLastError && <p className="mt-1 text-destructive">{activeOrder.subscriptionCheckLastError}</p>}
                    </div>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2 text-sm"><InfoBox label={copy.qrVersion} value={"v" + activeOrder.qrVersion} /><InfoBox label={copy.acceptedAt} value={formatDateTimeForLanguage(activeOrder.assignedAt, language)} /></div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Button onClick={completeActive} disabled={loading || !activeOrderCanCheckSubscription}>
                    {loading || activeOrderChecking ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <CheckCircle2Icon data-icon="inline-start" />}
                    {completeButtonLabel}
                  </Button>
                  <Button variant="outline" onClick={releaseActive} disabled={loading || generatingUpi || activeOrderGenerating || activeOrderChecking}>
                    <Undo2Icon data-icon="inline-start" />
                    {textFor(language, "释放订单", "Release order")}
                  </Button>
                </div>
                <div className="flex flex-col gap-2 rounded-2xl bg-muted/40 p-3">
                  <FieldGroup><Field><FieldLabel htmlFor="problem">{copy.problemReason}</FieldLabel><Textarea id="problem" value={problemReason} onChange={(event) => { setProblemTouched(true); setProblemReason(event.target.value); }} /></Field></FieldGroup>
                  <Button variant="destructive" onClick={markProblem} disabled={loading || activeOrderChecking}><AlertTriangleIcon data-icon="inline-start" />{copy.needReupload}</Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
        )}
        <Card className="rounded-3xl bg-background shadow-sm">
          <CardHeader>
            <CardTitle>{copy.hallTitle}</CardTitle>
            <CardDescription>
              {worker.status === "ONLINE"
                ? `${copy.hallOnlineDesc} · Slots ${activeOrderCount}/${MAX_ACTIVE_ORDERS_PER_WORKER}`
                : copy.hallOfflineDesc}
            </CardDescription>
            <CardAction><Button variant="outline" size="sm" onClick={() => refreshAll()}><RefreshCwIcon data-icon="inline-start" />{copy.refresh}</Button></CardAction>
          </CardHeader>
          <CardContent>
            <InputGroup className="mb-3 rounded-full bg-background"><InputGroupAddon><SearchIcon /></InputGroupAddon><InputGroupInput value={search} onChange={(event) => setSearch(event.target.value)} placeholder={copy.searchPlaceholder} /></InputGroup>
            {worker.status !== "ONLINE" ? (
              <div className="grid min-h-[360px] place-items-center rounded-3xl bg-muted/40 text-center"><div className="flex max-w-sm flex-col items-center gap-3"><WifiOffIcon className="size-10 text-muted-foreground" /><div className="font-semibold">{copy.offlineTitle}</div><p className="text-sm text-muted-foreground">{copy.offlineDesc}</p></div></div>
            ) : (
              <div className="overflow-hidden rounded-3xl border border-border">
                <Table><TableHeader><TableRow><TableHead>{copy.order}</TableHead><TableHead>{copy.createdAt}</TableHead><TableHead>{copy.status}</TableHead><TableHead className="text-right">{copy.action}</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {filteredOrders.length === 0 ? (
                      <TableRow><TableCell colSpan={4} className="h-40 text-center text-muted-foreground">{copy.noOrders}</TableCell></TableRow>
                    ) : filteredOrders.map((order) => (
                      <TableRow key={order.id}>
                        <TableCell>
                          <div>
                            <div className="font-semibold">{order.orderNo}</div>
                            <div className="mt-1 text-xs text-muted-foreground">
                              {order.source === "PUBLIC_SCAN"
                                ? `${textFor(language, "扫码订单", "Scan order")} · ${formatMoney(order.scanPrice ?? 0)}`
                                : copy.upiPendingTitle}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>{formatDateTimeForLanguage(order.createdAt, language)}</TableCell>
                        <TableCell><OrderStatusBadge status={order.status} language={language} /></TableCell>
                        <TableCell className="text-right"><Button size="sm" onClick={() => accept(order.id)} disabled={loading || !canAcceptMoreOrders}><PlayCircleIcon data-icon="inline-start" />{copy.accept}</Button></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
        </div>
      </div>
    </AppFrame>
  );
}

function LanguageButton({ label, onClick }: { label: string; onClick: () => void }) {
  return <Button variant="outline" size="sm" onClick={onClick}><Globe2Icon data-icon="inline-start" />{label}</Button>;
}

function formatDateTimeForLanguage(value: string | null | undefined, language: AppLanguage) {
  if (!value) return "-";
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-US", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function formatDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function textFor(language: AppLanguage, zh: string, en: string) {
  return language === "zh" ? zh : en;
}

function upsertActiveOrder(orders: PublicOrder[], order: PublicOrder) {
  const index = orders.findIndex((item) => item.id === order.id);
  if (index === -1) return [...orders, order].slice(0, MAX_ACTIVE_ORDERS_PER_WORKER);
  return orders.map((item, itemIndex) => (itemIndex === index ? order : item));
}

function formatWithdrawInput(value?: number | null) {
  const amount = Math.max(0, Number(value ?? 0));
  return Number.isFinite(amount) ? amount.toFixed(2) : "0.00";
}

function formatBalance(value?: number | null) {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount)) return "$0.00";
  const prefix = amount < 0 ? "-" : "";
  return `${prefix}$${Math.abs(amount).toFixed(2)}`;
}

function InfoBox({ label, value }: { label: string; value: string }) {
  return <div className="rounded-2xl bg-muted/40 p-3"><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 truncate font-semibold">{value}</div></div>;
}
