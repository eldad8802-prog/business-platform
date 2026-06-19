# Document Extraction — Phase 0 Eval Harness

Purpose: establish a **frozen, numeric Baseline** of how the *current* production
extraction engine performs, before any other change. This directory is
**additive and read-only** — it imports the production engine but changes no
production code, persists nothing to the DB, and alters no decision.

To remove entirely: delete the `eval/` directory. Nothing else depends on it.

## What it measures

Per field — **vendor, amount, date, docType, direction** — plus **isFinancial**:

- **Accuracy** — matched / labeled (raw extraction, ignores needsReview)
- **Coverage** — produced-a-value / total
- **Review Rate** — needsReview=true / total (doc-level)
- **False Positives** — value present AND needsReview=false AND wrong
- **False Negatives** — truth existed but the engine did not confidently return it

Definitions are frozen in `eval/lib/metrics.ts`. Do not change them between
Before/After runs.

### Segmented views (so averages don't hide failures)

The report slices every metric by:

- **source channel** — upload / email / whatsapp / unknown
- **coarse document type** — receipt / invoice / donation_receipt /
  bank_transfer / quote / non_financial / unknown. Finer Israeli types
  (חשבונית מס / חשבונית מס קבלה / זיכוי) are **not** invented — they are
  reported as indistinguishable at Phase 0.
- **OCR quality** — empty / short / medium / long (by `ocrText` length)
- **amount complexity** — # of distinct amount candidates (single vs multiple)
- **date complexity** — # of date candidates (single vs multiple)
- **vendor concentration** — Top-5 / Top-10 vendor share, plus vendor accuracy
  on recurring vs one-off vendors (to detect template-propped accuracy)

Segmentation logic is in `eval/lib/segments.ts` (reuses production PURE functions
for read-only measurement).

## The Test Set (two sources)

1. **Auto** (`ground-truth.auto.json`) — approved documents joined with their
   `FinancialRecord`. Those are **human-approved** values, i.e. real ground truth
   for amount / vendor / date / direction (and isFinancial = true). No labeling
   work required.
2. **Manual** (`ground-truth.manual.json`) — a representative sample of
   non-approved / non-financial docs, labeled by a human. This is the only way to
   measure **docType** and to get **isFinancial = false** negatives and
   over-review.

## How to run

```bash
# 1) Build the auto Test Set + a simple manual template (READ-ONLY DB reads).
npx tsx eval/build-ground-truth.ts 60

# 1b) OR build a STRATIFIED manual template that over-samples hard cases
#     (weak OCR, multiple amounts/dates, credit notes, non-financial, all channels):
npx tsx eval/build-stratified-sample.ts 400 60 8
#     args: poolSize sampleSize perBucket

# 2) Human step: pick ONE template, fill in truth fields, save as the manual set:
#    eval/data/ground-truth.manual.template.json            (simple)
#    eval/data/ground-truth.manual.stratified.template.json (stratified, recommended)
#      ->  eval/data/ground-truth.manual.json
#    Leave any field null if it does not apply / is not present in the document.
#    The `strata` block is sampling metadata only — never edit it as truth.

# 3) Run the Baseline (RE-RUNS the production engine offline; persists nothing).
npx tsx eval/run-baseline.ts
```

Outputs:

- `eval/data/baseline-report.json` — full per-doc detail incl. every mismatch
- `eval/BASELINE-REPORT.md` — the human-readable frozen reference point

## Privacy

`eval/data/` holds real OCR text from business documents and is git-ignored
(`eval/data/.gitignore`). Keep it local. Only `BASELINE-REPORT.md` (aggregates,
no raw document text) is safe to share.

## Safety properties (Phase 0 contract)

- Additive only — new files under `eval/`, no edits to `app/` or `lib/`.
- Read-only — `build-ground-truth.ts` does `findMany` reads; `run-baseline.ts`
  runs the engine, whose only DB access is a `vendorLearning` read.
- No production decision changes; no writes to `ExtractedData` / `FinancialRecord`.
- Reversible — delete `eval/`.
