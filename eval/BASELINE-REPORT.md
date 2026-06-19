# Phase 0 — Baseline Report (FROZEN reference point)

Generated: 2026-06-15T00:56:39.487Z

Total documents evaluated: **12**
- from FinancialRecord (auto): 12
- from manual labels: 0

Engine: `runUnifiedDocumentIntelligence` (current production).
Doc-level **Review Rate**: 83.3%

## Per-field metrics

| Field | Labeled | Accuracy | Coverage | False Positives | False Negatives |
|---|---|---|---|---|---|
| vendor | 12 | 100.0% | 100.0% | 0 | 10 |
| amount | 12 | 100.0% | 100.0% | 0 | 10 |
| date | 12 | 100.0% | 100.0% | 0 | 10 |
| docType | 0 | 0.0% | 100.0% | 0 | 0 |
| direction | 12 | 83.3% | 83.3% | 0 | 10 |

Vendor accuracy (lenient containment, secondary): 100.0% over 12 labeled.

## isFinancial classification

Labeled: 12 · Accuracy: 91.7% · FP (said financial, isn't): 0 · FN (missed financial): 1

## Segmented metrics

Averages hide where the engine actually fails. These slices expose it.

### By source channel

| Segment | N | Review Rate | Vendor Acc | Amount Acc | Date Acc |
|---|---|---|---|---|---|
| upload | 12 | 83.3% | 100.0% | 100.0% | 100.0% |

_Per-segment full metrics (coverage, FP, FN, docType, direction) are in the JSON report._

### By coarse document type

| Segment | N | Review Rate | Vendor Acc | Amount Acc | Date Acc |
|---|---|---|---|---|---|
| receipt | 7 | 85.7% | 100.0% | 100.0% | 100.0% |
| invoice | 4 | 75.0% | 100.0% | 100.0% | 100.0% |
| non_financial | 1 | 100.0% | 100.0% | 100.0% | 100.0% |

_Per-segment full metrics (coverage, FP, FN, docType, direction) are in the JSON report._


> Types the engine **cannot** distinguish at Phase 0 (NOT invented as buckets): חשבונית מס (mapped into invoice); חשבונית מס קבלה (not modeled); זיכוי / credit note (not modeled).

### By OCR quality (by length)

| Segment | N | Review Rate | Vendor Acc | Amount Acc | Date Acc |
|---|---|---|---|---|---|
| long | 8 | 87.5% | 100.0% | 100.0% | 100.0% |
| medium | 4 | 75.0% | 100.0% | 100.0% | 100.0% |

_Per-segment full metrics (coverage, FP, FN, docType, direction) are in the JSON report._

### By amount complexity (# amount candidates)

| Segment | N | Review Rate | Vendor Acc | Amount Acc | Date Acc |
|---|---|---|---|---|---|
| multiple | 12 | 83.3% | 100.0% | 100.0% | 100.0% |

_Per-segment full metrics (coverage, FP, FN, docType, direction) are in the JSON report._

### By date complexity (# date candidates)

| Segment | N | Review Rate | Vendor Acc | Amount Acc | Date Acc |
|---|---|---|---|---|---|
| multiple | 11 | 81.8% | 100.0% | 100.0% | 100.0% |
| single | 1 | 100.0% | 100.0% | 100.0% | 100.0% |

_Per-segment full metrics (coverage, FP, FN, docType, direction) are in the JSON report._

## Vendor concentration

Unique vendors: 10 over 12 docs.
Top 5 vendor share: **58.3%** · Top 10: **100.0%**

Vendor-field accuracy on **recurring** vendors: 100.0% (3 labeled)
Vendor-field accuracy on **one-off** vendors: 100.0% (9 labeled)

A large gap (recurring >> one-off) means apparent accuracy is propped up by repeated vendor templates, not generalization.

## Limitations (read before trusting any number)

- **Original AI accuracy is NOT measurable until Phase 1/2.** Approve overwrites `ExtractedData`, so the AI's value at ingestion is gone; we only re-run today's engine vs human-approved truth.
- **Approved docs do not necessarily reflect original AI output** — some were corrected by a user before approval; the correction is unrecorded.
- **Missing from the auto set:** docs still in `needs_review`, rejected, or that failed OCR. The auto set is approved+financial only → skewed toward easy/legible cases.
- **Empty-OCR blind spot:** all three intake paths reject empty OCR before creating a Document, so empty-OCR docs are unmeasurable here by construction.
- **Finer Israeli doc types** (חשבונית מס / חשבונית מס קבלה / זיכוי) are not modeled by the classifier and are not bucketed — only the 6 coarse classes + unknown.
- **Date candidate count** is a local regex approximation (eval-only), not the engine's internal date parser.

## Metric definitions (frozen)

- **Accuracy** = matched / labeled (raw extraction, ignores needsReview).
- **Coverage** = produced-a-value / total.
- **Review Rate** = needsReview=true / total (doc-level).
- **False Positive** = value present AND needsReview=false AND wrong.
- **False Negative** = truth existed but engine did not confidently return the correct value.

Per-doc detail (including every mismatch) is in `eval/data/baseline-report.json`.
