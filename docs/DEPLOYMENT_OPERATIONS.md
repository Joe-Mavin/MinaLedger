# Staging deployment and operations

This runbook describes a provider-neutral Docker Compose staging setup. It prepares deployment artifacts; it does not deploy MinaLedger, authorize a pilot, provision real participant records, or establish production readiness.

## Readiness assessment

| Area | Current state |
|---|---|
| API, web client, PostgreSQL and checkpoint worker | Compose definitions and container builds are implemented. The API and worker share the existing backend code; they do not add business workflows. |
| Database exposure and persistence | PostgreSQL has no published host port, is on an internal Compose network, and uses a persistent volume. The API runtime uses a restricted database role; migration and maintenance operations use the initial database administrator role. |
| Migrations | A one-shot `migrate` service applies reviewed SQL only when explicitly invoked. Application startup does not run migrations. It then grants the runtime role access to current and future schema objects. |
| HTTPS | TLS terminates at the hosting reverse proxy. Compose publishes the web container only on host loopback. No public TLS listener, certificate, domain, or hosting resource is created here. |
| Health and logs | `/livez` is a process liveness endpoint; `/readyz` checks PostgreSQL. `/healthz` remains a compatibility alias for readiness. Request URLs are query-stripped and QR lookup tokens are redacted in request logs. Logs are structured JSON to stdout/stderr. |
| Backups | `pg_dump` custom-format backup and separate-database restore verification scripts are included. A successful run must be observed and retained by the deployment operator; repository scripts alone are not evidence of a working backup. |
| Product demonstration | The app supports sign-in, assigned site/hole context, production capture, measurement, offline synchronization and audit-checkpoint views. It does not provide one complete UI journey for provisioning, allocation review, Dora processing, recovery/consignment, or gold-trade/payment reconciliation. Several workflows remain API-only, and allocation approval is intentionally not implemented. |

## Prerequisites and images

The staging host needs Docker Engine with Docker Compose v2, a protected and preferably encrypted backup directory, persistent disk space, and an HTTPS reverse proxy. Configure host firewall rules and restrict Docker daemon access; a Docker administrator can read container environment and database volumes. The database volume must be included in host-level storage monitoring.

The container recipes use fixed patch tags for Node.js 24.22.3, PostgreSQL 18.7 and NGINX 1.30.7. PostgreSQL 18's official image stores data under `/var/lib/postgresql`, which is the mounted volume path in the Compose file. Confirm image tags and security updates before each staging release. Before any real pilot, choose a digest-pinning and image-update procedure with the hosting owner. References: [Node.js release status](https://nodejs.org/en/about/previous-releases), [official PostgreSQL image metadata](https://github.com/docker-library/official-images/blob/master/library/postgres), [PostgreSQL version support](https://www.postgresql.org/support/versioning/), [NGINX stable releases](https://nginx.org/en/download.html), and [PostgreSQL 18 image storage layout](https://github.com/docker-library/postgres/blob/master/18/alpine3.24/Dockerfile).

## Configure staging secrets

Copy `deploy/staging.env.example` to the ignored local file `deploy/.env.staging`. Set `BACKUP_DIR` to an absolute, access-controlled directory outside the checkout (for example, `C:/MinaLedgerProtectedBackups` on Windows or `/var/backups/minaledger-staging` on Linux). Generate independent hexadecimal secrets for `POSTGRES_PASSWORD`, `APP_DATABASE_PASSWORD`, and `JWT_SECRET`; each password placeholder must be replaced before starting the stack. For example, generate a value locally with:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Use a different output for each secret. Store the resulting env file with restrictive host ACLs; do not paste it into tickets or logs. Compose passes the API and database credentials only to the services that need them; Docker administrators can inspect container environments and volumes. The checkpoint worker and migration job do not receive the JWT signing secret. A hosting secret manager and rotation procedure are owner decisions. The Postgres init script creates a non-superuser application role only when initializing a new database volume. Changing the role password later requires a controlled database operation and coordinated environment update.

Set `CORS_ORIGIN` to the exact browser origin, including `https://` and no path. `TRUST_PROXY_HOPS=1` is correct only for the shipped web proxy behind a hosting proxy that replaces `X-Forwarded-For` with the single client address. The hosting proxy must also set `X-Forwarded-Proto` to the external scheme. If the actual trusted chain differs, determine and set the exact hop count; never trust arbitrary forwarded headers. Login limits default to 10 attempts per 15 minutes and remain unchanged unless the owner explicitly configures a stricter value.

`DATABASE_SSL=disable` is set only for API, worker and maintenance traffic on the isolated private Compose database network. This opt-out must not be reused for an externally reachable or managed database. The production default remains `DATABASE_SSL=require` with certificate verification enabled. TLS from browsers terminates at the hosting reverse proxy; configure HTTPS, certificate renewal, HSTS and secure forwarding there. The web port binds to `127.0.0.1` and must not be changed to a public bind address.

## Build, migrate and start

Run from the repository root after creating and securing `deploy/.env.staging`:

```powershell
docker compose --env-file deploy/.env.staging -f deploy/compose.staging.yml build
docker compose --env-file deploy/.env.staging -f deploy/compose.staging.yml --profile manual run --rm migrate
docker compose --env-file deploy/.env.staging -f deploy/compose.staging.yml up -d
docker compose --env-file deploy/.env.staging -f deploy/compose.staging.yml ps
Invoke-RestMethod http://127.0.0.1:8080/livez
Invoke-RestMethod http://127.0.0.1:8080/readyz
```

The explicit migration command starts PostgreSQL if needed, applies pending migration files, then grants the runtime role access to the schema. Check its exit code before starting or updating the API. `up` does not invoke migrations. The API and checkpoint worker wait for a healthy database; the web container waits for API readiness. PostgreSQL and the API are not published on host ports. Only NGINX is published on host loopback. The web container proxies the same-origin API paths and serves the production-built PWA.

For browser access, configure the hosting proxy to forward the staging hostname over HTTPS to `http://127.0.0.1:8080`, with sanitized forwarded headers. Keep the API and database unreachable from the public network. The Vite production client uses the current browser origin as its API base; the development client retains the local API default.

### Initial administrator bootstrap

Bootstrap only after the first migration and before creating any other user. The bootstrap command runs as the restricted application role and reads the password from the temporary process environment. In PowerShell, collect it without echo and clear it afterward:

```powershell
$env:BOOTSTRAP_ADMIN_EMAIL = 'admin@example.invalid'
$env:BOOTSTRAP_ADMIN_DISPLAY_NAME = 'Staging administrator'
$secret = Read-Host 'Initial admin password (12-72 bytes)' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
try {
  $env:BOOTSTRAP_ADMIN_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  docker compose --env-file deploy/.env.staging -f deploy/compose.staging.yml run --rm --no-deps `
    -e BOOTSTRAP_ADMIN_EMAIL -e BOOTSTRAP_ADMIN_DISPLAY_NAME -e BOOTSTRAP_ADMIN_PASSWORD `
    api npm run bootstrap-admin
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  Remove-Item Env:BOOTSTRAP_ADMIN_EMAIL, Env:BOOTSTRAP_ADMIN_DISPLAY_NAME, Env:BOOTSTRAP_ADMIN_PASSWORD -ErrorAction SilentlyContinue
}
```

A global `SYSTEM_ADMIN` can provision accounts and role grants but receives no automatic access to a site. The bootstrap login alone cannot demonstrate operational workflows; authorized site/hole relationships and fictional test records must be provisioned in an isolated staging database through reviewed API requests. There is no in-app administration or sample-data seeding flow.

## Observe service health and logs

`/livez` only indicates that the API process responds. `/readyz` and the backward-compatible `/healthz` run a database query. Compose uses readiness to gate web startup and report API/web health. The checkpoint worker has no separate HTTP endpoint; observe its container state and structured startup/error logs. It authenticates before polling and continues to use the existing transactional outbox lease/retry implementation. No duplicate domain event path was added.

```powershell
docker compose --env-file deploy/.env.staging -f deploy/compose.staging.yml ps
docker compose --env-file deploy/.env.staging -f deploy/compose.staging.yml logs --since 15m api checkpoint-worker web db
```

API and web logs omit query strings, redact opaque QR token path segments, omit credentials and request bodies, and retain request IDs for support. The NGINX access log does not record client IP, referer or user agent. Do not export raw logs with participant or commercial identifiers to public tickets. The login limiter is in-memory for this single API instance; do not scale API replicas without choosing a shared rate-limit store or an equivalent gateway control. There is no metrics endpoint, alert service, centralized log retention or on-call schedule in this slice; the hosting owner must select and operate those controls.

## Backup and restore verification

The Compose maintenance service runs PostgreSQL client tools over the private database network. It writes a custom-format `pg_dump` archive into `BACKUP_DIR`, validates the archive list, uses a temporary file, sets the archive mode to owner-only where supported, and refuses to overwrite an existing archive. The host backup directory must have restrictive ACLs and should be encrypted at rest. The procedure does not encrypt the archive itself, upload it off-host, retain it, or monitor backup freshness.

Create a backup:

```powershell
docker compose --env-file deploy/.env.staging -f deploy/compose.staging.yml --profile maintenance run --rm backup
```

The filename includes the database name and UTC timestamp. Verify the file exists in the configured host directory and copy it to an independently protected location. A **proposed** starting retention policy is 30 daily backups plus 12 month-end backups, with an extra retained pre-release copy; capacity, privacy retention, recovery objectives and deletion approval remain owner decisions.

Restore verification creates a new database and never drops or cleans a database. Set all three values in `deploy/.env.staging` for the exact archive and a new target name ending in `_restore_test`; the confirmation must exactly match. The backup must be directly under `BACKUP_DIR`:

```text
RESTORE_BACKUP_FILE=/backups/minaledger_staging-YYYYMMDDTHHMMSSZ.dump
RESTORE_TARGET_DATABASE=minaledger_YYYYMMDD_restore_test
RESTORE_CONFIRM_TARGET_DATABASE=minaledger_YYYYMMDD_restore_test
```

Then invoke:

```powershell
docker compose --env-file deploy/.env.staging -f deploy/compose.staging.yml --profile maintenance run --rm restore-test
```

The script refuses an existing target, a target equal to the application database, an unconfirmed target, a name without the `_restore_test` suffix, or an archive outside the mounted backup directory. It restores without `--clean`, checks that migration history exactly matches the checked-out migration files, confirms required tables exist, grants the runtime role on the restored copy, and tests that role's schema read. A failure leaves the new database in place for investigation and prints no credentials. Do not run the restore test against a production cluster unless the owner explicitly approves the disposable target and associated capacity. Review and remove a test database only through a separate, explicit cleanup action after confirming its exact name and that it is not in use.

This restore verification is not a disaster-recovery switchover. For an actual recovery, the owner must select a new isolated database, preserve the failed source, check the application image/migration compatibility, validate access and data with the responsible parties, and approve a controlled endpoint switch. Never overwrite the source database. Migrations have no automatic down-migration; application rollback after a schema change may be unsafe. Restore the pre-release backup into a separate database and use a compatible application image instead of guessing a rollback.

## Updates, rollback and incident handling

Before a staging update, create and verify a backup, review the migration SQL and application image changes, build the selected image tags, apply the one-shot migration, then start/recreate services and check `/livez`, `/readyz`, logs and the critical workflows. Preserve the previous image digest and backup. Forward migrations are additive, but compatibility with an older application version is not guaranteed; migration rollback scripts are not a deployment rollback command.

For an API outage, compare liveness and readiness, inspect API/database/worker logs using the request ID, and stop affected writes if database availability or consistency is uncertain. Preserve local offline queues on devices; do not clear browser storage or edit a submitted envelope to force synchronization. Reconnect when service is restored, use the receipt endpoint/queue status to resolve unknown uploads, and submit a linked correction with a new mutation ID when the UI reports conflict or rejection. Server authorization is rechecked on upload.

For a lost device, notify the designated support owner, revoke the user's active role assignments through the authorized administration API, secure or recover the device, and review server audit/command receipts. Revoked roles stop resource access server-side even while a short-lived JWT remains in a browser. The product has no password reset, account lockout, remote device wipe, or role administration UI; account suspension and recovery procedure need an owner-approved support process. Do not treat deleting IndexedDB as a substitute for server-side review.

For a compromised account, preserve logs and affected record IDs, revoke current roles, rotate the password using an owner-approved procedure (no self-service password reset is implemented), examine command and audit history, and use linked corrections rather than rewriting submitted records. Escalate possible participant-data exposure under a privacy procedure before contacting affected people. The project has no incident commander, support hours, breach-notification policy or approved retention schedule yet.

## Security and pilot-readiness gaps

Implemented controls include server-side live account and role checks, scoped authorization, short-lived signed tokens, login rate limiting, Helmet, allowlisted CORS, request-size limits, redacted request logging, append-only business audit evidence, idempotent commands and the database checkpoint outbox. The checkpoint and the history it covers are in the same PostgreSQL trust boundary; no independent signature, holder, external verifier or blockchain commitment is implemented.

Still requiring owner/participant decisions and/or hosting work:

- IndexedDB is not encrypted; shared-device access, local retention and lost-device handling need participant-tested policy.
- Participant identification, acknowledgement, paper-assisted capture and dispute procedures need local agreement.
- Data collection, retention, access, export, correction, deletion and backup retention/privacy policy are undecided.
- Role grants, access review cadence, account suspension and password reset ownership need an operational owner.
- Hosting region, TLS/reverse proxy, database and Docker administration, secrets management, backup custody, monitoring and support ownership are not provisioned.
- Checkpoint frequency, separately administered custody and independent verification remain unresolved.
- External payment verification, assay acceptance, measurement instruments/units and field validation require partner procedures.
- There is no end-to-end UI for the full production-to-Dora-to-recovery-to-trade journey. Do not claim a complete field demonstration, regulatory compliance, independent ledger verification, production-grade security, or pilot acceptance based on these changes.

## Reproducible checks

Run from the repository root, using a dedicated PostgreSQL database whose name ends in `_test`:

```powershell
Set-Location server
$env:TEST_DATABASE_URL = 'postgres://USER:LOCAL_SECRET@127.0.0.1:5432/minaledger_test'
npm run lint
npm test
Remove-Item Env:TEST_DATABASE_URL
Set-Location ../client
npm run lint
npm run build
npm run test:unit
npm run test:e2e
```

The integration suite resets the test database's `public` schema and clears it after use. Client E2E runs build the frontend and Playwright Chromium must be installed. Container build, Compose health, TLS proxy, backup/restore against the staging stack and a complete user workflow must be verified in an environment with Docker and the chosen hosting configuration. Do not treat the application test suite as production or field acceptance.
