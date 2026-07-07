export type AdminPaginationMeta = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasPrev: boolean;
  hasNext: boolean;
  search: string;
};

export type AdminPaginatedResponse<T> = {
  items: T[];
  pagination: AdminPaginationMeta;
};

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function parsePositiveInt(value: string | null, fallback: number) {
  const parsed = Number(value || "");
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function parseAdminPagination(request: Request, options?: { defaultPageSize?: number; maxPageSize?: number }) {
  const url = new URL(request.url);
  const maxPageSize = options?.maxPageSize ?? MAX_PAGE_SIZE;
  const defaultPageSize = Math.min(options?.defaultPageSize ?? DEFAULT_PAGE_SIZE, maxPageSize);
  const page = parsePositiveInt(url.searchParams.get("page"), 1);
  const rawPageSize = parsePositiveInt(url.searchParams.get("pageSize"), defaultPageSize);
  const pageSize = Math.min(Math.max(rawPageSize, 1), maxPageSize);
  const search = String(url.searchParams.get("search") || "").trim().slice(0, 120);
  return {
    page,
    pageSize,
    skip: (page - 1) * pageSize,
    take: pageSize,
    search,
    url,
    isPaged: url.searchParams.get("paged") === "1",
  };
}

export function createPaginationMeta(input: { page: number; pageSize: number; total: number; search?: string }): AdminPaginationMeta {
  const totalPages = Math.max(1, Math.ceil(input.total / input.pageSize));
  const page = Math.min(Math.max(input.page, 1), totalPages);
  return {
    page,
    pageSize: input.pageSize,
    total: input.total,
    totalPages,
    hasPrev: page > 1,
    hasNext: page < totalPages,
    search: input.search || "",
  };
}

export function paginatedPayload<T>(items: T[], input: { page: number; pageSize: number; total: number; search?: string }): AdminPaginatedResponse<T> {
  return {
    items,
    pagination: createPaginationMeta(input),
  };
}

export function paginateArray<T>(items: T[], input: { page: number; pageSize: number; search?: string }): AdminPaginatedResponse<T> {
  const total = items.length;
  const page = Math.min(Math.max(input.page, 1), Math.max(1, Math.ceil(total / input.pageSize)));
  const start = (page - 1) * input.pageSize;
  return paginatedPayload(items.slice(start, start + input.pageSize), {
    page,
    pageSize: input.pageSize,
    total,
    search: input.search,
  });
}

export function containsInsensitive(value: string) {
  return { contains: value, mode: "insensitive" as const };
}
