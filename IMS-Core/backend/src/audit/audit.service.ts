import { Injectable, Logger } from '@nestjs/common';
import { AuditActorType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../common/types/request';
import type { ClientContext } from '../common/utils/request-context';
import { Paginated, Pagination, toSkipTake } from '../common/utils/request-context';

export interface AuditEntry {
  actorType: AuditActorType;
  actorId?: string | null;
  actorName?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  success?: boolean;
  metadata?: Record<string, unknown>;
  context?: ClientContext;
}

/** Keys that must never end up in audit metadata. */
const SENSITIVE_KEY = /(pass(word)?|secret|token|key|authorization|cookie)/i;

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrub(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : scrub(v, depth + 1);
  }
  return out;
}

/**
 * Append-only audit trail. Writing an audit record must never break the
 * business operation, so failures are logged and swallowed.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          actorType: entry.actorType,
          actorId: entry.actorId ?? null,
          actorName: entry.actorName ?? null,
          action: entry.action,
          targetType: entry.targetType ?? null,
          targetId: entry.targetId ?? null,
          success: entry.success ?? true,
          metadata: entry.metadata ? (scrub(entry.metadata) as Prisma.InputJsonValue) : undefined,
          ipAddress: entry.context?.ip ?? null,
          userAgent: entry.context?.userAgent ?? null,
        },
      });
    } catch (err) {
      this.logger.error(`Failed to write audit log for ${entry.action}: ${(err as Error).message}`);
    }
  }

  /** Convenience wrapper for actions performed by a dashboard user. */
  async byUser(user: Pick<AuthUser, 'id' | 'username'>, action: string, target: { type?: string; id?: string } = {}, metadata?: Record<string, unknown>, context?: ClientContext): Promise<void> {
    await this.record({ actorType: 'USER', actorId: user.id, actorName: user.username, action, targetType: target.type, targetId: target.id, metadata, context });
  }

  async list(filter: { action?: string; actorId?: string; targetType?: string; targetId?: string }, pagination: Pagination): Promise<Paginated<unknown>> {
    const where: Prisma.AuditLogWhereInput = {
      ...(filter.action ? { action: { startsWith: filter.action } } : {}),
      ...(filter.actorId ? { actorId: filter.actorId } : {}),
      ...(filter.targetType ? { targetType: filter.targetType } : {}),
      ...(filter.targetId ? { targetId: filter.targetId } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, ...toSkipTake(pagination) }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { items: items.map((i) => ({ ...i, id: i.id.toString() })), total, page: pagination.page, pageSize: pagination.pageSize };
  }
}
