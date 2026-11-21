import { describe, expect, it, vi } from 'vitest';
import { CpuSampler, cpuPercentBetween } from '../modules/metrics/cpu';
import { collectDisks, parseProcMounts, usageFromStatfs } from '../modules/metrics/disk';
import { parseMeminfo } from '../modules/metrics/memory';
import { netRate, parseNetDev } from '../modules/metrics/network';
import { checkServices, parseIsActive, validServiceNames } from '../modules/metrics/services';
import { MetricsCollector } from '../modules/metrics/collector';
import { MonitorService } from '../services/monitor.service';

const MEMINFO = `MemTotal:        8000000 kB
MemFree:          500000 kB
MemAvailable:    3000000 kB
Buffers:          100000 kB
Cached:          2000000 kB
SwapCached:            0 kB
Active(anon):    1000000 kB
SwapTotal:       2000000 kB
SwapFree:        1500000 kB
HugePages_Total:       0
`;

const MOUNTS = `sysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0
proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0
udev /dev devtmpfs rw,nosuid,relatime 0 0
tmpfs /run tmpfs rw,nosuid,nodev,noexec,relatime 0 0
/dev/sda1 / ext4 rw,relatime 0 0
/dev/sda1 /var/lib/some/bind ext4 rw,relatime 0 0
/dev/sdb1 /mnt/backup\\040disk xfs rw,relatime 0 0
/dev/loop0 /snap/core/1 squashfs ro,nodev,relatime 0 0
server:/export /mnt/nfs nfs4 rw,relatime 0 0
/dev/sda15 /boot/efi vfat rw,relatime 0 0
overlay /var/lib/docker/overlay2/x/merged overlay rw 0 0
`;

const NETDEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 9999999    1000    0    0    0     0          0         0  9999999    1000    0    0    0     0       0          0
  eth0: 1000000    2000    0    0    0     0          0         0   500000    1500    0    0    0     0       0          0
  ens4: 3000000    2000    0    0    0     0          0         0   700000    1500    0    0    0     0       0          0
docker0:  555555    2000    0    0    0     0          0         0   555555    1500    0    0    0     0       0          0
vethabc:  444444    2000    0    0    0     0          0         0   444444    1500    0    0    0     0       0          0
`;

describe('cpu', () => {
  it('computes busy percentage from time deltas', () => {
    expect(cpuPercentBetween({ idle: 100, total: 200 }, { idle: 150, total: 400 })).toBe(75);
    expect(cpuPercentBetween({ idle: 100, total: 200 }, { idle: 100, total: 200 })).toBeNull();
    expect(cpuPercentBetween({ idle: 100, total: 200 }, { idle: 10, total: 50 })).toBeNull();
  });

  it('sampler reports the average since the previous sample', async () => {
    const readings = [
      { idle: 0, total: 0 },
      { idle: 90, total: 100 },
      { idle: 100, total: 200 },
    ];
    const s = new CpuSampler(() => readings.shift()!);
    expect(await s.sample()).toBe(10);
    expect(await s.sample()).toBe(90);
  });
});

describe('memory', () => {
  it('uses MemAvailable for used memory', () => {
    const m = parseMeminfo(MEMINFO)!;
    expect(m.totalBytes).toBe(8_000_000 * 1024);
    expect(m.usedBytes).toBe(5_000_000 * 1024);
    expect(m.availableBytes).toBe(3_000_000 * 1024);
    expect(m.swapUsedBytes).toBe(500_000 * 1024);
  });

  it('approximates availability on old kernels and rejects garbage', () => {
    const m = parseMeminfo('MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 50 kB\nCached: 250 kB\n')!;
    expect(m.availableBytes).toBe(400 * 1024);
    expect(parseMeminfo('nothing here')).toBeNull();
  });
});

describe('disk', () => {
  it('keeps local filesystems once per device and unescapes paths', () => {
    expect(parseProcMounts(MOUNTS)).toEqual([
      { device: '/dev/sda1', mount: '/', fs: 'ext4' },
      { device: '/dev/sda15', mount: '/boot/efi', fs: 'vfat' },
      { device: '/dev/sdb1', mount: '/mnt/backup disk', fs: 'xfs' },
    ]);
  });

  it('matches df Use% semantics (reserved blocks excluded)', () => {
    // 1000 blocks, 100 free, 50 available to users → used 900, size 950
    const u = usageFromStatfs('/', 'ext4', { bsize: 4096, blocks: 1000, bfree: 100, bavail: 50 })!;
    expect(u.usedBytes).toBe(900 * 4096);
    expect(u.totalBytes).toBe(950 * 4096);
    expect(usageFromStatfs('/', 'ext4', { bsize: 4096, blocks: 0, bfree: 0, bavail: 0 })).toBeNull();
  });

  it('skips mounts whose statfs fails', async () => {
    const stat = vi.fn(async (p: string) => {
      if (p === '/broken') throw new Error('EACCES');
      return { bsize: 1024, blocks: 100, bfree: 50, bavail: 50 };
    });
    const disks = await collectDisks(
      [
        { device: 'a', mount: '/', fs: 'ext4' },
        { device: 'b', mount: '/broken', fs: 'ext4' },
      ],
      stat,
    );
    expect(disks.map((d) => d.mount)).toEqual(['/']);
  });
});

describe('network', () => {
  it('sums physical interfaces only', () => {
    const c = parseNetDev(NETDEV, 0)!;
    expect(c.rxBytes).toBe(4_000_000);
    expect(c.txBytes).toBe(1_200_000);
  });

  it('computes rates and ignores counter resets', () => {
    expect(netRate({ rxBytes: 0, txBytes: 0, at: 0 }, { rxBytes: 10_000, txBytes: 5_000, at: 10_000 })).toEqual({ rxBytesPerSec: 1000, txBytesPerSec: 500 });
    expect(netRate({ rxBytes: 10_000, txBytes: 0, at: 0 }, { rxBytes: 5, txBytes: 5, at: 10_000 })).toBeNull();
  });
});

describe('services', () => {
  it('validates names so they can never become options or shell syntax', () => {
    expect(validServiceNames(['nginx', 'mysql.service', 'php8.3-fpm', 'getty@tty1', '--help', 'a;rm -rf /', '$(id)', 'nginx'])).toEqual(['nginx', 'mysql.service', 'php8.3-fpm', 'getty@tty1']);
  });

  it('parses is-active output in argument order', () => {
    expect(parseIsActive(['nginx', 'mysql'], 'active\nfailed\n')).toEqual([
      { name: 'nginx', state: 'active', active: true },
      { name: 'mysql', state: 'failed', active: false },
    ]);
    expect(parseIsActive(['nginx', 'mysql'], 'active\n')).toBeNull();
  });

  it('executes systemctl without a shell and with an argument terminator', async () => {
    const exec = vi.fn(async () => ({ stdout: 'active\ninactive\n' }));
    const r = await checkServices(['nginx', 'redis-server', 'bad name'], exec);
    expect(exec).toHaveBeenCalledWith('systemctl', ['is-active', '--', 'nginx', 'redis-server'], { timeout: 5000 });
    expect(r?.map((s) => s.active)).toEqual([true, false]);
    expect(await checkServices([], exec)).toEqual([]);
  });

  it('reports nothing (instead of false alerts) when systemd is unavailable', async () => {
    expect(await checkServices(['nginx'], async () => Promise.reject(new Error('ENOENT')))).toBeNull();
  });
});

describe('MetricsCollector', () => {
  it('builds a protocol sample from /proc sources', async () => {
    let now = 1_000_000;
    const files: Record<string, string> = { '/proc/meminfo': MEMINFO, '/proc/mounts': MOUNTS, '/proc/net/dev': NETDEV };
    const readings = [
      { idle: 0, total: 0 },
      { idle: 50, total: 100 },
      { idle: 100, total: 200 },
    ];
    const collector = new MetricsCollector({
      readText: async (p) => {
        if (!(p in files)) throw new Error('ENOENT');
        return files[p];
      },
      statfs: async () => ({ bsize: 4096, blocks: 1000, bfree: 500, bavail: 500 }),
      exec: async () => ({ stdout: 'active\n' }),
      cpu: new CpuSampler(() => readings.shift()!),
      now: () => now,
    });
    const first = await collector.collect(['nginx']);
    expect(first).toMatchObject({
      cpu: { percent: 50 },
      memory: { totalBytes: 8_000_000 * 1024 },
      swap: { totalBytes: 2_000_000 * 1024 },
      services: [{ name: 'nginx', active: true }],
    });
    expect(first.disks).toHaveLength(3);
    expect(first.network).toBeUndefined(); // needs two readings
    expect(new Date(first.collectedAt).getTime()).toBe(now);

    now += 10_000;
    files['/proc/net/dev'] = NETDEV.replace('eth0: 1000000', 'eth0: 1100000');
    const second = await collector.collect(['nginx']);
    expect(second.network).toEqual({ rxBytesPerSec: 10_000, txBytesPerSec: 0 });
  });
});

describe('MonitorService', () => {
  it('sends samples, drops them when offline and clamps intervals', async () => {
    const sample = { collectedAt: new Date().toISOString() };
    const collector = { collect: vi.fn(async () => sample) } as unknown as MetricsCollector;
    const sent: unknown[] = [];
    let connected = true;
    const svc = new MonitorService(() => ['nginx'], (d) => (connected ? (sent.push(d), true) : false), collector);

    await svc.collectAndSend();
    connected = false;
    await svc.collectAndSend();
    expect(sent).toEqual([sample]);
    expect(collector.collect).toHaveBeenCalledWith(['nginx']);

    svc.start(1);
    expect(svc.currentIntervalSec).toBe(15);
    svc.setInterval(999_999);
    expect(svc.currentIntervalSec).toBe(3600);
    svc.stop();
  });

  it('shares one in-flight collection between concurrent callers', async () => {
    let release!: () => void;
    const collector = { collect: vi.fn(() => new Promise((r) => (release = () => r({ collectedAt: 'x' })))) } as unknown as MetricsCollector;
    const svc = new MonitorService(() => [], () => true, collector);
    const a = svc.collectAndSend();
    const b = svc.collectAndSend();
    release();
    await Promise.all([a, b]);
    expect(collector.collect).toHaveBeenCalledTimes(1);
  });

  it('survives collector failures', async () => {
    const collector = { collect: vi.fn(async () => Promise.reject(new Error('boom'))) } as unknown as MetricsCollector;
    const svc = new MonitorService(() => [], () => true, collector);
    await expect(svc.collectAndSend()).resolves.toBeUndefined();
  });
});
