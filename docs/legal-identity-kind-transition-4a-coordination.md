# "מעבר לעוסק מורשה" — handover package for the billing / issuer-declaration track (4a)

**For:** a new 4a session (billing, issuer declaration, numbering, uniform export), with no chat history.
**From:** the legal identity track (session f3), 2026-11-22.
**Status:** handover only. **This file approves nothing.** Each 4a task needs the owner's focused approval as usual.
Billing (A0) code is changed only by 4a, never by the legal identity track.

## 1. Business context (decided — do not reopen)

Owner decisions of 2026-11-20 / 21:

- A business file's legal identity (kind, legal name, id number) is never changed after the fact. There is no
  correction request and no approver.
- **Path A — "מעבר לעוסק מורשה":**
  - the same individual moves from **עוסק פטור** (`EXEMPT_DEALER`) to **עוסק מורשה** (`AUTHORIZED_DEALER`) inside the
    same business file;
  - same legal name, same id number; the VAT number equals the id number;
  - after a server-side re-authentication (password, or Google for Google-only accounts) and five explicit
    confirmations;
  - authorized → exempt stays blocked.
- **Path B:** a different name or id number means a new business file, by a separate signup. Out of scope here except
  task T7.
- Dubiz never changes, credits or re-issues a historical document, and never issues retroactively.
- Two dates, never mixed:
  - `statusEffectiveDate` — the day the owner declares the status started at the Tax Authority; may be earlier than
    today;
  - `confirmedAt` — the moment the owner confirmed in Dubiz.
  New documents follow the new kind from `confirmedAt`.
- The feature (`BUSINESS_KIND_TRANSITION_ENABLED`) stays **OFF in Production until every task marked "Gate" below is
  merged and tested**.

## 2. What the legal identity track has built (not merged, nothing applied)

| PR | Content | State 11-22 |
|---|---|---|
| #1210 | Migration `20261221090000_business_kind_transition`: append-only `BusinessKindTransition` (one row per business, FORCE RLS, runtime SELECT only) + definer `business_kind_transition_to_authorized(user, vat, date, reauth_method, reauth_at, statement_sha)` | CI green; classifier AUTHORITY (needs an approval record); not merged |
| #1204 | API `/api/business/legal-identity/kind-transition` (GET, preview, reauth/password, reauth/google, confirm), re-auth proof `lib/auth/sensitive-reauth.ts` + `lib/auth/google-reauth.ts`, Prisma model, tests | Red only on checks that need #1210 on main |
| #1213 | UI: entry in the legal identity card on `/business` + `/business/legal-identity/kind-transition` (3 steps + success) | Stacked on #1204 |
| #1214 | CI proof only (#1210 + #1204 + #1213 joined) — **not for merge** | e2e: app 33/33, browsers 17/17, flag-off 4/4 |

What the transition writes, in one transaction:

1. `BusinessKindTransition` row.
2. `BusinessProfile.billingBusinessKind = 'AUTHORIZED_DEALER'` and `billingVatNumber = billingTaxId`.

What it never touches:

- name, id number, `legalIdentityConfirmedAt` / `legalIdentitySource`;
- any `Billing*` table;
- the issuer declaration.

**While the latest issuer declaration is live (not anonymised), the function refuses with `ISSUER_DECLARATION_ACTIVE`.**
The definer bypasses the profile lock DZD35 as table owner, so without this refusal the profile would drift from the
declaration. T1 removes this limit.

## 3. Files and models 4a will work in (A0 unless stated)

| Area | Where |
|---|---|
| Issuer declaration schema / guards | `prisma/migrations/20261126100000_issuer_declaration/migration.sql` — `BusinessIssuerDeclaration` (versioned, append-only), chain guard `issuer_declaration_chain_guard` (version+1, supersedes, `STATUS_CHANGE` requires a VAT-status change and `effectiveFrom` ≥ current; `CORRECTION` refused after issuance; DZD31/33), profile lock `issuer_profile_identity_lock` (DZD35) |
| Declaration code | `lib/billing/issuer-declaration/details.ts` (`TRACK_BY_KIND`, `REQUIRED_FIELDS_BY_KIND`, `ISSUER_IDENTITY_FIELDS`), `lib/services/billing/issuer-declaration/issuer-declaration.service.ts` (creates only `INITIAL` / `EXISTING_CONFIRMATION` today), `lib/services/billing/issuer-declaration/issuer-declaration-gates.ts`, `lib/billing/issuer-declaration/config.ts` |
| Re-auth enum | `prisma/schema.prisma` `enum IssuerReauthMethod { PASSWORD EMAIL_LINK PLATFORM_ADMIN_ELEVATION }` — **no `GOOGLE`** |
| Issuance / snapshot / numbering | `lib/services/billing/billing-issue.service.ts`: `buildIssuedSnapshot` freezes the issuer and `extensions.billingBusinessKind`; `assertDocumentTypeAllowedForBusinessKind` (exempt cannot issue `TAX_INVOICE` / `TAX_INVOICE_RECEIPT`); the counter upsert per (business, documentType) in `BillingDocumentNumberSequence`; the allocation gate. `BillingSeriesOpening` + `series_opening_apply` (20261126100000) |
| Immutability (do not touch) | `secf_billing_document_immutable` (20260926140000, DZ010) — issued documents are frozen |
| Uniform export | `lib/services/billing/uniform/uniform-export-loader.ts` and `uniform-file-builder.ts` read `billingBusinessKind` / `billingTaxId` / `billingVatNumber` **live from the profile** |
| Drafts VAT default | `lib/billing/document-view-model.ts` (exempt → 0% client default; no server rule ties VAT to the kind) |
| Kind caches (not A0) | `features/business-documents/use-business-kind.ts`, banners |
| Old wording | `app/billing/issuer-declaration/confirm/confirm-screen.tsx` ("בקשת תיקון מבוקרת"), `app/billing/issuer-declaration/declaration-screen.tsx` ("תיקון — רק בבקשה מבוקרת"), `lib/i18n/messages/areas/billing.ts` `lockedNote` ("לפנות לתמיכה"), `lib/billing/issuer-declaration/config.ts` `LEGAL_IDENTITY_CORRECTION_ENABLED` (links to a route that was never built). `lib/legal-identity/lock.ts` (legal identity track, not A0) has the same "לפנות לתמיכה" text: the legal identity track changes it together with T6 |

## 4. Constraints (binding)

- **Keep current invoice behaviour unchanged** for every business that does not transition: same documents, numbers,
  PDFs, VAT defaults, export. A0 golden / regression suites must stay green (or exceptions owner-approved one by one).
- **Never modify, credit, re-issue or renumber a historical document**, automatically or as a side effect. No
  retroactive issuance.
- No new path that bypasses DZD35, the chain guard, DZ010, the signup lock DZL04 or the re-auth rules.
- Schema / migration changes need the owner's approval and their own approval record (authority-changing migrations).
- One Production release at a time; announce before dispatching; never merge a migration while another release is
  pending.

## 5. Tasks, acceptance and tests

"Gate" = must be merged and tested before the flag may be turned on.

### T1 — `STATUS_CHANGE` writer (Gate)

- A SECURITY DEFINER function (e.g. `issuer_declaration_status_change(...)`) that the transition calls **inside its
  own transaction, before the profile update**.
- It inserts declaration version+1:
  - `kind STATUS_CHANGE`, `track AUTHORIZED_DEALER_INDIVIDUAL`, `vatStatus AUTHORIZED`;
  - same `legalForm` / `idType` / `idNumber`;
  - `vatRegistrationNumber` = the new VAT number;
  - `supersedesId` = current;
  - `effectiveFrom = now()` (see T4: the declared start date lives in `BusinessKindTransition`);
  - `declaredByUserId` = `authorizedUserId` = the current authorized user;
  - `statementVersion` / `statementSha256` per 4a's canonical text;
  - `reauthMethod` per T1a.
- **Acceptance (lab, Production role topology):**
  - exempt-declared business → transition → declaration v2 STATUS_CHANGE plus profile AUTHORIZED in sync;
  - DZD35 satisfied after the transaction;
  - v1 untouched;
  - a failure at any point rolls back both;
  - a non-authorized user, or an identity mismatch, is refused.
- **Legal identity follow-up (not 4a):** a small migration that replaces the `ISSUER_DECLARATION_ACTIVE` refusal with
  a call to T1, under its own approval.

### T1a — Google re-authentication for the declaration (Gate for Google-only declared businesses)

- `IssuerReauthMethod` has no `GOOGLE`. A Google-only owner of a declared business cannot transition.
- Options:
  - (a) add `GOOGLE` (enum migration) and accept a Google step-up proven the same way as the transition;
  - (b) an owner-approved alternative (e.g. `EMAIL_LINK` for this path).
- **Never** accept a client-side claim.
- **Acceptance:** a Google-only declared owner transitions with a fresh Google re-auth; a stale or foreign Google
  account is refused.

### T2 — Uniform export for historical periods (Gate)

- Header and record identity must be the identity in force at the relevant time, not the current profile:
  - before `confirmedAt` → the exempt values;
  - after → the authorized values.
  Source: each document's frozen `issuedSnapshot` issuer and/or the `BusinessKindTransition` row.
- A period that straddles `confirmedAt` needs an owner-approved rule.
- **Acceptance (lab):**
  - a pre-transition month exported after the transition shows the exempt status and no VAT number;
  - a post-transition month shows the authorized values;
  - a straddling month follows the rule;
  - non-transitioned businesses: byte-identical output to today (golden).

### T3 — 0%-VAT drafts must be reviewed before issuing (Gate; owner 11-21)

- After the transition, a draft created while exempt with 0% lines cannot be issued until the owner opened it and
  confirmed or changed its VAT. The check is server-side, before numbering.
- **Acceptance (lab):**
  - such a draft → issue refused with a clear Hebrew message, no number taken;
  - after review → issues;
  - drafts created after the transition, and every non-transitioned business, unchanged.

### T4 — Documents issued between the official start and the Dubiz update (Gate)

- A read-only query: documents issued between `statusEffectiveDate` and `confirmedAt` (count + list, issued only).
- A notice for the transition screens (step 1, step 3, success): "N מסמכים הופקו כעוסק פטור מאז <date> — לא ישתנו;
  כדאי לבדוק עם רואה החשבון".
- **No** change, credit or re-issue of those documents.
- **Acceptance:**
  - counts match a seeded lab;
  - no write path;
  - the legal identity screens show the real count (they currently show the generic warning).

### T5 — Numbering continuity (Gate)

- **Lab proof:**
  - exempt business issues receipts;
  - transition;
  - first `TAX_INVOICE` = 1 (or a declared `BillingSeriesOpening`);
  - `RECEIPT` / `CREDIT_NOTE` continue;
  - no duplicate or collision in any series;
  - old PDFs re-render byte-identical from their snapshots;
  - the allocation gate applies to the new tax invoices.
- **Acceptance:** all assertions pass under the Production role topology.

### T6 — Remove the old "correction request" / "support" wording (Gate)

- Replace the texts listed in §3 with the owner-approved rule:
  > "סוג העסק, השם המשפטי ומספר העוסק / ח״פ לא משתנים לאחר האישור. מעבר מעוסק פטור לעוסק מורשה — דרך ״מעבר לעוסק
  > מורשה״. שם או מספר אחר — בתיק עסק חדש."
- Retire the `LEGAL_IDENTITY_CORRECTION_ENABLED` link.
- **Acceptance:** no screen mentions a correction request; en/he messages updated; i18n proofs green.

### T7 / T8 (not gates)

- **T7:** a new business file with the same id number restarts numbering at 1 for the same taxpayer. Offer a
  `BillingSeriesOpening` at its first issuance. The owner decides: a prompt, or a requirement.
- **T8:** re-evaluate #1183 (forward technical correction) against the "no correction" rule (owner decision).

## 6. Suggested order

1. T6 (texts only).
2. T5 (lab proof only).
3. T1 + T1a (migration + code, each with its approval record).
4. T3, T2, T4.
5. Legal identity follow-up migration (call T1).
6. Owner enables the flag after an isolated Preview with a real Google account and a physical phone.

## 7. How to verify against the legal identity code

- Lab: `.bkt/lab.sh <db> --with-bkt` (needs #1210 in the tree).
- Batteries:
  - `.bkt/battery.ts` — database, 52 checks;
  - `.bkt/app-battery.ts` — API, 33 checks;
  - `.bkt/ui-e2e.mts` / `.bkt/ui-off.mts` — browsers, flag ON / OFF.
- CI: `business-kind-transition-lab.yml`, `business-kind-transition-e2e.yml`.
- Any 4a change that the transition calls must keep these green.
