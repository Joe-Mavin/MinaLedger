# MinaLedger Project Continuity

## Current verified state

Backend implementation through the Phase 4 gold-trade slice is present in the repository. Phase 4 was added on top of the Phase 1-3 baseline at `495eb932e3e4dedbc7dd7396c139554741cd28e2`; historical migrations 001-007 were not modified.

Phase 4 provides gold-trade proposal and read/reconciliation APIs, bilateral term decisions and revisions, append-only weight and assay records, measured custody offers and decisions, atomic inventory journal posting for accepted handovers, and gold-trade payment reports/decisions. It uses the existing Express authentication middleware, live PostgreSQL account/role checks, party-level resource authorization, idempotency and audit streams. Custody remains independent from agreement, entitlement and settlement. Payment reports are claims and do not establish external financial verification.

Additive migrations `server/src/database/migrations/006_phase_four_gold_trades.sql`, `007_phase_four_integrity_corrections.sql` and `008_phase_four_observation_integrity.sql` and their rollback scripts are in place. Migration 007 adds current-line uniqueness/projection, exact assay-to-batch and assay-to-line linkage, and database-side assay and gold-measurement attribution checks. Migration 008 rejects assay and trade-measurement inserts for closed trades or superseded lines, taking trade then line row locks. Historical migrations 001-007 remain unchanged. The full integration suite applies from an empty schema and covers rollback/reapplication of migrations 003-008.

Verified on 2026-11-19 against the dedicated PostgreSQL `_test` database:

- `npm run lint`: passed; 24 ES modules checked.
- `npm test`: 50 tests, 50 passed, 0 failed.
- Phase 3 regression coverage: 31 nested scenarios, all passing.
- Phase 4 corrections cover represented-party assay submission, revoked membership, all six measurement source roles, batch A/B assay mismatches across initial/add/revision paths, append-only assay corrections, duplicate/current line checks, idempotent replay, concurrent duplicate additions, and observation writes racing with closure and revision. Both API revalidation and direct database insert guards were verified; failed writes leave no observations.

Phase 4 technical rule: each trade proposal has at most one current line per batch; a correction is a linked successor that retains historical rows. A recorded assay identifies its trade-line context and batch, while its submission status remains `RECORDED`; no laboratory certification or independent verification is asserted. Measurement and assay attribution checks use active party representation and effective organization membership/role assignment at the claimed observation time.

Observation integrity uses a parent-first lock order (`gold_trade`, then `gold_trade_line`) for measurement, assay, revision and decision commands. Application checks re-read status/currentness and live actor authorization inside the write transaction; migration 008 enforces closed/current-line state again in PostgreSQL. The tests establish implemented database/API behavior, not field validation or deployment.

## Phase 5 verified state (2026-11-19)

Phase 5 adds a React/TypeScript/Vite field PWA and an allowlisted offline synchronization boundary. The client stores versioned immutable command envelopes and scoped references in IndexedDB, caches only its app shell through a service worker, and displays local, uploading, receipt, review, accepted, conflict and rejected states. It does not cache operational API responses.

The three supported sync commands are production creation, production measurement addition and capture acknowledgement. The Express routes remain behind the existing authentication middleware. Sync rechecks live accounts, roles, acting context and site/hole authorization, then dispatches through existing production domain services. Migration `009_offline_sync.sql` adds durable immutable receipts/history and uniqueness/transition constraints; the rollback is `server/src/database/rollback/009_offline_sync.sql`. Historical migrations 001–008 remain unchanged. Receipt recovery, idempotency, version conflicts, dependency handling, paper provenance, separate participant acknowledgement/dispute, role revocation and cross-site denial are covered by integration tests.

Verified on 2026-11-19 using the dedicated PostgreSQL `_test` database:

- Backend `npm run lint`: passed; 27 ES modules checked.
- Backend `npm test`: 51 tests, 51 passed, 0 failed; migration 009 rollback/reapplication and the Phase 1–4 regression suite passed.
- Client `npm run lint`: passed.
- Client `npm run build`: passed (TypeScript check and Vite production build).
- Client `npm run test:unit`: 2 passed, 0 failed.
- Client `npm run test:e2e`: 1 Chromium test passed, 0 failed; includes offline reload, API non-caching and unknown-outcome receipt recovery.

This is automated local verification only. The PWA has no configured production HTTPS hosting, has not been field-tested, does not encrypt IndexedDB, and relies on foreground/online sync opportunities rather than guaranteed background execution. Offline tokens remain in tab-scoped session storage under the current short expiry policy; upload authorization is always checked again by the server. Phase 6 has not started.

## Remaining scope and decisions

- The Phase 4 integration trade exercises recovered gold. Direct miner purchases and merchant-to-merchant aggregation/resale need broader scenario validation; a gold aggregation transformation is not implemented.
- Payment routes currently cover gold trades only. Residue-sale settlement endpoints, currency conversion, banks/mobile-money/payment-provider integrations and independent payment verification are not implemented.
- Production hosting/operations, field validation, production blockchain and per-miner recovered-gold allocation are not implemented. Phase 5 local software verification does not resolve pilot decisions about acknowledgement methods, paper handling, offline session duration, device-loss response, evidence retention or shared-device policy.
- Pilot participants still need to validate custody signers and evidence, measurement methods and accepted units, assay acceptance, price visibility, supported currencies, payment proof and dispute/adjustment authority. Current technical constraints do not settle those business policies.
- Phase 5 is complete as an automated-test-verified technical slice. Do not begin Phase 6 without separate authorization.

See [implementation milestones](docs/IMPLEMENTATION_PLAN.md), [acceptance criteria](docs/ACCEPTANCE_CRITERIA.md), [business rules](docs/BUSINESS_RULES.md), [database schema](docs/DATABASE_SCHEMA.md) and [decision log](docs/DECISION_LOG.md) for details.
