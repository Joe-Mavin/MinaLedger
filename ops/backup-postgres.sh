#!/bin/sh
set -eu

: "${PGHOST:?Database host is required}"
: "${PGPORT:?Database port is required}"
: "${PGUSER:?Database user is required}"
: "${PGDATABASE:?Database name is required}"
: "${PGPASSWORD:?Database password is required}"

backup_root=${BACKUP_ROOT:-/backups}
case "$backup_root" in
  /*) ;;
  ..|../*|*/../*|*/..) echo "Relative backup directory cannot escape the current directory." >&2; exit 2 ;;
  *) ;;
esac
backup_root=${backup_root%/}
if [ -z "$backup_root" ]; then
  echo "Backup directory must not be empty or the filesystem root." >&2
  exit 2
fi
backup_file=${BACKUP_FILE:-"$backup_root/${PGDATABASE}-$(date -u +%Y%m%dT%H%M%SZ).dump"}
case "$backup_file" in
  "$backup_root"/*) ;;
  *) echo "Backup output must be a file directly under the configured backup directory." >&2; exit 2 ;;
esac
base_name=${backup_file##*/}
if [ -z "$base_name" ] || [ "$backup_file" != "$backup_root/$base_name" ]; then
  echo "Backup output must be a file directly under the configured backup directory." >&2
  exit 2
fi

mkdir -p "$backup_root"
temporary_file="$backup_root/.${base_name}.partial.$$"
if [ -e "$backup_file" ] || [ -e "$temporary_file" ]; then
  echo "Backup output already exists; refusing to overwrite it." >&2
  exit 2
fi
trap 'rm -f "$temporary_file"' EXIT HUP INT TERM

pg_dump --no-password --format=custom --no-owner --no-acl \
  --host "$PGHOST" --port "$PGPORT" --username "$PGUSER" \
  --dbname "$PGDATABASE" --file "$temporary_file"
pg_restore --list "$temporary_file" >/dev/null
chmod 600 "$temporary_file"
mv -n "$temporary_file" "$backup_file"
if [ -e "$temporary_file" ]; then
  echo "Backup destination appeared during creation; refusing to overwrite it." >&2
  exit 2
fi
printf 'Backup verified: %s (%s bytes)\n' "$backup_file" "$(wc -c < "$backup_file" | tr -d ' ')"
