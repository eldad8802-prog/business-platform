# Account Deletion & Erasure — Design & Retention Decision (v1, awaiting ratification)

Status: **DRAFT — awaiting owner/legal ratification.** No code written against this yet.
Operationalizes **R-Erasure** in `docs/privacy-constitution-v1.md` (§124/§130/§177) for the
self-service account-deletion path required by the app stores. Billing-adjacent; must stay
consistent with the frozen billing-compliance non-negotiables (`AGENTS.md`,
`docs/billing-compliance-hardening-plan.md`) — it introduces **no** new financial source of
truth and **never** mutates or deletes issued invoices.

## 1. Why (drivers)
- **Apple App Store 5.1.1(v)** and **Google Play** require an app that creates accounts to offer
  an **in-app account-deletion initiation** (Google also requires a web path + actual data
  deletion, honoring legal-retention exceptions). Current state: only an email-to-support request
  on `/data-deletion` — **P0 store blocker** (audit finding UI-002, runtime-confirmed).
- **privacy-constitution R-Erasure**: a documented erasure workflow that **honors legal-retention
  exceptions (tax)** and writes an audit entry — distinct from the unwired `Business.archivedAt`.

## 2. Ratified decisions (this pass)
1. **Model = anonymize-and-retain** (not hard delete). A naive `business.delete()` is impossible
   anyway — 12 `Restrict` FKs block it — and destroying them would violate Israeli tax retention.
2. **Scope = whole Business + all its Users** (flat one-business tenancy; almost all data hangs off
   `businessId`).
3. **Doc-first**: ratify this before implementing.

## 3. Model — what "מחיקת חשבון" does
On confirmed deletion of a Business, in one tenant-safe, idempotent, fail-closed transaction/service:
1. **Mark** the tenant closed: set `Business.archivedAt = now()` (+ a new `deletedAt`/`deletionRequestedAt`
   marker and `archivedByUserId`). This wires the currently-unused soft-delete field.
2. **Revoke** every external integration credential (see §6) — provider-side revoke, then row cleanup.
3. **Purge / anonymize** all non-fiscal PII (see §5, bucket B).
4. **Retain** the legally-required fiscal/governance records unchanged (see §5, bucket A).
5. **Block login**: anonymize the `User` credential rows so `verifyAuthToken → findUnique` fails
   closed. Auth is a **stateless bearer JWT with no session store**, so there is nothing to revoke
   server-side; anonymizing/clearing the `User` (email → tombstone, `password` → unusable) makes all
   existing tokens resolve to a non-existent/closed user.
6. **Audit**: write one erasure audit event — *what categories were erased, when, by whom* — never the
   erased content (per R-Erasure).

## 4. Critical legal nuance (must hold)
An **issued** tax document legally freezes counterparty + business identity inside
`BillingDocument.issuedSnapshot` (`legalSnapshotHash`, allocation number, signed-PDF artifact).
**Anonymization MUST NOT touch PII that is frozen inside a retained fiscal record** — the invoice is
the legal record and its integrity/hash must survive. We anonymize the **operational** rows
(`Customer`, `BusinessProfile`, `Message`, uploads), **not** the historical identity captured inside
retained invoices. This keeps erasure lawful *and* keeps tax records valid.

## 5. The three buckets (from the impact audit — `prisma/schema.prisma`)
**A. RETAIN — legal must-keep (12 `Restrict` FKs + their children):** `BillingDocument`
(+`BillingDocumentLine`, `BillingReceiptPayment`), `BillingAuditEvent`,
`BillingDocumentNumberSequence`, `BillingPaymentAllocation`, `FinancialEvent`,
`BillingAuthoritySubmission`, `PaymentRequest`/`PaymentTransaction`/`PaymentAuditEvent`, and the RIA
governance rows (`RiaCanonicalReferent`, `RiaPolicyLineage`). Signed/unsigned PDF blobs referenced by
`BillingDocument` are retained. **Not deleted, not mutated.**

**B. PURGE / ANONYMIZE — non-fiscal PII (Cascade off Business):** `User` (email→tombstone,
password→unusable, name→null), `BusinessProfile` (tax id, phone, email, address, geo, logo,
signature), `Customer`/`Lead`/`Deal`/`Party`/`CrmNote`/`CrmAttachment`, `Conversation`/`Message`
(`contentText`)/`MessageAnalysis`/`ReplySuggestion`, content/AI (`ContentRun/Event`,
`Recommendation`, `LearningEvent/Signal`, `VendorLearning`), inventory/supplier/PO, pricing, tasks,
appointments, obligations, feature access, bot config. Uploaded **non-fiscal** blobs
(`Document`/`FinancialDocument`/`ExtractedData`, `CrmAttachment.storageKey`, email/WhatsApp attachment
imports) purged from external storage too. *(Whether these bookkeeping source docs are themselves
retention-required is an open legal question — see §8.)*

**C. REVOKE — external, before/with row cleanup:** `BillingAuthorityConnection` (SHAAM OAuth — has
`revokedAt`; call authority revoke), `EmailConnection`+`OAuthToken` (Gmail — Google revoke),
`WhatsAppConnection` (Meta), `BusinessPaymentConnection` (Tranzila/CardCom), `POSApiKey`. Credentials
are AES-256-GCM at rest — DB delete ≠ provider revoke, so revoke first, best-effort, then clear rows.

## 6. Backend service contract
`requestBusinessDeletion({ businessId, actorUserId })` (name TBD), server-only:
- **Tenant-safe** (operates only on the actor's own `businessId`), **fail-closed**, **idempotent**
  (safe to retry; a second call on an already-closed tenant is a no-op success).
- **Order**: revoke integrations (best-effort, logged) → anonymize/purge bucket B (+ storage) →
  mark `Business.archivedAt/deletedAt` → write audit event. Retain bucket A untouched.
- Introduces **no** new financial source of truth; does **not** call billing mutation paths that
  would alter issued documents. Reconciled with `docs/billing-compliance-hardening-plan.md`.
- A schema migration adds the lifecycle marker(s) (`Business.deletedAt` / `deletionRequestedAt`) —
  additive/nullable/expand-only, gated `release-migrate` (no destructive DDL).

## 7. UX
`Settings → חשבון ופרטיות → מחיקת חשבון`: explains what is deleted vs legally retained; explicit,
non-one-click confirmation (typed confirmation or re-authentication); destructive styling; prevents
double-submit; accessible + RTL. Public `/data-deletion` updated so it no longer reads as Meta-only —
it documents the in-app flow and the tax-retention exception.

## 8. OPEN — needs owner/legal sign-off before implementation
1. **Retention period.** Israeli tax law (Income-Tax bookkeeping regulations / VAT) generally requires
   retaining books & records ~**7 years** from the end of the relevant tax year — **propose 7 years**,
   but the exact period + trigger is an **accountant/legal ratification**, currently an un-ratified gap
   (`privacy-constitution` P-11 / G-3/G-5). Retained records need a documented period, not "indefinite".
2. **Bookkeeping source docs** (`FinancialDocument`/`Document`/`FinancialRecord`, currently Cascade):
   are these themselves retention-required (they may be the source of a tax deduction)? If yes, move
   them to bucket A. **Legal call.**
3. **Multi-user trigger authority.** With no owner field, *any* user of a Business can currently
   trigger business-wide deletion. Acceptable, or gate it (e.g., only if sole user, or require
   confirmation)? *(Question 2 answer leaned "whole business + all users"; confirm the trigger rule.)*
4. **Grace period / undo?** Immediate vs a short reversible window before purge.

## 9. Test plan (when implemented)
Authorization (only own tenant); cross-tenant denial; missing session; idempotent re-request;
post-deletion login blocked; bucket-A fiscal records **retained + unmutated** (hash intact); bucket-B
PII anonymized; integration revoke invoked; audit event written; Settings entry + confirmation;
public page aligned. **No real Production account deleted for QA — isolated fixture only.**

## 10. Out of scope (this doc)
Native packaging; the exact SHAAM/Google/Meta revoke API wiring (contract only here); GDPR-specific
flows beyond Israeli law; data-export ("right to access") — separate R-Access workflow.
