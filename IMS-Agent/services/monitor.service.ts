import { createLogger } from '../src/logger';
import { MetricsCollector, type MetricsSample } from '../modules/metrics/collector';

const log = createLogger('monitor');
const MIN_INTERVAL_SEC = 15;
const MAX_INTERVAL_SEC = 3600;

/**
 * Periodically collects a metrics sample and sends it over the realtime
 * channel. Samples are ephemeral: when Core is unreachable they are dropped
 * (a fresh sample is sent right after reconnecting), so an outage never
 * builds up a backlog on the server.
 */
export class MonitorService {
  private timer?: NodeJS.Timeout;
  private intervalSec = 60;
  private running = false;
  private inFlight?: Promise<MetricsSample | undefined>;

  constructor(
    private readonly getServices: () => string[],
    private readonly send: (data: MetricsSample) => boolean,
    private readonly collector: MetricsCollector = new MetricsCollector(),
  ) {}

  start(intervalSec: number): void {
    this.running = true;
    this.schedule(intervalSec);
  }

  stop(): void {
    this.running = false;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Applies a new interval from the configuration (no-op when unchanged). */
  setInterval(intervalSec: number): void {
    const next = clampInterval(intervalSec);
    if (next === this.intervalSec && this.timer) return;
    if (this.running) this.schedule(next);
    else this.intervalSec = next;
  }

  get currentIntervalSec(): number {
    return this.intervalSec;
  }

  /** Collects and sends one sample; concurrent callers share the same collection. */
  collectAndSend(): Promise<MetricsSample | undefined> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      try {
        const sample = await this.collector.collect(this.getServices());
        if (!this.send(sample)) log.debug('Not connected; metrics sample dropped');
        return sample;
      } catch (err) {
        log.warn('Metrics collection failed', { error: (err as Error).message });
        return undefined;
      } finally {
        this.inFlight = undefined;
      }
    })();
    return this.inFlight;
  }

  private schedule(intervalSec: number): void {
    this.intervalSec = clampInterval(intervalSec);
    clearInterval(this.timer);
    this.timer = setInterval(() => void this.collectAndSend(), this.intervalSec * 1000);
    this.timer.unref();
  }
}

function clampInterval(sec: number): number {
  if (!Number.isFinite(sec)) return 60;
  return Math.min(MAX_INTERVAL_SEC, Math.max(MIN_INTERVAL_SEC, Math.round(sec)));
}
