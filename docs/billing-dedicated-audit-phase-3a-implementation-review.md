# Billing Dedicated Audit — Phase 3A Implementation Planning Review

This document defines the final safe execution plan for Dedicated Billing Audit
Phase 3A. It is a planning artifact only: no schema changes, migrations, runtime
changes, UI work, analytics expansion, observability platform, SIEM, or
enterprise audit system are implemented by this document.

## Source Of Truth

This review follows:

- `docs/billing-compliance-tax-authority-readiness-plan.md`
- `docs/billing-compliance-implementation-plan.md`
- `docs/billing-compliance-phase-1-immutable-issued-review.md`
- `docs/billing-credit-cancellation-architecture-plan.md`
- `docs/billing-credit-cancellation-implementation-review.md`
- `docs/billing-credit-reversal-phase-2a-scope-review.md`
- `docs/billing-dedicated-audit-foundation-plan.md`
- `docs/billing-dedicated-audit-implementation-scope-review.md`

If this document conflicts with the compliance readiness plan, the compliance
readiness plan wins.

## Goal

Phase 3A should create a minimal legal traceability layer that can answer:

- who acted
- what happened
- when it happened
- which billing document was affected
- which lifecycle event occurred

It must remain:

- append-only
- immutable through service boundaries
- compliance-safe
- lightweight
- production-safe

It must not become:

- enterprise monitoring
- analytics warehouse
- event sourcing platform
- SIEM
- observability suite
- finance event stream

## Recommended Exact Phase 3A Scope

Phase 3A should implement only:

- a dedicated `BillingAuditEvent` model
- a central `lib/services/billing/billing-audit.service.ts`
- event/source constants
- stable canonical JSON hashing
- create-only transactional audit helper
- create-only best-effort audit helper
- read-only document audit timeline helper
- no changes to `LearningEvent`

Phase 3A should not yet migrate every existing `logAuditEvent()` call. Broad
service wiring belongs to later slices after the model and service foundation
are verified.

## Exact Audit v1 Schema

Add only one model in the implementation phase: `BillingAuditEvent`.

Recommended fields:

```prisma
model BillingAuditEvent {
  id                Int      @id @default(autoincrement())
  businessId        Int
  billingDocumentId Int?
  actorUserId       Int?
  eventType         String
  source            String   @default("USER")
  summary           String
  metadata          Json?
  eventHash         String
  occurredAt        DateTime @default(now())
  createdAt         DateTime @default(now())

  business        Business         @relation(fields: [businessId], references: [id])
  billingDocument BillingDocument? @relation(fields: [billingDocumentId], references: [id], onDelete: Restrict)
  actorUser       User?            @relation(fields: [actorUserId], references: [id], onDelete: SetNull)

  @@index([businessId, occurredAt])
  @@index([billingDocumentId, occurredAt])
  @@index([eventType, occurredAt])
}
```

### Deletion Behavior

- Prefer `onDelete: Restrict` for `BillingDocument` if it works cleanly with the
  current Prisma relation shape.
- Use `onDelete: SetNull` for `User`, so audit survives user deletion.
- Do not solve business-level retention/deletion in Phase 3A. Business deletion
  is a broader retention policy decision.

## Required Vs Optional Fields

Production minimum in Phase 3A:

- `businessId`
- `billingDocumentId` for document events
- `actorUserId` for user-initiated legal events
- `eventType`
- `source`
- `summary`
- `metadata`
- `eventHash`
- `occurredAt`
- `createdAt`

Keep out of Phase 3A:

- `before`
- `after`
- `ipAddress`
- `userAgent`
- `requestId`
- `previousEventHash`

### Rationale

`metadata` is required now because legal events need compact structured facts:
document number, legal snapshot hash, lock timestamp, totals, source invoice,
and PDF hash.

`before`/`after` diffs can wait because adding them too early risks noisy
payloads and storage bloat.

`ipAddress`, `userAgent`, and `requestId` require route-level context plumbing,
which would expand Phase 3A beyond the foundation.

`previousEventHash` and hash chains are useful future hardening, but not needed
for minimal serious legal traceability.

## Required Transactional Events

These events must eventually be blocking. Phase 3A should define constants and
service validation for them, while broad service wiring can wait for Phase 3B
and Phase 3C.

Legal lifecycle events:

- `BILLING_DRAFT_CREATED`
- `BILLING_DRAFT_HEADER_UPDATED`
- `BILLING_DRAFT_LINES_REPLACED`
- `BILLING_DOC_SUBMITTED_FOR_REVIEW`
- `BILLING_DOC_REVERTED_TO_DRAFT`
- `BILLING_DOC_ISSUED`
- `BILLING_CREDIT_NOTE_ISSUED`
- `BILLING_QUOTE_CONVERTED_TO_INVOICE`
- `BILLING_CREDIT_NOTE_DRAFT_CREATED`

When wired, these must be written in the same transaction as the domain state
change. If the audit write fails, the legal action should fail.

Future transactional events, not Phase 3A:

- `BILLING_PAYMENT_STATUS_CHANGED`
- `BILLING_AUTHORITY_SUBMISSION_ATTEMPTED`
- `BILLING_AUTHORITY_ACCEPTED`
- `BILLING_AUTHORITY_REJECTED`
- `BILLING_AUTHORITY_FAILED`
- cancellation/void lifecycle events

## Best-Effort Events

These should not block already-issued legal documents or PDF rendering flows:

- `BILLING_PDF_RENDERED`
- `BILLING_PDF_RENDER_FAILED`
- `BILLING_QUOTE_PDF_RENDERED`

Can wait:

- PDF viewed/downloaded
- share/send
- archive export generated
- archive view

Telemetry only:

- clicks
- page views
- filters
- preview opens
- retry interactions
- product-learning signals
- general UX behavior

## Append-Only Strategy

Phase 3A append-only enforcement should be minimal and service-boundary based:

- expose only create helpers from `billing-audit.service.ts`
- do not add update/delete service methods
- do not add audit mutation routes
- centralize Prisma writes in the audit service
- use relation delete behavior to prevent easy document/audit deletion where
  feasible
- do not add DB triggers in Phase 3A
- do not introduce event replay or event sourcing

This is enough for the current app boundary. DB-level append-only triggers can
be revisited later if direct DB write risk becomes real.

## Audit Service Scope

Phase 3A should add:

`lib/services/billing/billing-audit.service.ts`

Recommended service API:

```ts
createBillingAuditEventTx(tx, input): Promise<void>
createBillingAuditEventBestEffort(input): Promise<void>
getBillingDocumentAuditTimeline(input): Promise<BillingAuditEvent[]>
```

Service behavior:

- `createBillingAuditEventTx` throws on validation or write failure.
- `createBillingAuditEventBestEffort` logs and returns on failure.
- both create paths compute `eventHash` from stable canonical data.
- user-sourced document events require `businessId`, `billingDocumentId`,
  `actorUserId`, `eventType`, `summary`, and meaningful metadata.
- the timeline helper is read-only and scoped by `businessId + billingDocumentId`.
- no update/delete helpers are exported.

## Event Hashing Scope

Phase 3A should hash a stable canonical payload containing:

- `businessId`
- `billingDocumentId`
- `actorUserId`
- `eventType`
- `source`
- `summary`
- `metadata`
- `occurredAt`

Do not include database `id`, because it is unknown before insert. Do not
require hash chains in Phase 3A.

## Relationship To Existing Services

Current Billing lifecycle services already emit telemetry-style `LearningEvent`
records via `logAuditEvent()`:

- `lib/services/billing/billing-issue.service.ts`
- `lib/services/billing/billing-credit-reversal.service.ts`
- `lib/services/billing/convert-quote-to-invoice.service.ts`
- `lib/services/billing/billing-draft.service.ts`
- `lib/services/billing/billing-transition.service.ts`
- `lib/services/billing/billing-pdf.service.ts`
- `lib/services/billing/quote-pdf.service.ts`

Recommended migration path:

1. Phase 3A: add model/service only and verify service behavior.
2. Phase 3B: wire blocking legal events into transactional services.
3. Phase 3C: wire draft/review events and best-effort PDF events.
4. Phase 3D: verify no legal lifecycle action relies only on `LearningEvent`.

### Avoid Duplicate Writes

- Do not add separate event-building logic in every service.
- Prefer small audit metadata helper functions if duplication appears.
- If dual-writing to `LearningEvent` is kept temporarily, derive telemetry from
  legal audit facts, not the other way around.

### Avoid Audit Drift

- For issue events, audit after final number/hash/lock values exist, but inside
  the same transaction.
- For quote conversion, audit in the conversion transaction after the invoice
  row exists.
- For credit draft creation, audit in the same transaction as credit draft
  creation.
- For PDF events, audit after DB PDF metadata update succeeds.

## Relationship To LearningEvent

Clear separation:

- `BillingAuditEvent` is legal audit.
- `LearningEvent` remains telemetry/product-learning.
- `logAuditEvent()` remains best-effort and must not be treated as
  compliance-safe.
- new legal Billing functionality should not rely on `logAuditEvent()`.
- temporary dual-write is acceptable only for compatibility and should be
  explicitly labeled as telemetry.

## Failure Strategy

Blocking audit writes:

- invoice issuance
- credit-note issuance
- quote conversion
- credit-note draft creation
- draft/review lifecycle changes once wired
- future payment status changes
- future authority submission state changes

Warning-only audit writes:

- PDF render success/failure
- quote PDF render success/failure
- future share/send unless treated as legal delivery proof
- telemetry-only events

Rule:

- Legal state transitions should not commit without audit.
- Operational artifact audit should not make legal document workflows brittle.

## Retention And Export Direction

Phase 3A should be export-ready, not export-heavy:

- audit rows should be retained at least as long as issued invoices, credit
  notes, snapshots, legal hashes, and PDFs
- product UI must not expose audit deletion
- timeline helper should support future archive/detail views
- archive export endpoints can wait
- CSV/JSON export can wait
- signed exports and external immutable storage can wait

Future archive bundle should include:

- issued document facts
- issued snapshot
- legal snapshot hash
- PDF hash/storage reference
- linked credit notes
- audit timeline

## Dangerous Traps

- adding `BillingAuditEvent` but still relying on `LearningEvent` for legal
  actions
- swallowing audit failure during invoice or credit issuance
- auditing legal events after transaction commit
- adding `before`/`after` snapshots too early and creating noisy storage bloat
- missing `actorUserId` on user-driven legal actions
- audit without `billingDocumentId` for document lifecycle events
- audit metadata missing final `documentNumber`, `lockedAt`, or
  `legalSnapshotHash`
- blocking issuance on PDF audit failure
- creating duplicate legal and telemetry payload ownership
- turning audit into analytics, monitoring, or event sourcing

## Recommended Implementation Order

When implementation is approved, use this order:

1. Schema and migration:
   - add `BillingAuditEvent` only
   - add relations and indexes
   - keep all additions additive

2. Prisma generation and baseline verification:
   - `npx prisma validate`
   - `npx prisma generate`
   - migration status/deploy when approved

3. Audit service foundation:
   - add event/source constants
   - add stable JSON stringify/hash helper
   - add transactional create helper
   - add best-effort create helper
   - add document timeline query helper

4. Service-level verification:
   - create audit event transactionally
   - confirm event hash is saved
   - confirm timeline query returns scoped events
   - confirm best-effort path does not throw outward
   - confirm no update/delete service path exists

5. Stop point:
   - do not wire all Billing lifecycle services until Phase 3A foundation is
     verified
   - proceed to Phase 3B only after audit foundation verification

## What Absolutely Must Exist Before Production

Before production legal Billing use, the system must have:

- dedicated `BillingAuditEvent`
- central `billing-audit.service.ts`
- append-only create-only service boundary
- event hash for each row
- transactional audit for invoice issuance
- transactional audit for credit-note issuance
- transactional audit for quote conversion
- transactional audit for reversal creation
- audit for draft/review lifecycle changes
- best-effort audit for PDF success/failure
- no legal Billing action relying only on `LearningEvent`
- read-only document audit timeline helper
- retention direction tied to legal documents

## What Can Safely Wait

- `before`/`after` diff columns
- IP/userAgent/requestId fields
- hash chains
- signed exports
- WORM/external immutable storage
- audit UI
- advanced export filters
- SIEM integration
- analytics dashboards
- distributed tracing
- event sourcing
- payment audit wiring until payment exists
- authority audit wiring until authority readiness exists

## Phase 3A Completion Criteria

Phase 3A is complete when:

- the dedicated audit model exists additively
- the audit service can write transactional events
- the audit service can write best-effort events
- event hashes are deterministic
- document timeline reads are scoped correctly
- `LearningEvent` remains unchanged
- no audit update/delete path exists
- verification proves foundation behavior without broad Billing rewiring

## Scope Boundary

Audit Phase 3A is the foundation for legal traceability. It is not a full legal
audit migration of every Billing action yet, and it is not an enterprise audit
platform.
