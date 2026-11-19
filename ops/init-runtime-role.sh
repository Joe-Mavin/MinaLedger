#!/bin/sh
set -eu

: "${APP_DATABASE_USER:?Set APP_DATABASE_USER before initializing PostgreSQL}"
: "${APP_DATABASE_PASSWORD:?Set APP_DATABASE_PASSWORD before initializing PostgreSQL}"
if [ "$APP_DATABASE_USER" = "$POSTGRES_USER" ]; then
  echo "Runtime and database administrator roles must be different." >&2
  exit 2
fi
if [ "$APP_DATABASE_PASSWORD" = "$POSTGRES_PASSWORD" ]; then
  echo "Runtime and database administrator passwords must be different." >&2
  exit 2
fi
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
case "$APP_DATABASE_PASSWORD" in
  *[!a-fA-F0-9]*) echo "Runtime database password must be hexadecimal." >&2; exit 2 ;;
esac
if [ "${#APP_DATABASE_PASSWORD}" -lt 64 ]; then
  echo "Runtime database password must contain at least 64 hexadecimal characters." >&2
  exit 2
fi

psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv app_user APP_DATABASE_USER
\getenv app_password APP_DATABASE_PASSWORD
CREATE ROLE :"app_user" LOGIN PASSWORD :'app_password';
SQL
