import type { Response } from "express";

export interface ListResponseMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  [key: string]: any;
}

export function sendList<T>(
  res: Response,
  data: T[],
  totalOrMeta?: number | { page?: number; pageSize?: number; total?: number; totalPages?: number; nextCursor?: string | null; [key: string]: any },
  params?: { page: number; pageSize: number; [key: string]: any },
) {
  let meta: any;
  if (typeof totalOrMeta === "number") {
    const total = totalOrMeta;
    const page = params?.page || 1;
    const pageSize = params?.pageSize || data.length || 25;
    const totalPages = Math.ceil(total / pageSize) || 1;
    meta = {
      page,
      pageSize,
      total,
      totalPages,
      ...params,
    };
  } else if (totalOrMeta && typeof totalOrMeta === "object") {
    meta = totalOrMeta;
  } else {
    meta = {
      page: 1,
      pageSize: data.length,
      total: data.length,
      totalPages: 1,
    };
  }

  res.json({
    data,
    meta,
  });
}

export function sendCreated<T>(res: Response, data: T, meta?: any) {
  res.status(201).json({
    data,
    ...(meta ? { meta } : {}),
  });
}

export function sendOne<T>(res: Response, data: T, meta?: any) {
  res.json({
    data,
    ...(meta ? { meta } : {}),
  });
}
