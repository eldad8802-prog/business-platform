# Billing Dedicated Audit Foundation Plan

This document defines the minimal legal audit foundation for Billing/Invoices.
It is a planning artifact only: no schema changes, migrations, runtime changes,
UI work, SIEM integration, analytics platform, or enterprise audit system are
implemented by this document.

## Source Of Truth

This plan follows:

- `docs/billing-compliance-tax-authority-readiness-plan.md`
- `docs/billing-compliance-implementation-plan.md`
- `docs/billing-compliance-phase-1-immutable-issued-review.md`
- `docs/billing-credit-cancellation-architecture-plan.md`
- `docs/billing-credit-cancellation-implementation-review.md`
- `docs/billing-credit-reversal-phase-2a-scope-review.md`

If this document conflicts with the compliance readiness plan, the compliance
readiness plan wins.

## Goal

Billing needs a dedicated legal audit path that can answer:

- who acted
- what happened
- when it happened
- which billing document was affected
- which legal lifecycle event occurred

The audit layer must be:

- append-only
- document-linked
- business-scoped
- searchable
- export-ready
- compliance-friendly

It must not become:

- event sourcing
- SIEM
- distributed tracing
- analytics warehouse
- accounting ledger
- enterprise audit platform

## Current Baseline

Billing currently writes audit-style events through `logAuditEvent()` in
`lib/services/audit.service.ts`.

That function writes to `LearningEvent` and deliberately swallows failures:

- good for telemetry
- not good enough for legal audit
- not blocking for compliance-critical document changes
- not Billing-specific
- not retention/export-ready as a legal document trail

Current Billing services already emit useful event names:

- `BILLING_DRAFT_CREATED`
- `BILLING_DRAFT_HEADER_UPDATED`
- `BILLING_DRAFT_LINES_REPLACED`
- `BILLING_DOC_SUBMITTED_FOR_REVIEW`
- `BILLING_DOC_REVERTED_TO_DRAFT`
- `BILLING_DOC_ISSUED`
- `BILLING_QUOTE_CONVERTED_TO_INVOICE`
- `BILLING_CREDIT_NOTE_DRAFT_CREATED`
- `BILLING_PDF_RENDERED`
- `BILLING_PDF_RENDER_FAILED`
- `BILLING_QUOTE_PDF_RENDERED`

These names are useful, but the storage path is still telemetry-grade.

## Recommended Minimal Audit Model

Future implementation should add a dedicated `BillingAuditEvent` model. It
should be separate from `LearningEvent` and linked directly to Billing legal
records.

Recommended future schema shape:

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
  before            Json?
  after             Json?
  requestId         String?
  ipAddress         String?
  userAgent         String?
  eventHash         String
  previousEventHash String?
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

### Model Decisions

- `eventType` should be a string in the database, with constants in code. This
  keeps future event additions additive and avoids enum migration churn.
- `billingDocumentId` should be required for document lifecycle events, but the
  column can remain nullable to allow future business-level Billing settings
  events without another migration.
- `actorUserId` should be required by service validation for user-initiated
  legal actions, but nullable in schema for system jobs, migrations, and future
  background authority attempts.
- `metadata` is required by convention for legal events, but nullable at schema
  level for migration safety and future compatibility.
- `eventHash` should be required for legal audit integrity.
- `previousEventHash` can be nullable and may remain unused in the first slice.
  A hash chain is useful later, but not required for the minimal foundation.
- `before` and `after` should be compact JSON only where they add value. Do not
  store full document snapshots for every draft edit.

## Append-Only Strategy

Minimal append-only enforcement should rely on ownership boundaries first:

- expose only create APIs from the Billing audit service
- do not implement update/delete audit functions
- do not add product routes that modify audit rows
- keep all legal audit writes centralized
- use `onDelete: Restrict` from audit to `BillingDocument` where feasible
- keep retention deletion out of regular product flows

Database triggers can wait. They are only needed if direct DB writes become a
real operational risk. The first serious boundary is that application code must
not have an update/delete path for `BillingAuditEvent`.

## Central Audit Service API

Future implementation should add a dedicated service, for example:

`lib/services/billing/billing-audit.service.ts`

Recommended API shape:

```ts
export type BillingAuditSource = "USER" | "SYSTEM" | "JOB" | "MIGRATION" | "API";

export type CreateBillingAuditEventInput = {
  businessId: number;
  billingDocumentId?: number | null;
  actorUserId?: number | null;
  eventType: BillingAuditEventType;
  source?: BillingAuditSource;
  summary: string;
  metadata?: Record<string, unknown>;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  requestId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  occurredAt?: Date;
};

export async function createBillingAuditEventTx(
  tx: Prisma.TransactionClient,
  input: CreateBillingAuditEventInput
): Promise<void>;

export async function createBillingAuditEventBestEffort(
  input: CreateBillingAuditEventInput
): Promise<void>;
```

### Transactional Writes

Use `createBillingAuditEventTx()` for compliance-critical lifecycle changes:

- invoice issue
- credit note issue
- quote converted to invoice
- credit note draft creation
- future payment status changes
- future authority submission state changes
- future cancellation/void legal lifecycle changes

These writes should happen in the same transaction as the domain state change.
If the audit write fails, the legal action should fail.

### Best-Effort Writes

Use best-effort only for operational artifact or telemetry-like events:

- PDF render success
- PDF render failure
- future share/download events unless legally treated as delivery proof

Best-effort failures should be logged with enough context, but they should not
roll back an already-issued document.

## Event Hashing

`eventHash` should be computed from a stable canonical payload, not from raw
JavaScript object ordering.

Suggested hash input:

- `businessId`
- `billingDocumentId`
- `actorUserId`
- `eventType`
- `source`
- `summary`
- `metadata`
- `before`
- `after`
- `requestId`
- `occurredAt`
- `previousEventHash`

This provides tamper-evidence for each row without requiring a full enterprise
hash-chain or external signing system in the first slice.

## Required Audit Events

### Required Before Production

Legal lifecycle:

- `BILLING_DRAFT_CREATED`
- `BILLING_DRAFT_HEADER_UPDATED`
- `BILLING_DRAFT_LINES_REPLACED`
- `BILLING_DOC_SUBMITTED_FOR_REVIEW`
- `BILLING_DOC_REVERTED_TO_DRAFT`
- `BILLING_DOC_ISSUED`
- `BILLING_QUOTE_CONVERTED_TO_INVOICE`
- `BILLING_CREDIT_NOTE_DRAFT_CREATED`
- `BILLING_CREDIT_NOTE_ISSUED`

Legal artifact:

- `BILLING_PDF_RENDERED`
- `BILLING_PDF_RENDER_FAILED`
- `BILLING_QUOTE_PDF_RENDERED`
- future `BILLING_CREDIT_NOTE_PDF_RENDERED` if credit notes get distinct PDF
  handling

Future legal states:

- `BILLING_PAYMENT_STATUS_CHANGED`
- `BILLING_AUTHORITY_SUBMISSION_ATTEMPTED`
- `BILLING_AUTHORITY_ACCEPTED`
- `BILLING_AUTHORITY_REJECTED`
- `BILLING_AUTHORITY_FAILED`
- `BILLING_VOIDED_OR_CANCELLED` only if a legally valid non-issued void/cancel
  flow is introduced

### Nice To Have Later

- PDF viewed
- PDF downloaded
- share link created
- document sent
- export bundle generated

### Telemetry Only

These should remain outside legal audit:

- page views
- clicks
- filters
- preview opens
- retry button clicks
- general UX behavior
- recommendation/product-learning signals

## Required Metadata By Event

### Issue

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

For credit notes, also include:

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

For credit-note draft:

- `creditNoteId`
- `sourceInvoiceId`
- `totalAmount`
- `remainingAmountBeforeDraft` when available

### Draft Header Updated

Recommended metadata:

- `documentId`
- `documentType`
- compact `before`
- compact `after`
- `actorUserId`

Do not store full legal snapshots for draft header edits.

### Draft Lines Replaced

Recommended metadata:

- `documentId`
- `documentType`
- previous totals if easily available
- new totals
- previous line count
- new line count
- `actorUserId`

Do not store all previous and new line details unless a later legal requirement
demands it.

### PDF Rendered / Failed

Recommended metadata:

- `documentId`
- `documentType`
- `pdfHash` on success
- `pdfStorageKey` on success
- `pdfTemplateVersion`
- `byteLength` on success
- `errorMessage` on failure
- `actorUserId`

## Existing Service Mapping

| Service | Current event | Future audit mode | Notes |
| --- | --- | --- | --- |
| `billing-draft.service.ts` | `BILLING_DRAFT_CREATED` | transactional | Draft creation creates legal work-in-progress. |
| `billing-draft.service.ts` | `BILLING_DRAFT_HEADER_UPDATED` | transactional | Store compact before/after. |
| `billing-draft.service.ts` | `BILLING_DRAFT_LINES_REPLACED` | transactional | Store line count and totals, not full line snapshots. |
| `billing-transition.service.ts` | `BILLING_DOC_SUBMITTED_FOR_REVIEW` | transactional | Lifecycle transition must not occur without audit. |
| `billing-transition.service.ts` | `BILLING_DOC_REVERTED_TO_DRAFT` | transactional | Lifecycle rollback must be traceable. |
| `billing-issue.service.ts` | `BILLING_DOC_ISSUED` | transactional/blocking | Must include number, legal hash, lock timestamp. |
| `convert-quote-to-invoice.service.ts` | `BILLING_QUOTE_CONVERTED_TO_INVOICE` | transactional/blocking | Conversion relationship is legal history. |
| `billing-credit-reversal.service.ts` | `BILLING_CREDIT_NOTE_DRAFT_CREATED` | transactional/blocking | Legal reversal intent. |
| `billing-pdf.service.ts` | `BILLING_PDF_RENDERED` / `FAILED` | best-effort legal artifact | Do not roll back already-issued documents. |
| `quote-pdf.service.ts` | `BILLING_QUOTE_PDF_RENDERED` | best-effort artifact | Quote PDF is less critical than issued invoice PDF. |

## Relationship To LearningEvent

`LearningEvent` should remain product telemetry and product-learning data.

Future responsibility split:

- `BillingAuditEvent`: legal traceability for Billing documents.
- `LearningEvent`: analytics, product behavior, recommendations, non-legal
  telemetry.

Migration strategy:

- keep `LearningEvent` unchanged
- add `BillingAuditEvent` alongside it
- initially dual-write only where product telemetry still needs old data
- stop treating `LearningEvent` as legal source of truth immediately after
  `BillingAuditEvent` exists
- do not call `logAuditEvent()` from new legal Billing services unless it is
  explicitly telemetry-only

## Failure Strategy

Blocking failures:

- invoice issue audit fails
- credit note issue audit fails
- quote conversion audit fails
- credit note draft audit fails
- future payment status audit fails
- future authority submission state audit fails

Warning-only failures:

- PDF render audit failure
- quote PDF render audit failure
- future share/download audit failure unless delivery proof becomes legal

Do not use a single best-effort logger for both categories. The service API must
make the failure mode explicit at the callsite.

## Retention And Export Direction

Retention baseline:

- retain Billing audit events at least as long as issued invoices, credit notes,
  issued snapshots, legal hashes, and PDFs
- do not expose product deletion of legal audit events
- do not cascade-delete audit rows as part of normal document cleanup

Export readiness:

- query by `businessId`
- query by `billingDocumentId`
- query by `eventType`
- query by date range
- preserve structured JSON metadata
- include audit timeline in a future archive/export bundle

Future archive bundle should be able to include:

- issued document row
- issued snapshot
- legal snapshot hash
- PDF hash and storage reference
- linked credit notes
- audit timeline

Can wait:

- signed exports
- external immutable storage
- accountant portal
- advanced audit search UI
- SIEM connectors

## Dangerous Traps

- mutable audit rows
- swallowed audit failures for legal actions
- treating `LearningEvent` as legal audit
- duplicate audit responsibility across services
- state changes committed without matching audit events
- free-text-only audit payloads
- giant before/after snapshots for every edit
- missing actor on user-driven legal actions
- audit rows deleted by cascade
- audit metadata drifting from final document state
- UI exposing legal actions before audit is durable
- PDF/share events blocking legal issuance unnecessarily

## Recommended Implementation Order

### Phase 3A — Schema And Service Foundation

- add `BillingAuditEvent` model additively
- add indexes for document/business timeline queries
- add central `billing-audit.service.ts`
- add event type constants
- add stable event hash helper
- keep `LearningEvent` untouched

### Phase 3B — Critical Legal Lifecycle

- move invoice issue audit into the issuance transaction
- move credit note issue audit into the issuance transaction
- move quote conversion audit into the conversion transaction
- move credit note draft creation audit into the creation transaction
- keep existing `LearningEvent` writes only if telemetry compatibility is needed

### Phase 3C — Draft And Review Lifecycle

- add dedicated audit for draft created
- add dedicated audit for header updates
- add dedicated audit for line replacements
- add dedicated audit for submit/revert review transitions
- keep before/after compact

### Phase 3D — Legal Artifact Audit

- add PDF render success/failure audit as best-effort
- add quote PDF audit as best-effort
- prepare future credit-note PDF event naming

### Phase 3E — Read/Export Readiness

- add document audit timeline query helper
- document retention policy
- verify no legal Billing action relies only on `LearningEvent`

## Production Must-Haves

Billing is not legal-production-ready until:

- dedicated `BillingAuditEvent` exists
- legal lifecycle audit writes are transactional and blocking
- legal audit is separate from `LearningEvent`
- issue audit includes legal number, lock time, and legal snapshot hash
- credit note audit includes source invoice relationship
- audit events are append-only through service boundaries
- audit rows are retained with legal documents
- document audit timeline can be queried/exported
- future payment and authority state changes cannot happen without audit

## Explicitly Out Of Scope

Do not build as part of the Billing audit foundation:

- SIEM integration
- analytics warehouse
- clickstream tracking
- distributed tracing
- event sourcing platform
- accounting ledger
- reconciliation event stream
- enterprise admin audit console
- cryptographic notarization
- external WORM storage

The target is minimal serious legal traceability, not an enterprise audit
platform.
