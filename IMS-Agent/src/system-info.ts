import { readFileSync } from 'node:fs';
import os from 'node:os';

let cachedOs: string | undefined;

/** PRETTY_NAME from /etc/os-release, e.g. "Ubuntu 24.04.1 LTS". */
export function osPrettyName(): string {
  if (cachedOs) return cachedOs;
  try {
    const content = readFileSync('/etc/os-release', 'utf8');
    const match = /^PRETTY_NAME="?([^"\n]+)"?$/m.exec(content);
    cachedOs = match?.[1] ?? `${os.type()} ${os.release()}`;
  } catch {
    cachedOs = `${os.type()} ${os.release()}`;
  }
  return cachedOs;
}

export function systemSummary() {
  return {
    hostname: os.hostname().slice(0, 255),
    os: osPrettyName().slice(0, 255),
    arch: process.arch,
    uptimeSec: Math.round(os.uptime()),
  };
}
