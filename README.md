# MinaLedger Kenya

MinaLedger is a gold-only production accountability and traceability platform for Kenya's artisanal and small-scale gold supply chain. This repository contains the approved domain design and a PostgreSQL-backed backend.

## Current implementation status

**Phases 1–5 have implemented, automated-test-verified slices; the product remains partial and is not deployed or field-accepted.** The Node.js ES-module, Express, Sequelize and PostgreSQL backend includes scoped accounts and roles, effective-dated site and hole participants, production outputs and capture provenance, typed append-only measurement observations, allocation proposals and revisions, independently authorized Dora facilities, processing inputs and outputs, protected opaque QR lookup, a single inventory movement journal, residue stockpiles and pooling, residue sales, consignments, custody decisions, dispatch/receipt and recovery events with output genealogy, bilateral gold-trade terms, assay and measurement records, gold custody and payment reconciliation, per-aggregate hash-linked audit streams, and a Phase 5 offline command synchronization boundary. A React/TypeScript PWA provides a versioned local queue, scoped reference cache, app-shell caching and visible synchronization states.

Allocation proposals start as `PENDING` and require an active, effective site or hole `BENEFICIARY` relationship for every named party; the model supports miners and recorded non-miner beneficiaries without treating land access as entitlement. The API does not expose allocation review commands while reviewer authority, eligible measurement kinds, review evidence and dispute rules remain unresolved. Production and processing measurements validate source parties against effective participant or facility relationships; only an explicit `RECORDER` observation defaults to the authenticated recorder. Phase 3 records Dora residue output intake and pooling through the existing journal, commercial sale decisions without payment, itemized consignment, separate custody offers and decisions, transport legs, paired dispatch/receipt movements, count-backed adjustments, and recovery transformations with all source links. Phase 4 adds gold-trade proposals, matching bilateral terms decisions, assay/measurement history, separately accepted custody handovers posted through the same inventory journal, payment reporting/decisions, and trade reconciliation. Recovery output remains aggregate and is not apportioned to individual miners. Phase 5 adds offline upload and receipts for the three documented command types. The PWA has not been deployed or field-accepted, and the current payment API covers gold trades, not residue-sale settlement. No Phase 6 ledger or independent checkpoint infrastructure is implemented.

The two approved routes remain in scope: direct gold sales through local and larger merchants, and residue through Dora processing, aggregation, recovery and later gold sale. A cooperative is optional. Participant identity, role, entitlement, custody, measurement and commercial events remain separate concepts.

## Field client setup

The client requires Node.js 18 or newer. The Vite development server defaults to `http://localhost:5173` and the API defaults to `http://localhost:3001`. Set `VITE_API_BASE_URL` at build time when the API is hosted elsewhere; configure the API's `CORS_ORIGIN` to include the client origin. A production PWA must be served over HTTPS (except localhost); hosting and deployment are not configured by this repository.

```powershell
Set-Location client
npm ci
npm run dev
```

Client verification commands are `npm run lint`, `npm run build`, `npm run test:unit`, and `npm run test:e2e`. The browser test uses Playwright Chromium; install it once with `npx playwright install chromium` if needed. The service worker caches the application shell only. Operational API responses are not cached; the site/hole/authorized-participant reference set is stored in IndexedDB with recorder/context scope. The queue is not encrypted, credentials are not persisted in IndexedDB or local storage, and browser storage may be inspected or evicted.

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

Tests run against PostgreSQL, apply SQL migrations from an empty schema, and exercise API and database integrity across production, allocation, QR, measurement, inventory, commercial constraints, audit, residue pooling, custody, consignment, receipt, recovery genealogy, gold-trade settlement and Phase 5 sync. They use synthetic fictional records only. The current verified suite reports **51 tests, 51 passed, 0 failed**, including rollback/reapply coverage for migrations 003–009.

Run `npm run lint` to syntax-check every server and integration-test ES module with Node.js before running `npm test`. Phase 5 verification on 2026-11-19 passed: backend lint checked **27 ES modules**; the PostgreSQL suite reported **51 tests, 51 passed, 0 failed** against the dedicated `_test` database, including rollback/reapply coverage for migrations 003–009; client ESLint passed; its TypeScript production build passed; IndexedDB unit tests reported **2 passed, 0 failed**; and the Chromium browser test reported **1 passed, 0 failed**. Phase 4 tests include measurement and assay rejection on closed trades and superseded lines, plus concurrent closure/revision races with persisted-state checks.

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
| `GET/POST /api/v1/doras/{facilityId}/stockpiles` | List or create facility-scoped residue stockpile locations |
| `POST /api/v1/stockpiles/{stockpileId}/intake`, `POST /api/v1/stockpiles/{stockpileId}/transfers` | Post Dora-output intake or paired stockpile transfer/pooling movements |
| `GET /api/v1/inventory/locations/{locationId}/balances`, `POST /api/v1/inventory/locations/{locationId}/adjustments` | Read derived balances or record an evidenced count adjustment |
| `POST /api/v1/residue-sales`, `GET /api/v1/residue-sales/{saleId}`, `POST /api/v1/residue-sales/{saleId}/lines/{lineId}/decisions`, `POST /api/v1/residue-sales/{saleId}/lines/{lineId}/revisions` | Record and counterparty-accept a residue sale or propose a linked revision after conflicting quantity decisions; no payment processing |
| `POST /api/v1/consignments`, `GET /api/v1/consignments/{consignmentId}` | Create/read an itemized, multi-batch recovery consignment |
| `POST /api/v1/consignments/{consignmentId}/dispatch`, `/api/v1/consignments/{consignmentId}/transport-legs`, `/api/v1/consignments/{consignmentId}/receipts`, `/api/v1/consignments/{consignmentId}/receipt-items/{receiptItemId}/corrections`, `/api/v1/consignments/{consignmentId}/custody-offers` | Record paired dispatch, transport, receipt, linked receipt correction and separate custody offer |
| `POST /api/v1/custody-transfers/{transferId}/decisions` | Accept, dispute or reject an offered custody transfer |
| `POST /api/v1/recovery-facilities/{facilityId}/inventory-locations`, `/api/v1/recovery-facilities/{facilityId}/recovery-events` | Create typed recovery inventory or consume accepted inputs and record outputs |
| `GET /api/v1/recovery-events/{eventId}` | Read authorized recovery event and input/output genealogy |
| `POST /api/v1/gold-trades`, `GET /api/v1/gold-trades/{tradeId}` | Propose/read a gold purchase or resale and its authorized reconciliation |
| `POST /api/v1/gold-trades/{tradeId}/lines`, `/api/v1/gold-trades/{tradeId}/lines/{lineId}/revisions`, `/api/v1/gold-trades/{tradeId}/lines/{lineId}/decisions` | Add batches, propose successor terms and record seller/buyer decisions |
| `POST /api/v1/gold-trades/{tradeId}/lines/{lineId}/measurements`, `POST /api/v1/gold-trades/{tradeId}/lines/{lineId}/assays` | Append trade-line weight observations/corrections and assay records |
| `POST /api/v1/gold-trades/{tradeId}/lines/{lineId}/custody-offers`, `POST /api/v1/gold-trades/{tradeId}/custody-transfers/{transferId}/decisions` | Offer custody with an exact handover measurement and accept, dispute or reject it; accepted transfers post through the shared inventory journal |
| `POST /api/v1/gold-trades/{tradeId}/payments`, `POST /api/v1/gold-trades/{tradeId}/payments/{paymentId}/decisions` | Record payment claims and counterparty confirmation, dispute, failure or reversal decisions |
| `POST /api/v1/sync/commands`, `GET /api/v1/sync/receipts/{clientMutationId}` | Submit an allowlisted offline production, measurement or participant-acknowledgement command and recover its durable receipt |

Production measurement quantities are JSON decimal strings, such as `"10.250000"`, to preserve PostgreSQL numeric precision. A batch carries identity and lineage, not a duplicate quantity. A measurement correction is a new observation.

## Persistence and security notes

- Sequelize provides the application data layer. Reviewed SQL files under `server/src/database/migrations/` define composite foreign keys, append-only triggers, allocation checks, the inventory journal and database transaction protections.
- `inventory_balance` is derived from accepted lines in `inventory_movement_line`; there is no second stockpile journal or writable balance table.
- Migration `004_phase_three_residue_recovery.sql` adds receipt, custody-decision, recovery input/output genealogy, variance and sale-decision integrity around existing domain tables. Additive migration `005_phase_three_integrity_corrections.sql` limits effective receipt claims to net accepted dispatch, requires current measured/verified Dora intake observations, and adds append-only receipt and residue-sale decision revisions. PostgreSQL triggers enforce these rules; migration 005 rollback refuses to remove its protections when correction records exist.
- Additive migration `006_phase_four_gold_trades.sql` adds gold-trade proposal/status/evidence history, bilateral accepted terms, assay correction guards, measured custody linkage, and payment reconciliation safeguards without editing earlier migrations. Gold handover acceptance is atomic with balanced postings in the existing inventory journal; the selected current handover measurement must exactly equal the moved quantity. Migration 006 rollback refuses to discard Phase 4 records.
- Additive migration `009_offline_sync.sql` adds immutable command envelopes, durable synchronization receipts and append-only receipt history, with database uniqueness and transition constraints; `server/src/database/rollback/009_offline_sync.sql` is its rollback. Offline commands are dispatched through existing production domain services, not arbitrary event-row insertion. The allowlist is production creation, production measurement addition and separate capture acknowledgement.
- The sync endpoints run through the existing Express authentication middleware. At sync time the server rechecks live account, role assignment, acting party and resource access, validates expected audit sequence and parent dependencies, and stores an acceptance/review/conflict/rejection result. Identical mutation ID and envelope return the existing receipt; a changed envelope under the same ID is rejected. Transient unknown outcomes can be recovered through the receipt endpoint.
- Offline bearer tokens remain tab-scoped in `sessionStorage` and expire under the existing 15-minute token policy. The server revalidates authorization during every upload; a locally queued command grants no continued server access. Local references are limited to authorized site/hole context and related participants, and cleared on logout where possible. Browser storage is not encrypted. Sync is driven by online/foreground opportunities, not a guaranteed background worker.
- Passwords are bcrypt hashes. Tokens are short-lived signed bearer tokens; account and role status is rechecked on every authenticated request. Access is filtered by site, hole or active organisation relationship.
- Hole-scoped grants apply only to the assigned hole. Site details and site-wide participant/production listings require a site-level grant; nested production and measurement requests verify the event's actual site and hole.
- Site, production, allocation proposal, Dora, processing, QR, user/role, measurement and inventory writes append redacted business audit events in the same transaction. Audit streams are per aggregate and are not a distributed blockchain.
- A Dora's site association does not grant processing access. Direct facility and processing-event access requires a matching facility role/relationship plus access to every source hole. Administrators do not receive automatic access to production or processing details.
- Phase 3 checks live write access to both Dora facilities for cross-facility pooling and to the relevant recovery facility for recovery actions. Read-only auditors can inspect authorized inventory but cannot create or transfer it. Gold-trade acceptance, custody, inventory movement and payment are separate facts. Gold payment reports are not independently verified by MinaLedger and are not an integration with a bank or mobile-money provider.
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
- [Project continuity](PROJECT_CONTINUITY.md)

The documents distinguish confirmed requirements, field observations, proposed technical decisions, unresolved business questions, and assumptions requiring pilot validation. A hash chain does not prove the physical truth of a recorded measurement or event.
