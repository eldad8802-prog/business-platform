# Temporal knowledge catalogue (M6)

This is the canonical contract for **per-business temporal knowledge**: what is normal for *this*
business, what is stable, what is changing, and what is unusual against its own history. It also
records when Dubiz simply does not have enough history to say.

The code implements this document:

- Rules: [`lib/knowledge/temporal/rules.ts`](../../lib/knowledge/temporal/rules.ts)
- Statistics: [`engine.ts`](../../lib/knowledge/temporal/engine.ts) and [`robust.ts`](../../lib/knowledge/temporal/robust.ts)
- Persistence: [`temporal-writer.ts`](../../lib/knowledge/temporal/temporal-writer.ts)
- Read contract for M7: [`lib/knowledge/knowledge-selector.ts`](../../lib/knowledge/knowledge-selector.ts)

The evidence boundary is [`SENSOR_COVERAGE.md`](./SENSOR_COVERAGE.md).
`lib/knowledge/temporal/temporal.test.ts` parses it and fails if a rule depends on a row that is not
`COVERED` or `COVERED_BY_DOMAIN_STATE`, unless the rule justifies a `PARTIAL` row for the exact
fields it reads.

## Principles this layer cannot violate

1. **A business is compared only to itself.** There is no cross-business baseline, cohort, average
   or prior. Every series is built from one business's observations, loaded inside that business's
   tenant transaction; the loader takes one `businessId` and nothing else. An entity (a payee, a
   supplier, a resolved vendor party, an inventory item) is compared only to its own history.
2. **No history means "insufficient history".** A new business, customer or supplier gets
   `INSUFFICIENT_HISTORY` with the exact shortfall. It never gets a borrowed or invented baseline.
3. **Types are not collapsed.** BASELINE, STABLE_PATTERN, TREND, MATERIAL_CHANGE and ANOMALY are
   separate artifacts with separate tests.
4. **A deviation is not an explanation.** No artifact carries a cause. "Charges are above this
   vendor's usual range" is allowed. "The vendor raised prices" is not.
5. **Owner truth is not overridden.** Temporal knowledge is derived from evidence that already
   reflects owner corrections, reversals and identity decisions. It is interpretation, never a new
   source of truth, and it has no authority to merge entities.
6. **No model, no LLM, no confidence percentage.** Every threshold is a stated, deterministic rule.
   Uncertainty is expressed as a *reason*: `NO_OBSERVATIONS`, `TOO_FEW_OBSERVATIONS` or
   `TOO_SHORT_HISTORY` (with `have` / `need` / span), or as `STALE`.

## Persisted shape: `TemporalKnowledge`

Temporal knowledge is its own table (migration `20260926090000_m6_temporal_knowledge`), not an
extension of `KnowledgeMeasure`. `KnowledgeMeasure` holds exactly one current answer per slot (its
writer deletes and re-creates), which is right for a measure. Temporal knowledge must keep history: a
baseline that shifted stays auditable as the baseline that *was*, and a material change is by
definition two windows. The same evidence sources feed both tables, and `KnowledgeMeasure` is
unchanged.

| Field | Meaning |
|---|---|
| `businessId` | the one business (FK, ENABLE + FORCE RLS) |
| `temporalKey`, `domain`, `rulePolicyVersionId` | which rule, and which governed version |
| `knowledgeType` | BASELINE, STABLE_PATTERN, TREND, MATERIAL_CHANGE or ANOMALY |
| `status` | ACTIVE, INSUFFICIENT_HISTORY, STALE or SUPERSEDED |
| `entityType` / `entityId` | NULL means business level; otherwise the entity (party, payee, supplier, inventory-item) |
| `contextKey` | a same-business slice (e.g. `direction=expense`); `''` means none |
| `valueKind`, `unit` | duration / amount / cadence / rate |
| `asOf`; `historyStart` → `historyEnd`; `recentStart` → `recentEnd` | every window derives from `asOf`, never from the clock |
| `historyCount`, `recentCount` | observations in each window |
| `baseline`, `recent`, `finding`, `reason` | robust summaries, the classification's own numbers, and the insufficiency reason |
| `evidenceRefs`, `evidenceFingerprint` | the contributing records (ids only) and a sha256 of the sorted set |
| `semanticHash` | identity of the conclusion; used to make re-runs a no-op |
| `materializedAt`, `confirmedAt`, `supersededAt` | when it was concluded, last re-confirmed, and replaced |

**Append-and-supersede.**
- Same conclusion from the same evidence: nothing new is written; only `confirmedAt` moves. This is
  what makes retries idempotent.
- A changed conclusion: the old row becomes `SUPERSEDED` (kept) and a new row is appended.
- A slot the run no longer produces (an anomaly that is no longer current, a pattern that stopped
  holding): `STALE` if the rule version is the same, `SUPERSEDED` if a new version replaced it.
- The runtime role has **no DELETE** on the table.

## How each type is decided

**Windows.** `recent` = `[asOf − recentDays, asOf]`. `history` = the `historyDays` before that.
**The baseline is built from history only.** Recent observations are compared against it and never
feed it. A new level becomes the baseline only by ageing into the history window, and the previous
baseline row is then superseded. This is the protection against baseline poisoning.

| Type | Numeric series (duration, amount, cadence) | Rate series |
|---|---|---|
| **INSUFFICIENT_HISTORY** | history count below `minHistory`, or history span below `minSpanDays`. **Nothing else is produced without a baseline.** | same |
| **BASELINE** | median, q1, q3, IQR, MAD, min, max. `STALE` if nothing was observed for `staleAfterDays`; a stale baseline produces nothing about the present. | proportion (hits / n) |
| **STABLE_PATTERN** | IQR ≤ max(`stableRelativeSpread` × \|median\|, material floor) | the three equal thirds of history agree within the material floor (each third ≥ max(5, minHistory ÷ 4)) |
| **MATERIAL_CHANGE** | recent count ≥ `minRecent`; recent median outside [q1, q3]; the shift ≥ material floor **and** ≥ 1.5 × robust scale; at least 75% of recent points on the same side. `candidateNewBaseline` is true only once the recent window has a baseline's support. | \|Δp\| ≥ material floor **and** \|two-proportion z\| ≥ 2.58 |
| **ANOMALY** | only when there is **no** material change. A recent point is anomalous if its deviation ≥ material floor, its robust (modified) z ≥ 3.5 (1.4826 × MAD; IQR ÷ 1.349 when MAD = 0), and it is outside the Tukey fence. Cadence also reports an **expected occurrence missing**: time since the last event ≥ max(q3 + 3 × max(IQR, floor), 2 × median). No cause is stated. | not applicable (one member of a population is not unusual) |
| **TREND** | the span `[historyStart, asOf]` is cut into `trendPeriods` equal periods, and every period needs `minPerPeriod` observations or the result is INSUFFICIENT_HISTORY. From the period medians: **UP/DOWN** when Kendall τ ≥ 0.66 in that direction **and** first-to-last movement ≥ material floor; **FLAT** when the range < material floor; otherwise **NONE** (no sustained direction). | same, on period proportions |

**Why these numbers.**
- Median and MAD: the data has real outliers (DOC-04 already showed it in Production).
- 3.5 is the Iglewicz–Hoaglin robust outlier line.
- τ ≥ 0.66 over four periods requires at least five of six period pairs to agree.
- The material floor is the rule's own unit of "matters". Without it, a large population could turn
  a trivial difference into a "change".

## Rules

| Rule | Follows | Level | Kind | History / recent (days) | Min history / span / recent | Material floor | Stable spread | Trend periods × min | Stale after |
|---|---|---|---|---|---|---|---|---|---|
| **T-DOC-04** filing lag | DOC-04 | business, plus context `direction=expense` / `direction=income` | duration (days) | 365 / 90 | 12 / 90 / 4 | 1.5 days | 0.5 | 4 × 3 | 120 |
| **T-DOC-05** vendor charge | DOC-05 | resolved **party** | amount | 365 / 120 | 6 / 90 / 3 | 10% of median | 0.15 | 4 × 2 | 180 |
| **T-DOC-02** vendor billing rhythm | DOC-02 | resolved **party** | cadence (days) | 365 / 120 | 5 gaps / 90 / 3 | 5 days | 0.3 | 4 × 2 | 240 |
| **T-DOC-06** correction rate | DOC-06 | business | rate | 365 / 90 | 30 / 90 / 15 | 0.10 | thirds ≤ 0.10 | 4 × 8 | 120 |
| **T-AP-01** payment timing (signed) | AP-01 | business | duration | 365 / 90 | 10 / 90 / 4 | 2 days | 0.5 | 4 × 3 | 120 |
| **T-AP-04** per-payee timing | AP-04 | **payee** | duration | 365 / 120 | 6 / 90 / 3 | 2 days | 0.5 | 4 × 2 | 180 |
| **T-INV-02** restock rhythm | INV-02 | **inventory item** | cadence | 180 / 60 | 5 gaps / 45 / 3 | 3 days | 0.3 | 4 × 2 | 120 |
| **T-INV-04** correction share | INV-04 | business | rate | 180 / 60 | 30 / 45 / 15 | 0.10 | thirds ≤ 0.10 | 4 × 8 | 90 |
| **T-SUPP-01** purchase rhythm | SUPP-01 | **supplier** | cadence | 365 / 120 | 5 gaps / 90 / 3 | 5 days | 0.3 | 4 × 2 | 240 |
| **T-SUPP-02** delivery lead time | SUPP-02 v2 | **supplier** | duration | 365 / 120 | 5 / 90 / 3 | 2 days | 0.5 | 4 × 2 | 240 |

All ten rules are `v1`, each with its own `DerivationPolicy` lineage (`temporal-…`), seeded in the
migration. The resolver is fail-closed.

**Context.**
- T-DOC-04 judges `direction=expense` and `direction=income` separately, on their own history.
- A sparse slice returns INSUFFICIENT_HISTORY with `fallbackContextKey: ''`, which points at **this
  business's** overall baseline and never at another business.
- Weekday, time-of-day and month slices were evaluated and **not built**: no Production business has
  enough repeated periods. Seasonality is the same: one December is not annual seasonality, and
  eight Mondays of sparse filings are not weekday seasonality.

**Sensor-manifest dependencies**, checked in CI against `SENSOR_COVERAGE.md`:

| Rule | Depends on | Status |
|---|---|---|
| T-DOC-04 | Owner approves a document; Financial record created | COVERED_BY_DOMAIN_STATE |
| T-DOC-05, T-DOC-02 | Financial record created; Document vendor ↔ supplier identity | COVERED_BY_DOMAIN_STATE |
| T-DOC-06 | Owner corrects extracted fields | COVERED_BY_DOMAIN_STATE |
| T-AP-01, T-AP-04 | Commitment + installments created; Manual payment recorded; Payment voided; Allocation reversed | COVERED_BY_DOMAIN_STATE |
| T-INV-02 | Quantity changed / manual correction; Receiving posted | COVERED_BY_DOMAIN_STATE / COVERED |
| T-INV-04 | Quantity changed / manual correction | COVERED_BY_DOMAIN_STATE |
| T-SUPP-01 | Purchase order created by the owner (**PARTIAL**, justified); Purchase order created by approving a draft | PARTIAL + DOMAIN_STATE. The PARTIAL is only that `PurchaseOrder.source` is client-supplied, and this rule never reads `source`. |
| T-SUPP-02 | Receiving posted; Purchase order created by approving a draft | COVERED / DOMAIN_STATE (the v2 loader excludes one-click draft orders) |

**Reversal and correction.** Each rule reads through the M4 loaders, which already exclude reversed
allocations, voided payments, cancelled installments, DRAFT/CANCELLED orders and unresolved or
retracted vendor identities. Owner corrections reach FinancialRecord through document review. A
rebuild after a reversal changes the evidence fingerprint; the previous artifact becomes SUPERSEDED
and stays there to audit. The battery proves this.

**Identity.**
- A per-vendor rule is keyed on a resolved `Party`. Two spellings are two parties until the owner
  confirms a link or a valid tax id binds them.
- M6 has no merge authority.

## Classification of the existing learning rules

| Rule | Temporal classification | Why |
|---|---|---|
| DOC-04 | BASELINE + TREND + ANOMALY ready | built as T-DOC-04 |
| DOC-05 | BASELINE + ANOMALY + CHANGE ready | built as T-DOC-05 (sparse per vendor today) |
| DOC-02 | BASELINE + ANOMALY ready | built as T-DOC-02 |
| DOC-06 | BASELINE + TREND + CHANGE ready (rate) | built as T-DOC-06 |
| AP-01, AP-04 | BASELINE + TREND + ANOMALY ready | built as T-AP-01 and T-AP-04; no settlements in Production yet |
| AP-03 | NEEDS_MORE_EVIDENCE | AP-01's signed timing already carries the lateness signal; a separate late-share series would double-count |
| AP-06 | NOT_TEMPORAL | describes the evidence's quality, not the business |
| INV-02 | BASELINE + ANOMALY ready | built as T-INV-02 (timing only, never quantities) |
| INV-04 | BASELINE + TREND + CHANGE ready (rate) | built as T-INV-04 (counts only, never quantities) |
| INV-05 | **BLOCKED_BY_PRODUCT_DEFECT** | alerts follow stock quantities, which the POS held-sale defect corrupts |
| SUPP-01 | BASELINE + ANOMALY ready | built as T-SUPP-01 |
| SUPP-02 v2 | BASELINE + ANOMALY + CHANGE ready | built as T-SUPP-02 |
| SUPP-03 v2 | NEEDS_MORE_EVIDENCE | a per-supplier short-delivery rate needs far more orders than any business has |
| L0 facts (AP-L0-overdue, AP-L0-due-soon, DOC-L0-needs-review) | NOT_TEMPORAL | point-in-time by definition |

## Freshness, staleness, supersession

| Event | Effect |
|---|---|
| New evidence | a changed conclusion: the old row is SUPERSEDED, a new one appended |
| Evidence reversed or voided | the fingerprint changes: SUPERSEDED plus a new row |
| No observation for `staleAfterDays` | BASELINE is STALE, and nothing is inferred about the present |
| A slot no longer produced | STALE |
| Rule version changes | every live row of the old version is SUPERSEDED |
| Entity gone | its series disappears: its rows become STALE |

## Performance

- One business per derivation.
- One bounded, window-limited query per distinct evidence source, shared by the rules that use it:
  5 sources for 10 rules.
- Pure in-memory statistics per series.
- One tenant transaction per rule write.
- No tenant-wide scan per user action, and no scheduler: derivation runs through the existing
  runtime route, one business per call.

## Observability

The derive route returns the following per temporal rule: `ruleId`, `ruleVersion`, `outcome`,
`failedStage`, series count, artifact counts by type and status, and written, confirmed, superseded,
staled and duration. It never returns a baseline, value, entity id or evidence reference; the
battery asserts this. The response is printed into a public workflow log.

## Contract for M7 (not built here)

`selectCurrentKnowledge(businessId, { includeInsufficient? })` in
`lib/knowledge/knowledge-selector.ts`:

- It reads one business inside its tenant transaction.
- It returns ACTIVE `KnowledgeMeasure` rows and ACTIVE `TemporalKnowledge` rows side by side. Each
  carries its rule and version, windows, counts, summaries, finding, evidence fingerprint and
  timestamps.
- It returns INSUFFICIENT_HISTORY rows only when asked.
- It does not combine domains, rank, interpret or explain. That is M7's job.

## Known limitations

- **Production history is thin.** Payables and supplier purchasing have no settled or
  supplier-linked evidence in Production yet, so those rules are proven only in the test battery
  until real activity exists.
- **Some baselines are sparse.** Per-vendor baselines exist only for vendors with at least six
  resolved documents a year.
- **Blocked by product defects.** INV-05 stays blocked until the POS held-sale stock defect is fixed.
  The refund / credit-note and void-cascade defects do not feed any M6 rule.
- **No seasonality and no forecasting.** Both are by design until the evidence supports them.

## Production proof state

Recorded at M6 closure. See the closure report.
