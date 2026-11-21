# Release ownership

**One source of truth for how Dubiz ships.** If you are a feature session, the
short version is: you never touch deployment. Read "The boundary" and stop.

---

## The deployment model

```
feature branch → PR → release/verify (required) → merge to main
                                                      ↓
                                   Vercel Git integration deploys automatically
```

Production database migrations are separate and manual, on purpose:

```
migration PR merged → approval record PR (authority-changing migrations only) → preflight evidence run from main
  → release-migrate (workflow_dispatch, expected_migrations = exact names)
      plan    — no secrets: classify each migration, check approval records + preflight runs
      ↓ production-db environment — owner approval
      stage   — pin the SHA, read the Production ledger, stage ONLY the approved first pending migrations
      deploy  — prisma migrate deploy over the staged directory, as the owner role
      confirm — the ledger now holds exactly the approved set
  → post-apply evidence (feature evidence + ops/evidence/privilege-model-production-assert.sql)
```

Details and the incident behind them: `docs/security/RELEASE_MIGRATE_AUTHORITY_GATE.md`.
Permissions rules every migration must follow: `docs/security/PERMISSIONS_CONTRACT.md`.

There is deliberately **no** `VERCEL_TOKEN`, no GitHub-driven application
deploy, no promote/rollback orchestration, and no custom release control plane.
A release-gate architecture was built on 2026-09-03 and removed on 2026-09-05
because it made every feature task manage production infrastructure. Do not
rebuild it without opening explicitly designated RELEASE-INFRA work.

---

## The boundary

**Feature sessions MUST NOT mutate:**

- Vercel project settings (either project)
- Vercel Git integration — connecting or disconnecting a repository
- Ignored Build Step / `commandForIgnoringBuildStep`
- `vercel.json`, `.vercelignore`
- GitHub environments, environment secrets, repository secrets or variables
- `.github/workflows/release-*.yml`, `.github/workflows/prod-readonly-evidence.yml` (its allow-list of evidence files)
- `scripts/ci/release-*`, `scripts/ci/migration-first-guard.mjs`, `scripts/ci/migration-security-classifier.mjs`
- `ops/release-approvals/**` (approval records are the owner's decision, landed through their own PR)
- Branch protection and required status checks
- The Production DB release flow (`release-migrate`, `production-db`)
- Deployment architecture of any kind

**If a feature session hits an infrastructure problem: STOP + REPORT.**
Do not fix it along the way. Say what you found and hand it back.

Only work explicitly designated **RELEASE-INFRA** may change the items above,
and such a PR must have a title beginning `RELEASE-INFRA:` so it is visible as
what it is. A "pilot-only" change to a repo-level file is not pilot-only:
`vercel.json` is shared by `business-platform` and `business-platform-btrl`.

---

## Migration safety — the rule

A schema-sensitive change ships as **two** PRs. Never one.

**PR-1 — the database.**
`prisma/migrations/**` only. Expand-only (add columns/tables; do not drop or
rename in the same step). No `prisma/schema.prisma`, no runtime code.

Then run **`release-migrate`** (Actions → release-migrate → Run workflow) with
`expected_migrations` = the exact names. It applies exactly that approved prefix
of the pending migrations — never "whatever is pending on main" — after the
`production-db` approval, and confirms the ledger afterwards. An authority-changing
migration (roles, GRANT/REVOKE, RLS, policies, SECURITY DEFINER, default
privileges) also needs its approval record in `ops/release-approvals/` and a
successful preflight evidence run from main after the merge.

**PR-2 — the code.**
`prisma/schema.prisma` plus the runtime that depends on it. By now the column
exists in Production, so merging this is safe even though Vercel deploys it
within minutes.

This is not theory. It is exactly the sequence that recovered the 2026-09-02
incident: `ea2fbe3` (migration, schema-only) → `release-migrate` → `318144a`
(schema + runtime).

### What enforces it

`scripts/ci/migration-first-guard.mjs`, run as a **blocking** step in
`release-ci-verify`. It reads the PR's own diff with `git` and nothing else —
no network, no database, no Vercel, no GitHub API, no secret. It blocks:

| verdict | when |
|---|---|
| `COMBINED_MIGRATION_AND_CODE` | the PR adds a migration **and** changes `schema.prisma` **and** changes application code |
| `SCHEMA_WITHOUT_MIGRATION` | `schema.prisma` introduces an identifier that **no migration anywhere in `prisma/migrations` mentions** |

The second rule asks whether a migration *exists*, not whether *this PR* contains
one — otherwise it would block PR-2, which is the correct half of the rule. It
allows migration-only PRs (PR-1), schema+code PRs whose migration already landed
(PR-2), code-only PRs, and migration+schema PRs that add no dependent code.
Comments, formatting, and `generator`/`datasource` edits are invisible to it by
construction.

Replayed against this repository's own history, it blocks `31d69e6` (the
incident) and `2380093` (the 2026-09-04 repeat), and allows `ea2fbe3` → `318144a`
(the corrected split), `75becfe`, `f4a04c0` and ordinary product PRs.

Run it yourself: `node scripts/ci/migration-first-guard.mjs --self-test`

### The exemption

Putting `MIGRATION-EXEMPT` in the PR title bypasses the guard. It exists for
genuine cases the rule does not fit — reverting a schema change, or a rename
that maps to an existing column. It is visible in the PR title, in the run log,
and in the job summary. Use it deliberately or not at all.

---

## What the guard does not cover

It proves the *shape* of a PR, not that `release-migrate` actually ran. The
`production-db` approval is what closes that: the person who approves the
migration is the person who merges PR-2. Keep those together.

Grants now live **inside the migration** that creates the table, stated explicitly
(GRANT what is needed, REVOKE what the owner's default privileges would add) —
`docs/security/PERMISSIONS_CONTRACT.md` §2.2. Any change to privileges, policies,
RLS flags or SECURITY DEFINER functions shows up as a diff of
`ops/security/privilege-model.baseline.txt`, which `security-lab.yml` checks by
rebuilding the shared security lab from every migration. After the apply, the
Production model is compared with
`ops/evidence/privilege-model-production-assert.sql` (PASS per section).

## Other required checks today

`release/verify` is the only required status. It runs the migration-first guard
(from the base branch), the tenant-table RLS guard, the tenant-scoped access guard,
validate and build. `security/gate` and `security-lab` run on every relevant PR but
are not required statuses yet — making them required is an owner decision.
