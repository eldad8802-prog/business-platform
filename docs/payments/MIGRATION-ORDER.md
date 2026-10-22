# Migration order: 20261025090000 (PR #756) → 20261026090000 (PR #769)

Status: analysis for the owner, 2026-10-23. Nothing is applied by this document; no safety check is changed by it.

## 1. What is pending, where

| Migration | PR | On `main` | Release record (`ops/release-approvals/`) | Production |
|---|---|---|---|---|
| `20261022090000_task_reminders_push` | #740 | yes | yes | **applied** — release-migrate run 39686015405 (2026-10-21) |
| `20261023090000_accountant_month_close` | #745 (open, stacked #750) | **no** | no | not applied |
| `20261024090000_platform_admin_a1` | #754 | yes | yes (`releaseSet` = itself) | **applied** — release-migrate run 39821445606 (2026-10-22 17:26Z: `migrate deploy` and the ledger gate step succeeded; the run's overall status shows "cancelled" after those steps), post-apply evidence run 39822895671 |
| `20261025090000_currency_settings_fx_rates` | #756 (open) | no | no | not applied |
| `20261026090000_payment_settlement_facts` | #769 (draft, this PR) | no | no | not applied |

No other open PR adds a migration directory (checked: every open PR's files; `sec/integration` #549 carries
2026-09 migrations and is DO-NOT-MERGE). "Applied" is read from the release-migrate run history and the post-apply
evidence runs. Nobody read Production's ledger for this document.

## 2. Dependencies

* **Objects:** #769 names nothing of #756 (the lab's step 0 asserts it: no `FxRate`, `BusinessLocaleSettings`,
  `UserLocalePreference`, `business_base_currency`, `fx_rate`). #756 does not name `PaymentSettlementFact`. So
  either order gives the same final schema.
* **Builds on:** #769 needs `20261018090000_daily_tasks_foundation` (its `task_user_same_business`), which is
  applied (#769 preflight check 6).
* **Ledger order is what decides it.** Both PRs' preflights refuse when a migration sorting after them is already
  recorded. That check exists because `prisma migrate deploy` itself does not enforce order: it applies an
  older-named pending migration after a newer applied one without complaint, so the schema history would no longer
  match the file order.
  * #756 `ops/evidence/currency-fx-preflight.sql` check 5:
    `(SELECT count(*) FROM "_prisma_migrations" WHERE migration_name > '20261025090000_currency_settings_fx_rates') = 0`
  * #769 `ops/evidence/payment-settlement-facts-preflight.sql` check 5:
    `(SELECT count(*) FROM "_prisma_migrations" WHERE migration_name > '20261026090000_payment_settlement_facts') = 0`
  * The release gate (`scripts/ci/release-migrate-gate.mjs`) refuses a release whose preflight run shows any
    `FAIL` row (`checkPreflightVerdict`). It also enforces the **prefix invariant**: the migrations named in
    `expected_migrations` must be exactly the first pending migrations on `main`, in Prisma order.

## 3. The safe order, with NO change to any safety check

**`20261025090000_currency_settings_fx_rates` first, then `20261026090000_payment_settlement_facts`.**

* After 20261025 is applied, #769's check 5 compares `'20261025…' > '20261026…'`, which is false. It observes 0
  and passes. The lab proves it (workflow step 2b: a ledger with 20261025 recorded, and the preflight then gives
  19/19 PASS or INFO, check 5 = 0).
* 20261025 is released while nothing after it is recorded (the latest applied is 20261024), so #756's check 5
  passes too.

### Gates, in order

1. **G1:** owner reviews and merges #756. #769 stays unmerged until then (see §4 for why).
2. **G2:** `prod-readonly-evidence.yml` dispatched from `main` with `ops/evidence/currency-fx-preflight.sql`. Every
   check must PASS or be INFO, and check 5 must observe 0.
3. **G3:** a release record `ops/release-approvals/20261025090000_currency_settings_fx_rates.json` in its own PR,
   carrying that preflight run. Then `release-migrate` with
   `expected_migrations = 20261025090000_currency_settings_fx_rates`, followed by #756's post-apply evidence.
4. **G4:** owner merges #769.
5. **G5:** `prod-readonly-evidence.yml` dispatched from `main` with
   `ops/evidence/payment-settlement-facts-preflight.sql`, run after #769 reached `main` and after G3. Expect 19
   rows, no FAIL, check 5 = 0 and check 3 = 0.
6. **G6:** a release record `ops/release-approvals/20261026090000_payment_settlement_facts.json` in its own PR.
   Then `release-migrate` with `expected_migrations = 20261026090000_payment_settlement_facts`.
7. **G7:** `ops/evidence/payment-settlement-facts-production-evidence.sql` must give 20/20 PASS. Its checksum pin is
   this PR's `migration.sql` sha256.

Alternative, also with no check change: merge both, run both preflights from `main` before either is applied (both
pass, because neither is recorded yet), and release them in **one** run,
`expected_migrations = 20261025090000_currency_settings_fx_rates,20261026090000_payment_settlement_facts`. The two
records then carry the same `releaseSet` in that order. The two-run order above is the recommended one: each
migration gets its own fresh preflight and post-apply evidence, as every release so far has.

## 4. If the order is inverted

If 20261026 is applied first:

* #756's check 5 observes 1 (this migration sorts after it), so its preflight FAILs. The release gate then refuses
  every release record built on that preflight. **20261025 cannot be released** without one of these:
  (a) re-timing #756's migration to sort after 20261026: a new name and sha256, a new lab run, re-review, and
  updates to the PRs that cite "after 20261025090000" (#764);
  (b) changing #756's check 5, which weakens a safety check and is not allowed without explicit proof and review.
  Both are rework, and neither is needed if the order is kept.
* The lab demonstrates this (step 2b: on a database where 20261026 is applied, #756's check-5 query observes 1).

How it could happen: the prefix invariant protects the order only once **both** migrations are on `main`. If #769
is merged while #756 is not, 20261026 is the first pending migration and a release of it alone would pass the
gate. **Rule: do not dispatch the release of 20261026090000 until 20261025090000 is applied.** The simplest way is
to not merge #769 before #756 (G1 before G4).

## 5. The accountant migration (#745), which blocks both releases if merged as it is

* `20261023090000_accountant_month_close` is **not** on `main`, not applied, and has no release record (the
  program stopped at G1).
* `20261024090000_platform_admin_a1`, which sorts after it, **is applied**. So #745's own preflight check 3 ("no
  finished migration sorts after this one") would **FAIL** in Production today. Its last preflight run,
  39693852409 (2026-10-21 23:30Z), predates that apply. #745 therefore cannot be released under its current name.
* If #745 is merged to `main` unchanged, 20261023 becomes the **first pending** migration. The prefix invariant
  then refuses `expected_migrations = 20261025…` (and `20261026…`): "pending but NOT approved, and it would have
  to run before …". 20261023 cannot be approved either, because its preflight fails. **Merging #745 as it is
  blocks the release of both #756 and #769.**
* Resolution, owner decision and outside this PR: re-time #745's migration to a name that sorts after the latest
  migration applied when it is released (for example after 20261026), and release it in name order like the
  others. This PR does not modify #745 or #756.

## 6. General rule

Release in Prisma (name) order. Every migration's name must sort after every migration already recorded in
Production when it is applied. Any re-timing changes the migration's sha256, so it needs a new lab run, a new
checksum pin and new release records.
