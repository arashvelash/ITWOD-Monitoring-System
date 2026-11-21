import type { Request } from 'express';
import { z } from 'zod';

export interface ClientContext {
  ip: string | null;
  userAgent: string | null;
}

export function getClientContext(req: Request): ClientContext {
  const ua = req.get('user-agent');
  return {
    ip: (req.ip ?? req.socket?.remoteAddress ?? null)?.slice(0, 64) ?? null,
    userAgent: ua ? ua.slice(0, 512) : null,
  };
}

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

export type Pagination = z.infer<typeof paginationSchema>;

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export function toSkipTake(p: Pagination): { skip: number; take: number } {
  return { skip: (p.page - 1) * p.pageSize, take: p.pageSize };
}

export const uuidParam = z.string().uuid();

/** Recursively converts BigInt values so they can be serialised to JSON. */
export function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? Number(v) : v))) as T;
}
