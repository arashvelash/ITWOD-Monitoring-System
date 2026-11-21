/** Virtual interfaces whose traffic is already counted on a physical one. */
const IGNORED_IFACES = /^(lo|veth|docker|br-|virbr|cni|flannel|cali|vxlan|tun|tap|wg)/;

export interface NetCounters {
  rxBytes: number;
  txBytes: number;
  at: number;
}

/** Sums receive/transmit byte counters of physical interfaces from /proc/net/dev. */
export function parseNetDev(text: string, at = Date.now()): NetCounters | null {
  let rx = 0;
  let tx = 0;
  let found = false;
  for (const line of text.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const iface = line.slice(0, idx).trim();
    if (!iface || IGNORED_IFACES.test(iface)) continue;
    const cols = line.slice(idx + 1).trim().split(/\s+/).map(Number);
    if (cols.length < 16 || cols.some((n) => !Number.isFinite(n))) continue;
    rx += cols[0];
    tx += cols[8];
    found = true;
  }
  return found ? { rxBytes: rx, txBytes: tx, at } : null;
}

export interface NetRate {
  rxBytesPerSec: number;
  txBytesPerSec: number;
}

/** Rate between two readings; null after counter resets (reboot, interface removal) or too short windows. */
export function netRate(prev: NetCounters, next: NetCounters): NetRate | null {
  const sec = (next.at - prev.at) / 1000;
  const drx = next.rxBytes - prev.rxBytes;
  const dtx = next.txBytes - prev.txBytes;
  if (sec < 1 || drx < 0 || dtx < 0) return null;
  return { rxBytesPerSec: Math.round(drx / sec), txBytesPerSec: Math.round(dtx / sec) };
}
