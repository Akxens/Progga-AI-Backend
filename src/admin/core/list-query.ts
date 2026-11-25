import type { Request } from "express";
import { badRequest } from "../../lib/errors";

export interface ListQuerySpec {
  defaultPageSize?: number;
  allowedSortFields?: readonly string[] | string[];
  defaultSortField?: string;
  defaultSortOrder?: "asc" | "desc";
}

export interface ListQueryParams {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
  search?: string;
  sortBy: string;
  sortOrder: "asc" | "desc";
  from?: string;
  to?: string;
  filters: Record<string, string>;
}

export function parseListQuery(req: Request, spec: ListQuerySpec = {}): ListQueryParams {
  // Page
  let page = 1;
  if (req.query.page !== undefined) {
    const parsedPage = parseInt(req.query.page as string, 10);
    if (isNaN(parsedPage) || parsedPage < 1) {
      throw badRequest("page must be an integer >= 1");
    }
    page = parsedPage;
  }

  // PageSize: 10 | 25 | 50 | 100
  const allowedSizes = [10, 25, 50, 100];
  let pageSize = spec.defaultPageSize || 25;
  if (req.query.pageSize !== undefined) {
    const parsedSize = parseInt(req.query.pageSize as string, 10);
    if (!allowedSizes.includes(parsedSize)) {
      throw badRequest(`pageSize must be one of ${allowedSizes.join(", ")}`);
    }
    pageSize = parsedSize;
  }

  const skip = (page - 1) * pageSize;
  const take = pageSize;

  // Search
  let search: string | undefined;
  if (typeof req.query.search === "string") {
    const trimmed = req.query.search.trim();
    if (trimmed.length > 100) {
      throw badRequest("search query must be <= 100 characters");
    }
    search = trimmed.length > 0 ? trimmed : undefined;
  }

  // Sort
  let sortBy = spec.defaultSortField || "createdAt";
  let sortOrder: "asc" | "desc" = spec.defaultSortOrder || "desc";

  // Check sort param (either sort="field" / sort="-field" or sortBy="field" & sortOrder="asc"|"desc")
  if (typeof req.query.sort === "string" && req.query.sort.trim()) {
    const s = req.query.sort.trim();
    if (s.startsWith("-")) {
      sortBy = s.slice(1);
      sortOrder = "desc";
    } else {
      sortBy = s;
      sortOrder = "asc";
    }
  } else if (typeof req.query.sortBy === "string" && req.query.sortBy.trim()) {
    sortBy = req.query.sortBy.trim();
    if (req.query.sortOrder === "asc" || req.query.sortOrder === "desc") {
      sortOrder = req.query.sortOrder;
    }
  }

  if (spec.allowedSortFields && spec.allowedSortFields.length > 0) {
    if (!spec.allowedSortFields.includes(sortBy)) {
      sortBy = spec.defaultSortField || "createdAt";
    }
  }

  // Dates: from / to YYYY-MM-DD
  const from = typeof req.query.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : undefined;
  const to = typeof req.query.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : undefined;

  if (from && to && from > to) {
    throw badRequest("'to' date must be >= 'from' date");
  }

  // Other filters
  const filters: Record<string, string> = {};
  for (const [key, val] of Object.entries(req.query)) {
    if (
      !["page", "pageSize", "search", "sort", "sortBy", "sortOrder", "from", "to"].includes(key) &&
      typeof val === "string"
    ) {
      filters[key] = val;
    }
  }

  return {
    page,
    pageSize,
    skip,
    take,
    search,
    sortBy,
    sortOrder,
    from,
    to,
    filters,
  };
}
