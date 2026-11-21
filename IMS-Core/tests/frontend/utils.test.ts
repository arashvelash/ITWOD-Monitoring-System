import { describe, expect, it } from 'vitest';
import { formatBytes, formatDuration, formatUptime, initials, timeAgo } from '@/lib/utils';
import { bucketMs, formatRate, maxDiskPercent, memoryPercent, toneFor, withGaps } from '@/lib/metrics';
import { passwordScore } from '@/features/auth/password-score';

describe('formatters', () => {
  it('formats bytes', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB');
  });

  it('formats durations and uptime', () => {
    expect(formatDuration(42_000)).toBe('42s');
    expect(formatDuration(125_000)).toBe('2m 5s');
    expect(formatUptime(90_061)).toBe('1d 1h');
  });

  it('formats relative time', () => {
    const now = Date.parse('2026-01-01T12:00:00Z');
    expect(timeAgo(null)).toBe('never');
    expect(timeAgo(new Date(now - 10_000), now)).toBe('just now');
    expect(timeAgo(new Date(now - 5 * 60_000), now)).toBe('5 minutes ago');
  });

  it('builds initials', () => {
    expect(initials('arash admin')).toBe('AA');
    expect(initials('ops.team')).toBe('OT');
  });
});

describe('metrics helpers', () => {
  const m = {
    collectedAt: '',
    memory: { totalBytes: 1000, usedBytes: 250 },
    disks: [
      { mount: '/', totalBytes: 100, usedBytes: 40 },
      { mount: '/var', totalBytes: 100, usedBytes: 95 },
    ],
  };
  it('computes memory and max disk usage', () => {
    expect(memoryPercent(m)).toBe(25);
    expect(maxDiskPercent(m)).toBe(95);
    expect(maxDiskPercent({ collectedAt: '' })).toBeNull();
  });
  it('parses bucket intervals and inserts gaps for outages', () => {
    expect(bucketMs('5 minutes')).toBe(300_000);
    expect(bucketMs('2 hours')).toBe(7_200_000);
    expect(bucketMs('1 minute')).toBe(60_000);
    const pts = ['00:00', '00:01', '00:02', '00:10'].map((t) => ({ collectedAt: `2026-01-01T${t}:00.000Z`, v: 1 as number | null }));
    const out = withGaps(pts, 60_000, (at) => ({ collectedAt: at, v: null }));
    expect(out).toHaveLength(5);
    expect(out[3]).toEqual({ collectedAt: '2026-01-01T00:03:00.000Z', v: null });
  });
  it('formats network rates in bits', () => {
    expect(formatRate(null)).toBe('—');
    expect(formatRate(100)).toBe('800 bit/s');
    expect(formatRate(125_000)).toBe('1.0 Mbit/s');
  });
  it('maps usage to tones', () => {
    expect(toneFor(50)).toBe('success');
    expect(toneFor(80)).toBe('warning');
    expect(toneFor(95)).toBe('destructive');
  });
});

describe('passwordScore', () => {
  it('scores short passwords as 0 and long varied passphrases high', () => {
    expect(passwordScore('short')).toBe(0);
    expect(passwordScore('aaaaaaaaaaaaaaaa')).toBe(1);
    expect(passwordScore('Correct-Horse-Battery-Staple-42')).toBe(4);
  });
});
