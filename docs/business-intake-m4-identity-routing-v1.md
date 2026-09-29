# Business Intake M4 — Identity Resolution + Routing (v1)

M3 answers *what happened, from which trusted source, for which business*.
M4 answers the next three questions for every canonical intake event:

1. **Who is this about?**
2. **How certain are we?**
3. **Where should it go?**

It answers them deterministically, inside one business, from evidence, and it never silently merges people.
M4 works with zero LLM availability, because there is no AI anywhere in identity or routing.

---

## 1. Frozen rules (enforced in code and tested)

| Rule | Where it is enforced |
|---|---|
| Customer remains the contact record; there is no Contact model | Schema: links and proposals point at `Customer` |
| A WhatsApp message is not a Lead | `R0_FORBIDDEN_LEAD` (any non-LEAD family targeting `lead` is dead-lettered), `R1_MESSAGE` |
| An order is not a Lead | `R0_FORBIDDEN_LEAD`, `R5_COMMERCE` |
| An explicit lead event may route to Lead deterministically | `R4_EXPLICIT_LEAD` |
| Documents stay specialized | `R3_DOCUMENT` (adapter path unchanged) |
| No fuzzy or AI auto-merge | Pure-suite structural test: no LLM, similarity, trigram, `ILIKE` or `contains` in identity or routing code |
| No physical Customer merge | M4 never deletes or merges Customer rows; the owner's confirmation creates *links*, and undo revokes them |

---

## 2. Data model: three homes, three meanings

| Home | Meaning | Mutability |
|---|---|---|
| `IdentityLink` | **Current interpretation**: "this identifier belongs to this Customer" | Revoked, never deleted |
| `IdentityProposal` | **Owner authority**: evidence was not enough, so Dubiz asks the owner | State machine; every applied effect is recorded |
| `IntakeNormalizedEvent` (new columns) | **Historical evidence**: what M4 concluded for *that* event at *that* time | Never rewritten by a later reversal |

History and current interpretation are kept apart on purpose. Undoing a confirmation changes the current interpretation, but it does not rewrite what M4 concluded when the event arrived.

### IdentityLink

- `kind`: `phone`, `email` or `provider`. `scope` is `''` for phone and email, and `<sourceKey>:<account>` for provider ids. A provider id is never global.
- `valueHash`: a domain-separated SHA-256 of `m4.identity.v1 ␟ kind ␟ scope ␟ normalized value`. **The value itself is never stored.** It already lives on the domain record that needs it.
- `method`: `deterministic` (M4 decided from strong evidence) or `owner_confirmed`.
- `status`: `active` or `revoked` (with `revokedAt`, `revokedByUserId` and `revokeReason`).
- Provenance: `sourceIntakeEventId` and `proposalId`.
- **One active owner per identifier per business**: the partial unique index `IdentityLink_active_identifier_key`.
- A phone that is on a Customer **row** is never duplicated into a link: `Customer.phone` stays the authoritative phone identity.

### IdentityProposal

- One per (event, candidate): the unique `IdentityProposal_event_candidate_key`. Regenerating a proposal is a no-op.
- `reason`: `candidate`, `ambiguous` or `conflict`.
- `state`: `proposed`, then one of `confirmed`, `rejected`, `stale` or `superseded`. `confirmed` can later become `undone`.
- `proposedLinks`: the hashed identifiers that the event carried and that **nobody holds**. An identifier that is already held (another Customer's phone, an email already proven for someone) counts as evidence. A confirmation never moves it, because moving it would be a merge nobody decided.
- `evidence`: categories only. `evidenceFingerprint` is a sha256 over (reason, candidates, links).
- `appliedEffects`: exactly what a confirmation changed (currently `{lead: {id, previousCustomerId}}`), so undo restores that and nothing else.

### IntakeNormalizedEvent (new columns)

The new columns are:
- `identityState` and `identityPolicyVersion`;
- `identityCustomerId`;
- `identityEvidence` (categories: identifier kinds, strong and weak bases, conflict flag, created customer, attached to open lead, number of proposals);
- `identityCandidateCount`;
- `routingRule` and `routingDestination`;
- `ownerReviewRequired`.

---

## 3. Identity evidence and policy (`identity-policy@1`)

Identifiers come from the M3 contact hints and nothing else:

- **phone**: normalized by `normalizeCustomerPhone`, the same normalizer Customer, Lead and M2 use. `0501234567`, `050-123-4567` and `+972501234567` are all `972501234567`.
- **email**: trimmed and lower-cased. Placeholder addresses (`noreply@…`, `test@…`, `example.com`, `.invalid`, …) are never identifiers.
- **provider**: a provider-scoped user id, only together with its `sourceKey:account` scope.
- **Names are never identifiers.**

| Evidence | Strength |
|---|---|
| `Customer.phone` | strong |
| active phone link (owner-confirmed alternate phone) | strong |
| active provider link | strong |
| active email link (proven earlier) | strong |
| `Customer.email` (free text nobody verified) | **weak** |

| Situation | State |
|---|---|
| Two strong identifiers point to different Customers | `conflict` |
| One strong Customer, but a weak email names someone else | `conflict` |
| One strong Customer (weak evidence agrees or is absent) | `resolved` |
| No strong evidence; the weak email matches exactly one Customer | `candidate` |
| No strong evidence; the weak email matches several Customers | `ambiguous` |
| Nothing matches | `unresolved` |
| No usable identifier | `not_applicable` |

---

## 4. Routing: deterministic, with explicit rules (`routing-policy@1`)

`decideRoute(family, eventType, target, identityState, coreDestinations)` is pure. Each decision carries the rule's name.

| Rule | When | Destination | Executor |
|---|---|---|---|
| `R0_FORBIDDEN_LEAD` | target `lead` but the family is not LEAD | none | **forbidden**: dead-lettered (`routing:forbidden:R0_FORBIDDEN_LEAD`) |
| `R5_COMMERCE` | family COMMERCE | commerce | `unavailable` until a handler exists: dead-lettered with the payload kept for replay |
| `R2_MESSAGE_STATUS` | target `message_status` | message_status | adapter |
| `R1_MESSAGE` | MESSAGE + conversation | conversation | adapter (the M2 path, unchanged) |
| `R3_DOCUMENT` | target `document` | document | adapter |
| `R4_EXPLICIT_LEAD` | LEAD + lead | lead | core if the adapter opted in (`coreDestinations: ["lead"]`), otherwise the adapter; owner review when identity is uncertain |
| `R6_FORM_ATTENTION` | FORM_SUBMISSION | attention | adapter, with owner review |
| `R7_NONE` | target `none` | none | adapter |
| `R8_ATTENTION_DEFAULT` | anything else | attention | adapter, with owner review |

No BusinessProfile heuristic and no AI can override a rule.

### The Lead destination (`R4`, run by the core)

It runs as **one tenant transaction**:

1. **Idempotency.** If `resultRefs.leadId` is already recorded for this event, that lead is returned.
2. **Locks.** Every identifier of the event is locked in one global order. The phone lock **is M2's WhatsApp sender lock**, so WhatsApp and intake serialize on the same person.
3. **Resolve again**, authoritatively, under the locks.
4. **Contact**, by identity state:
   - `resolved`: that Customer, plus deterministic links for the event's other identifiers that nobody else holds. A phone is never linked deterministically.
   - `unresolved`: a new Customer.
   - `not_applicable`: no contact.
   - `candidate`, `ambiguous` or `conflict`: **no contact**; proposals are created instead.
5. **Lead.** If a Lead is already open on that phone, the event attaches to it (the domain's "one open lead per phone" rule). Otherwise `createLead` runs with the contact decided above.
6. **Evidence and result refs** are written in the same transaction.

The M3 contact hints are purged afterwards, because the domain records now hold the values.

---

## 5. Owner proposals

`GET /api/intake/identity-proposals` returns the open proposals. `POST /api/intake/identity-proposals/:id` takes `{action: confirm | reject | undo, expectedFingerprint?}`.

| Action | Effect |
|---|---|
| **confirm** | Staleness check first. Then it creates `owner_confirmed` links for `proposedLinks`, attaches the event's contact-less Lead, records `appliedEffects`, and supersedes the event's other open proposals |
| **reject** | The candidate is not this person. Nothing changes; the proposal stays as a record |
| **keep separate** | This is `reject`. Customers stay separate, because M4 never merges |
| **undo** | Revokes the links this confirmation created (`revokeReason = owner_undo`, the rows are kept) and reverts the Lead **only if it still points at that candidate** |

A proposal is **stale**, and is never applied, when:
- an identifier it proposes is now held by another Customer (a link, or for a phone a Customer row whose phone hashes the same, recomputed in SQL);
- its Lead is already attached to someone else;
- its evidence was erased; or
- the owner's `expectedFingerprint` differs from the stored one (the owner saw different evidence).

Decisions take `SELECT … FOR UPDATE` on the proposal, and every write is `updateMany({id, businessId})`.

---

## 6. Cross-channel example (battery-proven)

1. **WhatsApp from `+972501234567`.** M2 creates Customer X. Rule `R1_MESSAGE` applies; identity is `resolved` (created by the destination). **No Lead.**
2. **Lead form with `050-123-4567` + `eldad@example.test`.** Resolved to X by `customer_phone`. A Lead is attached to X, and the email becomes a `deterministic` link to X.
3. **Second form with `ELDAD@example.test` only.** Resolved to X by `email_link`. **One Customer across three events and two channels.**

Uncertain variants:
- a form carrying only an email that sits in `Customer.email` gives `candidate`;
- two Customers sharing that email gives `ambiguous`;
- X's phone together with an email proven for Zohar gives `conflict`.

In all three, the Lead is created **without a contact** and the owner decides.

---

## 7. Concurrency and idempotency

- **Advisory locks**:
  - phone uses `'IS'` (shared with M2);
  - email uses `'IE'`;
  - provider uses `'IP'`.
  They are sorted and deduplicated, with `pg_advisory_xact_lock`.
- **Backstops**:
  - the partial unique index on active links;
  - `Customer (businessId, phone)` unique;
  - `Lead_open_phone_key`;
  - `createMany … skipDuplicates`.
- **Replays**: M3's receipt identity turns a replay into one receipt, and M4's `resultRefs` anchor, written in the Lead's own transaction, makes a retry after commit return the same Lead.
- **Partial failure**: the Customer insert rolls back with the Lead insert, and a retry creates exactly one of each.

---

## 8. Observability and learning signals

- The **trace** (`traceIntakeReceipt`) now includes identity state, policy version, evidence categories, candidate count, rule, destination, owner-review flag and proposals. It carries no identifier values and no content.
- **Sensors** (`LearningEvent`):
  - `INTAKE_IDENTITY_RESOLVED`: state, identifier kinds, strong bases, candidate count, policy version, rule, destination;
  - `IDENTITY_PROPOSAL_DECIDED`: action and outcome.
- **No phone or email in LearningEvent**, enforced by the `recordSensor` PII key guard and asserted by the battery.

---

## 9. Privacy and erasure

- Identifiers are stored as hashes only. Message content is not duplicated.
- Account erasure is handled as follows:
  - `IdentityLink.valueHash` is nulled; an erased link can never match again;
  - `IdentityProposal.proposedLinks`, `evidence` and `appliedEffects` are nulled;
  - `IntakeNormalizedEvent.identityEvidence` and `identityCustomerId` are nulled.
- Both tables are `ERASURE_MANAGED` in the coverage ratchet.
- Customer deletion cascades its links and proposals through FKs.

---

## 10. Tenant security

- Every row carries `businessId`.
- **Composite (businessId, id) FKs**, DB-only like sec-C's:
  - `IdentityLink_customerId_tenant_fkey` → Customer;
  - `IdentityProposal_candidateCustomerId_tenant_fkey` → Customer;
  - `IdentityProposal_leadId_tenant_fkey` → Lead;
  - `IdentityProposal_businessId_intakeEventId_fkey` → IntakeEvent.
  A row of business A cannot reference B's records, even through the table owner.
- FORCE RLS with per-command SELECT, INSERT and UPDATE policies. There is no DELETE policy, and DELETE and TRUNCATE are revoked from `app_runtime`.
- Proven on PostgreSQL 17 as a NOSUPERUSER / NOBYPASSRLS runtime:
  - no cross-tenant read, update or insert;
  - no-context reads return nothing;
  - DELETE is refused;
  - the same phone, email and provider id in two businesses resolve independently.

---

## 11. Why Party and EntityLinkProposal are **not** reused

| Existing model | Why not |
|---|---|
| `Party` | Party-centric, with raw `signalValue` PII, phone-alone identity and an unordered `findFirst`. It is used only by a gated backfill and is not erasure-managed. Reusing it would make Customer a second-class contact and store identifiers in clear |
| `EntityLinkProposal` | No undo, no staleness, a DELETE grant, and raw values. M4 needs recorded effects and reversible, stale-safe owner authority |

Both stay untouched. M4's tables are minimal and Customer-centric.

---

## 12. Migration

`20260930090000_m4_identity_routing` is **expand-only**:
- two new tables;
- eight nullable or defaulted columns on `IntakeNormalizedEvent`;
- indexes, CHECKs, FKs, RLS, policies and grants.

There is no backfill, and no existing row, constraint or policy changes. The preflight refuses a database without sec-C and M3.

It is shipped separately (PR-A) and is **not merged before explicit owner approval**, so it cannot be applied implicitly by another `release-migrate` run.

## 13. Proof

- `lib/intake/identity/identity-core.test.ts`: the pure suite, run with no database. It covers:
  - rules R0–R8;
  - hashing and scope;
  - placeholders;
  - lock sharing with M2;
  - fingerprint;
  - no AI or fuzzy code.
- `.m4/identity-routing-battery.ts` in `m4-identity-routing-ci.yml`: real PG17, the real migration, the real webhook, processor and owner route. It covers:
  - migration mechanics;
  - cross-channel;
  - candidate, ambiguous and conflict;
  - confirm, reject, undo, stale and supersede;
  - order ≠ lead;
  - malformed input;
  - replay and partial-failure retry;
  - concurrency;
  - tenant isolation;
  - deletion and erasure;
  - trace;
  - learning signals.
- The M3 foundation battery re-runs on the migrated database.

## Out of scope

M5 and M6 (commerce handler, further sources) are not part of M4. Commerce events stay dead-lettered with their payload kept.
