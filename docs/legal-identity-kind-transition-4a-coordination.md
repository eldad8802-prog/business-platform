# "מעבר לעוסק מורשה" — coordination package for the billing / issuer-declaration track (4a)

From: legal identity track (session f3, replacing dd). Status: **proposal for 4a + owner**. Nothing here changes a 4a
file, and nothing in the legal identity PRs touches an A0 path. The owner's rule (11-20): the transition is **not
enabled in Production** before the accounting effects below are handled.

## Task list for 4a (owner decisions 2026-11-21; ready to start, no 4a session needed to read it)

Every task is A0 and owned by 4a, and each needs the owner's focused approval as usual. "Gate" = it must be merged
before `BUSINESS_KIND_TRANSITION_ENABLED` may be turned on.

| # | Task | Acceptance | Gate |
|---|---|---|---|
| T1 | **`STATUS_CHANGE` writer**: a definer function (e.g. `issuer_declaration_status_change(...)`), callable inside the transition's transaction, that inserts version+1 (`track AUTHORIZED_DEALER_INDIVIDUAL`, `vatStatus AUTHORIZED`, same id, `vatRegistrationNumber`, `effectiveFrom = now()`, `supersedesId`, current authorized user) | Chain guard passes; DZD35 is satisfied after the profile update in the same tx; old versions are untouched; lab shows exempt-declared business → transition → declaration v2 + profile in sync | Yes (until then the transition refuses with `ISSUER_DECLARATION_ACTIVE`) |
| T1a | **`IssuerReauthMethod` gains `GOOGLE`** (enum migration), or an owner-approved alternative for Google-only declared businesses | Google-only declared owner can transition | Yes, for Google-only declared businesses |
| T2 | **Uniform export (מבנה אחיד), historical periods**: header and record identity per period. Before `confirmedAt` → the exempt values; after → the authorized values (from each document's `issuedSnapshot`, or the `BusinessKindTransition` row). A rule for a period that straddles the transition | Lab: export of a pre-transition month run after the transition shows NO VAT number / exempt status; a post-transition month shows the authorized values; a straddling month follows the agreed rule | **Yes (owner 11-21)** |
| T3 | **Open 0%-VAT drafts must be reviewed before issuing** (owner 11-21: a requirement, not a notice): after the transition, a draft created while exempt with 0% lines cannot be issued until the owner opens it and confirms or changes its VAT (a per-draft "reviewed" mark, server-side, checked before numbering) | Lab: draft with 0% created before the transition → issue refused with a clear Hebrew message → after review → issues; drafts created after the transition unaffected | Yes |
| T4 | **Gap list for an early status date**: a read-only query for the documents issued between `statusEffectiveDate` and `confirmedAt` (count + list, issued only), plus a screen or section that shows them. No change to any document | Matches the mockup's warning (step 1, step 3, success "what now") with real numbers; no write path | Yes (the transition screens show this count) |
| T5 | **Numbering continuity lab**: exempt business issues receipts → transition → tax invoice starts at 1 (or a declared `BillingSeriesOpening`), receipts continue, credit notes continue, old PDFs re-render byte-identical | All assertions pass | Yes |
| T6 | **User-facing messages**: replace "בקשת תיקון מבוקרת" / "לפנות לתמיכה" in `confirm-screen.tsx:175`, `declaration-screen.tsx:360`, `billing.ts lockedNote` with the new rule; retire the `LEGAL_IDENTITY_CORRECTION_ENABLED` link | Owner-approved wording; no text mentions a correction request | Yes |
| T7 | **Same taxpayer in a new business file (Path B)**: the new file restarts numbering at 1 for the same id number. Offer a `BillingSeriesOpening` on the new file's first issuance when another file with the same id number exists | Owner decision on whether it is a prompt or a requirement | No (Path B), but before Path B is promoted |
| T8 | **Re-evaluate #1183** (forward technical correction after issuance) against the "no correction" rule | Owner decision: close, or keep for technical fields only | No |

Legal identity track dependencies: the transition calls T1 inside its transaction (a small follow-up migration on the
legal identity side once T1 exists), and the screens read T4's count.

## What the legal identity track ships (Drafts, not merged)

- Migration `20261221090000_business_kind_transition` (PR: db/business-kind-transition):
  - append-only `BusinessKindTransition` table (one row per business);
  - definer function `business_kind_transition_to_authorized(...)`:
    - exempt → authorized only, same entity;
    - VAT number = id number;
    - two dates: `statusEffectiveDate` (declared, ≤ today) and `confirmedAt` (now);
    - one transaction.
  - It **refuses with `ISSUER_DECLARATION_ACTIVE`** when the latest issuer declaration is live. The owner bypasses
    DZD35 too, so without this refusal the profile could drift from the declaration. Lab: 52/52.
- Code (PR #1204): routes behind `BUSINESS_KIND_TRANSITION_ENABLED` (OFF → 404), password / Google re-auth proof,
  pure core, tests.
- After a transition, the profile has `billingBusinessKind = AUTHORIZED_DEALER` and `billingVatNumber = billingTaxId`.
  Legal name, tax id and `legalIdentityConfirmedAt` are untouched.

## Items for 4a (owner: "do not do 4a's work without approval")

### 1. `STATUS_CHANGE` declaration version

Today a business with a live declaration cannot transition at all. Proposed contract, for 4a to accept or amend:
- in the SAME transaction, before the profile update, INSERT version+1 with:
  - `kind = 'STATUS_CHANGE'`, `track = 'AUTHORIZED_DEALER_INDIVIDUAL'`, `vatStatus = 'AUTHORIZED'`;
  - same `legalForm` / `idType` / `idNumber`;
  - `vatRegistrationNumber` = the new VAT number;
  - `supersedesId` = current;
  - `effectiveFrom` = now() — see item 2 for why not the declared date;
  - `declaredByUserId` = `authorizedUserId` = current authorized user (DZD33);
  - `reauthMethod` = PASSWORD or …;
  - `statementVersion` / `statementSha256` per 4a's canonical text.
- **Blocker:** `IssuerReauthMethod` has no `GOOGLE` value (it has PASSWORD, EMAIL_LINK, PLATFORM_ADMIN_ELEVATION).
  A Google-only owner with a declaration needs either a new enum value (4a migration) or EMAIL_LINK for this path.
- Options:
  - (a) 4a adds a definer `issuer_declaration_status_change(...)` and dd's function calls it — one transaction, each
    track owns its table; recommended.
  - (b) dd's function writes the row directly — mixes ownership.
- The chain guard already allows exactly this shape (DZD31 checks pass: VAT status changes, same identity).

### 2. Status start date earlier than the Dubiz update (owner: present a safe solution before the accounting part)

Facts:
- Documents issued as exempt between `statusEffectiveDate` and `confirmedAt` stay exactly as issued (DZ010; owner
  rule).
- Dubiz never issues retroactively.
- The issuer chain refuses `effectiveFrom` earlier than the current version's (DZD31), and #1117 bounds it to "now".
  A back-dated declaration version would therefore also need a 4a decision.

Proposal (safe, nothing automatic):
- (i) Record both dates. This is done in the migration.
- (ii) After the transition, show a read-only **gap notice**:
  - "between `<statusEffectiveDate>` and `<confirmedAt>`, N documents were issued as עוסק פטור";
  - a link to the list;
  - text that Dubiz did not change them and that their treatment (for example new documents for those
    transactions, or reporting) is decided with the accountant.
  - Counting reads `BillingDocument` (issuedAt, documentType, status): an **A0 read** → 4a owns the query, or approves
    a read-only helper.
- (iii) No credit notes, re-issues or VAT recalculation by Dubiz. Any future "issue a tax invoice for a past
  transaction" is a separate owner + 4a decision.
- (iv) The declaration `effectiveFrom` stays "now" (the Dubiz moment). The declared start date lives in
  `BusinessKindTransition` and is shown in the business's history.
- Open for owner + accountant: whether the gap notice must block anything. Recommendation: **no**, inform only.

### 3. Uniform export (מבנה אחיד) for historical periods

- `uniform-export-loader.ts` reads `billingBusinessKind` / `billingVatNumber` / `billingTaxId` **live from the
  profile**. An export of a pre-transition period, run after the transition, would print the new VAT status and number.
- Proposal: for the header fields, use the issuer snapshot of the documents in the period (`issuedSnapshot.issuer*`,
  frozen). Or use the `BusinessKindTransition` row: before `confirmedAt` → exempt values; after → authorized.
- A period that straddles `confirmedAt` needs a rule (split, or snapshot per record).
- 4a / owner decision; A0.

### 4. Open drafts and VAT defaults

- `document-view-model.ts` defaults new lines to 0% for exempt and the standard rate otherwise. This is client-side
  only; no server rule ties VAT to the kind.
- Drafts created while exempt keep their 0% lines. If issued after the transition, the snapshot says AUTHORIZED with
  0% lines.
- Proposal:
  - on the first billing visit after the transition, a notice lists open drafts with 0% lines and asks the owner to
    review each one;
  - optionally block issuing such a draft until it is opened and saved once — 4a decision.
- `use-business-kind` / banners cache the kind: a reload is enough. A server-pushed refresh is optional.

### 5. Messages that point to a "correction request" or to support

These contradict the new rule (owner 11-20: no correction mechanism; Path B = new business file):

| File | Owner | Current text |
|---|---|---|
| `app/billing/issuer-declaration/confirm/confirm-screen.tsx:175` | 4a (A0) | "…שינוי שלהם — רק בבקשת תיקון מבוקרת." |
| `app/billing/issuer-declaration/declaration-screen.tsx:360` | 4a (A0) | "תיקון — רק בבקשה מבוקרת." |
| `lib/i18n/messages/areas/billing.ts:440` `lockedNote` | billing | "…לתיקון פרטים חוקיים יש לפנות לתמיכה." |
| `lib/legal-identity/lock.ts:22` | legal identity | "…לתיקון פרטים חוקיים יש לפנות לתמיכה." |
| `lib/billing/issuer-declaration/config.ts:20` `LEGAL_IDENTITY_CORRECTION_ENABLED` link | 4a | links to `/business/legal-identity/correction` (never built) |

Proposed wording (owner to approve):
- "סוג העסק, השם המשפטי ומספר העוסק / ח״פ לא משתנים לאחר האישור. מעבר מעוסק פטור לעוסק מורשה — דרך ״מעבר לעוסק
  מורשה״. שם או מספר אחר — בתיק עסק חדש."
- Retire the correction link and its flag.

### 6. Numbering continuity

From the investigation, not yet lab-proven on a transitioned business:
- One counter per (business, documentType).
- After the transition, `TAX_INVOICE` / `TAX_INVOICE_RECEIPT` have no counter → the first one is 1, or a
  `BillingSeriesOpening` if declared (allowed while unused).
- `RECEIPT` / `CREDIT_NOTE` continue.

Proposed 4a lab case: exempt business issues 2 receipts → transition → issues tax invoice (expect no. 1), receipt (expect
no. 3), credit note. Old PDFs are re-rendered byte-identical from the snapshot, and the allocation gate applies to the
tax invoice.

### 7. Also affected (FYI)

- **#1183** (forward technical correction after issuance) was built for the old correction-request concept. Re-evaluate
  with the owner.
- **Exempt draft "+ צור חשבונית"** hidden by `business_documents`: after the transition the kind is AUTHORIZED, so it
  appears. Expected.

## Proposed order to Production

1. Legal identity migration: preflight → merge + release → evidence 11/11.
2. 4a: items 1, 3, 4, 5 and 6 (and the gap notice in 2) merged.
3. Legal identity code merged, flag still OFF.
4. Owner enables `BUSINESS_KIND_TRANSITION_ENABLED` after a real-phone test on a test business.
