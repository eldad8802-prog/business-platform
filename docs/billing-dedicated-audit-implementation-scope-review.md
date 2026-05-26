# Billing Dedicated Audit — Implementation Scope Review

This document defines the exact execution-safe scope for Dedicated Billing Audit
v1. It is a planning artifact only: no schema changes, migrations, runtime
changes, UI work, refactors, analytics system, SIEM, or event-sourcing platform
are implemented by this document.

## Source Of Truth

This scope review follows:

- `docs/billing-compliance-tax-authority-readiness-plan.md`
- `docs/billing-compliance-implementation-plan.md`
- `docs/billing-compliance-phase-1-immutable-issued-review.md`
- `docs/billing-credit-cancellation-architecture-plan.md`
- `docs/billing-credit-cancellation-implementation-review.md`
- `docs/billing-credit-reversal-phase-2a-scope-review.md`
- `docs/billing-dedicated-audit-foundation-plan.md`

If this document conflicts with the compliance readiness plan, the compliance
readiness plan wins.

## Goal

Audit v1 should add minimal serious legal traceability for Billing documents.
It must answer:

- who acted
- what happened
- when it happened
- which billing document was affected
- which lifecycle event occurred

It must remain:

- append-only
- compliance-friendly
- lightweight
- production-safe
- future-ready for archive/export

It must not become:

- telemetry platform
- analytics warehouse
- enterprise monitoring system
- SIEM
- event sourcing
- accounting or finance event stream

## Recommended Exact Audit v1 Scope

Audit v1 includes only:

- one dedicated `BillingAuditEvent` model
- one central Billing audit service
- stable event hash calculation
- transactional audit writes for legal lifecycle changes
- best-effort audit writes for PDF artifact events
- read-only document audit timeline helper
- clear separation from `LearningEvent`

Audit v1 does not include:

- audit UI
- dashboards
- analytics reports
- advanced export UI
- distributed tracing
- hash chains
- cryptographic signing
- WORM storage
- external SIEM integrations

## Minimal Schema Additions

Add only one model in Audit v1: `BillingAuditEvent`.

Recommended exact model shape for implementation:

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

  business        Business         @relation(fields: [businessId], references: [id], onDelete: Restrict)
  billingDocument BillingDocument? @relation(fields: [billingDocumentId], references: [id], onDelete: Restrict)
  actorUser       User?            @relation(fields: [actorUserId], references: [id], onDelete: SetNull)

  @@index([businessId, occurredAt])
  @@index([billingDocumentId, occurredAt])
  @@index([eventType, occurredAt])
}
```

### Why This Is The Audit v1 Minimum

- `businessId` preserves tenant boundary.
- `billingDocumentId` links legal events to source documents, invoices, quotes,
  and credit notes.
- `actorUserId` records who initiated user actions while remaining nullable for
  future jobs/system events.
- `eventType` stays a string to avoid enum migration churn.
- `source` distinguishes user/system/job/API events without a separate model.
- `summary` gives a short readable timeline line.
- `metadata` carries compact structured legal facts.
- `eventHash` gives per-row tamper evidence.
- `occurredAt` is the legal event time.
- `createdAt` is the database insertion time.

### Fields Kept Out Of Audit v1

Do not add these in Audit v1:

- `before`
- `after`
- `ipAddress`
- `userAgent`
- `requestId`
- `previousEventHash`

They are useful future additions, but they are not required for the minimal
legal audit foundation. They can be added later additively if real product,
legal, or operational needs appear.

## Required Vs Optional Fields

Required at schema level:

- `businessId`
- `eventType`
- `source`
- `summary`
- `eventHash`
- `occurredAt`
- `createdAt`

Required by service validation for document lifecycle events:

- `billingDocumentId`
- `actorUserId` when `source = USER`
- event-specific `metadata`

Optional in schema for future-safe compatibility:

- `actorUserId` for system/job/migration events
- `billingDocumentId` for future business-level Billing events
- `metadata` for migration safety, though legal events should always provide it

## Event Classification

### Transactional Events

These must be written in the same transaction as the legal state change. If the
audit write fails, the domain action should fail.

Audit v1 transactional events:

- `BILLING_DRAFT_CREATED`
- `BILLING_DRAFT_HEADER_UPDATED`
- `BILLING_DRAFT_LINES_REPLACED`
- `BILLING_DOC_SUBMITTED_FOR_REVIEW`
- `BILLING_DOC_REVERTED_TO_DRAFT`
- `BILLING_DOC_ISSUED`
- `BILLING_CREDIT_NOTE_ISSUED`
- `BILLING_QUOTE_CONVERTED_TO_INVOICE`
- `BILLING_CREDIT_NOTE_DRAFT_CREATED`

`BILLING_CREDIT_NOTE_ISSUED` should be explicit in Audit v1 even if the
underlying issuance service also records generic document issuance facts. This
keeps legal reversal timelines readable and avoids ambiguity.

### Best-Effort Events

These should be recorded, but should not roll back an already-issued document
or make PDF rendering fragile.

Audit v1 best-effort events:

- `BILLING_PDF_RENDERED`
- `BILLING_PDF_RENDER_FAILED`
- `BILLING_QUOTE_PDF_RENDERED`

Future best-effort events:

- PDF viewed/downloaded
- share link created
- document sent
- archive export generated

### Future Transactional Events

Do not implement these in Audit v1 unless the underlying feature exists:

- `BILLING_PAYMENT_STATUS_CHANGED`
- `BILLING_AUTHORITY_SUBMISSION_ATTEMPTED`
- `BILLING_AUTHORITY_ACCEPTED`
- `BILLING_AUTHORITY_REJECTED`
- `BILLING_AUTHORITY_FAILED`
- cancellation/void lifecycle events

### Telemetry Only

Keep these outside legal audit:

- page views
- clicks
- filters
- preview opens
- retry interactions
- onboarding prompts
- recommendation/product-learning events
- general UX behavior

## Required Metadata

### Document Issued

Required metadata:

- `documentId`
- `documentType`
- `documentNumber`
- `documentNumberFormatted`
- `issuedAt`
- `lockedAt`
- `legalSnapshotHash`
- `totalAmount`
- `currency`
- `customerId`
- `referenceDocumentId`
- `actorUserId`

For credit notes, include:

- `sourceInvoiceId`
- `creditedAmount`
- `remainingAmountBeforeIssue` when available

### Draft Created

Required metadata:

- `documentId`
- `documentType`
- `customerId`
- `lineCount`
- `actorUserId`

For credit-note drafts, include:

- `creditNoteId`
- `sourceInvoiceId`
- `totalAmount`
- `remainingAmountBeforeDraft` when available

### Draft Header Updated

Required metadata:

- `documentId`
- `documentType`
- `customerId`
- `customerNameSnapshot`
- `actorUserId`

Do not store full legal snapshots for draft header edits in Audit v1.

### Draft Lines Replaced

Required metadata:

- `documentId`
- `documentType`
- `lineCount`
- `subtotalAmount`
- `vatAmount`
- `totalAmount`
- `actorUserId`

Do not store all old/new line details in Audit v1.

### Review Transitions

Required metadata:

- `documentId`
- `documentType`
- `fromStatus`
- `toStatus`
- `actorUserId`

### Quote Converted To Invoice

Required metadata:

- `quoteId`
- `invoiceId`
- `actorUserId`

Recommended metadata:

- quote number if allocated
- invoice draft totals
- customer id

### PDF Rendered / Failed

Success metadata:

- `documentId`
- `documentType`
- `pdfHash`
- `pdfStorageKey`
- `pdfTemplateVersion`
- `byteLength`
- `actorUserId`

Failure metadata:

- `documentId`
- `documentType`
- `errorMessage`
- `pdfTemplateVersion`
- `actorUserId`

## Central Audit Service Scope

Future implementation should add:

`lib/services/billing/billing-audit.service.ts`

Audit v1 service API:

```ts
export type BillingAuditSource = "USER" | "SYSTEM" | "JOB" | "MIGRATION" | "API";

export type BillingAuditEventType =
  | "BILLING_DRAFT_CREATED"
  | "BILLING_DRAFT_HEADER_UPDATED"
  | "BILLING_DRAFT_LINES_REPLACED"
  | "BILLING_DOC_SUBMITTED_FOR_REVIEW"
  | "BILLING_DOC_REVERTED_TO_DRAFT"
  | "BILLING_DOC_ISSUED"
  | "BILLING_CREDIT_NOTE_ISSUED"
  | "BILLING_QUOTE_CONVERTED_TO_INVOICE"
  | "BILLING_CREDIT_NOTE_DRAFT_CREATED"
  | "BILLING_PDF_RENDERED"
  | "BILLING_PDF_RENDER_FAILED"
  | "BILLING_QUOTE_PDF_RENDERED";

export type CreateBillingAuditEventInput = {
  businessId: number;
  billingDocumentId?: number | null;
  actorUserId?: number | null;
  eventType: BillingAuditEventType;
  source?: BillingAuditSource;
  summary: string;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
};

export async function createBillingAuditEventTx(
  tx: Prisma.TransactionClient,
  input: CreateBillingAuditEventInput
): Promise<void>;

export async function createBillingAuditEventBestEffort(
  input: CreateBillingAuditEventInput
): Promise<void>;

export async function getBillingDocumentAuditTimeline(input: {
  businessId: number;
  billingDocumentId: number;
}): Promise<BillingAuditEvent[]>;
```

### Service Rules

- `createBillingAuditEventTx()` must throw on failure.
- `createBillingAuditEventBestEffort()` may catch/log errors.
- both create methods must compute `eventHash`.
- both create methods must validate business id, event type, source, summary,
  and required document/actor fields for user legal actions.
- `getBillingDocumentAuditTimeline()` is read-only and scoped by
  `businessId + billingDocumentId`.
- no update/delete service methods should exist.

## Event Hashing Scope

Audit v1 should hash a stable canonical payload containing:

- `businessId`
- `billingDocumentId`
- `actorUserId`
- `eventType`
- `source`
- `summary`
- `metadata`
- `occurredAt`

Do not include database `id` in the hash because it is only known after insert.
Do not require a hash chain in Audit v1.

## Relationship To LearningEvent

Clear Audit v1 decision:

- `BillingAuditEvent` is the legal audit source of truth.
- `LearningEvent` remains product telemetry only.
- `logAuditEvent()` may remain for non-legal telemetry and compatibility.
- new legal Billing code should not rely on `logAuditEvent()`.
- temporary dual-write is allowed only if old telemetry consumers still need
  `LearningEvent`.

Avoid duplicate responsibility:

- legal metadata should be defined by Billing audit service inputs
- telemetry payloads, if needed, should be derived from legal audit facts
- never treat swallowed `LearningEvent` writes as compliance-safe

## Append-Only Strategy

Audit v1 append-only strategy is intentionally lightweight:

- create-only service API
- no update/delete service API
- no audit mutation routes
- centralized Prisma writes in `billing-audit.service.ts`
- restrict document deletion where feasible through relation behavior
- no DB trigger in v1
- no event replay or event sourcing

DB triggers can be reconsidered later if direct DB writes become a real
operational risk.

## Retention And Export Direction

Audit v1 must be export-ready, not export-heavy.

Minimum direction:

- retain audit rows at least as long as issued invoices, credit notes, snapshots,
  hashes, and PDFs
- do not expose product deletion for legal audit rows
- support timeline query by `businessId + billingDocumentId`
- preserve structured JSON metadata for future archive bundle export

Future archive bundle should be able to include:

- issued document row
- issued snapshot
- legal snapshot hash
- PDF hash/storage reference
- linked credit notes
- audit timeline

Can wait:

- CSV/JSON export endpoint
- advanced filters
- signed exports
- immutable external storage
- accountant/legal portal

## Dangerous Traps

- swallowing audit failure during invoice or credit-note issuance
- writing legal audit after transaction commit
- blocking invoice issuance on PDF audit
- treating `LearningEvent` as legal audit
- adding broad before/after snapshots and creating noisy storage bloat
- missing actor on user-initiated legal events
- cascade-deleting audit rows through ordinary cleanup
- metadata missing final `documentNumber`, `lockedAt`, or `legalSnapshotHash`
- inconsistent event naming between invoice issue and credit-note issue
- duplicate legal/telemetry payload ownership
- UI/API exposing legal actions before transactional audit exists

## Recommended Implementation Order

When implementation is approved, use this order:

1. Schema foundation:
   - add `BillingAuditEvent`
   - add relations
   - add indexes
   - keep fields additive and migration-safe

2. Audit service foundation:
   - add event type constants
   - add source constants
   - add stable JSON hash helper
   - add transactional create
   - add best-effort create
   - add document timeline read helper

3. Critical legal lifecycle:
   - move issuance audit into the `billing-issue.service.ts` transaction
   - add explicit credit-note issue event when document type is `CREDIT_NOTE`
   - move quote conversion audit into the conversion transaction
   - move credit-note draft audit into the credit service transaction

4. Draft/review lifecycle:
   - add transactional audit to draft create
   - add transactional audit to draft header update
   - add transactional audit to draft line replacement
   - add transactional audit to submit/revert review

5. PDF artifact audit:
   - add best-effort audit for PDF rendered
   - add best-effort audit for PDF render failed
   - preserve current PDF behavior

6. Verification:
   - `npx prisma validate`
   - `npx prisma generate`
   - migration status/deploy when ready
   - targeted lint/typecheck
   - runtime smoke for invoice issue
   - runtime smoke for credit-note issue
   - runtime smoke for quote conversion
   - audit failure must block issue
   - PDF audit failure must not block PDF rendering flow

## What Absolutely Must Exist Before Production

- dedicated `BillingAuditEvent` model
- central Billing audit service
- transactional audit for invoice issue
- transactional audit for credit-note issue
- transactional audit for quote conversion
- transactional audit for credit-note draft creation
- transactional audit for draft/review lifecycle changes
- best-effort audit for PDF rendered/failed
- event hash for every audit row
- legal metadata with document number, type, `lockedAt`, `legalSnapshotHash`,
  source references, totals, actor, and timestamps
- no legal Billing action relying only on `LearningEvent`
- append-only service boundary
- read-only document audit timeline helper

## Explicitly Out Of Scope

Do not build in Audit v1:

- analytics dashboard
- user tracking platform
- distributed tracing
- SIEM integration
- event sourcing
- ledger or finance event stream
- admin audit console
- advanced audit export UI
- cryptographic notarization
- WORM/external immutable storage
- payment automation
- authority integration

The target is minimal legal traceability for immutable business documents, not
an enterprise audit platform.
