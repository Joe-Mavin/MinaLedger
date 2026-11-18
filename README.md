# MinaLedger Kenya

MinaLedger is a gold-only production accountability and traceability platform for Kenya's artisanal and small-scale gold supply chain. This repository contains the approved domain design and an initial PostgreSQL-backed backend foundation.

## Current implementation status

**The Phase 1 backend foundation and its current integration suite are verified; Phase 1 remains partial.** The backend uses Node.js ES modules, Express, Sequelize and PostgreSQL. It includes scoped accounts and roles, sites, holes, participant relationships, production outputs, typed append-only measurement observations, a single inventory movement journal, and per-aggregate hash-linked audit streams.

The implementation is a foundation, not the complete product. Allocation persistence and database constraints exist, but allocation review endpoints are not enabled while the pilot reviewer policy remains unresolved. Inventory posting is available to internal domain code and the integration suite; complete movement, consignment and trade APIs are later work. There is no frontend, offline sync engine or distributed blockchain network in this phase.

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

Tests run against PostgreSQL, apply the SQL migration from an empty schema, and exercise API, foreign-key, measurement, allocation, inventory concurrency/rollback and partial reversal/correction caps, currency and audit-chain rules. They use synthetic fictional records only.

Run `npm run lint` to syntax-check every server and integration-test ES module with Node.js before running `npm test`.

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
| `GET/POST /api/v1/sites/{siteId}/production-events` | List or record production events with output batches and optional observations |
| `GET /api/v1/sites/{siteId}/production-events/{eventId}` | Read event and output measurement history |
| `POST /api/v1/sites/{siteId}/production-events/{eventId}/outputs/{outputId}/measurements` | Append an output measurement observation |

Production measurement quantities are JSON decimal strings, such as `"10.250000"`, to preserve PostgreSQL numeric precision. A batch carries identity and lineage, not a duplicate quantity. A measurement correction is a new observation.

## Persistence and security notes

- Sequelize provides the application data layer. Reviewed SQL files under `server/src/database/migrations/` define composite foreign keys, append-only triggers, allocation checks, the inventory journal and database transaction protections.
- `inventory_balance` is derived from accepted lines in `inventory_movement_line`; there is no second stockpile journal or writable balance table.
- Passwords are bcrypt hashes. Tokens are short-lived signed bearer tokens; account and role status is rechecked on every authenticated request. Access is filtered by site, hole or active organisation relationship.
- Hole-scoped grants apply only to the assigned hole. Site details and site-wide participant/production listings require a site-level grant; nested production and measurement requests verify the event's actual site and hole.
- Site and production writes, user/role changes, measurements and inventory transfers append redacted business audit events in the same transaction. Audit streams are per aggregate and are not a distributed blockchain.
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
