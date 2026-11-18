# Project charter

## Status and labels

This is a Phase 0 design document. **Proposed technical decisions** and **Assumptions requiring pilot validation** are not implementation commitments. The project owner must approve the specification before Phase 1.

## Problem statement

Gold moves through a chain of small and independent operators. Production, processing, residue recovery, trading, payment, assay and custody can involve different people and organisations. A record that treats those as one transaction cannot explain who produced or processed a material, who is entitled to it, what quantity was declared or measured, or who currently holds it. Intermittent connectivity also makes field capture difficult. MinaLedger proposes a shared, auditable record of those events and their material links.

## Objectives

1. Record gold production and allocations at mining-hole level.
2. Preserve traceable material links through Dora processing, residue pooling, transport, recovery and merchant aggregation.
3. Distinguish participant, entitlement, custody, measurement, assay, price and payment facts.
4. Support authorised users with multiple roles and visibility scoped to their participation.
5. Capture field events offline, synchronise them idempotently, and show clearly when server and ledger acceptance have or have not occurred.
6. Allow independent organisations to validate selected shared event commitments if a pilot establishes a workable governance model.

## Users and participants

- Miners and mining operators, including hole operators and site-level operators.
- Site landowners and permit holders, when they participate in the pilot's chosen recordkeeping model.
- Independent Dora operators and their workers.
- Residue aggregators, carriers and transport coordinators.
- Recovery facility operators and owners.
- Local merchants and larger merchants.
- Field officers, auditors and authorised regulators, subject to an agreed mandate and access scope.
- System administrators responsible for accounts and operations.

Users are login identities, not business entities. A person or organisation is represented once as a party and can be linked to multiple roles and organisations. Cooperative participation is optional.

## Confirmed project requirements

- The product is for Kenya's artisanal and small-scale **gold** supply chain at initial scope.
- It must represent both the miner-to-local-merchant route and the residue-to-recovery-facility route, which converge at larger merchants.
- Data capture must work offline and later synchronise.
- The proposed client/server/database stack and separation of concerns are specified in the parent request.
- Corrections must preserve history; declared, measured and verified quantities remain distinct.
- Sensitive commercial and personal information must not be placed directly on a public blockchain.

## Field observations (not universal rules)

- A site can contain multiple holes and independent hole operators.
- A site may have multiple independent Dora crushers, and miners may choose among them.
- Dora operators may retain residue as service payment and pool it across customers before resale.
- Recovery facilities receive residue in truck consignments, maintain inventory and record recovery.
- Miners may sell directly to local merchants; local merchants aggregate purchases and resell to larger merchants.
- Recovery facility owners may sell recovered gold directly to larger merchants.

These statements are design inputs to validate with participating locations, not assertions about every location or participant.

## Scope

### In scope for the prototype design

- Gold production and allocation records linked to site and hole.
- Material batch creation, processing inputs and outputs, residue stockpiles, pooled consignments, transport, recovery and recovered-gold batches.
- Gold purchases and sales with declared and measured weights, assay references, agreed price, payment records and custody transfer.
- QR-addressable records, audit history, user and organisation roles, offline capture, server synchronisation and a ledger-commitment boundary.
- English-first interface and configurable local terminology, to be validated during pilot discovery.

### Excluded from initial scope

- Gemstones, other minerals, or a claim of multi-mineral support.
- Regulatory determinations, permit validation, legal title adjudication, tax calculation, export clearance, environmental reporting, or compliance certification.
- Automated pricing, a public token, cryptocurrency payments, financial settlement rails, or a claim that a ledger proves the physical truth of a measurement.
- Operational deployment of a consortium blockchain in Phase 0.
- Automatic attribution of pooled recovery output to individual miners without an agreed, defensible allocation method.

## Expected Phase 0 outcome

An owner-reviewable project charter, domain and material-genealogy model, proposed relational schema and Mermaid ERD, system and API architecture diagram, blockchain and offline designs, access model, decision log, open pilot questions, implementation milestones and prototype acceptance criteria. Phase 0 itself produces documentation only.

## Expected prototype outcome after approval

A pilot-ready, gold-only application capable of recording and tracing the defined routes for a deliberately bounded pilot cohort, with offline capture and clear synchronization states. A distributed ledger may be trialled only after participant governance and independent-verification needs are agreed. Prototype scope, participant count, location, languages, devices and ledger participation remain unresolved.

## Unresolved business questions

See [Decision log](DECISION_LOG.md). Highest priority: pilot location and participants; operational definitions for production, allocations and residue ownership; measurement and assay conventions; accepted evidence for custody; settlement and correction practices; and who can see, endorse and govern shared records.
