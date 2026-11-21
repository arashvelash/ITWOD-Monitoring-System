// PM2 process definition for the IMS Agent (installed to /opt/ims-agent/ecosystem.config.cjs).
// Variables from /etc/ims-agent/agent.env are passed to the agent process.
const fs = require('node:fs');

function loadEnv(file) {
  const env = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {
    /* optional */
  }
  return env;
}

module.exports = {
  apps: [
    {
      name: 'ims-agent',
      script: '/opt/ims-agent/launcher.js',
      args: 'run',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      // A crash loop is handled by the launcher (rollback after 3 failed boots).
      min_uptime: '30s',
      max_restarts: 50,
      exp_backoff_restart_delay: 2000,
      kill_timeout: 35000,
      max_memory_restart: '400M',
      node_args: ['--max-old-space-size=256'],
      out_file: '/var/log/ims-agent/agent.log',
      error_file: '/var/log/ims-agent/error.log',
      merge_logs: true,
      time: false,
      env: { NODE_ENV: 'production', ...loadEnv('/etc/ims-agent/agent.env') },
    },
  ],
};
