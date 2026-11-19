# Proposed implementation milestones

## Phase 1 implementation status (2026-11-18)

Phase 1 foundation work is implemented and covered by the current combined integration suite. The product and the broader Stage 1/2 deliverables remain partial.

- Implemented and tested: ES-module Express API; Sequelize access layer and reviewed SQL migration; environment validation; health endpoint; bcrypt accounts and short-lived JWT authentication; audited user/role administration and organisation membership; site/hole/resource authorization with cross-hole and cross-site regression coverage; site/hole/participant commands; production events, output batches and append-only typed measurement observations; allocation revision constraints; one derived inventory journal with guarded transfer service; and per-aggregate hash-linked audit verification.
- Still needed: client/PWA, deployment and backup policy, allocation-review API and pilot reviewer role, complete production operations, offline engine, distributed ledger and production rollout. Commercial correction and partial-reversal integrity rules are enforced and tested in PostgreSQL; a user-facing correction command is not implemented.
- Verification commands: `cd server; npm run lint`, `npm run migrate`, then `npm test` with `TEST_DATABASE_URL` set to a dedicated PostgreSQL `_test` database. The suite resets and cleans that database's `public` schema.

## Phase 2 implementation status (2026-11-18)

The Phase 2 production-to-Dora backend slice and targeted security/domain-integrity corrections are implemented. **Phase 2 as a whole remains partial.** Migrations `002_phase_two_operations.sql` and additive `003_phase_two_integrity.sql` extend the approved Phase 1 schema without changing its original migrations. A checked manual rollback is kept outside the forward migration directory.

- Implemented: reuse of an existing party across effective-dated site/hole relationships; production-event participant links and optional assisted-capture provenance; linked measurement corrections with effective source-party attribution; complete quantity-based or share-based allocation proposals with explicit basis observations, immutable revisions, row/total checks, effective beneficiary relationships and pending review history; multiple Dora facilities associated with one site; facility-scoped access; processing events with one or more production output inputs, typed input/output measurement sets, distinct miner-retained-gold and Dora-retained-residue batches, selected-facility attribution and source lineage; QR token creation and rotation with write authorization across every lineage origin, plus authenticated read-authorized lookup.
- Allocation proposals remain `PENDING`. No API can approve, dispute, reject or withdraw them while reviewer authority, eligible measurement kinds, evidence/reason rules, dispute granularity and rounding/unallocated-quantity rules remain unresolved. An approved allocation cannot be replaced through the proposal API.
- Not included in the Phase 2 slice (partly delivered by Phase 3 afterward): frontend/PWA and offline sync, inventory posting for processing, and residue stockpile pooling, transport, custody and recovery. Merchant gold trades, payments and distributed blockchain operation remain later work or pilot-dependent.
- The Phase 2 regression coverage is included in the current full suite. Migration 003 rollback/reapply, QR authorization/revocation, measurement source attribution and rollback, and beneficiary eligibility pass in the Phase 4 verification run below.

## Phase 3 implementation status (2026-11-19)

The residue-to-recovery backend slice is implemented and verified using additive migrations `004_phase_three_residue_recovery.sql` and `005_phase_three_integrity_corrections.sql` with checked rollback scripts. It reuses the existing `inventory_movement` journal, balance guard, authentication, resource authorization, idempotency and append-only audit services.

- Implemented and tested: Dora-output stockpile intake with preserved origin; cross-Dora pooling by a user authorized for both locations; count-backed adjustments; Dora-to-recovery residue sale proposals and bilateral line decisions without payment; itemized multi-batch consignments; paired stockpile/transit dispatch and transit/facility receipt; partial, disputed and rejected receipt evidence; transport legs; separate custody offer/decision; recovery-facility inventory; multi-source recovery consumption; multiple aggregate outputs linked to every input; variance records; audit, idempotency and live role revocation.
- Targeted corrections: effective receipt claims are separated into presented, accepted, disputed and rejected quantities and cannot exceed net accepted dispatch. Receipt corrections append linked observations and reverse/repost accepted inventory atomically; superseded receipt observations cannot source recovery genealogy, and a receipt already cited by immutable recovery genealogy cannot be revised. Dora intake requires a current, unsuperseded `MEASURED` or `VERIFIED` observation for the exact processing output and batch, with an exact posted quantity. Conflicting seller/buyer sale quantities remain unresolved until a linked successor receives fresh matching decisions from both parties.
- Database enforcement: source and batch foreign keys, unique intake from each Dora output, typed receipt measurements, accepted receipt movement checks, cumulative receipt claim guard and correction/reversal checks, current-measurement intake guard, paired Phase 3 movement validations, consignment status transitions, sale mapping, mismatch revision and eligible inventory checks, custody decision/offer completeness, recovery source quantity/current-receipt checks, output-to-input genealogy completeness, and append-only evidence triggers. Rollback refuses to discard correction records.
- Limitations at the Phase 3 checkpoint: no gold-trade routes, frontend/PWA, offline sync, production blockchain or per-miner recovered-output allocation. Gold-trade backend routes are implemented in Phase 4 below. Recovery process stages are broad classifications; they do not encode technical recipes. Pilot decisions about physical pooling, custody evidence, discrepancy/adjustment authority, measurements and residue-sale terms remain open.
- Verification at the Phase 3 checkpoint on 2026-11-19: `npm run lint` passed for 23 ES modules and `npm test` passed 47/47 against the dedicated PostgreSQL `_test` database, including the 31 nested Phase 3 scenarios and Phase 1/2 regression cases.

## Phase 4 implementation status (verified 2026-11-19)

The gold-trade backend slice is implemented with additive migration `006_phase_four_gold_trades.sql` and a matching guarded rollback. Earlier migrations remain unchanged. The API uses existing authentication, live account/role checks, party resource authorization, idempotency, audit streams and the authoritative inventory journal.

- Implemented: gold-trade proposals against eligible gold outputs; seller/buyer term decisions with identical quantity, price, total and deductions required for agreement; immutable disagreements and fresh successor proposals; append-only declared/measured weight observations and corrections; assay observations and corrections; exact measured custody offers, recipient acceptance/dispute and atomic balanced inventory movement; payment reports and counterparty decisions; and a party-scoped trade read model reconciling proposed/agreed/transferred quantities, amount due/settled/outstanding/disputed, measurement spread, evidence and unresolved events. The integration scenario verifies disagreement/revision, assays and corrections, accepted/disputed/concurrent custody, payment report retry, partial confirmations, payment dispute, overpayment rejection and reconciliation.
- Database enforcement includes eligible gold lineage, source-party and party representation checks, trade and line immutability, bilateral exact-term decisions, seller inventory commitments, custody measurement linkage and exact-quantity movement, append-only assay/payment/status/evidence history, payment obligation limits, and transaction-level inventory nonnegative/paired-transfer checks. Phase 4 migration rollback/reapply is exercised before fixture records are created.
- Verification on 2026-11-19: `npm run lint` passed for **24 ES modules**. `npm test` passed **48 tests, 48 passed, 0 failed** against the dedicated PostgreSQL `_test` database. The suite migrates from an empty schema, verifies rollback/reapplication of migrations 003, 004, 005 and 006, includes all 31 nested Phase 3 scenarios and retains Phase 1/2 integrity coverage.
- Remaining scope and validation: the current gold payment API does not expose residue-sale settlement; it does not connect to a payment provider or independently verify money movement. Currency conversion, a gold aggregation transformation, frontend/offline workflows, deployment and pilot operations are not implemented. The integration scenario exercises recovered gold; local-miner purchases and merchant-to-merchant aggregation/resale need broader scenario validation. Custody measurement practice, assay acceptance, price visibility, supported currencies and settlement evidence/authority remain participant decisions.

## Delivery rule

The milestone definitions below describe scope and acceptance criteria; implementation status is stated in the Phase 1/2/3/4 summaries above. The Phase 4 backend slice is implemented, while broader Stage 4 deliverables and Stages 5 onward remain future work. Participant-dependent decisions in the [decision log](DECISION_LOG.md) remain unresolved and must be answered before their affected rules are treated as pilot policy. Do not turn unresolved assumptions into defaults. Each future implementation stage should ship a reviewable vertical slice with migrations, API/UI, permissions, observability and automated tests appropriate to its scope.

## Stage 0 — Phase 0 specification (current assignment)

- **Scope:** project charter, domain model, material routes, database proposal, security, offline, API/architecture, ledger choices, decisions, milestones and acceptance criteria.
- **Dependencies:** supplied project specification.
- **Deliverables:** completed `/docs` specification and README status update; diagrams; decision log with open questions.
- **Acceptance criteria:** requested existing docs are populated; both routes and pooled genealogy are described; homogeneous-basis allocation revisions, typed measurement ownership, one inventory journal with transaction-level balance guards, trade/payment currency integrity, assisted capture and per-aggregate audit ordering are consistent across docs; requirements/observations/proposals/open questions are distinguished; project status says design only; approval gate is explicit.
- **Automated checks:** documentation link check, Markdown lint and Mermaid syntax parse in the eventual repository workflow. No application tests apply to this documentation-only stage.
- **Known risks:** pilot assumptions may be read as universal practice; unresolved terminology could become hard-coded if Phase 1 begins without participant review.

## Stage 1 — application foundation, identity and audit

- **Scope:** React/Vite/TypeScript PWA shell; Express ES-module API; PostgreSQL schema/migrations; scoped account/role model; idempotency and per-aggregate audit stream envelope; health/configuration endpoints; structured errors; CI baseline; a database-integrity proof for composite FKs, deferred cross-row constraints and transactional row-lock protocols, using reviewed SQL if the ORM cannot express them.
- **Dependencies:** owner approval, pilot deployment boundary, authentication choice, initial party/role and data visibility review; verify ORM support for the required PostgreSQL constraints, triggers and transaction isolation before settling migration ownership.
- **Deliverables:** runnable client/API, initial migrations, module boundaries, authentication integration, authorization middleware, audit log and development deployment instructions.
- **Acceptance criteria:** an authorized user can sign in, choose an assigned acting context, access only its allowed records, and create an append-only auditable command. Database design proof demonstrates that inventory guards serialize balance updates and deferred constraints reject invalid movements; payment currency composite FKs and typed measurement-owner constraints work in PostgreSQL. Role revocation takes effect server-side. No feature claims legal validation.
- **Automated tests:** unit tests for role/scope decisions and audit stream hashing; API tests for duplicate and concurrent command handling; integration tests for append and correction; migration smoke test against PostgreSQL; dependency/security baseline checks selected by maintainers.
- **Known risks:** account recovery or identity collection could burden users; broad admin access may expose commercial data; authentication and offline policies may conflict.

## Stage 2 — sites, holes, production and Dora processing

- **Scope:** sites, holes, effective-dated party relationships, multiple independent processing facilities per site, multiple production outputs, output-specific allocation chains and complete homogeneous-basis revisions/reviews, material batches, typed measurement-set ownership/observations, assisted-capture provenance, processing inputs/outputs, residue retention and opaque QR lookup.
- **Dependencies:** Stage 1; pilot agreement on minimum site/hole and production fields, measurement units, facility identification, allocation basis/review authority and whether a dispute applies to a whole set or a beneficiary row.
- **Deliverables:** field capture and authorized genealogy views for production through one or more Dora facilities.
- **Acceptance criteria:** a site supports multiple holes/operators and multiple Doras; an output can be allocated to many beneficiaries and one beneficiary can receive across outputs; each set uses one basis; pending/provisional/disputed/rejected/approved states and corrected revisions are retained; only one current-approved set exists per output; a miner's chosen Dora records multiple outputs; exactly-one typed measurement ownership and batch matching are enforced; measurements are not duplicated on batches; no allocation silently implies entitlement, custody, sale or payment.
- **Automated tests:** domain tests for split/multiple outputs, allocation cardinality/revisions and role scope; API tests for duplicate retries and invalid facility access; database tests for foreign keys/constraints; end-to-end scenario across site → hole → production → output → multiple allocations → Dora processing.
- **Known risks:** terminology and allocation practices vary; initial measurement may be estimated or disputed; QR labels may identify records without proving authenticity.

## Stage 3 — residue pooling, transport and recovery

- **Scope:** stockpile locations, one inventory movement journal with balance-key guards and deferred transfer/transformation constraints, Dora-to-facility residue sales, itemized residue consignments, transport legs, dispatch/receipt and discrepancies, recovery facility inventory, recovery events and outputs with input genealogy.
- **Status:** the Phase 3 backend slice is implemented and verified above; the broader Stage 3 deliverable remains partial because field capture/UI, deployment, pilot validation and operating procedures are not implemented.
- **Dependencies:** Stage 2; pilot agreement on residue ownership/service consideration, stockpile practice, dispatch/receipt evidence, facility inventory and recovery inputs/outputs; PostgreSQL transaction/locking proof from Stage 1.
- **Deliverables:** traceable residue route from Dora output through pooled inventory, truck consignment and recovery output.
- **Acceptance criteria:** a consignment can contain several residue batches; stockpile OUT + transit IN and transit OUT + facility IN are atomic paired postings; concurrent commands cannot overdraw inventory; transformations link consumed and created batches; manifests do not add a second balance; the residue sale is separate from shipment, custody and payment; a recovery event can consume multiple consignments; counts reconcile through explicit adjustments without inferring fraud; no exact source-miner recovery quantity is displayed without an approved allocation method.
- **Automated tests:** property tests for movement/balance invariants, no-double-count transfer and split/merge genealogy; concurrent transfer tests; integration tests for multiple batch/consignment inputs; authorization tests across facility boundaries; failure tests for incomplete receipt, discrepancy and adjustment.
- **Known risks:** physical mixing may make lineage evidential rather than exact; mass balance may be affected by process, moisture, sampling or measurement differences.

## Stage 4 — gold purchases, merchant aggregation, assay, payment and custody

- **Status:** the gold-trade backend slice is implemented and verified above. Stage 4 remains partial; planned aggregation workflows, broader scenario coverage, UI, participant validation and operations are not complete.
- **Scope:** miner-to-local merchant purchases, local merchant aggregation/resale, facility-to-larger merchant trade, assay records, proposed/accepted trade quantities, seller/buyer measurement observations, shared gold/residue payment histories, partial settlement, offered/accepted custody and corrections/disputes.
- **Dependencies:** Stages 2–3; participant agreement on weight/assay fields, price visibility, supported transaction currencies and money precision, payment states, who accepts custody and permitted aggregation allocation. No currency conversion is in scope without a separate approval and explicit conversion facts.
- **Deliverables:** both routes converge on larger merchants while source purchases remain linked and commercial visibility is scoped.
- **Acceptance criteria:** transaction quantity, accepted trade quantity, declared/measured weight and inventory deduction are distinct; original measures remain visible; both counterparties accept identical effective terms; a gold custody posting cites a current exact-quantity handover measurement; gold payment reports and decisions are append-only, bounded by the agreed obligation and reconciled by currency; custody and inventory remain separate. Residue-sale payment endpoints and the full aggregation lifecycle remain outstanding.
- **Automated tests:** integration scenarios for both value-chain routes and both payment parents; authorization tests for counterpart versus unrelated prices; concurrency tests preventing overselling/overpayment; idempotency tests for trade/payment/custody; correction/reversal and disagreement tests.
- **Known risks:** counterparties may disagree about price/assay or refuse detailed source disclosure; aggregation attribution may not be defensible.

## Stage 5 — offline command queue and synchronization

- **Scope:** IndexedDB command storage, service-worker app shell, sync status UI, idempotent upload/receipts, retries, dependency ordering, version conflicts, shared-device assisted capture, participant acknowledgement, paper transcription and offline-data lifecycle.
- **Dependencies:** stable Stage 1–4 API schemas; pilot device/browser/connectivity observation; offline authentication and local data policy.
- **Deliverables:** user-visible local/server/counterparty/ledger states and recoverable synchronization after app restart or interrupted upload.
- **Acceptance criteria:** offline-created commands survive restart; no-phone participants can be captured by an authorized recorder; participant, recorder, source, acknowledgement, occurrence time and entry time are distinct; later paper transcription is labelled; no recorder entry implies consent/approval; duplicate retries and conflicts behave as specified.
- **Automated tests:** browser storage/restart tests; network disconnect/reconnect tests; assisted/shared-device and paper-transcription tests; acknowledgement/dispute tests; idempotency and schema-version tests; conflict/ordering tests; local data clear/revocation tests.
- **Known risks:** browser storage eviction, shared devices, stale permissions, local clock drift, poor connectivity and OS background-task limits.

## Stage 6 — tamper-evidence prototype and conditional ledger pilot

- **Scope:** append-only per-aggregate audit streams, sorted row locking, deterministic event canonicalization, salted commitment utility, independent checkpoint creation/verification, outbox worker, failure handling and receipt display. A separate network pilot is conditional.
- **Dependencies:** Stage 1 audit envelope; selected event allowlist; approval of payload sharing, hash/key procedures, participant governance and independent verification criteria. Operational Fabric/Besu deployment needs explicit pilot approval.
- **Deliverables:** first a database-backed hash-linked prototype; only if approved, a test permissioned network with separately controlled organizations and a documented chaincode/endorsement policy.
- **Acceptance criteria:** concurrent same-stream appends form one ordered sequence; cross-stream transactions lock consistently; there is no global-order claim; a verifier validates through the latest independently held checkpoint and the UI states the uncheckpointed-tail limit; correction produces a new linked commitment; database acceptance and network commitment are visibly separate.
- **Automated tests:** concurrent writer/same-stream and cross-stream tests; canonicalization cross-language vectors; payload/stream tamper, deletion/reordering and checkpoint verification tests; demonstrate that uncheckpointed tail rewriting is not necessarily detected; outbox retry/idempotency tests; simulated network outage; privacy checks.
- **Known risks:** false confidence from hashes, metadata leakage, key loss, node concentration, network overhead and lack of a willing independent operator. Retain the signed-database alternative if consortium value is not demonstrated.

## Stage 7 — pilot hardening and evaluation

- **Scope:** selected-site deployment, user training, accessibility/language review, monitoring, backup/restore, security review, support and feedback; no automatic widening to all locations.
- **Dependencies:** preceding stages and explicit pilot participant agreement; hosting and support owners; reviewed data access/retention policy; if ledger is used, completed governance and outage exercises.
- **Deliverables:** bounded pilot release, support/runbook, measured feedback, defect and risk register, and recommendation to continue, change or stop.
- **Acceptance criteria:** participants complete agreed end-to-end scenarios in real connectivity conditions; data visibility matches approved matrix; data restore and offline reconciliation are demonstrated; disputed/incorrect records can be corrected without erasure; pilot owner reviews evidence before expansion.
- **Automated tests:** full critical-path end-to-end suite; regression/security/accessibility checks selected for the product; backup-restore verification; load and queue-recovery checks sized from observed pilot volumes.
- **Known risks:** onboarding burden, literacy/language fit, disputed practices, connectivity, physical evidence quality and operational cost may outweigh the traceability benefit.

## Suggested sequencing gates

- Validate domain terms and role visibility with a small set of participants before building workflow-specific rules.
- Complete a vertical path through each route before broadening reports or dashboards.
- Demonstrate offline sync and correction before collecting consequential production/trade records.
- Demonstrate independent verification and participant governance before calling the design a distributed blockchain system.
- Reassess scope, cost, data sensitivity and participant benefit at the end of each stage.
