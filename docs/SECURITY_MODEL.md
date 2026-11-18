# Security and permissions model

## Design status

The role set is a proposal from the Phase 0 request. Final access rules require participant review and pilot threat modelling. This document does not assert a regulatory access mandate or verify permit/legal status.

## Identity and authorization model

- Represent a person or organisation once as a `party`. A user account authenticates a person; it is not a second copy of that person in the business model.
- Assign users one or more roles through effective-dated, revocable role assignments. Scope grants to a participant party, assigned site, hole, facility, or pilot project where possible. A user acting in several roles must choose the acting context for each command.
- Use role-based access control for the base action and resource/relationship checks for context. A valid role alone does not reveal every record. The backend evaluates the caller, acting party, relationship to the resource, record state and requested action on every query and command.
- Separate application identity from permissioned-network identity. If a ledger pilot proceeds, map eligible organisation identities and human signers through a controlled enrollment process. An application role does not automatically grant network endorsement rights.

## Proposed role permissions

| Role | Proposed access |
|---|---|
| System administrator | Manage accounts, configuration and role grants; view operational metadata needed for support. No automatic access to commercial payloads or personal evidence. Exceptional access is purpose-bound, time-limited and audited. |
| Field officer | Create/update records only for assigned sites or pilot scope; capture production, measurements, evidence and witness notes; make an assisted entry as recorder when authorized; initiate corrections for review. No broad merchant pricing/payment visibility and no automatic right to approve the participant's statement. |
| Mining operator | Manage assigned site/hole records and production events; propose allocations for relevant production; view material lineage and counterpart details needed for those events. Cannot claim legal ownership based solely on a role. |
| Miner | View own profile, attributed production/allocation and own relevant gold batches, assay/transaction facts, payments and custody requests; respond to transfers involving them. Cannot see other miners' commercial records. |
| Dora operator | Manage assigned processing facility, runs, input/output batches, service/residue settlement records, own stockpiles and consignments; see only customer details needed to record/verify work. |
| Recovery facility operator | Record facility intake, discrepancies, inventory movements, recovery events, output batches, assays and its own trade/custody facts. Source detail follows the access policy agreed with contributors. |
| Local merchant | Record own purchases, stock/aggregation, payment, assay, custody and resale. See counterpart and source information needed for the merchant's own transactions and approved genealogy. |
| Larger merchant | Record own incoming purchases, approved input genealogy, assays, payments and onward custody. Cannot see unrelated merchant prices or private miner identity details by default. |
| Auditor or authorised regulator | Read-only, purpose-bound access to specifically authorized records and evidence. Export, search and sensitive-field access are audited. Scope and identity evidence must be established by the pilot owner; no blanket access is assumed. |

Several people can perform one role, and one user can have multiple roles. Role names do not imply legal qualification, authority to certify a measurement, or ownership of material.

## Data visibility principles

- A participant sees records they created or are authorized to transact on, plus source/provenance fields explicitly shared for traceability.
- For assisted or paper-transcribed records, preserve the authenticated recorder and actual participant as separate identities. The participant can acknowledge, decline or dispute through the pilot-approved process; recorder entry alone is not consent, approval or proof of identity.
- Counterparties see the shared transaction facts needed to verify declared/measured weight, assay reference, agreed price, payment status and custody acceptance. Pilot policy must define which commercial fields are shared at each step.
- Keep unrelated prices, participant contact details, identity documents, exact coordinates and internal notes private. A QR scan resolves through an authorized API and must not expose raw data in the encoded token.
- Treat a permissioned ledger as shared infrastructure, not as a private database. Put only minimal commitments on-chain; use carefully scoped channels/private collections if a network is approved.
- Log sensitive reads, exports, role grants/revocations, rejected attempts and administrative access. Expose a useful history to affected participants where the pilot decides that is appropriate.

## Security controls to require in implementation

- Central server-side authorization on every API operation and query; deny by default; no frontend-only hiding as access control.
- Strong authentication and protected session/token handling; account recovery and multi-factor policy to be selected for user device/access realities during pilot design.
- Transport encryption, protected secrets, key rotation, environment separation and least-privilege service/database accounts.
- Input validation, file-type/size limits, safe evidence storage, output encoding and defenses against injection and cross-site request forgery where applicable.
- Append-only audit events, correction links, protected backups, restore exercises and database access monitoring.
- Audit both who the record concerns and who entered it; record source and acknowledgement events separately. Prevent a recorder from changing the actual-participant reference after submission without a linked correction and review.
- Scoped exports and redacted logs; never log credentials, private keys or full sensitive event payloads by default.
- Device-level screen lock and data minimization. Offline browser storage can be inspected or evicted; it must not be described as encrypted/secure unless the selected platform mechanism is implemented and verified.
- For a ledger network: protected signing keys, certificate issuance/revocation, separated administration, documented member onboarding, policy changes and recovery procedures.

## Threats and mitigations

| Threat | Proposed mitigation | Remaining limit |
|---|---|---|
| Shared device exposes another user's data | Scoped download, logout cleanup, session lock, least-privilege local cache, actor context shown before capture. | A person with physical device access may still inspect local storage. Pilot device policy is open. |
| Recorder entry is mistaken for participant approval | Separate participant/recorder identities, explicit source and acknowledgement status, append later acknowledgements/disputes, show unacknowledged state in views. | Software cannot establish consent or truth from a recorder's assertion; acknowledgement methods and review roles are pilot decisions. |
| Duplicate offline retry records a second trade/transfer | Stable UUID mutation ID, payload hash and database uniqueness; same-key retry returns receipt. | Does not resolve two distinct users' conflicting valid claims. |
| Stale offline data overwrites current custody/inventory | Expected version checks, no last-write-wins, conflict review and append-only corrections. | Human reconciliation may be required. |
| Privileged operator alters database history | Append-only application controls, per-event hash links, anchored checkpoints/independent peers, protected audit access. | A centralized operator can rewrite unanchored data; hashes do not prove physical truth. |
| QR token guesses or leaks private data | High-entropy opaque token, revocation/rotation, authorization after lookup, minimal public response. | A copied QR can be shared; pilot must define label handling. |
| False measurement or collusive parties | Store method, instrument/evidence, actor, counterpart acceptance and correction/dispute trail; targeted independent verification. | Software cannot establish physical truth or prevent collusion. |
| Ledger participant sees metadata or correlates activity | Minimize on-chain fields, limit channel/collection membership, review signer/timing exposure, avoid public ledger. | Permissioned participants may still infer transaction relationships. |

## Unresolved security questions

Select authentication provider and recovery model; determine offline authorization duration; define acceptable identity evidence without turning the prototype into an unapproved identity registry; decide assisted-capture and paper-transcription roles/acknowledgement methods; define data retention, erasure and evidence access policy; set role approval and review ownership; decide if/when ledger keys are controlled by organizations or individuals; and define incident response for lost devices, compromised accounts and disputed signatures.
