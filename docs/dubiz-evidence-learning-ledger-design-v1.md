# Evidence Learning Ledger — Design v1

> Status: **APPROVED (design)** — 2026-06-25. Revised same day to a **general per-field Decision Ledger** (was Amount-only). Implementation not yet started; no code, no commit without explicit per-phase approval.

## 0. What this is (and is not)

This is a general **Evidence / Decision / Correction Ledger** for **every business field the engine infers** — not an Amount-only ledger. Its single purpose is to let us understand, weeks and months later, **where the engine was right, where it was wrong, and why** — so future improvement is **evidence-based, not guesswork**.

It is **NOT**:
- Auto Learning
- A mechanism that changes the engine
- A system that computes priors, re-ranks, tunes weights/thresholds/confidence, uses keywords/blocklists/fallbacks, or alters engine behavior in any way.

### Hard boundaries (non-negotiable)
- No Auto Learning.
- No weight changes.
- No threshold tuning.
- No confidence tuning.
- No keywords.
- No blocklists.
- No fallback.
- No change to engine behavior.
- The Ledger is **never read from inside an extraction decision**.
- The Ledger is **write-only with respect to the engine**.

The engine remains identical byte-for-byte. The Ledger only records what already happened.

## 1. Fields in scope from the start

The Ledger captures a decision for **every** business field, from day one — even fields that today come only from the legacy engine:

| `fieldKey` | Meaning | Today's source |
|---|---|---|
| `amount` | סכום | Amount Slice (first structural slice) + legacy |
| `vendor` | שם ספק | legacy |
| `date` | תאריך | legacy |
| `direction` | הכנסה / הוצאה | legacy |
| `documentType` | סוג מסמך | legacy |
| `businessCategory` | קטגוריה עסקית | legacy (`decideCategory`) |

**`businessCategory` is a first-class citizen now**, even though no new category engine exists yet. The system today assigns many documents to "general" (כללי); we want the Ledger to capture category decisions and corrections so that later we can decide, on evidence, whether to build a dedicated **Category Slice** and which mappings it should learn — without the engine ever changing itself.

When future slices arrive (Vendor Slice, Date Slice, Category Slice), they write to the **same** Ledger via the same per-field contract. No new system is built per slice.

## 2. Foundation — what already exists (reused, not duplicated)

| Component | Role today | Written when | Channels |
|---|---|---|---|
| `ExtractionSnapshot` (`prisma/schema.prisma`) | Engine belief at extraction — denormalized key fields + `rawResult` (lossless `UnifiedDocumentIntelligenceResult`) | At extraction | upload + create-from-ocr |
| `ReviewEvent` (`prisma/schema.prisma`) | Human verdict at approve — per-field `verdicts {belief, final, verdict, delta}` over amount/vendorName/date/category/direction | At approve, **before** overwrite | approve route |
| `recordExtractionSnapshot` / `recordReviewEvent` (`lib/services/documents/ledger/correction-ledger.service.ts`) | append-only, swallow-all-errors, never read back into any decision | — | — |

The existing ledger already satisfies the binding principles: append-only, write-only, never read back, OCR stored as hash only. It already records legacy belief vs human verdict for most fields — but only as a flat per-document blob, with no structural reasoning and no per-field engine record. Generalizing it is the core of this design.

## 3. Entity model — three entities

```
ExtractionSnapshot   →  documents the DOCUMENT (one row per extraction event)
   └─ SliceDecision  →  documents each FIELD DECISION of the engine (one row per field)
ReviewEvent          →  documents what the USER confirmed/corrected (one row per approve)
ExtractionEvidence   →  the heavy, shared deterministic input + reasoning (1:1 with snapshot)
```

### 3.1 `ExtractionSnapshot` (existing — kept, lightly extended)
One row per extraction. Document-level identity and provenance only. The amount-specific slice columns proposed earlier are **removed** — that data now lives in `SliceDecision` rows.
- Keep: `documentId`, `businessId`, `occurredAt`, `sourceChannel`, `liveEngineVersion`, `ocrEngine`, `ocrVersion`, `ocrTextHash`, existing denormalized legacy belief, `rawResult`.
- Add: `sliceEngineVersion` (pinned version of the new structural engine), `ocrGeometryHash`, `geometryAvailable`.

### 3.2 `SliceDecision` (NEW — 1:N from snapshot, one row per field)
The generic per-field engine-decision record. **This is the heart of the generalization.**

| Field | Meaning |
|---|---|
| `extractionSnapshotId` (FK) | the document decision this belongs to |
| `documentId`, `businessId` | denormalized for query |
| `fieldKey` | `amount` / `vendor` / `date` / `direction` / `documentType` / `businessCategory` |
| `engineValue` | what the engine decided (string-encoded, truthful null allowed) |
| `legacyValue` | the legacy engine's value for this field, if it differs/exists |
| `resolutionState` | `resolved` / `ambiguous` / `unresolved` |
| `basis` | how it was decided (slice basis for amount; legacy `source`/`reason` for others; null when none) |
| `confidenceLabel` | engine confidence label if any (kept verbatim, never tuned) |
| `provenance` (JSON) | per-field provenance (e.g. `derivedFrom` token refs for amount; legacy `source`+`reason` for others) |
| `strength` (JSON) | per-field structural strength `supports` (rich for slices, coarse/empty for legacy) |
| `reasoningBlob` (JSON) | small per-field reasoning trace; for amount the readout decision detail, for legacy fields the entity detail |
| `producedBy` | `slice` / `legacy` — which path produced `engineValue` |
| `sliceEngineVersion` | pinned version of the producer |

Notes:
- For `amount`, `producedBy:"slice"` rows carry the full structural reasoning (resolutionState/basis/provenance/strength from `readAmount`).
- For the legacy-only fields, a `producedBy:"legacy"` row is still written with whatever the legacy engine exposes (`source`, `reason`, `confidence`). Coarse is fine — null/empty are truthful values. This guarantees a **uniform contract** so future slices slot in without schema change.
- The heavy **shared** geometry is NOT duplicated per field — it lives once on `ExtractionEvidence` (3.4). `reasoningBlob` on `SliceDecision` holds only the small per-field trace.

### 3.3 `ReviewEvent` (existing — extended)
One row per approve (the human action is atomic). Already stores per-field `verdicts {belief, final, verdict, delta}`. Extensions:
- Add `documentType` to the verdict fields (currently amount/vendorName/date/category/direction).
- Add `extractionSnapshotId` (FK), `editOrdinal`, `revisionOfReviewEventId` (see §5).
- The per-field human record the user asked for (`userFinalValue` / `verdict` / `delta` per field) is the **logical join** `SliceDecision(fieldKey)` ⋈ `ReviewEvent.verdicts[fieldKey]`, materialized by the weekly report — no duplication.

### 3.4 `ExtractionEvidence` (NEW — 1:1 with snapshot)
Heavy, shared, deterministic artifacts, kept out of the lean analytics rows.
- `ocrGeometry` (Tier 2, JSON): the full `OcrGeometryResult` — `tokens[] {text, bbox, page}`, `coordinateMode`, `geometryAvailable`. Currently stored **nowhere** (OCR is hash-only). This is the evidence boundary.
- `reasoningBlob` (Tier 3, JSON): full structural reasoning chain for the document (`moneyAmounts`, `groups`, `relations`, `roles`, `readout`). **Approved: included from the start** for maximum recoverability during the research phase.
- `geometryHash`, `sliceEngineVersion`.

## 4. Governing principle — determinism → reconstruction by replay

The structural engine is a **pure, deterministic function**: `geometry → representation → grouping → money → relations → roles → readout` (`document-amount-readout.ts` is IN-MEMORY ONLY). Derived layers are reconstructable from the stored geometry + pinned version, so we need not store them as rows. We still store the Tier-3 blob now (approved) for maximum evidence; we may shrink to replay-only later.

The boundary that must never be lost is the **geometric OCR result** (`ocrGeometry` on `ExtractionEvidence`).

## 5. Linking snapshot ↔ correction (durable across engine versions)

Current gap: `ReviewEvent` holds no pointer to a specific snapshot. Fix (additive, three durability layers):
1. `extractionSnapshotId` (FK) on `ReviewEvent` → hard link to the exact decision.
2. `sliceEngineVersion` + `ocrGeometryHash` duplicated on both sides → content-hash linkage survives even if the FK is lost.
3. The snapshot is immutable and freezes the engine version it was decided against; a correction points at a **row**, not "the engine", so a future version swap does not break the link.

`editOrdinal` (1 = first edit, 2+ = subsequent) and `revisionOfReviewEventId` express "first vs subsequent" via append-only chaining.

## 6. Capturing the user's action — approve only (Phase 1 scope)

The single capture point is **approve** (`app/api/documents/[id]/approve/route.ts`). Other edit paths (post-approve edits, direct PATCH of `ExtractedData`) are **out of scope** for now; if significant edits outside approve are later discovered, they will be mapped separately. `buildVerdicts` already produces the per-field belief/final/verdict/delta; we extend it to include `documentType` and to read belief from the linked snapshot.

Example (Engine 1500 → User 1600): `amount: {belief:1500, final:1600, verdict:"corrected", delta:{old:1500, new:1600}}`.

## 7. Lifecycle

1. **OPEN** — at extraction (upload / create-from-ocr / and shadow runs): create `ExtractionSnapshot` + N `SliceDecision` rows (one per field) + `ExtractionEvidence`. Immutable, append-only. The slice reasoning is captured **even while the slice is Shadow only** — before its amount is ever published.
2. **CORRELATE** — at approve: create `ReviewEvent` with `extractionSnapshotId` and per-field verdicts.
3. **Logical closure** — the snapshot is never updated. A snapshot is *resolved* once ≥1 ReviewEvent references it; with none, it is *pending/unreviewed* (a metric in itself).
4. **Subsequent edits** → additional ReviewEvents, `editOrdinal` increments, chained via `revisionOfReviewEventId`.

## 8. Weekly Investigation Report

Source: **read-only**, offline aggregation over `ExtractionSnapshot ⋈ SliceDecision ⋈ ExtractionEvidence ⋈ ReviewEvent`. An `eval/` script (like `eval/amount-shadow.ts`) emits **investigative Markdown** (not CSV) appended to `docs/` weekly.

General (all fields):
- Volume processed, corrected, overall correction rate; correction rate **per `fieldKey`**.
- **`resolved & corrected`** per field/basis = engine confident but wrong → trust failure, most severe.
- **`abstained & user-supplied`** = coverage gap.
- Correction rate per `resolutionState`, per `basis`, per `documentType`.
- Triangulation legacy ↔ slice ↔ human (justifies/contests slice replacement).
- Known vs New: a curated **Known Root Causes** registry; the report diffs weekly failure clusters against it → flags NEW vs KNOWN clusters.

Category-specific (the focus the user flagged):
- Which `businessCategory` the engine chose vs what the user corrected it to.
- Correction recurrence: same vendor → same corrected category **within one business** and **across businesses**.
- **Missing categories** — corrected values that map to no existing category (candidate new categories).
- **"general" (כללי) sufficiency** — how often `general` is the engine value but the user corrects to something specific (fallback-insufficiency signal).
- Vendor→category stability — vendors that always settle to the same category (future Category-Slice mapping candidates, surfaced as evidence only — never auto-applied).

## 9. Future RCA capability

For every correction we have: (a) what the engine decided (`SliceDecision.engineValue`), (b) **why** (provenance + strength + basis + resolutionState), (c) what the human decided (`ReviewEvent.verdicts`), (d) the deterministic evidence for full reconstruction (`ExtractionEvidence.ocrGeometry`). Months later we can take a failure cluster (e.g. category mis-assignments for a vendor), replay reasoning on the original evidence, and evaluate a candidate new slice on the same evidence — evidence-based improvement, not guessing.

## 10. Approved scope summary

- General per-field Decision Ledger — **not Amount-only**. Amount is just the first slice that writes to it.
- Extend `ExtractionSnapshot` lightly (slice engine version + geometry hash/availability); move amount-specific data out to `SliceDecision`.
- Add `SliceDecision` (1:N, one row per field) with the uniform field contract — including `businessCategory` from the start.
- Add `ExtractionEvidence` (1:1) for shared geometry (Tier 2) + reasoning blob (Tier 3).
- Extend `ReviewEvent` with `extractionSnapshotId`, `editOrdinal`, `revisionOfReviewEventId`, and a `documentType` verdict.
- Store full `OcrGeometryResult`; store Decision Trace per field; store Frozen Reasoning Blob.
- Link the human correction to the specific snapshot.
- Later produce a Weekly Investigation Report (read-only eval/docs script) with general + category dimensions.

## 11. Decisions resolved (2026-06-25)

1. Tier 3 Frozen Reasoning Blob — **YES, from the start**.
2. Correction capture point — **approve only** in Phase 1.
3. Slice reasoning captured in **shadow** — **YES**, before it affects output.
4. **General per-field Ledger** — `SliceDecision` table with `fieldKey` contract; all six fields (amount, vendor, date, direction, documentType, businessCategory) recorded from day one; `businessCategory` first-class even before a category engine exists. Amount is the first writer; legacy fields write coarse rows under the same contract.
