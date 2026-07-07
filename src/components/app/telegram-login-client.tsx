"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BotIcon, CheckCircle2Icon, Clock3Icon, CopyIcon, Globe2Icon, Loader2Icon, RefreshCwIcon, SendIcon } from "lucide-react";
import { toast } from "sonner";
import { AppFrame } from "@/components/app/app-frame";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { apiFetch } from "@/lib/api-client";
import { useAppLanguage, type AppLanguage } from "@/lib/client/language";
import { cn } from "@/lib/utils";

const TELEGRAM_BOT_USERNAME = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME || "your_bot_username";

type Purpose = "worker" | "admin";
type ChallengeStatus = "PENDING" | "APPROVED" | "USED" | "EXPIRED";

type ChallengeData = {
  id: string;
  code: string;
  purpose: Purpose;
  status: ChallengeStatus;
  expiresAt: string;
};

type ChallengePollData = {
  status: ChallengeStatus;
  expiresAt?: string;
  redirectTo?: string;
};

type LoginCopy = {
  purposes: Record<Purpose, { title: string; subtitle: string; note: string; commandPlaceholder: string }>;
  confirmTitle: string;
  refreshCode: string;
  oneTimeCode: string;
  generating: string;
  approved: string;
  used: string;
  expired: string;
  waiting: string;
  secondsLeft: (seconds: number) => string;
  sendToBot: string;
  copyCommand: string;
  openBot: string;
  manualTip: string;
  copied: string;
  createFailed: string;
  pollFailed: string;
  confirmedTip: string;
  switchLanguage: string;
};

const COPY: Record<AppLanguage, LoginCopy> = {
  zh: {
    purposes: {
      worker: {
        title: "接单方 Telegram 登录",
        subtitle: "网页生成一次性代码，把代码发送给 Telegram Bot 后会自动进入工作台。",
        note: "只有后台已登记 Telegram ID 或用户名的 worker 可以确认登录。",
        commandPlaceholder: "/worker 8位登录代码",
      },
      admin: {
        title: "管理员 Telegram 登录",
        subtitle: "网页生成一次性代码，把代码发送给 Telegram Bot 后会自动进入管理后台。",
        note: "管理员登录仅允许环境变量配置的 Telegram 管理员确认。",
        commandPlaceholder: "/admin 8位登录代码",
      },
    },
    confirmTitle: "Telegram Bot 确认登录",
    refreshCode: "换一个代码",
    oneTimeCode: "网页一次性登录代码",
    generating: "正在生成登录代码…",
    approved: "Telegram 已确认，正在进入…",
    used: "登录已完成",
    expired: "登录代码已过期，请重新生成。",
    waiting: "等待你在 Telegram Bot 中发送登录代码。",
    secondsLeft: (seconds) => "剩余 " + seconds + " 秒",
    sendToBot: "发送给 Telegram Bot",
    copyCommand: "复制命令",
    openBot: "打开 Bot 并确认",
    manualTip: "如果 Telegram 没有自动发送，请在 Bot 聊天窗口中点击 Start，或手动发送上面的命令。",
    copied: "登录命令已复制",
    createFailed: "生成登录代码失败",
    pollFailed: "检查登录状态失败",
    confirmedTip: "Telegram 已确认，页面会自动跳转。",
    switchLanguage: "EN",
  },
  en: {
    purposes: {
      worker: {
        title: "Worker Telegram Login",
        subtitle: "The page generates a one-time code. Send it to the Telegram Bot to enter the workbench.",
        note: "Only workers registered by Telegram ID or username can confirm login.",
        commandPlaceholder: "/worker 8-char login code",
      },
      admin: {
        title: "Admin Telegram Login",
        subtitle: "The page generates a one-time code. Send it to the Telegram Bot to enter the admin panel.",
        note: "Admin login is restricted to the Telegram admin configured in environment variables.",
        commandPlaceholder: "/admin 8-char login code",
      },
    },
    confirmTitle: "Confirm with Telegram Bot",
    refreshCode: "New code",
    oneTimeCode: "One-time web login code",
    generating: "Generating login code…",
    approved: "Telegram confirmed. Entering…",
    used: "Login completed",
    expired: "The login code has expired. Generate a new one.",
    waiting: "Waiting for you to send the login code to the Telegram Bot.",
    secondsLeft: (seconds) => String(seconds) + "s left",
    sendToBot: "Send to Telegram Bot",
    copyCommand: "Copy command",
    openBot: "Open Bot and confirm",
    manualTip: "If Telegram does not send it automatically, tap Start in the Bot chat or manually send the command above.",
    copied: "Login command copied",
    createFailed: "Failed to generate login code",
    pollFailed: "Failed to check login status",
    confirmedTip: "Telegram confirmed. The page will redirect automatically.",
    switchLanguage: "中文",
  },
};

export function TelegramLoginClient({ purpose }: { purpose: Purpose }) {
  const { language, toggleLanguage } = useAppLanguage();
  const [challenge, setChallenge] = useState<ChallengeData | null>(null);
  const [status, setStatus] = useState<ChallengeStatus>("PENDING");
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(0);
  const startedRef = useRef(false);
  const copy = COPY[language];
  const purposeText = copy.purposes[purpose];

  const expiresAt = challenge?.expiresAt ? new Date(challenge.expiresAt).getTime() : 0;
  const remainingSeconds = expiresAt ? Math.max(0, Math.ceil((expiresAt - now) / 1000)) : 0;
  const botCommand = challenge ? "/login " + challenge.code : purposeText.commandPlaceholder;
  const botDeepLink = challenge
    ? "https://t.me/" + TELEGRAM_BOT_USERNAME + "?start=" + encodeURIComponent("login_" + challenge.code)
    : "https://t.me/" + TELEGRAM_BOT_USERNAME;

  const statusText = useMemo(() => {
    if (!challenge) return copy.generating;
    if (status === "APPROVED") return copy.approved;
    if (status === "USED") return copy.used;
    if (status === "EXPIRED" || remainingSeconds <= 0) return copy.expired;
    return copy.waiting;
  }, [challenge, copy, remainingSeconds, status]);

  const createChallenge = useCallback(async () => {
    try {
      setLoading(true);
      const data = await apiFetch<ChallengeData>("/api/tg-login/challenge", {
        method: "POST",
        body: JSON.stringify({ purpose }),
      });
      setChallenge(data);
      setStatus(data.status);
      setNow(Date.now());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy.createFailed);
    } finally {
      setLoading(false);
    }
  }, [copy.createFailed, purpose]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void createChallenge();
  }, [createChallenge]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!challenge || status === "APPROVED" || status === "USED" || status === "EXPIRED") return;

    const poll = async () => {
      try {
        const data = await apiFetch<ChallengePollData>("/api/tg-login/challenge/" + challenge.id + "?purpose=" + purpose);
        setStatus(data.status);
        if (data.status === "APPROVED" && data.redirectTo) {
          window.location.href = data.redirectTo;
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : copy.pollFailed);
      }
    };

    const timer = window.setInterval(() => void poll(), 2000);
    void poll();
    return () => window.clearInterval(timer);
  }, [challenge, copy.pollFailed, purpose, status]);

  async function copyCommand() {
    if (!challenge) return;
    await navigator.clipboard.writeText(botCommand);
    toast.success(copy.copied);
  }

  return (
    <AppFrame audience={purpose === "admin" ? "admin" : "worker"} title={purposeText.title} subtitle={purposeText.subtitle} simpleHeader>
      <div className="mx-auto max-w-xl">
        <Card className="rounded-3xl bg-background shadow-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BotIcon className="size-5 text-brand" />
              {copy.confirmTitle}
            </CardTitle>
            <CardDescription>{purposeText.note}</CardDescription>
            <CardAction>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={toggleLanguage}>
                  <Globe2Icon data-icon="inline-start" />
                  {copy.switchLanguage}
                </Button>
                <Button variant="outline" size="sm" onClick={createChallenge} disabled={loading}>
                  <RefreshCwIcon data-icon="inline-start" />
                  {copy.refreshCode}
                </Button>
              </div>
            </CardAction>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-5">
              <div className="rounded-3xl bg-muted/40 p-5 text-center">
                <div className="text-sm text-muted-foreground">{copy.oneTimeCode}</div>
                <div className="mt-3 font-mono text-4xl font-semibold tracking-[0.18em] text-brand sm:text-5xl">
                  {challenge?.code || "--------"}
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-center gap-2 text-sm text-muted-foreground">
                  {loading ? <Loader2Icon className="size-4 animate-spin" /> : <Clock3Icon className="size-4" />}
                  <span>{statusText}</span>
                  {challenge && status === "PENDING" && <span>{copy.secondsLeft(remainingSeconds)}</span>}
                </div>
              </div>

              <div className="rounded-2xl border border-border p-4">
                <div className="text-sm font-semibold">{copy.sendToBot}</div>
                <div className="mt-2 rounded-2xl bg-muted/40 px-4 py-3 font-mono text-lg">{botCommand}</div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button type="button" onClick={copyCommand} disabled={!challenge}>
                    <CopyIcon data-icon="inline-start" />
                    {copy.copyCommand}
                  </Button>
                  <a
                    href={botDeepLink}
                    target="_blank"
                    rel="noreferrer"
                    aria-disabled={!challenge}
                    className={cn(buttonVariants({ variant: "outline" }), !challenge && "pointer-events-none opacity-50")}
                  >
                    <SendIcon data-icon="inline-start" />
                    {copy.openBot}
                  </a>
                </div>
                <p className="mt-3 text-xs text-muted-foreground">{copy.manualTip}</p>
              </div>

              {status === "APPROVED" && (
                <div className="flex items-center gap-2 rounded-2xl bg-success/10 p-4 text-sm text-success">
                  <CheckCircle2Icon className="size-4" />
                  {copy.confirmedTip}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </AppFrame>
  );
}
