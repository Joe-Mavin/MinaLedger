# MinaLedger Product UI Assessment and Roadmap

**Assessment date:** 2026-11-23
**Revision inspected:** working tree based on `main` at `4058e517d05f9639f584c42cb206f0e49a7aa7f2`, with Stage 7A Milestone 5 client changes under review.
**Scope:** the feature inventory below began as the pre-Milestone-2 baseline. Stage 7A Milestones 2–5 implementation and verification are appended in [the implementation plan](IMPLEMENTATION_PLAN.md) and [demo contract](DEMO_CONTRACT.md). Commerce browser tests use fictional mocked APIs and do not prove browser-to-PostgreSQL behavior. No field validation is claimed.

## Summary

The backend contains substantial scoped identity, production, processing, inventory, recovery, trade, custody, audit and offline-sync capabilities. The UI now includes the shared workspace shell, Registry and limited Access Administration, Production and Allocation, Milestone 4 Operations, and Milestone 5 Measurements & assays, Gold trades and Payments workspaces. The complete product journey still has API and policy gaps; mocked browser tests do not prove browser-to-PostgreSQL behavior.

`App.tsx` retains login, overview, Capture, command queue and audit-checkpoint controls and integrates the Registry, Access, Production, Operations and Commerce workspaces. Commerce uses the existing production/processing measurement routes and gold-trade/payment services. Trade and payment details require an authorized party and a known trade UUID because the backend has no trade collection/search endpoint. QR tracing and general reporting screens remain absent.

The existing workspace should remain a first-class **Capture** destination. New UI should call existing authenticated APIs and services; it should not duplicate business logic or create another inventory ledger.

## Frontend inventory

The client keeps `App.tsx`, `main.tsx`, `api.ts`, `apiBase.ts`, `styles.css` and `offline/` modules for IndexedDB, commands, types and synchronization. `registry/RegistryWorkspace.tsx`, `admin/AccessAdministration.tsx`, `production/ProductionWorkspace.tsx`, `operations/OperationsWorkspace.tsx` and `commerce/` provide the Milestone 2–5 screens without adding a router or replacing the offline command architecture. Capture, measurement context, queue recovery and checkpoint behavior remain in the shared app.

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

The full journey cannot currently be completed through the product UI. Milestone 5 adds online-only measurements, trade and gold-payment screens around existing services; it does not change the offline queue contract. The gold-trade API has no collection/search endpoint, so the UI cannot provide a complete trade register or filters. Auditor-only trade/payment detail is not authorized by the current backend route. Residue-sale payments, independent payment verification, allocation review, recovery-facility creation, full batch transformation lineage, QR and reports remain gaps. Milestone 5 browser APIs use fictional intercepted responses and do not prove browser-to-PostgreSQL behavior.

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

The acceptance-criteria document contains historical verification counts from earlier phases. Stage 7A Milestones 4–5 status and verification limits are recorded below and in the implementation plan.

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

Remaining limits include no recovery facility creation, no residue-sale payment endpoint/UI, no gold-trade collection/search or Auditor-only trade detail route, no independent payment verification, no general reports, no full direct batch/transformation genealogy API, and no offline Operations or Commerce mutations. Recovery-facility authorization/party ownership semantics remain those already present in the backend. Physical measurement, weighing, assay, transport, receipt, custody and recovery practices require field validation.

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
