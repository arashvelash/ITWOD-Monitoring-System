/**
 * Minimal structured JSON logger (one line per event). PM2 captures stdout /
 * stderr into /var/log/ims-agent and pm2-logrotate rotates the files.
 * Values under secret-looking keys are always redacted.
 */
type Level = 'error' | 'warn' | 'info' | 'debug';
const ORDER: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };
const SENSITIVE = /(secret|password|token|key|signature|authorization)/i;

let threshold: Level = (['error', 'warn', 'info', 'debug'] as const).includes(process.env.IMS_AGENT_LOG_LEVEL as Level) ? (process.env.IMS_AGENT_LOG_LEVEL as Level) : 'info';

export function setLogLevel(level: Level): void {
  threshold = level;
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (value instanceof Error) return { message: value.message, name: value.name };
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = SENSITIVE.test(k) ? '[redacted]' : redact(v, depth + 1);
  return out;
}

function write(level: Level, scope: string, msg: string, fields?: Record<string, unknown>) {
  if (ORDER[level] > ORDER[threshold]) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, scope, msg, ...(fields ? (redact(fields) as object) : {}) });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

export interface Logger {
  error(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(scope: string): Logger {
  return {
    error: (m, f) => write('error', scope, m, f),
    warn: (m, f) => write('warn', scope, m, f),
    info: (m, f) => write('info', scope, m, f),
    debug: (m, f) => write('debug', scope, m, f),
  };
}
