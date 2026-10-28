#!/usr/bin/env bash
# ChatE online SQLite backup (safe while web + worker are writing).
# Usage:  ./backup.sh [--with-storage] [dest-dir]
# Defaults: SQLITE_PATH=/var/lib/chate/chate.sqlite, BACKUP_DIR=/var/backups/chate
# Requires: sqlite3 CLI OR node >= 22.5 (node:sqlite fallback), gzip, sha256sum.
# Exit codes: 0 ok, 1 usage/config error, 2 backup/integrity failure.
set -Eeuo pipefail

DB_PATH="${SQLITE_PATH:-/var/lib/chate/chate.sqlite}"
DEST="${BACKUP_DIR:-/var/backups/chate}"
STORAGE_DIR_PATH="${STORAGE_DIR:-/var/lib/chate/storage}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
WITH_STORAGE=0

for arg in "$@"; do
  case "$arg" in
    --with-storage) WITH_STORAGE=1 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) DEST="$arg" ;;
  esac
done

[[ -f "$DB_PATH" ]] || { echo "FATAL: database not found: $DB_PATH" >&2; exit 1; }
mkdir -p "$DEST"
chmod 700 "$DEST"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BASE="$DEST/chate-$STAMP.sqlite"
TMP="$BASE.tmp"
trap 'rm -f "$TMP" "$BASE.gz.tmp"' EXIT

# 1) Consistent snapshot. Both methods read the live WAL database safely.
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB_PATH" ".timeout 10000" ".backup '$TMP'"
else
  command -v node >/dev/null 2>&1 || { echo "FATAL: need sqlite3 or node" >&2; exit 1; }
  node --input-type=module -e '
    import { DatabaseSync } from "node:sqlite";
    const [src, dst] = process.argv.slice(1);
    const db = new DatabaseSync(src);
    try {
      db.exec("PRAGMA busy_timeout = 10000");
      const q = String.fromCharCode(39);
      db.exec("VACUUM INTO " + q + dst.split(q).join(q + q) + q);
    } finally { db.close(); }
  ' "$DB_PATH" "$TMP"
fi

# 2) Integrity must pass before the file is promoted.
if command -v sqlite3 >/dev/null 2>&1; then
  VERDICT="$(sqlite3 "$TMP" 'PRAGMA integrity_check;')"
else
  VERDICT="$(node --input-type=module -e '
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    console.log(db.prepare("PRAGMA integrity_check").get().integrity_check);
    db.close();
  ' "$TMP")"
fi
[[ "$VERDICT" == "ok" ]] || { echo "FATAL: integrity_check=$VERDICT" >&2; exit 2; }

mv "$TMP" "$BASE"
chmod 600 "$BASE"
gzip -9 "$BASE"
sha256sum "$BASE.gz" | awk '{print $1}' > "$BASE.gz.sha256"
chmod 600 "$BASE.gz" "$BASE.gz.sha256"

echo "OK db backup: $BASE.gz ($(stat -c%s "$BASE.gz") bytes, integrity=ok, retention=${RETENTION_DAYS}d)"

# 3) Private file bytes live outside SQLite (metadata only is in the DB).
if [[ "$WITH_STORAGE" == "1" && -d "$STORAGE_DIR_PATH" ]]; then
  TAR="$DEST/chate-storage-$STAMP.tar.gz"
  tar -C "$(dirname "$STORAGE_DIR_PATH")" -czf "$TAR" "$(basename "$STORAGE_DIR_PATH")"
  chmod 600 "$TAR"
  sha256sum "$TAR" | awk '{print $1}' > "$TAR.sha256"
  echo "OK storage backup: $TAR ($(stat -c%s "$TAR") bytes)"
fi

# 4) Retention. Never delete the only recent copy without this window.
find "$DEST" -maxdepth 1 -type f \( -name 'chate-*.sqlite.gz*' -o -name 'chate-storage-*.tar.gz*' \) \
  -mtime +"$RETENTION_DAYS" -print -delete

# 5) Offsite copy (uncomment and configure; do not leave backups only on the VPS).
# rsync -az --delete-after "$DEST/" backup-host:/srv/chate-backups/$(hostname)/
echo "DONE $(date -u +%FT%TZ)"
