# MinaLedger Product UI Assessment and Roadmap

**Assessment date:** 2026-11-20
**Revision inspected:** `f8f37e35b3681bbcf1d4ea910f98b0809fec264d` (`main`; cached `origin/main` matched). No network fetch was performed.
**Scope:** the initial assessment below records the pre-Milestone-2 state. Stage 7A Milestone 2 implementation and verification are appended in [the implementation plan](IMPLEMENTATION_PLAN.md) and [demo contract](DEMO_CONTRACT.md). No field validation is claimed.

## Summary

The backend contains substantial scoped identity, production, processing, inventory, recovery, trade, custody, audit and offline-sync capabilities. The UI now includes the shared workspace shell, a registry for authorized sites, holes and participants, and limited access administration. The full supply-chain journey still cannot be completed through the UI.

`App.tsx` retains login, overview, capture, command queue and audit-checkpoint controls. The shared shell now exposes Registry and Access administration according to the active role/scope. Registry supports site/hole and participant list/detail/create, plus permitted site metadata updates. Access administration supports account and organization creation, supported role grants and current-session revocation. Other offline-enabled operations still use the generic JSON editor. There are no screens for allocations, Dora processing, inventory/recovery, merchant trades/payments, consignments, QR tracing or reports.

The existing workspace should remain a first-class **Capture** destination. New UI should call existing authenticated APIs and services; it should not duplicate business logic or create another inventory ledger.

## Frontend inventory

The client keeps `App.tsx`, `main.tsx`, `api.ts`, `apiBase.ts`, `styles.css` and `offline/` modules for IndexedDB, commands, types and synchronization. `registry/RegistryWorkspace.tsx` and `admin/AccessAdministration.tsx` provide the Milestone 2 screens without adding a router or changing the offline command architecture. Capture, measurement context, queue recovery and checkpoint behavior remain in the shared app.

`client/src/api.ts` provides the shared request helper and typed reads for sites, holes, hole participants and production events. Most other calls are direct from `App.tsx`; there are no feature-specific clients for other domains.

## Verified feature inventory

| Module | Backend status | Frontend status | Missing work | Evidence |
|---|---|---|---|---|
| **1. Authentication/access** | Login, profile, scoped roles, account/org creation and role grant/revocation exist. | **Partial:** login/session and role context; global system administrators can create accounts/organizations, assign roles, and revoke grants created in the active UI session. No full directory or existing-assignment ID listing. | Add authorized account/org/member/role directory endpoints before listing or managing existing records. Bootstrap remains outside the app. | `App.tsx`, `client/src/admin/AccessAdministration.tsx`; `POST /api/v1/admin/...`; party/account/role tables in migration 001. |
| **2. Dashboard** | Health/readiness exists; no operational summary API found. | **Missing:** greeting and sync status are not an operations dashboard. | Define authorized indicators and implement overview. | `App.tsx` welcome section; route surface in `server/src/app.mjs`. |
| **3. Sites and holes** | Site create/list/read/update and hole create/list/read APIs exist. | **Implemented for site-readable scopes:** authorized list/detail, site create/edit, hole list/detail/create; server continues to enforce resource scope. | Add system-administrator resource discovery if admin assignment must support site/hole scopes; add navigation only if hole-only discovery becomes available. | `/api/v1/sites`, `/api/v1/sites/:siteId`, `/api/v1/sites/:siteId/holes`; `client/src/registry/RegistryWorkspace.tsx`; migration 001. |
| **4. Participants/organisations** | Scoped participant create/list, organization/account creation and user-role APIs exist; site and hole relationships are distinct. | **Partial but usable:** site/hole relationship register and creation with identity, category, effective period, source and evidence; org creation and limited account/role administration. No complete account, organization or membership directories and no relationship lifecycle endpoint. | Add safe directory/detail/member and relationship lifecycle APIs where product workflows require them. | `/api/v1/sites/:siteId/participants`, `/api/v1/sites/:siteId/holes/:holeId/participants`, `/api/v1/admin/...`; migrations 001–002. |
| **5. Sharing/allocations** | Allocation proposals, revisions and output history exist; proposals remain pending; review decisions are not exposed. No general negotiated sharing-agreement workflow was found. | **Partial:** generic JSON command only; no proposal/history/review screen. | Add proposal/revision UI. Do not represent approval until reviewer policy and backend decisions exist. | `GET/POST .../allocation-sets`; `allocation.service.mjs`; allocation tables in migration 001. |
| **6. Production/batches** | Production create/list/read, output batches, capture provenance and measurements exist. | **Partial but usable for capture:** structured production/measurement/acknowledgement; no event/batch register or detail. | Add event/batch list, detail, lineage and measurement history. | Production routes and `production.service.mjs`; migration 001 material entities and migration 002 capture/participant tables. |
| **7. Dora processing** | Dora create/list/read/update; processing event create/read and input/output measurements exist. | **Missing:** no Dora or processing UI. | Facility and processing forms plus event discovery. No processing-event collection endpoint exists. | `/api/v1/sites/:siteId/doras`, `/api/v1/processing-events...`; `dora.service.mjs`, `processing.service.mjs`. |
| **8. Residue/recovery** | Stockpile create/list, measured intake, transfer, balances, adjustment, consignment and recovery services use the existing inventory journal. Recovery facility location/event routes exist; no recovery-facility create/list route found. | **Partial:** selected inventory/consignment commands via generic JSON; no operational screens. | Add inventory/recovery UI; add facility provisioning/discovery only if approved workflow requires it. Keep pooled recovery aggregate absent an approved basis. | `/api/v1/doras/:facilityId/stockpiles`, `/api/v1/stockpiles/...`, `/api/v1/recovery-facilities/:facilityId/...`; `residue.service.mjs`; migrations 001, 004–005. |
| **9. Measurements/assay** | Production/processing/trade measurements and trade assay APIs exist. | **Partial:** structured production measurement; no processing/trade observation UI; some trade commands use generic JSON. | Context-specific forms, observation history and linked correction views. A recorded assay is not independent certification. | Measurement routes in `server/src/app.mjs`; measurement/assay tables in migrations 001 and 006–008. |
| **10. Merchant trades** | Gold-trade proposals, lines, revisions, bilateral decisions, custody, observations and per-trade reconciliation exist. | **Missing:** no merchant/trade UI. | Add trade list/detail and counterpart workflows. Validate direct miner purchases and merchant aggregation/resale scenarios. | `/api/v1/gold-trades...`; `gold-trade.service.mjs`; `docs/IMPLEMENTATION_PLAN.md` says aggregation and broader scenario coverage remain incomplete. |
| **11. Payments** | Gold-trade payment reports/decisions and reconciliation exist. No residue-sale payment route found. | **Missing:** no payment UI. | Add scoped payment history/decisions; decide whether residue settlement is in scope and add backend support first. | Gold-trade payment routes in `server/src/app.mjs`; payment entities in migration 001; implementation plan says residue payments remain outstanding. |
| **12. Consignments/custody** | Create/read, dispatch, transport, receipt/correction and custody offer/decision APIs exist. | **Partial:** generic JSON subset only; no manifest/movement/receipt workspace. Consignment creation and transport legs are not offline commands. | Add list/detail/dispatch/receipt/custody views. No consignment collection endpoint exists. | `/api/v1/consignments...`, custody routes; `residue.service.mjs`; migrations 001 and 004. |
| **13. Traceability/QR** | Batch QR create/rotate and authenticated lookup exist; material genealogy is stored. | **Missing:** no QR or traceability UI. | QR display/rotation and authorized scan/detail timeline. Lookup is not anonymous public verification. | `/api/v1/material-batches/:batchId/qr`, `/api/v1/qr/:token`; `qr.service.mjs`; migration 001 `qr_record`. |
| **14. Audit checkpoints** | Hash-linked streams, database checkpoints, retryable outbox and covered-prefix verification exist. | **Partial:** manual stream UUID checkpoint creation/status only; no event timeline, checkpoint list or stream picker. | Add stream discovery/history and retain disclosure of covered history, unanchored tail and external verification limits. | Checkpoint routes in `server/src/app.mjs`; `checkpoint.service.mjs`; migration 011; checkpoint form in `App.tsx`. |
| **15. Offline sync** | Fourteen command types have schemas, live authorization/version checks, dependency handling and durable receipts. IndexedDB supports retry, receipt recovery and linked corrections. | **Partial:** structured production/measurement/acknowledgement, queue and correction; raw JSON for other allowlisted commands. | Structured forms for supported types; visibly identify unsupported workflows as online-only. | `client/src/offline/types.ts`, `sync.ts`, `commands.ts`; `/api/v1/sync/commands`, `/versions`, `/receipts`; server `sync.schemas.mjs` and `sync.service.mjs`. |
| **16. Operational reporting** | No general reporting/dashboard API found. Balance and per-trade reconciliation reads are narrower module reads. | **Missing:** no reports interface. | Define measures, filters and privacy scopes before adding reports. | Route surface in `server/src/app.mjs`; trade read model in `gold-trade.service.mjs`. |

## Backend-to-frontend findings

- HTTP handlers and many Zod schemas are registered in `server/src/app.mjs`; domain services are in `server/src/modules`. SQL migrations are the broad database definition. `server/src/database/models.mjs` models core tables, not every migrated table.
- Collection reads exist for sites, holes, participants, Doras, production events and stockpiles. Processing events, gold trades, consignments, residue sales and recovery events are read-by-ID/action APIs without collection endpoints.
- Recovery facility create/list and general dashboard/report APIs were not found. Organization, account, membership and existing role-assignment list/detail endpoints are also absent; the UI limits those records to what existing authorized responses or the active session can provide.
- Allocation review decisions are absent by design until reviewer policy is approved.
- Payment routes are scoped to gold trades. `docs/ACCEPTANCE_CRITERIA.md` says payment coverage includes residue sales, while the implementation plan and actual route surface say residue-sale payment endpoints remain outstanding. Reconcile AC-08a before building payment UI.
- Internal audit stream read/verify functions exist, but there is no general audit-event timeline route.
- There is no automatic fictional demonstration-data seeding flow. Keep all demonstration data fictional and isolated.

Core entities are defined across migrations 001–011: parties and scoped relationships; sites/holes; material events/batches; measurements/assays; allocation chains/revisions; processing; inventory movements; consignments/receipts/custody; trades/payments; QR; audit streams/checkpoints. Examples: `001_foundation.sql`, `002_phase_two_operations.sql`, `004_phase_three_residue_recovery.sql`, `006_phase_four_gold_trades.sql` and `011_audit_checkpoints.sql`.

## Complete demonstration journey

| Step | Backend | UI | Dependency/decision |
|---|---|---|---|
| Register site and hole | Create/list/read APIs | Registry list/detail/create; permitted site metadata updates; hole list/detail/create | System administrators still lack a site/hole resource directory for assigning these scopes. |
| Register participants/relationships | Scoped participant and admin APIs | Registry lists and creates participant identities/categories/site or hole relationships; dates and source/evidence references are shown | No relationship edit/revoke API; login account and role directories are incomplete. Keep participant category, relationship and system role distinct. |
| Record sharing agreement | No general agreement workflow | None | Decide how negotiated arrangements are represented; do not infer ownership or percentages. |
| Capture production | Event/output/batch APIs | Structured capture for preassigned context | Add event and batch register. |
| Record allocation | Proposal/revision/history API; pending only | Generic JSON | Reviewer policy and decision API are absent. |
| Dora processing | Event/input/output/measurement APIs | None | Build facility and processing workflows. |
| Pool/transfer residue | Stockpile/intake/transfer/balance APIs | Generic JSON subset | Build inventory UI; recovery facility must already exist. |
| Consign and receive | Dispatch/transport/receipt/correction/custody APIs | Generic JSON subset | Build manifests/reconciliation; no collection route. |
| Recover gold | Recovery transformation and genealogy | None | Facility provisioning gap; output stays aggregate absent approved allocation basis. |
| Weigh and assay | Backend supports all domains; production measurement UI only | Partial | Add context-specific observation UI and history; validate field practice. |
| Merchant trade and payment | Gold trade/payment APIs | None | Build UI, validate both merchant routes; residue payment API missing. |
| Custody | Offer/decision APIs | Generic JSON subset | Build custody history and handover UI. |
| Traceability | Authenticated QR and genealogy APIs | None | Build QR/scan/detail UI. |
| Audit verification | Checkpoints and verifier | Manual UUID checkpoint UI | Add stream discovery/history; explain trust boundary and tail. |
| Offline capture/sync | Supported allowlist and durable receipts | Production-first UI; generic JSON for much of the allowlist | Add typed forms; other workflows remain online-only. |

The full journey cannot currently be completed through the product UI. Registry and limited access administration join the existing capture, measurement, offline synchronization and checkpoint tools. Processing, inventory, recovery, trade, custody and reporting remain API-only; allocation acceptance and residue-sale settlement also have backend/policy gaps.

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

### 3. Production, batches and allocations

- Build production register/detail, batch genealogy, measurement history and allocation proposal/revision/history.
- Reuse production, measurement and allocation APIs. Review API is new and gated on policy approval.
- Test participant/capture matching, linked corrections and pending status.
- Accept when production and measurement can be inspected after creation and proposals are never shown as approved without approval.

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

The client has three unit tests and sixteen Playwright tests. The browser suite covers all nine role navigation sets, registry and administration request flows, offline queue/session behavior and checkpoint display. Browser API interactions use fictional intercepted responses; they do not constitute a full browser-to-real-API journey. Backend PostgreSQL integration tests in `server/tests/integration.test.mjs` cover actual API/domain scenarios, including site/participant reads, account/role administration, allocation gating, Dora lineage, inventory, trade/payment authorization, role revocation and checkpoints. Stage 7A Milestone 2 verification passed client lint, production build, units **3/3**, Playwright **16/16**, backend lint and PostgreSQL tests **55/55**; details and screenshots are in [the implementation plan](IMPLEMENTATION_PLAN.md).

Add acceptance coverage for:

- Form/page validation, role visibility, loading/error/empty states and accurate pending/conflict/rejected labels.
- API/PostgreSQL create/list/detail workflows, live role revocation, cross-site/facility denial and counterparty privacy.
- Cross-module genealogy and inventory balance consistency from production through processing, residue, consignment, receipt and recovery.
- Browser demonstration with fictional fixtures and real API/database; retain mocked tests for focused error cases.
- Offline allowlist forms, no API caching, restart/reconnect, unknown uploads, receipt recovery, correction and authorization revocation.
- QR scope and audit checks distinguishing covered history, unanchored tail and physical claims from recorded software evidence.

The acceptance-criteria document contains historical verification counts from earlier phases. The latest Stage 7A Milestone 2 results are recorded above and in the implementation plan.

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
