# Migration order: 20261025090000 (#756) → 20261026090000 (#769) → 20261027090000 (#745, re-timed)

Status: analysis for the owner, updated 2026-10-23. Nothing is applied by this document; no safety check is changed
by it. "Applied" is read from the release-migrate run history and the post-apply evidence runs (read-only GitHub run
history). Nobody read Production's ledger for this document.

## 1. Global order — applied tail and everything pending

| # | Migration | PR | On `main` | Release record (`ops/release-approvals/`) | Production |
|---|---|---|---|---|---|
| — | `20261022090000_task_reminders_push` | #740 | yes | yes | **applied** — release-migrate run 39686015405 (2026-10-21) |
| — | `20261024090000_platform_admin_a1` | #754 | yes | yes (`releaseSet` = itself) | **applied** — release-migrate run 39821445606 (2026-10-22 17:26Z: `prisma migrate deploy`, post-status and the post-apply ledger gate step all succeeded; the run's overall status shows "cancelled" after those steps), post-apply evidence run 39822895671 (all PASS) |
| 1 | `20261025090000_currency_settings_fx_rates` | #756 (open, ready) | no | no | not applied |
| 2 | `20261026090000_payment_settlement_facts` | #769 (draft, this PR) | no | no | not applied |
| 3 | `20261027090000_accountant_month_close` (was `20261023090000_…`) | #745 (open; app PR #750 stacked) | no | no | not applied; owner gate G1 not given |

There is no `20261023090000_*` any more: #745's migration was re-timed (§5). No release-migrate run has ever named
`20261023090000`, and no release record exists for it. No other open PR adds a migration directory (checked
2026-10-23: the files of every open PR). `sec/integration` #549 carries 2026-09 migrations and is DO-NOT-MERGE.

**Release in this order, one migration per release-migrate run.** Every migration's name sorts after every migration
already recorded in Production at the moment it is applied.

## 2. Dependencies

* **Objects:** #769 names nothing of #756 (its lab's step 0 asserts it: no `FxRate`, `BusinessLocaleSettings`,
  `UserLocalePreference`, `business_base_currency`, `fx_rate`). #756 does not name `PaymentSettlementFact`. #745
  names only its own `Accountant*` objects plus `Business`, `User`, `PlatformFeatureDefinition` / `Policy` (its lab's
  step 0 asserts it, and that no other migration names an accountant object). No object dependency between the three.
* **Builds on:** all three need `20261018090000_daily_tasks_foundation` (applied).
* **Ledger order is what decides it.** Each preflight refuses when a migration sorting after it is already recorded,
  because `prisma migrate deploy` itself does not enforce order (it applies an older-named pending migration after a
  newer applied one without complaint, and the history would no longer match the file order):
  * #756 `ops/evidence/currency-fx-preflight.sql` check 5: nothing recorded `> '20261025090000_currency_settings_fx_rates'`.
  * #769 `ops/evidence/payment-settlement-facts-preflight.sql` check 5: nothing recorded `> '20261026090000_payment_settlement_facts'`.
  * #745 `ops/evidence/accountant-month-close-preflight.sql` check 3: nothing finished `> '20261027090000_accountant_month_close'`
    (and the Daily Tasks foundation finished).
  * The release gate (`scripts/ci/release-migrate-gate.mjs`) refuses a release whose preflight run shows any `FAIL`
    row, and enforces the **prefix invariant**: `expected_migrations` must be exactly the first pending migrations on
    `main`, in Prisma order. A later pending migration never blocks an earlier one; an earlier pending one blocks
    every later one.

## 3. Gates, in order (none of them is given by this document)

**#756 — `20261025090000_currency_settings_fx_rates`**

1. Owner merges #756.
2. Owner approval record PR: `ops/release-approvals/20261025090000_currency_settings_fx_rates.json` in its own PR
   (sha256 of the merged `migration.sql`, the owner's decision link, the preflight run of step 3).
3. Read-only preflight on Production: `prod-readonly-evidence.yml` dispatched from `main` with
   `ops/evidence/currency-fx-preflight.sql`, after #756 reached `main`. No FAIL; check 5 observes 0.
4. `release-migrate` with `expected_migrations = 20261025090000_currency_settings_fx_rates`.
5. Post-apply evidence: `ops/evidence/currency-fx-production-evidence.sql` all PASS.

(The record must carry the run id of step 3 and must not land in the PR that adds the migration, so in practice the
preflight is dispatched right after the merge and the record PR then names it — as for every release so far.)

**#769 — `20261026090000_payment_settlement_facts`** — only after #756's step 5.

6. Owner merges #769 (not before #756 is merged — see §4).
7. Owner approval record PR: `ops/release-approvals/20261026090000_payment_settlement_facts.json`.
8. Read-only preflight on Production with `ops/evidence/payment-settlement-facts-preflight.sql`, after #769 reached
   `main` and after step 5. No FAIL; checks 3 and 5 observe 0.
9. `release-migrate` with `expected_migrations = 20261026090000_payment_settlement_facts`.
10. Post-apply evidence: `ops/evidence/payment-settlement-facts-production-evidence.sql` 20/20 PASS.

**#745 — `20261027090000_accountant_month_close`** — owner gate G1, only after #769's step 10.

11. Owner merges #745 (#750, the app PR, stays unmerged until step 15).
12. Owner approval record PR: `ops/release-approvals/20261027090000_accountant_month_close.json` (it adds policies
    and grants, so expect the classifier to mark it authority-changing).
13. Read-only preflight on Production with `ops/evidence/accountant-month-close-preflight.sql`: 11/11 PASS, check 3
    observes 0. The last preflight run, 39693852409 (2026-10-21), predates both the A1 apply and the re-time and does
    not count.
14. `release-migrate` with `expected_migrations = 20261027090000_accountant_month_close`.
15. Post-apply evidence: `ops/evidence/accountant-month-close-production-evidence.sql` 19/19 PASS; then #750 may merge.

Alternative with no check change: merge several, run their preflights from `main` before any is applied (all pass,
nothing of them is recorded yet), and release them in one run with `expected_migrations` naming them in Prisma
order and the records carrying the same `releaseSet`. The one-per-run order above is the recommended one: each
migration gets its own fresh preflight and post-apply evidence.

## 4. If the order is inverted

* **20261026 applied before 20261025:** #756's check 5 observes 1 and its preflight FAILs; 20261025 can no longer be
  released without re-timing #756 (and the PRs that cite it, #764) or weakening check 5 (not allowed). #769's lab
  demonstrates it (step 2b). The prefix invariant protects the order only once **both** are on `main`, so: do not
  merge #769 before #756, and do not dispatch 20261026's release before 20261025 is applied.
* **20261027 (#745) applied before 20261025 / 20261026:** the same failure for #756 and #769 (their check 5 would
  observe 1). It cannot happen through the gate while #756 / #769 are on `main` and pending (they are then the first
  pending migrations, so `expected_migrations = 20261027…` alone is refused). It could happen only if #745 were merged
  and released while #756 / #769 are still unmerged. Rule: **#745 merges after #769 is applied** (step 11 after
  step 10).

## 5. The accountant re-time (#745): `20261023090000` → `20261027090000`

**Why.** `20261024090000_platform_admin_a1` was applied in Production on 2026-10-22 (runs above).
`20261023090000_accountant_month_close` therefore sorted before an applied migration:

* its own preflight check 3 would FAIL in Production (observed 1), so no release record could be built on it;
* if merged as it was, it would be the first pending migration, and the prefix invariant would refuse
  `expected_migrations = 20261025…` and `20261026…` — it would block #756 and #769.

**Why after, not before (e.g. `20261024100000`).** A name between 20261024 and 20261025 would also pass #745's
check 3 today, but it would make #745 the first pending migration as soon as it is merged, so the currency track
(#756, #769) would wait on #745's owner gate G1, which has not been given. After the two, #745 never blocks them,
and #756 / #769 stay exactly as reviewed (no re-time, no new pins).

**What changed (PR #745 only).** The folder `prisma/migrations/20261023090000_accountant_month_close` became
`20261027090000_accountant_month_close`; every reference in `.acct/lab.sh`, `.acct/battery.ts`, `.acct/rollback.sql`,
`.github/workflows/accountant-month-close-lab.yml`, `ops/evidence/accountant-month-close-preflight.sql` and
`ops/evidence/accountant-month-close-production-evidence.sql` was renamed. The two evidence files are on `main` since
#751; they change in #745 itself, so the migration, its preflight and its proof land on `main` under the same name in
one merge (the preflight must run after that merge anyway). `migration.sql` is byte-identical: Prisma's checksum is
the sha256 of the file content, not of the folder name, so the pinned sha256
`dffae663489f3625f99d58be9c225e7f13f2f5bf5562e03929de8f990582a41a` is unchanged. No check was weakened. The lab now
records every other migration of the checkout in its ledger (as Production's is, `platform_admin_a1` included) and
asserts that check 3 passes on it and FAILs when a later finished migration is present.

**Applied history untouched.** No applied migration directory, no `ops/release-approvals/*.json` and no applied
migration's evidence file is modified. `20261023090000_accountant_month_close` was never in any ledger outside the
labs (no release-migrate run ever named it).

## 6. General rule

Release in Prisma (name) order. A migration that is not yet applied anywhere may be re-timed so that it sorts after
every applied one; a migration that is applied anywhere is never renamed or edited. A re-time changes the sha256
only if the file content changes; a pure rename keeps it, but still needs a fresh lab run and, after the merge, a
fresh preflight.
