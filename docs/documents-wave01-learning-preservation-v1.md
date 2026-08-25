# Documents Wave 0+1 — Learning Preservation Map & Matrix (v1)

**Scope:** the binding learning-preservation analysis required before the Wave 0/1 integrity changes (stop-the-bleeding, atomic approval, dedup). Grounded in a full READ-ONLY dependency trace at `origin/main` `b399542`.
**Companion:** `docs/documents-integrity-remediation-blueprint-v1.md` (findings), this doc (learning contract for the fixes).

The protected pipeline is:

`Original Document → OCR/Extraction → Human Review → Review Evidence → Learning → Financial Truth`

## 1. Learning dependency inventory (as-built)

| Engine / store | Writers | Readers | Semantics they depend on |
|---|---|---|---|
| **VendorLearning** | approve route only (upsert; `usageCount++`, `confidence+0.02`, category last-write-wins) | `decideCategory` (short-circuits keyword rules; the ONLY closed learning loop in the product); Business-Memory comparison read (incumbent) | keyed by RAW vendor string per business; increment must happen at most once per document |
| **ReviewEvent** (canonical owner-decision evidence) | approve route only (append-only `create`) | Business-Memory evidence adapter (IMPL-2; tenant-wide read, **identity-only fingerprint** `kind:businessId:recordId`); vendor-category deriver (IMPL-3; support = verdict ∈ {confirmed, corrected} with non-empty final category); Learning Center (global metrics + latest-wins per doc); amount-correction eval source (filters `approvedAs="financial"`); READ-OBS | **append-only is a hard, schema-unenforced precondition** — an in-place edit is invisible to every freshness check; `id` is the ordering tiebreaker |
| **ExtractionSnapshot / SliceDecision / ExtractionEvidence** | pipeline only (append-only, records failures too) | Learning Center; eval harness (`eval/amount-memory-shadow.ts`); engine-belief mapper (0 product consumers). **NEW (Wave 0B): the output-profile resolver now reads the latest snapshot** | append-only; `rawResult` holds the full engine belief incl. `searchableText`, `guardrailRoute` |
| **DerivedClaim substrate** (shadow, flag-OFF) | `runShadowMaterialization` after approve, gated on `evidencePersisted` | read path (comparison-only, flag-OFF) | freshness = evidence-set fingerprint equality; rebuild = transactional replace; `erasedRefs`/`withdrawn` seam exists but is UNWIRED — the designated hook for future void/correction |
| **LearningEvent / LearningSignal** | not used by Documents at all | — | no coupling |

Key hidden couplings honored by this wave:
- The **profile decision feeds learning three ways at once**: it sets `approvedAs`, stamps `amount`/`direction` verdicts as `rejected` on document-only approvals, and gates the VendorLearning write. Fixing profile reachability (Wave 0B) therefore *changes the evidence mix* — intentionally: the machine's real belief (`quote_or_order` from a stale no-OCR cache) was itself corrupt evidence.
- The approve route reads `document.extractedData` **before** overwriting it; ReviewEvent belief must come from that pre-read object. The rewrite preserves this ordering (belief is captured before the transaction).
- `normalizeVendorForLearning` is the shared subject identity of approve/shadow/evidence/read — untouched in this wave.

## 2. Learning Preservation Matrix

Financial validity (does it hit totals) ≠ learning validity (is the review evidence usable). Both columns are stated per action, for the system as it exists AFTER Wave 0+1.

| Document action | Financial effect | ReviewEvent effect | Learning effect | Evidence retained? | Invalidation / supersession needed? |
|---|---|---|---|---|---|
| **Normal financial approval** | FinancialRecord created (now atomically with status+evidence) | 1 append (`approvedAs:"financial"`) — now inside the same transaction | VendorLearning +1 (atomic first-approval guard via conditional status transition — the old read-modify-write race is gone); shadow runs post-commit with `evidencePersisted:true` | Yes (belief=pre-edit engine extraction, final=human) | No |
| **Duplicate detected BEFORE approval** (upload 409 / review banner) | None — no document or no FR yet | None | **None — and that is the point**: blocking at intake prevents the false "two independent confirmations" signal at its source, with zero evidence erasure | N/A (nothing ingested on block; override ingests normally) | No |
| **Duplicate discovered AFTER approval** | *(Wave 2 — not implemented now)* future Void removes FR from totals | Existing events are NEVER edited/deleted (fingerprint is identity-only — an edit would be invisible and corrupt claims silently) | Future: void-with-reason=duplicate must (a) decrement/compensate VendorLearning usage, (b) pass the ReviewEvent refs via the **already-designed `erasedRefs` seam** so the deriver recomputes without that support (→ `withdrawn` when support empties) | Yes — events stay, flagged via supersession, not mutation | **Yes — supersession event + erasedRefs; never in-place edits** |
| **OCR correction (user fixes extracted fields at approval)** | FR carries the corrected values | `verdict:"corrected"` with `delta{old,new}` per field — `machine believed X → owner corrected to Y` is exactly what ReviewEvent already preserves (e.g. the 80,353 ₪ misread must stay recorded as belief, corrected, never deleted) | Deriver counts a correction as qualifying support for the FINAL value (INV-4-compatible); eval harness consumes the delta | Yes — belief AND final, plus ExtractionSnapshot keeps the raw engine result | No |
| **Financial correction after approval** (re-approve with new values, today's mechanism) | FR updated in place (still — full Correction lifecycle is Wave 1.4, deferred by scope truncation) | Second append (append-only history exists in the ledger even without UI) | VendorLearning NOT incremented (first-approval guard); existing claims go fingerprint-stale and re-derive on next approve. Open policy gap (documented, deferred): the deriver cannot yet distinguish "new support" from "supersedes my earlier decision" | Yes | Future: revision/supersession semantics (Wave 1.4) |
| **Void** | *(not implemented this wave)* must remove FR from aggregation without deletion | Append a void event; never delete | Same as duplicate-after-approval row: compensating learning signal + erasedRefs | Yes | **Yes** |
| **Informational document (explicit "שמור כמסמך מידע")** | None (and now: an explicit `explicitFinancial:false` can never silently create an FR even when the profile says financial) | 1 append (`approvedAs:"document"`; amount/direction verdicts `rejected`) | No VendorLearning write (correct — no confirmed category decision); shadow still runs (vendor evidence without category support contributes nothing per INV-4) | Yes | No |
| **Failed approval** (validation 400 / transaction rollback) | None — **new invariant: nothing commits**. Pre-fix, a 400 still overwrote ExtractedData and a mid-sequence crash could leave FR-without-approved or approval-without-evidence | None — the ReviewEvent write is inside the transaction; a failed approval leaves zero evidence of a decision that did not happen | None — VendorLearning runs only after commit; shadow is not invoked (its `evidencePersisted` gate is now backed by an actual commit) | N/A | No |

## 3. Contract decisions taken in this wave (binding for later waves)

1. **Evidence joins the financial transaction.** For approvals, ReviewEvent is no longer best-effort: financial truth without owner-decision evidence (or vice versa) is a worse failure than a failed request. `recordReviewEvent` (never-throws) remains for any non-approval caller; the approve route writes via `buildReviewEventCreateData` on the transaction client.
2. **Learning stays OUTSIDE the transaction, after commit.** VendorLearning and the Business-Memory shadow are best-effort and must never roll back financial truth. The first-approval guard moved from a racy status read to the atomic conditional transition (`updateMany … status != 'approved'`), which is the new idempotency contract for usage counting.
3. **Append-only is untouched.** No ReviewEvent/Snapshot/Slice/Evidence row is ever updated or deleted by any Wave 0/1 code path, including dedup.
4. **Duplicate defense is placed BEFORE evidence creation** (upload 409, review-time WARN) precisely so learning never has to un-count a confirmation.
5. **Deferred with named seams:** void/correction learning compensation goes through `DeriveOptions.erasedRefs` + the `withdrawn` claim state (already designed, unwired); re-approval supersession semantics need a policy decision before Wave 1.4/2.
