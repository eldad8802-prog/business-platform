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

## 7. Approved prefix (2026-10-04)

### Root cause
`prisma migrate deploy` has no target: it applies **every** migration directory that has no finished ledger row. With an exact-set gate, a later migration merged to main (M6, `20261009090000`) made it impossible to release an earlier, ready one (P3-A, `20261008090000` / `20261008090100`) without approving M6 too. Relaxing the comparison alone would not help — deploy would still run M6.

### Design
The protected job hands `prisma migrate deploy` a **staged** migrations directory, built from the dispatch commit, that holds the applied migrations and the approved prefix — nothing else. A migration outside the approved prefix is not in that directory, so the apply step cannot run it. No ledger edit, no `migrate resolve`, no SQL outside Prisma, no rename, no revert.

### Prefix invariant
`expected` (in the order given) must equal the first `k` pending migrations in Prisma order (byte order of directory names). With pending `[A, B, C]`: `[A]`, `[A,B]`, `[A,B,C]` pass; `[B]`, `[A,C]`, `[B,C]`, `[B,A]` refuse. An unapproved migration before or among the expected ones refuses before any write; one after them stays pending. The exact set is the case `k = pending.length`.

### Race protection (after approval, before any write — `gate stage`)
1. The checkout is the dispatch commit (`HEAD == github.sha`); a migration merged to main later is not in it.
2. The authority checks run again: approval record (checksum), decision link, approver, preflight run (prod-readonly-evidence.yml, main, after the merge, naming its file) **and the preflight's verdict** — a preflight log with any FAIL row, or no PASS row, refuses (a run concludes "success" whenever its SQL ran).
3. The Production ledger is read now; an unfinished or rolled-back row refuses.
4. Pending order is computed from the dispatch commit; the prefix invariant is checked.
5. The staged tree is re-read: exactly applied ∪ approved, byte-identical, no held migration.

### Ledger proof (`gate confirm`, after the apply)
Finished rows = finished-before ∪ expected exactly; no unfinished row; no row at all for a held migration.

### Proof
`.release-gate/prefix-lab.sh` (release-gate-lab.yml step 5): the owner's 12 cases on PG17, each through the real stage → deploy → confirm path, with the actual ledger and objects checked after each.

## 8. Owner-bound release sets (`releaseSet`)

### Two different things
- **Approved prefix (section 7) is a technical capability.** `stage` can apply any prefix of the pending order that the run names, and hold everything after it. It answers: *can this list be applied in this order without running anything else?*
- **An owner-bound release set is authority.** It records an owner decision that certain migrations go to Production **together, in one run**. It answers: *did the owner approve releasing exactly this list?*

The prefix capability stays generic. A binding only narrows what a particular owner decision allows.

### Where it lives
In the approval record, which is repository-tracked and reviewed. It is never a workflow input:

```json
{
  "migration": "20300101090100_b",
  "sha256": "<file sha256>",
  "decision": "https://github.com/<owner>/<repo>/pull/<n>#issuecomment-<id>",
  "approvedBy": "<owner>",
  "preflightRun": 123456789,
  "preflightFile": "ops/evidence/<b>-preflight.sql",
  "releaseSet": ["20300101090000_a", "20300101090100_b", "20300101090200_c"]
}
```

`releaseSet` is optional. When it is present it must meet all of these:
- it is a non-empty list of migration names;
- every name is a migration directory in the checkout;
- no name appears twice;
- it contains the record's own `migration`;
- it is in **Prisma order**. A different order is refused, and the message shows the canonical order; the gate never re-sorts silently.

### What the gate enforces
These checks run in `plan` and again in `stage`, after approval and before any write.

- **Every binding record is consulted.** That is every record under `ops/release-approvals/` whose `releaseSet` shares a migration with `expected_migrations`, not only the records of the requested migrations. A part of a bound set cannot slip through just because the record that binds it belongs to a migration left out of the request.
- **Exact match.** `expected_migrations` must equal the bound set exactly:
  - a **subset** is refused ("requested migrations are only a subset of the owner-approved release set");
  - a **superset** is refused;
  - a list that leaves part out and adds something else is refused.
- **Conflicts.** If two records bind the requested migrations to **different** sets, the gate refuses and lists both sets. It does not guess which one is newer.
- **Restrict-only.** A binding never authorizes anything by itself. Every authority-changing migration still needs its own checksum-bound, preflight-bound record (section 4). The ledger and prefix checks (`decide`) are unchanged.
- **Fail closed.** A malformed binding, or an approval record that is not valid JSON, refuses every release, because it cannot be told what it binds.

The plan prints the bound set and the requested release member by member, so an operator sees exactly why it stopped:

```
owner-bound release set detected (ops/release-approvals/20300101090100_b.json):
  20300101090000_a
  20300101090100_b
  20300101090200_c
requested release:
  20300101090000_a
  20300101090100_b
REFUSED: requested migrations are only a subset of the owner-approved release set (left out: 20300101090200_c) — releasing part of it needs a new owner decision
```

### Changing an owner decision (supersession)
Editing the `expected_migrations` input can never weaken a binding. A changed decision is a **new authority artifact**: a reviewed approval-record PR that changes the record, carrying both of these:
- `"supersedes": "<the previous decision URL>"`
- a **new** `decision` link

The gate walks the record's git history (release-migrate checks out with full history) and takes the most recent earlier version whose binding differs from the current one. The current record must name that version's decision in `supersedes`, and must link a different decision. Comparing against the last *different* binding means an unauthorized change cannot be laundered by touching the file again afterwards.

What counts as a change of binding:
- adding a binding to an approved record;
- changing the set;
- removing the binding.

Every other record that binds the old set must be changed the same way. Otherwise the two records conflict and the gate refuses.

If the history cannot be read (a shallow or missing clone), a release touching a binding record is refused.

Example:
1. The owner approves releasing A, B and C together. The records of B and C carry `releaseSet: [A, B, C]`. Releasing `[A, B, C]` is allowed. Releasing `[A, B]` or `[A]` is refused.
2. The owner later decides A and B may go without C. B's record changes to `releaseSet: [A, B]` with `supersedes` naming decision 1 and a new `decision` link. C's record drops or changes its binding the same way.
3. Now `[A, B]` is allowed and `[A, B, C]` is refused.

### Backward compatibility
Records without `releaseSet` validate exactly as before. Their migrations keep the generic prefix behaviour, so existing records need no rewrite.

### Proof
- **`release-migrate-gate.mjs --self-test`:** the R-matrix, run with synthetic names:
  - no binding: an exact set and a shorter prefix are both allowed;
  - a bound set: exact is allowed; subset, superset and different are refused;
  - agreeing records are allowed; conflicting records are refused;
  - malformed sets (duplicate, unknown, own-missing, out of order, empty) are refused;
  - checksum and preflight still bind;
  - supersession: refused without `supersedes`, refused with the same decision link, allowed under a new decision, and both adding and removing a binding count as changes.
- **`.release-gate/release-set-lab.sh` (release-gate-lab.yml step 6):** the same cases through the real `plan` CLI in throwaway git checkouts, including the laundering attempt and a checkout with no git history.
