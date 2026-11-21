import os from 'node:os';

export interface MemoryInfo {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
}

/**
 * Parses /proc/meminfo. "Used" follows the kernel's MemAvailable estimate
 * (what `free` shows as available), so page cache is not counted as used.
 */
export function parseMeminfo(text: string): MemoryInfo | null {
  const kb = new Map<string, number>();
  for (const line of text.split('\n')) {
    const m = /^(\w+(?:\(\w+\))?):\s+(\d+)(?:\s+kB)?\s*$/.exec(line.trim());
    if (m) kb.set(m[1], Number(m[2]) * 1024);
  }
  const total = kb.get('MemTotal');
  if (!total) return null;
  // Kernels older than 3.14 have no MemAvailable: approximate it.
  const available = kb.get('MemAvailable') ?? (kb.get('MemFree') ?? 0) + (kb.get('Buffers') ?? 0) + (kb.get('Cached') ?? 0);
  const swapTotal = kb.get('SwapTotal') ?? 0;
  const swapFree = kb.get('SwapFree') ?? 0;
  return {
    totalBytes: total,
    availableBytes: Math.min(available, total),
    usedBytes: Math.max(0, total - available),
    swapTotalBytes: swapTotal,
    swapUsedBytes: Math.max(0, swapTotal - swapFree),
  };
}

/** Fallback for non-Linux hosts (development machines). */
export function osMemory(): MemoryInfo {
  const total = os.totalmem();
  const free = os.freemem();
  return { totalBytes: total, availableBytes: free, usedBytes: total - free, swapTotalBytes: 0, swapUsedBytes: 0 };
}
