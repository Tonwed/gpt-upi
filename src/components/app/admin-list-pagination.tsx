"use client";

import { Button } from "@/components/ui/button";
import type { AdminPaginationMeta } from "@/lib/types/app";
import { cn } from "@/lib/utils";

export function AdminListPagination({
  pagination,
  loading,
  onPageChange,
  className,
}: {
  pagination?: AdminPaginationMeta | null;
  loading?: boolean;
  onPageChange: (page: number) => void;
  className?: string;
}) {
  if (!pagination || pagination.totalPages <= 1 && pagination.total <= pagination.pageSize) {
    return pagination ? (
      <div className={cn("flex items-center justify-end text-xs text-muted-foreground", className)}>
        共 {pagination.total} 条
      </div>
    ) : null;
  }

  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-3 text-sm", className)}>
      <div className="text-xs text-muted-foreground">
        第 {pagination.page} / {pagination.totalPages} 页，共 {pagination.total} 条，每页 {pagination.pageSize} 条
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loading || !pagination.hasPrev}
          onClick={() => onPageChange(Math.max(1, pagination.page - 1))}
        >
          上一页
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loading || !pagination.hasNext}
          onClick={() => onPageChange(Math.min(pagination.totalPages, pagination.page + 1))}
        >
          下一页
        </Button>
      </div>
    </div>
  );
}
