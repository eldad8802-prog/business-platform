# "מעבר לעוסק מורשה" — handover package for the billing / issuer-declaration track (4a)

**For:** a new 4a session (billing, issuer declaration, numbering, uniform export), with no chat history.
**From:** the legal identity track (session f3), 2026-11-23; updated 2026-11-24 after the T1 wiring (#1266, #1272, #1267) was
merged and applied, and again on 2026-11-25 after T4 closed (#1269 + #1279). The activation conditions are in §8.
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

## 2. What the legal identity track has built (all merged; flag OFF)

| PR | Content | State 11-22 |
|---|---|---|
| #1210 | Migration `20261221090000_business_kind_transition`: append-only `BusinessKindTransition` (one row per business, FORCE RLS, runtime SELECT only) + definer `business_kind_transition_to_authorized(user, vat, date, reauth_method, reauth_at, statement_sha)` | **MERGED 19564556 and APPLIED in Production 2026-11-22** (record #1223, release-migrate 44969899339, ledger 228, evidence 44971617659 11/11) |
| #1204 | API `/api/business/legal-identity/kind-transition` (GET, preview, reauth/password, reauth/google, confirm), re-auth proof `lib/auth/sensitive-reauth.ts` + `lib/auth/google-reauth.ts`, Prisma model, tests | **MERGED 272125bb (2026-11-22)**, live; every route answers 404 while the flag is off |
| #1213 | UI: entry in the legal identity card on `/business` + `/business/legal-identity/kind-transition` (3 steps + success) | **MERGED 8955bbce (2026-11-22)**, live; flag off → no entry, no API request, the page says not available |
| #1214 | CI proof only (#1210 + #1204 + #1213 joined) | **Closed without merge** (owner-approved); evidence kept |
| #1266 | Migration `20261225090000_kind_transition_issuer_declaration_wiring`: the transition calls the 4a T1 writer (contract `.billing-4a/T1-WIRING-CONTRACT.md` §2; code = `.billing-4a/t1-wiring.proposed.sql`); evidence files, `.bkt` wiring lab + batteries, rollback | **MERGED 29447009 and APPLIED in Production 2026-11-24** (record #1272 → b834ecb0, preflight 45317499245 12/12, release-migrate 45320505488, post-apply proof 45323806725 9/9) |
| #1267 | Application: a live declaration no longer blocks; the writer's answers mapped to 409 with owner-approved Hebrew texts | **MERGED 947c6ab3 (2026-11-24)**, live (Production deployment 2026-11-24T05:00:36Z); every route still 404 while the flag is off |
| #1279 | T4 integration: the interim-documents count and list on steps 1 and 3, the success screen and the "already moved" screen; confirm carries `interimDocumentCount` and recounts inside the transition's transaction (409 `INTERIM_DOCUMENTS_CHANGED`, atomic rollback) | **MERGED ed3e8300 (2026-11-24)**, live (Production deployment 2026-11-24T20:13:58Z); every route still 404 while the flag is off |

The flag is read in one place, `lib/legal-identity/kind-transition-flag.ts` (`=== "true"`, server-only). The API
enforces it per request; `app/business/layout.tsx` passes it to the screens. Turning it on or off = env change + redeploy.

What the transition writes, in one transaction:

1. `BusinessKindTransition` row.
2. `BusinessProfile.billingBusinessKind = 'AUTHORIZED_DEALER'` and `billingVatNumber = billingTaxId`.

What it never touches:

- name, id number, `legalIdentityConfirmedAt` / `legalIdentitySource`;
- any `Billing*` table;
- the issuer declaration.

**Since 2026-11-24 (20261225090000), a live issuer declaration is no longer refused.** After the `STATEMENT_STALE`
check and before the history row and the profile update, the transition calls `issuer_declaration_status_change` with
its own server-computed digest, re-auth method and instant:

- `DECLARED` → declaration v2 `STATUS_CHANGE` is filed **in the same transaction**, so the profile keeps following the
  declaration (DZD35).
- Any other answer → `ISSUER_DECLARATION_<status>`, with nothing written. The application maps
  `NOT_AUTHORIZED_USER`, `IDENTITY_MISMATCH`, `DECLARATION_NOT_EXEMPT` and `DECLARATION_NOT_YET_EFFECTIVE` to 409 with
  owner-approved texts; any other status is unreachable and maps to 500.
- A business without a live declaration (none, or anonymised) never reaches the writer and transitions exactly as
  before.

The transition still never writes the declaration table directly; only the 4a writer does. Right after the apply
Production held 0 STATUS_CHANGE rows, 0 transition rows, and 0 businesses with a live exempt declaration and an exempt
profile.

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
  pending. `release-migrate` applies **every** pending migration and its verify step requires `expected_migrations`
  to equal the pending set exactly: on 2026-11-23 `20261216090000_activity_packs` (#1207, another track) is merged
  but **not applied** — coordinate with its owner before any 4a migration is merged or released.
- `ISSUER_DECLARATION_ENABLED` is not set in Production (the declaration flow is off there). Whether any Production
  business already holds a live declaration is unknown until a read-only evidence query is run (owner approval).

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
- **Status 2026-11-24: DONE.** 4a's writer is applied (20261223100000, release-migrate 45292801317). The legal identity
  follow-up is applied too (20261225090000, release-migrate 45320505488, proof 45323806725 9/9), and its application side
  is merged (#1267, 947c6ab3).
- Lab on the real migration:
  - integrated battery 57/57;
  - K1–K11 wired 56/56;
  - 4a T1 battery 75/75 (W 26/26);
  - app battery wired 43/43 (A18/A19) and unwired 34/34 (A20);
  - atomicity holds; the rollback restores the old body byte for byte.

### T1a — Google re-authentication for the declaration (Gate for Google-only declared businesses)

- `IssuerReauthMethod` has no `GOOGLE`. A Google-only owner of a declared business cannot transition.
- Options:
  - (a) add `GOOGLE` (enum migration) and accept a Google step-up proven the same way as the transition;
  - (b) an owner-approved alternative (e.g. `EMAIL_LINK` for this path).
- **Never** accept a client-side claim.
- **Acceptance:** a Google-only declared owner transitions with a fresh Google re-auth; a stale or foreign Google
  account is refused.
- **Status 2026-11-24: DONE** (option a, 20261223090000 applied). Through the wired transition, GOOGLE is recorded on
  both v2 and the history row (lab W3). A real Google account is still part of R1–R14.

### T2 — Uniform export for historical periods (Gate)

**Updated 2026-11-24 (4a), after the owner's decisions D1–D4.**

- **The finding.** On path A the uniform file carries no exempt/authorized status.
  - Every "מספר עוסק מורשה" field (A000 1003, A100 1102, Z900 1152, B110 1402, C100 1202, D110 1252, D120 1302) is the
    id number (`billingTaxId`), and it does not change.
  - 1015 is filled only for a company. 1018 is the legal name, and it does not change. `billingVatNumber` is not used.
  - Each document is written from what it froze at issuance, with its own per-line VAT.
  - So the original text of this section (exempt values "with no VAT number" before `confirmedAt`) does not match the
    file. Changing the file that way would also change every exempt business that never transitions.
- **The owner's decisions:**
  - D1: one file for the whole requested range, also when it straddles the transition.
  - D2: `confirmedAt` is Dubiz's operational switch point. The official date at the Tax Authority is unchanged.
  - D3: no change to the file structure, the identity fields or the printed reports.
  - D4: these acceptance criteria.
- **Acceptance (lab, `.billing-4a/t2-uniform-transition.battery.mts`, 25/25):**
  - T2-1: the identity fields are identical in the pre-transition, post-transition and straddling files.
  - T2-2: a pre-transition range exported before and after the transition is byte-identical (INI.TXT, BKMVDATA.TXT),
    and so is the printed-report data.
  - T2-3: the straddling file holds exactly the pre and post documents, each with its own VAT. The INI, Z900 and
    report 2.6 totals reconcile.
  - T2-4: businesses that did not transition are byte-identical, and the 9 existing uniform tests pass.
  - T2-5: three simulator packages (`docs/compliance/tax-authority/t2-kind-transition/`).
- **No change to the export code.**
- **Closure (owner, final, 2026-11-24).** The authority for the uniform structure is the Tax Authority; an
  accountant's confirmation is not a condition. The id number stays the same; one file for a range across the
  transition; each document keeps its own VAT; numbering stays continuous in every series. T2 closes when:
  1. the three v2 packages (≥ 2,000 records each, `t2-simulator-packages-v2.zip`) pass the official ITA simulator;
  2. no contradiction with the original spec 1.31 is found. The README holds the field-by-field check against the
     original: identity fields, 1015, 1011/1023, 1024/1025, the path, the document codes 305/320/330/400 and the
     1306 payment codes. The spec has no instruction to split files on a change from exempt to authorized.
  A Tax Authority inquiry is drafted (`ITA-INQUIRY-DRAFT.md`) only for the point the spec does not address in words:
  the "מספר עוסק מורשה" fields for an exempt dealer.

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
- **Status 2026-11-24: DONE.**
  - 4a side: #1269, e5acaa2d. Contract: `.billing-4a/T4-INTERIM-DOCUMENTS-CONTRACT.md`.
  - Legal identity side: #1279, ed3e8300. Covers steps 1 and 3, the success screen, the list sheet, and the in-transaction
    recount on confirm.
  - Texts: the owner-approved sentence, plus four more the owner approved on 2026-11-24 (singular, none, load error,
    changed while confirming).
- **Lab (CI e2e 45472029498):**
  - app battery 54/54 unwired and 65/65 wired;
  - T4 cases T1–T8 + T7b, including the real issuance racing the real confirm in both orders;
  - browsers 34/34 (V1–V9);
  - flag OFF 4/4.

### T3 status (2026-11-25)

**OPEN.** #1273 is a Draft. The owner approved the merge at HEAD 80a9d9b5, subject to a read-only Production check of
historical quotes; 4a runs that check and does the merge. #1273 is the only T1–T6 item not on main.

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

**T5 and T6 status (4a, 2026-11-25): closed.** Both were delivered with T1 and covered by batteries 53/53. Nothing is
missing from main.

### T7 / T8 (not gates)

- **T7:** a new business file with the same id number restarts numbering at 1 for the same taxpayer. Offer a
  `BillingSeriesOpening` at its first issuance. The owner decides: a prompt, or a requirement.
- **T8:** re-evaluate #1183 (forward technical correction) against the "no correction" rule (owner decision).

## 6. Suggested order

1. T6 (texts only).
2. T5 (lab proof only).
3. T1 + T1a (migration + code, each with its approval record).
4. T3, T2, T4.
5. ~~Legal identity follow-up migration (call T1).~~ Done 2026-11-24 (#1266 applied, #1267 merged).
6. Owner enables the flag after an isolated Preview with a real Google account and a physical phone.

## 8. Activation conditions (2026-11-25)

The flag `BUSINESS_KIND_TRANSITION_ENABLED=true` in Production is an env change plus a redeploy. It needs the owner's
approval and happens only after every condition below holds.

| # | Condition | State |
|---|---|---|
| C1 | T1 + T1a: the writer, Google re-auth, and the 20261225090000 wiring applied in Production | ✅ applied (release-migrate 45292801317 and 45320505488; proof 45323806725 9/9) |
| C2 | T2: the three v2 packages pass the official ITA simulator; no contradiction with spec 1.31 | ⏳ the owner runs the simulator (`docs/compliance/tax-authority/t2-kind-transition/t2-simulator-packages-v2.zip`) |
| C3 | T3: #1273 merged and live | ⏳ 4a, after the read-only quote check |
| C4 | T4 | ✅ #1269 + #1279 live |
| C5 | T5, T6 | ✅ closed (4a) |
| C6 | R1–R14 on a physical phone with a real Google account, on the isolated Preview | ⏳ owner actions O1–O6 in `docs/legal-identity-kind-transition-real-device-runbook.md` |
| C7 | After C2, C3 and C6: an isolated CI run of the full lab on main | ⏳ re-run after #1273 merges |
| C8 | The owner's activation decision: set the env var in Production and redeploy; then a read-only check (routes 200 for a signed-in exempt owner, no 5xx) | ⏳ owner |

## 7. How to verify against the legal identity code

- Lab: `.bkt/lab.sh <db> --with-bkt` (20261221090000 only); `--t1-base` (Production before the wiring);
  `--with-wiring` (Production now: + 4a T1/T1a + 20261225090000); `--broken-wiring` (atomicity).
- Batteries:
  - `.bkt/battery.ts` — database, 52 checks unwired / 56 wired;
  - `.bkt/wiring-battery.mts` — the wiring on the real migration (I1–I5), 57 checks;
  - `.bkt/app-battery.ts` — API, 34 checks unwired / 43 wired;
  - `.bkt/ui-e2e.mts` / `.bkt/ui-off.mts` — browsers, flag ON / OFF.
- CI: `business-kind-transition-lab.yml`, `kind-transition-wiring-lab.yml`, `business-kind-transition-e2e.yml` (wired lab).
- Any 4a change that the transition calls must keep these green.
