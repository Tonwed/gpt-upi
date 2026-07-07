"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BellIcon,
  ClipboardListIcon,
  CompassIcon,
  CrownIcon,
  DatabaseIcon,
  Globe2Icon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  ReceiptTextIcon,
  RefreshCwIcon,
  SendIcon,
  UsersRoundIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AppLanguage } from "@/lib/client/language";
import { cn } from "@/lib/utils";

type AppAudience = "customer" | "worker" | "admin";

type AdminNavItem = {
  href: string;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
};

const audienceMeta: Record<AppAudience, { suffix: string }> = {
  customer: { suffix: "Client" },
  worker: { suffix: "Workbench" },
  admin: { suffix: "Admin" },
};

const topbarCopy: Record<AppLanguage, {
  chip: Record<AppAudience, string>;
  scannerGroup: string;
  scannerGroupShort: string;
  refresh: string;
  notification: string;
}> = {
  zh: {
    chip: {
      customer: "客户界面",
      worker: "接单界面",
      admin: "管理后台",
    },
    scannerGroup: "加入 Scanner TG Group",
    scannerGroupShort: "TG 群",
    refresh: "刷新",
    notification: "通知",
  },
  en: {
    chip: {
      customer: "Client",
      worker: "Worker",
      admin: "Admin",
    },
    scannerGroup: "Join Scanner TG Group",
    scannerGroupShort: "TG Group",
    refresh: "Refresh",
    notification: "Notifications",
  },
};

const adminNavItems: AdminNavItem[] = [
  { href: "/admin", label: "总览", description: "Dashboard", icon: LayoutDashboardIcon },
  { href: "/admin/users", label: "用户管理", description: "Users", icon: UsersRoundIcon },
  { href: "/admin/cdks", label: "充值 CDK", description: "Recharge keys", icon: KeyRoundIcon },
  { href: "/admin/workers", label: "接单账号", description: "Workers", icon: UsersRoundIcon },
  { href: "/admin/orders", label: "订单列表", description: "Orders", icon: ClipboardListIcon },
  { href: "/admin/billing", label: "充值账单", description: "Billing", icon: ReceiptTextIcon },
  { href: "/admin/proxies", label: "代理池", description: "Proxies", icon: Globe2Icon },
  { href: "/admin/upi-extract", label: "提取记录", description: "UPI Extract", icon: DatabaseIcon },
];

const SCANNER_TG_GROUP_URL = process.env.NEXT_PUBLIC_SCANNER_TG_GROUP_URL || "https://t.me/your_scanner_group";

function isAdminNavActive(pathname: string, href: string) {
  if (href === "/admin") return pathname === "/admin";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function PageHeader({
  title,
  subtitle,
  hidePageHeader,
}: {
  title: string;
  subtitle?: string;
  hidePageHeader?: boolean;
}) {
  if (hidePageHeader) return null;

  return (
    <section className="mb-5 flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
      <div className="flex items-center gap-4">
        <div className="hidden size-16 place-items-center rounded-3xl bg-background shadow-[0_20px_60px_rgba(0,0,0,0.08)] ring-1 ring-foreground/10 sm:grid">
          <CompassIcon className="size-7 text-brand" />
        </div>
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">{title}</h1>
          {subtitle && <p className="max-w-2xl text-sm text-muted-foreground">{subtitle}</p>}
        </div>
      </div>
    </section>
  );
}

function AdminSidebar({ onRefresh }: { onRefresh?: () => void }) {
  const pathname = usePathname();

  return (
    <aside className="border-b border-border/70 bg-background/95 shadow-sm backdrop-blur-xl lg:fixed lg:inset-y-0 lg:left-0 lg:z-30 lg:w-72 lg:border-b-0 lg:border-r">
      <div className="flex min-h-full flex-col gap-4 p-4 lg:p-5">
        <div className="flex items-center justify-between gap-3 rounded-3xl border border-border/70 bg-muted/30 px-4 py-3">
          <Link href="/admin" className="flex min-w-0 items-center gap-3">
            <div className="grid size-10 shrink-0 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-sm">
              <CrownIcon className="size-5" />
            </div>
            <div className="min-w-0">
              <div className="truncate text-lg font-semibold leading-none tracking-tight">
                <span className="text-brand">UPI</span> Admin
              </div>
              <div className="mt-1 text-xs font-medium text-muted-foreground">管理后台</div>
            </div>
          </Link>
          {onRefresh && (
            <Button variant="outline" size="icon-sm" onClick={onRefresh} aria-label="刷新">
              <RefreshCwIcon />
            </Button>
          )}
        </div>

        <nav className="hidden flex-1 flex-col gap-1.5 lg:flex" aria-label="管理后台导航">
          {adminNavItems.map((item) => {
            const active = isAdminNavActive(pathname, item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "group flex items-center gap-3 rounded-2xl px-3 py-3 text-sm font-medium transition",
                  active
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <span
                  className={cn(
                    "grid size-9 shrink-0 place-items-center rounded-xl transition",
                    active ? "bg-primary-foreground/15" : "bg-muted/70 group-hover:bg-background",
                  )}
                >
                  <Icon className="size-4" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate">{item.label}</span>
                  <span className={cn("block truncate text-xs", active ? "text-primary-foreground/70" : "text-muted-foreground")}>
                    {item.description}
                  </span>
                </span>
              </Link>
            );
          })}
        </nav>

        <nav className="-mx-1 flex gap-2 overflow-x-auto pb-1 lg:hidden" aria-label="管理后台导航">
          {adminNavItems.map((item) => {
            const active = isAdminNavActive(pathname, item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex shrink-0 items-center gap-2 rounded-full border px-3 py-2 text-sm font-medium transition",
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <Icon className="size-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </aside>
  );
}

export function AppFrame({
  title,
  subtitle,
  children,
  onRefresh,
  audience = "customer",
  simpleHeader = false,
  hidePageHeader = false,
  hideTopbar = false,
  headerActions,
  language = "zh",
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  onRefresh?: () => void;
  audience?: AppAudience;
  simpleHeader?: boolean;
  hidePageHeader?: boolean;
  hideTopbar?: boolean;
  headerActions?: React.ReactNode;
  language?: AppLanguage;
}) {
  const meta = audienceMeta[audience];
  const copy = topbarCopy[language];

  if (audience === "admin" && !simpleHeader) {
    return (
      <div className="min-h-screen bg-soft text-foreground lg:pl-72">
        <AdminSidebar onRefresh={onRefresh} />
        <main className="mx-auto max-w-[1800px] px-5 pb-12 pt-6 lg:px-8 lg:pt-8">
          <PageHeader title={title} subtitle={subtitle} hidePageHeader={hidePageHeader} />
          {children}
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-soft text-foreground">
      {!hideTopbar && (
        <header className="sticky top-0 isolate border-b border-border/60 bg-background/80 backdrop-blur-xl">
          <div className="mx-auto flex max-w-[1800px] items-center justify-between gap-4 px-5 py-3 lg:px-8">
            <div className="flex items-center gap-3">
              <div className="grid size-9 place-items-center rounded-full bg-primary text-primary-foreground shadow-sm">
                <CrownIcon className="size-5" />
              </div>
              <div className="flex items-baseline gap-1.5 text-lg font-semibold tracking-tight">
                <span className="text-brand">UPI</span>
                <span>{meta.suffix}</span>
              </div>
            </div>

            {!simpleHeader && (
              <div className="hidden rounded-full border border-border/70 bg-background px-3 py-1.5 text-sm font-medium text-muted-foreground shadow-sm md:block">
                {copy.chip[audience]}
              </div>
            )}

            {!simpleHeader ? (
              <div className="flex items-center gap-2">
                {audience === "worker" && (
                  <a
                    href={SCANNER_TG_GROUP_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-9 items-center justify-center gap-2 rounded-full bg-brand px-4 text-sm font-semibold text-white shadow-sm shadow-brand/20 transition hover:bg-brand/90"
                  >
                    <SendIcon className="size-4" />
                    <span className="hidden sm:inline">{copy.scannerGroup}</span>
                    <span className="sm:hidden">{copy.scannerGroupShort}</span>
                  </a>
                )}
                {headerActions}
                {onRefresh && (
                  <Button variant="outline" size="sm" onClick={onRefresh}>
                    <RefreshCwIcon data-icon="inline-start" />
                    {copy.refresh}
                  </Button>
                )}
                <Button variant="ghost" size="icon-sm" aria-label={copy.notification}>
                  <BellIcon />
                </Button>
              </div>
            ) : (
              <div className="size-9" aria-hidden />
            )}
          </div>
        </header>
      )}

      <main className="mx-auto max-w-[1800px] px-5 pb-12 pt-8 lg:px-8">
        <PageHeader title={title} subtitle={subtitle} hidePageHeader={hidePageHeader} />
        {children}
      </main>
    </div>
  );
}
