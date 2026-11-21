import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { dueSlot, SchedulerService } from '../services/scheduler.service';
import type { JobConfig } from '../services/config.service';
import { tempPaths } from './helpers';

const job = { id: 'j1', name: 'db', enabled: true, schedule: '0 3 * * *', timezone: 'Asia/Tehran' } as JobConfig;

describe('dueSlot', () => {
  it('finds the latest slot after the last handled one', () => {
    // 03:00 Tehran = 23:30 UTC the previous day
    expect(dueSlot(job, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T23:31:00Z'))?.toISOString()).toBe('2026-01-01T23:30:00.000Z');
    expect(dueSlot(job, new Date('2026-01-01T23:30:00Z'), new Date('2026-01-01T23:45:00Z'))).toBeNull();
  });
});

describe('SchedulerService', () => {
  it('fires each slot exactly once and skips stale slots', async () => {
    const { root } = tempPaths();
    let now = new Date('2026-01-01T20:00:00Z');
    const fired: string[] = [];
    const svc = new SchedulerService(join(root, 'schedule.json'), async (_j, slot) => void fired.push(slot.toISOString()), () => now);
    svc.setJobs([job]);
    await svc.start(); // first sight: remembers "now", no back-fill
    expect(fired).toEqual([]);

    now = new Date('2026-01-01T23:30:05Z');
    await svc.tick();
    await svc.tick();
    expect(fired).toEqual(['2026-01-01T23:30:00.000Z']);

    // Agent was down for two days: the old slot is outside the catch-up window.
    now = new Date('2026-01-04T12:00:00Z');
    await svc.tick();
    expect(fired).toHaveLength(1);
    svc.stop();
  });

  it('persists state across restarts', async () => {
    const { root } = tempPaths();
    const file = join(root, 'schedule.json');
    let now = new Date('2026-01-01T20:00:00Z');
    const onDue = vi.fn().mockResolvedValue(undefined);
    const a = new SchedulerService(file, onDue, () => now);
    a.setJobs([job]);
    await a.start();
    now = new Date('2026-01-01T23:30:10Z');
    await a.tick();
    a.stop();
    const b = new SchedulerService(file, onDue, () => now);
    b.setJobs([job]);
    await b.start();
    b.stop();
    expect(onDue).toHaveBeenCalledTimes(1);
  });

  it('ignores disabled jobs', async () => {
    const { root } = tempPaths();
    const onDue = vi.fn();
    const svc = new SchedulerService(join(root, 's.json'), onDue, () => new Date());
    svc.setJobs([{ ...job, enabled: false }]);
    await svc.start();
    svc.stop();
    expect(onDue).not.toHaveBeenCalled();
  });
});
