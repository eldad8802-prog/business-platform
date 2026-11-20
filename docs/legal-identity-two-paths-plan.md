# Legal identity — two paths (owner decision 2026-11-20)

Status: plan + pure core only. No schema change, migration, merge, flag or Production change is made or approved by this file.

## Rule

A business file's legal identity (kind, legal name, id number) is never changed after the fact. No correction request, no approver.

- **Path A — "מעבר לעוסק מורשה":** same legal entity, same id number, same legal name; `EXEMPT_DEALER → AUTHORIZED_DEALER` inside the same business file, confirmed explicitly by the business owner in the flow.
- **Path B — new business file:** any change of legal name or id number (even one character), and any individual ↔ company move. The old file and its documents stay as they are.

Pure core on this branch: `lib/legal-identity/identity-change-policy.ts` (classifier), `lib/legal-identity/kind-transition.ts` (eligibility, input validation, acknowledgements, canonical statement + sha256, effects list). Tests: 13 + 16 checks, in `scripts/ci/test-coverage/legal-identity-two-paths.json`.

## Findings that shape the design (origin/main b4a28809)

- Identity lives on `BusinessProfile.billingBusinessKind / billingLegalName / billingTaxId` (+ `billingVatNumber`). Locked after `legalIdentityConfirmedAt` by trigger `BusinessProfile_legal_identity_lock` (DZL04); only the table owner (migration / SECURITY DEFINER function) passes.
- Issuer declaration (`20261126100000`): when a live declaration exists, `BusinessProfile_issuer_identity_lock` (DZD35) requires kind / name / tax id / VAT number to equal the latest declaration. The chain guard already supports kind `STATUS_CHANGE` (VAT status must change, same legal form / id type / id number, version+1, filed by the current authorized user). No code creates `STATUS_CHANGE` yet.
- Issued documents carry a frozen `issuedSnapshot` (incl. `extensions.billingBusinessKind`), protected by `secf_billing_document_immutable` (DZ010); PDFs render from the snapshot. A kind switch cannot alter past documents.
- Numbering: one counter per (business, documentType). After the switch `TAX_INVOICE` / `TAX_INVOICE_RECEIPT` have no counter → start at 1 (or a `BillingSeriesOpening`, allowed while unused). `RECEIPT` / `CREDIT_NOTE` continue.
- Read live, not from a snapshot: uniform export loader (`lib/services/billing/uniform/uniform-export-loader.ts`), letters. An export of a pre-switch period run after the switch would show the new VAT number → 4a to decide (A0).
- Server-side kind rule: `assertDocumentTypeAllowedForBusinessKind` refuses tax invoices for exempt. VAT 0% for exempt is a client default only.
- One user ↔ one business: `User.businessId Int` (required), `User.email @unique`, no membership table, token has no business claim, 885 uses of `user.businessId`. RLS isolation is per business (`app.current_business_id`), so a second business is isolated correctly at the database level. No SaaS Subscription model yet; feature access is per business.

## Path A — design (needs owner approval: migration)

One migration (proposed `2026122xxxxxxx_business_kind_transition`), not written yet:

1. Table `BusinessKindTransition` (append-only, FORCE RLS by businessId): `id, businessId, fromKind, toKind, taxIdAtTransition, legalNameAtTransition, vatNumber, effectiveAt, confirmedByUserId, reauthMethod, statementVersion, statementSha256, issuerDeclarationId (nullable), createdAt`. UPDATE/DELETE refused (trigger), erasure disposition = keep with business (fiscal history) — to confirm.
2. SECURITY DEFINER `business_kind_transition_exempt_to_authorized(p_user_id, p_vat_number, p_statement_sha)` granted to `app_runtime` only:
   - business from `app.current_business_id`; user must belong to it; not being deleted; advisory lock per business;
   - current kind must be `EXEMPT_DEALER`; tax id valid; VAT number valid (and = tax id, if the owner keeps that rule);
   - recompute the canonical statement server-side and compare the sha (stale → refuse);
   - if a live issuer declaration exists: INSERT version+1 `STATUS_CHANGE` (`AUTHORIZED_DEALER_INDIVIDUAL`, VAT number) in the same transaction, before the profile update (satisfies DZD35) — **4a's table; contract to agree with 4a**;
   - UPDATE profile kind + VAT number (owner rights pass DZL04); INSERT the transition row; all or nothing.
3. Route `POST /api/business/legal-identity/kind-transition` (+ GET for eligibility, statement, digest): PASSWORD re-verification (Google-only accounts: decision), 409 on stale digest, audit event. Flag `BUSINESS_KIND_TRANSITION_ENABLED` (OFF → 404).
4. UI: one action "מעבר לעוסק מורשה" on the business details screen + a 3-step flow (explain → enter id + VAT number + acknowledgements → review & confirm). Design to be shown to the owner first.

Billing touch points (A0, 4a): STATUS_CHANGE writer, uniform export period handling, warning on open 0%-VAT drafts, kind caches (`use-business-kind`).

## Path B — options (needs owner decision)

| Option | What | Schema | Effort | UX |
|---|---|---|---|---|
| B1 | New business file = new account with a different email (works today) + clear explanation screen | none | small | poor: second email, separate login |
| B2 | Multi-business membership: `BusinessMembership`, active business resolved server-side (session row), switcher, "open new business file" | yes (new table, UserIdentity, deletion split) | large | good |
| B3 | B1 now, B2 later as its own project | none now | small now | poor now, good later |

Recommendation: B3. B2 touches login, Google identity, account deletion (today deletes the whole business and anonymises its users), notifications recipients and every `user.businessId` resolution — a separate, planned project, ideally before a SaaS Subscription model is designed (per-business vs per-user plan).

## Old frozen work

| Item | Verdict |
|---|---|
| #1148 correction migration (request table, four-eyes, decide) | superseded — keep frozen, close when the owner approves |
| #1152 correction request screens | superseded; reusable pieces: `signed-in-as` helper/component, PASSWORD re-verification wiring, attachment storage pattern |
| #1154 approver console | superseded (no approver). CI red at freeze: M6 battery, i18n en chunk, verify (migration-first, tenant-table RLS, tenant-scoped access, validate, build) — not investigated further |
| #1179 preflight/evidence for #1148 | superseded; pattern reused for the Path A migration |
| `feat/legal-identity-completion-prompt` (no PR) | not needed now (32 businesses are test/pilot); keep |
| #1183 (4a) forward technical correction after issuance | depends on the old "correction" concept; 4a/owner to re-evaluate |

Copy that now contradicts the rule (to fix after approval): `lib/legal-identity/lock.ts` message ("לפנות לתמיכה"), `lib/i18n/messages/areas/billing.ts` lockedNote, 4a's declaration screens ("תיקון — רק בבקשה מבוקרת"), `LEGAL_IDENTITY_CORRECTION_ENABLED` link in 4a's declared-status screen.
