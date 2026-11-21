import { readJson, writeJson } from '../src/fs-utils';
import { createLogger } from '../src/logger';
import { verifyCommand, type CommandType, type SignedCommand } from '../src/protocol';

const log = createLogger('commands');
const DEDUPE_WINDOW_MS = 24 * 3_600_000;

export type CommandHandler = (payload: Record<string, unknown>, commandId: string) => Promise<Record<string, unknown> | void>;

export interface CommandCallbacks {
  ack(commandId: string): void;
  result(commandId: string, status: 'SUCCEEDED' | 'FAILED', result?: Record<string, unknown>, error?: string): Promise<void>;
}

/**
 * Verifies and executes commands from Core. Only allow-listed command types
 * with a registered handler can run; each command id executes at most once.
 */
export class CommandService {
  private readonly handlers = new Map<CommandType, CommandHandler>();
  private executed = new Map<string, number>();
  private loaded = false;

  constructor(
    private readonly nodeSecret: string,
    private readonly stateFile: string,
    private readonly callbacks: CommandCallbacks,
  ) {}

  register(type: CommandType, handler: CommandHandler): void {
    this.handlers.set(type, handler);
  }

  async handle(cmd: SignedCommand): Promise<void> {
    await this.loadState();
    const check = verifyCommand(this.nodeSecret, cmd);
    if (!check.ok) {
      log.warn('Rejected command', { id: typeof cmd?.id === 'string' ? cmd.id : undefined, reason: check.reason });
      // Only answer for commands that were genuinely signed by Core.
      if (check.reason !== 'invalid signature' && check.reason !== 'malformed signature' && check.reason !== 'malformed command') {
        await this.callbacks.result(cmd.id, 'FAILED', undefined, `Rejected by agent: ${check.reason}`);
      }
      return;
    }
    if (this.executed.has(cmd.id)) {
      log.debug('Ignoring duplicate command', { id: cmd.id });
      return;
    }
    const handler = this.handlers.get(check.type);
    this.executed.set(cmd.id, Date.now());
    await this.saveState();
    this.callbacks.ack(cmd.id);

    if (!handler) {
      await this.callbacks.result(cmd.id, 'FAILED', undefined, `Command ${check.type} is not supported by this agent`);
      return;
    }
    log.info('Executing command', { id: cmd.id, type: check.type });
    try {
      const result = (await handler(check.payload, cmd.id)) ?? undefined;
      // agent.update reports its own result after the restart.
      if (check.type !== 'agent.update') await this.callbacks.result(cmd.id, 'SUCCEEDED', result);
    } catch (err) {
      const message = (err as Error).message;
      log.error('Command failed', { id: cmd.id, type: check.type, error: message });
      await this.callbacks.result(cmd.id, 'FAILED', undefined, message.slice(0, 2000));
    }
  }

  private async loadState(): Promise<void> {
    if (this.loaded) return;
    const saved = await readJson<Record<string, number>>(this.stateFile).catch(() => null);
    this.executed = new Map(Object.entries(saved ?? {}));
    this.loaded = true;
  }

  private async saveState(): Promise<void> {
    const cutoff = Date.now() - DEDUPE_WINDOW_MS;
    for (const [id, at] of this.executed) if (at < cutoff) this.executed.delete(id);
    await writeJson(this.stateFile, Object.fromEntries(this.executed));
  }
}
