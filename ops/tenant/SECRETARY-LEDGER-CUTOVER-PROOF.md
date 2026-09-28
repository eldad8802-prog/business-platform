# Phase 2 — Secretary → ledger authority cutover: Production proof (QA tenant)

**Claim under proof:** with `SECRETARY_LEDGER_STORE=true`, the secretary writes
the payables ledger only (Commitment → Installment → Payment/Allocation when
actually paid), never `BusinessObligation`; snooze and "טופל" are workflow
only (handled ≠ paid); "שילמת? כן" uses the real payment path exactly once; the
next recurring occurrence materialises exactly once; the Daily Business Cost
engine reads the new rows; nothing crosses tenants.

**Constraints:** QA tenant only — business **38** (`COLLECTION_QA_BUSINESS_ID`,
`collection-qa-tenant.identity.env`). Every QA item is titled with the marker
**`QA-P2`**. No schema change, no data correction, no bridge removal.

## Evidence tools (both read-only, both bound to `production-db`)

| Tool | What it shows |
|---|---|
| *Prod Read-Only Evidence* → `ops/evidence/secretary-ledger-cutover-evidence.sql` | Q1 whole-table baselines (legacy rows, Payments, allocations…); Q2 the QA tenant's legacy rows; Q3–Q7 QA-P2 commitments, installments, workflow rows, payments, allocations; Q8 duplicates (all 0); Q9 the uniqueness constraints that make retries safe + FORCE RLS; Q10 an RLS probe **as `app_runtime`**, counts only |
| *Prod Read-Only Evidence (Daily Business Cost, QA tenant)* | the real engine for business 38 on chosen dates: QA-P2 lines, totals, cash out — session READ ONLY, verified before and after |
| *secretary-ledger-cutover-dry-run* | cutover state must stay copy 0 / reconcile 0 / totals 0 / conflicts 0 / invalid 0 / ambiguous 0 |

## Procedure

| # | Who | Step | Expected |
|---|---|---|---|
| 0 | Operator | Evidence SQL + cutover dry run (**baseline**) | legacy_obligations 9; cutover state all 0; Q3–Q7 empty |
| 1 | Owner | Vercel → Production env: set `SECRETARY_LEDGER_STORE` = `true` exactly; redeploy | deployment of `main` green |
| 2 | Owner | Log in as the QA tenant. Secretary → new obligation **`QA-P2 שכירות`**, 100 ₪, **monthly**, due **today** | appears in the secretary |
| 3 | Operator | Evidence SQL | Q3 1 commitment (RECURRING, no total, series id); Q4 1 installment; Q2 unchanged; Q6 none; Q1 legacy count unchanged |
| 4 | Operator | Business-cost evidence for today and +7 days | the QA-P2 line present (RECORDED), cash out 0 |
| 5 | Owner | Snooze `QA-P2 שכירות` ("לא עכשיו") | — |
| 6 | Operator | Evidence SQL + business-cost evidence (same dates) | Q5 followUpAt set; Q4 dueAt/amount unchanged; Q6 none; engine output identical to step 4 |
| 7 | Owner | "טופל" on `QA-P2 שכירות` → "שילמת?" → **לא, רק לסמן שטופל** | secretary shows it closed; next month's occurrence appears |
| 8 | Operator | Evidence SQL + business-cost evidence | Q5 handledAt set; Q6 still none, Q7 none (handled ≠ paid); Q4 sequence 2 exists exactly once; cash out still 0 |
| 9 | Owner | New obligation **`QA-P2 ביטוח`**, 50 ₪, monthly, due today → "טופל" → "שילמת?" → **כן**, 50 ₪, today, העברה בנקאית | — |
| 10 | Operator | Evidence SQL + business-cost evidence | Q6 exactly 1 Payment (key `secretary:<installment>:<date>:50`), Q7 exactly 1 allocation to installment #1; Q4 sequence 2 exactly once; cash out today 50 ₪ on the QA-P2 ביטוח payment; allocated cost unchanged by the payment |
| 11 | Owner | Repeat the same "כן" answer on the same item if the UI still offers it (a replay) | — |
| 12 | Operator | Evidence SQL | Q6 still 1 Payment; Q8 duplicate_payment_keys 0, duplicate_live_occurrences 0 |
| 13 | Operator | Evidence SQL Q10 (already in every run) | as `app_runtime`, bypassrls false: other-business rows visible to 38 = 0; QA rows visible to another business = 0; nothing visible without context |
| 14 | Operator | Cutover dry run (**after**) | still all 0; legacy_obligations still 9 with the same max id and last change |

## Idempotency boundaries (where retries are defined safe)

- **Payment**: `UNIQUE (businessId, idempotencyKey)`; the secretary's key is
  `secretary:<installmentId>:<paidDate>:<amount>` — a retried "כן" replays the
  first Payment. A different amount or date is, deliberately, a different payment.
- **Next occurrence**: `UNIQUE (commitmentId, sequence)`, and materialisation
  happens only when the LATEST occurrence is settled or handled; a second
  "טופל" on a closed item is a no-op.
- **Commitment creation** has no idempotency key: a double-submitted create
  form creates two commitments — exactly as the legacy store created two
  obligations. The UI disables the button while saving. (Documented limitation,
  unchanged by the cutover.)
- **Workflow row**: primary key = installmentId (upsert) — at most one per occurrence.

## Rollback

Set `SECRETARY_LEDGER_STORE` to `false` (or remove it) and redeploy: the
secretary reads/writes `BusinessObligation` again immediately. Anything created
in ledger mode stays in the ledger (and in the Daily Business Cost) but is not
shown by the legacy secretary. Nothing is deleted either way.

## QA data

QA-P2 rows stay in the QA tenant as evidence. They are not deleted by this
procedure; any cleanup is a separate, explicit owner decision.
