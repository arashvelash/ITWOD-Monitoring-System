import { CronExpressionParser } from 'cron-parser';
import { readJson, writeJson } from '../src/fs-utils';
import { createLogger } from '../src/logger';
import type { JobConfig } from './config.service';

const log = createLogger('scheduler');
/** Missed runs (agent down / host rebooted) are caught up if they are at most this old. */
const CATCH_UP_WINDOW_MS = 60 * 60_000;
const MAX_TIMER_MS = 60 * 60_000;

type State = Record<string, string>; // jobId -> ISO time of the last scheduled slot handled

/** Returns the most recent scheduled slot in (after, now], if any. */
export function dueSlot(job: Pick<JobConfig, 'schedule' | 'timezone'>, after: Date, now: Date): Date | null {
  try {
    const prev = CronExpressionParser.parse(job.schedule, { tz: job.timezone || 'UTC', currentDate: new Date(now.getTime() + 1) }).prev().toDate();
    return prev > after ? prev : null;
  } catch {
    return null;
  }
}

export function nextSlot(job: Pick<JobConfig, 'schedule' | 'timezone'>, from: Date): Date | null {
  try {
    return CronExpressionParser.parse(job.schedule, { tz: job.timezone || 'UTC', currentDate: from }).next().toDate();
  } catch {
    return null;
  }
}

/**
 * Evaluates job schedules locally so backups keep running while Core is
 * unreachable. Each scheduled slot fires at most once (persisted state).
 */
export class SchedulerService {
  private jobs: JobConfig[] = [];
  private state: State = {};
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly stateFile: string,
    private readonly onDue: (job: JobConfig, scheduledFor: Date) => Promise<unknown>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  setJobs(jobs: JobConfig[]): void {
    this.jobs = jobs.filter((j) => j.enabled);
    if (this.running) this.reschedule();
  }

  async start(): Promise<void> {
    this.state = (await readJson<State>(this.stateFile).catch(() => null)) ?? {};
    this.running = true;
    await this.tick();
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
  }

  /** Fires every due job, then arms a timer for the next slot. */
  async tick(): Promise<void> {
    const now = this.now();
    let changed = false;
    for (const job of this.jobs) {
      const last = this.state[job.id] ? new Date(this.state[job.id]!) : null;
      // First sight of a job: do not back-fill history, start from now.
      if (!last) {
        this.state[job.id] = now.toISOString();
        changed = true;
        continue;
      }
      const slot = dueSlot(job, last, now);
      if (!slot) continue;
      this.state[job.id] = slot.toISOString();
      changed = true;
      if (now.getTime() - slot.getTime() > CATCH_UP_WINDOW_MS) {
        log.warn('Skipping a missed slot older than the catch-up window', { job: job.name, slot: slot.toISOString() });
        continue;
      }
      void this.onDue(job, slot).catch((err: Error) => log.error('Scheduled run failed to start', { job: job.name, error: err.message }));
    }
    const known = new Set(this.jobs.map((j) => j.id));
    for (const id of Object.keys(this.state)) {
      if (!known.has(id)) {
        delete this.state[id];
        changed = true;
      }
    }
    if (changed) await writeJson(this.stateFile, this.state).catch((err: Error) => log.warn('Cannot persist schedule state', { error: err.message }));
    this.reschedule();
  }

  private reschedule(): void {
    clearTimeout(this.timer);
    if (!this.running) return;
    const now = this.now();
    const next = this.jobs
      .map((j) => nextSlot(j, now))
      .filter((d): d is Date => d !== null)
      .sort((a, b) => a.getTime() - b.getTime())[0];
    const delay = next ? Math.min(Math.max(next.getTime() - now.getTime() + 250, 1000), MAX_TIMER_MS) : MAX_TIMER_MS;
    this.timer = setTimeout(() => void this.tick(), delay);
    this.timer.unref?.();
  }
}
