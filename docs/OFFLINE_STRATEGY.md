# Offline, assisted and paper-based capture

## Status and operating rule

**Proposed technical decision:** use IndexedDB for locally saved command envelopes and a PWA service worker for the app shell and sync opportunities. PostgreSQL is authoritative after server receipt; participant acknowledgement, business approval and ledger inclusion are separate states. Offline capture is never labelled server-accepted or blockchain-committed before those respective confirmations.

## Personal phones are not a prerequisite

Participants without personal smartphones may use an authorized recorder's device or a paper-originated workflow if the pilot approves it. Do not require every miner or worker to own an account/device in order to be represented as a participant. An actual participant and the person entering the data are different identities.

### Assisted capture by an authorized recorder

1. The recorder signs in using their own account on the shared device and selects the assigned site/facility and capture context. A recorder's permissions are checked server-side and apply only to the assigned scope.
2. The form identifies the **actual participant** the record concerns and their role. If that person cannot be reliably identified, record an explicit `unknown/unresolved participant` state; never substitute the recorder as the participant.
3. Record separately: (a) actual participant/party, (b) authenticated person entering the record, (c) information source, and (d) participant acknowledgement status/method. Sources may include participant statement, witness statement, contemporaneous paper form or other evidence. A source statement is not automatically verified.
4. Preserve the claimed event occurrence time and its stated timezone/source, the recorder's actual entry time, and later server receipt time as separate timestamps. Do not backdate the entry timestamp to match a claimed occurrence time.
5. Attach or reference supporting evidence where available and permitted: paper reference/image, witness, instrument slip, or other pilot-approved record. Record the evidence source and who captured/transcribed it.
6. Show acknowledgement explicitly: `ACKNOWLEDGED` (with method and time), `PENDING`, `NOT_OBTAINED`, `DECLINED`, or `DISPUTED`. Acknowledgement means only the recorded acknowledgement action; it is not blanket consent to data collection, legal agreement, measurement verification, allocation approval, or custody acceptance.
7. If a participant later disputes or denies the record, append their response and set the applicable review state. Preserve the original submission and provenance. Do not silently change the recorder's entry or promote an unacknowledged submission to participant-approved.

The exact acknowledgement methods (for example, witnessed review, paper mark, signature or other accessible method), what counts as adequate evidence, and whether/when a recorder may submit without the participant present are unresolved pilot decisions. Do not assume biometric, identity-document or signature collection.

## Paper-originated records and later entry

Paper-originated records may be entered later **if the project owner and pilot participants approve the workflow**. The transcription keeps:

- Actual participant if known, or explicit unknown/unresolved state.
- The authenticated transcriber, who may differ from the event participant and from the person who originally wrote the paper record.
- `source_kind=PAPER_TRANSCRIPTION`, paper/form reference or image if available, original claimed occurrence time, and actual transcription time.
- Participant acknowledgement state and any later acknowledgement/dispute as a separate appended event.
- Evidence reference, source/witness details and record status (`provisional`, `needs review`, `disputed`, etc.) as the pilot defines.

The paper's date is not the digital entry date. Transcription does not prove that the participant consented, that the paper was accurate, or that the recorded business event was approved. If the paper source lacks an identifier, do not invent a local numbering practice before the pilot defines one. Suspected duplicate transcriptions are flagged for review; they are not automatically merged by matching text or dates.

## Local digital capture

- Cache the app shell and only the reference data needed for the user's assigned locations. Do not bulk-download unrelated participants' inventory, prices, assay evidence or personal data.
- Each command has a versioned envelope: random `clientMutationId`, device ID, authenticated recorder/user, actual participant reference/state, acting party and role scope, command type, schema version, client creation time/timezone, claimed occurrence time, expected resource version, parent command IDs, payload, capture-provenance fields, evidence hashes and local status.
- Generate the mutation ID once and preserve it through retries. A changed command is a new revision linked to the old one, not a changed payload under the same key.
- Save as `draft` or `pending_upload`. Local validation supports usability only; it does not verify authority, participant acknowledgement, business facts or measurements.
- Where users share a device, each entry remains attributed to the signed-in recorder. Require a clear actor/context confirmation before saving, lock or sign out between users according to pilot policy, and clear scoped cached data on logout/revocation where possible. Browser storage can be inspected or evicted and is not a secure vault.
- An offline shared-device workflow must not display the recorder's name as the actual participant unless the recorder is in fact the participant.

## Synchronization states

Each command has its own state. “Saved” must say whether it means local storage, server receipt or participant acknowledgement.

| State | Meaning |
|---|---|
| `draft` | Not queued for upload; editable locally. |
| `pending_upload` | Saved on the device or queued for later transcription upload; not server accepted. |
| `uploading` | Request in progress; outcome may be unknown after connection loss. Retry using the same idempotency key. |
| `server_received` | Server durably recorded the submission and provenance; this alone does not mean business approval or participant acknowledgement. |
| `needs_review` | An authorized review is needed, including unknown participant, unacknowledged or paper-transcribed records where policy requires it. |
| `server_accepted` | Server accepted the command under domain rules; any separate participant-acknowledgement requirement remains visible. |
| `conflict` | A current version, identity, inventory or prior event conflicts; review is required. |
| `rejected` | Server rejected it with a reason; retain the receipt and allow a corrected new command when appropriate. |
| `ledger_queued` / `ledger_submitted` | An eligible server-accepted commitment awaits network confirmation. |
| `ledger_committed` | A network receipt confirms commitment under its configured policy. |
| `ledger_failed` | Submission failed/exhausted attempts; server acceptance remains a separate state. |

Unacknowledged/disputed submissions may be retained as attributed reports when the pilot permits, but cannot be presented as participant-approved. They must not satisfy an approval or custody condition that requires the participant's response. Ledger eligibility follows the approved event policy; no pre-acceptance ledger confirmation is shown.

## Idempotency, duplicate prevention and conflict handling

- Enforce a unique `(actor_scope, clientMutationId)` with a request hash. Same key and same payload returns the durable original receipt; same key and changed payload is rejected.
- Idempotency prevents retry duplicates. `expectedVersion`/ETag detects stale state; both are required for inventory/custody/allocation commands.
- Retry network timeouts with bounded exponential backoff and jitter. Query a receipt or resubmit with the same key after an uncertain response.
- Never use last-write-wins for custody, quantity, allocation, trade terms, payment or assay. Preserve both conflicting submissions and return an explicit review state.
- Different offline users can submit conflicting claims for one batch. Keep each attributed record; use an append-only dispute/reconciliation event, not timestamp-based merging.
- A participant's later acknowledgement or dispute is a separate event referencing the submission; it does not edit the original provenance.

## Server acknowledgement and inventory/ledger handoff

1. API checks schema, authenticated recorder role/scope, participant/capture provenance, idempotency, dependencies and current versions.
2. In one PostgreSQL transaction, store domain facts, capture provenance, measurement records, one inventory journal posting set (if applicable), audit stream entries, idempotency receipt and any eligible outbox item.
3. Return server receipt time and state separately from occurrence time, participant acknowledgement and business review. Persist the response locally before marking server receipt.
4. Dispatch and receipt transfer measured quantity between stockpile, transit-consignment and recovery inventory locations with paired OUT/IN postings. The consignment manifest is not another balance posting.
5. A background worker submits an eligible commitment after server acceptance and records the network transaction ID/receipt separately.

## Retries, recovery and pilot decisions

- Retry transient network/server failures with capped backoff; respect `Retry-After`. Pause for authentication expiry, revoked scope, schema incompatibility, permanent rejection or a conflict.
- Resume IndexedDB commands after app restart. Server outbox retries independently of the device.
- Track queue age, acknowledgements pending, paper transcriptions, disputes, duplicate attempts and ledger backlog. Set alert thresholds after pilot observation.
- Validate shared-device handling, recorder authorization, acknowledgement accessibility, no-phone use, paper retention, language, clock accuracy, connectivity, storage eviction and lost-device response with participants.
- Decide who may transcribe paper records, whether witness capture is allowed, which acknowledgements are required per event, how a participant disputes an entry, whether evidence must be attached, and how long offline authorization lasts before implementing those rules.
