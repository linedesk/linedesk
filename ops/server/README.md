# Server setup around the install

What a production server needs besides `docker compose`: alerts by email, disk and memory checks, the nightly backup with its checks, and firewalls in front of Docker's published ports. One command installs it all; run it again after an update (it changes only what differs and keeps the settings).

```sh
sudo ops/server/setup.sh --alert-to ops@example.com --label prod
sudo ops/server/setup.sh --dry-run    # shows every file it would change, touches nothing
```

| What | Files | When it runs |
| --- | --- | --- |
| Email alerts through the install's own SMTP (`SMTP_URL`, `EMAIL_FROM` in `.env`) to `LINEDESK_ALERT_TO` | `bin/linedesk-alert-text`, `bin/linedesk-alert`, `systemd/linedesk-alert@.service` | when a unit below fails (`OnFailure`) |
| Disk (under 15 % or 8 GB free), memory (under 10 % available), swap (over 50 % used): one email when crossed, one when fine again | `bin/linedesk-resources` | every 15 minutes |
| Offsite database backup (`scripts/backup.sh`) | `systemd/linedesk-backup.*` | 09:00 UTC daily, only once `backup.env` exists |
| WAL archiving (`docker-compose.wal.yml`, docs/backups-wal.md): archived WAL to the bucket, a base backup every night | `systemd/linedesk-wal-*` | every minute and 03:00 UTC, once `COMPOSE_FILE` has `docker-compose.wal.yml` and `backup.env` exists |
| The newest backup is under 26 hours old | `bin/linedesk-backup-check` | 12:00 UTC daily, with the backup |
| Restore test of the newest backup into a throwaway database (`scripts/restore-backup.sh`); for encrypted backups only that the newest is there, not tiny and age-encrypted (the private key stays off the server) | `bin/linedesk-restore-test` | Sundays 10:00 UTC, with the backup |
| SIP (5060) only from the carriers in `etc/sip-allow.txt` and this server's `/etc/linedesk/sip-allow.local.txt` | `bin/linedesk-sip-firewall` | at boot, before Docker |
| `--cloudflare`: web ports only from Cloudflare (an install behind its proxy), IPv4 and IPv6; the list is refreshed by each run and refused if it looks wrong | `bin/linedesk-web-firewall` | at boot, before Docker |
| `--monitor <host> [--monitor-sip <host>]`: web, API, LiveKit and SIP of another install, from this server; email after 2 failures in a row and when back | `bin/linedesk-monitor` | every 2 minutes |
| `--harden-ssh`: keys only, no root login, 3 tries (refuses unless a sudo user with a full SSH key exists; checks `sshd -t` first and `sshd -T` after) | `etc/sshd-hardening.conf` | |
| `--ufw`: only SSH reaches the host's own services (Docker's published ports go past ufw; the firewalls above cover them) | | |

Both firewalls fail closed: every entry is checked before anything changes, and each chain is replaced in one step, so it never exists without its final DROP. A firewall, check or backup that fails sends an alert, at most one per unit every 6 hours. Alert emails carry a unit's last log lines without row data, and the SMTP password never shows on a command line.

Settings live in `/etc/linedesk/ops.env` (no secrets). Test the email: `/usr/local/sbin/linedesk-alert-text Test "Alerts work."`.

Linedesk's own servers: production runs it with `--label prod --cloudflare --harden-ssh --ufw`; staging with `--label staging --monitor app.linedesk.ai --monitor-sip sip.linedesk.ai`, so production is checked from another provider. Staging's address is in production's `/etc/linedesk/sip-allow.local.txt` for the SIP check.
