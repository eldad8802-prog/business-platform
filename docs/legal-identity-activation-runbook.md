# Legal identity — Production activation runbook

Status (2026-11-17): stages 1–2 are **done in Production** (owner-approved); stages 3–5 and everything below are a
**proposal, not run**. Each stage needs its own owner approval. Session dd (legal identity track).

## 0. What ships, and in what order

| # | Change | Production effect | Needs |
|---|---|---|---|
| 1 ✅ | migration `20261128090000_signup_legal_identity` (#1140) — APPLIED 11-17, ledger 218, evidence 12/12 | two columns + lock/seed/confirm functions + triggers. **No existing business is confirmed or locked.** | approval record, preflight 11/11, release-migrate, evidence 12/12 |
| 2 ✅ | #1142 (signup + lock code) — MERGED 7a17e70e, live 11-17 | **the only customer-facing change**: a new signup saves kind / legal name / number in the account transaction and they are locked from then on; `/business` shows them read-only for confirmed businesses | merge after 1 |
| 3 | migration `20261128100000_legal_identity_correction` (#1148; its preflight/evidence files reach main first via #1179) | correction tables + functions, append-only, four-eyes. **No approver exists → nobody can decide.** | merge, approval record, preflight 9/9, release, evidence 14/14 |
| 4 | #1152 (correction screens for the business) | none while `LEGAL_IDENTITY_CORRECTION_ENABLED` is unset (routes answer 404) | merge after 3 |
| 5 | #1154 (approver console) | none while the flag is unset | merge after 4 |

Existing businesses, issued documents, numbering, VAT and PDFs are untouched by every stage above.

## 1. Approvers (decision: who may approve)

An approver must satisfy **all** of the following; the server checks each on every decision and info request, and the
database checks the role, the `LegalIdentityApprover` row and the four-eyes rule (5) again inside
`legal_identity_correction_decide` / `_request_info`:

1. a platform admin: `role = PLATFORM_ADMIN` and the email in `PLATFORM_ADMIN_EMAILS`;
2. the email in `PLATFORM_ADMIN_LEGAL_IDENTITY_APPROVERS` (a separate list: being an admin is not enough);
3. a row in `LegalIdentityApprover` — writable **only** by the table owner (no application role can read or write
   it), so no code path and no admin can grant it to itself;
4. a TOTP authenticator enrolled (`PlatformAdminMfa`) and a fresh step-up (≤ 5 minutes) for every decision and info
   request — enforced always for this permission, independent of `PLATFORM_ADMIN_MFA_REQUIRED`;
5. not the requester and not a user of the requesting business (four-eyes, enforced in the database).

**Recommended:** two named Dubiz staff, each a PLATFORM_ADMIN on a staff business (never a customer business), TOTP
enrolled before activation. Adding one = (a) env lists (Production, owner), (b) one owner-run statement:

```sql
-- as the database owner, Production, after the owner names the user
INSERT INTO "LegalIdentityApprover" ("userId", "note") VALUES (<user id>, '<who approved, date>');
```

Removing one = remove the email from `PLATFORM_ADMIN_LEGAL_IDENTITY_APPROVERS` (immediate) and delete the row.

## 2. Turning the correction flow on (decision: activation policy)

Order: approvers ready (§1) → `LEGAL_IDENTITY_CORRECTION_ENABLED=true` in Production → redeploy → checks:

- `/business/legal-identity/correction` loads for a confirmed business and shows the "מחובר/ת כ־…" line;
- `/admin/legal-identity-corrections` for an approver asks for the step-up, then lists; for any other admin: refused;
- no 5xx in the Production logs for `/api/business/legal-identity/*` and `/api/platform-admin/legal-identity-corrections*`.

Options for a controlled start: enable and announce nothing (only businesses that ask get the link), or enable with a
link from `/business` (a later, separate change). The flag is a kill switch: unset → every correction route 404s;
requests already filed stay in the database untouched and are decided after re-enabling.

## 3. What every decision leaves behind

- the request row (append-only): requester, current and requested values, reason, re-verification method and time,
  status, decider, decision time, public note (shown to the business), internal note (staff only);
- `PlatformAuditEvent`: `…_CORRECTION_APPROVED` / `…_REJECTED` / `…_STALE` / `…_INFO_REQUESTED` by the approver,
  target = the request; viewing the queue, a request or an attachment is audited too;
- the profile changes **only** on APPLIED and stays confirmed and locked; issued documents keep their snapshot.

## 4. Failures and open requests

| Situation | What happens |
|---|---|
| the identity changed since the request | the decision answers STALE; nothing applied; the business files a new request |
| a live issuer declaration exists (#1117) | approve refuses (DECLARATION_ACTIVE); reject is still possible. A later migration (direction approved in principle, not written) lets an approved correction of a declared business write a CORRECTION declaration version in the same transaction: only the authorized user may request, PASSWORD re-verification, VAT number included |
| the requester cancels | CANCELLED; it can no longer be decided |
| the account is deleted | open requests are anonymised with it (`legal_identity_correction_erase`) |
| the flag is turned off with requests open | they stay PENDING; nothing expires |
| a second request while one is open | refused (one open request per business) |
| another tab switches the browser's account | the screen turns red and stops acting until reloaded |

## 5. The 32 existing businesses (decision: if and when to complete them)

Production counts (read-only, 2026-11-16): 32 live businesses; 31 without a business kind, 31 incomplete, 1 complete
whose number fails the check digit, **0 complete and valid**. Nothing changes for them by any stage above: they are not
confirmed, not locked, not blocked, and their stored values are never rewritten.

The completion mechanism already exists and is **off** (`LEGAL_IDENTITY_COMPLETION_ENABLED`, #1142):
`POST /api/business/legal-identity/confirm` → `legal_identity_confirm_existing` confirms **what the business itself
stored** (never writes a value; a number with separators is canonicalised to the same nine digits), answering
CONFIRMED / INCOMPLETE / INVALID_TAX_ID / LEGAL_NAME_TOO_LONG. From CONFIRMED on, the business is locked like a new one.

Proposed plan (each step separately approved):
1. **Notice, no blocking:** a dismissible prompt on `/business` for unconfirmed businesses: "השלימו את פרטי העסק
   החוקיים" — fill the kind, legal name and number in the existing form (still editable for them), then "אישור הפרטים".
   (Built, not opened as a PR: branch `feat/legal-identity-completion-prompt` — renders nothing while the flag is off.)
2. **Enable completion** (`LEGAL_IDENTITY_COMPLETION_ENABLED=true`): each owner confirms their own details; staff never
   confirm for them.
3. **The one business with an invalid number:** the confirm answers INVALID_TAX_ID; the owner corrects the number in the
   form (it is not locked yet) and confirms.
4. **Progress:** re-run `ops/evidence/legal-identity-existing-accounts.sql` (counts only).
5. **No deadline and no blocking** until the owner decides otherwise; issuing keeps working for unconfirmed businesses.

## 6. Rollback

Code first (Vercel rollback to the previous deployment, then revert the squash), then — only if needed and approved —
`.sli/correction-rollback.sql`, then `.sli/rollback.sql` (both lab-proven, each one transaction). Rolling back
`20261128090000` after signups loses their confirmation state (the columns), never their identity values.
