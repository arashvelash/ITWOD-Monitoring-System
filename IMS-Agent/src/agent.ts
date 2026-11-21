import type { KeyObject } from 'node:crypto';
import { CoreClient } from './core-client';
import { toWsUrl } from './core-url';
import { loadIdentity, loadPrivateKey, type Identity } from './identity';
import { createLogger } from './logger';
import { agentPaths, type AgentPaths } from './paths';
import type { SignedCommand } from './protocol';
import { systemSummary } from './system-info';
import { AGENT_VERSION } from './version';
import { WsClient, type AuthOk } from './ws-client';
import { CommandService } from '../services/command.service';
import { ConfigService } from '../services/config.service';
import { OutboxService } from '../services/outbox.service';
import { SchedulerService } from '../services/scheduler.service';
import { BackupService } from '../services/backup.service';
import { MonitorService } from '../services/monitor.service';
import { UpdateService } from '../updater/update.service';

const log = createLogger('agent');

/**
 * Wires all agent services together:
 *  WsClient (realtime) + CoreClient (HTTPS) → CommandService → handlers
 *  ConfigService → SchedulerService → BackupService → OutboxService
 *  MonitorService → metrics frames
 */
export class Agent {
  readonly ws: WsClient;
  readonly client: CoreClient;
  readonly config: ConfigService;
  readonly outbox: OutboxService;
  readonly commands: CommandService;
  readonly scheduler: SchedulerService;
  readonly backups: BackupService;
  readonly monitor: MonitorService;
  readonly updates: UpdateService;
  private heartbeatTimer?: NodeJS.Timeout;
  private flushTimer?: NodeJS.Timeout;
  private heartbeatIntervalSec = 30;

  constructor(
    readonly identity: Identity,
    privateKey: KeyObject,
    readonly paths: AgentPaths,
  ) {
    this.client = new CoreClient({ coreUrl: identity.coreUrl, nodeId: identity.nodeId, nodeSecret: identity.nodeSecret, privateKey });
    this.ws = new WsClient({ url: toWsUrl(identity.coreUrl, '/ws/agent'), nodeId: identity.nodeId, nodeSecret: identity.nodeSecret, privateKey });
    this.outbox = new OutboxService(paths.outboxDir, () => this.client);
    this.config = new ConfigService(paths.configCacheFile, identity.nodeSecret, () => this.client);
    this.commands = new CommandService(identity.nodeSecret, paths.executedCommandsFile, {
      ack: (commandId) => void this.ws.send({ type: 'command.ack', commandId }),
      result: (commandId, status, result, error) => this.reportReliable('command.result', { commandId, status, ...(result ? { result } : {}), ...(error ? { error } : {}) }),
    });
    this.backups = new BackupService(this.config, paths, (data) => this.reportReliable('backup.report', data));
    this.scheduler = new SchedulerService(paths.scheduleStateFile, (job, scheduledFor) => this.backups.runScheduled(job, scheduledFor));
    this.monitor = new MonitorService(() => this.config.current.monitoring.services, (data) => this.ws.send({ type: 'metrics', data }));
    this.updates = new UpdateService(paths, this.client, (commandId, status, result, error) => this.reportReliable('command.result', { commandId, status, ...(result ? { result } : {}), ...(error ? { error } : {}) }));
    this.registerCommands();
  }

  static async fromDisk(paths: AgentPaths = agentPaths()): Promise<Agent> {
    const identity = await loadIdentity(paths);
    if (!identity) throw new Error(`Agent is not registered (missing ${paths.identityFile}). Run: ims-agent register --core-url <url>`);
    return new Agent(identity, await loadPrivateKey(paths), paths);
  }

  async start(): Promise<void> {
    log.info('Starting IMS agent', { version: AGENT_VERSION, nodeId: this.identity.nodeId, core: this.identity.coreUrl });
    await this.config.loadCache();
    this.scheduler.setJobs(this.config.current.jobs);
    this.config.on('changed', (cfg) => {
      this.scheduler.setJobs(cfg.jobs);
      this.monitor.setInterval(cfg.metricsIntervalSec);
    });

    this.ws.on('authenticated', (ok: AuthOk) => this.onAuthenticated(ok));
    this.ws.on('message', (frame: Record<string, unknown>) => this.onFrame(frame));
    this.ws.start();

    await this.scheduler.start();
    this.monitor.start(this.config.current.metricsIntervalSec);
    this.flushTimer = setInterval(() => void this.outbox.flush(), 60_000);
    this.flushTimer.unref();
    await this.updates.onStartup();
  }

  async stop(): Promise<void> {
    clearInterval(this.heartbeatTimer);
    clearInterval(this.flushTimer);
    this.scheduler.stop();
    this.monitor.stop();
    await this.backups.waitForIdle(30_000);
    this.ws.stop();
  }

  private onAuthenticated(ok: AuthOk): void {
    this.heartbeatIntervalSec = ok.heartbeatIntervalSec || 30;
    clearInterval(this.heartbeatTimer);
    this.sendHeartbeat();
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), this.heartbeatIntervalSec * 1000);
    this.heartbeatTimer.unref();
    void this.syncConfig(ok.configVersion);
    void this.outbox.flush();
    void this.updates.onConnected();
    void this.monitor.collectAndSend();
  }

  private onFrame(frame: Record<string, unknown>): void {
    switch (frame.type) {
      case 'command':
        void this.commands.handle(frame as unknown as SignedCommand).catch((err: Error) => log.error('Command handling crashed', { error: err.message }));
        break;
      case 'heartbeat.ack':
        if (typeof frame.configVersion === 'number') void this.syncConfig(frame.configVersion);
        break;
      case 'error':
        log.warn('Core reported an error', { code: frame.code, message: frame.message });
        break;
      default:
        log.debug('Ignoring frame', { type: frame.type });
    }
  }

  private sendHeartbeat(): void {
    this.ws.send({ type: 'heartbeat', agentVersion: AGENT_VERSION, ...systemSummary() });
  }

  private async syncConfig(version: number): Promise<void> {
    try {
      await this.config.refresh(version);
    } catch (err) {
      log.warn('Configuration refresh failed', { error: (err as Error).message });
    }
  }

  private async reportReliable(type: 'backup.report' | 'command.result', data: unknown): Promise<void> {
    await this.outbox.add({ type, data });
    await this.outbox.flush();
  }

  private registerCommands(): void {
    this.commands.register('ping', async () => ({ status: 'ok', version: AGENT_VERSION, ...systemSummary(), outbox: await this.outbox.size(), configVersion: this.config.current.configVersion }));
    this.commands.register('config.sync', async () => {
      await this.config.refresh(undefined, true);
      return { configVersion: this.config.current.configVersion, jobs: this.config.current.jobs.length };
    });
    this.commands.register('monitor.collect', async () => {
      await this.monitor.collectAndSend();
      return { sent: true };
    });
    this.commands.register('backup.run', async (payload) => {
      const jobId = String(payload.jobId ?? '');
      const runId = String(payload.runId ?? '');
      const trigger = payload.trigger === 'TELEGRAM' ? 'TELEGRAM' : 'MANUAL';
      if (!/^[0-9a-f-]{36}$/.test(jobId) || !/^[0-9a-f-]{36}$/.test(runId)) throw new Error('Invalid job or run id');
      await this.config.refresh(undefined, true).catch(() => undefined);
      const job = this.config.job(jobId);
      if (!job) throw new Error('Unknown backup job');
      // Runs in the background; the outcome is delivered as a backup.report.
      void this.backups.run(job, { runId, trigger });
      return { accepted: true, runId };
    });
    this.commands.register('agent.update', async (payload, commandId) => {
      await this.updates.apply(payload, commandId, async () => {
        // Never cut a running backup short: start no new jobs, let the current one finish (bounded).
        this.scheduler.stop();
        await this.backups.waitForIdle(20 * 60_000);
        await this.stop();
      });
    });
  }
}
