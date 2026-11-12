# כיסוי התראות לפי פיצ'ר — Notification feature coverage

Owner decision 2026-11-13: notifications for ALL features active in Production before launch; listen to real
events / state only; never change business logic, money calculations, amounts, statuses, document issuance /
numbering, invoice / receipt behaviour or payment mechanisms; never bypass a guard. Features that are OFF stay OFF.

Branch stack (Draft, not merged, nothing applied): #1143 migration (`notify/2-engine-migration`), #1146 engine
(`notify/3-engine`), #1147 producers (`notify/5-producers`), **this branch `notify/6-coverage`** (status sweep + this
document). Everything here is inert until `notifications_engine` (catalog default OFF) is enabled for a business.

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

### The status sweep in one paragraph

Per live business (`notification_live_businesses`, the digest's walk) where `notifications_engine` is ON, inside that
business's tenant context: `getBusinessStatusSnapshot` → keep the items of the sweep's OWN scopes whose category's
feature is available → the existing `decideForSnapshot` → the existing `persistSnapshotNotifications` →
`resolveAbsentNotifications` per owned scope against UNCAPPED identifier sets (`lib/notifications/exhaustive-facts.ts`
— never the capped snapshot; an incomplete lead read resolves nothing) → the existing inventory and documents-queue
reconcilers as a catch-up. Owned scopes: `billing|billing_document`, `leads|lead`, `supplier|supplier_purchase_draft`.
CRON_SECRET route, not scheduled in `vercel.json` (owner decision), 45 s budget under `maxDuration = 60`, keyset
continuation (`?after=<nextAfter>`), counts-only logs. Zero domain-code changes.

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
| Ordinary appointment upcoming / changed — `lib/services/appointment/*` | later | — | none | calendar screen | — | — | **not wired**: no producer exists and no policy rule; an appointment reminder is a new product decision (time-based, like task reminders) — owner decision required |

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
| Obligation due / overdue / postponed — `lib/services/obligations/obligation.service.ts:461`, `sources.ts:73` | digest candidate | (digest) | agenda, payables badge | the secretary IS the surface | yes | — | **not wired**: payables have no policy rule (see §7) |
| invoice_review / documents_queue / stock / lead / conversation sources | — | — | — | — | — | — | covered in §6 / §5 / §8 / §1 / §12 |
| quote_validity / quote_followup — `sources.ts:176/217` | — | — | agenda | — | yes | — | not wired: `business_documents` is OFF by default |

## 5. מסמכים נכנסים ואישורים — Incoming documents & approvals (`documents`, ON)

| Fact | Needs? | Channel | Existing | Overlap | Action | Catalog key | Wired by |
|---|---|---|---|---|---|---|---|
| Review backlog ≥ `PAPERWORK_PENDING_MIN` — `lib/services/documents/process-document-pipeline.service.ts:157` | yes | in-app (72 h) | queue consumer from the pipeline (:278), approve route, WhatsApp intake (`documents-intake.service.ts:432`) | documents AttentionBand, agenda documents_queue | yes | `documents.review` [documents] | existing consumer; **status sweep** re-runs it as a catch-up for paths without a hook (deletion, bulk) |
| Per-document "needs review" | no | — | Attention | — | — | `documents.review` | deliberately not wired: the queue is the identity (one row, not twenty — `documents-review-queue-notifications.ts:8`) |
| OCR / extraction failed — `process-document-pipeline.service.ts:148-151` | covered | in-app | lands in needs_review → the queue | — | yes | `documents.review` | covered by the queue |
| Pipeline fatal error, status `failed` — `process-document-pipeline.service.ts:236` | yes (later) | in-app | **none** (not in Attention either) | — | yes (retry) | — | **not wired**: no business-status fact and no policy rule; needs a translator + rule (owner decision); no protected path involved |

## 6. חשבוניות, קבלות והצעות מחיר — Invoices / receipts / quotes (`billing`, ON) — PROTECTED DOMAIN

| Fact | Needs? | Channel | Existing | Overlap | Action | Catalog key | Wired by |
|---|---|---|---|---|---|---|---|
| PDF render failed — `lib/services/billing/billing-pdf.service.ts:356`, `quote-pdf.service.ts:304`; loader `lib/business-status/loaders.ts:473` | yes | **push** (12 h) + in-app; in-app only in quiet hours (policy) | Attention only | — | yes | `billing.failure` [billing] | **status sweep** (read-only; no billing file changes) |
| Billing document PENDING_REVIEW — `loaders.ts:459` | yes | in-app + **digest** (48 h) | Attention, agenda invoice_review (`sources.ts:148`) | agenda | yes | `billing.review` [billing] | **status sweep** |
| Stale drafts / stale payment links (14 days) — `loaders.ts:649/683` | no | — | Attention (WARNING) | — | soft | — | not wired: policy silent ("forgotten money" is not an interruption) |
| ITA allocation number submission FAILED / REJECTED / HELD — `lib/services/billing/authority/billing-authority-submission-execution.service.ts:407-411` | yes (HELD needs a decision) | in-app | in-document display only (`lib/billing/authority-document-state-display.ts:64`) | — | HELD: yes | — | **not wired**: no business-status fact, no policy rule; state-sweepable later with a read-only translator + rule (owner decision) — NO protected hook needed |
| Quote accepted / declined — `quote-share-state.ts:50` | no | — | — | — | — | — | not an event for the owner (the owner records it) |

## 7. תשלומים והתחייבויות — Payments & obligations — PROTECTED DOMAIN (payments / settlement)

| Fact | Needs? | Channel | Existing | Overlap | Action | Catalog key | Wired by |
|---|---|---|---|---|---|---|---|
| Payment verified PAID — `lib/services/payments/payment-verification.service.ts:388` | no | — | collection "paid" bucket | — | no | — | not wired: good news, no action; never "all money" |
| Payment request FAILED / EXPIRED — `lib/services/payments/collection-view.ts:44/46` | digest candidate | (digest) | payments nav dot (`nav-signals.ts:80`) | badge | yes | — | **not wired**: no business-status fact / policy rule; state-sweepable read-only later (owner decision) |
| Payment anomalies (accounting paused, refund unresolved, verification anomaly, disabled provider) — `payment-attention.service.ts:18-26` | yes (operator) | in-app | `/api/payments/attention` screen | — | yes | — | **not wired**: same; read-only sweep possible later, no protected hook |
| Payables installment OVERDUE / DUE — `lib/services/payables/payables-core.ts:223/228`, `loaders.ts:605/619` | digest candidate | (digest) | Attention, payables badge (`nav-signals.ts:86`), agenda supplier_payment | secretary | yes | — | **not wired**: the policy has no `payables` rule (silent by design — "never all money"); adding a digest-only rule is an owner decision |
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
| **Wired by this PR (status sweep)** | billing PDF failed (push); billing review (in-app + digest); lead follow-ups (in-app); supplier drafts (in-app + digest); catch-up of the inventory and documents-queue consumers; classification of the accountant complaint |
| **Digest-only** | billing review, supplier drafts (catalog default `digest`); anything a user switches to digest, or whose push was held back (quiet / rate limit) |
| **Not wired — owner decision** | payables overdue / due (policy silent by design); payment request failed / expired and payment anomalies; ITA allocation HELD / FAILED; document pipeline `failed`; appointment reminders; new-device / password-reset security notices (session track) — each is state-sweepable read-only with a new translator + policy rule, no protected-path hook |
| **Not wired — deliberately** | per-document review items, stale drafts / payment links, LOW lead reasons, inventory WARNING, task overdue (duplicates), payment PAID (no action) |

## Protected paths

No protected-path hook is proposed. Every billing / payment fact listed above is a STATE (a status column, a render
status, a derived due date) that the read-only sweep observes within one sweep interval; none needs sub-minute
latency, and the push-worthy one (PDF failure) is not lost by waiting a sweep. Therefore no `notify/7-protected-hooks`
branch was created. The only protected file this branch touches is the cron authority registry test
`lib/services/billing/settlement/settlement-recovery-auth.test.ts` (one route added to `CRON_ROUTES` and
`DECISION_CALLERS`, the same pattern `notify/3-engine` uses) — that edit needs the owner's approval.
