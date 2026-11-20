#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT HUP INT TERM
mock_bin="$test_root/bin"
backup_root="$test_root/backups"
mkdir -p "$mock_bin" "$backup_root"

cat > "$mock_bin/pg_dump" <<'MOCK'
#!/bin/sh
set -eu
output=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --file) output=$2; shift 2 ;;
    *) shift ;;
  esac
done
: "${output:?pg_dump mock did not receive --file}"
: > "$output"
observed_umask=$(umask)
case "$observed_umask" in
  0077|077) ;;
  *) echo "pg_dump inherited umask $observed_umask; expected 0077." >&2; exit 1 ;;
esac
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) ;;
  *)
    mode=$(stat -c '%a' "$output")
    if [ "$mode" != 600 ]; then
      echo "Temporary archive mode was $mode before pg_dump completed; expected 600." >&2
      exit 1
    fi
    ;;
esac
if [ "${MOCK_PG_DUMP_FAIL:-0}" = 1 ]; then
  exit 42
fi
printf 'mock archive contents\n' > "$output"
MOCK

cat > "$mock_bin/pg_restore" <<'MOCK'
#!/bin/sh
set -eu
[ "${1:-}" = --list ]
[ -s "${2:?archive path is required}" ]
MOCK
chmod 700 "$mock_bin/pg_dump" "$mock_bin/pg_restore"

export PATH="$mock_bin:$PATH"
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=backup_test PGDATABASE=minaledger_test PGPASSWORD=test_only
export BACKUP_ROOT="$backup_root"
export BACKUP_FILE="$backup_root/permissions-test.dump"

sh "$repository_root/ops/backup-postgres.sh"
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) printf 'Unix permission bits are not reported reliably on this Windows filesystem; umask was verified inside pg_dump.\n' ;;
  *)
    final_mode=$(stat -c '%a' "$BACKUP_FILE")
    [ "$final_mode" = 600 ] || { echo "Final archive mode was $final_mode; expected 600." >&2; exit 1; }
    ;;
esac

if sh "$repository_root/ops/backup-postgres.sh" >/dev/null 2>&1; then
  echo "Backup script overwrote an existing archive." >&2
  exit 1
fi
[ "$(cat "$BACKUP_FILE")" = 'mock archive contents' ] || { echo "Existing archive content changed." >&2; exit 1; }

export BACKUP_FILE="$backup_root/failure-test.dump"
export MOCK_PG_DUMP_FAIL=1
if sh "$repository_root/ops/backup-postgres.sh" >/dev/null 2>&1; then
  echo "Backup script unexpectedly succeeded after the mock dump failed." >&2
  exit 1
fi
[ ! -e "$BACKUP_FILE" ] || { echo "Failed backup left a published archive." >&2; exit 1; }
set -- "$backup_root"/.failure-test.dump.partial.*
[ ! -e "$1" ] || { echo "Failed backup left a temporary archive." >&2; exit 1; }

printf 'Backup permission, no-overwrite, and failure-cleanup checks passed.\n'
