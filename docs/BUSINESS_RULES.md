# Domain terminology and proposed business rules

## Status labels

- **Confirmed project requirements** are constraints from the project specification.
- **Field observations** are reported operating patterns and require local validation; they are not defaults to force on every pilot participant.
- **Proposed rules** are system behavior to review with participants before implementation.
- **Unresolved business questions** are listed in [Decision log](DECISION_LOG.md).

## Core distinctions

| Record | What it says | What it does not say |
|---|---|---|
| Production event | Material was reported as produced from a hole at a recorded time by an actor. | It does not determine beneficiary, title, sale, payment or custody by itself. |
| Production allocation | A beneficiary's proposed/reviewed share of one specific production output, with its basis, revision and review history. | It does not prove legal title, entitlement, physical possession, sale or payment. |
| Entitlement | A party is recorded as entitled to a batch/quantity under a stated basis. | It is not the same as who physically holds the batch. |
| Custody transfer | One party offers material to another; the recipient accepts, disputes or rejects. | An offer alone does not transfer accepted custody. |
| Declared quantity | A participant's stated amount, unit and time. | It is not a measured or verified amount. |
| Measured quantity | An observation associated with an actor, method/instrument if known, unit and time. | It is not automatically verified or an assay of purity. |
| Verified quantity | A measurement that met a pilot-defined verification procedure. | It does not establish ownership, assay, price or legal compliance. |
| Assay | A sample/result record with assayer, method, result units, time and evidence reference if available. | It is not interchangeable with gross weight or a universal guarantee of the entire batch. |
| Gold trade | A seller/buyer agreement with lines, agreed terms and status. | It does not imply full payment or custody acceptance. |
| Transaction quantity | The amount proposed on a commercial line revision, stored separately from measurement observations. | It is not necessarily the final accepted trade quantity or the amount physically moved. |
| Accepted trade quantity | The amount accepted by the counterparties for commercial settlement; null until accepted and changed only by a linked correction revision. | It does not prove that this amount was physically weighed or has left the seller's inventory. |
| Inventory quantity deducted | The physical quantity in accepted OUT postings from a location, supported by a measurement and linked to the relevant transfer/trade where applicable. | It is not automatically equal to a proposal, accepted trade quantity, payment, or ownership change. |
| Payment | A separate amount/currency/method/status fact, possibly partial or multiple. | A promised or pending payment is not a completed payment. |
| Material genealogy | Links inputs and outputs through production, processing, pooling and recovery. | It does not establish entitlement or transfer custody. |

## Parties, roles and operating locations

1. A person or organisation is represented once as a party, regardless of how many roles it holds. Users authenticate as people and receive one or more scoped roles.
2. A mining site may have multiple holes, with separately effective-dated site and hole relationships for landowner, permit holder, operator, miner or beneficiary as applicable. Recording a relationship is not validation of legal title or permit status.
3. A site can host multiple independent Dora facilities. The processing event identifies the facility selected for that run; no site-wide default Dora is assumed.
4. Recovery facilities, local merchants and larger merchants are separate participant types. A party may have multiple types/roles where the pilot supports it.
5. A cooperative or other group organization is optional. Individual participant records remain possible.

## Production, allocation and processing

- Production event is created against a mining hole and records who reported it, claimed occurrence time, server receipt time, event status and material outputs.
- One production event may create multiple output batches. Each output may have one allocation chain containing complete revisions; each row names exactly one beneficiary. One output can have allocations to multiple beneficiaries, and one beneficiary can receive allocations from multiple outputs.
- Each allocation-set revision uses one basis: `QUANTITY` or `SHARE`. Every row in the set has that same basis; mixed quantity/share rows are invalid. For `QUANTITY`, the proposer names the exact output measurement observation; the system never chooses by timestamp or assumes the latest is correct. A pilot-authorized reviewer explicitly authorizes that same observation in the approval event, with reason/evidence where needed. `DECLARED`, `MEASURED` and `VERIFIED` describe source/process, not truth; which kinds are eligible remains a pilot decision. Conflicting observations remain visible. A later correction or dispute does not retarget an approved allocation: dispute/withdraw it, clear the current pointer, then submit a complete corrected revision against a selected observation for fresh approval. A share set has no measurement basis. A correction is a new complete revision linked to its predecessor. Review states `PENDING`, `PROVISIONAL`, `DISPUTED`, `APPROVED`, `REJECTED` and `WITHDRAWN` remain distinguishable and append-only. A new set starts pending; provisional is explicitly non-final. Only one set per output chain can be current/approved; a correction is not current until reviewed and approved.
- Approval records the reviewed allocation basis only. It is not silently carried into ownership or payment records. Separate events express entitlement, custody, purchase or settlement.
- If the allocation uses a quantity, approved totals cannot exceed the exact output measurement explicitly authorized for that set. If it uses shares, approved shares cannot exceed 100%. Full allocation is not required unless the pilot decides otherwise. The reviewer role and evidence process, whether a set is reviewed as a whole or individual rows can be disputed separately, which observation kinds qualify, rounding, and the locally accepted allocation basis remain pilot decisions.
- Miners may select a Dora for processing where the local pilot confirms that workflow. The processing event records selected facility, input batch(es), measured/declared input and all identified output batch(es).
- If a Dora retains residue as service payment, record the residue output, service terms and entitlement/settlement basis separately. Do not imply all Dora operators do this, or treat retained material as a cash payment.
- A processing event may produce more than one output. If the event cannot account for outputs, record known inputs/outputs and a variance or pending measurement; do not fabricate balance.

## Material, measurement and inventory

- Material batches use stable opaque IDs, material categories, source events and workflow state. A batch does not store a competing declared or current quantity.
- `material_measurement` is the sole source of observed/declarative physical quantity. Every measurement set has one typed relational owner (event input/output, trade line, consignment item plus stage, or physical count) and one batch; database CHECK/composite-FK constraints reject missing, multiple or mismatched owners. Ownership cannot be reassigned after creation. Preserve who supplied the observation, who entered it, source unit/value, normalized amount, time, method/instrument and evidence where available.
- Proposed technical convention: store mass in canonical grams to `NUMERIC(20,6)` and retain entered value/unit plus a versioned conversion. Six decimal places are storage scale, not measurement accuracy. Accepted units, precision, rounding, moisture and weighing practices need pilot approval.
- Measurements are append-only observations. Corrections append a replacement/correction reference with reason; the original remains visible to authorized users.
- One `inventory_movement` journal is authoritative for all locations and custodian accounts. Stockpiles are locations, not a second movement ledger. Balances are derived per batch/location by summing accepted IN minus OUT postings in canonical grams; no separately editable balance is authoritative.
- A same-batch transfer has a paired source OUT and destination IN in one atomic movement. Dora stockpile to consignment transit is one transfer; transit to recovery inventory is a second. A consignment manifest identifies lots but does not add inventory. This prevents the same residue being counted in both source and destination.
- A custodian handover while material remains at the same physical site is represented as balanced postings between distinct location/custodian inventory accounts. Custody records who holds the material; this does not establish ownership or contractual entitlement.
- A consignment records itemized source lots, sender, receiving facility, transport/custody events and discrepancies. Dispatch transfers the accepted amount into the transit location; receipt transfers accepted quantity from transit to facility. Any short/excess amount remains in transit or is handled by a reasoned adjustment/reconciliation. Dispatch does not imply receipt.
- Before accepting any movement, the database transaction locks guard rows for affected batch/location pairs in stable order, checks the derived post-movement balances are nonnegative, validates transfer legs and commits the header, all lines, status and audit entries atomically. Database FKs/CHECKs and deferred transaction-level constraints enforce shape; frontend checks are insufficient. Concurrent writers use the same guard protocol, so they cannot both spend the same available stock.
- Processing transformations link OUT lines to consumed event inputs and IN lines to produced event outputs. Their mass totals need not match because of loss, sampling or process variance; record the reason rather than forcing equality.
- Physical counts compare against derived balances. A difference is recorded as a new authorized adjustment with reason and evidence; no balance is overwritten. Reconciliation exposes a discrepancy for review and does not automatically label it fraud or theft.
- Accepted movement corrections use linked reversal or adjustment postings; accepted movement history is never rewritten. Drafts may be rejected/voided before acceptance. Opening balances require explicit authorization and evidence.
- A Dora-to-recovery-facility residue sale is recorded as a commercial fact linked to its residue batch lines and, where applicable, a consignment. Do not infer the sale from shipment, receipt, custody or payment alone. A sale's currency is immutable from creation under a PostgreSQL update trigger and column permissions; a correction creates a successor sale with a reason. Payment currency composite FKs remain in force.
- A recovery event can use multiple consignment inputs and create one or multiple outputs. Preserve input links even when weights are pooled. Do not allocate recovered gold to individual miners without a defensible, approved method.

## Trades, assay, price, payment and custody

- Gold and residue sale lines carry a `transaction_quantity_g` on each proposal/revision. This is the quantity proposed for the deal, in canonical grams; it is a contract claim, not a scale reading.
- `accepted_trade_quantity_g` is recorded only after both seller and buyer accept the same line revision through authorized actors. It may equal the transaction quantity or be a negotiated resolution. A revised agreement is a new row linked to the previous revision and requires fresh acceptance; never overwrite the proposal or its accepted quantity.
- Seller-declared weight and buyer-measured weight are separate `material_measurement` observations in the line's measurement set. The measurement source role identifies seller/buyer; conflicting values remain visible. The accepted trade quantity does not change or erase either observation.
- Proposed mass convention is canonical grams stored to six decimal places (`NUMERIC(20,6)`), with original entered value/unit retained and versioned conversion. This scale is storage capacity, not claimed instrument accuracy. Pilot participants must approve permitted units and resolution.
- Inventory quantity deducted is read from accepted OUT inventory-movement postings. For both `gold_trade_line` and `residue_sale_line`, only an accepted physical OUT transfer may reference the current accepted line revision, and its paired IN has no commercial reference. A database deferred check caps cumulative net unreversed OUT across a line's correction chain at the current accepted quantity; parent/line locks serialize that check with concurrent acceptance and movement. A reduced corrected quantity requires compensating reversals before it can be accepted. Partial shipments are allowed within the cap and are separate physical events. Never deduct inventory merely because a trade or payment was recorded. Commercial acceptance, physical movement, payment and custody remain independent facts.
- Assays link to a sample and batch/trade line, with result, method, assayer, time and evidence. The pilot decides whether an assay is accepted for a given transaction.
- Prices and settlement terms are commercial data and access is limited to authorized participants. The same transaction graph can show a local merchant buying from multiple miners and reselling an aggregation batch to a larger merchant.
- A common payment API and data model supports both gold trades and residue sales. Each parent transaction has one immutable currency; PostgreSQL triggers/permissions reject changing it after creation, and a correction uses a successor transaction. A payment must match the parent and each payment event must match its payment; composite database FKs enforce those matches. Currency is not assumed to be KES; conversion is not in the initial MVP. Partial settlements use multiple payment records/events.
- Payment events are append-only: a reported payment is a claim; confirmation records confirmed value; failure, reversal or correction appends a linked event with actor, time, reason and evidence. Corrections do not edit the original amount/status. Net confirmed settlement is a derived projection per currency; do not convert currencies without an approved exchange-rate record.
- Reconciliation compares net confirmed amounts with accepted transaction amounts in the parent transaction's currency. It does not net different currencies. If currency conversion is approved later, preserve original amount/currency and record converted amount, target currency, rate and conversion timestamp as a separate fact. The trade/sale, payment, inventory movement and custody acceptance remain separate; payment is not proof of material handover.
- Custody transfer is offered by a sender and separately accepted/disputed/rejected by an authorized recipient. For commercial events, record trade agreement, payment and custody independently even when participants complete them together in practice.

## Merchant aggregation and recovery attribution

- Aggregation creates a new batch/event with multiple input links. Do not replace source purchase or consignment records with a single combined origin.
- Querying an aggregate must reveal source lineage only to users authorized for those sources and only at the agreed detail level.
- If pooled output needs to be apportioned, the pilot must specify the allocation basis (for example, measured contribution, assay-adjusted contribution, or an agreed provisional estimate), inputs, formula, rounding, responsible parties, version and approval. These are examples for discussion, not selected practices.
- If no defensible method is agreed, display aggregate output and contributing input batches without claiming individual source quantities.

## Corrections, synchronization and QR

- Accepted business events are not hard-deleted. Corrections, reversals, disputes and voids are new records linked to the affected event and include actor, time, reason and approval context.
- Assisted capture is allowed only for a recorder authorized in the relevant scope. The record distinguishes the actual participant from the user who entered it, records the information source, acknowledgement state, claimed occurrence time and actual entry time, and links supporting evidence. A recorder's entry does not mean the participant consented to data collection or approved the facts.
- A participant without a personal smartphone may review/acknowledge through a pilot-approved method, or leave acknowledgement pending/not obtained. Declined, disputed, unavailable and paper-transcribed records remain labelled as such and require the applicable review; they are not silently promoted to approved facts.
- Paper-originated records may be entered later if the pilot accepts that process. Preserve the paper reference or image when available, claimed event time, transcription time, transcriber identity and any later acknowledgement as separate facts. Do not backdate the entry time or treat a paper record as a digital signature.
- Offline commands have unique client mutation IDs and preserve source timestamps. Server receipt, acceptance, counterpart acceptance and ledger commitment are separately displayed.
- A QR token resolves to an opaque record ID through an authorized lookup. It contains no personal data or sensitive commercial values and can be revoked/rotated if a label is exposed.
- Local variants should be represented through explicit configuration or optional fields where practical; do not hard-code a single location's informal practice as a universal rule.
