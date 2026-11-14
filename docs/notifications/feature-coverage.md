# כיסוי התראות לפי פיצ'ר — Notification feature coverage

Owner decision 2026-11-13: notifications for ALL features active in Production before launch; listen to real
events / state only; never change business logic, money calculations, amounts, statuses, document issuance /
numbering, invoice / receipt behaviour or payment mechanisms; never bypass a guard. Features that are OFF stay OFF.

Branch stack (Draft, not merged, nothing applied): #1143 migration (`notify/2-engine-migration`), #1146 engine
(`notify/3-engine`), #1147 producers (`notify/5-producers`), **this branch `notify/6-coverage`** (status sweep, the
state producers A–E of the owner decisions of 2026-11-13, this document, `sweep-performance.md`). Everything here is
inert until `notifications_engine` (catalog default OFF) is enabled for a business.

**The owner's final table is [§0 below](#0-final-coverage-table-owner-2026-11-13).** The per-domain sections after it
keep the detailed source lines.

Paths are relative to the repository root; line numbers are as of `notify/6-coverage`.

## How to read this document

| Column | Meaning |
|---|---|
| Fact | A real event (status change, creation, failure) or a derived state, with its source line |
| Needs? | Whether it deserves a notification at all (silence is the default — `lib/notifications/notification-policy.ts:24`) |
| Channel | **push** = immediate on the lock screen (generic text only); **in-app** = bell / notification centre; **digest** = the 08:00 daily summary (`lib/notifications/engine/digest.ts`) |
| Existing | What already notifies or surfaces it |
| Overlap | Duplication with the secretary / agenda (`lib/services/tasks/sources.ts`), Attention (`lib/business-status`), nav badges (`components/navigation/nav-signals.ts`) |
| Action | Whether the user must do something |
| Catalog key | `lib/notifications/catalog.ts` category (feature gate in brackets) |
| Wired by | PR / mechanism that produces it, or **not wired** + why |

**Production overrides are invisible from here.** The defaults below come from
`lib/services/feature-access/platform-feature-catalog.ts`; a business-level override or a platform policy in
Production can differ. Every notification is gated on the business's real feature access at run time
(`lib/notifications/engine/engine-gate.ts`), so an override is honoured automatically.

### Push rule

Push by default only for explicitly urgent, action-required facts: a user-set task reminder, a booking request
waiting for approval (feature OFF by default), critical stock, a billing document whose PDF failed (the owner may
believe a legal document exists when it does not), and the security alert (no producer yet). Never "all money".
Everything else is in-app or digest. Every push shows only the catalog's generic Hebrew text unless the user enabled
`lockScreenDetails` (`lib/notifications/push/push-content.ts`).

## Mechanisms

| Mechanism | Where | What it covers |
|---|---|---|
| Snapshot writer + policy | `lib/notifications/notification-writer.ts:124`, `notification-policy.ts:109` | dedupe, cooldown, quiet hours (policy), owed PUSH rows |
| Domain consumers (event hooks) | inventory `inventory-alert-notifications.ts:85`, documents queue `documents-review-queue-notifications.ts:104`, inbox `inbox-waiting-notifications.ts:113`, intake `intake-notifications.ts:99`, accountant `lib/accountant/notify.ts:214,339` | as listed per domain |
| Engine `notify()` | `lib/notifications/engine/notify.ts:64` | connections.disconnected (#1147), digest, test push |
| Direct upserts | task reminders `lib/services/tasks/task-reminders.service.ts:71`, public booking `lib/services/booking/booking-notify.ts:34` | tasks.reminder, booking.request_waiting |
| Push worker / digest | `engine/push-worker.ts`, `engine/digest.ts` (#1146) | delivery of owed pushes; 08:00 summary |
| **Status sweep (this PR)** | `lib/notifications/producers/status-sweep.ts`, route `app/api/notifications/status-sweep` | billing review / failure, lead follow-ups, supplier drafts; catch-up of the inventory and documents-queue consumers |
| **State producers A–E (this PR)** | `lib/notifications/producers/state-producers.ts` (reads + runner), `state-facts.ts` (pure), run by the sweep per business | obligations due / overdue, payment requests failed / expired unpaid, ITA allocation problems, document processing failures, upcoming appointments — through the engine's `notify()` |

### The status sweep in one paragraph

Per live business (`notification_live_businesses`, the digest's walk) where `notifications_engine` is ON, inside that
business's tenant context: the home snapshot's own loaders / translators for the sweep's OWN scopes only, one read at a
time (`loadOwnedFacts`) → keep the items whose category's feature is available → the existing `decideForSnapshot` →
the existing `persistSnapshotNotifications` → `resolveAbsentNotifications` per owned scope against UNCAPPED identifier
sets (`lib/notifications/exhaustive-facts.ts` — never a capped list; an incomplete lead read resolves nothing) → the
existing inventory and documents-queue reconcilers as a catch-up → the state producers A–E (one tenant transaction
behind a per-business advisory lock) → a worker kick when a push is owed. Owned scopes: `billing|billing_document`,
`leads|lead`, `supplier|supplier_purchase_draft`. CRON_SECRET route, not scheduled in `vercel.json` (owner decision),
45 s budget under `maxDuration = 60`, businesses in a pool of 2 (`NOTIFICATIONS_SWEEP_CONCURRENCY`), keyset
continuation (`?after=<nextAfter>`), counts-only logs. Zero domain-code changes. Measurements:
[`sweep-performance.md`](sweep-performance.md).

## 0. Final coverage table (owner, 2026-11-13)

Legend — **Default**: push = owed push on the lock screen (generic text), in-app = bell only, digest = in-app + the
08:00 daily summary (`engine/digest.ts`), never a separate push. **Quiet hours**: "deferred" = the worker holds the push
until the user's quiet end (`engine/worker-decision.ts`), the TTL drops it if that is too late; "bypass" only for a
user-set reminder and the security alert. **Summary?**: whether an unresolved row reaches the daily summary (digest
mode, or a push held back by quiet hours / rate limit). **Resolved?**: closed automatically once the fact is no longer
true (handled). Tests are under `lib/notifications/` unless a path is given.

| Feature (default) | Detectable events | Wired to the engine | Category | Default | Quiet hours | Summary? | Resolved? | Tests |
|---|---|---|---|---|---|---|---|---|
| Tasks (`daily_tasks`, ON) | reminder due; overdue / due today | reminder due | `tasks.reminder` | push | **bypass** (user-set time) | if held | yes (task done) | `services/tasks/task-reminders.test.ts`, `task-reminders.db.test.ts`, `catalog.test.ts` |
| Appointments (`appointments`, ON) | confirmed appointment starts soon; created / moved / cancelled | **upcoming (60 min before)** — new | `appointments.upcoming` | push (TTL 30 min) | deferred, dropped after the start | if held | yes (cancelled, moved, started) | `producers/state-producers.test.ts`, `producers/state-producers.db.test.ts` |
| Public booking (`public_booking`, OFF) | request pending / auto-confirmed / cancelled / expired | pending, cancelled; resolve on settle | `booking.request_waiting` | push | deferred | if held | yes | `catalog.test.ts`, `producers/producers.test.ts` |
| Obligations / secretary / payables (no flag) | due today, overdue, postponed, paid / handled / released | **due day + overdue stages 1, 3, 7, weekly** — new | `obligations.due` | **digest** (no push) | n/a (no push) | yes | yes (MET, released, postponed, paid in the ledger) | `producers/state-producers.test.ts`, `.db.test.ts` |
| Payments / collection (no flag) | request FAILED, expired unpaid, PAID, anomalies | **FAILED on a sent link; expired > 24 h unpaid** — new | `payments.request_failed` | push | deferred | if held | yes (paid by any path, re-asked, cancelled) | `producers/state-producers.test.ts`, `.db.test.ts` |
| Billing (`billing`, ON) | PDF failed; review pending; stale drafts / links; **ITA allocation failed / rejected / uncertain / HELD / stuck** | PDF failed, review, **ITA (only with the PRODUCTION pilot on)** — new | `billing.failure`, `billing.review`, `billing.allocation_failed` | push / digest / push | deferred | review: yes; others if held | yes | `producers/status-sweep.test.ts`, `.db.test.ts`, `producers/state-producers.test.ts`, `.db.test.ts` |
| Documents (`documents`, ON) | review backlog; per-document review; **processing failed**; stuck in processing | backlog (queue), **processing failed** — new | `documents.review`, `documents.processing_failed` | in-app / **digest** | n/a | failed: yes | yes (queue empty; retried / succeeded) | `documents-review-queue-notifications.verify.test.ts`, `.integration.test.ts`, `producers/state-producers.*` |
| Accountant (`accountant_*`, ON) | period ready / attention / failed / changed; send failed / bounce / complaint | all | `accountant.month_close`, `accountant.send_failed` | in-app | n/a | no | yes | `producers/producers.test.ts`, `catalog.test.ts` |
| Inventory (`inventory`, ON) | critical / low stock, unmatched POS, supplier draft pending | critical stock, supplier draft | `inventory.critical_stock`, `suppliers.purchase_pending` | push / digest | deferred | supplier: yes | yes | `inventory-alert-notifications.integration.test.ts`, `producers/status-sweep.*` |
| Inbox (`inbox`, ON) | customer waiting for a reply | waiting | `inbox.customer_waiting` | in-app | n/a | no | yes (answered) | `inbox-waiting-notifications.verify.test.ts`, `.integration.test.ts` |
| Leads (no flag) | follow-up overdue / due, called / wrote, new untouched | HIGH / MEDIUM reasons | `leads.follow_up` | in-app | n/a | no | yes (complete read only) | `producers/status-sweep.*` |
| Connections (Gmail / WhatsApp, ON) | token revoked; intake paused / failed | revoked (+ restore resolves); intake (`intake_status_visibility`, OFF) | `connections.account_disconnected`, `connections.disconnected` | in-app | n/a | no | yes | `producers/producers.test.ts`, `intake-notifications.verify.test.ts` |
| Security | new device, password reset | not wired (session track owns the auth plane) | `security.new_device` (reserved) | — | — | — | — | `catalog.test.ts` |
| System | daily summary, test push | both | `digest.daily`, `system.test` | push | deferred / bypass (test) | — | — | `engine/notification-engine.db.test.ts` |
| content, pricing, revenue, reports, starter_bot (ON) | no owner-facing action-required event | — | — | — | — | — | — | — |
| OFF features (acquisition, commerce, telephony, POS, bank file, knowledge, recommendations, business documents, service desk) | — | nothing until enabled; categories gated on their flag | — | — | — | — | — | — |

### The five owner decisions (A–E) in detail

All five are produced by the status sweep (no domain code changed, no protected-path hook) through
`lib/notifications/producers/state-producers.ts` (reads + runner) and `state-facts.ts` (pure decisions), as one
whole-business notification per fact (userId NULL) via the engine's `notify()`; deep links are internal paths checked
against the category's prefixes (`catalog.ts` `safeHref`). Catalog entries: `lib/notifications/catalog.ts:259-342`.

| | Source (read-only) | Fires when | Never fires when | Dedupe key (stage) | Resolved when | Catalog |
|---|---|---|---|---|---|---|
| **A** obligations | the secretary's REAL store per `SECRETARY_LEDGER_STORE` (`obligations.deps.ts:40`): legacy `obligation-store.prisma.ts:139` or ledger `obligation-store.ledger.ts:393` with the DERIVED state of `toObligationRecord` (:98 — paid / handled / released ⇒ not OPEN); in legacy mode also the ledger's own commitments (`legacyObligationId` NULL; backfilled copies are not read twice). Reader `state-producers.ts:68`, decision `state-facts.ts:65` | OPEN and its due DAY (business time zone) is today, or it is overdue: stage `due`, `late1` (days 1–2), `late3` (3–6), `late7`, then `late14`, `late21`, … | not yet due; MET / RELEASED; postponed (followUpAt in the future) | `st:obligations.due:<type>:<id>:<dueDay>:<stage>` — a stage is told once (cooldown 7 days ≥ the longest stage) | the obligation is handled / paid / released / postponed, or moves to its next stage (the previous stage row resolves) | normal, **in-app + digest, no push**, cooldown 168 h, TTL 12 h, href `/secretary` (ledger-own: `/payables`) |
| **B** payments | `PaymentRequest` + `PaymentTransaction` statuses, the other requests of the same billing document / customer, `BillingPaymentAllocation` (`state-producers.ts:95`, `state-facts.ts:119`) | TERMINAL only: FAILED on a link that was really sent (`paymentUrl`), or the link's lifetime ended > 24 h ago with no verification PENDING | PAID (status or a PAID transaction); another request of the same document PAID; a receipt allocation covers the document; the owner already re-asked (newer PENDING request) or CANCELLED; link-creation failure (the owner saw it on screen); expiry inside the 24 h grace | `st:payments.request_failed:payment_request:<id>:<failed\|expired>` | paid by any path, re-asked, cancelled. A request terminal for more than 7 days is never announced (only kept resolvable) | high, **push**, cooldown 72 h, TTL 12 h, href `/payments/<id>` |
| **C** ITA allocation | `BillingAuthoritySubmission` + the authority's own `isAuthorityOutcomeUncertainErrorCode` (`state-producers.ts:142`, `state-facts.ts:191`) | FAILED, REJECTED, SUBMITTED with the outcome-uncertain code, HELD without a reported decision, or READY / PENDING / SUBMITTED with no movement for **60 min** (`ALLOCATION_STUCK_MS` = 4 × the execution service's own 15-min in-flight staleness) | integration off: `BILLING_AUTHORITY_RUNTIME_ENVIRONMENT` ≠ PRODUCTION, or the pilot (`BILLING_AUTHORITY_PRODUCTION_PILOT_BUSINESS_IDS` / `_OPERATIONS`) does not admit the business for `approval` (`state-producers.ts:131`) — then nothing is read and nothing resolved; a request moving within the last 60 min | `st:billing.allocation_failed:billing_authority_submission:<id>:<problem>` | APPROVED / NOT_REQUIRED / HELD decision reported (stuck → failed is a new key) | high, **push**, cooldown 24 h, TTL 12 h, href `/billing/<documentId>` |
| **D** document processing | `Document.status = 'failed'` (`state-producers.ts:156`) — the pipeline (`process-document-pipeline.service.ts:236`) never retries on its own; only the "retry" action (`app/api/documents/[id]/process`) re-runs it | status `failed` | `processing`, `needs_review` (OCR failure lands there and is the review queue's) | `st:documents.processing_failed:document_processing:<id>` | retried (processing), succeeded, deleted | normal, **in-app + digest**, cooldown 72 h, TTL 12 h, href `/documents/review/<id>` |
| **E** appointments | `Appointment` CONFIRMED, not BLOCK, not erased (`state-producers.ts:166`, `state-facts.ts:269`); time zone `BookingSettings.timeZone` else Asia/Jerusalem (`preferences-store.ts` `businessTimeZone`) | starts within the lead (catalog default **60 min**); created only while ≥ 30 min remain (start − TTL), so the owed push can never outlive the start | cancelled / completed / no-show / proposed; started; BLOCK | `st:appointments.upcoming:appointment:<id>:<startsAt ISO>` — a move is a new key | cancelled, moved (old key), started | high, **push**, cooldown 24 h, **TTL 30 min**, href `/calendar` |

**Timing precision of E (per-user lead, migration 20261213090000).** Each user chooses the lead
(`NotificationSettings.appointmentReminderMinutes`: 30 / 60 / 120 minutes or 1440 = the same local time the day before;
NULL = 60; settings screen "מתי להזכיר לפני תור"). The sweep creates ONE reminder per user per appointment start
(`st:appointments.upcoming:appointment:<id>:<startsAt ISO>:u<user>:l<lead>`) only inside [moment − one sweep interval
(15 min), moment + half the lead], with its owed push due at the moment (`nextAttemptAt` — the worker's due list and
claim both require it) and expiring at the start. The 5-minute worker therefore delivers it 0–5 minutes after the
moment whatever the sweep's phase (`state-producers.test.ts` precision check; `docs-appointments.db.test.ts` with the
real sweep and worker). Cancel / move / lead change ⇒ the key is absent ⇒ resolved, and the owed push is suppressed
('resolved') when its moment comes. No quiet-hours bypass (decided conservatively: the time was set by whoever booked,
not chosen by the user as a reminder): deferred to the quiet end, dropped if that is after the start.

**D — stuck documents.** `Document.statusChangedAt` is stamped by a database trigger (insert, real status change, the
retry's write of `processing`); a document still `processing` more than 30 minutes after its attempt started is stuck
(6 × the longest attempt window: the pipeline runs in `after()` of routes with maxDuration 60 s / 300 s and never retries
by itself). Same category as `failed`, key `…:<id>:stuck:<attempt start ISO>`; in-app + summary, no push by default.
Rows older than the migration have no stamp and are never flagged.

### Where a notification meets the secretary / home / badges — duplicate or not

| Fact | Already shown by | Notification default | Why this is not an unnecessary duplicate |
|---|---|---|---|
| Obligation due / overdue | secretary briefing (`obligation.service.ts:461`), agenda `supplier_payment` (`lib/services/tasks/sources.ts`), payables badge (`nav-signals.ts:86-90`), Attention payables items | **in-app + digest, never push** | The secretary is a screen the owner opens; the notification adds exactly ONE outside touch a day — the 08:00 summary — and only on the due day and at the overdue stages (1, 3, 7, weekly), never daily. It is never pushed on its own, so the owner is not told twice the same day. Same store, same state as the secretary (`getBriefing` reads the same `obligationServiceDeps` store), so the two cannot disagree. |
| Payment request failed / expired | payments nav dot (`nav-signals.ts:83`), collection "attention" bucket (`collection-view.ts:45`) | push | The dot is visible only inside the app; a failed customer payment is money the owner must chase now. No task/agenda item exists for it. |
| ITA allocation problem | the document screen only (`lib/billing/authority-document-state-display.ts`) | push | Nothing else surfaces it; the invoice cannot be delivered until a person acts. |
| Document processing failed | the documents inbox row status; NOT in Attention or the agenda (the agenda `documents_queue` counts `needs_review` only) | in-app + digest | No other surface outside the documents screen; low urgency, so no push. Distinct from the review-queue row (that one counts `needs_review`; a `failed` document is not in it). |
| Upcoming appointment | the calendar and the secretary's today view (`secretary-hub-data.ts` lists appointments) | push | Different job: the views list the day; the reminder is time-triggered, once per appointment start. |
| Billing review, supplier drafts | Attention, agenda `invoice_review` | digest | as before (§6 / §8) |
| Lead follow-ups | Attention, leads badge, agenda `lead` | in-app | as before (§1): the bell is the history, the badge is a count |
| Critical stock | inventory "קריטי" label, agenda `stock` | push | as before (§8) |

## 1. לידים ולקוחות — Leads & customers

| Fact | Needs? | Channel | Existing | Overlap | Action | Catalog key | Wired by |
|---|---|---|---|---|---|---|---|
| Lead attention: follow-up overdue / customer called / customer wrote (HIGH), follow-up due today / awaiting decision / new & untouched (MEDIUM) — `lib/services/crm/lead-attention.ts:209-300`, queue `lib/services/crm/lead-attention-queue.ts:161` | yes | in-app (policy `leads` rules, 24 h cooldown) | Attention, leads badge (`nav-signals.ts:125`), agenda `lead` source (`sources.ts:245`) | the bell row duplicates the badge / agenda by design (the bell is the history; the badge is a count) | yes | `leads.follow_up` (no feature key) | **status sweep** (this PR); resolved when the lead leaves the queue (complete read only) |
| Quote with no activity / stalled lead (LOW) — `lead-attention.ts` | no | — | Attention, agenda | — | soft | — | not wired: policy has no LOW rule (silence by default) |
| New lead created — `lib/services/crm/lead.service.ts:476`, `lib/intake/routing/lead-destination.ts:141` | covered as state | in-app | NEW_UNHANDLED reason above | — | yes | `leads.follow_up` | covered by the sweep through the NEW_UNHANDLED reason; an instant per-lead event is not wired (acquisition sources are OFF by default; polling is acceptable for an in-app item) |

## 2. יומן ותורים — Calendar & bookings

| Fact | Needs? | Channel | Existing | Overlap | Action | Catalog key | Wired by |
|---|---|---|---|---|---|---|---|
| Public booking request pending / auto-confirmed — `lib/services/booking/public-booking.service.ts:440-441` | yes | push + in-app | `booking-notify.ts:52/57`, reminder push every 2 h `booking-sweep.service.ts:71` | booking pending count `booking-admin.service.ts:223` | pending: yes | `booking.request_waiting` [public_booking, OFF] | existing (#1146 routes its push through the shared sender) |
| Customer cancelled — `public-booking.service.ts:544` | yes | in-app | `notifyCustomerCancelled` | — | no | (booking domain row) | existing |
| Request expired / declined / approved — `public-booking.service.ts:292`, `booking-settle.ts:26`, `booking-admin.service.ts:275` | resolve only | — | resolves the notification | — | — | — | existing |
| Ordinary appointment upcoming (CONFIRMED, not BLOCK) — `Appointment.startsAt`, reader `lib/notifications/producers/state-producers.ts:166` | yes | push (TTL 30 min; quiet hours deferred, dropped after the start) | none | calendar, secretary today view | attend | `appointments.upcoming` [appointments, ON] | **state producer E (this PR)**: 60 min before (catalog default), cancelled / moved / started ⇒ resolved; a move is a new key (start time in the key) |

## 3. משימות ותזכורות — Tasks & reminders (`daily_tasks`, ON)

| Fact | Needs? | Channel | Existing | Overlap | Action | Catalog key | Wired by |
|---|---|---|---|---|---|---|---|
| Task reminder due — `task-reminders.service.ts:54/71`, cron `app/api/task-reminders/dispatch/route.ts:26` | yes | push (quiet bypass: user-set) + in-app | reminder loop | tasks badge (`nav-signals.ts:106`) | yes | `tasks.reminder` [daily_tasks] | existing; push via the shared sender (#1146) |
| Task overdue / due today | no separate | — | tasks badge, agenda | — | yes | — | not wired: the user already got the reminder they set; a second notice would duplicate it |

## 4. המזכירה החכמה — The smart secretary (`app/(shell)/secretary`, agenda)

The secretary is a VIEW over the agenda sources (`lib/services/tasks/sources.ts:73-394`: supplier_payment,
customer_debt, invoice_review, quote_validity, quote_followup, lead, conversation, documents_queue, stock). None of the
sources writes a notification, and none should: every source is a projection of a fact that is covered (or
deliberately silent) in its own domain section. Notifying from the agenda as well would duplicate the domain row.

| Fact | Needs? | Channel | Existing | Overlap | Action | Catalog key | Wired by |
|---|---|---|---|---|---|---|---|
| Obligation due / overdue / postponed — `lib/services/obligations/obligation.service.ts:461`, `sources.ts:73` | yes | **in-app + digest** (no push: the secretary already shows it — see §0 overlap) | agenda, payables badge | the secretary IS the surface; one 08:00 summary touch only on the due day and at the overdue stages | yes | `obligations.due` (no flag) | **state producer A (this PR)**: the secretary's real store, stages due / 1 / 3 / 7 / weekly; postponed, MET, released ⇒ resolved |
| invoice_review / documents_queue / stock / lead / conversation sources | — | — | — | — | — | — | covered in §6 / §5 / §8 / §1 / §12 |
| quote_validity / quote_followup — `sources.ts:176/217` | — | — | agenda | — | yes | — | not wired: `business_documents` is OFF by default |

## 5. מסמכים נכנסים ואישורים — Incoming documents & approvals (`documents`, ON)

| Fact | Needs? | Channel | Existing | Overlap | Action | Catalog key | Wired by |
|---|---|---|---|---|---|---|---|
| Review backlog ≥ `PAPERWORK_PENDING_MIN` — `lib/services/documents/process-document-pipeline.service.ts:157` | yes | in-app (72 h) | queue consumer from the pipeline (:278), approve route, WhatsApp intake (`documents-intake.service.ts:432`) | documents AttentionBand, agenda documents_queue | yes | `documents.review` [documents] | existing consumer; **status sweep** re-runs it as a catch-up for paths without a hook (deletion, bulk) |
| Per-document "needs review" | no | — | Attention | — | — | `documents.review` | deliberately not wired: the queue is the identity (one row, not twenty — `documents-review-queue-notifications.ts:8`) |
| OCR / extraction failed — `process-document-pipeline.service.ts:148-151` | covered | in-app | lands in needs_review → the queue | — | yes | `documents.review` | covered by the queue |
| Pipeline fatal error, status `failed` — `process-document-pipeline.service.ts:236` (no automatic retry: only `app/api/documents/[id]/process`) | yes | in-app + digest | documents inbox row | — | yes (retry) | `documents.processing_failed` [documents] | **state producer D (this PR)**; retried / succeeded ⇒ resolved. A document **stuck in `processing`** (Phase 2 killed) is NOT wired: `Document` has no `updatedAt` / processing-start column, so a just-retried old document cannot be told apart from a stuck one — needs a column (migration), follow-up |

## 6. חשבוניות, קבלות והצעות מחיר — Invoices / receipts / quotes (`billing`, ON) — PROTECTED DOMAIN

| Fact | Needs? | Channel | Existing | Overlap | Action | Catalog key | Wired by |
|---|---|---|---|---|---|---|---|
| PDF render failed — `lib/services/billing/billing-pdf.service.ts:356`, `quote-pdf.service.ts:304`; loader `lib/business-status/loaders.ts:473` | yes | **push** (12 h) + in-app; in-app only in quiet hours (policy) | Attention only | — | yes | `billing.failure` [billing] | **status sweep** (read-only; no billing file changes) |
| Billing document PENDING_REVIEW — `loaders.ts:459` | yes | in-app + **digest** (48 h) | Attention, agenda invoice_review (`sources.ts:148`) | agenda | yes | `billing.review` [billing] | **status sweep** |
| Stale drafts / stale payment links (14 days) — `loaders.ts:649/683` | no | — | Attention (WARNING) | — | soft | — | not wired: policy silent ("forgotten money" is not an interruption) |
| ITA allocation number: FAILED / REJECTED / outcome uncertain / HELD undecided / stuck > 60 min — `BillingAuthoritySubmission`, `billing-authority-submission-execution.service.ts:385-411`, threshold `state-facts.ts` `ALLOCATION_STUCK_MS` | yes | push | in-document display only (`lib/billing/authority-document-state-display.ts:64`) | — | yes | `billing.allocation_failed` [billing] | **state producer C (this PR)**, read-only, ONLY when `BILLING_AUTHORITY_RUNTIME_ENVIRONMENT=PRODUCTION` and the pilot admits the business for `approval`; APPROVED / decision reported ⇒ resolved. No authority file changed |
| Quote accepted / declined — `quote-share-state.ts:50` | no | — | — | — | — | — | not an event for the owner (the owner records it) |

## 7. תשלומים והתחייבויות — Payments & obligations — PROTECTED DOMAIN (payments / settlement)

| Fact | Needs? | Channel | Existing | Overlap | Action | Catalog key | Wired by |
|---|---|---|---|---|---|---|---|
| Payment verified PAID — `lib/services/payments/payment-verification.service.ts:388` | no | — | collection "paid" bucket | — | no | — | not wired: good news, no action; never "all money" |
| Payment request FAILED (on a sent link) / expired > 24 h unpaid — `PaymentRequest`, `PaymentTransaction`, `BillingPaymentAllocation`; `collection-view.ts:44/46` | yes | push | payments nav dot (`nav-signals.ts:83`) | badge (in-app only) | yes | `payments.request_failed` (no flag) | **state producer B (this PR)**: never when paid by any path (transaction, sibling request, receipt allocation), re-asked or cancelled; a link-creation failure is not announced (seen on screen) |
| Payment anomalies (accounting paused, refund unresolved, verification anomaly, disabled provider) — `payment-attention.service.ts:18-26` | yes (operator) | in-app | `/api/payments/attention` screen | — | yes | — | **not wired** (outside A–E): read-only sweep possible later, no protected hook |
| Payables installment OVERDUE / DUE — `lib/services/payables/payables-core.ts:223/228`, `loaders.ts:605/619` | yes | in-app + digest | Attention, payables badge (`nav-signals.ts:86`), agenda supplier_payment | secretary | yes | `obligations.due` | **state producer A (this PR)** through the secretary's store: in ledger mode every installment (derived paid / handled state); in legacy mode the ledger's OWN commitments (`legacyObligationId` NULL) — backfilled copies are the secretary's obligations and are not read twice. The `payables` business-status items stay silent in the policy (unchanged) |
| Customer debt — `sources.ts:116` | no separate | — | agenda | — | yes | — | not wired (agenda is the surface) |

## 8. מלאי וספקים — Inventory & suppliers (`inventory`, ON)

| Fact | Needs? | Channel | Existing | Overlap | Action | Catalog key | Wired by |
|---|---|---|---|---|---|---|---|
| CRITICAL_STOCK alert — `lib/services/inventory/inventory.service.ts:195/226` | yes | **push** (24 h) + in-app | inventory consumer from ~10 routes (e.g. `app/api/inventory/movements/route.ts:118`, `pos/sale/route.ts:414`) | inventory "קריטי" label (`nav-signals.ts:93`), agenda stock | yes | `inventory.critical_stock` | existing; **status sweep** re-runs the consumer as a catch-up |
| LOW_STOCK / UNMATCHED_POS_PRODUCT / suspicious correction (WARNING) — `translators/inventory.ts:38` | no | — | Attention | agenda | soft | (`inventory.attention` reserved) | not wired: policy silent for WARNING |
| Supplier purchase draft PENDING_REVIEW — `lib/services/inventory/supplier-purchase-intake.service.ts:192`, `loaders.ts:501` | yes | in-app + **digest** (72 h) | Attention only | — | yes | `suppliers.purchase_pending` [inventory] | **status sweep** |

## 9. סגירת חודש ורואה חשבון — Month close & accountant

| Fact | Needs? | Channel | Existing | Overlap | Action | Catalog key | Wired by |
|---|---|---|---|---|---|---|---|
| Period READY / NEEDS_ATTENTION / PREPARATION_FAILED / CHANGED — `lib/accountant/notify.ts:57-70,214`, sweep `lib/accountant/sweep.ts:180` | yes | in-app (72 h) | accountant notifier | Attention (`lib/accountant/attention.ts:22`) | yes | `accountant.month_close` [accountant_month_close, ON] | existing |
| Send failed / bounce — `lib/accountant/delivery.service.ts:415`, `app/api/webhooks/resend/route.ts:77` | yes | in-app (24 h) | accountant notifier | Attention | yes | `accountant.send_failed` [accountant_delivery, ON] | existing |
| Recipient complaint (spam report) — `app/api/webhooks/resend/route.ts:88`, `notify.ts:339` | yes | in-app | accountant notifier | — | yes | `accountant.send_failed` | existing writer; **classified by this PR** (was UNKNOWN in the catalog) |

## 10. Gmail / WhatsApp / מקורות לידים — Connections & lead sources

| Fact | Needs? | Channel | Existing | Overlap | Action | Catalog key | Wired by |
|---|---|---|---|---|---|---|---|
| Gmail token revoked (invalid_grant) — `lib/services/integrations/gmail/gmail-auth.service.ts:84`, `gmail-discovery.service.ts:266` | yes | in-app (24 h) | — | connections screen | yes | `connections.disconnected` [intake_status_visibility, OFF] | **#1147** (`producers/connection-notifications.ts`); restored at `app/api/integrations/gmail/callback/route.ts:262` |
| WhatsApp revoked by Meta / restored — `lib/services/integrations/whatsapp/connection.service.ts:366/258` | yes | in-app | — | — | yes | `connections.disconnected` | **#1147** |
| Lead intake paused / failed / backlog — `lib/intake/intake-sweeper.ts:299` → `intake-notifications.ts:99` | yes | in-app | intake sweeper | Attention (`intake-attention.ts:197`) | yes | `connections.disconnected` [intake_status_visibility, OFF] | existing |
| Intake recovered | no | — | — | — | no | — | silent until a rule is approved (existing decision) |

Note: `connections.disconnected` is gated on `intake_status_visibility` (OFF by default), so Gmail / WhatsApp
disconnects are silent in a business without it even when the engine is ON. Moving the gate to `gmail_import` /
`whatsapp` (both ON) is a one-line catalog change but changes who hears it — left as an owner decision.

## 11. אבטחה ומערכת — Security & system

| Fact | Needs? | Channel | Existing | Overlap | Action | Catalog key | Wired by |
|---|---|---|---|---|---|---|---|
| New device / new sign-in — `app/api/auth/login/route.ts:139` | yes | push (critical, quiet bypass) | none | sessions screen (`lib/auth/session-directory.ts`) | review | `security.new_device` | **not wired**: the auth plane is owned by the session track (#1044/45/50/57/58); the only "new browser" signal is a missing cookie — needs a design decision there, not a poll |
| Password reset (revokes all sessions) — `app/api/auth/password/reset/route.ts:46-49` | yes (email is the right channel) | — | none | — | — | — | not wired: same ownership; the signed-out user cannot see an in-app row |
| Email not verified — `lib/auth/email-tokens.ts:107-120` | no | — | settings card + banner | — | yes | — | not wired: the banner is the surface |
| Daily digest — `engine/digest.ts` | yes | push (generic, count only) | #1146 | — | — | `digest.daily` | #1146 |
| Test push — `app/api/notifications/test` | — | push | #1146 | — | — | `system.test` | #1146 |

## 12. פיצ'רים פעילים נוספים — Other active features

| Feature (default) | Fact | Decision |
|---|---|---|
| inbox (ON) | Customer waiting for a reply — `app/api/message/route.ts:442`, `lib/intake/whatsapp/whatsapp-intake.ts:399` | existing inbox consumer, in-app (12 h), `inbox.customer_waiting`; NOT swept: it resolves per conversation, never from absence (a capped list is not evidence) |
| inbox (ON) | Pending reply suggestion (`loaders.ts:309`) | silent (policy: inbox MEDIUM has no rule) |
| starter_bot (ON) | Bot hand-over (`app/api/conversations/take-over/route.ts`) | no event for the owner beyond the waiting conversation above |
| content / pricing / revenue (coupons) / reports (ON) | coupon EXPIRED (`redeem.service.ts:137`), exports | no owner-facing, action-required event; not wired |
| owner_recommendations, public_booking, business_documents, service_desk, acquisition_*, commerce_*, telephony_*, bank_file_import, pos_rivhit, knowledge_derivation, intake_status_visibility, notifications_engine (OFF) | — | stay OFF; where a category exists it is gated on its feature, so nothing is produced until the owner enables it. Service desk: infrastructure-compatible (a future category plugs into the catalog), no activation |

## Summary

| Status | Facts |
|---|---|
| **Wired before this PR** | task reminders; booking requests (OFF); inbox waiting; documents review queue; critical stock; accountant month close / send failed; lead intake (OFF); Gmail / WhatsApp disconnected (#1147, gated OFF) |
| **Wired by this PR (status sweep)** | billing PDF failed (push); billing review (in-app + digest); lead follow-ups (in-app); supplier drafts (in-app + digest); catch-up of the inventory and documents-queue consumers; classification of the accountant complaint; **state producers A–E**: obligations due / overdue (digest), payment request failed / expired unpaid (push), ITA allocation problems (push, PRODUCTION pilot only), document processing failed (digest), appointment reminders (push) |
| **Digest-only** | billing review, supplier drafts (catalog default `digest`); anything a user switches to digest, or whose push was held back (quiet / rate limit) |
| **Not wired — needs a decision or a column** | payment anomalies; document stuck in `processing` (needs `Document.updatedAt`); per-user appointment lead time (needs a settings column); new-device / password-reset security notices (session track) |
| **Not wired — deliberately** | per-document review items, stale drafts / payment links, LOW lead reasons, inventory WARNING, task overdue (duplicates), payment PAID (no action) |

## Protected paths

No protected-path hook is proposed, so no `notify/7-protected-hooks` branch was created. A–E are all STATES (a status
column, a due date, a start time) that the read-only sweep observes within one sweep interval; none needs an event
hook. The new code lives under `lib/notifications/` and only IMPORTS read-only helpers from protected directories
(`billing-authority-send-certainty.ts` `isAuthorityOutcomeUncertainErrorCode`,
`billing-authority-production-pilot.ts` `isAuthorityProductionOperationAllowedForBusiness`); it reads
`PaymentRequest` / `PaymentTransaction` / `BillingPaymentAllocation` / `BillingAuthoritySubmission` through the
tenant transaction and writes none of them. The only protected file this branch touches is the cron authority
registry test `lib/services/billing/settlement/settlement-recovery-auth.test.ts` (one route added to `CRON_ROUTES`
and `DECISION_CALLERS`, the same pattern `notify/3-engine` uses) — that edit needs the owner's approval.
