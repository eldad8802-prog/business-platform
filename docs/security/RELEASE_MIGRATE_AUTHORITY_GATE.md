# release-migrate — authority-changing migrations (incident record + proposed guard)

Status: **PROPOSAL.** Nothing here changes `release-migrate`, the `production-db` environment or who may approve it. Wiring any of it is a release-authority change, and that needs the owner's explicit approval.

## 1. What happened (2026-10-01)

| UTC | Event |
|---|---|
| 00:04:32 | #594 merged. It adds migration `20261003090000_control_plane_production_privileges`, which grants `app_ctlplane` new privileges and revokes runtime privileges. |
| 01:33:09 | Another session dispatched `release-migrate` run **36801636645** from main `97ed0591`. Its free-text `reason` read *"owner-approved; pending set = this migration only; main 3c871963"*. Nothing verified that claim, and the run's own SHA was different. |
| ≈01:36 | The `production-db` environment was approved from the owner's account, with an empty comment. |
| 01:36:10–01:37:02 | `prisma migrate deploy` applied #594 (the only pending migration). |
| 01:39 → 20:11 | The security decision package (preflight, ledger, lab proof) was still being assembled. Its read-only runs executed only after the apply. |

The result happens to be correct: 17/18 post-apply checks pass, and the one failure is a pre-existing grant outside #594's scope (see the #594 closure). But the security decision gate was bypassed. The privileges changed **before** the evidence the owner had asked for existed.

## 2. Root cause

`release-migrate` knows nothing about *which* migration was approved.

1. **It applies whatever is pending on main.** `prisma migrate deploy` has no allow-list. Being merged is enough.
2. **The human gate carries no context.** The `production-db` approval dialog shows the workflow and its SHA, not the migrations that will run. The `reason` input is optional free text that nothing checks.
3. **No migration is treated as sensitive.** A migration that changes who may do what (roles, grants, RLS) goes through the same path as `ADD COLUMN`.
4. **Approval is not bound to evidence.** Nothing ties the approval to a reviewed checksum, a preflight run or a decision record.

Not a cause: `release-migrate`'s `main`-only guard (L-21) and its concurrency group both worked as designed.

## 3. Scale

The prototype classifier (`scripts/ci/migration-security-classifier.mjs`, not wired anywhere) flags a migration as **authority-changing** when its SQL contains any of: role DDL, GRANT, REVOKE, `ALTER DEFAULT PRIVILEGES`, RLS enable/disable/force, policy DDL, `OWNER TO`, `SECURITY DEFINER`, `SET ROLE` / `SESSION AUTHORIZATION`, or an escalating role attribute. Comments are stripped first. On main today:

**47 of 163 migrations are authority-changing.**

This includes every tenant-RLS feature migration (M2, M3, M4, M5, P1, M9, payables) and #594. Blocking them is therefore not an option. Each needs a **specific, checksum-bound approval**, which M4 and M5 received by process and #594 did not.

## 4. Proposed guard (four layers, smallest first)

### L1 — An explicit expected set (applies to every run)

- Add a **required** input `expected_migrations`: a comma-separated list of exact migration names.
- Add a first step, after the environment approval (it needs the DB secret) and **before** `migrate deploy`. It computes the actual pending set (repository folders minus finished ledger rows) and **fails unless the two sets are equal**.
- Add `run-name: release-migrate — ${{ inputs.expected_migrations }}`, so the list appears in the run list and on the approval screen.

Effect: nothing is applied "because it is on main". An extra migration appearing between dispatch and approval stops the run. This automates the manual "re-check the pending set" step used in M4 and M5.

### L2 — Authority-changing migrations need a merged approval record

- Every expected migration that the classifier flags must have `ops/release-approvals/<migration_name>.json` **on the dispatched SHA**, containing:

  ```json
  { "migration": "...", "sha256": "<checksum of migration.sql>", "decision": "<link to the owner decision>",
    "preflightRun": <prod-readonly-evidence run id>, "approvedBy": "<owner>", "approvedAt": "<ISO time>" }
  ```

- The job verifies four things:
  - the record exists;
  - `sha256` matches the file;
  - `preflightRun` is a **successful** `prod-readonly-evidence` run of the migration's preflight file;
  - that run **started after** the migration was merged.
- The record lands through its own PR. A CODEOWNERS rule makes the owner the required reviewer of `ops/release-approvals/**`.
- The migration-first guard (or the classifier in CI) refuses a PR that adds an authority-changing migration **and** its approval record together. The record must come later, after the evidence exists.

Effect: having #594 on main plus a dispatched run would not have been enough. It would also have needed an owner-merged record bound to that exact checksum, citing a preflight that had actually run.

### L3 — Make the human gate informative

- A step **before** the protected job (in a job with no secrets) prints into the job summary, for the approver to see: each expected migration, its classification and its checksum, and for flagged ones the approval-record link.
- Optionally, use `production-db`'s "prevent self-review" and "required reviewers". Their value is limited when the owner is the only reviewer.

### L4 — Post-apply proof as the closing step

For a flagged migration, the run summary links the migration's post-apply proof file, and a follow-up (not automatic) proof run is the closure condition. Today this is a convention (M4, M5, #594). It stays human-dispatched, because the proof run needs its own `production-db` approval.

## 5. What this does NOT solve (honest limits)

- **The owner is also the only approver.** A rushed approval of a correctly prepared run still applies. L1 and L2 make it *structurally* impossible to apply an unreviewed or unexpected authority-changing migration, but not impossible to approve a reviewed one hastily.
- **A repository admin can edit the workflow.** That is visible in git history and is caught by the existing workflow-policy and supply-chain guards only partly. A GitHub ruleset on `.github/workflows/release-migrate.yml` with required owner review would close it.
- **Coverage depends on the classifier.** It is lexical. It is deliberately broad, and its self-test pins every rule. A new kind of authority change, such as a new extension, needs a new rule.

## 6. What adopting it would take (each an owner decision)

1. Approve the change to `release-migrate.yml` (L1, L3), the CODEOWNERS entry, and `ops/release-approvals/` (L2).
2. Wire the classifier into CI (the migration-first guard and release-migrate), with its self-test.
3. Backfill approval records only for migrations pending at adoption. Already-applied migrations need none.
