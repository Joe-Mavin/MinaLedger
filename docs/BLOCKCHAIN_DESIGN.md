# Blockchain and tamper-evidence design

## Status

**Proposed technical decision:** keep business data in PostgreSQL and make ledger integration an asynchronous, replaceable adapter. Hyperledger Fabric is the leading permissioned-network candidate for a governed pilot. This is not a decision to deploy a blockchain. Phase 0 defines a hash-linked audit prototype separately from an operational distributed ledger.

**Pilot assumption:** independent participants have a reason and capacity to host or independently verify ledger state, and can agree who governs membership, endorsement, upgrades and disputes. If that is false, use the database audit log with signed exports and independent checkpoints; do not claim distributed trust.

## Keep the use case narrow

A ledger is useful only for selected cross-organisation facts for which participants need shared ordering and independent validation. It is not needed for every profile edit, inventory query, offline draft, payment note or internal correction. It cannot prove that a weight, assay or handover description was physically truthful. Measurement evidence, counterpart acknowledgement and governance are still required.

## PostgreSQL versus ledger

### PostgreSQL stores

Operational domain records and relational history; names and contact details; site and hole details; measurements and capture provenance (actual participant, recorder, source and acknowledgement state); assay results and attachments; prices and payment history; participant role assignments; access scopes; detailed event payloads; idempotency receipts; per-aggregate audit streams; outbox; ledger submission status and receipts. Database access is authorized by application policy and database controls.

Before an audit event is committed or queued for ledger anchoring, PostgreSQL validates the domain command: the explicitly selected and authorized allocation measurement basis and totals, typed measurement ownership, immutable gold-trade/residue-sale currency plus payment currency equality, valid movement reference combinations, nonnegative inventory balance and the cumulative net OUT cap for both gold-trade and residue-sale line revision chains. Deferred constraints/triggers and row locks enforce these database invariants; audit stream-head locks order audit entries only and do not protect domain quantities by themselves. Domain rows, audit entries and outbox item commit together after successful validation. Any external ledger submission is asynchronous and cannot make an invalid database movement valid; a ledger commitment does not prove the underlying facts are true.

### Permissioned ledger may store

- An opaque, random event reference and allowlisted event type/schema version.
- A salted commitment to an accepted canonical event payload.
- A previous commitment or agreed lineage reference for the selected sequence.
- Signatures/endorsements required by a network policy for selected cross-party events.
- The ledger's transaction identifier and committed receipt/status.

Do not write participant names, direct identifiers, precise site coordinates, weights, prices, payment details, raw assay data, documents, or free-text notes to a public ledger. Permissioned channels and private-data features reduce distribution but do not make careless data placement safe. Ledger membership, retention, metadata visibility and key management remain security concerns.

## Hashes and event linking

1. On server acceptance, build an allowlisted event envelope with a schema version, random event ID, event kind, claimed occurrence/server receipt timestamps, relevant opaque references, capture/acknowledgement state and accepted correction/supersession reference. Do not describe an assisted or paper transcription as participant-approved unless the corresponding acknowledgement/approval exists.
2. Serialize with a fixed, versioned canonicalization rule (proposed: JSON Canonicalization Scheme) so independent implementations hash identical bytes. Encode decimal quantities and money as normalized decimal strings, not JSON floating-point numbers, to preserve PostgreSQL `NUMERIC` precision. Exclude mutable presentation fields and data that is not needed for the commitment.
3. Generate a cryptographically random 256-bit salt. Proposed formula: `payload_commitment = SHA-256("MinaLedger:event:v1\0" || JCS(event_envelope) || salt)`. Store payload, salt, hash algorithm and schema version under restricted access; submit only the commitment and minimum opaque metadata.
4. Link the commitment into the ordered audit stream(s) for every affected aggregate, as described below. Preserve business event IDs, measurement source, participant/recorder provenance and event revisions in PostgreSQL. Sequence and commitment linking is tamper-evidence, not a truth oracle.
5. Do not confuse the application commitment with a network transaction hash. The ledger client returns a network-specific transaction ID/receipt; save it alongside the application commitment, network ID, submission time and finality state.

Salting prevents straightforward guessing of low-entropy fields from a published hash. Never reuse salts. If a verifier is entitled to validate the commitment, provide the exact canonical payload and salt through an authenticated channel. A hash alone proves neither the contents to an observer nor their truth.

## Audit order, concurrency and idempotency

**Proposed decision: per-aggregate streams.** There is no global audit sequence and no single database-wide event order. Each event has one immutable payload commitment and can have one `audit_stream_entry` in each affected aggregate stream (such as a batch, trade, consignment, event or payment). Stream key, sequence, previous hash and entry hash are recorded separately. Timestamps are evidence of claimed/recorded times; they are not a total order across streams or offline devices.

For one command, first claim the actor-scoped idempotency key. Acquire domain revision/settlement locks (including the gold-trade or residue-sale parent/line-chain lock used by the commercial OUT cap), then affected inventory `(location_id,batch_id)` guard rows, then audit stream heads. Sort keys within each lock class and use this same class order for every command. Insert missing guard/head rows with conflict-safe inserts before locking them with `SELECT ... FOR UPDATE`. The inventory guard serializes balance checks; the audit head serializes event sequence only. In the same PostgreSQL transaction as the domain change and idempotency receipt, each stream gets `last_sequence + 1` and `entry_hash = SHA-256("MinaLedger:stream:v1\0" || JCS({stream_kind, stream_id, sequence, previous_hash, payload_commitment}))`; the first entry uses a 32-byte zero hash. Insert stream entries and advance heads. Unique `(stream_kind, stream_id, sequence)` constraints and transaction retry handle concurrent first-row creation. Deferred database constraint triggers validate movement reference shape, commercial line caps, and resulting nonnegative inventory balance before commit. Different streams can proceed concurrently; commands sharing a stream serialize. Cross-aggregate commands lock all affected streams in the same sorted order. This design provides a verifiable sequence per aggregate, not a global order or a guarantee against a database administrator.

The API claims the unique actor-scoped idempotency key and request hash at the start of the same database transaction as the command. A concurrent duplicate waits on the unique key; after commit it returns the saved response if the hash matches, and rejects a changed payload. A rollback leaves no command effects or receipt. Different keys racing on the same inventory/allocation/trade aggregate use record versions and domain locks; inventory writers additionally lock every affected batch/location guard row in stable order and validate the journal-derived balance. Stale commands return a conflict instead of replacing accepted facts. Hash-stream locks and inventory balance locks protect different invariants.

### Independent checkpoints and verifier limits

At a pilot-agreed interval, create a signed manifest of stream key, last sequence, head hash, checkpoint time and signer. Copy it to a separately administered append-only store or anchor its digest with an independently operated network. Keep key validity/rotation information and the receipt.

A verifier recomputes the event commitment from the permitted payload and salt, replays per-aggregate entries, checks sequence continuity and previous hashes, then compares the resulting tip with a checkpoint obtained independently. Altering, deleting or reordering events at or before that checkpoint changes the verified chain/tip. An uncheckpointed tail can be rewritten by the database operator without an independently held later receipt; do not claim detection beyond the latest trusted checkpoint. A checkpoint also cannot establish that the physical weight, assay or participant statement was true.

## Corrections and disputes

Accepted events are immutable in the audit model. A correction is a new event that references the event it supersedes, carries a reason, actor, time and corrected values, and receives a new commitment. Preserve the original and mark its current validity/status in a derived view. A disputed custody handover remains a disputed event until resolved; do not rewrite the previous holder. A later correction cannot remove a previous ledger commitment. Any legally required personal-data handling, retention, or redaction process is an unresolved policy question; avoid putting personal data on-chain so that normal correction/redaction does not require changing ledger history.

## Custody validation

- A sender creates an offered transfer for a batch or consignment and recipient. Quantity evidence is referenced through immutable measurement records and linked inventory movement postings; custody does not introduce a competing quantity field.
- The recipient explicitly accepts, disputes or rejects it using an authenticated account authorised for that party and context. The offer and response are separate signed facts.
- Store both signatures/identity references and their verified organization context. The backend checks authority, open transfer state, scope and expected record version. The transaction commits to the audit/outbox atomically only after the defined acceptance threshold is satisfied.
- For selected network events, a chaincode endorsement policy can require approvals from the relevant organizations. Network-level endorsement supplements application authorization and counterparty acknowledgement; it does not replace them.
- Field officer observation can be recorded as evidence but is not automatically a substitute for either party's acceptance.

## Permissioned network governance

Represent network members as participating organisations (for example, willing mining/operator groupings, Dora businesses, recovery facilities, merchants or an agreed independent host). Do not assume a regulator, government department or cooperative will operate a node. Before production use, participants must agree:

- Eligibility, onboarding evidence, identity issuance, key custody, revocation and emergency recovery.
- Which organisations run peers/orderers/validators and how infrastructure costs and outages are handled.
- Channel or private-data membership and which event types each party can read, write or endorse.
- Endorsement requirements for site records, transfers, recovery outputs, merchant transactions and corrections.
- Chaincode review, upgrade approval, incident handling, dispute escalation, retention, exit and network shutdown.
- How a party with limited devices/connectivity can participate without delegating away meaningful control.

These rules are to be negotiated with the pilot. Role labels in the application do not automatically create network membership.

## Technology options

| Option | Strengths for this project | Costs and limitations | Phase 0 view |
|---|---|---|---|
| **Hyperledger Fabric** | Permissioned organization identities, channels and private-data collections support selective visibility; chaincode endorsement policies can require selected organizations to approve transactions. Fabric orders and validates transactions in stages and provides committed block receipts. | Requires operating peers and an ordering service, certificate/key lifecycle, channel/collection design, chaincode lifecycle and consortium governance. Private data is still replicated to the authorized collection members. | **Leading pilot candidate** if participants need shared event ordering and selective multiorganization endorsement. Begin with one channel and a small allowlisted event model only after a privacy/governance design. |
| **Hyperledger Besu with QBFT** | Ethereum-compatible execution and tooling; QBFT is designed for private networks and requires a supermajority of validators to sign blocks. Could suit a team that needs EVM contracts and has validator operators. | Validator membership and contract-level data privacy need careful design; application-level permissions still required. Besu documents that the network stalls if more than one third of validators stop participating. | Realistic alternative where EVM compatibility is a primary requirement; not preferred for this data-sharing problem without a separate privacy model. |
| **PostgreSQL append-only audit + signatures/checkpoints** | Lowest operational complexity; familiar relational queries, full data minimization and straightforward offline sync; independent signed exports/checkpoints can expose later alteration. | A single service/database operator remains the authority unless checkpoints are independently held and verified. No consensus among multiple organizations. | **Default prototype control.** Keep this if a pilot has no credible independent network governance or if ledger value is not demonstrated. |

Fabric's official documentation describes private-data collections, organization policies and transaction ordering; Besu's QBFT documentation describes supermajority signing and the one-third outage limit. These are capability descriptions, not a security certification or an operational recommendation for a specific deployment: [Fabric private data](https://hyperledger-fabric.readthedocs.io/en/latest/private-data/private-data.html), [Fabric endorsement policies](https://hyperledger-fabric.readthedocs.io/en/latest/endorsement-policies.html), [Fabric transaction ordering](https://hyperledger-fabric.readthedocs.io/en/latest/orderer/ordering_service.html), [Besu QBFT](https://docs.besu-eth.org/private-networks/how-to/configure/consensus/qbft).

## Independent verification

An authorized verifier receives the event payload and salt through a controlled channel, recomputes the versioned commitment, verifies participant signatures and identity validity for the relevant time, and compares the commitment and transaction receipt against an independently operated peer or trusted checkpoint. The verifier follows correction and material-lineage links and confirms the ledger status is committed. A verifier without ledger membership or a trusted receipt cannot independently establish network inclusion. A ledger receipt does not establish the physical truth of the recorded event.

## Delivery stages

1. **Phase 0:** document concepts and open governance questions; no ledger or application implemented. The allocation, measurement, payment-currency and inventory controls in the schema remain proposed designs, not deployed controls.
2. **Prototype audit:** append-only PostgreSQL events and per-aggregate streams, transaction locking/idempotency, versioned canonicalization and test vectors, salted commitments, independently held checkpoints, correction handling, outbox states and verification utility. No claim of a distributed network.
3. **Network pilot (conditional):** provision a permissioned test network with separately administered organizations, agreed policies and read/verification process; submit only selected commitments; test node outage, member revocation, retries, privacy and recovery.
4. **Operational decision:** compare participant value and total ownership cost against the signed-audit baseline before committing to network operations.

## Sources for the proposed design

- [JSON Canonicalization Scheme, RFC 8785](https://www.rfc-editor.org/rfc/rfc8785)
- [NIST Secure Hash Standard, FIPS 180-4](https://csrc.nist.gov/pubs/fips/180-4/upd1/final)
- [Hyperledger Fabric security model](https://hyperledger-fabric.readthedocs.io/en/latest/security_model.html)
