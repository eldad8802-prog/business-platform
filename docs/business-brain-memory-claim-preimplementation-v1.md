# Dubiz — Business Memory Derived Claim · Pre-Implementation Decision v1

> **Status: PRE-IMPLEMENTATION DECISION — NOT SCHEMA, NOT CODE.** Read-only. Decides whether a Derived Claim is ready to become a persistence substrate, and if so its minimal coherent shape. Implements `business-brain-evidence-memory-contract-v1.md` (RATIFIED) + `business-brain-memory-architecture-v1.md` + `business-brain-memory-persistence-design-v1.md` + `business-brain-memory-impl-2-preimplementation-v1.md`. Where any tension arises, **Contract v1 governs**.
> **Baseline:** `origin/main c30dd81` (IMPL-2 Evidence Adapter merged). Firsthand-revalidated, unchanged.
> **Type:** a decision. No Prisma / SQL / migration / Claim code / writer / runtime.

---

## 1. Baseline (firsthand)
- **Business Memory models on main (exactly two):** `DerivationPolicy` + `DerivationPolicyVersion` — GLOBAL, inert, immutable, identity-only; **applied to Production** (2026-08-17). The derivation policy is an **identity** (name + version label); its **function is CODE and is unwritten** (no content column by design).
- **Evidence Adapter (IMPL-2, merged c30dd81, inert):** `lib/business-memory/evidence/` — store-agnostic contract + `ReviewEvent` owner-decision reader + `ExtractionSnapshot` engine-belief reader. Gives, deterministically: for `(businessId, DomainLocalSubject)`, the ordered append-only owner-decision evidence set + a stable `EvidenceSetIdentity`. **0 consumers.**
- **No Claim model. No Memory Deriver. No Business-Memory writer. No proposition abstraction to reuse.**
- **VendorLearning (untouched):** mutable counter `{ businessId, vendorName, category, usageCount, confidence, isGlobal }`; `decideCategory` reads it learning-first.
- **Revalidation:** no advance affects any assumption → **no REVALIDATION-REQUIRED.**

## 2. What a Derived Claim actually is (normative definition)
> **A Derived Claim is a tenant-local, non-authoritative statement that the business's retained evidence — read through the Evidence Adapter and interpreted by a pinned Derivation Policy version — supports a particular proposition about a subject; it is a rebuildable projection of that derivation, never a fact and never a decision.**

It **is:** tenant-local · derived · evidence-backed · policy-version-pinned · explainable · rebuildable · non-authoritative · droppable.
It **is NOT:** raw evidence · an owner decision · truth · a recommendation · an action · a manually-editable business fact.

## 3. Proposition — options ranked
A proposition = *predicate + value* about a subject (Architecture §5), e.g. `category = "office"`.

| Option | Sketch | clarity | type-safety | replay | explain | conflict | over-eng. | extensibility | persist. simplicity | VL retrofit | future domains |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **P-A** generic predicate/value | `subject + predicate + value(string)` | 2 | 1 | 4 | 3 | 3 | **1 (worst)** | 4 | 4 | 3 | 3 |
| **P-B** typed kind + payload (envelope) | `claimType + typed value` | **5** | **5** | 5 | 5 | 5 | **4** | **5** | 4 | 5 | **5** |
| **P-C** domain-specific model | `VendorCategoryClaim` | 5 | 5 | 4 | 4 | 4 | 3 | 2 | 5 | 5 | 2 |
| **P-D** subject/predicate/object | generic SPO triple | 2 | 1 | 4 | 3 | 3 | **1** | 5 | 3 | 2 | 4 |
- **P-A / P-D** are a **universal ontology** built from ONE use-case — the premature-ontology anti-pattern (same trap IMPL-2 rejected). String predicates kill type-safety and invite JSON-soup.
- **P-C** is clean for vendor→category but **bakes vendor semantics into the memory core** and forces re-inventing the envelope for the next domain.
- **P-B (hybrid envelope + typed proposition)** keeps the common invariants (tenant, policy-pin, evidence-link, droppable, conflict-as-rowset) generic while each `claimType` defines its **own minimal typed value** — no universal predicate ontology, no JSON soup. **Winner.**

## 4. What Vendor→Category actually claims (the critical semantics)
Two candidate readings:
- **(i)** *"Vendor X belongs to Category Y."* — a **fact about the vendor entity**; implicitly cross-business ("X is office" regardless of tenant).
- **(ii)** *"For business B, the retained evidence currently supports category Y for documents associated with vendor-subject X."* — **tenant-local, derived, operational** knowledge.

**Verdict: (ii) is the only reading compatible with Contract v1.** Reading (i) is truth about an entity (violates INV-6 knowledge≠truth) and is cross-tenant/global (violates INV-9). The Claim is **learned operational knowledge**, an *input to a future recommendation*, never a fact about the vendor. This settles the proposition's meaning: the value is a category **string**, but the claim is about `(business, vendor-subject)` and asserts *evidential support*, not identity.

## 5. Generic vs domain-specific
- **Generic core (P-A/P-D):** premature ontology; unproven with one use-case.
- **VendorCategory-specific (P-C):** bakes semantics; poor reuse.
- **Hybrid (P-B):** generic **Claim envelope** (shared invariants) + **typed proposition per `claimType`**; v1 has exactly one kind `vendor-category` with `value = category`. Common invariants without turning everything into JSON.
> **Recommendation: Hybrid (P-B).** It is the least-regret frame — *when* a Claim is built.

## 6. Minimal Claim semantics (conceptual — if/when built)
Required (concept, **not** asserted as columns): tenant `businessId` · `subject` (domain-local, inline — §10) · `claimType` + typed `propositionValue` · pinned `policyVersion` · `evidenceSetIdentity` reference (§9) · recorded `materializedAt`. Derived-not-stored: **state** (§7) · **confidence** (§14, omitted). Forbidden: everything in §21.

## 7. State model — revalidated (derive from the rowset, do NOT persist a status machine)
Architecture states: `supported / conflicting / insufficient / withdrawn`. Re-examined for the FIRST model:
- **insufficient** → needs **no row**: *absence of any Claim for a subject* is insufficient.
- **withdrawn** → **no row**: after rebuild, erased-evidence candidates simply aren't re-materialized (absence).
- **supported** → exactly **one** candidate row for the subject+policyVersion.
- **conflicting** → **two or more** candidate rows (distinct values) for the subject+policyVersion.
> **State becomes a pure function of the candidate rowset — no `state` column, no status machine, no `active/current`.** This is the cleanest reading of INV-8/§6 and directly answers §7's "does insufficient/withdrawn need a row?" → **no.**

## 8. Conflict representation (the central test)
Sequence `X→Office, X→Office, X→Inventory, X→Office`:
- **Chosen frame — candidate-set:** the deriver emits **one candidate Claim per distinct supported proposition value** (`Office`, `Inventory`), each carrying its own evidence linkage; **no winner is stored** (Architecture §6). "Which wins" is decided on read by the policy/recommendation, never materialized.
- Rejected: a single row with a stored winning value (smuggles latest-wins) or a stored resolved count (smuggles precedence).
> **But note:** whether this sequence yields **one** candidate (`Office`, if the policy resolves by recency/majority — Contract §8 reversal-by-recency) or **two** candidates (`{Office, Inventory}`, if all corrections co-count → `conflicting`) is **exactly the Derivation Policy's conflict semantics — and those are unwritten.** The rowset shape is therefore a function of an artifact that does not yet exist (see §18/§Verdict).

## 9. Evidence linkage
The Evidence Adapter already yields a deterministic `EvidenceSetIdentity` (`refs` + ordering + fingerprint) for `(businessId, subject)`. A Claim would reference **that identity** (or a derivation-run id carrying it) — **never copy raw ReviewEvent** (INV-10/13). **Minimum:** the evidence-set identity fingerprint + refs, resolvable back to append-only records. **Hard rule preserved:** no Claim without reconstructable evidence linkage. *(This part is fully settled by IMPL-2 — it is NOT a blocker.)*

## 10. Subject representation
Use the adapter's `DomainLocalSubject { domain:"vendor", normalizedKey, businessId }` **inline** in the Claim. **No SubjectRef table** is a prerequisite: the vendor subject is a stable normalized string within tenant+domain. A future RIA canonical referent binds as an **alias over the same evidence** (Architecture §10 late-binding) — the hybrid envelope leaves room for a `referent`-keyed claimType later **without** rewriting evidence. **No competing identity authority.**

## 11. Policy pinning
Each Claim would FK-pin `DerivationPolicyVersion` (exists). `onDelete: Restrict` (already) → policy history never cascade-deleted by a Claim. Claims under **different** policy versions **coexist** (replay/rebuild); there is **no** "current policy" selection column. *(Settled — not a blocker.)*

## 12. Materialization identity (definable — but determined by the unbuilt deriver)
Under the candidate-set frame, identity = **`(businessId, subject, claimType, policyVersion, propositionValue)`** — one row per distinct supported value per policy version. This is **definable without precedence** (it does not encode "one current Claim"; different values and different policy versions legitimately coexist). ✔ the §12 no-smuggled-currentness test.
> **However:** the *alternative* frame (single-value-per-subject + derived state) would give identity `(businessId, subject, claimType, policyVersion)` — a **different key**. Choosing between the two keys **is** choosing the conflict model, **which is Derivation-Policy semantics that are not yet written.** So uniqueness is *definable*, but *which* uniqueness is **not yet determined** independent of the deriver.

## 13. Rebuild / delete semantics
Materialized Claims are **droppable**: rebuild = drop the subject's candidate rows, re-derive from evidence+policy, insert fresh. **No Claim history is persisted** — Contract §5/§12 place canonical history in the **evidence**, not in the cache. Persisting Claim-history would add complexity with no invariant benefit. *(Settled — favors a thin cache.)*

## 14. Confidence
Formula deferred (Contract §14). **v1 Claim carries NO confidence field** — a placeholder numeric would be arbitrary authority (INV-7 forbids). Confidence, when it exists, is a derived cache alongside the Claim, added later. *(No blocker — just omit.)*

## 15. Recommendation boundary
The Claim shape excludes `suggestedAction / CTA / autoApply / recommendation copy / owner-approval status`. A future Recommendation layer **consumes** Claims; it is not part of them. *(Settled.)*

## 16. VendorLearning retrofit simulation
```
CURRENT:  approve → VendorLearning.upsert(businessId,vendor → category; usageCount++, confidence)
          decideCategory → VendorLearning.findUnique (learning-first)

FUTURE:   approve → ReviewEvent (canonical, append-only)                    [EXISTS]
          → Evidence Adapter: ordered owner-decision evidence for subject   [EXISTS, inert]
          → Memory Deriver × vendor-category-policy@vN                       [MISSING]
          → Derived Claim candidate(s): (business, vendor) ⇒ category        [MISSING: this stage]
          → (later) decideCategory reads the Claim instead of the counter    [MISSING: read-switch, deferred]
```
- **Rebuildable:** `usageCount`→count of confirming evidence; `confidence`→derived; category→candidate value(s) — *where ReviewEvent coverage exists* (Persistence Design §5 caveat).
- **Kept:** the append-only `ReviewEvent` evidence.
- **Disappears:** the mutable counter, the stored `0.8`/`+0.02`, the `upsert` overwrite, `isGlobal`.
- **Read-path enters later** at `decideCategory` (NOT proposed here).
> The simulation shows the **missing middle is the Deriver**, not a table: everything up to the adapter exists; the Claim is the *output* of the still-missing deriver.

## 17. Cross-domain compatibility
The hybrid envelope + domain-local inline subject allows a later `claimType` keyed on a canonical RIA referent to be **re-derived over the same evidence** (alias), no evidence rewrite (Architecture §10). **PASS** — the frame does not block late RIA binding, and activates no RIA.

## 18. Candidate architectures
| | C1 · Hybrid envelope + typed proposition | C2 · VendorCategoryClaim only | C3 · generic SPO Claim | C4 · No Claim table yet (deriver-first) |
|---|---|---|---|---|
| correctness | 5 | 4 | 3 | **5** |
| complexity | 4 | 4 | 2 | **5** |
| type safety | 5 | 5 | 1 | n/a |
| reuse | 5 | 2 | 4 | **5** |
| over-engineering | 4 | 3 | 1 | **5** |
| rebuildability | 5 | 5 | 4 | **5** |
| explainability | 5 | 4 | 3 | **5** |
| future compat | 5 | 2 | 4 | **5** |
| time-to-first-memory | 3 | 4 | 2 | **5** |
| **speculation risk (lower=better)** | commits output shape pre-deriver | commits + bakes vendor | commits ontology | **none — no table frozen** |
- C1 is the best **table** design *when a table is warranted*. But C1/C2/C3 all **freeze the derivation's output contract before the derivation exists** (§8/§12), carrying migration risk with **zero near-term value** (no consumer, no deriver).
- **C4** builds the genuinely-missing artifact — the **Memory Deriver + first policy function** as a pure `evidence set → claim(s)` contract (code, testable, inert, no persistence) — which *determines* the Claim shape instead of guessing it. Same discipline that made IMPL-2 correct (function/contract before persistence).

## 19. Selected strategy
> **CLAIM STRATEGY (target, when built) = C1 — Hybrid envelope + typed proposition, candidate-set conflict model (state = f(rowset), no status machine).**
> **READINESS = NOT YET.** The Claim is the persisted **output** of a Derivation function (Deriver + first policy semantics) that **does not exist**; its rowset/uniqueness/conflict shape is a function of that unbuilt artifact (§8/§12). Persisting it now is speculation with migration risk and no consumer.

## 20. If Claim were built (conceptual minimum, for the record — deferred)
tenant `businessId` · inline `subject{domain,normalizedKey}` · `claimType` + typed `propositionValue` · FK `policyVersionId` (RESTRICT) · `evidenceSetIdentity` reference · `materializedAt`. Unique `(businessId, subject, claimType, policyVersion, propositionValue)` (candidate-set) **iff** the deriver confirms the candidate-set semantics. Droppable/rebuildable; additive; inert until a read-switch. **Not to be written until the Deriver fixes these.**

## 21. Hard forbidden semantics (permanent)
No truth/verified flag · no owner-approved flag · no `current/latest/active` · no `preferred` · no global learned knowledge/`isGlobal` · no mutable manual edit · no arbitrary metadata JSON without contract · no recommendation/action · no VendorLearning-compat field · no RIA authority field · no C1 dependency · no stored confidence in v1.

## 22. Deferred items (unchanged, still frozen)
Derived Claim substrate · confidence formula · VendorLearning backfill · VendorLearning read-switch · policy selection · erasure implementation · unified evidence log · C0 persistence activation · RIA binding/runtime · recommendation integration · SubjectRef/alias persistence.

## 23. Exact implementation gate (the real next step)
**Business Memory IMPL-3 (revised) — Memory Deriver + first Derivation Policy function, as a pure INERT code contract:** a deterministic `derive(ownerDecisionEvidenceSet, policyVersionId) → Claim candidate(s)` function (+ its conflict/support/state semantics, + tests) over the existing Evidence Adapter, with **no persistence, no writer, no Claim table, no read-switch**. It must concretely decide §8's conflict rule (recency/majority vs co-count) and §12's resulting rowset. **Only after** the deriver's output is concrete and tested does the Claim cache become a mechanical projection — at which point a Claim-substrate pre-implementation is a short, non-speculative step.

---

## Verdict
Both core questions are answered: the **proposition** is a tenant-local, derived, **operational** claim (reading (ii), not a vendor fact), best represented by a **hybrid envelope + typed proposition**; **generic-vs-specific** resolves to **hybrid**. Evidence linkage, subject, policy pinning, rebuild, confidence, and the recommendation boundary are all settled. **What is NOT settled is the Claim's rowset/uniqueness/conflict shape — because that is the output of a Derivation function (Deriver + first policy semantics) that does not yet exist.** A Claim is a rebuildable cache of a derivation; caching the output of an unbuilt function is speculation, not a substrate.

> **C — CLAIM NOT YET READY.**
> *Next: build the Memory Deriver + first Derivation Policy function as a pure inert code contract (no persistence). The Claim substrate follows, non-speculatively, once the deriver fixes its output.*

---

*Claim Pre-Implementation Decision v1 · READ-ONLY. Implements Contract v1 + Architecture v1 + Persistence Design v1 + IMPL-2; Contract v1 governs. No code/schema/migration/Claim/writer/runtime; VendorLearning / ReviewEvent / DerivationPolicy / RIA / C0 / C1 unmodified and unactivated.*
