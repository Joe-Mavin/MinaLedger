#!/bin/sh
set -eu

: "${PGHOST:?Database host is required}"
: "${PGPORT:?Database port is required}"
: "${PGUSER:?Database user is required}"
: "${PGDATABASE:?Source database name is required}"
: "${PGPASSWORD:?Database password is required}"
: "${APP_DATABASE_USER:?Runtime database user is required}"
: "${APP_DATABASE_PASSWORD:?Runtime database password is required}"
: "${RESTORE_BACKUP_FILE:?Set the backup archive path explicitly}"
: "${RESTORE_TARGET_DATABASE:?Set a new target database ending in _restore_test}"
: "${RESTORE_CONFIRM_TARGET_DATABASE:?Repeat the restore target name for confirmation}"

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
backup_file=$RESTORE_BACKUP_FILE
target=$RESTORE_TARGET_DATABASE
case "$APP_DATABASE_USER" in
  [a-z]* ) ;;
  *) echo "Runtime database user must start with a lowercase letter." >&2; exit 2 ;;
esac
case "$APP_DATABASE_USER" in
  *[!a-z0-9_]*) echo "Runtime database user may contain only lowercase letters, digits, and underscores." >&2; exit 2 ;;
esac
if [ "${#APP_DATABASE_USER}" -gt 63 ]; then
  echo "Runtime database user must be at most 63 characters." >&2
  exit 2
fi
case "$backup_file" in
  "$backup_root"/*) ;;
  *) echo "Restore input must be a file directly under the configured backup directory." >&2; exit 2 ;;
esac
base_name=${backup_file##*/}
if [ -z "$base_name" ] || [ "$backup_file" != "$backup_root/$base_name" ] || [ ! -f "$backup_file" ]; then
  echo "Restore input must name an existing archive directly under the configured backup directory." >&2
  exit 2
fi
case "$target" in
  *_restore_test) ;;
  *) echo "Restore target must end in _restore_test." >&2; exit 2 ;;
esac
case "$target" in
  *[!a-zA-Z0-9_]*) echo "Restore target may contain only letters, digits, and underscores." >&2; exit 2 ;;
esac
if [ "${#target}" -gt 63 ]; then
  echo "Restore target must be at most 63 characters." >&2
  exit 2
fi
if [ "$target" = "$PGDATABASE" ] || [ "$target" != "$RESTORE_CONFIRM_TARGET_DATABASE" ]; then
  echo "Restore target must be separately named, differ from the source, and match its confirmation." >&2
  exit 2
fi

pg_restore --list "$backup_file" >/dev/null
existing=$(psql --no-password --host "$PGHOST" --port "$PGPORT" --username "$PGUSER" \
  --dbname postgres --tuples-only --no-align --command "SELECT 1 FROM pg_database WHERE datname = '$target'")
if [ -n "$existing" ]; then
  echo "Restore target already exists; refusing to modify or replace it." >&2
  exit 2
fi

createdb --no-password --host "$PGHOST" --port "$PGPORT" --username "$PGUSER" \
  --maintenance-db postgres "$target"
pg_restore --no-password --exit-on-error --no-owner --no-acl --host "$PGHOST" --port "$PGPORT" \
  --username "$PGUSER" --dbname "$target" "$backup_file"

psql --no-password --host "$PGHOST" --port "$PGPORT" --username "$PGUSER" --dbname "$target" \
  --set ON_ERROR_STOP=1 --command "GRANT CONNECT ON DATABASE \"$target\" TO \"$APP_DATABASE_USER\"; GRANT USAGE ON SCHEMA public TO \"$APP_DATABASE_USER\"; GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO \"$APP_DATABASE_USER\"; GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO \"$APP_DATABASE_USER\"; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO \"$APP_DATABASE_USER\"; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO \"$APP_DATABASE_USER\""

actual_migrations=$(psql --no-password --host "$PGHOST" --port "$PGPORT" --username "$PGUSER" \
  --dbname "$target" --tuples-only --no-align --command 'SELECT name FROM schema_migration ORDER BY name')
expected_migrations=$(for migration in /migrations/*.sql; do basename "$migration"; done)
if [ "$actual_migrations" != "$expected_migrations" ]; then
  echo "Restored migration history does not match the migrations in this application version." >&2
  echo "The restored target database was retained for investigation." >&2
  exit 1
fi

schema_ok=$(psql --no-password --host "$PGHOST" --port "$PGPORT" --username "$PGUSER" \
  --dbname "$target" --tuples-only --no-align --command \
  "SELECT (to_regclass('public.user_account') IS NOT NULL AND to_regclass('public.audit_checkpoint') IS NOT NULL)::text")
if [ "$schema_ok" != "true" ]; then
  echo "Restored schema verification failed; the target database was retained for investigation." >&2
  exit 1
fi
runtime_access=$(PGPASSWORD="$APP_DATABASE_PASSWORD" psql --no-password --host "$PGHOST" --port "$PGPORT" \
  --username "$APP_DATABASE_USER" --dbname "$target" --tuples-only --no-align \
  --command 'SELECT count(*) >= 0 FROM public.user_account')
if [ "$runtime_access" != "t" ]; then
  echo "Restored application role could not read its schema; target database was retained for investigation." >&2
  exit 1
fi
printf 'Restore verified in separate database %s; %s migrations match this application version.\n' \
  "$target" "$(printf '%s\n' "$actual_migrations" | wc -l | tr -d ' ')"
