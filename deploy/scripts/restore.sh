#!/usr/bin/env bash
# ChatE SQLite restore from a backup produced by backup.sh.
# Usage: sudo ./restore.sh /var/backups/chate/chate-YYYYmmddTHHMMSSZ.sqlite.gz [--yes]
# Requires: gzip, sha256sum, sqlite3 OR node, systemctl, root.
# Steps: stop services -> verify checksum -> swap file (current DB kept aside)
#        -> drop stale WAL/SHM -> migrate -> start -> health check.
set -Eeuo pipefail

BACKUP="${1:-}"
ASSUME_YES="${2:-}"
[[ -n "$BACKUP" && -f "$BACKUP" ]] || { echo "usage: restore.sh <backup.sqlite.gz> [--yes]" >&2; exit 1; }
[[ -f "$BACKUP.sha256" ]] || { echo "FATAL: missing checksum $BACKUP.sha256" >&2; exit 1; }

DB_PATH="${SQLITE_PATH:-/var/lib/chate/chate.sqlite}"
APP_DIR="${APP_DIR:-/opt/chate}"
ENV_FILE="${ENV_FILE:-/etc/chate/chate.env}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "== 1/8 verify checksum"
EXPECTED="$(cat "$BACKUP.sha256")"
ACTUAL="$(sha256sum "$BACKUP" | awk '{print $1}')"
[[ "$EXPECTED" == "$ACTUAL" ]] || { echo "FATAL: sha256 mismatch" >&2; exit 2; }

echo "== 2/8 decompress"
gzip -dc "$BACKUP" > "$WORK/restored.sqlite"
chmod 600 "$WORK/restored.sqlite"

echo "== 3/8 sqlite integrity_check"
if command -v sqlite3 >/dev/null 2>&1; then
  VERDICT="$(sqlite3 "$WORK/restored.sqlite" 'PRAGMA integrity_check;')"
  [[ "$VERDICT" == "ok" ]] || { echo "FATAL: integrity $VERDICT" >&2; exit 2; }
  MIGRATIONS="$(sqlite3 "$WORK/restored.sqlite" 'SELECT COUNT(*) FROM schema_migrations;')"
else
  MIGRATIONS="$(node --input-type=module -e '
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    const ok = db.prepare("PRAGMA integrity_check").get().integrity_check;
    if (ok !== "ok") { console.error(ok); process.exit(2); }
    console.log(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get().n);
    db.close();
  ' "$WORK/restored.sqlite")"
fi
echo "   integrity=ok schema_migrations=$MIGRATIONS"

if [[ "$ASSUME_YES" != "--yes" ]]; then
  read -r -p "Restore $BACKUP over $DB_PATH ? type RESTORE: " REPLY
  [[ "$REPLY" == "RESTORE" ]] || { echo "aborted"; exit 1; }
fi

echo "== 4/8 stop chate-web + chate-worker"
systemctl stop chate-web.service chate-worker.service || true
if systemctl is-active --quiet chate-web.service; then echo "FATAL: web still running" >&2; exit 1; fi

echo "== 5/8 keep current database aside"
if [[ -f "$DB_PATH" ]]; then
  cp -a "$DB_PATH" "$DB_PATH.pre-restore-$STAMP"
  [[ -f "$DB_PATH-wal" ]] && cp -a "$DB_PATH-wal" "$DB_PATH.pre-restore-$STAMP-wal" || true
  [[ -f "$DB_PATH-shm" ]] && cp -a "$DB_PATH-shm" "$DB_PATH.pre-restore-$STAMP-shm" || true
fi
rm -f "$DB_PATH-wal" "$DB_PATH-shm" "$DB_PATH-journal"

echo "== 6/8 install restored file"
install -o chate -g chate -m 600 "$WORK/restored.sqlite" "$DB_PATH"

echo "== 7/8 apply pending migrations"
set -a
. "$ENV_FILE"
set +a
( cd "$APP_DIR" && sudo -u chate env NODE_ENV=production SQLITE_PATH="$DB_PATH" \
    /usr/bin/node node_modules/tsx/dist/cli.mjs scripts/migrate.ts )

echo "== 8/8 start services + health check"
systemctl start chate-web.service chate-worker.service
for i in $(seq 1 30); do
  if curl -fsS --max-time 3 http://127.0.0.1:3211/api/models >/dev/null 2>&1; then
    echo "OK restored and healthy (attempt $i). Previous DB: $DB_PATH.pre-restore-$STAMP"
    exit 0
  fi
  sleep 2
done
echo "FATAL: web did not become healthy in 60s; roll back with:" >&2
echo "  systemctl stop chate-web chate-worker && mv $DB_PATH.pre-restore-$STAMP $DB_PATH && rm -f $DB_PATH-wal $DB_PATH-shm && systemctl start chate-web chate-worker" >&2
exit 3
