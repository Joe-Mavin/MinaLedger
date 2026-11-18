# MinaLedger Kenya

MinaLedger is a gold-only production accountability and traceability platform for Kenya's artisanal and small-scale gold supply chain. This repository contains the approved domain design and a PostgreSQL-backed backend.

## Current implementation status

**The Phase 1 foundation and a Phase 2 production-to-Dora backend slice are verified; the overall implementation remains partial.** The backend uses Node.js ES modules, Express, Sequelize and PostgreSQL. It includes scoped accounts and roles, effective-dated site and hole participants, production outputs and capture provenance, typed append-only measurement observations, complete allocation proposals and revisions, independently authorized Dora facilities, processing inputs and outputs, protected opaque QR lookup, a single inventory movement journal, and per-aggregate hash-linked audit streams.

Allocation proposals start as `PENDING` and require an active, effective site or hole `BENEFICIARY` relationship for every named party; the model supports miners and recorded non-miner beneficiaries without treating land access as entitlement. The API does not expose approval, dispute or rejection commands while the pilot reviewer, eligible measurement kinds, review evidence and dispute rules remain unresolved. Production and processing measurements validate source parties against effective participant or facility relationships; only an explicit `RECORDER` observation defaults to the authenticated recorder. Processing records the selected Dora and source production outputs, input/output measurements, and each output's recorded role. Miner-retained gold and Dora-retained residue remain separate batches; these records do not establish legal entitlement or custody. Inventory posting remains internal, and complete movement, consignment, residue recovery and trade APIs are later work. There is no frontend, offline sync engine or distributed blockchain network.

The two approved routes remain in scope: direct gold sales through local and larger merchants, and residue through Dora processing, aggregation, recovery and later gold sale. A cooperative is optional. Participant identity, role, entitlement, custody, measurement and commercial events remain separate concepts.

## Backend setup

Prerequisites: Node.js 18 or newer and PostgreSQL 14 or newer. Run the commands below from PowerShell.

1. Create an application database role and separate application and test databases using a PostgreSQL administrator account. Choose a password locally; do not commit it.

   ```sql
   CREATE ROLE minaledger LOGIN PASSWORD 'replace-with-a-local-secret';
   CREATE DATABASE minaledger OWNER minaledger;
   CREATE DATABASE minaledger_test OWNER minaledger;
   ```

2. Install the backend dependencies and create a local environment file.

   ```powershell
   Set-Location server
   npm install
   Copy-Item .env.example .env
   ```

3. Edit `server/.env` and set `DATABASE_URL` and `JWT_SECRET`. Use a random secret of at least 32 characters. URL-encode reserved characters in the database password.

4. Apply the reviewed SQL migration and create the first administrator account. Bootstrap credentials are read only from environment variables and are not written to logs.

   ```powershell
   npm run migrate
   $env:BOOTSTRAP_ADMIN_EMAIL = 'admin@example.test'
   $env:BOOTSTRAP_ADMIN_DISPLAY_NAME = 'Initial administrator'
   $env:BOOTSTRAP_ADMIN_PASSWORD = 'use-a-unique-local-password'
   npm run bootstrap-admin
   Remove-Item Env:BOOTSTRAP_ADMIN_EMAIL, Env:BOOTSTRAP_ADMIN_DISPLAY_NAME, Env:BOOTSTRAP_ADMIN_PASSWORD
   ```

   Bootstrap succeeds only while the database has no user accounts. A global `SYSTEM_ADMIN` grant permits account and role management; it does not grant automatic access to site, production, measurement, inventory or commercial records.

5. Start the API and check the database-backed health endpoint.

   ```powershell
   npm start
   Invoke-RestMethod http://127.0.0.1:3001/healthz
   ```

The health response is `{"status":"ok","database":"connected",...}`. The API listens on port 3001 by default. Set `PORT` to change it.

## PostgreSQL integration tests

The tests reset the `public` schema and clear it again afterward. Point them only at a dedicated database whose name ends in `_test`; they refuse other database names.

```powershell
Set-Location server
$env:TEST_DATABASE_URL = 'postgres://minaledger:replace_me@127.0.0.1:5432/minaledger_test'
npm test
Remove-Item Env:TEST_DATABASE_URL
```

Tests run against PostgreSQL, apply the SQL migrations from an empty schema, and exercise API, foreign-key, production-to-Dora lineage, allocation revision concurrency and eligibility, facility access, QR authorization/revocation, measurement source attribution and rollback, inventory concurrency/rollback and partial reversal/correction caps, currency and audit-chain rules. They use synthetic fictional records only. The verified suite reports 15 tests passed and 0 failed. The integration tests include rollback/reapply coverage for migration 003 and regression assertions for the Phase 2 security corrections.

Run `npm run lint` to syntax-check every server and integration-test ES module with Node.js before running `npm test`. The correction set's syntax check passed for 22 ES modules, and the PostgreSQL suite passed all 15 tests with no failures against the dedicated `_test` database.

## Available API routes

All write commands require an `Idempotency-Key` UUID. Sign in at `POST /api/v1/auth/login`; send the returned short-lived bearer token to protected endpoints.

| Method and path | Purpose |
|---|---|
| `GET /healthz` | Database-backed service health |
| `POST /api/v1/auth/login`, `GET /api/v1/me` | Sign-in and current account/role view |
| `POST /api/v1/admin/users`, `POST /api/v1/admin/organisations` | Scoped identity and organisation administration |
| `POST /api/v1/admin/users/{userId}/roles`, `POST /api/v1/admin/role-assignments/{id}/revoke` | Audited role grant and revocation |
| `GET/POST /api/v1/sites` | List authorized sites or create within pilot scope |
| `GET/PATCH /api/v1/sites/{siteId}` | Read or update permitted site metadata |
| `GET/POST /api/v1/sites/{siteId}/holes` | Read or add site holes |
| `GET /api/v1/sites/{siteId}/holes/{holeId}` | Read one hole when authorized for that hole or site |
| `GET /api/v1/sites/{siteId}/holes/{holeId}/participants` | Read only the selected hole's participants |
| `GET/POST /api/v1/sites/{siteId}/participants` | Read or associate a party and its site/hole role |
| `GET/POST /api/v1/sites/{siteId}/doras` | List site-associated Doras or create a distinct facility record |
| `GET/PATCH /api/v1/doras/{facilityId}` | Read/update a Dora with facility-scoped authorization |
| `GET/POST /api/v1/sites/{siteId}/production-events` | List or record production events with output batches and optional observations |
| `GET /api/v1/sites/{siteId}/production-events/{eventId}` | Read event and output measurement history |
| `POST /api/v1/sites/{siteId}/production-events/{eventId}/outputs/{outputId}/measurements` | Append an output measurement observation |
| `GET/POST /api/v1/sites/{siteId}/production-events/{eventId}/outputs/{outputId}/allocation-sets` | Read allocation history or submit a complete pending quantity/share proposal or revision |
| `POST /api/v1/sites/{siteId}/processing-events` | Record a Dora processing event with production inputs and distinct measured outputs |
| `GET /api/v1/processing-events/{eventId}` | Read processing lineage when authorized for both source holes and the selected facility |
| `POST /api/v1/processing-events/{eventId}/inputs/{inputId}/measurements`, `POST /api/v1/processing-events/{eventId}/outputs/{outputId}/measurements` | Append input/output measurement observations and corrections |
| `POST /api/v1/material-batches/{batchId}/qr`, `POST /api/v1/material-batches/{batchId}/qr/rotate` | Create or rotate an opaque QR identity |
| `GET /api/v1/qr/{opaqueToken}` | Resolve a QR identity after authentication and resource authorization |

Production measurement quantities are JSON decimal strings, such as `"10.250000"`, to preserve PostgreSQL numeric precision. A batch carries identity and lineage, not a duplicate quantity. A measurement correction is a new observation.

## Persistence and security notes

- Sequelize provides the application data layer. Reviewed SQL files under `server/src/database/migrations/` define composite foreign keys, append-only triggers, allocation checks, the inventory journal and database transaction protections.
- `inventory_balance` is derived from accepted lines in `inventory_movement_line`; there is no second stockpile journal or writable balance table.
- Passwords are bcrypt hashes. Tokens are short-lived signed bearer tokens; account and role status is rechecked on every authenticated request. Access is filtered by site, hole or active organisation relationship.
- Hole-scoped grants apply only to the assigned hole. Site details and site-wide participant/production listings require a site-level grant; nested production and measurement requests verify the event's actual site and hole.
- Site, production, allocation proposal, Dora, processing, QR, user/role, measurement and inventory writes append redacted business audit events in the same transaction. Audit streams are per aggregate and are not a distributed blockchain.
- A Dora's site association does not grant processing access. Direct facility and processing-event access requires a matching facility role/relationship plus access to every source hole. Administrators do not receive automatic access to production or processing details.
- QR payloads contain only random opaque tokens. The database stores the QR token hash on its QR record; resolution still requires authentication and read authorization for every source hole and processing facility. Creation and rotation require write authorization across that same lineage.
- `.env`, credentials, and local database files are excluded from Git.

## Approved project documents

- [Project charter](docs/PROJECT_CHARTER.md)
- [Gold value chain and genealogy](docs/GOLD_VALUE_CHAIN.md)
- [Business rules and terminology](docs/BUSINESS_RULES.md)
- [Database schema and ERD](docs/DATABASE_SCHEMA.md)
- [System architecture and API](docs/SYSTEM_ARCHITECTURE.md)
- [Blockchain design](docs/BLOCKCHAIN_DESIGN.md)
- [Offline strategy](docs/OFFLINE_STRATEGY.md)
- [Security and permissions](docs/SECURITY_MODEL.md)
- [Implementation milestones](docs/IMPLEMENTATION_PLAN.md)
- [Prototype acceptance criteria](docs/ACCEPTANCE_CRITERIA.md)
- [Decision log and open questions](docs/DECISION_LOG.md)

The documents distinguish confirmed requirements, field observations, proposed technical decisions, unresolved business questions, and assumptions requiring pilot validation. A hash chain does not prove the physical truth of a recorded measurement or event.
