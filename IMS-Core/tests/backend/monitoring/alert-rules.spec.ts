import { evaluateSample, fingerprints, memoryPercent, offlineThresholdSec, Thresholds } from '../../../backend/src/alerts/alert-rules';

const S = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const T: Thresholds = { cpuPercent: 90, cpuSustainMinutes: 5, memoryPercent: 90, diskPercent: 90 };
const GiB = 1024 ** 3;

describe('evaluateSample', () => {
  it('needs a sustained CPU series before opening CPU_HIGH', () => {
    expect(evaluateSample(S, 'web', { cpu: { percent: 99 } }, T, [99]).open).toHaveLength(0);
    expect(evaluateSample(S, 'web', { cpu: { percent: 99 } }, T, [95, 40, 99]).open).toHaveLength(0);
    const r = evaluateSample(S, 'web', { cpu: { percent: 99 } }, T, [95, 93, 99]);
    expect(r.open).toEqual([expect.objectContaining({ type: 'CPU_HIGH', severity: 'CRITICAL', fingerprint: fingerprints.cpu(S) })]);
  });

  it('applies hysteresis before resolving', () => {
    // Just below the threshold: neither open nor resolve (prevents flapping).
    const hover = evaluateSample(S, 'web', { cpu: { percent: 88 }, memory: { totalBytes: 100, usedBytes: 88 } }, T, [95, 88]);
    expect(hover.open).toHaveLength(0);
    expect(hover.resolve).toHaveLength(0);
    const calm = evaluateSample(S, 'web', { cpu: { percent: 20 }, memory: { totalBytes: 100, usedBytes: 50 } }, T, [20]);
    expect(calm.resolve).toEqual(expect.arrayContaining([fingerprints.cpu(S), fingerprints.memory(S)]));
  });

  it('opens memory and per-mount disk alerts', () => {
    const r = evaluateSample(
      S,
      'web',
      {
        memory: { totalBytes: 8 * GiB, usedBytes: 7.9 * GiB },
        disks: [
          { mount: '/', totalBytes: 100 * GiB, usedBytes: 96 * GiB },
          { mount: '/data', totalBytes: 100 * GiB, usedBytes: 10 * GiB },
        ],
      },
      T,
      [],
    );
    expect(r.open.map((a) => a.fingerprint)).toEqual([fingerprints.memory(S), fingerprints.disk(S, '/')]);
    expect(r.open.find((a) => a.type === 'DISK_HIGH')?.severity).toBe('CRITICAL');
    expect(r.resolve).toContain(fingerprints.disk(S, '/data'));
  });

  it('tracks services and resolves vanished mounts and services', () => {
    const open = [fingerprints.disk(S, '/mnt/old'), fingerprints.service(S, 'old.service'), fingerprints.disk(S, '/')];
    const r = evaluateSample(
      S,
      'web',
      {
        disks: [{ mount: '/', totalBytes: 100, usedBytes: 50 }],
        services: [
          { name: 'nginx', active: false, state: 'failed' },
          { name: 'mysql', active: true },
        ],
      },
      T,
      [],
      open,
    );
    expect(r.open).toEqual([expect.objectContaining({ type: 'SERVICE_DOWN', fingerprint: fingerprints.service(S, 'nginx') })]);
    expect(r.resolve).toEqual(expect.arrayContaining([fingerprints.service(S, 'mysql'), fingerprints.disk(S, '/mnt/old'), fingerprints.service(S, 'old.service'), fingerprints.disk(S, '/')]));
  });

  it('does not resolve disk/service alerts when the sample omits those sections', () => {
    const r = evaluateSample(S, 'web', { cpu: { percent: 10 } }, T, [10], [fingerprints.disk(S, '/'), fingerprints.service(S, 'nginx')]);
    expect(r.resolve).toEqual([fingerprints.cpu(S)]);
  });
});

describe('helpers', () => {
  it('memoryPercent handles missing totals', () => {
    expect(memoryPercent({})).toBeNull();
    expect(memoryPercent({ memory: { totalBytes: 200, usedBytes: 50 } })).toBe(25);
  });

  it('gives cPanel agents a longer offline threshold (cron cadence)', () => {
    expect(offlineThresholdSec('UBUNTU', 180)).toBe(180);
    expect(offlineThresholdSec('CPANEL', 180)).toBeGreaterThanOrEqual(1020);
    expect(offlineThresholdSec('CPANEL', 3600)).toBe(3600);
  });
});
