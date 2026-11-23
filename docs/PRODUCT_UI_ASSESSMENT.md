# MinaLedger Product UI Assessment and Roadmap

**Assessment date:** 2026-11-23
**Revision inspected:** Stage 7A Milestone 6 targeted correction working tree based on `main`.
**Scope:** historical feature findings are updated for Stage 7A Milestones 0–6. Playwright uses fictional mocked APIs and does not prove browser-to-PostgreSQL behavior. Milestone 6 PostgreSQL integration passed 56/56 on the dedicated `minaledger_test` database. No field validation is claimed.

## Summary

The backend contains substantial scoped identity, production, processing, inventory, recovery, trade, custody, audit and offline-sync capabilities. The UI now includes Traceability, Audit evidence and Reports alongside the shared workspace shell, Registry, Access Administration, Production/Allocation, Operations and Commerce. The journey still has API and policy gaps; mocked browser tests do not prove browser-to-PostgreSQL behavior.

`App.tsx` retains login, overview, Capture and the command queue, and integrates Registry, Access, Production, Operations, Commerce, Traceability, Reports and Audit evidence workspaces. Batch tracing and reporting reuse existing record reads plus two narrowly scoped API additions for authorized batch search/genealogy; audit adds server-filtered stream/checkpoint collection reads. There is still no general reporting API or gold-trade collection/search endpoint. Trade/payment detail requires an authorized party and a known trade UUID.

The existing workspace should remain a first-class **Capture** destination. New UI should call existing authenticated APIs and services; it should not duplicate business logic or create another inventory ledger.

## Frontend inventory

The client keeps `App.tsx`, `main.tsx`, `api.ts`, `apiBase.ts`, `styles.css` and `offline/` modules for IndexedDB, commands, types and synchronization. Feature screens are in `registry/`, `admin/`, `production/`, `operations/`, `commerce/`, `traceability/`, `reports/` and `audit/`; no new router or offline architecture was introduced. Queue records link to an authorized traceability view when a business batch ID is present in the submitted payload or server receipt.

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
| **9. Measurements/assay** | Production, processing and trade measurements plus trade assays exist. | **Partial:** authorized production/processing register and detail, online DECLARED/MEASURED recording, participant selection from production-event relationships, and trade weight/assay history with append-only reasoned corrections. VERIFIED remains read-only. | Production/processing correction reason support is incomplete; event-detail APIs omit some recorder/evidence fields. No laboratory certification or physical validation is claimed. | Measurement routes in `server/src/app.mjs`; `client/src/commerce/MeasurementsWorkspace.tsx`; migrations 001 and 006–008. |
| **10. Merchant trades** | Gold-trade proposals, lines, revisions, bilateral decisions, custody, observations and per-trade reconciliation exist. | **Partial:** create proposal, open known trade detail, revise current pending line, submit represented-party decisions, inspect status/source/observation/custody/reconciliation history. Server remains authoritative for both parties and batch eligibility. | No trade collection/search/filter endpoint; users need a known UUID. Auditor-only detail access is unavailable because the existing route requires seller/buyer representation. Real database merchant aggregation/resale journeys are not browser-tested. | `/api/v1/gold-trades...`; `gold-trade.service.mjs`; `client/src/commerce/GoldTradesWorkspace.tsx`. |
| **11. Payments** | Gold-trade payment reports/decisions and reconciliation exist. No residue-sale payment route exists. | **Partial:** buyer report form and seller/buyer-supported payment decisions for known authorized trades; reconciliation separates agreement, reports and recorded confirmation. | Read API omits event-level actor/time/evidence/reference. No external money-movement verification, bank/M-Pesa integration or residue-sale settlement exists. Auditor-only trade/payment reads are unavailable. | Gold-trade payment routes in `server/src/app.mjs`; `client/src/commerce/PaymentsWorkspace.tsx`; AC-08a remains unmet for residue sales. |
| **12. Consignments/custody** | Create/read, dispatch, transport, receipt/correction and custody offer/decision APIs exist. | **Implemented in Operations:** authorized consignment register/detail, creation, dispatch, transport legs, receipt/correction and custody offers/decisions with commercial links. These actions are online-only. | Validate handover and receipt practices in the field; do not equate sale, payment, dispatch, custody or receipt. | `/api/v1/consignments`, `/api/v1/consignments...`, custody routes; `residue.service.mjs`; migrations 001 and 004. |
| **13. Traceability/QR** | Batch QR create/rotate and authenticated lookup exist; genealogy is stored. | **Implemented:** authorized batch-code/UUID search, lineage detail across accessible production, processing, inventory, consignment, recovery, residue sales and party-authorized trades; QR create/rotate and authenticated resolution. | No anonymous QR verification. Exact lineage remains limited to currently authorized records. Trade collection/search and some supporting event context are unavailable. Pooled output remains aggregate. | `GET /api/v1/material-batches?query=...`, `GET /api/v1/material-batches/:batchId/traceability`, existing QR routes; `traceability.service.mjs`, `qr.service.mjs`; no migration. |
| **14. Audit checkpoints** | Hash-linked streams, database checkpoints, retryable outbox and covered-prefix verification exist. | **Implemented:** server-discovered authorized streams, recent checkpoint history, create/open/status/verification and read-only Auditor workspace. | History collection returns the most recent 100 records. Checkpoint and verifier share PostgreSQL; no external independent anchor or blockchain. | `GET /api/v1/audit/streams`, `GET /api/v1/audit/checkpoints`, existing detail/create routes; `checkpoint.service.mjs`; migration 011 unchanged. |
| **15. Offline sync** | Fourteen command types have schemas, live authorization/version checks, dependency handling and durable receipts. IndexedDB supports retry, receipt recovery and linked corrections. | **Implemented for existing allowlist:** capture, queue state, retries, receipt recovery and linked corrections remain unchanged; queue items show a related batch trace link when the payload/receipt includes a batch UUID. New trace, reports, QR and audit workflows remain online-only. | No new offline command types or background-sync guarantee. Offline save remains local until receipt says otherwise. | `client/src/offline/types.ts`, `sync.ts`, `commands.ts`; `/api/v1/sync/commands`, `/versions`, `/receipts`; `App.tsx`. |
| **16. Operational reporting** | No general reporting API; authorized record and balance reads exist. | **Implemented as a client report view:** period/site/facility filters over authorized reads; counts stage records and current non-superseded observations without adding grams across stages; presents supporting records and print layout. Known trade UUID can be opened for represented parties. | Client-side aggregation is not a general report endpoint. No trade search, residue payment, external money verification, or independent assay certification. Counts are record/observation counts, not production KPI totals. | Existing site, Dora, processing, inventory, consignment, recovery, residue-sale and trade detail APIs; `ReportsWorkspace.tsx`; no migration. |

## Backend-to-frontend findings

- HTTP handlers and many Zod schemas are registered in `server/src/app.mjs`; domain services are in `server/src/modules`. SQL migrations are the broad database definition. `server/src/database/models.mjs` models core tables, not every migrated table.
- Collection reads exist for sites, holes, participants, Doras, production events, processing events, consignments, residue sales, recovery facilities/events, inventory movements and audit streams/checkpoints. Milestone 6 adds authorized batch search and traceability reads. There is still no gold-trade collection or general dashboard/report API; the Reports workspace calculates record/observation counts from existing authorized reads.
- Recovery facility create remains unavailable; Milestone 4 adds a read-only authorized facility list/detail based on existing facility scope relationships. Organization, account, membership and existing role-assignment list/detail endpoints are also absent; the UI limits those records to what existing authorized responses or the active session can provide.
- Allocation review decisions are absent by design until reviewer policy is approved.
- Payment routes are scoped to gold trades. AC-08a records residue-sale payment coverage as an unmet requirement; no residue payment endpoint or payment UI was added. Do not reuse gold-trade settlement as residue settlement.
- Audit stream discovery and checkpoint-history collection endpoints now filter all returned streams/checkpoints by current live access; no general audit-event timeline route was added.
- There is no automatic fictional demonstration-data seeding flow. Keep all demonstration data fictional and isolated.

Core entities are defined across migrations 001–011: parties and scoped relationships; sites/holes; material events/batches; measurements/assays; allocation chains/revisions; processing; inventory movements; consignments/receipts/custody; trades/payments; QR; audit streams/checkpoints. Examples: `001_foundation.sql`, `002_phase_two_operations.sql`, `004_phase_three_residue_recovery.sql`, `006_phase_four_gold_trades.sql` and `011_audit_checkpoints.sql`.

## Complete demonstration journey

| Step | Backend | UI | Dependency/decision |
|---|---|---|---|
| Register site and hole | Create/list/read APIs | Registry list/detail/create; permitted site metadata updates; hole list/detail/create | System administrators still lack a site/hole resource directory for assigning these scopes. |
| Register participants/relationships | Scoped participant and admin APIs | Registry lists and creates participant identities/categories/site or hole relationships; dates and source/evidence references are shown | No relationship edit/revoke API; login account and role directories are incomplete. Keep participant category, relationship and system role distinct. |
| Record sharing agreement | No general agreement workflow | None | Decide how negotiated arrangements are represented; do not infer ownership or percentages. |
| Capture production | Event/output/batch APIs | Production register/detail plus structured capture for selected site/hole through the existing offline queue; authorized batch search opens its trace | No general trade search; source details remain subject to each record's own authorization. |
| Record allocation | Proposal/revision/history API; pending only | Structured proposal and correction commands with beneficiary relationship, basis, receipt and revision history | Reviewer policy and decision API are absent; no ownership or percentage is inferred. |
| Dora processing | Event/input/output/measurement APIs | Operations: create/list/detail Dora and processing event; link actual production output and source records | Authorized site grant required to register a Dora; event list is filtered using detail-level facility and source-hole authorization. |
| Pool/transfer residue | Stockpile/intake/transfer/balance APIs | Operations: stockpile list/create/detail, measured Dora-output intake, balances, movement provenance and transfers | Recovery facility must already exist; source output must be measured/verified and not already accepted. |
| Consign and receive | Dispatch/transport/receipt/correction/custody APIs | Operations: authorized list/detail, create, dispatch, transport legs, receipt/correction and custody offer/decision | These UI actions are online-only; each action remains server-authorized. |
| Recover gold | Recovery transformation and genealogy | Operations: facility/location register, balances, eligible receipt inputs, event create/detail and source genealogy | Facility provisioning and residue payment are unsupported; output remains aggregate absent approved allocation basis. |
| Weigh and assay | Backend supports all domains; production measurement UI only | Partial | Add context-specific observation UI and history; validate field practice. |
| Merchant trade and payment | Gold trade/payment APIs | None | Build UI, validate both merchant routes; residue payment API missing. |
| Custody | Offer/decision APIs | Generic JSON subset | Build custody history and handover UI. |
| Traceability | Authenticated QR and authorized genealogy API | Search batches, inspect linked records, create/rotate QR and resolve tokens with a signed-in account | No public verification. A caller only sees records allowed by their live site/hole/facility/party grants. |
| Audit verification | Checkpoints and verifier | Discover authorized streams, create and review checkpoint history/status and live tail | Checkpoint history is capped to the latest 100; PostgreSQL is the single trust boundary. |
| Offline capture/sync | Supported allowlist and durable receipts | Existing capture, queue/retry/receipt/correction flow with batch trace links where receipt data contains a batch ID | No new command types; new workspaces remain online-only. |

The full journey remains incomplete. Milestone 6 adds online-only Traceability and Reports views and server-discovered audit evidence without changing the offline queue contract. A batch's visible lineage is filtered against current record authorization; a QR token is resolved only through an authenticated request. There is no public QR certification, trade collection/search, general reporting API, residue-sale payment, external payment verification, allocation review workflow, recovery-facility creation, independent laboratory certification, or external checkpoint anchor. Reports are computed from authorized API response sets and do not sum stage quantities. Browser API mocks are not proof of browser-to-PostgreSQL behavior; the Milestone 6 PostgreSQL suite passed 56/56 on the dedicated test database.

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

Client verification on 2026-11-23: lint passed; production build and app-shell check passed; unit tests passed **3/3**; Playwright Chromium passed **28/28**. Five new mocked-API tests cover source-linked measurement recording, gold-trade proposal/revision and both-party decisions, reasoned trade measurement/assay corrections, payment reporting and counterparty decision, and Auditor read-only/unsupported trade review. The other 23 tests cover Milestones 1–4, including navigation, Registry, Access, Production, Operations, offline synchronization, receipt recovery, audit checkpoints and responsive layout. These API responses are fictional and do not constitute a real browser-to-PostgreSQL journey. The final Milestone 4 authorization correction had server lint and PostgreSQL integration coverage **56/56** on the dedicated test database; backend code was unchanged and backend tests were not rerun for Milestone 5. See [the implementation plan](IMPLEMENTATION_PLAN.md) for phase and milestone history.

Add acceptance coverage for:

- Form/page validation, role visibility, loading/error/empty states and accurate pending/conflict/rejected labels.
- API/PostgreSQL create/list/detail workflows, live role revocation, cross-site/facility denial and counterparty privacy.
- Cross-module genealogy and inventory balance consistency from production through processing, residue, consignment, receipt and recovery.
- Browser demonstration with fictional fixtures and real API/database; retain mocked tests for focused error cases.
- Offline allowlist forms, no API caching, restart/reconnect, unknown uploads, receipt recovery, correction and authorization revocation.
- QR scope and audit checks distinguishing covered history, unanchored tail and physical claims from recorded software evidence.

The acceptance-criteria document contains historical verification counts from earlier phases. Stage 7A Milestones 4–6 status and verification limits are recorded below and in the implementation plan.

## Stage 7A Milestone 4 status (2026-11-22)

The Operations workspace adds Dora and processing, residue inventory/sales, consignments/custody, and recovery pages using the existing domain services and inventory journal. New backend reads provide authorized registers and eligible choices; mutation behavior continues through existing routes. No migration was added. No offline command type was added, and these Operations actions require a live connection. Existing Capture, Registry, Access, Production, Allocation, Queue and Audit workspaces remain in place.

The workspace navigation is exposed to `DORA_OPERATOR`, `RECOVERY_FACILITY_OPERATOR`, `FIELD_OFFICER`, `MINING_OPERATOR`, `MINER` and `AUDITOR`; navigation visibility only improves discoverability. The server remains authoritative. Dora operators can create processing events and eligible residue-sale/consignment actions within facility and source-hole scopes; recovery operators can manage authorized recovery locations and events and participate on authorized consignment sides; field/mining roles see records/actions allowed by existing site/hole rules; Miners are read-only in Operations; Auditors are read-only. Every mutation still passes through existing service authorization and transaction logic.

Additional read endpoints are `GET /api/v1/doras`, `GET /api/v1/doras/:facilityId/residue-outputs`, `GET /api/v1/doras/:facilityId/recovery-destinations`, `GET /api/v1/processing-events`, `GET /api/v1/inventory/locations/:locationId/movements`, `GET /api/v1/consignments`, `GET /api/v1/residue-sales`, `GET /api/v1/recovery-facilities`, `GET /api/v1/recovery-facilities/:facilityId`, `GET /api/v1/recovery-facilities/:facilityId/recovery-events`, and `GET /api/v1/recovery-facilities/:facilityId/eligible-inputs`. These were needed for role-filtered discovery, source selection and provenance displays; they do not add alternate mutation paths.

Browser coverage includes mocked UI journeys for Dora processing, measured inventory, consignment/recovery genealogy and Auditor read-only Operations. The final authorization correction passed server lint and PostgreSQL integration **56/56** using the dedicated test database. Milestone 4 had no migration changes. Browser cases remain mocked and do not prove an end-to-end browser-to-PostgreSQL workflow. No Docker, deployment or field verification is claimed.

## Stage 7A Milestone 5 status (2026-11-23)

Commerce adds Measurements & assays, Gold trades and Payments to the role-aware workspace using only existing source, gold-trade and payment APIs. Production and processing measurements are viewed in source-event context; recording uses selected event/output or processing input/output IDs. Where a production detail response supplies participant relationships, non-recorder observations select one of those returned party IDs. Trade measurements and assays remain trade-line linked, show history, and support existing append-only corrections with predecessor and reason. No VERIFIED observation is user-created, and an assay is never called certified.

Trade flows provide proposal creation, known-ID lookup, current proposal revision and represented-party decision controls. The UI states that agreement requires both parties to accept matching terms. Payment flows are available only for gold trades, report from the buyer and show permitted existing decisions; sale agreement, payment report, counterparty record and actual money movement are distinct. The API does not verify external payment. Residue-sale payments and payment-provider integrations remain unsupported.

Role-specific tests verify seller and buyer decision contexts, buyer report versus seller confirmation, and read-only Auditor controls. Actual authorization is still enforced by server middleware and services. The current gold-trade detail API requires representation by a seller or buyer, so an Auditor grant alone cannot inspect trade/payment detail; no Auditor-specific route was added. Users open a known UUID or a trade they just created because no trade list/search endpoint exists. These product gaps are shown in the workspace.

All Commerce mutations are online-only. No offline command type, backend route, domain service or migration changed; migrations 001–011 are unchanged. `npm run lint` passed, `npm run build` passed, `npm run test:unit` passed **3/3**, and `npm run test:e2e` passed **28/28** on 2026-11-23. The five Milestone 5 browser cases use fictional intercepted API responses; the remaining tests are Milestones 1–4 regression coverage. No field, production deployment, laboratory, bank or external payment verification is claimed.

### Milestone 5 remaining limits before Milestone 6

At the Milestone 5 closeout, the UI had no reports view or batch genealogy search. Milestone 6 adds authorized batch search and traceability reads plus report summaries over existing authorized API reads. Recovery facility creation, residue-sale payment, gold-trade collection/search, Auditor-only trade detail, independent payment verification, and offline Operations or Commerce mutations remain unsupported. Recovery-facility authorization/party ownership semantics remain those already present in the backend. Physical measurement, weighing, assay, transport, receipt, custody and recovery practices require field validation.

## Stage 7A Milestone 6 status (2026-11-23)

Traceability provides authorized batch-code/UUID search, a batch view that links records returned by the existing production, processing, inventory, consignment, recovery, residue-sale and party-authorized gold-trade services, and authenticated QR creation, rotation and resolution. `GET /api/v1/material-batches` and `GET /api/v1/material-batches/:batchId/traceability` are the only new batch read endpoints. Search reads keyset pages of at most 100 candidates, authorizes each candidate before returning it, returns at most 50 visible batches, and scans no more than 1,000 candidates per request. The response marks a bounded scan `complete: false`, and the UI asks users to narrow that search. The batch lineage filter checks live hole, processing facility, recovery facility and trade-party access through existing authorization/domain services. QR write controls are limited by active supported role and the source scope shown for the batch; server checks remain authoritative and rejection errors are shown. A recovery-facility user can trace the authorized aggregate recovery output and its recovery event; the UI does not infer individual source-person attribution. QR lookup is never anonymous.

Audit Evidence discovers currently readable streams and recent checkpoints through `GET /api/v1/audit/streams` and `GET /api/v1/audit/checkpoints`, and supports checkpoint creation, detail, status, verification and attempt history. Discovery and history are filtered by the same live stream-access checks used by checkpoint detail. Auditor controls remain read-only in the UI. Checkpoints and verifiers share PostgreSQL; a covered stream prefix can have a later unanchored tail, and no external independent commitment or deployed blockchain exists. History is limited to the latest 100 checkpoint rows.

Reports queries existing authorized list/detail/balance services. Filters cover date, site and facility within the response set. It shows stage-specific record counts and distinct current measurement observations (superseded observations excluded); it does not combine gram quantities across production/processing/recovery stages. Supporting records can be expanded and printed. A known trade UUID can be loaded only for an authorized trade party because there is no trade collection endpoint. A payment record remains a ledger record, not proof of external money movement.

The existing IndexedDB sync contract, command types, idempotency, retries, receipts and corrections are unchanged. Queue records link to batch traceability where a batch UUID exists in the submitted payload or returned receipt. New workspaces are online-only and do not claim guaranteed background sync. No migration was added; migrations 001–011 are unchanged.

**Milestone 6 verification on 2026-11-23:** client lint passed; `npm run build` and app-shell verification passed; unit tests passed **3/3**; Playwright Chromium passed **53/53**. Ten targeted Playwright cases use fictional mocked API responses to cover supported role/scope combinations for QR write controls, unsupported roles and wrong scope, visible server 403/404 responses, and incomplete-search notice; the suite retains QR lookup/rotation, Auditor, audit, report and mobile scenarios. Existing offline queue coverage follows an accepted receipt's related batch into Traceability. These are UI tests, not browser-to-PostgreSQL proof. Server lint passed for **32 ES modules**. PostgreSQL integration tests passed **56/56** on the dedicated `minaledger_test` database, including 275 inaccessible matches preceding an accessible search result and checks that inaccessible batches are omitted, plus batch scope/lineage, recovery QR rotation and audit collection authorization assertions. No migration, new offline command, deployment, field validation, external QR verification, external checkpoint anchoring or payment verification is claimed.

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
