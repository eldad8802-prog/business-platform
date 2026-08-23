# Account Deletion & Erasure — Design & Retention Decision (v1, RATIFIED)

Status: **RATIFIED** (owner sign-off, 2026-08). Implements **R-Erasure**
(`docs/privacy-constitution-v1.md` §124/§130/§177). Billing-adjacent; consistent with the frozen
billing-compliance non-negotiables (`AGENTS.md`, `docs/billing-compliance-hardening-plan.md`):
introduces **no** new financial source of truth and **never** mutates or deletes issued invoices.

## 1. Why (store + privacy drivers)
- **Apple 5.1.1(v)** + **Google Play**: an account-creating app must offer **in-app** account-deletion
  initiation (Google also: web path + actual data deletion, honoring legal-retention exceptions).
  Today only an email-to-support request exists → **P0 store blocker (UI-002, runtime-confirmed)**.
- **R-Erasure**: documented erasure honoring **tax legal-retention exceptions** + an audit entry.

## 2. Ratified decisions
1. **Model = anonymize-and-retain** (hard delete is impossible — 12 `Restrict` FKs — and unlawful).
2. **Scope = whole Business + all Users.**
3. **Trigger authority = SOLE ACTIVE USER ONLY (v1).** No invented owner/role.
4. **No grace period / recycle-bin (v1)** — immediate deletion lifecycle after confirmation.
5. **Retention = statutory date/rule based**, NOT a hard-coded 7y TTL (see §4).

## 3. Three distinct concepts (must not be conflated — reflected in code + UX)
- **A. User account deletion** — the authentication identity + user PII (`User.email/name/password`).
- **B. Business operational-data erasure** — Customers, conversations/messages, CRM notes/attachments,
  operational profile PII, **integrations** (revoke), non-evidence uploads.
- **C. Legally-retained business records** — issued fiscal documents + frozen snapshots, numbering,
  audit, governance, financial evidence (bucket A + §5 classification). Retained per §4; **never used
  to run an active account**.

**UX statement (he):** "החשבון והמידע התפעולי יימחקו/יעברו אנונימיזציה; מסמכים ורשומות שהחוק מחייב
לשמור (כגון חשבוניות ומסמכי הנהלת חשבונות) עשויים להישמר לתקופת השמירה החוקית, ולא ישמשו להפעלת חשבון פעיל."

## 4. Retention rule (statutory — do NOT hard-code 7y TTL)
Retained records (bucket A + §5) are kept per Israeli bookkeeping law:
> **7 years from the end of the tax year to which the record relates, OR 6 years from the date the
> annual return for that tax year was filed — whichever is LATER.**
This is **date/rule based**. **The system currently has no reliable `taxYear` + `reportFiledAt`
source-of-truth to compute the "later-of" expiry** (`FinancialDocument` has `month/year`;
`BillingDocument` has `issuedAt`; there is **no** annual-report-filed timestamp). Therefore, in v1:
- Retained fiscal/evidence records are **kept** and **never auto-purged**.
- **No automatic purge of the fiscal bucket is implemented** — expiry is **not computable** until a
  proper retention source-of-truth exists. This is recorded as an open retention-gap
  (`privacy-constitution` P-11 / G-3/G-5); a future task adds the SoT + a governed purge job.

## 5. Buckets (from impact audit — `prisma/schema.prisma`)
**A. RETAIN — legal must-keep (never delete/mutate):** the 12 `Restrict` FKs — `BillingDocument`
(+`BillingDocumentLine`,`BillingReceiptPayment`), `BillingAuditEvent`, `BillingDocumentNumberSequence`,
`BillingPaymentAllocation`, `FinancialEvent`, `BillingAuthoritySubmission`,
`PaymentRequest`/`PaymentTransaction`/`PaymentAuditEvent`, `RiaCanonicalReferent`, `RiaPolicyLineage` —
**plus the classified bookkeeping-evidence models below.** PDF blobs referenced by `BillingDocument`
retained.

**Bookkeeping-evidence classification (ratified — moved OUT of purge into RETAIN):**
| Model | Represents | Backs FinancialRecord / expense evidence? | Class |
|---|---|---|---|
| `FinancialDocument` | uploaded financial docs (`docType`: vendor invoice/receipt/…) | Yes | **RETAIN** |
| `Document` | ingested source docs (Gmail/WhatsApp/upload), OCR; `financialRecord` relation | Yes (when financial); conservative for all | **RETAIN** |
| `FinancialRecord` | derived ledger entry (`vendorName`/`amount`/`date`/`category`) | Is the record | **RETAIN** |
| children: `ExtractedData`, `Email/WhatsAppAttachmentImport` | parsed/evidence of a `Document` | evidence | **RETAIN (with Document)** |
Embedded PII in these (`ocrText`, `vendorName`, `extractedData`) is **evidence** and is **not**
anonymized (would damage the fiscal proof). Retained by simply **not touching** them (Business row kept
→ no cascade).

**B. PURGE / ANONYMIZE — non-fiscal, non-evidence PII:** `User` (email→tombstone, name→null,
password→unusable → login fails closed), `BusinessProfile` PII (legal name, tax id, VAT, phone, email,
address, geo, logo, signature), `Customer`/`Lead`/`Deal` PII (anonymize — may be FK-referenced by
retained invoices, so anonymize the live row, **never** the invoice's frozen snapshot),
`Conversation`/`Message`(`contentText`)/`ReplySuggestion`/`MessageAnalysis`, `CrmNote`/`CrmAttachment`
(+ storage). Non-evidence operational data (inventory/pricing/tasks) may be purged in a later increment;
v1 focuses on identity + counterparty + communications PII + integrations.

**C. REVOKE — external, before/with row cleanup:** `BillingAuthorityConnection` (SHAAM — `revokedAt`),
`EmailConnection`+`OAuthToken` (Gmail), `WhatsAppConnection` (Meta), `BusinessPaymentConnection`
(Tranzila/CardCom), `POSApiKey`. AES-256-GCM at rest → clear ciphertext + set revoked markers;
provider-side revoke best-effort where a helper exists (documented; DB-clear is the guaranteed part).

## 6. Trigger authority — sole active user (v1)
Business-wide deletion is allowed **only when the business has exactly one active user AND that user is
the authenticated requester.** If `activeUsers(businessId) > 1` → **fail closed**, no destructive
action; the UI explains deletion can't be automated yet due to multiple users (support escalation
allowed, not a destructive action). No `owner=true`/new role invented; replaced later by real
BusinessMembership/Owner authority.

## 7. Backend service contract
`deleteOwnBusinessAccount({ businessId, actorUserId })` — server-only, **tenant-safe** (only the actor's
own business), **fail-closed**, **idempotent** (re-request on an already-closed tenant = no-op success).
Order: assert sole-active-user → revoke integrations (best-effort, logged) → anonymize/purge bucket B
(+ storage) → set `Business.deletedAt`/`archivedAt`(+`archivedByUserId`) → write erasure audit event.
Retain bucket A untouched. **No** call to billing mutation paths; **no** new financial source of truth.
Additive migration adds `Business.deletedAt`/`deletionRequestedAt` (nullable, expand-only, gated
`release-migrate`; `archivedAt` already exists).

## 8. UX
`Settings → חשבון ופרטיות → מחיקת חשבון`: discoverable entry; explains delete-vs-legally-retained (§3
copy); explicit non-one-click confirmation (typed confirmation / re-auth); destructive styling;
double-submit guarded; accessible + RTL. Do **not** show "החשבון נמחק" before the lifecycle reaches the
defined completion point; if async, show request-received + status. Public `/data-deletion` updated to
document the in-app flow + retention exception (no longer Meta-only).

## 9. Test plan
sole-user allowed; second active user → denied; cross-tenant → denied; unauthenticated → denied;
idempotent re-request; post-deletion login blocked; bucket-A fiscal/evidence **retained + unmutated**
(hash intact, incl. the 3 classified models); bucket-B PII anonymized; integration credentials cleared
+ revoked markers set; audit event written; Settings entry + confirmation; public page aligned.
**No real Production account deleted for QA — isolated fixture only.**

## 10. Out of scope (v1)
Native packaging; exact SHAAM/Google/Meta provider revoke API wiring (contract only); the retention
purge job + its `taxYear`/`reportFiledAt` source-of-truth (§4); full operational-table purge
(inventory/pricing/tasks); data-export / R-Access.
