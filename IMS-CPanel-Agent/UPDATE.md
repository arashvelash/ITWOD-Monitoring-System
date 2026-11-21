# Updating the IMS cPanel Agent

Shared hosting offers no safe way for a program to replace its own code, so the cPanel agent does **not** self-update: an `agent.update` command from Core is rejected with an explanatory message. Updates are a quick manual file replacement. The identity, state, logs and local backups are kept.

## 1. Check the current version

```bash
cat ~/ims-agent/VERSION
```

The dashboard shows the reported version under **Servers** and **Updates › Agents**.

## 2. Update

1. Download or build the upload archive for the new tag (see INSTALLATION.md §1). Read the release notes for manual steps.
2. Disable the cron job temporarily (cPanel › Cron Jobs › edit, or comment it out) and wait until a running cycle has finished (`~/ims-agent/state/agent.lock` is not locked; `tail ~/ims-agent/logs/agent.log`).
3. Replace **only** the code:

   ```bash
   cd ~
   cp -a ims-agent ims-agent.bak-$(cat ims-agent/VERSION)     # quick rollback copy (contains your identity – delete it afterwards)
   rm -rf ims-agent/src ims-agent/cron
   unzip -o ims-agent-new.zip 'src/*' 'cron/*' 'VERSION' '.htaccess' 'config/.htaccess' -d ims-agent
   chmod 700 ims-agent
   ```

   Never overwrite `config/identity.php` or `state/`.

4. Run one cycle manually and check for errors:

   ```bash
   php ~/ims-agent/cron/ims-cron.php --verbose
   ```

5. Re-enable the cron job. The new version appears in the dashboard with the next heartbeat.
6. Remove the rollback copy: `rm -rf ~/ims-agent.bak-*`.

## 3. Rollback

```bash
cd ~ && rm -rf ims-agent && mv ims-agent.bak-<old-version> ims-agent
```

## 4. Changing the PHP version

After switching the account's PHP version, verify the CLI binary used by cron (`php -v`, `php -m | grep -E 'curl|openssl|sodium|pdo_mysql'`) and adjust the cron command path if necessary.

## 5. Re-registration

Only needed after the node was revoked or the identity was lost:

```bash
php ~/ims-agent/cron/register.php --core-url=https://itwodms.ir --token=imsr_… --force
```

Create the new registration token in the dashboard first (Servers › server › New registration token).
