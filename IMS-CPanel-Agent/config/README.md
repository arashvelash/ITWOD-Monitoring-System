# config/

Created and managed by the agent – no manual configuration is needed.

| File | Written by | Content |
| --- | --- | --- |
| `identity.php` | `cron/register.php` | Node ID, Core URL, node secret, Ed25519 key (if libsodium is available). Mode 0600, starts with a guard so it outputs nothing if ever requested over HTTP. **Never copy, share or commit it.** |
| `.htaccess` | shipped / agent | Denies all web access |

All job settings (schedules, paths, databases, destinations, retention, encryption) are configured in the IMS dashboard and cached in `state/config-cache.json`.

Optional environment variables for the cron command line:

| Variable | Purpose |
| --- | --- |
| `IMS_ALLOW_INSECURE_CORE=true` | Allow an `http://` Core URL (development only) |
