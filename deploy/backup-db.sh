#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/ynzy-miniapp}"
DATA_FILE="${DATA_FILE:-$APP_DIR/server/data/db.json}"
BACKUP_DIR="${BACKUP_DIR:-/opt/ynzy-miniapp-backups/db}"
KEEP="${KEEP:-48}"

if [ ! -f "$DATA_FILE" ]; then
  echo "db backup skipped: data file not found"
  exit 0
fi

mkdir -p "$BACKUP_DIR"

node -e "const fs=require('fs'); JSON.parse(fs.readFileSync(process.argv[1], 'utf8').replace(/^\\uFEFF/, '') || '{}')" "$DATA_FILE"

stamp="$(date +%Y%m%d%H%M%S)"
target="$BACKUP_DIR/db-$stamp.json"
tmp="$target.tmp"

cp "$DATA_FILE" "$tmp"
chmod 600 "$tmp"
mv "$tmp" "$target"
ln -sfn "$target" "$BACKUP_DIR/latest.json"

find "$BACKUP_DIR" -maxdepth 1 -type f -name 'db-*.json' -printf '%T@ %p\n' |
  sort -nr |
  awk -v keep="$KEEP" 'NR > keep { sub(/^[^ ]+ /, ""); print }' |
  xargs -r rm -f

echo "db backup written: $target"
