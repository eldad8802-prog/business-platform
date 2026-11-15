# Issuer declaration — release runbook (#1091 → apply → #1117 → screens → enforcement)

Status: **proposal for owner approval — nothing here has been run.** Every stage below needs its own approval.
Author: invoice track, 2026-11-12; revised 2026-11-14 after #1105 was applied alone (see "Ledger order").

## Why the order is fixed

| Code that reaches Production | Needs, already applied in Production | What breaks if it arrives first |
|---|---|---|
| #1091 (migration only) | `20261126090000` (#1105) — **applied 2026-11-14** | nothing (no application code) |
| #1107 (auth link library) | `20261126090000` (#1105) — applied | nothing reachable: only #1117's routes call it, behind `ISSUER_DECLARATION_ENABLED` (default OFF) |
| #1117 (declaration code) | `20261126100000` (#1091) **and** `20261126090000` (#1105) | **issuance** (the gate reads `IssuerDeclarationEnforcement` → relation missing → every issue of a fiscal document fails), **issuer-profile save** (the identity gate reads `BusinessIssuerDeclaration`), **account deletion** (the purge calls `issuer_declaration_erase()` → function missing → deletion fails) |

So **#1117 must not be merged until the production evidence of stage B is PASS.** There is no safe way to ship
#1117 first: its gate fails closed by design (a missing table must not silently allow issuing).

## Ledger order

`release-migrate` applies only the *first pending migrations, in Prisma order*. On 2026-11-14 the owner approved and
Production applied `20261126090000_auth_issuer_declaration_link` (#1105) **alone** (release-migrate 43617171163; approval
record #1161). The two migrations are independent — #1105's header: "no dependency on billing's migration"; neither names
the other's objects; both apply orders yield the same objects (`auth-issuer-declaration-link-lab.yml`, step 6).

This migration was therefore **re-timestamped from `20261123090000` to `20261126100000_issuer_declaration`** (SQL
byte-identical, sha256 `28f1d87513be69741e855739e345dfd5caaa0762e43bc2f65ce98327b4ded3b9`), so it sorts right after
the applied #1105 and is **not** an out-of-order migration. `20261127090000` was not used: Service Desk drafts already
claim it (`service_desk_tracks`).

The release is now **one migration, alone**: `release-migrate` with exactly `20261126100000_issuer_declaration`.

**Dependency (another session's migration):** on 2026-11-14 main also gained `20261124090000_service_user_same_business_fix`
(#1131, Service Desk), not applied in Production. It sorts before this migration, so while it is pending it is the first
pending migration and `release-migrate` will not apply this one alone. This migration can be released alone only after
#1131's own release (its own preflight, approval record and run; its preflight treats later finished migrations as
informational only). The two are independent: #1131 replaces the body of `service_user_same_business()` only; this
migration names no Service Desk object. The lab applies every earlier migration first, #1131 included.

## Stages

### Stage A — merge #1091 (migration-only PR)
- Before: #1091 CI green except the expected A0 guard (G4, the migration file only); `issuer-declaration-migration-lab`
  PASS (lab 73/73, S1, negatives, release scripts 12/12 + 12/12 + order-guard negatives).
- Precondition for stage B, not for stage A: `20261124090000_service_user_same_business_fix` (#1131) applied by its own
  release — until then it is the first pending migration (see "Ledger order").
- After: Vercel deploy of main succeeds (no code change; the build runs `prisma generate && next build` only). Nothing in
  Production changes. `20261126100000_issuer_declaration` is then the first (and only) pending migration on main.
- Stop: revert the merge commit (no data, no migration applied).

### Stage B — apply the migration (release-migrate, one dispatch, this migration only)
1. Read-only preflight from main (`prod-readonly-evidence.yml`, `ops/evidence/issuer-declaration-preflight.sql`;
   owner approves the `production-db` environment) → every check PASS (**12/12**): ledger clean; this migration not
   recorded; **nothing finished after it**; **#1105 recorded and finished**; no object exists yet; the 5 attached tables
   exist; roles correct; **no transaction older than 60 s on the billing tables** (the migration uses
   `lock_timeout 3s`; it fails fast rather than queueing issuance). Record checks 13/14 (issued fiscal documents, counters).
2. Approval record `ops/release-approvals/20261126100000_issuer_declaration.json` in its own PR (decision URL, sha256
   above, `preflightRun` = step 1's run, `releaseSet: ["20261126100000_issuer_declaration"]`). The migration is
   authority-changing (GRANT, REVOKE, RLS, POLICY, SECURITY DEFINER), so `release-migrate` refuses without it.
3. Apply: `release-migrate` with exactly `20261126100000_issuer_declaration`.
4. After (read-only): `ops/evidence/issuer-declaration-production-evidence.sql` → 12/12 PASS: 3 tables, FORCE RLS,
   12 functions, definer search_path pinned, nothing executable by PUBLIC, 5 triggers enabled, runtime holds only
   read + add, no runtime designation, app_admin both, **enforcement 0, declarations + openings 0** (inert);
   checks 13/14 equal the preflight's 13/14; check 15 (#1105 recorded) = 1.
- Behaviour after stage B (still the old code): issuing, numbering, profile saves, account deletion unchanged — the
  issue trigger is inert without the enforcement row; the profile lock without a declaration; the opening trigger
  without an opening row; nothing writes declarations or openings.
- Stop: if the apply fails, `lock_timeout` rolled it back (the migration is one transaction) — re-run preflight, retry
  later. If evidence FAILs: do not continue; `.issuer-declaration/rollback.sql` (owner, refuses if any record exists;
  drops the triggers on existing tables first). #1105 is not touched by this rollback.

### Stage C — merge #1117
- Before: stage B evidence PASS **again on the day** (re-run the evidence script); #1117 updated to the renamed migration
  and green on current main; `ISSUER_DECLARATION_ENABLED` stays OFF in Production.
- After (synthetic checks only, no real document): issuance of an existing business works exactly as before
  (no enforcement row); profile save works; an account-deletion lab run is not possible in Production — rely on the
  CI deletion labs (W1–W10, C1–C6) + the evidence that `issuer_declaration_erase()` exists and is executable by the runtime.
- Stop: revert the merge commit — the old code runs fine on the new schema (the triggers are inert).

### Stage D — declaration screens ON (`ISSUER_DECLARATION_ENABLED`) — separate decision
### Stage E — enforcement row — separate decision, one-way
- Before: every active business that issues fiscal documents has a declaration (count query) — otherwise they are
  blocked at issue from that moment; multi-user businesses need a platform designation first.
- The row is append-only: switching enforcement off needs its own migration and approval.

## Other sessions' pending migrations

After stage A and #1131's release, `20261126100000_issuer_declaration` is the first pending migration on main, so `release-migrate` can apply
a migration that sorts after it only after stage B (as in every earlier release). Drafts that sort **before** it
(Service Desk `20261121…`–`20261126090000_service_desk_case_charge`) already sort before the applied #1105 and need
their own re-timestamp regardless of this change.

## Areas checked for a breakage window

| Area | Window? | Why |
|---|---|---|
| Issuing documents | only if #1117 precedes stage B | gate reads the enforcement table; prevented by the stage-C precondition |
| Issuer profile save | only if #1117 precedes stage B | identity gate reads declarations |
| Account deletion | only if #1117 precedes stage B | purge calls `issuer_declaration_erase()` |
| Declaration links | none | routes exist only with #1117, flag OFF; link migration already applied |
| Existing numbering | none | the opening trigger acts only on a NEW counter of a series that has an opening row; none exist |
| User permissions | none | designation EXECUTE only for app_admin; runtime read + add only (evidence 8–10) |
| Businesses without a declaration | none until stage E | the issue trigger and gate are inert without the enforcement row |
