# Closed beta access — runbook (v1)

The closed beta lets up to 20 invited testers open Dubiz accounts while signup stays closed. They can use everything except two integrations that are not ready for outside testing:

- **Meta**: connecting WhatsApp Business (Embedded Signup) and Facebook / Instagram lead forms.
- **The Tax Authority**:
  - connecting it (OAuth);
  - held-invoice decisions;
  - issuing a tax invoice that would need an allocation number. Such an invoice could be issued, but it could never be delivered without a connection.

For a beta business these show **"בקרוב"**, and the server refuses to *start* them. Reading existing data, disconnecting, deleting Meta data, and every other feature are unchanged.

## Who is in the beta

A business is in the beta if and only if it has a `BusinessBetaEnrollment` row (migration `20261017090000_beta_cohort_enrollment`).

- **How a row gets written.** The row is written in the **same transaction** as the account, and only when the account was admitted through the closed-beta path. Admission needs all three of:
  - the address is on `SIGNUP_ALLOWED_EMAILS`;
  - the personal invitation code for that address is present;
  - public signup is off.
- **Who can change it.** No tenant can write or remove a row. `app_auth` may only insert `CLOSED_BETA_SIGNUP` rows. `app_runtime` may only read its own row.
- **Existing businesses are excluded.** Every business that existed before the beta has no row, so the policy cannot touch it. `ops/evidence/beta-cohort-invariants.sql` proves this at any time.

## The switch

| `BETA_COHORT_RESTRICTIONS` | Effect |
|---|---|
| `on` | Enrolled businesses are restricted. |
| anything else / unset | **Nobody** is restricted. The enrollment table is not even read. |

- **Rollback is the switch.** Unset `BETA_COHORT_RESTRICTIONS` (or set it to `off`) and redeploy. No data or code changes.
- **Where the code lives.** The policy is in `lib/beta/beta-access-policy.ts`, the server gates in `lib/beta/beta-gate.ts`, and the display hook in `lib/beta/use-beta-access.ts`.

## Server gates — the complete list

| Capability | Entry point |
|---|---|
| `META_WHATSAPP` | `POST /api/integrations/whatsapp/embedded-signup` |
| `META_LEAD_ADS` | `POST /api/integrations/acquisition/meta/pages`, `POST …/meta/connect` (on top of `acquisition_meta_lead_ads`, which is OFF by default) |
| `TAX_AUTHORITY` | `GET /api/taxes/oauth/connect`, `POST /api/billing/documents/[id]/authority-decision` |
| `TAX_AUTHORITY` (issue pre-check) | `POST /api/billing/documents/[id]/issue` → 409 `BETA_ALLOCATION_COMING_SOON` for a draft that `evaluateAuthorityReadinessAtIssue` marks READY. The draft is refused **before** anything is written. Every other document issues as before. |

These are deliberately **not** gated:
- status reads;
- disconnect;
- Meta data deletion;
- acquisition revoke / pause;
- the inbound webhooks (a beta business cannot hold a connection);
- the OAuth callback (it can only be reached through the refused connect);
- `/privacy` and `/data-deletion`.

`lib/beta/beta-access.test.ts` (F1–F4) pins both lists. It fails if a new route that starts one of these integrations appears without the gate.

**No Tax Authority logic changed.** `lib/services/billing/authority/*` and `billing-issue.service.ts` do not import the beta module (test F4).

## Activation (each step is an owner gate)

1. **PR-1 — the migration.** Merge it. Run the Production preflight (`prod-readonly-evidence` → `ops/evidence/beta-cohort-enrollment-preflight.sql`). Then the approval record, then `release-migrate`, then the post-apply evidence (`…-production-evidence.sql`, 14/14).
2. **PR-2 — the application.** Merge it and let it deploy with the switch **unset**. This is a no-op for everyone. Prove it with the invariants file.
3. **Secrets (Production env).** Set both:
   - `SIGNUP_INVITE_SECRET`: at least 32 random characters, e.g. `openssl rand -base64 48`;
   - `SIGNUP_ALLOWED_EMAILS`: the testers' exact addresses, at most 20.

   `PUBLIC_SIGNUP_ENABLED` stays `false`.
4. **Switch on.** Set `BETA_COHORT_RESTRICTIONS=on` and redeploy.
5. **Personal links.** Run this **locally**, with the same values as Production:
   ```
   SIGNUP_INVITE_SECRET=… SIGNUP_ALLOWED_EMAILS=… APP_BASE_URL=https://promaxgroup.co.il npx tsx scripts/beta/invite-links.ts
   ```
   Send each tester **only their own** link.
6. **After each signup:** run `ops/evidence/beta-cohort-invariants.sql`. Every check must pass:
   - enrolled count is the number of testers;
   - no enrolled business holds a Meta or Tax Authority connection;
   - none was enrolled after its creation.

## Ending the beta / emergencies

- **Lift all restrictions now.** Set `BETA_COHORT_RESTRICTIONS` to `off` (or unset it) and redeploy.
- **Stop new beta signups.** Remove `SIGNUP_ALLOWED_EMAILS`. Rotating `SIGNUP_INVITE_SECRET` voids every unused link.
- **Nothing is deleted.** Enrollment rows stay as the record of who joined through the beta. Removing the table is a separate, explicit owner decision (`.beta/rollback.sql` refuses while rows exist).

## Known limits

- **One switch for the whole cohort.** There is no per-tester exception in v1. A tester who should get Meta or the Tax Authority needs the switch off for everyone, or a follow-up.
- **The pre-check is not atomic with the issue.** It reads the draft just before the issue transaction. A tester editing the same draft in two tabs at the same instant could slip past it. The worst outcome is an issued invoice that cannot be delivered, for that tester only. Nothing about the Tax Authority's rules or other businesses is affected.
- **Display during load.** Until `/api/business/beta-access` answers, a few connect links wait one short request. For non-beta businesses there is no other difference.
