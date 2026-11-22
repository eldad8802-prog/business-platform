# "מעבר לעוסק מורשה": controlled release package

Prepared 2026-11-22. **Nothing here is approved by this file.**

**Progress (2026-11-22):** steps 1–4 DONE. #1210 merged 19564556 → read-only preflight 44967275771 11/11 → owner apply decision (#1210 issuecomment-7071788368) → approval record #1223 (d37fda3b) → release-migrate 44969899339 (pending set exactly this migration; ledger 227 → 228; nothing pending) → evidence 44971617659 11/11, signup identity 44971804949 12/12; Production healthy, flag absent. Next: step 5 (#1204).
 Each numbered step is a separate owner approval. The
feature flag `BUSINESS_KIND_TRANSITION_ENABLED` is unset in every Vercel environment (checked 11-22: `vercel env ls`
lists no such name) and the code treats anything but `"true"` as OFF (404).

## A. The PRs

| PR | Branch | Role | Merge |
|---|---|---|---|
| #1210 | `db/business-kind-transition` | migration `20261221090000_business_kind_transition` (+ lab, preflight, evidence, rollback) | 1st, then a separate apply |
| #1204 | `feat/legal-identity-two-paths-core` | API, re-auth proof, Prisma model, tests, docs | 2nd, only after the migration is APPLIED in Production |
| #1213 | `feat/legal-identity-kind-transition-ui` | the approved screens (stacked on #1204) | 3rd; retarget to `main` after #1204 merges |
| #1214 | `ci/legal-identity-joined-proof` | CI proof only (#1210 + #1204 + #1213) | **never**; close after the three merge (owner OK) |

Why #1204 / #1213 are red before #1210 merges:
- `migration-first-guard`: the code PR models a table whose migration is not on main yet.
- `tenant-table-rls-guard` R1: same cause; it is called inside several workflows' static guards.
- `tenant context closure`: the uncovered-table count; same cause.

Proof that only the dependency causes them: on #1214 (migration present) every check passes except
`migration-first-guard`. That guard refuses a migration and its code in one PR by design, which is why there are three
PRs. Its later steps (RLS guard incl. self-test, tenant-scoped access, prisma validate) pass locally on the joined tree.

## B. Step 1 — merge #1210 (owner approval required)

- Migration: `prisma/migrations/20261221090000_business_kind_transition/migration.sql`
- sha256 (LF): `75e8000a2846941ed1c02449d239dae7921f2ffbe33600a5b5cd042f9505fbdf`, unchanged since the lab runs.
- Classifier: **AUTHORITY** `[GRANT, REVOKE, RLS, POLICY, SECURITY_DEFINER]`, so release-migrate needs an approval
  record (§D).
- Depends on (both applied in Production): `20261126100000_issuer_declaration`,
  `20261128090000_signup_legal_identity`.
- Open migration PRs checked 11-22: no name collision, and none touches what this migration reads or creates.
  - #1207 `20261216090000_activity_packs` (new table only).
  - #1183 `20261220090000` (4a; replaces the declaration chain guard; this migration never writes the declaration).
  - The Service Desk and old legal identity Drafts all sort earlier and touch none of these objects.
- **Real order:**
  - `release-migrate` applies every migration still pending on main, and its `verify` step refuses unless
    `expected_migrations` equals exactly that pending set. So the order is decided by what is unapplied in Production
    at dispatch time, not by file names.
  - Before dispatch: confirm the Production ledger has nothing pending but `20261221090000` (the preflight's check 1,
    plus the release `verify` step).
  - If another track's migration was merged and is still unapplied: stop, and agree the order with that track.
  - Out-of-order apply is accepted by Prisma and the gate (proven earlier).
- Merge method: squash, with `--match-head-commit <exact head sha>`.

## C. Step 2 — read-only Production preflight (owner approval for the production-db gate)

- `prod-readonly-evidence.yml` from `main`, file `ops/evidence/business-kind-transition-preflight.sql`. Read-only
  session; SELECT only (CI step 0 proves it).
- **Expected: 11/11 PASS** in Production. The lab shows check 7 as a lab-ledger artefact; Production has both
  prerequisites recorded.
  1. ledger clean
  2. not recorded
  3. table absent
  4. functions absent
  5. `app_runtime` exists
  6. helpers present
  7. prerequisites finished
  8. columns present
  9. signup lock trigger present
  10. `Asia/Jerusalem` known
  11. `sha256()` present
- Report the result, then wait for a **separate, explicit** apply approval.

## D. Step 3 — approval record + apply (separate owner approval)

Approval record PR (its own PR, after the preflight run): `ops/release-approvals/20261221090000_business_kind_transition.json`

```json
{
  "migration": "20261221090000_business_kind_transition",
  "sha256": "75e8000a2846941ed1c02449d239dae7921f2ffbe33600a5b5cd042f9505fbdf",
  "decision": "<link to the owner's written apply decision>",
  "approvedBy": "eldad8802-prog",
  "approvedAt": "<ISO time of the decision>",
  "preflightRun": "<run id of step 2>",
  "preflightFile": "ops/evidence/business-kind-transition-preflight.sql",
  "releaseSet": ["20261221090000_business_kind_transition"]
}
```

Then `release-migrate` with `expected_migrations = 20261221090000_business_kind_transition`. Announce to the other
sessions first; one release in flight.

## E. Step 4 — after the apply

- `ops/evidence/business-kind-transition-production-evidence.sql` → **11/11**. It pins the checksum and the
  app/SQL digest vector `8ab5a6b2…d464`.
- `ops/evidence/signup-legal-identity-production-evidence.sql` → still **12/12**.
- Ledger: +1 row, finished, not rolled back.
- Health: Vercel logs 0 new errors; `/business` and signup unchanged.
- Rollback, owner-run, only after reverting any code that calls the function: `.bkt/rollback.sql` drops the history
  table and the functions. Profiles already transitioned stay AUTHORIZED.

## F. Steps 5–6 — merge #1204, then #1213 (each its own approval)

1. Update #1204 from main (it then carries the migration's table in main's chain). CI must be green except owner-known
   items. Merge.
2. Production check: `GET /api/business/legal-identity/kind-transition` with a session → **404** (flag unset).
   `/business` unchanged.
3. Retarget #1213 to `main`, update, CI green (incl. `business-kind-transition-e2e.yml`), merge. Same 404 check;
   `/business` shows no entry.
4. Close #1214 without merging (owner OK).

## G. Before the flag (gates)

- 4a tasks T1, T1a, T2, T3, T4, T5, T6 merged and tested (`docs/legal-identity-kind-transition-4a-coordination.md`).
- Isolated Preview with a **real Google account** and a **physical phone** (§I).
- Then the owner sets `BUSINESS_KIND_TRANSITION_ENABLED=true` in Production **and redeploys** (as for every Vercel env
  change: the API reads it at request time, the business layout passes it to the screens — `lib/legal-identity/kind-transition-flag.ts` is the
  one reader). Turning it off is the same: remove it and redeploy.

## H. Evidence index

Kept in the PRs (the run pages remain after #1214 is closed). Local runs: PG18, Production role topology.

| What | Where | Result |
|---|---|---|
| Migration lab (CI) | `business-kind-transition-lab.yml` on #1210 / #1214 | proof 11/11, preflight as expected, battery K1–K11 52/52, atomicity, rollback |
| App battery | `.bkt/app-battery.ts` in `business-kind-transition-e2e.yml` on #1214 | 33/33 |
| Browsers, flag ON | `.bkt/ui-e2e.mts`, same workflow | 17/17 (Chromium desktop/phone, WebKit iPhone-sized viewport: **emulation**) |
| Flag OFF | `.bkt/ui-off.mts`, same workflow | 4/4 |
| Google / OAuth regressions | `oauth identity` workflows on #1204 / #1214 | pass (incl. the browser job) |
| Production build | Vercel previews on #1210 / #1204 / #1213 / #1214 | pass |
| Units | security-gate manifest `legal-identity-two-paths.json` | kind-transition 20, policy 13, sensitive-reauth 15, handlers 15, client 9 |

## I. Real Google + physical phone (owner actions needed; nothing done yet)

The emulated runs prove the server never trusts the browser (a faked Google "ok" is refused). A real Google account
and a real phone are still unverified.

**Owner actions** (none may be done without the owner; OAuth settings are not changed by sessions):

1. **Google Cloud Console:** either
   - create a separate **test OAuth client** (recommended), or
   - add a redirect URI to the existing client:
   `https://<stable preview alias>/api/auth/google/callback`. Use the branch alias, e.g.
   `business-platform-git-<branch>-eldads-projects-77d41b04.vercel.app`, so it does not change per deploy.
2. **Isolated database:** a Neon branch from the Preview database, then `prisma migrate deploy` up to
   `20261221090000`. Synthetic data only. Needs the owner's `neonctl auth` on this machine (`neonctl` hangs here
   without it).
3. **Vercel branch-scoped Preview env** for the test branch only. This is a Preview-only flag ON: it needs explicit
   owner OK.
   - `DATABASE_URL`, `DIRECT_URL`, `AUTH_DATABASE_URL` → the isolated branch;
   - `AUTH_PLANE_ENABLED=true`;
   - `AUTH_GOOGLE_LOGIN_ENABLED=true`, `AUTH_GOOGLE_LOGIN_MODE=pilot`, `AUTH_GOOGLE_LOGIN_PILOT_EMAILS=<owner test
     address>`;
   - `GOOGLE_LOGIN_CLIENT_ID` / `_SECRET` (the test client), `GOOGLE_LOGIN_REDIRECT_BASE_URL=https://<alias>`;
   - `BUSINESS_KIND_TRANSITION_ENABLED=true`.
   Preview today has no `GOOGLE_LOGIN_*` variables at all.
4. **Phone access:** Vercel Deployment Protection blocks previews. Either a protection-bypass link for the test
   branch, or sign in to Vercel on the phone.
5. **Test accounts on the isolated database:**
   - (a) exempt + password;
   - (b) exempt + Google-only, linked to the owner's real Google account;
   - (c) a second Google account that is **not** linked.
6. **Clean-up afterwards:** delete the branch env vars and the Neon branch. The old leftovers from
   `feat/legal-identity-correction-admin` (`LEGAL_IDENTITY_CORRECTION_ENABLED`,
   `PLATFORM_ADMIN_LEGAL_IDENTITY_APPROVERS`, DB URLs) also await the owner's clean-up OK.

**Checklist** (the owner on the phone; the session can drive the desktop part):

| # | Check | Pass when |
|---|---|---|
| G1 | Google re-auth with account (b) | Google asks for a fresh login; back on step 2 "אומת עם Google"; confirm → success; history says GOOGLE |
| G2 | Cancel on Google's screen | back with "בוטל", nothing written |
| G3 | Choose account (c) | "חשבון ה-Google שבחרתם לא מחובר…", nothing written |
| G4 | Wait > 5 minutes after verifying, then confirm | "עבר זמן רב מדי…" + "לאימות מחדש", nothing written |
| G5 | Return flow | the typed date and id number are restored after Google |
| G6 | Flag removed from the branch env + redeploy | entry gone; the page says not available; API 404 |
| M1 | Phone: RTL, numeric keyboard on the id field, date picker, scrolling with the fixed button, back button, the sheet, the error states, 320–430 px widths | as approved in the design |
