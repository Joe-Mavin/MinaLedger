# MinaLedger fictional demo contract

**Status:** Stage 7A Milestones 0–6. Demo identities and workflow records described here are fictional design fixtures. Role-aware workspaces now include Registry, Access, Production/Allocation, Operations, Commerce, Traceability, Reports and Audit evidence, but the repository still lacks a complete fixture seeder and an end-to-end product UI for either value-chain route. Milestone 6 PostgreSQL integration passed **56/56** on the dedicated `minaledger_test` database. This document does not authorize live or production data entry.

## Safety boundary

- Run a demo only against a disposable, dedicated local database named with a `_demo` suffix. Keep it separate from the `_test` database and every shared or production database. The fixture instructions below use authenticated HTTP APIs; they do not insert business fixtures with SQL or bypass authorization.
- Keep bootstrap, admin and persona passwords in a local secret manager or process environment. Do not put secrets in this repository, the fixture notes, URLs, screenshots, or shell history. Persona accounts must use fictional `example.test` addresses and synthetic data only.
- Bootstrap one system administrator using the existing `npm run bootstrap-admin` procedure. Assign `SYSTEM_ADMIN` only to the person responsible for local demo administration. Do not grant it as a convenience role to field, merchant, processing, recovery or audit personas.
- Create users, organizations and role assignments through the existing authenticated `/api/v1/admin/...` endpoints. Create sites, holes, participants and Dora associations through their authenticated domain APIs. Respect role scopes and current server checks.
- For repeatable API provisioning, retain each successful response ID in a local, untracked fixture note and reuse the same UUID `Idempotency-Key` with the exact same request body when retrying that operation. A changed body requires a new reviewed operation and key; do not work around a collision by deleting audit or idempotency records.
- There is no application-level fixture deletion or reset API. Reset only by replacing the disposable demo database with its reviewed empty baseline, applying the existing migrations, and replaying the API provisioning sequence. Confirm the local `_demo` database identity before any database replacement. Never use a production backup or data export as the baseline.

## Fictional personas and grants

Names and organizations are illustrative. Each account has only the single grant listed unless a pilot administrator documents and approves an additional assignment.

| Persona | MinaLedger role | Required grant scope | Intended experience |
|---|---|---|---|
| Asha Wanjiru | `SYSTEM_ADMIN` | `GLOBAL / global` | Local account and organization setup only; no implied access to business records. |
| Peter Wekesa | `FIELD_OFFICER` | `PILOT / default` | Field capture and site coordination in the configured pilot. |
| Kendi Mwangi | `MINING_OPERATOR` | `SITE / Kifaru Ridge site ID` | Site-scoped operational capture. |
| Naliaka Wekesa | `MINER` | `HOLE / Main A hole ID` | Hole-scoped participant capture and acknowledgement. |
| Doreen Atieno | `DORA_OPERATOR` | `FACILITY / Mwangaza Dora ID` | Processing facility records for the assigned Dora. |
| Salim Otieno | `RECOVERY_FACILITY_OPERATOR` | `FACILITY / Jirani Recovery Works ID` | Recovery-side custody and recovery records. This grant cannot be provisioned from a clean database through current APIs; see backend gaps. |
| Wanjiku Muriuki | `LOCAL_MERCHANT` | `ORGANISATION / Mwangaza Local Gold Buyers party ID` | Local merchant participation and trade records. |
| Kamau Kiptoo | `LARGER_MERCHANT` | `ORGANISATION / Soko Mkuu Bullion Traders party ID` | Larger merchant participation and linked resale records. |
| Joyce Achieng | `AUDITOR` | `SITE / Kifaru Ridge site ID` | Read and checkpoint verification for streams authorized by the server. |

These grants correspond to the scope validation in `identity.service.mjs`. Organization-scoped users must have an active membership in that exact organization. A facility-scoped grant must point to an existing processing or recovery facility. A site or hole grant must point to the matching existing resource. A Dora association alone does not confer facility access. A user interface selection never creates or extends a server grant.

## Fictional organizations and places

- **Kifaru Ridge Artisanal Cooperative** — optional participant organization; it does not receive automatic entitlement or site access.
- **Kifaru Ridge Local Gold Buyers Ltd** — the local-merchant organization. Wanjiku is an active member.
- **Soko Mkuu Bullion Traders Ltd** — the larger-merchant organization. Kamau is an active member.
- **Kifaru Ridge Mine** — fictional site code `DEMO-KIFARU`, in an explicitly synthetic county/locality. `Main A` and `Main B` are separate holes so hole-scoped access can be demonstrated.
- **Mwangaza Dora One** and **Mwangaza Dora Two** — two independent fictional processing facilities associated with the site through the site Dora API. Only the assigned Dora role is a processing grant.
- **Jirani Recovery Works** — planned fictional recovery facility. The present API can write recovery inventory locations and recovery events for a facility ID, but it has no recovery-facility create or list endpoint. Do not invent a facility ID or write its row directly.

## Scenarios and expected evidence

### Route A — mine to merchant

1. Record a fictional production event against `Main A`, link the actual synthetic miner through a hole participant relationship, and retain capture provenance.
2. Keep measured output and beneficiary allocation as separate records. A measurement does not approve an allocation, and allocation does not establish custody.
3. Record the miner’s sale to Kifaru Ridge Local Gold Buyers. Link the accepted purchase line to its source batch. A later local-to-larger-merchant resale must retain the source purchase links.
4. Expected evidence: source production and measurement, a separately reviewed allocation where permitted, bilateral accepted trade terms, and source-linked resale. Payment and custody remain separate events. Do not display an exact miner attribution for pooled material unless the approved allocation evidence supports it.

### Route B — Dora residue to recovery

1. Record a distinct processing event at the selected Mwangaza Dora, with source production and output batches linked.
2. Add eligible residue inventory using the exact current `MEASURED` or `VERIFIED` output observation; a declared or superseded value is not inventory authority.
3. Record a residue sale separately from dispatch, receipt, custody and payment. Dispatch and receipt remain separately evidenced and corrections append linked records.
4. Pool eligible residue only through the existing inventory movement journal. Record consignments, custody decisions and transport/receipt evidence without replacing the source events.
5. When recovery facility provisioning is available, record a recovery event using accepted source receipts and preserve every contributing consignment and residue input. Keep recovered output aggregate unless a defensible approved attribution basis exists.
6. Expected evidence: linked processing inputs/outputs, exact qualifying inventory observations, accepted dispatch/receipt and custody evidence, and full recovery input genealogy. No recovery output is apportioned to individual miners by default.

These are expected domain outcomes, not a claim that a user can complete either scenario in the product UI. The client now provides role-scoped Overview, Field capture, Registry, Access administration, My command queue and Audit evidence destinations. Registry supports authorized site/hole/participant records; Access administration supports only the existing create/grant/revoke endpoints and does not provide full directories. There are no dedicated allocation-review, Dora, recovery, trade, payment, consignment or reporting pages, so Route A and Route B remain incomplete in the UI.

## API-only fixture setup sequence

Use a disposable `_demo` database, apply the reviewed migrations, and create the initial administrator with the existing bootstrap command. Keep all credentials outside Git. Use the following authenticated API sequence; do not write fixture rows directly:

1. Create the three named organizations with `POST /api/v1/admin/organisations` and one stable mutation UUID per organization.
2. Create Peter with `POST /api/v1/admin/users`; grant only `FIELD_OFFICER / PILOT / default` with `POST /api/v1/admin/users/{userId}/roles`.
3. Sign in as Peter and create Kifaru Ridge Mine through `POST /api/v1/sites`. Create the two holes through `POST /api/v1/sites/{siteId}/holes`.
4. Create the mining operator, miner, auditor and two merchant accounts through `/api/v1/admin/users`. For the merchant accounts, set `organisationPartyId` to the matching organization when creating the account so the API creates the required membership. Assign their single listed role with `/api/v1/admin/users/{userId}/roles` only after its scope resource exists.
5. Create synthetic site and hole participants through `POST /api/v1/sites/{siteId}/participants`, using the returned persona `personPartyId` values and the appropriate site or hole role. Do not treat participant association as a login grant or entitlement decision.
6. As a site-authorized field officer, create each Dora through `POST /api/v1/sites/{siteId}/doras`. Assign Doreen `DORA_OPERATOR / FACILITY / {Mwangaza Dora ID}` using the admin role endpoint.
7. A clean database cannot finish Salim’s recovery-facility role assignment or Route B setup through the current API. Stop at this gap; do not fabricate a recovery facility through SQL. An existing, independently provisioned facility ID may be used only in an approved isolated environment after confirming the facility exists and the recovery operator is assigned to that exact facility.

The current public API does not list all organizations or provide account/role cleanup, so retain the generated resource IDs in a private local note and use the same mutation UUID/body for retries. On reset, restore the disposable database baseline rather than deleting individual fixture records. Phase 1 audit and append-only constraints mean fixture history is not erasable through the product.

## Implemented, verified and outstanding

- **Implemented in Milestones 0–2:** responsive role-aware shell; site register/detail/edit, hole list/detail/create, participant register/create; account and organization create; supported role assignment and current-session grant revocation. The UI uses the existing authenticated APIs. Participant identity, category, site/hole relationship, validity, source and evidence remain separate. The participant query now returns relationship IDs/types/status and category/date details. No migration was added and migrations 001–011 are unchanged.
- **Role/scope behavior:** Registry is shown to Field Officer and Mining Operator grants with site-readable scopes and to site-scoped auditors. Global System Administrators see Access administration. Other roles do not receive a registry destination because current APIs do not provide a safe authorized discovery path for their hole, facility or organization scope. These UI rules do not grant access; server authorization remains authoritative.
- **Tested:** client lint, production build and app-shell verification, **3/3** unit tests, **16/16** Playwright tests, server lint and **55/55** PostgreSQL integration tests on a dedicated temporary `_test` database. The browser suite uses fictional API fixtures; PostgreSQL tests exercise actual backend services, authorization and database constraints. The screenshots and full verification record are in [the implementation plan](IMPLEMENTATION_PLAN.md).
- **Not implemented:** complete account/organization/membership/role directories; existing-grant ID discovery or revocation from the UI; participant relationship edit/revoke endpoints; system-administrator site/hole/facility resource discovery; a repeatable API fixture runner; recovery-facility provisioning; complete Route A or Route B UI journeys; transaction screens; deployment, field acceptance or real-data verification.
- **Recovery-facility decision:** no provisioning/list/detail route or migration was added. The nullable `recovery_facility.party_id` and shared `facility_party_role` table do not establish the intended organization ownership semantics. Resolve that domain and authorization contract before implementation; do not fabricate IDs or write direct fixture SQL.
