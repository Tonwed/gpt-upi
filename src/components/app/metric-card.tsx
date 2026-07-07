import type { LucideIcon } from "lucide-react";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function MetricCard({
  title,
  value,
  description,
  icon: Icon,
  tone = "default",
}: {
  title: string;
  value: string | number;
  description?: string;
  icon: LucideIcon;
  tone?: "default" | "success" | "warning" | "info" | "brand";
}) {
  const dotTone = {
    default: "bg-muted-foreground",
    success: "bg-success",
    warning: "bg-warning",
    info: "bg-info",
    brand: "bg-brand",
  }[tone];

  return (
    <Card className="rounded-3xl bg-background shadow-sm">
      <CardHeader>
        <CardTitle className="text-4xl font-semibold tracking-tight">{value}</CardTitle>
        <CardDescription className="flex items-center gap-2 font-medium">
          <span className={cn("size-2.5 rounded-full", dotTone)} />
          {title}
        </CardDescription>
        <CardAction>
          <div className="grid size-10 place-items-center rounded-2xl bg-muted text-muted-foreground">
            <Icon className="size-5" />
          </div>
        </CardAction>
      </CardHeader>
      {description && <CardContent className="text-sm text-muted-foreground">{description}</CardContent>}
    </Card>
  );
}
