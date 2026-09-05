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
release-migrate (workflow_dispatch) → production-db environment
                                    → owner approval
                                    → prisma migrate deploy
```

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
- `.github/workflows/release-*.yml`
- `scripts/ci/release-*`, `scripts/ci/migration-first-guard.mjs`
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

Then run **`release-migrate`** (Actions → release-migrate → Run workflow). It
pauses on the `production-db` environment for owner approval, applies pending
migrations over the direct connection, and re-checks status afterwards.

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

It also does not cover **grants**. A migration can land while the runtime role
still lacks privileges on the new table. When a change needs grants, the order
is: migration → grants → verify → consumer.
