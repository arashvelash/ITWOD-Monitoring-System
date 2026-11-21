# Troubleshooting

Start with the state of the stack:

```bash
cd /opt/ims-core
sudo docker compose ps
sudo docker compose logs --tail=200 backend
curl -fsS https://<domain>/api/v1/health/ready
```

## Core

| Problem | Diagnosis | Fix |
| --- | --- | --- |
| `Invalid configuration: …` in backend logs | A required variable/secret is missing or malformed | Check `.env`; make sure `init` ran (`docker compose logs init`) and the `ims_ims-secrets` volume exists |
| `missing secret /run/ims-secrets/…` | The secrets volume was removed or not mounted | Restore it from a Core backup (`secrets.tar.gz`). **Do not** generate new secrets for an existing database: the master key must match. |
| Backend unhealthy, `/health/ready` → 503 | `checks.database` or `checks.redis` is `false` | `docker compose logs postgres redis`; disk full? (`df -h`) |
| Migrations fail at start | Output of `prisma migrate deploy` in the backend log | Fix the cause, then `docker compose run --rm --no-deps backend migrate`. Restore the pre-update backup if a migration left the database inconsistent. |
| Certificate not issued | `docker compose logs web` shows ACME errors | DNS must point to the host, ports 80/443 reachable from the internet, no other web server on the host |
| Login: "Too many requests" | Rate limit (10/min per IP) | Wait 5 minutes |
| Login: account locked | Too many failed attempts | Another admin: Users › Unlock, or wait for the lockout to expire |
| Lost the only admin password | – | See below |
| Dashboard shows old version after update | Browser cache | Hard reload; `index.html` is served with `no-cache`, assets are content-hashed |

### Resetting a lost administrator password

With shell access to the Core host:

```bash
# The entrypoint wrapper provides DATABASE_URL from the secrets volume.
sudo docker compose exec backend ims-entrypoint node -e '
const argon2=require("argon2");const {PrismaClient}=require("@prisma/client");
(async()=>{const p=new PrismaClient();const pw=process.argv[1];
if(!pw||pw.length<12)throw new Error("password too short");
const hash=await argon2.hash(pw,{type:argon2.argon2id,memoryCost:19456,timeCost:2,parallelism:1});
const u=await p.user.update({where:{username:process.argv[2]},data:{passwordHash:hash,mustChangePassword:true,failedLoginAttempts:0,lockedUntil:null,passwordChangedAt:new Date()}});
await p.session.updateMany({where:{userId:u.id,revokedAt:null},data:{revokedAt:new Date(),revokedReason:"cli_reset"}});
console.log("password reset for",u.username);await p.$disconnect();})().catch(e=>{console.error(e.message);process.exit(1)})' '<new-temporary-password>' '<username>'
```

The user must choose a new password at the next login. The action is visible in the database but not in the audit log – record it in your change log.

## Agents (Ubuntu)

```bash
sudo ims-agent status
sudo tail -n 100 /var/log/ims-agent/error.log /var/log/ims-agent/agent.log
sudo -u ims-agent PM2_HOME=/var/lib/ims-agent/.pm2 pm2 status
```

| Problem | Fix |
| --- | --- |
| `Registration failed (401)` | Token expired/used/revoked → issue a new one in the dashboard |
| Node stays offline, log shows `4401` | Clock skew > 5 min (`timedatectl set-ntp true`) or the credential was revoked |
| Log shows `4403` | Node revoked in the dashboard – re-enrol with a new registration token and `--force-register` |
| `certificate` / `ECONNREFUSED` errors | Outbound 443 to Core blocked, proxy required, or Core certificate invalid |
| Backups fail with `EACCES` | The `ims-agent` user cannot read the source; grant group access or reinstall with `--run-as-root` |
| MySQL backup: access denied | Check host/port/user and the stored password; the user needs `SELECT, SHOW VIEW, TRIGGER, LOCK TABLES, EVENT` |
| Service shows down although running | The watched name must be the systemd unit (`systemctl list-units --type=service`) |
| Update rolled back | Reason is shown in Updates › Agents and in `sudo ims-agent status` (`updateState`) |

## Agents (cPanel)

```bash
php ~/ims-agent/cron/ims-cron.php --verbose
tail -n 100 ~/ims-agent/logs/agent.log
```

| Problem | Fix |
| --- | --- |
| `Required PHP extension missing` | Enable `curl`/`openssl` in *Select PHP Version*; `sodium` recommended |
| Node offline | Cron not running (check *Cron Jobs* and the PHP binary path) or outbound HTTPS blocked by the host |
| `must not be readable by group/others` | `chmod 600 ~/ims-agent/config/identity.php` |
| Backups time out | Large sites: exclude caches/uploads, raise the job timeout; hosts often limit cron runtime |

## Collecting information for support

- `VERSION`, `docker compose ps`, last 200 backend log lines (remove IPs if needed)
- For agents: `ims-agent status` output (contains no secrets) and the last log lines
- Never send `.env`, the secrets volume, `identity.json`/`identity.php` or `node.key`
