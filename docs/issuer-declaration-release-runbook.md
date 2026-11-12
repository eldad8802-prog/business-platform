# Issuer declaration — release runbook (#1091 → #1105 apply → #1107 → #1117 → enforcement)

Status: **proposal for owner approval — nothing here has been run.** Every stage below needs its own approval.
Author: invoice track, 2026-11-12.

## Why the order is fixed

| Code that reaches Production | Needs, already applied in Production | What breaks if it arrives first |
|---|---|---|
| #1091 (migration only) | — | nothing (no application code) |
| #1105 (migration only, **merged 11-12, not applied**) | — | nothing |
| #1107 (auth link library) | `20261126090000` (#1105) | nothing reachable: only #1117's routes call it, behind `ISSUER_DECLARATION_ENABLED` (default OFF) |
| #1117 (declaration code) | `20261123090000` (#1091) **and** `20261126090000` (#1105) | **issuance** (the gate reads `IssuerDeclarationEnforcement` → relation missing → every issue of a fiscal document fails), **issuer-profile save** (the identity gate reads `BusinessIssuerDeclaration`), **account deletion** (the purge calls `issuer_declaration_erase()` → function missing → deletion fails) |

So **#1117 must not be merged until the production evidence of stage 3 is PASS.** There is no safe way to ship
#1117 first: its gate fails closed by design (a missing table must not silently allow issuing).

## Ledger order

`release-migrate` applies only the *first pending migrations, in Prisma order*. `20261123090000_issuer_declaration`
sorts **before** `20261126090000_auth_issuer_declaration_link`. If #1105 is applied alone first, #1091's migration
becomes an out-of-order pending migration and its preflight (check 3) refuses. **Do not apply #1105 alone.** The safe
run applies both, in one `release-migrate` dispatch: `20261123090000_issuer_declaration,20261126090000_auth_issuer_declaration_link`.

## Stages

### Stage 1 — merge #1091 (migration-only PR)
- Before: #1091 CI green except the expected A0 guard; `issuer-declaration-migration-lab` PASS (lab 73/73, S1, negatives, release scripts).
- After: Vercel deploy of main succeeds (no code change). Nothing in Production changes.
- Stop: revert the merge commit (no data, no migration applied).

### Stage 2 — (#1105 is already merged) — no action

### Stage 3 — apply both migrations (release-migrate, one dispatch)
- Before (read-only): `ops/evidence/issuer-declaration-preflight.sql` → every check PASS (11/11): ledger clean, not
  recorded, **nothing finished after it**, no object exists yet, the 5 attached tables exist, roles correct,
  **no transaction older than 60 s on the billing tables** (the migration uses `lock_timeout 3s`; it fails fast rather
  than queueing issuance). Record checks 12/13 (issued fiscal documents, counters).
  Plus #1105's own preflight (session 23's script).
- Apply: `release-migrate` with exactly `20261123090000_issuer_declaration,20261126090000_auth_issuer_declaration_link`.
- After (read-only): `ops/evidence/issuer-declaration-production-evidence.sql` → 12/12 PASS: 3 tables, FORCE RLS,
  12 functions, definer search_path pinned, nothing executable by PUBLIC, 5 triggers enabled, runtime holds only
  read + add, no runtime designation, app_admin both, **enforcement 0, declarations + openings 0** (inert);
  checks 13/14 equal the preflight's 12/13. Plus #1105's evidence script.
- Behaviour after stage 3 (still the old code): issuing, numbering, profile saves, account deletion unchanged — the
  issue trigger is inert without the enforcement row; the profile lock without a declaration; the opening trigger
  without an opening row; nothing writes declarations or openings.
- Stop: if the apply fails, `lock_timeout` rolled it back (the migration is one transaction) — re-run preflight, retry
  later. If evidence FAILs: do not continue; `.issuer-declaration/rollback.sql` (owner, refuses if any record exists;
  drops the triggers on existing tables first). #1105 has its own rollback (session 23).

### Stage 4 — merge #1107 (session 23) — after #1106 (merged)
- Before: #1107 green on current main; stage 3 evidence PASS.
- After: nothing user-visible (library only).
- Stop: revert.

### Stage 5 — merge #1117
- Before: stage 3 evidence PASS **again on the day** (re-run the evidence script); #1117 green on current main;
  `ISSUER_DECLARATION_ENABLED` stays OFF in Production.
- After (synthetic checks only, no real document): issuance of an existing business works exactly as before
  (no enforcement row); profile save works; an account-deletion lab run is not possible in Production — rely on the
  CI deletion labs (W1–W10, C1–C6) + the evidence that `issuer_declaration_erase()` exists and is executable by the runtime.
- Stop: revert the merge commit — the old code runs fine on the new schema (the triggers are inert).

### Stage 6 — declaration screens ON (`ISSUER_DECLARATION_ENABLED`) — separate decision
### Stage 7 — enforcement row — separate decision, one-way
- Before: every active business that issues fiscal documents has a declaration (count query) — otherwise they are
  blocked at issue from that moment; multi-user businesses need a platform designation first.
- The row is append-only: switching enforcement off needs its own migration and approval.

## Areas checked for a breakage window

| Area | Window? | Why |
|---|---|---|
| Issuing documents | only if #1117 precedes stage 3 | gate reads the enforcement table; prevented by the stage-5 precondition |
| Issuer profile save | only if #1117 precedes stage 3 | identity gate reads declarations |
| Account deletion | only if #1117 precedes stage 3 | purge calls `issuer_declaration_erase()` |
| Declaration links | none | routes exist only with #1117, flag OFF; link migration applied in stage 3 |
| Existing numbering | none | the opening trigger acts only on a NEW counter of a series that has an opening row; none exist |
| User permissions | none | designation EXECUTE only for app_admin; runtime read + add only (evidence 8–10) |
| Businesses without a declaration | none until stage 7 | the issue trigger and gate are inert without the enforcement row |
