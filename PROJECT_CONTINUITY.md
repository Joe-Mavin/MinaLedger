# MinaLedger Project Continuity

## Current verified state

Backend implementation through the Phase 4 gold-trade slice is present in the repository. Phase 4 was added on top of the Phase 1-3 baseline at `495eb932e3e4dedbc7dd7396c139554741cd28e2`; historical migrations 001-005 were not modified.

Phase 4 provides gold-trade proposal and read/reconciliation APIs, bilateral term decisions and revisions, append-only weight and assay records, measured custody offers and decisions, atomic inventory journal posting for accepted handovers, and gold-trade payment reports/decisions. It uses the existing Express authentication middleware, live PostgreSQL account/role checks, party-level resource authorization, idempotency and audit streams. Custody remains independent from agreement, entitlement and settlement. Payment reports are claims and do not establish external financial verification.

Additive migration `server/src/database/migrations/006_phase_four_gold_trades.sql` and guarded rollback `server/src/database/rollback/006_phase_four_gold_trades.sql` are in place. The full integration suite applies from an empty schema and covers rollback/reapplication of migrations 003-006.

Verified on 2026-11-19 against the dedicated PostgreSQL `_test` database:

- `npm run lint`: passed; 24 ES modules checked.
- `npm test`: 48 tests, 48 passed, 0 failed.
- Phase 3 regression coverage: 31 nested scenarios, all passing.

## Remaining scope and decisions

- The Phase 4 integration trade exercises recovered gold. Direct miner purchases and merchant-to-merchant aggregation/resale need broader scenario validation; a gold aggregation transformation is not implemented.
- Payment routes currently cover gold trades only. Residue-sale settlement endpoints, currency conversion, banks/mobile-money/payment-provider integrations and independent payment verification are not implemented.
- Frontend/PWA, offline synchronization, deployment/operations, production blockchain and per-miner recovered-gold allocation are not implemented.
- Pilot participants still need to validate custody signers and evidence, measurement methods and accepted units, assay acceptance, price visibility, supported currencies, payment proof and dispute/adjustment authority. Current technical constraints do not settle those business policies.
- Do not begin Phase 5 until separately authorized.

See [implementation milestones](docs/IMPLEMENTATION_PLAN.md), [acceptance criteria](docs/ACCEPTANCE_CRITERIA.md), [business rules](docs/BUSINESS_RULES.md), [database schema](docs/DATABASE_SCHEMA.md) and [decision log](docs/DECISION_LOG.md) for details.
