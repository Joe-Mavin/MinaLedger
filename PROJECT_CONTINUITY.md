# MinaLedger Project Continuity

## Current verified state

Phases 1–6 are implemented as technical slices with backend PostgreSQL integration coverage and client tests. Stage 7 Part 1 adds a provider-neutral deployment and operations foundation. Stage 7A Milestones 0–1 add a documented fictional demo contract and a responsive role-aware workspace shell. No staging deployment, pilot, or real participant data is involved in this work. See [implementation status](docs/IMPLEMENTATION_PLAN.md) and the [operations runbook](docs/DEPLOYMENT_OPERATIONS.md).

The application includes scoped identity and authorization; site/hole participants and production capture; append-only measurements and allocation proposals; Dora processing; residue intake, inventory, consignment, custody, receipt and recovery; gold-trade terms, custody and payment reconciliation; PWA offline command synchronization; and database-backed audit checkpoints with a retryable outbox. Migrations 001–011 implement this domain state. Stage 7 Part 1 adds no migration and does not change business rules.

The Compose staging design has a production-built web client, Node API, private persistent PostgreSQL, the separate checkpoint worker, explicit one-shot migrations, and manual backup/restore services. The application role is a non-superuser; a separate database administrator role is used by the migration and maintenance commands. TLS terminates at the eventual hosting proxy. Production-mode database TLS remains required by default; plaintext is explicitly scoped to the isolated Compose database network.

Operational changes add process liveness (`/livez`), database readiness (`/readyz`, with `/healthz` retained), sanitized request URL logging, startup listen-error handling, timed graceful shutdown, explicit worker database startup checks, and configuration for proxy hops and login limits. The login default remains 10 attempts per 15 minutes. The client production build uses same-origin API requests unless an explicit API base is set.

## Verification status

Phase 6 verification on 2026-11-19: backend lint checked 30 ES modules; PostgreSQL integration was 55/55 passing with rollback/reapplication coverage for migrations 003–011; client lint passed; production build passed; unit tests were 3/3; Chromium browser tests were 2/2.

Stage 7 Part 1 verification on 2026-11-19: backend lint checked 31 ES modules; PostgreSQL integration passed 55/55; client lint and production build passed; unit tests passed 3/3; Chromium tests passed 2/2. The suite uses the isolated `minaledger_test` database, whose test harness resets the public schema. The Compose YAML parsed locally as seven services with no PostgreSQL host port. The backup script created a valid custom-format archive against the local `_test` database and `pg_restore --list` accepted it; the temporary archive was removed. A separate-database restore was not completed because Docker is unavailable and the local test role cannot create databases. Docker image builds, Compose startup/health, TLS proxy, and Compose maintenance services are not verified.

Stage 7A client verification on 2026-11-20: lint passed; TypeScript/Vite production build and app-shell check passed; unit tests were 3/3; Playwright Chromium was 14/14. Browser coverage includes all nine role navigation profiles, active-grant switching, authorized API data handling, synthetic fixture isolation/repeatability, responsive mobile layout, Capture/offline queue and audit checkpoint regressions. Backend code and migrations were unchanged, so backend lint and PostgreSQL tests were not rerun.

## Product demonstration and security limits

The client has a responsive role-aware shell with API-backed site references and a recorder-scoped local queue summary. It can sign in, select authorized context, capture production, add measurements, queue/synchronize supported commands, and inspect database checkpoint status. It does not provide one complete UI path for administration/provisioning, allocation review, Dora processing, stockpile and recovery operations, or merchant trade/payment reconciliation. Some of these operations are available only through APIs; allocation approval is deliberately absent. The fictional demo contract defines API setup and reset safeguards, but there is no automatic fixture seeder. Recovery facility creation/listing is a documented backend gap.

The PWA's IndexedDB is not encrypted. There is no password reset, account suspension UI, remote device wipe, or complete lost-device procedure. Server-side role revocation takes effect on authenticated requests, but short-lived tokens remain until expiry. Retention/privacy policy, participant acknowledgement and assisted-capture practice, shared-device behavior, hosting and support ownership, role review, checkpoint custody, external payment verification, and physical measurement/assay validation still require owner and participant decisions.

Audit checkpoints and the events they cover remain in one PostgreSQL trust boundary. No independent holder, external verifier, signature, blockchain network, payment provider integration, legal validation or regulatory compliance claim is made. Do not deploy real participant data or begin a pilot until the required governance, hosting, consent, access and support decisions are approved.

## Stage 7 Part 1 boundary

Implemented work is deployment configuration, operations and recovery documentation, and justified runtime hardening. It is not a deployment, a complete demonstration flow, a pilot, or Stage 7 completion. No paid cloud resource is selected or created. Container and host-specific verification must be run by an operator with Docker and the eventual TLS proxy before independent review.

The workspace contained a pre-existing edit to `server/.env.example`; it is intentionally left untouched and must remain outside the Stage 7 commit.

See [the implementation plan](docs/IMPLEMENTATION_PLAN.md), [acceptance criteria](docs/ACCEPTANCE_CRITERIA.md), [security model](docs/SECURITY_MODEL.md), [decision log](docs/DECISION_LOG.md), and [deployment operations](docs/DEPLOYMENT_OPERATIONS.md) for current scope and open decisions.
