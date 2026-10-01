# Business Intake M5 — CRM Lead Lifecycle + Secretary (v1)

M3 answers *what happened, from which trusted source, for which business*.
M4 answers *who it is about, how certain we are, and where it goes*.
M5 answers *what happens to a sales opportunity afterwards*:

- which leads need the owner, and why;
- what the next action is, and when it is due;
- how each lead progressed, stalled, and ended;
- what Dubiz proposes.

The authority model is unchanged: **observe → analyze → propose → the owner decides → track → learn.**
Nothing in M5 sends a message, contacts a customer, changes a stage on its own, or asks a model what is true. It works with zero LLM availability.

---

## 1. What already existed (forensic, 2026-09-30, main `5a0ef827`)

The CRM was not empty. M5 extends it rather than replacing it.

| Existing | State before M5 | M5 decision |
|---|---|---|
| `Lead.status` (`LeadStatus`: NEW, OPEN, QUALIFIED, QUOTED, WON, LOST, DROPPED) | Live. Owner-set through `PATCH /api/leads/[id]`. The rules in `lead-core.ts` are permissive and support reopening. | **Reused as the canonical stage and outcome.** No new stage vocabulary. |
| `Lead.nextFollowUpAt` + `followUpNote` | Live. A single follow-up slot, surfaced on Home and `/attention`, with "טופל" and "דחה ל־3 ימים". | **Reused as the next action's WHEN.** M5 adds the WHAT (`nextActionKind`). |
| `Lead.lastActivityAt`, `closedAt`, `lostReason` | Live. Written only by lead-service writes, never by messages. | Reused. The inference rules say "no recorded activity on the lead", never "no response". |
| `LEAD_*` audit events (`logAuditEvent` → `LearningEvent`) | Live. No idempotency key. | Kept unchanged for comparability. **Not** operational truth. |
| `lead-attention.ts` + the business-status leads loader/translator | Live. One contract for the Inbox, Home and Attention. | **Extended** with new reasons. Still one contract for every surface. |
| "Secretary" (`lib/services/obligations`) | The **payment** Secretary only: `BusinessObligation`, the commitment ledger, and a derived briefing. | Not reused for CRM (its model is financial and payer-side). M5 adds the Secretary's **lead** briefing beside it. |
| `Task` model | Dead: no reader or writer. | Not revived. A second follow-up engine would compete with `nextFollowUpAt`. |
| `BusinessObligation` | Financial obligations. | Not used. A follow-up is not an obligation. |
| `Conversation.pendingFollowUp` | JSON with no due date; not surfaced anywhere. | Not used. |
| `BusinessInsight`, M9 `OutcomeRecommendation` | Owner proposals. M9 explicitly excludes leads. | Not used in v1. Suggestions are derived at read time, and a dismissal is a lifecycle step (see §6). |
| `Deal` | Dead: no runtime consumer and no grant. | Not used. |
| `Conversation.currentStage` / `temperatureScore` | Written only behind `CONVERSATION_STATE_WRITER_ENABLED` (Production value unknown). | Not read by M5. A badge over possibly empty evidence is worse than no badge. |

### The six legacy Lead fields

| Field | Evidence before M5 | Decision |
|---|---|---|
| `temperature` | Never written or read | **DEPRECATE.** `Conversation.temperatureScore` is the (flag-gated) evidence source. |
| `currentStage` | Never written or read | **DEPRECATE.** `status` is the stage. |
| `valueEstimate` | Never written; Float | **KEEP + ACTIVATE**, retyped to `NUMERIC(18,2)`: the owner's *estimated opportunity value*. |
| `quotedPrice` | Never written | **DEPRECATE.** Quote truth is the billing `QUOTE` document. No quote→lead link exists yet. |
| `finalPrice` | Never written; Float | **KEEP + ACTIVATE**, retyped to `NUMERIC(18,2)`: the amount *agreed* at WON. Only a WON lead accepts it. |
| `currency` | Default `ILS` only | **KEEP + ACTIVATE**: the currency of the two amounts, with an ISO-4217 CHECK. |

Four amounts are never allowed to blur:

- **estimated value**: `Lead.valueEstimate`, set by the owner;
- **quote amount**: the billing `QUOTE` document;
- **agreed amount**: `Lead.finalPrice`, set by the owner at WON;
- **collected revenue**: payments and receipts.

M5 infers none of them from another.

---

## 2. The lifecycle contract

Five things, deliberately not one field:

| Concept | Where | Notes |
|---|---|---|
| **Stage** | `Lead.status` while open: NEW → OPEN (in progress) → QUALIFIED → QUOTED | Owner-moved, in either direction. |
| **State** | open / closed, derived from status | Never stored twice. |
| **Outcome** | terminal status WON / LOST / DROPPED + `closedAt` (+ `lostReason`, + `finalPrice`) | DROPPED ("never a real lead") stays out of conversion denominators. |
| **Next action** | `nextActionKind` (what) + `nextFollowUpAt` (when) + `followUpNote` (the owner's words) | At most one. CHECK: a kind requires a due moment. |
| **History** | `LeadLifecycleEvent`, append-only | §3. |

Next-action kinds: `call`, `send_quote`, `check_quote`, `follow_up`, `schedule_meeting`, `collect_info`, `wait_for_customer`, `other`.
A follow-up written before M5 has no kind, which is allowed. Nothing guesses one.

### Transition rules (who may change what)

| Change | Who | Why it is allowed |
|---|---|---|
| `created` at NEW | automatic | The lead exists: owner, import, conversation, auto-capture, or an explicit intake lead event (M4 `R4_EXPLICIT_LEAD`). |
| `intake_attached` | automatic | A further explicit lead event for a phone that already has an open lead (M4's one-open-lead rule). **The stage does not move.** |
| `next_action_cleared` | automatic | Closing a lead drops its open next action, so a decided lead can never be "overdue". |
| `contact_attached` / `contact_detached` | owner (M4 proposal confirm / undo) | Identity is the owner's decision when evidence is uncertain. |
| every stage change, outcome and reopen | **owner only** | |
| next action set / reschedule / complete, values | **owner only** | |
| a Dubiz suggestion | **proposed only** | It becomes a next action only when the owner accepts it (§6). |

These are **never** evidence of a transition:

- a message received (message ≠ lead activity, and message ≠ qualified);
- a quote document created (quote created ≠ quote sent ≠ accepted);
- an invoice (invoice ≠ won);
- a payment (payment ≠ sales outcome).

None of them is linked to a Lead in the data model today.

---

## 3. Durable history — `LeadLifecycleEvent`

One row per lifecycle change, written **in the same tenant transaction** as the Lead change it describes. It holds no personal data: no name, phone, email, note, reason text or message content.

| Column | Meaning |
|---|---|
| `seq` | The lead's `lifecycleVersion` after this step. `(businessId, leadId, seq)` is unique. |
| `kind` | `created`, `intake_attached`, `status_changed`, `next_action_set`, `next_action_rescheduled`, `next_action_completed`, `next_action_cleared`, `value_updated`, `suggestion_dismissed`, `contact_attached`, `contact_detached`, `conversation_linked` |
| `fromStatus` / `toStatus` | Enum-typed. Shape CHECKs per kind. |
| `nextActionKind`, `dueAt`, `previousDueAt` | Postponements keep both moments. |
| `amountKind` + `amount` | `value_updated` only (`estimate` or `agreed`). |
| `actorType`, `actorUserId`, `source` | `OWNER_USER` requires a user id. `BACKFILL` marks reconstructed rows. |
| `evidenceKind` + `evidenceRef` | `intake_event`, `conversation`, `identity_proposal`, `suggestion` or `backfill`, plus a scalar id or rule id (CHECK `[A-Za-z0-9_:.@-]{1,100}`). Never content. |
| `idempotencyKey` | `(businessId, idempotencyKey)` is unique. |

It can answer:

- when the lead arrived, and when it was first handled (`Lead.firstHandledAt`);
- how long it stayed in each stage;
- when each next action was set, postponed (and how often) and completed, and whether on time;
- when it was won or lost, and what caused each step (owner, system, integration, import, backfill), with the evidence reference.

### Backfill

The migration gives every existing Lead its `created` step (at `createdAt`). A Lead no longer NEW also gets **one** `status_changed` NEW → current status, at `closedAt`, else `lastActivityAt`, else `updatedAt`.

Both rows carry `source = BACKFILL`, so learning can exclude reconstructed history. The migration itself asserts the result: every Lead has exactly one `created` step, and `lifecycleVersion` equals its step count.

---

## 4. Concurrency and idempotency

Every lifecycle write runs the same protocol (`lead-lifecycle.service.ts`):

1. **`SELECT … FOR UPDATE` on the Lead.** Concurrent writers on one lead serialize, and the second sees the first one's result. Before M5, `updateLeadStatus` read and then wrote with no lock, so a double-tap could emit two transitions. That race is closed.
2. **Optional `expectedVersion`.** A mismatch returns `409 LEAD_LIFECYCLE_STALE` instead of overwriting a newer decision. This is the stale-proposal protection.
3. **Idempotency key first.** A retried step returns the recorded one.
4. **`lifecycleVersion + 1` by compare-and-set, then the history row with `seq` = the new version.** The unique `(businessId, leadId, seq)` is the database backstop.
5. **No-op detection.** A repeated identical status, an identical next action, or completing an already completed follow-up changes and records nothing.

Keys:

- `lead:<id>:created`;
- `lead:<id>:v<base>:status:<TO>`;
- `lead:<id>:v<base>:next:<dueMs>`;
- `lead:<id>:v<base>:completed`;
- `intake:<eventId>:lead-attached`;
- `identity-proposal:<id>:contact_attached|contact_detached`;
- `lead:<id>:conversation:<cid>`.

M4's intake anchor (`resultRefs.leadId`) and M3's receipt identity still guard the intake side. A replayed explicit lead event therefore gives one Lead and one `created` step.

---

## 5. Attention: facts, inferences and suggestions

`evaluateLeadAttention` stays the single contract for the Inbox, Home, Attention and the Secretary. The bands are strictly ordered (age moves an item within its band, never across one):

| Reason | Class | Evidence |
|---|---|---|
| `FOLLOWUP_OVERDUE` | **fact** | The due moment the owner set has passed |
| `CUSTOMER_WROTE` | **fact** | A customer-inbound message on a linked conversation after the lead's last recorded activity (M2's per-message timestamps, written independently of any flag) |
| `FOLLOWUP_DUE_TODAY` | **fact** | Due today (Israel-local day) |
| `AWAITING_OWNER_DECISION` | **fact** | An open M4 identity proposal names this lead |
| `NEW_UNHANDLED` | inference | NEW, no next action, since before today |
| `QUOTE_NO_ACTIVITY` | inference | QUOTED, no next action, no recorded lead activity for ≥ 3 days |
| `STALLED` | inference | OPEN or QUALIFIED, no next action, no recorded lead activity for ≥ 7 days |

Every item carries its class. The UI labels it "עובדה" or "מסקנה מהנתונים".

---

## 6. Dubiz proposes (`lead-lifecycle-core.ts`)

Suggestions are deterministic rules over lifecycle facts. They are shown only when the lead has **no** next action, since the owner's plan is never second-guessed.

| Rule | When | Proposal |
|---|---|---|
| `S4_REPLY_CUSTOMER@1` | The customer wrote after the last lead activity | follow up today |
| `S1_CONTACT_NEW@1` | NEW | call today |
| `S2_CHECK_QUOTE@1` | QUOTED, idle ≥ 3 days | check the quote |
| `S3_REVIVE_STALLED@1` | OPEN or QUALIFIED, idle ≥ 7 days | follow up |

- **Accept.** This is `setFollowUp` with the proposed kind and due moment, `fromSuggestionRuleId`, and the `expectedVersion` the owner saw. It is recorded as an **owner decision** (`actorType OWNER_USER`) with the suggestion as evidence. If the lead changed since, the acceptance is refused (409). A stale suggestion therefore can never overwrite a newer decision.
- **Not now.** This records a `suggestion_dismissed` step with the rule id. The rule stays quiet on that lead while the dismissal is the lead's latest step, and any later change lets Dubiz propose again.

There is no AI in this path. AI may later **word** a suggestion or summarize facts. It may not create a lead, move a stage, decide an outcome, set money, merge customers or send anything.

---

## 7. The Secretary

"Secretary" in code was the payment Secretary. M5 adds its sales side without mixing models:

- `GET /api/leads/briefing` returns `deriveLeadBriefing`. It holds counts per reason, the top five leads (each with its reason, its evidence class and, separately, Dubiz's suggestion), and a state (CALM, BUSY or CRITICAL; CRITICAL means something is overdue or a customer wrote).
- The Secretary home shows it as **"לידים היום"** below the payment briefing, and links to the lead or to the Attention queue.
- **One canonical source.** The briefing, Home and `/attention` all derive from `evaluateLeadAttention` over the same facts. An alert is never stored twice.
- **Read-only.** Reading the briefing changes nothing; the battery proves this.

The briefing scans at most 500 open leads. Beyond that it says the counts are a floor (`complete: false`).

---

## 8. Owner surfaces

- **Lead card → "מסלול הליד"**, with progressive disclosure:
  - one line on why the lead needs the owner (fact or inference);
  - Dubiz's suggestion, with **קבעו** / **לא עכשיו**;
  - the next action's kind;
  - amounts, folded away (estimate; agreed only when WON);
  - history, folded away (newest first, marked as reconstructed or as coming from a suggestion or an intake event).
- Status changes from the card carry `expectedVersion`.
- `GET /api/leads/[id]/history` returns the full history: tenant-scoped, and 404 for another business.
- `PATCH /api/leads/[id]` keeps its one-contract-per-request rule and adds two contracts: `{ value }` and `{ dismissSuggestion }`.

Mobile is unchanged in structure. On desktop the card is the existing master–detail pane.

---

## 9. Learning (no second learning system)

M5 uses the M5.5 sensor contract (`recordSensor`: allow-listed keys, a PII guard, idempotent keys):

| Sensor | Payload (categories, counts, durations only) |
|---|---|
| `LEAD_LIFECYCLE_STARTED` | origin (MANUAL, CONVERSATION, AUTO_CAPTURE, IMPORT, INTAKE), contactKnown |
| `LEAD_STAGE_CHANGED` | fromStage, toStage, closing, reopening, hoursInPreviousStage |
| `LEAD_OUTCOME_RECORDED` | outcome, daysOpen, hadNextAction |
| `LEAD_NEXT_ACTION_SCHEDULED` | actionKind, rescheduled, dueInHours, fromSuggestion |
| `LEAD_NEXT_ACTION_COMPLETED` | actionKind, onTime, lateHours |
| `LEAD_FIRST_HANDLED` | hoursToFirstHandling, firstAction |
| `LEAD_VALUE_RECORDED` | amountKind, cleared (the amount stays on the lead) |

Together with `LeadLifecycleEvent`, these make the future measures derivable without reconstructing lost history:

- time to first handling;
- time between stages;
- follow-up delay and completion;
- postponement rate;
- conversion by source and by path;
- time to close;
- where leads stall;
- suggestion adoption.

M5 does not build those measures. No customer PII and no message content ever enter `LearningEvent`.

`BusinessProfile` (`category`, `subCategory`, `businessModel`) is **not** used in v1. The rules above hold for every business type, and provider or lifecycle evidence always outranks a profile heuristic.

---

## 10. Tenant security

- `LeadLifecycleEvent` has FORCE RLS, with only a **SELECT** and an **INSERT** policy (tenant predicate, fail-closed).
- `app_runtime` holds `SELECT, INSERT`. `UPDATE, DELETE, TRUNCATE` are revoked, overriding Production's default ACL. The history is append-only.
- The composite `(businessId, leadId) → Lead(businessId, id)` FK means even the table owner cannot attach business B's step to A's lead.
- Lead keeps its Production posture: FORCE RLS `p7w1_tenant`, and the runtime has S/I/U with **no DELETE**.
- Erasure. `LeadLifecycleEvent` is `NON_PERSONAL_OPERATIONAL`, with machine-checked evidence: its textual surface is closed vocabularies and scalar references, and its only write site is `lead-lifecycle.service.ts`.
  - Account erasure scrubs the Lead's personal fields and keeps the non-personal history.
  - Business deletion cascades.
  - The three new Lead columns are `STRUCTURAL`.

---

## 11. Observability

For any lead, the chain is explainable end to end:

1. `IntakeEvent` → `IntakeNormalizedEvent`: identity state, routing rule, and `resultRefs.leadId`;
2. → the lead's `created` step, whose `evidenceRef` is that intake event;
3. → every later step, with its actor, source and evidence (a proposal, a suggestion, a conversation);
4. → the resulting state on the Lead.

`traceIntakeReceipt` is unchanged, and the lead history route completes the chain. Logs and history carry no PII.

---

## 12. Rollout

1. **Ops PR.** The read-only Production preflight and post-migration proof, each proven in `m5-production-evidence-lab.yml` (Production role shape, deliberate faults).
2. **PR-A (migration only).** `20261002090000_crm_lead_lifecycle`, `schema.prisma`, the isolation lab helper and the erasure classification. **Not merged before the owner approves the Production migration.** Before `release-migrate`, the complete pending set is re-verified against a fresh ledger.
3. `release-migrate`, then the post-migration proof (14 assertions).
4. **PR-B.** The implementation, tests and this document. It deploys on merge.

### Migration shape

- **Additive.** One new table, three new Lead columns, five Lead CHECKs.
- **Two retypes.** `valueEstimate` and `finalPrice` go from Float to `NUMERIC(18,2)`. No code has ever written them.
- **Backfill.** One or two history rows per existing Lead.
- **Locks.** The retype rewrites the Lead table under an exclusive table lock. In Production that is 13 rows, so milliseconds.
- **Rollback.** Drop the table and the three columns, and retype the two money columns back to `double precision`. No existing value is changed except the version counter, which the rollback drops.

---

## 13. Proof matrix

| Proof | Where |
|---|---|
| Lifecycle core, suggestions, dismissal, evidence classes, priority bands, briefing, AI boundary (structural), plus a negative proof that an inference relabelled as a fact fails | `lib/services/crm/lead-lifecycle.test.ts` (+ CI mutation) |
| Explicit lead → canonical intake → identity → routing → one Lead → lifecycle initialized once (evidence = the intake event) | `.m5/crm-lifecycle-battery.ts` |
| Message ≠ lead, order ≠ lead | battery |
| Replay ×5 (one Lead, one `created`); second event → one `intake_attached` | battery |
| Owner route: stage, next action, postpone, complete, values; stale version → 409; retries are no-ops | battery |
| Suggestion proposed (not applied); a stale acceptance is refused; a fresh one is recorded with evidence; "not now" | battery |
| WON clears the next action; agreed amount; reopen keeps history | battery |
| Concurrency: 8 identical transitions → 1 step; 6 different next actions → 6 contiguous steps; 6 completions → 1; two different transitions serialize; 5 concurrent lead events for one new phone → 1 Customer, 1 Lead, 1 `created`, 4 `intake_attached`; a WhatsApp message racing an owner change keeps both | battery |
| Partial failure rolls back lead + step; the retry creates exactly one; re-appending a recorded key writes nothing | battery |
| Ambiguous identity: lead without a contact, AWAITING_OWNER_DECISION; confirm → `contact_attached`; undo → `contact_detached` | battery |
| Secretary briefing and business-status agree; the briefing is read-only; no PII | battery |
| Tenant isolation on a NOBYPASSRLS runtime: no cross-tenant read, write, PATCH or history; no-context read → 0; composite FK; UPDATE/DELETE on history and DELETE on Lead refused | battery |
| Learning payloads and history hold no PII or amounts | battery |
| Account erasure scrubs the Lead and keeps its history; business deletion cascades | battery |
| Real migration: backfill on pre-existing rows, grants, FORCE RLS, policies, drift gate (17 DB-only objects), preflight refusal | `m5-crm-lifecycle-ci.yml` |
| Regression on the **same** M5 database: M4 battery, M3 battery | `m5-crm-lifecycle-ci.yml` |
| Leads W1–W3, collision recovery, priority order on real PostgreSQL (previously in no workflow) | `m5-crm-lifecycle-ci.yml` (`lead-domain`) |
| Production structural proof (catalog-exact, effective privileges, coverage invariant) | `ops/evidence/m5-crm-lead-lifecycle-production-evidence.sql` |

---

## 14. Known limitations (v1)

- **No quote→lead or payment→lead link.** QUOTED and WON stay owner-set, and quote or payment events are not lifecycle evidence. A link is an M7/M8 topic.
- **Lead follow-up notifications.** The notification policy has a lead rule but no sync caller. M5 surfaces attention through the Secretary, Home and Attention, and does not start writing notifications.
- **The leads list "דורש טיפול" filter** keeps the W2 SQL (follow-up due or new). The M5 reasons appear in the Secretary briefing and in Attention.
- **No Production adapter emits LEAD events yet.** The intake lead path is proven in the lab with the reference adapter and becomes live with the M6 connectors.
- **Backfilled history is coarse.** One status step per pre-M5 lead, marked `BACKFILL`.
- **Lab artifact.** The WhatsApp webhook drains the business queue with the Production registry, so a racing reference-adapter event can be dead-lettered `unknown_source` in a lab. In Production the single registry holds every source, so this cannot occur there. The M5 battery races two lead events and a message against an owner change instead.
