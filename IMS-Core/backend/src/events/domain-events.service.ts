import { Global, Injectable, Logger, Module } from '@nestjs/common';
import type { Alert, BackupJob, BackupRun, Server } from '@prisma/client';

/** In-process domain events. Producers never depend on their consumers. */
export interface DomainEventMap {
  'backup.finished': { run: BackupRun; job: BackupJob; server: Pick<Server, 'id' | 'name' | 'nodeId'> };
  'node.online': { serverId: string };
  'node.offline': { serverId: string; lastHeartbeatAt: Date | null };
  'alert.opened': { alert: Alert };
  'alert.resolved': { alert: Alert };
  'agent.update.finished': { serverId: string; version: string; succeeded: boolean; error?: string };
  'core.update.finished': { fromVersion: string; toVersion: string; status: 'SUCCEEDED' | 'FAILED' | 'ROLLED_BACK' | 'RUNNING' | 'REQUESTED'; message?: string };
}

type Handler<K extends keyof DomainEventMap> = (payload: DomainEventMap[K]) => Promise<void> | void;

@Injectable()
export class DomainEvents {
  private readonly logger = new Logger(DomainEvents.name);
  private readonly handlers = new Map<keyof DomainEventMap, Handler<never>[]>();

  on<K extends keyof DomainEventMap>(event: K, handler: Handler<K>): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler as Handler<never>]);
  }

  /** Runs all handlers; a failing handler never breaks the producer or other handlers. */
  async emit<K extends keyof DomainEventMap>(event: K, payload: DomainEventMap[K]): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) {
      try {
        await (handler as Handler<K>)(payload);
      } catch (err) {
        this.logger.error(`Handler for ${event} failed: ${(err as Error).message}`);
      }
    }
  }
}

@Global()
@Module({ providers: [DomainEvents], exports: [DomainEvents] })
export class EventsModule {}
