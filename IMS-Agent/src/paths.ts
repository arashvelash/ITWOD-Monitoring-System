import { join } from 'node:path';

/** Filesystem layout of an installed agent (overridable for tests / custom installs). */
export function agentPaths(env: NodeJS.ProcessEnv = process.env) {
  const configDir = env.IMS_AGENT_CONFIG_DIR ?? '/etc/ims-agent';
  const stateDir = env.IMS_AGENT_STATE_DIR ?? '/var/lib/ims-agent';
  const installDir = env.IMS_AGENT_INSTALL_DIR ?? '/opt/ims-agent';
  return {
    configDir,
    stateDir,
    installDir,
    backupDir: env.IMS_AGENT_BACKUP_DIR ?? '/var/backups/ims',
    identityFile: join(configDir, 'identity.json'),
    privateKeyFile: join(configDir, 'node.key'),
    releaseKeyFile: join(configDir, 'release-public.key'),
    configCacheFile: join(stateDir, 'config-cache.json'),
    outboxDir: join(stateDir, 'outbox'),
    executedCommandsFile: join(stateDir, 'executed-commands.json'),
    scheduleStateFile: join(stateDir, 'schedule-state.json'),
    updateStateFile: join(stateDir, 'update-state.json'),
    downloadsDir: join(stateDir, 'downloads'),
    releasesDir: join(installDir, 'releases'),
    currentLink: join(installDir, 'current'),
  };
}

export type AgentPaths = ReturnType<typeof agentPaths>;
