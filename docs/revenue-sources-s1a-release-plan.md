# S1-A release plan — Rivhit read-only ingest

Every step below needs its own explicit owner approval. Nothing here is executed by an agent without one. After every
step there is a **stop point**: verify, then decide whether to continue. The feature `pos_rivhit` stays OFF for every
business throughout. Turning it on, even for business 9, is a separate decision after the Rivhit answers.

## The pieces and their order

| # | What | Kind | Depends on |
|---|---|---|---|
| A | #848: the read model keeps non-POS evidence apart | code, `lib/revenue-truth` only | — |
| B | #842: migration `20261104090000_pos_rivhit_source` | migration files only | #841's `20261103090000_document_supplier_link` applied first, or approved together as the prefix |
| C | apply `20261104090000` (`release-migrate`) | Production schema (expand-only) | B merged |
| D | #846: Rivhit adapter, poller and owner API | code, flag OFF | A and C |

**Why this order:**
- **A comes first.** It is safe at any time: nothing in Production reads the model. #846 writes `ACCOUNTING_APP` rows, which only A keeps away from register figures.
- **C needs #841's migration first.** By the prefix rule, `20261104…` can only be applied after `20261103…` has been applied, or with it as one approved prefix.
- **D needs C applied.** D can create `pos.rivhit` connections and `revenue` routing rows only after the migration has widened the CHECKs.
- **Deploying D before C is harmless.** The owner API answers 404 while the flag is off, so no row is created. The order is kept anyway, following migration-first.

## Steps

1. **Merge #848.** `main` auto-deploys.
   - *Stop point:* the deployment is Ready and the domain points at it.
   - Nothing visible changes, because no route, page or job reads the model.
2. **Merge #842.** It contains migration files only, so the merge has no runtime effect.
3. **Preflight**, read-only: `prod-readonly-evidence` → `ops/evidence/pos-rivhit-source-preflight.sql`.
   - Expect **9/9 PASS**.
   - Check 3 needs every recorded migration to sort before `20261104…`. It holds once #841's migration is applied.
   - *Stop point:* any FAIL means do not apply.
4. **Apply**: `release-migrate` with the approved prefix ending in `20261104090000_pos_rivhit_source`. The owner approves `production-db`.
   - The migration makes no authority change (classifier: none), so no approval record is needed.
   - It runs in one transaction; a failure leaves nothing behind (lab-proven).
5. **Post-apply proof**, read-only: `ops/evidence/pos-rivhit-source-production-evidence.sql`.
   - Expect **11/11 PASS**, including the pinned checksum `14b9ec72…`, the feature OFF, no override, no `pos.rivhit` connection and no revenue row.
   - *Stop point.*
6. **Merge #846.** `main` auto-deploys. *Stop point:*
   - `/api/integrations/pos/rivhit` answers 404 for every business, because the flag is off.
   - The next intake sweep is healthy, with `revenueSources.calls` = 0.
   - The existing sources keep working: WhatsApp, leads, stores and telephony. The same check as in CI's `compat` job, now in Production: the sweep has no new failures.
7. **(Not part of this release.)** Enable `pos_rivhit` for business 9 only, with a Rivhit account and token the owner provides. This is a separate decision, after the Rivhit questions are answered (see the S1-A doc).

## Recovery

| Problem | Action | Effect on data |
|---|---|---|
| #848 misbehaves | revert the PR | none; the model is pure and unconnected |
| the migration fails | nothing to do: one transaction, so nothing is applied; the ledger shows it unfinished, and `release-migrate` refuses to continue until resolved | none |
| the migration must be undone | `.s1a/rollback.sql`, run in one transaction as the migration role, on an owner decision | it refuses while any `pos.rivhit` connection, `revenue` routing or `pos_rivhit` override exists |
| #846 misbehaves | revert the PR (the flag is off, so nothing was written) | none |
| after a future enablement | remove the business override, or set `emergencyDisabled` on `pos_rivhit` | polling stops at the next sweep. Revenue rows are append-only evidence: they stay, and are corrected only by decisions, never deleted |

## Not in this plan

- Any Rivhit contact. The inquiry is drafted and held until the owner decides, as the last step.
- PayPlus.
- Any screen.
- Any change to the home screen or the payables module.
- Retention or deletion policy.
