# DEV database drift — incident record (2026-08-23)

**Environment:** Neon branch `ep-square-grass-amqdtlrl`, database `neondb` — the shared
**development** branch. Production (`ep-flat-brook`) was never touched and is not
affected by anything in this document.

**Trigger:** the Collection MVP required a smoke test of
`lib/services/billing/collection/awaiting-payment.loader.ts` against a real database,
because it is the only part of that feature the pure tests cannot reach.

---

## 1. What was observed

Running `npx prisma migrate deploy` failed:

```
Error: P3009
migrate found failed migrations in the target database, new migrations will not be applied.
The `20260329225659_init` migration started at 2026-07-07 11:14:44.792778 UTC failed
```

Running the smoke test anyway failed differently:

```
P2022  The column `BusinessProfile.billingSignatureDataUrl` does not exist in the current database.
```

That column comes from `20260817130000_add_billing_signature_data_url` — so the DEV
schema was also physically behind `main`, independently of the ledger problem.

Reading the ledger directly showed the real state. **`_prisma_migrations` held 3 rows
against 94 migration files on disk:**

| migration | finished | rolled back |
|---|---|---|
| `20260210120000_billing_invoice_profile_fields` | yes | no |
| `20260329225659_init` | **no** | no |
| `20260820120000_add_billing_payment_terms_days` | yes | no |

`prisma migrate status` therefore reported 91 migrations as "not yet applied" — while
the application had been running against this database for months, with tables those
same migrations create.

## 2. What this means

**Observed:** the DEV ledger is not a record of how the DEV schema was built. Almost
every migration that shaped it was applied by some path that never wrote a ledger row
(`db push`, manual SQL, or a reset that cleared the table). The single unfinished
`init` row from 2026-07-07 is what blocks `migrate deploy` today.

**Observed:** the DEV schema was additionally missing at least one August column that
exists on `main`.

**Inferred (not proven):** the drift accumulated over a long period and is unrelated to
the Collection work. The evidence supports "the ledger predates this change" — it does
not identify who or what cleared it, and no attempt was made to find out.

**Not established:** whether Production's ledger is in the same state. Nothing here was
run against Production, and no claim is made about it. That is worth checking
separately, because the gated `release-migrate` workflow depends on `migrate deploy`
working there.

## 3. What was done, and why

The goal was a working DEV database for one smoke test — not a repair of DEV history.

1. **`ALTER TABLE "BusinessProfile" ADD COLUMN IF NOT EXISTS "billingPaymentTermsDays" INTEGER`**
   — the exact statement in `20260820120000_add_billing_payment_terms_days/migration.sql`,
   applied by hand because `migrate deploy` was blocked. Additive, nullable, expand-only.
2. **`npx prisma migrate resolve --applied 20260820120000_add_billing_payment_terms_days`**
   — so the hand-applied column is recorded rather than left as silent drift.
3. **`npx prisma db push --skip-generate`** — to close the remaining gap between the DEV
   schema and `schema.prisma`.

### Why `db push` and not something safer

`migrate deploy` was unavailable (P3009) and fixing that would have meant resolving or
rolling back an unfinished `init` migration on a shared database — a larger and riskier
action than the task required.

`db push` was chosen because it **refuses destructive changes** unless
`--accept-data-loss` is passed, which it was not. Without that flag it aborts rather
than drop a column or table. The command completed with
`Your database is now in sync with your Prisma schema` and reported no destructive
operation, so what it did was additive.

**The cost, stated plainly:** `db push` does not write ledger rows. DEV's ledger is
therefore still 3 rows against 94 files, and this action did not improve that — it only
avoided making it worse. `migrate deploy` on DEV will still fail with P3009 until the
`init` row is resolved by someone who decides that is worth doing.

## 4. State after alignment

- DEV schema: in sync with `prisma/schema.prisma` at commit base `7b48572` plus
  `billingPaymentTermsDays`.
- DEV ledger `_prisma_migrations`: **3 rows / 94 files**, `20260329225659_init` still
  unfinished.
- `prisma migrate deploy` on DEV: **still blocked** (P3009). Unchanged by this work.
- `prisma db push` on DEV: works.
- Production: untouched, unexamined, no claim made.

## 5. Consequences for the Collection MVP merge

The migration `20260820120000_add_billing_payment_terms_days` still has to reach
Production through the gated `release-migrate` workflow, exactly as it would have
anyway. Nothing in this incident changes that, and nothing here was a shortcut around
it.

Ordering matters at deploy time: `resolvePaymentTermsDays` falls back to 30 days when
the value is NULL, so a missing *value* is safe — but a missing *column* is not. The
migration must land before the code.

## 6. Open items (not actioned)

- Decide whether DEV's ledger is worth repairing, or whether DEV is simply a `db push`
  environment and should be documented as such.
- Verify Production's `_prisma_migrations` state independently. If it shares this
  condition, the release pipeline has a latent problem that has not yet been triggered.
