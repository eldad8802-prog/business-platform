# C-2 migration runbook — `20261025090000_currency_settings_fx_rates`

Migration: `prisma/migrations/20261025090000_currency_settings_fx_rates/migration.sql`
Lab: `.github/workflows/currency-fx-migration-lab.yml` (`.fx/`) · Rollback: `.fx/rollback.sql`
Preflight / proof: `ops/evidence/currency-fx-preflight.sql`, `ops/evidence/currency-fx-production-evidence.sql`

**Nothing here has been applied anywhere but throwaway CI databases.** The migration PR is migration-only
(no `schema.prisma`, no runtime code). The owner approval record is a separate, later PR.

---

## 1. What it adds (additive only — no existing object changes)

| Object | Shape | Isolation / privileges |
|---|---|---|
| `BusinessLocaleSettings` | PK `businessId` → `Business` (cascade); `locale` he\|en (def `he`), `region` `^[A-Z]{2}$` (def `IL`), `timeZone` IANA-shaped ≤64 (def `Asia/Jerusalem`), `baseCurrency` / `displayCurrency` ILS\|USD\|EUR (def `ILS`, NOT NULL), `version` ≥1, `createdAt`, `updatedAt` | ENABLE + FORCE RLS; `business_locale_settings_tenant_{select,insert,update}` on `app.current_business_id`; app_runtime SELECT/INSERT/UPDATE; no DELETE (business deletion cascades) |
| base-currency guard | trigger `BusinessLocaleSettings_base_currency_lock` (BEFORE INSERT OR UPDATE OF baseCurrency) → `business_locale_base_currency_lock()` (SECURITY DEFINER) → `business_financial_data_exists(int)` (SECURITY DEFINER, EXECUTE for nobody) over 12 ledgers (not HistoricalFiscalDocument — see §7): BillingDocument, FinancialRecord, FinancialEvent, PaymentRequest, Payment, Cheque, PaymentPreparation, ExternalTransaction, OutboundExecution, BusinessObligation, Commitment, CommerceOrder | `business_base_currency_locked()` (SECURITY DEFINER, tenant from the GUC, no argument) — EXECUTE for app_runtime only |
| `UserLocalePreference` | PK `userId` → `User` (cascade), `businessId` → `Business` (cascade, indexed), `locale` he\|en, `createdAt`, `updatedAt` | ENABLE + FORCE RLS; `user_locale_preference_own_{select,insert,update}`: businessId = `app.current_business_id` **AND** userId = `app.current_user_id`; trigger `UserLocalePreference_user_same_business` (existing `task_user_same_business`); app_runtime SELECT/INSERT/UPDATE |
| `FxRate` | `id` serial, `base`/`quote` ILS\|USD\|EUR (≠), `rate` numeric(20,10) > 0, `kind` REPRESENTATIVE\|DISPLAY, `source` BANK_OF_ISRAEL\|MANUAL (BoI ⇒ REPRESENTATIVE + quote ILS), `rateDate` date ≤ fetchedAt+1 day, `fetchedAt` (def now), `verification` VERIFIED\|UNVERIFIED (def UNVERIFIED), `sourceRef` ≤2048; unique (base, quote, kind, source, rateDate, fetchedAt); index (base, quote, kind, rateDate DESC, fetchedAt DESC) | ENABLE + FORCE RLS with `fx_rate_read` (SELECT, true) and `fx_rate_append` (INSERT, true) only; triggers `FxRate_append_only` (UPDATE/DELETE, row) + `FxRate_no_truncate` (statement) → `fx_rate_append_only_guard()` refuse **for every role incl. owner and superuser**; app_runtime SELECT only |
| `fx_rate_writer` | NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION; created only if absent; an existing role of that name must have exactly that shape and no memberships, or the migration aborts | INSERT on `FxRate` + USAGE on `FxRate_id_seq`; nothing else (no SELECT — append without RETURNING) |

Every grant the owner's DEFAULT PRIVILEGES hand out on the new tables / sequence / functions is revoked from
every grantee first; PUBLIC holds nothing. Error codes: `DZF01` append-only, `DZF02` base currency fixed,
`DZF03` guard preconditions (no context, not READ COMMITTED, role cannot see every row, writer shape).

**Defaults for existing data — no backfill.** No existing row is written. A business without a settings row
*is* he / IL / Asia/Jerusalem / ILS / ILS; a user without a preference *is* Hebrew. A backfill would write
N rows in an authority-changing release and still be incomplete (businesses created by the current code
after the migration get no row), so "absent ⇒ defaults" is the contract either way. Proven in the lab:
seeded rows are byte-identical after the migration; an absent row reads as the defaults; a row created
with only its key carries exactly those defaults.

**Currency CHECKs = the supported set (ILS/USD/EUR), not an ISO pattern.** The money engine
(`lib/money/currency.ts`) refuses every other code, so the database refusing them too keeps the two in step;
widening is a deliberate one-line migration (replace the CHECK) on small tables. The ledgers keep their own
existing ISO-pattern / free currency columns — untouched.

### Base-currency guard — why it is correct and race-safe
- It looks at the **data**, not at a flag: the proposal's `baseCurrencyLockedAt` would have stayed NULL for
  every existing business (nothing set it), leaving businesses with years of ILS records unlocked; and an
  INSERT with another base was not checked at all.
- Effective base = `OLD.baseCurrency`, or `ILS` when the row is being created. Unchanged → no work, no lock.
- Changed → refuse unless the session is READ COMMITTED and the function's role sees every row
  (BYPASSRLS / superuser, asserted at run time); `SELECT … FROM "Business" WHERE id = … FOR UPDATE`; then, in
  a new statement snapshot, refuse if any financial row exists.
- Race: every financial insert takes `FOR KEY SHARE` on its `Business` row through its foreign key (all 12
  ledgers have one — preflight check 11), which conflicts with `FOR UPDATE`. A first financial row in flight
  makes the change wait and then refuse (lab race 1); a change in flight makes the financial insert wait
  until it commits (lab race 2) — the serial order "change, then row", which is allowed.
- **Contract for the app PR:** code that *reads* the base currency to compute a financial row must first take
  `SELECT 1 FROM "Business" WHERE "id" = $1 FOR KEY SHARE` in the same transaction (otherwise it could read
  ILS, the change commits, and it writes an ILS-computed row under a USD base).
- No bypass exists. Changing the base currency of a business that has financial records is a future,
  separately reviewed procedure.

### Per-user preference isolation — the new GUC
`app.current_user_id` is new: no code sets it today, so today nobody (runtime) can read or write
`UserLocalePreference` at all (fail closed). The app PR sets it with `set_config('app.current_user_id', $id,
true)` in the same transaction as `app.current_business_id`.

### FxRate append-only — the documented exception
A correction is a new row with a later `fetchedAt`; readers pick the newest (`selectRate`). Removing a row
(e.g. a poisoned value) is possible only for the table owner, deliberately and visibly, in a reviewed
owner-run script: `BEGIN; ALTER TABLE "FxRate" DISABLE TRIGGER "FxRate_append_only"; DELETE …;
ALTER TABLE "FxRate" ENABLE TRIGGER "FxRate_append_only"; COMMIT;` — never from the application.

## 2. Intended Prisma models (for the later schema PR — NOT in schema.prisma now)

Names, defaults, keys and index names are Prisma's own conventions, so `prisma migrate diff` sees no drift
(the lab proves it: step 2b). CHECKs, policies, triggers and functions are invisible to Prisma by design.

<!-- fx-prisma-models:start -->
```prisma
model BusinessLocaleSettings {
  businessId      Int      @id
  locale          String   @default("he")
  region          String   @default("IL")
  timeZone        String   @default("Asia/Jerusalem")
  baseCurrency    String   @default("ILS")
  displayCurrency String   @default("ILS")
  version         Int      @default(1)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  business        Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
}

model UserLocalePreference {
  userId     Int      @id
  businessId Int
  locale     String
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt
  user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  business   Business @relation(fields: [businessId], references: [id], onDelete: Cascade)

  @@index([businessId])
}

model FxRate {
  id           Int      @id @default(autoincrement())
  base         String
  quote        String
  rate         Decimal  @db.Decimal(20, 10)
  kind         String
  source       String
  rateDate     DateTime @db.Date
  fetchedAt    DateTime @default(now())
  verification String   @default("UNVERIFIED")
  sourceRef    String?

  @@unique([base, quote, kind, source, rateDate, fetchedAt])
  @@index([base, quote, kind, rateDate(sort: Desc), fetchedAt(sort: Desc)])
}
```
<!-- fx-prisma-models:end -->

Back-relations to add in the same PR — `model Business`: `localeSettings BusinessLocaleSettings?` and
`userLocalePreferences UserLocalePreference[]`; `model User`: `localePreference UserLocalePreference?`.
The app PR must also classify the three models in `scripts/ci/erasure/erasure-model-coverage.ts`
(proposed: `BusinessLocaleSettings` / `UserLocalePreference` NON_PERSONAL_OPERATIONAL — removed by the
Business / User cascade; `FxRate` SYSTEM_INTERNAL).

## 3. Preconditions (all must hold before the apply)

1. The migration PR is merged to `main` by the owner (CI green, including `currency fx — migration lab`).
2. Nothing sorting after `20261025090000` has been applied (preflight check 5). #745 `20261023…` and #754
   `20261024…` sort **before** it: release-migrate applies only the *first* pending migrations, so if either
   is merged but not yet applied, it must be released first (or in the same owner-approved set, in Prisma
   order). Neither touches the objects this migration names.
3. **Preflight** — Actions → `prod-readonly-evidence` → `ops/evidence/currency-fx-preflight.sql`, dispatched
   from `main` after the merge: checks 1–16 and 20 PASS, 17–19 INFO. Read the INFO values: 17 = default ACL
   entries the migration takes back; 18 = whether PUBLIC has USAGE on schema `public` (the future writer
   login needs schema USAGE — only relevant at C-3); 19 = businesses whose base currency will be fixed at ILS
   from the first minute.
4. The owner approval record `ops/release-approvals/20261025090000_currency_settings_fx_rates.json` lands in
   **its own PR** (the classifier marks this migration authority-changing: ROLE, GRANT, REVOKE, RLS, POLICY,
   SECURITY DEFINER): `sha256` of migration.sql (LF), the owner's `decision` link, `preflightRun` = the run of
   step 3, `preflightFile`, and `releaseSet` if the owner binds it (`ops/release-approvals/README.md`).

## 4. Apply path (the repository's only one — docs/RELEASE-OWNERSHIP.md)

Actions → **release-migrate** (workflow_dispatch, from `main`) with `expected_migrations` = exactly the
pending set (this migration alone, unless the owner releases a set) → pauses on the `production-db`
environment for the owner's approval → `prisma migrate deploy` over the direct connection → re-checks status.

**Lock / time expectations.** One transaction (Prisma applies the file as one script; lab step 5 proves a
failure leaves nothing behind). No existing table is rewritten or scanned. The three foreign keys take a
`SHARE ROW EXCLUSIVE` lock on `Business` and `User` until commit — writes to those two tables (signup,
login counters, business rename) wait for the few milliseconds the migration runs; reads never wait. If
a long transaction holds a conflicting lock on `Business` / `User`, the migration waits for it — run it at a
quiet time and watch the release-migrate log; expected total time well under one second.

## 5. Verification after the apply

1. `prod-readonly-evidence` → `ops/evidence/currency-fx-production-evidence.sql`: 23/23 PASS (21 is the
   bounded Neon platform-admin exception, as in every recent proof).
2. `prod-readonly-evidence` → the preflight again: exactly checks 4, 7, 8, 9 FAIL ("not there yet" is now
   "there"), everything else unchanged.
3. Production behaviour: unchanged by construction — no running code references the new objects. Glance at
   the app (login, Home, documents) as usual.

## 6. Rollback

`.fx/rollback.sql`, owner-run as the migration role (Neon SQL editor or psql over the direct connection) —
never automatic. One transaction. It **refuses** while any of the three tables holds a row, or while a
LOGIN role is a member of `fx_rate_writer`; otherwise drops the three tables (policies, triggers, indexes,
sequence and grants go with them), the four functions and the role, and deletes its own ledger row so a
later `release-migrate` re-applies the migration whole. Lab step 6 proves: refusal changes nothing; after
the rollback the schema fingerprint (relations, columns, constraints, indexes, policies, triggers, functions,
types, default ACLs, ledger, roles) is identical to before the migration and the preflight passes again;
step 7 runs the current app's DB tests on the rolled-back database; step 8 re-applies it whole (23/23).

Lock: dropping the tables briefly locks `Business` / `User` (their foreign-key triggers are removed) — a
few milliseconds.

**If the application PR is already live:** roll the application back FIRST (revert its PR, wait until the
Production alias serves the reverted deployment — auto-deploys can lag or land out of order), because the
live code would otherwise fail on the missing tables (settings screen and language persistence errors;
anything reading base currency must already fall back to ILS when no row exists). Once the app writes
rows, the rollback refuses by design; discarding owners' language / currency choices or stored rates is a
separate explicit owner decision (an owner-run variant without the row check — `DROP TABLE` is not blocked
by the append-only triggers). While the app is reverted and the tables remain, nothing breaks: the
migration is inert without its consumer, so the usual choice is to **leave it applied**.

## 7. Risks and open points

- New GUC `app.current_user_id` (above): a new runtime contract; until the app sets it, the preference
  table is unreachable for the runtime (fail closed).
- `HistoricalFiscalDocument` (imported records of the business's previous system) is deliberately NOT in
  the guard: the I-8A firewall (`historical-fiscal-persistence.verify.test.ts`, run by AD-2A) forbids any
  later migration to name that table. A business whose only financial data is an import can therefore still
  change its base currency — owner decision whether that needs a separate, firewall-reviewed change.
- The guard's financial-table list is fixed in `business_financial_data_exists`; a new ledger table later
  must be added there (in its own migration) or it will not fix the base currency.
- The guard needs the migration role to keep BYPASSRLS (asserted at run time: it refuses instead of
  silently seeing nothing).
- The Neon platform admin path (pg_write_all_data + BYPASSRLS) could append to `FxRate`; it can still not
  change or remove a row (triggers fire for every role).
- Not verified anywhere but CI: Production's actual role attributes and default ACLs — that is what the
  preflight measures before anyone approves.
