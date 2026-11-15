# WAL archiving: restores that lose minutes, not a day

The nightly `pg_dump` (`scripts/backup.sh`, README "Backups") loses everything since 09:00 UTC when it is needed. WAL archiving keeps Postgres's write-ahead log as well: every change, shipped to the backup bucket within about two minutes. A restore takes the newest base backup and replays the log to the latest moment, or to a chosen moment (just before a mistake). The nightly dumps stay as a second, independent way back.

## How it works

| Part | What | Where |
| --- | --- | --- |
| Postgres | `archive_mode=on`; each finished WAL segment, gzipped, into the volume `walarchive`; `archive_timeout` closes a segment at most a minute after a change (`LINEDESK_WAL_ARCHIVE_TIMEOUT`, seconds, default 60) | `docker-compose.wal.yml` |
| Upload | every minute: moves the segments to `<BACKUP_S3_PREFIX>wal/` in the backup bucket (rclone, deleted locally once uploaded and its checksum matches); fails, and alerts, when a segment waits over 15 minutes or Postgres reports failed archiving (`pg_stat_archiver`), and sends one email when it is fine again; skips a turn while Postgres is down (a deploy) or a restore runs | `scripts/wal-archive.sh`, `linedesk-wal-archive.timer` |
| Base backup | every night 03:00 UTC: `pg_basebackup` (tar, gzip), checked, to `<prefix>base/`; deletes base backups older than `BACKUP_WAL_KEEP_DAYS` (7) and WAL one day older | `scripts/wal-base-backup.sh`, `linedesk-wal-base.timer` |
| Restore | the last WAL closed and uploaded first, then the newest base backup before the moment and WAL replayed up to it (in a container with the stack's own archive settings, so the new timeline is archived), the stack started again and a fresh base backup made; refuses a "latest" restore that stops short of the newest segment of its timeline (a gap), and on any failure puts the data from before back and starts the stack; that data stays in a private directory in `/var/tmp` | `scripts/wal-restore.sh ['2026-11-14 09:41:00+00']` |

Postgres stays on its internal network with no keys and no internet: only the host (as the stack's user) holds the bucket key, in `backup.env` as for the dumps. Same bucket and key, under its own prefix, so nothing new to create or rotate. The bucket holds the WAL of one database only: its system identifier is noted next to the WAL (`wal/SYSTEM_IDENTIFIER`), and another database with the same prefix (a new install, staging pointed at production's bucket) is refused.

## Security

- WAL is every change, nearly as it happens, and not encrypted: sign-in sessions, OAuth tokens of connected calendars and email codes pass through it, as they do through the nightly dumps. Anyone with the bucket key can read it, so the key stays in `backup.env` (mode 600) on the server only.
- The same key can delete the backups. Recommended, and Tim's decision: an R2 bucket lock (retention rule) on the backup bucket for at least as long as the scripts keep things (7 days for `base/`, 8 for `wal/`, 30 for the dumps), so a leaked key cannot wipe them. Production's backup bucket has it, and WAL archiving is on there (Tim, 2026-11-15).

## Numbers

- Data lost in a restore: up to about 2 minutes (`archive_timeout` 60 s plus the upload every minute). An idle database writes nothing, so nothing is lost there.
- Restore time: a few minutes for today's database (download, unpack, replay). Calls cannot be answered meanwhile.
- Cost: a segment that a minute's activity closes is 16 MB in Postgres but mostly empty, about 20 to 100 kB gzipped. A busy day is at most 1,440 segments, so about 150 MB a day and about 1 GB for 7 days. That is well inside R2's free 10 GB, and at most about 45,000 uploads a month against the free 1 million.
- Load: one gzip per segment in Postgres, one rclone run a minute on the host (a second of CPU), one base backup a night.

## Turn it on

1. `backup.env` set up and the nightly backup working (README "Backups").
2. `.env`: append `:docker-compose.wal.yml` to `COMPOSE_FILE`, then `scripts/deploy.sh --no-build`. Postgres is recreated with the new settings at a moment without calls (the deploy waits for one).
3. `sudo ops/server/setup.sh` (it enables both timers once it sees the file in `COMPOSE_FILE`).
4. `scripts/wal-base-backup.sh` once, so there is a base backup today; `scripts/backup.sh --list` shows `base/` and `wal/`.

Encrypted backups (`BACKUP_AGE_RECIPIENT`) are not supported yet: the scripts refuse rather than upload unencrypted WAL next to encrypted dumps.

## Tested

A drill on the staging server, with a throwaway Postgres 17 (the stack's image) and an S3 stand-in (`rclone serve s3`). 100 rows went in before the base backup, 100 after it, then a timestamp T1, then 100 more:

- a restore to the latest moment had all 300 rows, and the new timeline's history reached the bucket;
- after deleting every row, a restore to T1 had exactly 200 (Postgres: "recovery stopping before commit … 12:13:58");
- a second restore to the latest moment right after kept the 200 (it follows the newest timeline, not the abandoned one);
- with a segment of the current timeline removed from the bucket, a restore to the latest moment refused ("the replay stopped at segment 13 of timeline 4, but the archive goes to 16") and put the data back (500 rows before and after);
- archiving went on after each restore.

## Not (yet)

- Encryption of WAL (depends on the decision about encrypted backups; the scripts refuse while `BACKUP_AGE_RECIPIENT` is set).
- A second bucket or account for backups (today one key can delete dumps and WAL).
- A standby server (a restore still takes minutes, not seconds).
