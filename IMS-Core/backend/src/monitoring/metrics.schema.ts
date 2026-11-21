import { z } from 'zod';

const bytes = z.number().nonnegative().max(1e18);
const percent = z.number().min(0).max(100);

/** Agent metrics sample (docs/PROTOCOL.md §6). Unknown top-level keys are dropped. */
export const metricsSampleSchema = z.object({
  collectedAt: z.string().datetime({ offset: true }),
  cpu: z
    .object({
      percent: percent.optional(),
      cores: z.number().int().min(1).max(4096).optional(),
      load: z.array(z.number().min(0).max(1e5)).max(3).optional(),
    })
    .optional(),
  memory: z.object({ totalBytes: bytes.optional(), usedBytes: bytes.optional(), availableBytes: bytes.optional() }).optional(),
  swap: z.object({ totalBytes: bytes.optional(), usedBytes: bytes.optional() }).optional(),
  disks: z
    .array(z.object({ mount: z.string().min(1).max(255), fs: z.string().max(32).optional(), totalBytes: bytes, usedBytes: bytes }))
    .max(64)
    .optional(),
  network: z.object({ rxBytesPerSec: z.number().nonnegative().optional(), txBytesPerSec: z.number().nonnegative().optional() }).optional(),
  uptimeSec: z.number().nonnegative().max(1e10).optional(),
  services: z
    .array(z.object({ name: z.string().regex(/^[a-zA-Z0-9@._-]{1,64}$/), active: z.boolean(), state: z.string().max(32).optional() }))
    .max(50)
    .optional(),
  hosting: z.record(z.string(), z.unknown()).optional(),
});

export type MetricsSampleInput = z.infer<typeof metricsSampleSchema>;

export const RANGES = {
  '1h': { ms: 3_600_000, bucket: '1 minute' },
  '6h': { ms: 6 * 3_600_000, bucket: '2 minutes' },
  '24h': { ms: 24 * 3_600_000, bucket: '5 minutes' },
  '7d': { ms: 7 * 86_400_000, bucket: '30 minutes' },
  '30d': { ms: 30 * 86_400_000, bucket: '2 hours' },
} as const;

export type MetricsRange = keyof typeof RANGES;
