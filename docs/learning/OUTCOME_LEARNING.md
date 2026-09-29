# M9: Outcome learning loop

```
ValidatedFinding (M8, optional) ─┐
governed knowledge (bks.v1) ─────┴→ Recommendation → Owner Decision → Action → Outcome Observation
                                       → Outcome Assessment → learning artifacts → bks.v1 → future Brain context
```

Dubiz learns, per business, what happened after it recommended something and the owner answered. It
keeps evidence, authority and uncertainty with every step, and it never claims a cause.

Code: [`lib/knowledge/outcomes/`](../../lib/knowledge/outcomes/)

| File | Role |
|---|---|
| `outcome.contract.ts` | contract, catalogue, thresholds, attribution vocabulary |
| `recommend.ts` | candidates, memory and suppression |
| `track.ts` | actions and observations |
| `assess.ts` | assessment |
| `learn.ts` | snapshot learning artifacts |
| `outcome-store.ts` | the only file that queries |
| `outcome.service.ts` | orchestration |
| `outcomes.test.ts` | evaluation corpus |

Migration: `prisma/migrations/20260928090000_m9_outcome_learning`. Battery: `.m0/m9-outcome-battery.ts`.

## Architecture audit (what was reused, and why)

| Existing | Verdict | Why |
|---|---|---|
| `bks.v1` snapshot and M7 assembly | **REUSE / EXTEND** | Recommendations are derived only from snapshot knowledge. M9 learning returns through three new knowledge kinds. |
| M8 `ValidatedFinding.findingKey` and run meta | **REUSE** | Recorded as a recommendation's source, with the Brain versions and fingerprints. The model never authors a recommendation. |
| L0 facts (`documents-inbox`, `payables-schedule`) | **REUSE** | The authoritative triggers for the first two families. |
| `ReviewEvent` and `Document.status` | **REUSE (read)** | The document review action: immutable, human actor, business time, same transaction as the approval. |
| `Payment`, `PaymentAllocation` (voids and allocation reversals as tombstones) | **REUSE (read)** | The payables action and outcome. `paidAt` is owner-entered business time. |
| `BusinessInsight` (M3) | **DO NOT EXTEND** | It refreshes in place, the runtime can DELETE from it, and it is the owner-decision surface. Versioned, immutable recommendations cannot live there. M3 insights are unchanged. |
| `BusinessInsight` decision columns, `INSIGHT_DECIDED` | **DO NOT USE** for M9 | The column only holds the latest decision. M9 decisions are their own append-only rows. |
| `Recommendation` / `RecommendationOutcome` (legacy) | **DO NOT USE** | No writers, free-text `notes`, no actor or provenance. |
| `ReplySuggestion`, `BusinessBot*`, `Task` | **DO NOT USE** | Different domain, or dead. |
| `EntityLinkProposal`, `PayablesMatchRejection` | **PATTERN** | Write-once owner decisions, silence ≠ rejection, and no re-proposal after "no". |
| SEC-F append-only mechanism | **PATTERN** | Trigger plus revoked privileges, now the M9 history guard. |
| `LearningEvent` sensors | **NOT NEEDED** | M9 decisions are domain state in `OutcomeDecision`, not a sensor. |
| `InstallmentWorkflow.handledAt` | **DO NOT USE** as an outcome | It can be overwritten, is flag-gated, and "handled" does not mean paid. |
| `CollectionAction` → payment | **NOT YET** | No invoice link from the UI, refunds are not netted, and there is no Production qualifying data. |
| Inventory stock, lead conversion, supplier POs | **DO NOT USE** | POS held-sale stock defect; no lead→payment link; unreachable PO states. |

## Data model (five tables, one migration)

| Table | Author | Mutability |
|---|---|---|
| `OutcomeRecommendation` | system | **Versioned.** Content is immutable (trigger). Only the lifecycle `ACTIVE → SUPERSEDED / RESOLVED / EXPIRED` moves, and only forward. A superseded version is linked once to its successor. A partial unique index allows at most one `ACTIVE` version per `recommendationKey`. |
| `OutcomeDecision` | **owner** | **Append-only** (privileges plus a trigger that also binds the table owner). A change of mind is a new row with `supersedesDecisionId`. |
| `OutcomeActionEvent` | domain ledger | **Append-only.** `PERFORMED` / `REVERSED` / `WITHDRAWN`, keyed by the real domain record. |
| `OutcomeObservation` | domain ledger | **Append-only.** Days and counts only. A reversal is a new row with `reversesObservationId`. |
| `OutcomeAssessment` | deterministic assessor | **Append and supersede.** Unchanged inputs confirm the row; changed inputs supersede it. |

**Tenancy**
- Every table has `businessId` with a foreign key to `Business`.
- Every child reaches its recommendation through a composite key, `(businessId, recommendationId) → (businessId, id)`. A row of business A cannot point at business B's recommendation, whatever the ids.
- RLS is ENABLE and FORCE, with per-command policies (no `FOR ALL`) on `app.current_business_id`.
- The runtime can only SELECT and INSERT on the three history tables, and has no DELETE anywhere.

**Idempotency.** Every action, observation and decision carries a per-business unique `idempotencyKey`. Retries, replays, duplicate events and rebuilds therefore insert nothing new.

## Contract

**Recommendation**
- `recommendationKey` = `type:subjectType:subjectId`, plus `version`.
- `type` and `family`, the subject, and sorted `targets`.
- `supportingSlots`: snapshot slots that must exist in the snapshot it came from.
- `severity`, `evidenceFingerprint`.
- The source is either `KNOWLEDGE_RULE`, or `BRAIN_FINDING` with `sourceFindingKey`, the Brain contract/prompt/context versions, the model and `contextFingerprint`.
- `snapshotFingerprint`, `generatorVersion`.
- `issuedAt`, `validUntil`, `outcomeWindowEnd`.
- `status`, `closedAt`, `closedReason`, `supersededById`.

**Owner decision**
- `ACCEPT`, `REJECT`, `MODIFY` (a strict subset of the targets), or `NOT_NOW` (a deferral of 1–90 days, default 7).
- Bound to the recommendation version it answers. Deciding v1 is never applied to v2 (409 `VERSION_MISMATCH`).
- The actor comes from the session. `source = OWNER_UI`.
- An optional **structured** `reasonCode`: `ALREADY_HANDLED`, `NOT_RELEVANT`, `WRONG_TIMING`, `DISAGREE` or `WILL_HANDLE_DIFFERENTLY`. There is deliberately no free text.
- **Silence is never a decision.** An unanswered recommendation expires with decision state `NONE`.
- Route: `POST /api/outcomes/recommendations/[id]/decision`. The tenant and actor come from the session; the `Idempotency-Key` header is honoured. **No screen calls it.**

**Action**, read from the ledger and never claimed:

| Family | PERFORMED | REVERSED | WITHDRAWN |
|---|---|---|---|
| documents | the document's first `ReviewEvent` | — (no reversal path exists) | left the queue without a review |
| payables | a `PaymentAllocation` recorded after the recommendation, at the payment's `paidAt` | the allocation reversed, or its payment voided | the installment was cancelled |

An action is linked to the version that was live when it was recorded. It is linked to the owner's ACCEPT or MODIFY decision only if that decision came first.

**Observation**
- documents: review backlog at issue, and at the end of the window. The end value is reconstructed from the ledger: documents that existed then and had not yet been reviewed then.
- payables: `INSTALLMENT_SETTLED` (days late), and `INSTALLMENT_SETTLEMENT_REVERSED`.
- Settlement history is **replayed from the allocation timeline**, not remembered, so a rebuild reproduces reversals exactly.

**Assessment**

| Field | Values |
|---|---|
| `decisionState` | `NONE` / decision kind |
| `actionState` | `NOT_STARTED`, `PARTIALLY_COMPLETED`, `COMPLETED`, `REVERSED`, `CANCELLED`, `PRECEDED_RECOMMENDATION` |
| `outcomeState` | `PENDING`, `OBSERVED`, `NOT_OBSERVED`, `REVERSED` |
| `direction` | `DECREASED`, `UNCHANGED`, `INCREASED`, `SETTLED`, `NOT_MEASURABLE` |
| `attribution` | see below |
| `uncertainty` | `WINDOW_OPEN`, `NO_ACTION`, `ACTION_PRECEDED_RECOMMENDATION`, `TARGETS_WITHDRAWN`, `EVIDENCE_REVERSED`, `SEQUENCE_NOT_CAUSE` |

It also carries the window, the observation count, evidence refs, and detail (counts and days only).

## Attribution is sequence, never cause

| Attribution | Meaning |
|---|---|
| `NOT_ASSESSABLE` | The window is open, nothing was done, the targets were withdrawn, the act was reversed, or the act happened **before** the recommendation (a late-recorded payment). |
| `NO_OUTCOME_OBSERVED` | Something was done and the window closed without the outcome, or the outcome was reversed, or the backlog grew anyway. |
| `OBSERVED_SEQUENCE` | Something was done **after** the recommendation and **before** the observed outcome. Its uncertainty is always `SEQUENCE_NOT_CAUSE`. |

`ASSOCIATED`, `SUPPORTED_CONTRIBUTION` and anything causal would need a comparison design, such as a
control or a counterfactual, which the product does not have.

These values are **not in the TypeScript type**, and a **database CHECK** refuses them.

The snapshot carries a standing gap, `gap|outcomes|CAUSAL_ATTRIBUTION` (`RULE_BLOCKED` /
`NO_COMPARISON_DESIGN`), so the Brain is told what it cannot conclude.

The Brain's validator rejects outcome-effect wording in Hebrew and English:
- English: "thanks to", "improved", "worked", "paid off", "helped".
- Hebrew: בזכות, שיפר, השפיע, עזר, הועיל, הצליח, יעיל.

Prompt rule 11 (`brain-prompt.v2`) states the same boundary.

## Recommendation memory, and not nagging

Suppression is decided deterministically in `recommend.ts`, before any wording exists:

| State | What happens |
|---|---|
| ACTIVE, same situation | nothing (dedupe; the database also allows only one ACTIVE) |
| ACTIVE, materially changed | SUPERSEDED, and a new version is issued |
| ACTIVE, past validity | EXPIRED |
| ACTIVE, condition gone | RESOLVED |
| closed, **REJECT** | suppressed until a **material change** |
| closed, **NOT_NOW** | suppressed until the deferral passes, or a material change |
| closed, ACCEPT / MODIFY | a RESOLVED episode may recur; an expired one waits for its outcome window |
| closed, no decision | a RESOLVED episode may recur; an expired one waits a 30-day cooldown |

A material change means:
- documents: at least max(3, 50% of the prior targets) new documents;
- payables: an L0 severity escalation.

## Owner-behaviour learning

`DECISION_PATTERN`, per recommendation type:
- decided, accepted, rejected, modified, deferred;
- **expired unanswered**, its own column and never folded into "rejected";
- median days to decision.

`OUTCOME_PATTERN`, per type, over closed windows:
- action completed, partial or not started;
- observed-sequence, no-outcome and not-assessable counts;
- median days to first action.

**Thresholds.** A pattern needs at least **5** decided recommendations, or at least 5 closed windows. Below
that, the answer is an `INSUFFICIENT_EVIDENCE` gap with have/need.

Patterns carry the caveats `BEHAVIOUR_ONLY_NOT_INTENT` and `SEQUENCE_IS_NOT_CAUSE`. No field names a
trait, motive, risk appetite or intent (tested).

## Feedback into bks.v1 and the Brain

- New kinds: `RECOMMENDATION_MEMORY`, `DECISION_PATTERN`, `OUTCOME_PATTERN`.
- New authority: `OUTCOME_ASSESSMENT`. Memory fields name their own authority: `ownerDecision`, `ledgerAction`, `observedOutcome`, `systemAttribution`.
- One more snapshot query: `QUERY_BUDGET` goes from 9 to 10.
- `brain-context.v2` admits the new kinds as scalar facts, ranked with owner decisions. Raw outcome history never reaches the model.
- Everything is per business. The snapshot reads one business's rows inside its tenant transaction. There is no cross-business rate, baseline or ranking.

## Operations

- **Derive route.** `/api/knowledge/derive` runs M9 after the Brain step and before the reported snapshot. The response `outcomes` block holds:
  - versions;
  - recommendation counts (issued, closed, suppressed by reason, source kinds, active);
  - effective decisions;
  - tracking (actions and observations inserted, by type);
  - assessments (written, confirmed, superseded, by attribution, outcome and action state);
  - `feedback` (memory, pattern and gap counts in the next snapshot);
  - `durationMs` and `failureStage`.

  It never holds text, names, amounts or record ids.
- **Isolation probe.** The derive route's isolation probe now covers the five M9 tables.
- **Kill switch.** `OUTCOMES_MODE=off` means no read and no write.
- **Failure.** M9 never throws into the derivation. A failure is reported with its stage. Knowledge built for another business is refused before any read (`tenant_mismatch`).
- **No owner-visible AI.** No UI reads M9 (tested). Recommendations are not rendered, notified or sent.

## Known limitations

- **Production history is thin.** No owner decision can exist until an owner surface exists, so the Production chain is `recommendation → (no decision) → ledger action → observation → assessment → snapshot`. The decision leg is proven in the battery.
- **Deleted documents.** The backlog at window end is reconstructed from current state, so a document deleted since is not counted.
- **Payables `paidAt`.** It is owner-entered business time. A payment recorded after the recommendation but dated before it is classified `PRECEDED_RECOMMENDATION`, never as a response.
- **Voided payments.** A void does not cascade to cheque, preparation or evidence (known defect). M9 reads only the payment and allocation tombstones.
- **Erasure.** The five tables are classified `NEEDS_OWNER_DECISION` for erasure, as every other knowledge table is.

## M10 boundary

M10 would consume:
- `OutcomeRecommendation` (version, source, targets);
- the owner's `OutcomeDecision` history;
- `OutcomeAssessment`;
- the snapshot kinds above.

Showing recommendations to owners, and any automated action, are separate owner decisions. M9 builds
neither.

## Production proof (2026-09-29)

**Releases**
- The migration `20260928090000_m9_outcome_learning` shipped alone in #563 (`3949da0`). It was applied by `release-migrate` run 36493086831 after `production-db` approval. Exactly this migration was pending and applied.
- The code shipped in #562 (`cfdc5cd`), and `business-platform` deployed to Production.

**Runs.** All four ran through `knowledge-derive.yml` on the running application, as **`app_runtime_prod`** (NOSUPERUSER, NOBYPASSRLS, proof level FULL). Natural Production evidence only: no business record was created or changed, and no decision was made.

| | business 3 | business 9 |
|---|---|---|
| runs (with Brain shadow, then replay) | 36499082205, 36499276277 | 36499124235, 36499321733 |
| isolation (12 tables, including 5 M9 tables) | holds: RLS + FORCE, 0 rows without tenant, 0 foreign rows | holds |
| M9 runtime privileges | history tables SELECT/INSERT only; no DELETE anywhere | same |
| guard catalog | 10 CHECKs, 8 composite tenant keys, 2 partial unique indexes, 5 enabled guard triggers, 12 per-command policies, 0 `FOR ALL`; attribution CHECK is sequence-only | same |
| refused writes (all rolled back) | UPDATE ×3 and DELETE ×5 → `42501`; causal attribution → `23514`; dangling tenant reference → `23503`; editing a live recommendation → `DZ902` | same |
| first run | 2 candidates, 2 issued (`KNOWLEDGE_RULE`); decisions NONE; backlog-at-issue observed; 2 assessments `PENDING` / `NOT_STARTED` / `NOT_ASSESSABLE` | 3 candidates, 3 issued; decisions NONE; 3 assessments `PENDING` / `NOT_ASSESSABLE` |
| replay | 0 issued (`DEDUPED_ACTIVE` ×2); 0 actions/observations inserted; 2 assessments **confirmed** (recomputed hash = stored hash), 0 written, 0 superseded | 0 issued (`DEDUPED_ACTIVE` ×3); 0 inserted; 3 confirmed |
| feedback into bks.v1 | 2 `RECOMMENDATION_MEMORY`; pattern gaps (below threshold); snapshot deterministic; 10 queries | 3 `RECOMMENDATION_MEMORY`; pattern gaps; deterministic |
| Brain shadow (`brain-context.v2` / `brain-prompt.v2`) | FINDINGS, 2 accepted, `CAUSAL_WORDING` ×3 rejected | FINDINGS, 1 accepted, `CAUSAL_WORDING` ×4 rejected |

**Public logs** carry counts, states, codes and versions only. Scanned: no names, amounts or text.

**What Production proves today**
- It proves: `Recommendation → NO DECISION → (action pending) → assessment → snapshot memory`, together with tenant isolation, the guards and idempotent replay.
- **Outcome windows are open.** Ledger actions and observations after issuance will accrue from natural activity. None exists yet, and none was created.
- The owner-decision branch (ACCEPT / REJECT / MODIFY / NOT_NOW), reversal and from-scratch rebuild are proven only in the lab battery (52/52, as a NOBYPASSRLS role on the shipped DDL). No owner surface exists, so no Production decision can exist.

**Brain.** Since `brain-prompt.v2` and the broader outcome-effect wording list, more model findings are rejected as `CAUSAL_WORDING`. The M8 live runs had 0 rejections; these had 3 and 4. It is a safe-direction change: false rejections silence a finding, they never admit a claim. The prose is not logged, so which terms fired is not observable. A follow-up could report the matched term family as a code.
