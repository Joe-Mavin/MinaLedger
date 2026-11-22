# MinaLedger Product UI Assessment and Roadmap

**Assessment date:** 2026-11-20
**Revision inspected:** `f8f37e35b3681bbcf1d4ea910f98b0809fec264d` (`main`; cached `origin/main` matched). No network fetch was performed.
**Scope:** the feature inventory below began as the pre-Milestone-2 baseline. Stage 7A Milestones 2–4 implementation and verification are appended in [the implementation plan](IMPLEMENTATION_PLAN.md) and [demo contract](DEMO_CONTRACT.md). Browser cases use mocked APIs; Milestone 4 PostgreSQL integration verification remains pending a dedicated test database. No field validation is claimed.

## Summary

The backend contains substantial scoped identity, production, processing, inventory, recovery, trade, custody, audit and offline-sync capabilities. The UI now includes the shared workspace shell, registry and limited access administration, production and allocation screens, and the Stage 7A Milestone 4 Operations workspace for Dora processing, residue inventory/sales, consignments/custody and recovery. The complete product journey still has API and policy gaps; mocked browser tests do not prove browser-to-PostgreSQL behavior.

`App.tsx` retains login, overview, capture, command queue and audit-checkpoint controls and integrates the Production and Operations workspaces. Registry supports site/hole and participant list/detail/create, plus permitted site metadata updates. Access administration supports account and organization creation, supported role grants and current-session revocation. Production supports event register/detail, output observations, source batch references and proposed allocation/revision history through existing APIs and the offline queue. Operations uses existing Dora, processing, inventory, residue sale, consignment, custody and recovery domain actions, with a small set of authorized collection/read routes added for discovery. Merchant trade/payment, QR tracing and general reporting screens remain absent.

The existing workspace should remain a first-class **Capture** destination. New UI should call existing authenticated APIs and services; it should not duplicate business logic or create another inventory ledger.

## Frontend inventory

The client keeps `App.tsx`, `main.tsx`, `api.ts`, `apiBase.ts`, `styles.css` and `offline/` modules for IndexedDB, commands, types and synchronization. `registry/RegistryWorkspace.tsx`, `admin/AccessAdministration.tsx`, `production/ProductionWorkspace.tsx` and `operations/OperationsWorkspace.tsx` provide the Milestone 2–4 screens without adding a router or replacing the offline command architecture. Capture, measurement context, queue recovery and checkpoint behavior remain in the shared app.

`client/src/api.ts` provides the shared request helper and typed reads for sites, holes, hole participants and production events. The Production workspace uses the authenticated request helper with the existing event and allocation-history routes. Most other calls remain direct from feature screens; there are no feature-specific clients for other domains.

## Verified feature inventory

| Module | Backend status | Frontend status | Missing work | Evidence |
|---|---|---|---|---|
| **1. Authentication/access** | Login, profile, scoped roles, account/org creation and role grant/revocation exist. | **Partial:** login/session and role context; global system administrators can create accounts/organizations, assign roles, and revoke grants created in the active UI session. No full directory or existing-assignment ID listing. | Add authorized account/org/member/role directory endpoints before listing or managing existing records. Bootstrap remains outside the app. | `App.tsx`, `client/src/admin/AccessAdministration.tsx`; `POST /api/v1/admin/...`; party/account/role tables in migration 001. |
| **2. Dashboard** | Health/readiness exists; no operational summary API found. | **Missing:** greeting and sync status are not an operations dashboard. | Define authorized indicators and implement overview. | `App.tsx` welcome section; route surface in `server/src/app.mjs`. |
| **3. Sites and holes** | Site create/list/read/update and hole create/list/read APIs exist. | **Implemented for site-readable scopes:** authorized list/detail, site create/edit, hole list/detail/create; server continues to enforce resource scope. | Add system-administrator resource discovery if admin assignment must support site/hole scopes; add navigation only if hole-only discovery becomes available. | `/api/v1/sites`, `/api/v1/sites/:siteId`, `/api/v1/sites/:siteId/holes`; `client/src/registry/RegistryWorkspace.tsx`; migration 001. |
| **4. Participants/organisations** | Scoped participant create/list, organization/account creation and user-role APIs exist; site and hole relationships are distinct. | **Partial but usable:** site/hole relationship register and creation with identity, category, effective period, source and evidence; org creation and limited account/role administration. No complete account, organization or membership directories and no relationship lifecycle endpoint. | Add safe directory/detail/member and relationship lifecycle APIs where product workflows require them. | `/api/v1/sites/:siteId/participants`, `/api/v1/sites/:siteId/holes/:holeId/participants`, `/api/v1/admin/...`; migrations 001–002. |
| **5. Sharing/allocations** | Allocation proposals, revisions and output history exist; proposals remain pending; review decisions are not exposed. No general negotiated sharing-agreement workflow was found. | **Partial:** structured proposals/revisions use the existing sync command queue; history and review states are visible. No approval action or agreement workflow. | Backend allocation review/decision capabilities remain absent. Do not represent a pending proposal as an approved agreement. | `GET/POST .../allocation-sets`; `production.allocation.propose`; `allocation.service.mjs`; migration 001. |
| **6. Production/batches** | Production create/list/read, output batch references, capture provenance and measurements exist. | **Partial:** event register/detail, material/date/status filters, provenance, typed observation history and batch references from event outputs. Production starts the existing offline capture form. | Add a batch collection, direct batch detail and processing transformation/genealogy API before presenting downstream lineage. | Production event routes and `production.service.mjs`; migration 001 material entities and migration 002 capture/participant tables. |
| **7. Dora processing** | Dora create/list/read/update; processing event create/read and input/output measurements exist. | **Implemented in Operations:** authorized Dora register/detail/create/update, processing event register/detail/create with selected production source batches and input/output measurements. | Facility creation still requires an authorized site and server policy; validate capture/evidence practice in the field. | `/api/v1/doras`, `/api/v1/sites/:siteId/doras`, `/api/v1/processing-events`; `dora.service.mjs`, `processing.service.mjs`. |
| **8. Residue/recovery** | Stockpile, measured intake, transfer, balances, adjustment, consignment and recovery services use the existing inventory journal. | **Implemented in Operations:** stockpile register/create, eligible Dora-output intake, balances, movement/source history, transfer, residue-sale workflow, recovery locations/events and genealogy. | Recovery facility provisioning remains unavailable; existing facilities must be authorized and provisioned. Residue payment remains unsupported. Keep pooled recovery aggregate absent an approved basis. | `/api/v1/doras/:facilityId/stockpiles`, `/api/v1/stockpiles/...`, `/api/v1/recovery-facilities...`; `residue.service.mjs`; migrations 001, 004–005. |
| **9. Measurements/assay** | Production/processing/trade measurements and trade assay APIs exist. | **Partial:** structured production measurement; no processing/trade observation UI; some trade commands use generic JSON. | Context-specific forms, observation history and linked correction views. A recorded assay is not independent certification. | Measurement routes in `server/src/app.mjs`; measurement/assay tables in migrations 001 and 006–008. |
| **10. Merchant trades** | Gold-trade proposals, lines, revisions, bilateral decisions, custody, observations and per-trade reconciliation exist. | **Missing:** no merchant/trade UI. | Add trade list/detail and counterpart workflows. Validate direct miner purchases and merchant aggregation/resale scenarios. | `/api/v1/gold-trades...`; `gold-trade.service.mjs`; `docs/IMPLEMENTATION_PLAN.md` says aggregation and broader scenario coverage remain incomplete. |
| **11. Payments** | Gold-trade payment reports/decisions and reconciliation exist. No residue-sale payment route exists. | **Missing:** no payment UI; Operations clearly marks residue-sale settlement unsupported. | Implement residue settlement only after the required parent and decision semantics are approved and backend support is built. | Gold-trade payment routes in `server/src/app.mjs`; AC-08a is explicitly marked unmet for residue sales. |
| **12. Consignments/custody** | Create/read, dispatch, transport, receipt/correction and custody offer/decision APIs exist. | **Implemented in Operations:** authorized consignment register/detail, creation, dispatch, transport legs, receipt/correction and custody offers/decisions with commercial links. These actions are online-only. | Validate handover and receipt practices in the field; do not equate sale, payment, dispatch, custody or receipt. | `/api/v1/consignments`, `/api/v1/consignments...`, custody routes; `residue.service.mjs`; migrations 001 and 004. |
| **13. Traceability/QR** | Batch QR create/rotate and authenticated lookup exist; material genealogy is stored. | **Missing:** no QR or traceability UI. | QR display/rotation and authorized scan/detail timeline. Lookup is not anonymous public verification. | `/api/v1/material-batches/:batchId/qr`, `/api/v1/qr/:token`; `qr.service.mjs`; migration 001 `qr_record`. |
| **14. Audit checkpoints** | Hash-linked streams, database checkpoints, retryable outbox and covered-prefix verification exist. | **Partial:** manual stream UUID checkpoint creation/status only; no event timeline, checkpoint list or stream picker. | Add stream discovery/history and retain disclosure of covered history, unanchored tail and external verification limits. | Checkpoint routes in `server/src/app.mjs`; `checkpoint.service.mjs`; migration 011; checkpoint form in `App.tsx`. |
| **15. Offline sync** | Fourteen command types have schemas, live authorization/version checks, dependency handling and durable receipts. IndexedDB supports retry, receipt recovery and linked corrections. | **Partial:** structured production/measurement/acknowledgement, queue and correction; raw JSON for other allowlisted commands. | Structured forms for supported types; visibly identify unsupported workflows as online-only. | `client/src/offline/types.ts`, `sync.ts`, `commands.ts`; `/api/v1/sync/commands`, `/versions`, `/receipts`; server `sync.schemas.mjs` and `sync.service.mjs`. |
| **16. Operational reporting** | No general reporting/dashboard API found. Balance and per-trade reconciliation reads are narrower module reads. | **Missing:** no reports interface. | Define measures, filters and privacy scopes before adding reports. | Route surface in `server/src/app.mjs`; trade read model in `gold-trade.service.mjs`. |

## Backend-to-frontend findings

- HTTP handlers and many Zod schemas are registered in `server/src/app.mjs`; domain services are in `server/src/modules`. SQL migrations are the broad database definition. `server/src/database/models.mjs` models core tables, not every migrated table.
- Collection reads exist for sites, holes, participants, Doras, production events and stockpiles. Milestone 4 adds authorized collection reads for processing events, consignments, residue sales, recovery facilities/events, plus inventory movement and eligible input/output/destination reads; there is still no gold-trade collection or general dashboard/report API.
- Recovery facility create remains unavailable; Milestone 4 adds a read-only authorized facility list/detail based on existing facility scope relationships. Organization, account, membership and existing role-assignment list/detail endpoints are also absent; the UI limits those records to what existing authorized responses or the active session can provide.
- Allocation review decisions are absent by design until reviewer policy is approved.
- Payment routes are scoped to gold trades. AC-08a records residue-sale payment coverage as an unmet requirement; no residue payment endpoint or payment UI was added. Do not reuse gold-trade settlement as residue settlement.
- Internal audit stream read/verify functions exist, but there is no general audit-event timeline route.
- There is no automatic fictional demonstration-data seeding flow. Keep all demonstration data fictional and isolated.

Core entities are defined across migrations 001–011: parties and scoped relationships; sites/holes; material events/batches; measurements/assays; allocation chains/revisions; processing; inventory movements; consignments/receipts/custody; trades/payments; QR; audit streams/checkpoints. Examples: `001_foundation.sql`, `002_phase_two_operations.sql`, `004_phase_three_residue_recovery.sql`, `006_phase_four_gold_trades.sql` and `011_audit_checkpoints.sql`.

## Complete demonstration journey

| Step | Backend | UI | Dependency/decision |
|---|---|---|---|
| Register site and hole | Create/list/read APIs | Registry list/detail/create; permitted site metadata updates; hole list/detail/create | System administrators still lack a site/hole resource directory for assigning these scopes. |
| Register participants/relationships | Scoped participant and admin APIs | Registry lists and creates participant identities/categories/site or hole relationships; dates and source/evidence references are shown | No relationship edit/revoke API; login account and role directories are incomplete. Keep participant category, relationship and system role distinct. |
| Record sharing agreement | No general agreement workflow | None | Decide how negotiated arrangements are represented; do not infer ownership or percentages. |
| Capture production | Event/output/batch APIs | Production register/detail plus structured capture for selected site/hole through the existing offline queue | No batch collection or downstream lineage endpoint. |
| Record allocation | Proposal/revision/history API; pending only | Structured proposal and correction commands with beneficiary relationship, basis, receipt and revision history | Reviewer policy and decision API are absent; no ownership or percentage is inferred. |
| Dora processing | Event/input/output/measurement APIs | Operations: create/list/detail Dora and processing event; link actual production output and source records | Authorized site grant required to register a Dora; event list is filtered using detail-level facility and source-hole authorization. |
| Pool/transfer residue | Stockpile/intake/transfer/balance APIs | Operations: stockpile list/create/detail, measured Dora-output intake, balances, movement provenance and transfers | Recovery facility must already exist; source output must be measured/verified and not already accepted. |
| Consign and receive | Dispatch/transport/receipt/correction/custody APIs | Operations: authorized list/detail, create, dispatch, transport legs, receipt/correction and custody offer/decision | These UI actions are online-only; each action remains server-authorized. |
| Recover gold | Recovery transformation and genealogy | Operations: facility/location register, balances, eligible receipt inputs, event create/detail and source genealogy | Facility provisioning and residue payment are unsupported; output remains aggregate absent approved allocation basis. |
| Weigh and assay | Backend supports all domains; production measurement UI only | Partial | Add context-specific observation UI and history; validate field practice. |
| Merchant trade and payment | Gold trade/payment APIs | None | Build UI, validate both merchant routes; residue payment API missing. |
| Custody | Offer/decision APIs | Generic JSON subset | Build custody history and handover UI. |
| Traceability | Authenticated QR and genealogy APIs | None | Build QR/scan/detail UI. |
| Audit verification | Checkpoints and verifier | Manual UUID checkpoint UI | Add stream discovery/history; explain trust boundary and tail. |
| Offline capture/sync | Supported allowlist and durable receipts | Production-first UI; generic JSON for much of the allowlist | Add typed forms; other workflows remain online-only. |

The full journey cannot currently be completed through the product UI. Registry and limited access administration join Capture, Production, Allocation, Operations, offline synchronization and checkpoint tools. Milestone 4 adds the registers and mutation forms described below, but all Operations workflows are online-only; the existing offline queue contract is unchanged. The Milestone 4 Playwright cases use fictional intercepted API responses and do not prove browser-to-PostgreSQL behavior. The backend integration suite could not run because `TEST_DATABASE_URL` is not configured in this environment. A direct batch collection/detail/transformation API, allocation review decisions, recovery-facility creation, residue-sale payment, gold trade/payment UI, QR and reports remain gaps.

## Proposed navigation

Use a responsive shared shell and preserve the current workspace as **Capture**:

- **Overview**
- **Registry:** Sites & holes; People & organisations
- **Production:** Events & batches; Allocations
- **Processing:** Doras; Stockpiles & inventory; Recovery
- **Commerce:** Gold trades; Measurements & assays; Payments
- **Movement:** Consignments; Custody
- **Traceability:** QR and genealogy
- **Evidence & sync:** Audit/checkpoints; Offline queue
- **Reports**

Prefer list/detail flows over isolated pages. A batch detail can show origin, processing links, measurements, allocation history, custody and audit evidence. UI role visibility is not authorization; the server remains authoritative.

## Dependency-aware implementation milestones

### 0. Demo contract and fictional fixtures

- Define fictional personas, role matrix, site/hole/participants, Dora, recovery facility and merchant fixtures in an isolated demo database.
- Reuse bootstrap/admin and domain APIs; add only verified discovery/provisioning gaps.
- Test repeatable setup/teardown and cross-scope access with fictional data only.
- Decide whether allocation review, residue payments and reports are in demo scope.

### 1. Navigation and overview

- Build app shell, role/context-aware navigation, overview and shared loading/error/empty states; keep Capture intact.
- Reuse `/api/v1/me`, site/event/balance reads. Add summary endpoint only for defined indicators that cannot be safely composed.
- Test role visibility, navigation, session expiry, responsive layout and failures.
- Accept when users can navigate without losing capture/queue behavior and overview respects scope.

### 2. Registry and access administration

- Build site/hole registry, participant/org rosters and account/role administration.
- Reuse site/hole, participant and admin APIs; add directory/relationship lifecycle endpoints only as needed.
- Test effective dates, revoked roles, cross-site/hole denial and create-then-select browser flow.
- Preserve distinctions between account identity, participant party and organization membership; no legal validation claims.

### 3. Production, batches and allocations — implemented with documented API gaps

- Production register/detail, measurement history and allocation proposal/revision/history are implemented using existing APIs and the offline queue.
- Batch detail is limited to outputs exposed by production-event detail. A batch collection/detail/transformation genealogy API is not available; do not present unreturned relationships.
- Review API is not implemented and remains gated on approved policy.
- Mocked browser coverage passed for capture entry, register/detail, batch source reference, typed observation display, proposal/revision queue flow, pending status and read-only Auditor access. This is not a browser-to-PostgreSQL test.

### 4. Dora, inventory, consignment and recovery

- Build processing inputs/outputs, measured stockpile intake, transfers/balances/adjustments, residue sale, consignment/receipt and recovery genealogy.
- Reuse existing Dora, processing, inventory, residue, receipt and recovery services; preserve the single journal.
- Add facility discovery/provisioning or collection routes only where required.
- Test lineage, paired movements, balances, concurrency, corrections and facility authorization. Keep pooled outputs aggregate.

### 5. Measurements, trade, payments and custody

- Build trade list/detail, counterpart decisions, measurement/assay history, payment and custody timelines.
- Reuse gold-trade, measurement, assay, custody and gold payment APIs; add residue payment APIs only if approved.
- Test privacy, bilateral terms, assay attribution/correction, partial/disputed payments, currency, custody and inventory caps.
- Validate direct miner purchases and merchant aggregation/resale before calling both routes demonstrated.

### 6. Traceability, audit, reports and offline integration

- Build QR generation/scan, genealogy timeline, audit stream discovery/history, defined reports and structured forms for supported offline types.
- Reuse QR, checkpoint, IndexedDB, receipt and correction flows; add audit-history/report APIs only for agreed requirements.
- Test full fictional journey against real API/PostgreSQL, role revocation, QR authorization, checkpoint tail limits, offline reconnect/receipt recovery and report privacy.
- Keep independent checkpoint custody outside the database-backed prototype.

## Tests and acceptance plan

The client has three unit tests and 23 Playwright tests. Browser coverage includes all nine role navigation sets, registry and administration request flows, production capture/register/detail, batch references, observation history, allocation proposal/revision, read-only Auditor access, offline queue/session/receipt recovery, checkpoints, mobile layout and mocked Operations flows. Browser API interactions use fictional intercepted responses; they do not constitute a full browser-to-real-API journey. Backend PostgreSQL integration tests in `server/tests/integration.test.mjs` cover previously verified actual API/domain scenarios, including production, allocation, site/participant reads, account/role administration, Dora lineage, inventory, trade/payment authorization, role revocation and checkpoints. For Milestone 4, the backend suite did not run because `TEST_DATABASE_URL` was unset; new API integration coverage is therefore pending local verification. See [the implementation plan](IMPLEMENTATION_PLAN.md) for historical Phase and Milestone test results.

Add acceptance coverage for:

- Form/page validation, role visibility, loading/error/empty states and accurate pending/conflict/rejected labels.
- API/PostgreSQL create/list/detail workflows, live role revocation, cross-site/facility denial and counterparty privacy.
- Cross-module genealogy and inventory balance consistency from production through processing, residue, consignment, receipt and recovery.
- Browser demonstration with fictional fixtures and real API/database; retain mocked tests for focused error cases.
- Offline allowlist forms, no API caching, restart/reconnect, unknown uploads, receipt recovery, correction and authorization revocation.
- QR scope and audit checks distinguishing covered history, unanchored tail and physical claims from recorded software evidence.

The acceptance-criteria document contains historical verification counts from earlier phases. Stage 7A Milestone 4 status and verification limits are recorded below and in the implementation plan.

## Stage 7A Milestone 4 status (2026-11-22)

The Operations workspace adds Dora and processing, residue inventory/sales, consignments/custody, and recovery pages using the existing domain services and inventory journal. New backend reads provide authorized registers and eligible choices; mutation behavior continues through existing routes. No migration was added. No offline command type was added, and these Operations actions require a live connection. Existing Capture, Registry, Access, Production, Allocation, Queue and Audit workspaces remain in place.

The workspace navigation is exposed to `DORA_OPERATOR`, `RECOVERY_FACILITY_OPERATOR`, `FIELD_OFFICER`, `MINING_OPERATOR`, `MINER` and `AUDITOR`; navigation visibility only improves discoverability. The server remains authoritative. Dora operators can create processing events and eligible residue-sale/consignment actions within facility and source-hole scopes; recovery operators can manage authorized recovery locations and events and participate on authorized consignment sides; field/mining roles see records/actions allowed by existing site/hole rules; Miners are read-only in Operations; Auditors are read-only. Every mutation still passes through existing service authorization and transaction logic.

Additional read endpoints are `GET /api/v1/doras`, `GET /api/v1/doras/:facilityId/residue-outputs`, `GET /api/v1/doras/:facilityId/recovery-destinations`, `GET /api/v1/processing-events`, `GET /api/v1/inventory/locations/:locationId/movements`, `GET /api/v1/consignments`, `GET /api/v1/residue-sales`, `GET /api/v1/recovery-facilities`, `GET /api/v1/recovery-facilities/:facilityId`, `GET /api/v1/recovery-facilities/:facilityId/recovery-events`, and `GET /api/v1/recovery-facilities/:facilityId/eligible-inputs`. These were needed for role-filtered discovery, source selection and provenance displays; they do not add alternate mutation paths.

Browser coverage includes mocked UI journeys for Dora processing from a selected production output, Auditor read-only access, measured residue intake and stockpile transfer, and recovery receipt/event genealogy. These are UI interaction tests with fictional intercepted API data, not real API/database journeys. On 2026-11-22, client lint and production build passed, unit tests passed **3/3**, and Playwright Chromium passed **23/23**. Server lint passed for **31 ES modules**. The PostgreSQL integration suite did not run: `npm test` stopped before database access because `TEST_DATABASE_URL` is unset; configure a dedicated database with a name ending `_test` and rerun before treating backend integration as verified. No Docker, deployment or field verification is claimed.

Remaining limits include no recovery facility creation, no residue-sale payment endpoint/UI, no general report or gold-trade UI, no full direct batch/transformation genealogy API, and no offline Operations mutations. Recovery facility authorization/party ownership semantics remain those already present in the backend. Physical measurement, weighing, transport, receipt, custody and recovery practices require field validation.

## Domain and product guardrails

- Keep scope to artisanal and small-scale **gold** supply chains.
- Do not infer land ownership, miner entitlement or sharing percentages. A proposal is not an approved agreement.
- Keep production, processing, residue, recovery, measurement, assay, trade, payment and custody distinct.
- Do not attribute pooled recovered quantities to individual miners without an approved basis.
- A recorded assay is not independent certification; a payment report is not independent proof of money movement.
- Checkpoints remain in the same PostgreSQL trust boundary, not an operational blockchain.
- Preserve shared-device/session scope, offline provenance and server-side authorization.
- Use fictional data only; do not seed real participant information.

**This document is an assessment and roadmap, not implementation or field acceptance.**
