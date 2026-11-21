/**
 * Closed allow-list of commands Core can send to agents (docs/PROTOCOL.md §5).
 * There is intentionally no command for shell execution, deletion or disk
 * operations. Agents enforce the same list independently.
 */
export const ALLOWED_COMMANDS = ['ping', 'config.sync', 'monitor.collect', 'backup.run', 'agent.update'] as const;
export type AgentCommandType = (typeof ALLOWED_COMMANDS)[number];

export const AGENT_DEFAULTS = {
  heartbeatIntervalSec: 30,
  metricsIntervalSec: 60,
  wsPath: '/ws/agent',
  /** cPanel agents poll from cron every 5 minutes. */
  cpanelPollIntervalSec: 300,
  authTimeoutMs: 10_000,
  pingIntervalMs: 25_000,
  maxFrameBytes: 1024 * 1024,
  /** Per-connection flood protection. */
  maxMessagesPerWindow: 120,
  messageWindowMs: 10_000,
} as const;

/** Default command lifetimes (seconds). */
export const COMMAND_TTL_SEC: Record<AgentCommandType, number> = {
  ping: 120,
  'config.sync': 600,
  'monitor.collect': 120,
  'backup.run': 3600,
  'agent.update': 1800,
};

export const WS_CLOSE = {
  unauthorized: 4401,
  forbidden: 4403,
  replaced: 4409,
  flood: 4429,
  badMessage: 4400,
} as const;
