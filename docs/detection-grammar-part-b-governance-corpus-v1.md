# Detection Grammar — PART B — Owner-Ratified Design Source (v1) — WORKING DRAFT

> STATUS: WORKING DRAFT (scratchpad). NOT persisted to repo. NOT yet Source of Truth.
> Becomes Source of Truth ONLY after FULL owner ratification (see Ratification Ledger).
> Provenance rule: nothing here has authority until the owner ratifies it. Memory and the
> earlier conversational "Discovery" carry ZERO authority. Candidate items are proposals only.

---

## 0 · Nature & Authority Model  (LEVEL 0 — awaiting ratification)

- This document is an **Owner-Ratified Design Source**, created — not recovered.
  There is no pre-existing signed Discovery/Handover; a full fact-check (2026-07-17) found none.
- Its authority derives **solely from the owner's explicit item-by-item ratification**, never
  from discovery, memory, or the Candidate Inventory.
- Scope: it is the source of truth for **SPEC-01 PART B only** — the Detection Grammar operator
  inventory and each operator's contract. It does NOT reopen PART A or SPEC-02..07.

## 1 · Ratification Protocol  (LEVEL 0 — awaiting ratification)

Status legend for every item:
- `PROPOSED`   — drafted for review; zero authority.
- `RATIFIED`   — owner approved verbatim.
- `CORRECTED`  — owner approved with an explicit change (change recorded).
- `REJECTED`   — owner removed the item.
- `DEFERRED`   — owner postponed (kept out of Source of Truth for now).

Rules:
- No item is `RATIFIED` implicitly. Silence ≠ approval.
- The document is Source of Truth only when EVERY active item is `RATIFIED`/`CORRECTED`
  and none is `PROPOSED`.
- Every operator/parameter is derived from PART A's locked framework — never asserted from memory.

Ratification granularity & order:
- **L0** — this frame (§0, §1, §2 template).
- **L1** — the operator INVENTORY (which operators exist).
- **L2** — per ratified operator: its full contract (via the §2 template).

## 2 · Per-Operator Entry Template  (LEVEL 0 — RATIFIED w/ CORRECTION 2026-07-17)

> **The template is part of the Owner-Ratified Design Source itself — NOT a quote or a
> reconstruction of PART A.** Where a field is consistent with a principle locked in PART A,
> that is stated in the field's `provenance`, and is NOT claimed to be a historical PART A text.
>
> **GOVERNANCE NOTE (owner-ratified):** The §2 template is part of the Owner-Ratified Design
> Source of PART B. It is consistent with the principles locked in PART A, but does NOT
> constitute an official publication of PART A itself. If PART A is later published as a
> standalone document, it MUST be consistent with the template ratified here, or include an
> explicit Decision Record explaining each deviation.

Each ratified operator declares exactly these fields; every populated field carries an explicit
`provenance:` tag — one of `DESIGN-DECISION` (owner's choice here) · `CONSISTENT-WITH-PART-A`
(follows a locked PART A principle) · `OPEN-QUESTION` (needs a separate owner decision):

1. `operatorId` — stable logical identity (purpose, not realization).
2. `class` — FRAMING or REDUCTION (PART A taxonomy).
3. `purpose` — one-line intent.
4. `inputContract` — what it consumes (grounds / prior projection / COT accounts).
5. `outputContract` — what it emits; the versioning anchor (per PART A: version tracks output contract).
6. `parameters` — declared parameter schema (each parameter typed + bounded).
7. `coverageDeclaration` — how the operator contributes to coverage (per SPEC-07 A4; contributor, not authority).
8. `determinism` — determinism obligations (same inputs + pinned context → same output).
9. `compositionRules` — legal predecessors/successors (PART A: Reduction→Framing forbidden; Reduction→Reduction open).
10. `versioningRule` — the single PART A versioning rule instance for this operator.
11. `openQuestions` — anything NOT derivable from PART A that needs a separate owner decision.

## 2.5 · Operator Membership Criteria  (LEVEL 0.5 — PROPOSED, awaiting ratification)

> Derived ONLY from locked principles (PART A / SPEC-02..07 / C0), NOT from any candidate list.
> The inventory (§3) must be an OUTPUT of these criteria. Every criterion is `CONSISTENT-WITH`
> a locked principle (PART A text-only → consistency, not quotation).

### A · Category Taxonomy (mutually exclusive buckets)
| Category | Short definition |
|---|---|
| **Primitive Operator** | an atomic node of the Detection Grammar — meets ALL criteria C1–C8 |
| **Composite Pattern** | expressible as a legal composition of primitives — meets C2–C8 but FAILS C1 |
| **Derived Projection** | an OUTPUT/value produced BY operators, not a way-to-compute — fails C2/C3 |
| **Detector Logic** | application-level orchestration (Detector Definition graph + policy) — fails C1; uses operators (SPEC-03/04) |
| **Runtime Utility** | stateful/scheduling/support scaffolding — fails C4 and/or C3 |
| **C0 Prerequisite** | operates BELOW the projection layer (produces/normalizes Evidence) — fails C5 |
| **Cross-Cutting Grammar Contract/Law** (OWNER-RATIFIED) | a law/contract, not a node (e.g. Coverage Propagation) — fails C1+C3-as-function. **BOUNDARY (ratified):** this is a CLASSIFICATION-ONLY category to stop laws/contracts from being miscounted as operators; it is NOT an Operator category and NOT a member of the Grammar inventory. |

### B · Membership Criteria (a Primitive Operator must meet ALL)
| # | Criterion | Why required | Locked basis |
|---|---|---|---|
| **C1** | **Irreducibility** — not expressible as a composition of other operators | without it every pattern is a "primitive"; the grammar needs a minimal generating set (A0) | PART A composition model; A0 |
| **C2** | **Single Grammar Class** — exactly one ratified operator class under the PART A taxonomy | class is the type that governs legal composition; no class ⇒ can't be typed in the operator-graph | PART A taxonomy + Reduction→Framing rule *(reconciled by Amendment A3, 2026-07-31)* |
| **C3** | **Universal Operator Contract conformance** — declarable via §2, has an Output Contract | operator-graph nodes are referenced by their contract; no Output Contract ⇒ not a node | PART A operator template; SPEC-04 |
| **C4** | **Determinism & statelessness** — pure function; no state/schedule/inference/side effects | substrate guarantees reproducibility & pinning; stateful/inferential breaks replay | PART A determinism; SPEC-06; C0 inference-freeze |
| **C5** | **Layer-correctness** — consumes grounds/projection, emits within the Projection layer | operators live at Projection; producing Evidence ⇒ C0, producing Belief ⇒ above; else layers collapse | 4-layer model; SPEC-02; C0 boundary |
| **C6 (=C6a only, ratified scope)** | **Honesty obligations** — grounds-anchored + no-fabrication (+ locked honesty obligations) | an operator that fabricates / isn't grounds-anchored can't emit a legal projection | SPEC-07; C0 (missing≠negative, Unknown-not-fabricated) |
| ~~C6b~~ | **DEFERRED** — per-operator coverage-DECLARATION is NOT part of membership; stays under **OQ-39** at its existing status; not decided via membership criteria | — | (OQ-39 OPEN) |
| **C7** | **Output-Contract versionability + purpose-identity** — operatorId=purpose, version tracks Output Contract | membership needs a stable identity + the single versioning rule | PART A unifying versioning; SPEC-03 |
| **C8** | **Inventory-Independence (A0)** — definition never references which other operators exist | passes the Swap-Test; else the inventory becomes self-referential/unstable | PART A A0; Inventory-Independence discipline |

### C · Classification Decision Procedure (ordered, deterministic)
1. **Layer (C5):** produces Evidence? → **C0 Prerequisite**. Produces Belief/Judgment? → above grammar (**Detector Logic** if orchestration; else out of PART B).
2. **Function (C3+C4):** not a declarable deterministic function w/ Output Contract? → stateful/scheduling ⇒ **Runtime Utility**; a law/contract ⇒ **Cross-Cutting Contract/Law**.
3. **Value-vs-function:** is it a computed OUTPUT rather than a way-to-compute? → **Derived Projection**.
4. **Class (C2):** not assigned to exactly one ratified operator class under the PART A taxonomy? → not an operator; recheck the preceding classification analysis (1–3).
5. **Irreducibility (C1):** composable from other operators? → **Composite Pattern**.
6. **Honesty+Versioning+Inventory-Independence (C6,C7,C8):** all hold? → **Primitive Operator**. Any fail ⇒ reclassify.

### D · Justification / Provenance of each L0.5 item (audit before ratification)
Legend: **ENTAILED** = necessary consequence of a locked principle · **CHOICE** = one valid
option among alternatives (owner should bless) · **ODDR** = OWNER DESIGN DECISION REQUIRED
(new decision, NOT forced by SPEC — must not be presented as entailed).

**Categories**
| Item | Justification | Class |
|---|---|---|
| Primitive Operator / Composite Pattern | primitive-vs-composite distinction is forced by PART A's composition model (generators vs products) | ENTAILED |
| Derived Projection | SPEC-02: a projection OUTPUT is not an operator | ENTAILED |
| Detector Logic | SPEC-03/04: detectors orchestrate operators (distinct layer) | ENTAILED |
| C0 Prerequisite | locked C0/Projection boundary (Normalize = prerequisite) | ENTAILED |
| Runtime Utility | the EXCLUSION of stateful helpers is entailed (C4); naming a home-bucket for them is a labeling choice | **CHOICE** |
| Cross-Cutting Contract/Law (7th) | NOT forced — coverage-propagation could simply be "not an operator, owned by SPEC-07"; adding a category is new | **ODDR** |

**Criteria**
| Item | Justification | Class |
|---|---|---|
| C1 Irreducibility (as a hard membership requirement) | PART A locks composition RULES but NOT that the inventory admits ONLY irreducible primitives; "minimal generating set" vs "allow blessed composites" is a design choice | **ODDR** |
| C2 Single Class (exactly one ratified operator class) | PART A operator-class taxonomy requires each admitted operator to have exactly one canonical class | ENTAILED |
| C3 Universal Operator Contract conformance | definitional — PART A universal operator contract template | ENTAILED |
| C4 Determinism & statelessness | PART A determinism + SPEC-06 replay + C0 inference-freeze; statelessness follows from determinism+pinning | ENTAILED |
| C5 Layer-correctness | 4-layer model + SPEC-02 + C0 boundary | ENTAILED |
| C6a grounds-anchored + no-fabrication | SPEC-07 + C0 (missing≠negative, Unknown-not-fabricated) | ENTAILED |
| C6b coverage-DECLARATION per operator | this is **OQ-39**, still PROOF-REQUIRED/OPEN — NOT locked; requiring it now is a new decision | **ODDR** |
| C7 Output-Contract versionability + purpose-identity | PART A unifying versioning + SPEC-03 | ENTAILED |
| C8 Inventory-Independence (A0) | PART A A0 stability-under-inventory-change | ENTAILED |

**Procedure**
| Item | Justification | Class |
|---|---|---|
| Overall step ordering | a valid decision-tree order; other orders reach the same buckets | **CHOICE** |
| Steps 1,3,4 + honesty/versioning routing | rest on entailed criteria (C5,C3,C4,C6a,C7,C8) | ENTAILED |
| Step 2 → Contract/Law · Step "Runtime Utility" | inherit those categories' flags | inherits ODDR / CHOICE |
| Step 5 (irreducibility → Composite Pattern) | inherits C1 | inherits **ODDR** |

**Net items needing an explicit owner decision before §2.5 can be ratified:**
1. **Adopt the 7th category (Contract/Law)?** — ODDR.
2. **Is C1 (irreducibility) a HARD membership requirement** (only irreducible primitives) **or** do we allow blessed composites in the inventory? — ODDR.
3. **C6b — require coverage-declaration per operator?** This is open **OQ-39**; adopting it here would decide an open PROOF item — ODDR (or keep C6 = C6a only, defer C6b).
4. Bless the two CHOICE items (Runtime Utility bucket; procedure ordering).

## 2.6 · C1 Decision Analysis — irreducibility (OPEN, owner to decide)

Three options:
- **A — Minimal primitives only** (C1 HARD; no composites in inventory).
- **B — Inventory allows blessed composite operators** (composites get Primitive Operator status).
- **C — Canonical primitives-only inventory + SEPARATE named-composite-pattern LIBRARY** (patterns
  are reusable + named but are NOT Primitive Operators; they expand to atoms before execution).

**Decisive finding:** Option **B contradicts the already-ENTAILED criterion C8 (Inventory-Independence / A0).**
A composite operator is DEFINED as a composition of specific other operators, so its definition
inherently references which operators exist → it CANNOT pass the Swap-Test. Admitting composite
OPERATORS therefore violates a locked PART A principle; B is unavailable without reopening PART A.
The real choice is **A vs C**, and **C dominates A** (same atomic core + a home for reuse, at zero
semantic cost).

**DECISION — C1 RATIFIED as Option C (owner, 2026-07-17):** A **Primitive Operator must be atomic
and irreducible to a legal composition of other Primitive Operators.** An entity expressible as a
composition of primitives is NOT a Primitive Operator (however useful/named) — it is a
`Composite Pattern` and may live in a separate Patterns library. Option B rejected (violates
C8/A0). Full 10-axis analysis delivered in chat 2026-07-17.

## 2.7 · Pattern-Library Boundary  (OWNER-RATIFIED 2026-07-17 — boundary only, no full SPEC)
1. `patternId` lives in an identity space SEPARATE from `operatorId` and `detectorId`.
2. A Pattern is NOT an Operator and does NOT join the PART B Primitive Operator inventory.
3. A Pattern MUST be fully expandable to a legal graph of primitives BEFORE execution.
4. Runtime execution and Replay run against the EXPANDED primitive graph, never a pattern black-box.
5. A Pattern MAY be versioned separately, but its version does NOT replace the pinning of the
   operators it expands into.
6. Promotion of a Pattern to a Primitive is NOT automatic — it requires a Decision Record and an
   explicit Grammar change.

## 2.8 · C1 Standard — REFINED (owner-ratified 2026-07-17)
C1 does NOT require proving irreducibility against all POSSIBLE/future primitives (unprovable —
would let nothing ever lock). Refined standard:
> A candidate is a Primitive when there exists NO legal, complete, contract-preserving
> decomposition from (a) the RATIFIED Primitive Operators and (b) Grammar structures already
> proven/derived from locked principles — **at the time of ratification.**

**Known-Decomposition Test:** (1) seek a decomposition via the ratified inventory; (2) seek one via
operations already independently DEFINED in ratified material; (3) exhibit any concrete known
decomposition; (4) do NOT invent a hypothetical primitive to force a decomposition; (5) do NOT
infer "primitive" merely from a small inventory — must ALSO show an atomic single purpose + an
Output Contract that does NOT hide known internal orchestration.

**Implementation-guard:** a decomposition into CODE / implementation steps is NOT a semantic
decomposition into operators. To classify a candidate as a Composite Pattern, EVERY component must
be a legal DEFINED Grammar operation — not an algorithmic description. Otherwise the "composite"
claim fails.

**Forward-compatibility:** if a FUTURE ratified primitive later makes an existing primitive fully
decomposable, that is handled via Decision Record + Grammar amendment + version — it does NOT
retroactively invalidate the original ratification.

**Possible C1 outcomes:** narrow Primitive · Composite Pattern (over DEFINED primitives) ·
Detector/Runtime orchestration · PROOF-REQUIRED (a necessary component's contract is missing).

## 2.9 · Relational View Principle (owner-ratified 2026-07-18)
> If ALL semantic information already exists inside a RATIFIED Projection, and an operation only
> changes how that information is EXPOSED or ENUMERATED, it is NOT a new FRAMING Primitive.
>
> **Relation VIEW ≠ Relation FORMATION.** Formation may be a Primitive; a View alone does NOT prove
> a Primitive.

Consequence: candidates that are only views over an existing Projection (e.g. Join / Pair /
CrossMatch / Neighbor / Association over an identity group) are NOT admitted as FRAMING primitives on
that basis. A view must be classified on its own merits and stays **OPEN** until proven — it is NOT
assumed to be REDUCTION / Pattern / Primitive / non-operator.

## 2.10 · Empty Ground Set — general Grammar rule (OWNER-RATIFIED 2026-07-19)
An **empty ground set is NOT an empty configuration** — it is only an empty POPULATION. The rule
distinguishes: ground-bearing input · application parameters · externally-supplied frame/config
inputs · and each operator's own Output Contract.

1. An empty ground set is NOT `NOT_APPLICABLE`.
2. An empty ground set is NOT, by itself, a precondition failure.
3. The operator runs normally, provided all other inputs/parameters are valid.
4. The output MUST be the **canonical empty projection defined by that operator's Output Contract**.
5. It is FORBIDDEN to invent members / frames / complements / segments / relations / aggregate
   values to "fill" the output.
6. Identity, provenance, operator version, and parameter pinning are still recorded normally.
7. The difference between an empty-input invocation and NOT running is a SEMANTIC difference and
   MUST NOT be left to implementation choice.

**Meaning per ratified operator:**
- **Partition** — empty ground set → the canonical empty partition per its contract. Do NOT
  fabricate an empty subset unless an empty subset is explicitly implied by Partition's Output
  Contract (e.g. a CLOSED declared domain still lists its declared categories, now all empty).
- **IntervalMembership** — empty ground set does NOT delete the interval space. Because `FrameSet`
  derives from the pinned interval space (NOT from ground count), frames may still appear with EMPTY
  members. `UnframedComplement` is empty. Do NOT assert "empty FrameSet" automatically.
- **GapSegmentation** — empty ground set → **empty `SegmentSet`** (segments are formed only from
  grounds; empty segments impossible). Here empty population DOES yield an empty configuration.

Retroactive DOCUMENTATION inheritance: `Partition` and `IntervalMembership` contracts inherit §2.10
explicitly (documentation-only; their ratification is NOT reopened).

## DR-C1-PARTA-01 — PART A Class-Definition Provenance Loss & Owner-Ratified Replacement (RECORDED 2026-07-22)
- **Status:** **COMPLETED / CLOSED 2026-07-22** — replacement `PART-A-replacement@v1` RATIFIED; the PART A Class-Definition Provenance Gap is officially closed via the ratified Replacement Governance mechanism.
- **Problem:** the authoritative wording of PART A's operator-class definitions (`FRAMING`/`REDUCTION`) is not recoverable.
- **Search Scope (Read-Only):** repo `business-platform` · Brain worktree `bp-brain-c0` · session scratchpad · memory · Glob (spec-01/part-a) · **PR #109 file list (checked via `gh`)**.
- **Verdict:** `PA-3 — SOURCE NOT RECOVERABLE`.
- **Evidence:** NO source at Authority-Ladder levels 1–5. Only a memory SUMMARY (level 6) + reconstruction (level 7) — insufficient; levels 6–7 may NOT close the gap.
- **No reconstruction:** the historical wording must NOT be reconstructed from memory/summary and presented as authoritative.
- **Decision:** create a NEW **Owner-Ratified Replacement PART A**. It is **NOT a quote or reconstruction** of the historical PART A; it becomes the replacement source of authority **from its ratification date**.
- **Historical loss preserved** here, NOT hidden.
- **No silent Retroactive Interpretation:** the replacement governs FORWARD classification only; it does NOT reinterpret ratified contracts. The 4 ratified primitives (`Partition`/`IntervalMembership`/`GapSegmentation` = FRAMING; `Count` = REDUCTION) remain RATIFIED; **default = no re-ratification**. A Compatibility Audit follows drafting; only an explicit contradiction + a separate Owner decision may reopen any of the four.
- **Chosen structure (owner):** **PA-C** (separate axes: Operator-Class / Input-Category / Output-Category / Composition-Role) + **PA-D** (explicit `CLASS-UNRESOLVED` status) + **PA-B** (governed future class-addition). **PA-A rejected.**
- **UNFROZEN 2026-07-22 (replacement PART A ratified):** `Equality` and `Ordinal` are released from the CLASSIFICATION-BLOCKED-by-provenance-gap state. **W1 must be RE-RUN fresh for each, against ratified `PART-A-replacement@v1`, as if the first test — NO prior class conclusion is carried** (only the ratified facts: monolith-Compare rejected; Equality/Ordinal boundary-resolved as two distinct candidates; Difference/Ratio/Threshold/Set separated). `Compare` monolith stays rejected. Still: no Primitive #5, no W2, no §2, no Design-Axes until fresh W1 completes and the owner decides.
- **Next:** `PA-R2` (Design-Axes) → owner-chosen package → replacement draft (independent of the frozen candidates, under Non-Bias tests) → ratification → Compatibility Audit → only then classify candidates.

## PART A (REPLACEMENT) — **RATIFIED** · current version `PART-A-replacement@v1.1` · v1 Owner-ratified 2026-07-22 · v1.1 amended 2026-07-24 (Amendment A1, `DR-C1-PARTB-CLASS-01`)
> **RATIFIED as the official source of authority for the Detection-Grammar operator-class taxonomy (Owner Ratification 2026-07-22).** Authored per `DR-C1-PARTA-01` and the PA-R2/PA-R4 owner decisions (PKG-MIN + PA-C + PA-D + PA-B). It is a **replacement source of authority effective 2026-07-22 — NOT a quote or reconstruction of the historical PART A.** The `extent` wording note (PA-R5 F-PA5-1) was owner-classified as documentation-only and NOT a ratification blocker. Backward-Compatibility & Non-Retroactivity (§11/§12) in force; the four ratified primitives are unchanged and NOT re-ratified.

**1 · Authority & Replacement Status.** The historical PART A class-definition source is unrecoverable (`PA-3`, DR-C1-PARTA-01). This document, upon ratification, is the **replacement source of authority** for Detection-Grammar operator classes, effective from its ratification date. It does NOT reconstruct the lost source.

**2 · Scope of PART A.** PART A governs: the operator-class taxonomy · the Category vs Class distinction · composition rules between classes · the `CLASS-UNRESOLVED` status · the governed future class-addition mechanism. PART A does NOT contain individual operator contracts (those are PART B / per-operator §2).

**3 · Class / Category / Composition-Role separation (PA-C).** Four SEPARATE axes:
- **Operator Class** — the kind of semantic transformation (see §4).
- **Input Category** — what the operator consumes (Ground/Evidence · Scope · Readout · Quantity · Projection · …).
- **Output Category** — what it produces (Scope · Readout · Quantity · Relation-Outcome · …).
- **Composition Role** — what it may consume and what may consume it.
Class MUST NOT be inferred from Input Category, Output Category, arity, output size, scalar-ness, readout-ness, or graph position. Categories/role may TEST class-fit but never DERIVE class.

**4 · Operator Class — constitutive basis.** A class is constituted by: (a) the **kind of semantic transformation**; (b) **ownership of newly-created semantic information** (Formation vs evaluation/exposure, §2.9); (c) the **atomic Purpose**. Non-constitutive (alone): input type · output type · arity · output size · scalar/readout output · composition position.

**5 · FRAMING (definition, draft).** FRAMING is an operator that **creates NEW semantic Scope structure** by establishing membership, boundaries, partitioning, or structural identity over an input set. Constitutive: the operator OWNS a new semantic **Formation**; output is a **Scope** (or set of Scopes); the membership/boundaries/grouping did NOT pre-exist in the same semantic Projection. A View / enumeration / exposure of an existing relation is NOT FRAMING (§2.9). FRAMING is NOT restricted to raw-Grounds input — a future FRAMING may consume a Projection/Scope and create a NEW Scope, but ONLY with an explicit Input Contract + a genuinely-new Formation + a Known-Decomposition proof that it is not a Composite or View. Input type is therefore NOT part of the class definition, though **output ∈ Scope Category is a central sign** (Scope Category defined in §16). PART A creates NO general Grammar type / superclass / interface / capability `Scope` — "Scope" is an Input/Output **Category** with explicit ratified membership (§16).

**6 · REDUCTION (definition, draft — NARROW).** REDUCTION is an operator that **consumes one or more supported semantic Scopes** and produces from them a **non-Scope readout**, reducing the Scope's structural information to a derived result **without creating a new Formation**. Clarifications: NOT defined by arity (single vs multiple inputs do not set class); NOT defined merely by "smaller output"; does NOT automatically include every operation that yields a scalar / Quantity / relation-outcome; **`readout → readout` is NOT automatically REDUCTION** and remains `CLASS-UNRESOLVED` unless a candidate proves it fits this definition or justifies a separate class; a quantity-producing operation is NOT REDUCTION merely because it yields a Quantity; a relation-evaluation is NOT REDUCTION merely because it yields a short outcome. The term `many→one` is NOT used as a constitutive criterion (too algorithmic/vague). This definition preserves `Count` (scope→readout) without being written for Count alone, and leaves the Equality/Ordinal boundary honestly open. **Scope-Category membership (§16) is a POSSIBLE input condition; Operator Compatibility is a SEPARATE, additional condition** — no REDUCTION accepts all Scope types automatically, there is NO Structural Typing, a `Raw GroundSet` is NOT a Scope merely because it is a finite set, and `readout → readout` remains `CLASS-UNRESOLVED`.

**6b · Canonical Relation Evaluation (THIRD OPERATOR CLASS — added by amendment A1; `DR-C1-PARTB-CLASS-01`; Owner Ratification 2026-07-24).** A third operator class alongside FRAMING and REDUCTION. **Constitutive transformation-kind:** evaluation of a canonical, domain-fixed relation (D6) between two peer relata consumed contract-opaquely (D1), emitting a canonical relation-specific typed outcome. **Information-ownership:** a relation-fact between independent peer relata — NOT Scope Formation (≠ FRAMING §5), NOT reduction of a Scope's structural information (≠ REDUCTION §6), NOT Quantity production, NOT identity lookup, NOT criterion/rule application, NOT Judgment. **Full ratified definition** (boundaries, exclusions, output boundary, membership process, amendment tiers): PA-B §A (Foundation — D1 · D6 · Contract-Opaque anchor · Hidden-Transformation Guard) + PA-B §B §1–§15. This amendment ADDS a class only; it does NOT alter the FRAMING (§5) or REDUCTION (§6) definitions and reclassifies no existing operator. Membership is NOT automatic — every candidate operator still passes W1–W9; no operator is classified into this class by this amendment.

**7 · CLASS-UNRESOLVED (status, not a class).** A governance status for a candidate whose Purpose/Boundary is clarified, that is not yet rejected, and for which no ratified class is proven to fit. **Allowed in it:** Threshold Proof · Boundary/Purpose analysis · input/output analysis · Known-Decomposition · Swap-Tests · class-fit examination · required Foundation audits. **Forbidden in it:** final §2 · final operatorId · Primitive number · Ratification · Ledger/Register entry as an operator · runtime use as a ratified operator · being used to prove a new class circularly. **Exit only via:** proven fit to an existing class · ratification of a new class (PA-B) · rejection · decomposition · reclassification (View/Composite/Pattern/other). It is NOT a class and NOT a permanent parking lot.

**8 · Future Class-Addition (PA-B — defined, DORMANT).** No new class is created now. A new class is considered ONLY when ALL hold: an independent family Purpose · a distinct transformation-kind · distinct information-ownership · a proven boundary vs existing classes · proof the gap is not merely an Output Category · Known-Decomposition + C1–C8 relation · Non-Bias Audit · backward compatibility · a Decision Record · Owner Ratification. **No numeric minimum of candidates** — a single candidate may reveal a gap, but a class is NOT created just to hold one; family evidence may come from multiple candidates, multiple independent use-cases, or a broad principled proof.

**9 · Composition Rules.**
- **FRAMING → REDUCTION:** allowed and proven (Count consumes a framed scope), subject to explicit input-compatibility · lineage · replay · version-pinning · acyclic composition · no hidden conversion.
- **REDUCTION → FRAMING:** FORBIDDEN — not merely by layer order, but because a REDUCTION readout MUST NOT silently become Ground membership or Scope Formation. Any future exception requires a Decision Record + explicit Governance change.
- **FRAMING → FRAMING:** not forbidden; legal only when the first's output is a supported input of the second, the second creates a new independent Formation, no hidden orchestration, each operator stays atomic. `Partition → GapSegmentation per subset` is a Composite — NOT a new primitive and NOT a proof that all FRAMING→FRAMING is auto-allowed.
- **REDUCTION → REDUCTION:** OPEN — neither allowed nor forbidden now [OPEN-Q2].
- **CLASS-UNRESOLVED:** a candidate in this status does NOT participate in ratified composition and cannot be consumed as an existing operator.

**10 · Relation to §2 / C1–C8 / A0 / §2.7–§2.10.** PART A defines classes/categories/composition; the **§2 template** defines per-operator contract fields; **C1–C8** are the membership criteria a candidate must pass to be a Primitive within a class; **A0/C8** = operator-inventory-independence. **§2.7** (pattern-library boundary), **§2.8** (refined C1 standard), **§2.9** (View ≠ Formation), **§2.10** (empty ground set) remain governing and unchanged; PART A is consistent with them and does not restate or alter them.

**11 · Backward Compatibility.** The four ratified primitives are NOT reopened by this draft. Default: `Partition`/`IntervalMembership`/`GapSegmentation` remain FRAMING; `Count` remains REDUCTION; no re-ratification. A Compatibility Audit follows; only an explicit contradiction + a separate Owner decision may reopen any of the four.

**12 · Non-Retroactivity.** PART A governs FORWARD classification only. It does NOT reinterpret already-ratified operator contracts or their identities.

**13 · Open Questions.** [OPEN-Q1 — CLOSED by PA-R4, §16] Scope Category status defined (semantic Output Category with explicit ratified membership; NOT a Class/Type; NOT the current inventory list; NOT a Compatibility Matrix). [OPEN-Q2] `REDUCTION → REDUCTION` composition. [OPEN-Q3] classification of `readout → readout` operations. [OPEN-Q4 — CLOSED (classification-level) 2026-07-29, Amendment A2] classification of the frozen candidates `Equality`/`Ordinal`: RESOLVED at CLASSIFICATION level — both are `CLASS ASSIGNED` to `Canonical Relation Evaluation` (ORD-CF1 / EQ-CF1), `W2-ELIGIBLE`, and NOT ratified members. Classification-level ONLY: does NOT open W2, does NOT write §2, does NOT ratify membership, assigns no operatorId/Primitive number; full membership still requires W2–W9 (§11). [OPEN-Q5 — CLOSED 2026-07-24] whether a third operator class is ever warranted (via PA-B): RESOLVED — a third class, `Canonical Relation Evaluation`, was added via PA-B and ratified by `DR-C1-PARTB-CLASS-01` (§6b). PA-B remains available for any further class beyond the third.

**16 · Scope Category (PA-R4 — closes OPEN-Q1).**
- **Definition.** The Scope Category denotes a canonical semantic OUTPUT type that represents an **extent, membership structure, boundary structure, grouping structure, or complement structure** that is CREATED AND LOCKED by a ratified Producer contract, and whose instances carry **identity and snapshot that are identifiable and Replayable per the producing contract**. The definition does NOT require every Scope to: use the same data structure · contain a field named `members` · be non-empty · be a framed scope of the same kind · use the same identity mechanism. **Category membership is set EXPLICITLY, NEVER by Structural Typing.** This is an Input/Output **Category**, NOT an Operator Class and NOT a general Grammar Type/superclass/interface/capability.
- **Current Ratified Membership** (verified Read-Only against `### Registered Scope Types`; a SNAPSHOT of current inventory — NOT the definition, NOT a forever-closed list): `PartitionSubset` · `IntervalFrame` · `UnframedComplement` · `Segment` · `SegmentSet` (only in its exact registered status per the GapSegmentation contract).
- **Future Admission.** A future type does NOT join automatically because it contains members / is produced by FRAMING / is named frame·segment·subset·scope / resembles an existing type. Admission requires at least: (1) a ratified Producer contract or ratified contract change · (2) a defined semantic Output type · (3) canonical identity or canonical child identity · (4) snapshot/replay semantics · (5) explicit membership/boundary/grouping/complement semantics · (6) a check it is NOT merely a View / serialization / technical container / runtime utility · (7) an explicit registration decision in `Registered Scope Types` · (8) a backward-compatibility check. No new Operator Class is needed to add a Scope type. Whether each admission needs its own DR is NOT decided now — it depends on whether it registers an already-ratified output or changes a Governance/contract.
- **Scope Category Membership ≠ Operator Compatibility.** Category membership = "the type is recognized system-wide as a semantic Scope type." Operator compatibility = "a specific operator may consume this type." Being a Scope-Category member does NOT make a type an input of any operator. `Count` v1 continues to support ONLY its ratified allow-list (`PartitionSubset`/`IntervalFrame`/`UnframedComplement`/`Segment`); `SegmentSet` or any future Scope is NOT a `Count` input without a separate Compatibility decision. This preserves: no-auto-extension · no-structural-typing · C8 · and the taxonomy-vs-operator-contract distinction.

**14 · Relation to PART B.** PART A = the class/category/composition framework. PART B = the operator inventory + per-operator §2 contracts. PART A does not contain PART B's operator specifics.

**15 · Versioning & Future Amendments.** Current version: **`PART-A-replacement@v1.1`**. Amendments require a Decision Record + Owner Ratification. **Version record:**
- **`@v1`** — initial ratified replacement taxonomy (FRAMING + REDUCTION); Owner Ratification **2026-07-22** (historical date unchanged); authority `DR-C1-PARTA-01`.
- **`@v1.1`** — additive class-taxonomy amendment adding the third class `Canonical Relation Evaluation` (§6b) and closing OPEN-Q5 (§13); **EFFECTIVE 2026-07-24**; authority `DR-C1-PARTB-CLASS-01` + Amendment A1. A **direct continuation of `@v1`, NOT a new Replacement**; `DR-C1-PARTA-01` remains the authority for the Replacement itself, while `DR-C1-PARTB-CLASS-01` + Amendment A1 are the authority for the `v1 → v1.1` transition.
- **Amendment A1 (2026-07-24; `DR-C1-PARTB-CLASS-01`):** the `v1 → v1.1` change. Additive-only: FRAMING (§5), REDUCTION (§6), the four ratified primitives, and every other clause are UNCHANGED.
- **Amendment A2 (2026-07-29; authority: class-fit gates ORD-CF1/EQ-CF1):** closed OPEN-Q4 at CLASSIFICATION level — a **Tier-C documentation-consistency sync (NO version bump; PART A remains `@v1.1`)**. Records in §13 the **already-established** classification of both candidates to `Canonical Relation Evaluation` (previously established via the Class-Fit Gates, NOT by this amendment). NO new taxonomy content · NO class/definition/Foundation/Contract/Inventory change · NO W2/§2/membership/operatorId/Primitive#. Both candidates remain NOT ratified members; class members remain NONE.

---

## PA-B · Candidate Class-Addition Process (CA-R chain) — Foundation RATIFIED · Class DRAFT

> **Relationship.** This section operated the `PA-B` class-addition mechanism defined in PART A §8, downstream of `DR-C1-PARTA-01` (CLOSED) and governed by the current `PART-A-replacement@v1.1` (the PA-B mechanism it operated under is PART A §8, present since `@v1`). **OUTCOME (Owner Ratification 2026-07-24):** the Operator Class `Canonical Relation Evaluation` and `DR-C1-PARTB-CLASS-01` are RATIFIED and EFFECTIVE; PART A was amended to a three-class taxonomy (PART A §6b) and OPEN-Q5 closed. The ratification created the CLASS only — it did NOT classify `Ordinal`/`Equality`, add any Operator/Primitive, or open any W2/§2. Process history: CA-R1..CA-R5 (chat) · persisted CA-R5.5/CA-R7 (documentation-only) · ratified CA-R8.
>
> **Artifact map (same Class-Addition Process; post-ratification statuses).** §A Candidate Class Foundation = `RATIFIED` · §B Operator Class `Canonical Relation Evaluation` = `RATIFIED · EFFECTIVE (2026-07-24)` · §C Open Questions = `OPEN` (all seven) · §D Candidate Status (`Ordinal`/`Equality` = `CLASS-UNRESOLVED`, unchanged) · §E Decision Record `DR-C1-PARTB-CLASS-01` = `OWNER-RATIFIED · EFFECTIVE` · §F Evidence Chain Record (documentation). Ratifying the class did NOT confer membership on any candidate; membership remains via W1–W9.

### A · Candidate Class Foundation — RATIFIED (Owner Ratification 2026-07-24)

> **Status: `RATIFIED FOUNDATION`.** This Foundation is NOT an Operator Class · is NOT a change to PART A · does NOT classify any Candidate · does NOT permit skipping W1–W9. It fixes ONLY the two independent Foundation axes (D1, D6) plus the Contract-Opaque anchor and the Hidden-Transformation Guard, as the basis for drafting a Candidate Class.

**D1 — Relata Boundary.** Two inputs are valid **peer relata** at Foundation level only when BOTH hold together:
- **(a) Peer Semantic Role** — both relata occupy an equal semantic role in the relation; neither serves the other as `criterion`, `rule`, `pattern`, `schema`, `container`, `Scope`/membership-defining frame, or external policy source. The determination is NOT based on arity or on there merely being two inputs.
- **(b) Contract-Opaque Relation Evaluation** — at the operator-contract level, the relata are consumed as semantic values that are ATOMIC with respect to the operation. "Atomic" does NOT claim they lack internal structure; it means the operator: is NOT the owner of structural decomposition; is NOT the owner of membership semantics; is NOT the owner of boundaries; is NOT the owner of grouping; does NOT perform structural-property extraction as part of its Purpose; and does NOT define a new semantic traversal to decide the relation. The operator applies a relation already defined by a qualified relation-domain. Internal implementation details of that relation do NOT change the Transformation Kind, so long as they are not exposed in the operator's contract, add no new semantics, and the operator does not become the owner of the examined structure. Consequently: `string ordering` may be valid even if its implementation scans characters; `composite identifier equality` may be valid even if its implementation inspects components; `canonical structured value equality` may be valid if a qualified relation-domain defines it; `Grammar Scope containment` is OUT when membership examination is part of the operator's Purpose. There is NO admission by type name, representation, or Input Category alone.

**Contract-Opaque Relation Evaluation (anchor).** At the level of the operator's contract, the relata are consumed as semantic values atomic-with-respect-to-the-operation. The operator is not the owner of their decomposition, their membership, their boundaries, structural-property extraction, or a semantic traversal algorithm. It applies a relation the qualified relation-domain already defines outside the operator's contract. Internal implementation of that relation does not change the Transformation Kind, provided it is not part of the operator's contract, adds no new semantics, and the operator does not become the owner of the examined structure. Clarifications: "atomic" is relative to the operator's contract (not a claim of no internal structure); the relation-domain implementation MAY traverse / compare representation; the operator itself MUST NOT invent or own membership / containment / boundary / aggregation / structural-extraction semantics; if the operator's contract must define how to decompose the structure to determine the relation, it is a different Transformation Kind / a Candidate requiring Proof; nothing here implies `Set-as-value` or `TypeCompatibility` are inside — they remain for future examination against the principle.

**D6 — Relation Source.** A relation is a valid relation-source at Foundation level only when it is: canonical; deterministic; defined in a qualified relation-domain semantic contract shared by the relata; fixed for that domain and contract version; identical across every valid invocation; not re-selected per invocation; not dependent on a particular Producer; and not an external rule, policy, heuristic, or Judgment. The relation may not be silently supplied as a varying parameter or operator criterion. A Producer may at most REFERENCE a qualified domain relation; it may not create a different relation for the same values based on their source.

**Hidden Transformation Guard.** Normalization, conversion, and tolerance are NOT decided within this Foundation. The principle is locked: **no hidden normalization, hidden conversion, or hidden tolerance.** If a future Candidate requires any of them, it MUST be: explicit; declared in the contract; version-pinned; and examined at the appropriate Candidate/Design/§2 stage. Nothing here concludes whether `Type Compatibility` / `Set-as-value` / `normalized-string equality` / `quantity comparison with units` / `tolerance equality` are inside the class — they remain for future examination against the ratified Foundation.

### B · Operator Class — `Canonical Relation Evaluation` · `RATIFIED OPERATOR CLASS · EFFECTIVE` (Owner Ratification 2026-07-24)

> Class definition text below (§1–§15) is the ratified content: §1–§6, §9–§14 as drafted in CA-R3; §7, §8, §15 as corrected in CA-R5. The class semantics were NOT altered at ratification; only status/authority (§1) and the CLASS-UNRESOLVED relation (§10) were reconciled.

**§1 · Authority & Status.** `Operator Class Canonical Relation Evaluation · RATIFIED · EFFECTIVE 2026-07-24`. Rests on `Candidate Class Foundation — RATIFIED` (§A); authority `DR-C1-PARTB-CLASS-01` (§E, OWNER-RATIFIED · EFFECTIVE). Added to the PART A operator-class taxonomy by amendment (PART A §6b). Ratifies the CLASS only — classifies no Candidate; membership remains via W1–W9 (§11).

**§2 · Transformation Kind.** Evaluation of a **canonical, domain-fixed relation between two peer relata**, consumed **contract-opaquely**, emitting the **canonical outcome of that relation**. Does not rest on arity or output category.

**§3 · Atomic Family Purpose.** To home operators whose atomic purpose is **reading out a relational fact between two independent values** via a pre-defined domain relation — distinct from forming a scope, reducing scope structure, applying a criterion, or producing a quantity.

**§4 · Information Ownership.** Owns a **new relational fact between two independent relata**. NOT: Scope Formation · structural property of a scope · produced Quantity · membership determination · identity lookup · normative decision.

**§5 · Relata Boundary** *(= ratified D1)*. (a) Peer-Semantic-Role; (b) Contract-Opaque-Evaluation. (Full text as in §A/D1.)

**§6 · Relation Source** *(= ratified D6)*. Canonical · deterministic · qualified shared relation-domain contract · fixed for domain+contract-version · identical per invocation · not re-selected per invocation · not Producer-dependent · not external rule/policy/heuristic/Judgment. (Full text as in §A/D6.)

**§7 · Output Category (class-level) — CA-R5 corrected.** The output is the **canonical, relation-specific typed outcome defined by the applicable relation-domain contract.**
- No uniform Output Contract at class level.
- No forcing of boolean / three-way / finite outcome.
- The output is NOT a Scope.
- The output is NOT a new Quantity.
- The output is NOT a Business or Semantic Judgment.
- The Outcome-Contract specifics are decided in each Operator's contract.
(finite outcome NOT decided.)

**§8 · Explicit Exclusions — CA-R5 corrected.** Each exclusion is defined by semantic role, Transformation Kind, Information Ownership, and contract ownership — NOT by type name, representation, or technical use. Presented as a DERIVATION of §4–§6, not a standalone blacklist.
- **Schema/governing-structure role:** "A relatum is outside the class when it serves as a schema, rule, specification, or governing structure for the other relatum as part of the operator's semantic purpose." — No decision on `Type Compatibility`; two type descriptors are not disqualified merely as descriptors; examined later against D1/D6.
- **Container/frame role:** "A relation is outside the class when one relatum semantically defines membership, extent, containment, or an admissibility frame for the other relatum." — Use of a container data structure is not decisive; the exclusion applies only when the container-role is part of the Purpose and Information Ownership; no decision on structured values / `Set-as-value`.
- **Identity comparison:** "Identity comparison or identity lookup is outside the class when the operator's atomic purpose is to determine whether two references denote the same semantic or storage identity." — Identity MAY be used for provenance / input reference / lineage / replay / Projection identity; `value equality` may NOT claim identity equality, but the identity-collapse guard remains Contract/System-stage and is NOT decided here.
- **Scope structural operations:** "An operation is outside the class when its contract makes the operator semantically responsible for examining, deriving, reducing, or relating membership, boundaries, grouping, extent, containment, or another structural property of a Grammar Scope." — The criterion is Contract Ownership, not representation, not compositeness of the value, not implementation-level traversal; structured semantic values are not auto-disqualified; Grammar Scope relations stay OUT of the current class and require their own Proof.
- **Preserved principled exclusions (derived from §4–§6):** Scope Formation → FRAMING · Criterion/rule/pattern/policy application → source not D6-compliant · Quantity production → Purpose is creating a Quantity, not emitting a relation-outcome · Business/normative/semantic Judgment → out.

**§9 · Relation to FRAMING / REDUCTION.** NOT FRAMING: no Scope Formation; output is not a Scope. NOT REDUCTION: no consumption/collapse of scope structure; input need not be a Scope; output describes a relation between relata, not a property of a scope. An additive third region; no change to either class.

**§10 · Relation to CLASS-UNRESOLVED.** This class now occupies the previously-dormant class-slot (PART A §7/§8), ratified via `DR-C1-PARTB-CLASS-01` (§E). Its ratification does NOT resolve the `CLASS-UNRESOLVED` status of any candidate: `Ordinal` and `Equality` remain `CLASS-UNRESOLVED` until each is separately classified via W1–W9 (§11). A new PA-B exit-path (fit to a ratified class) is now available to them but has NOT been exercised.

**§11 · Candidate Membership Process.** Membership is NOT automatic; every operator still runs W1–W9; fitting the class is NOT a Primitive proof; the class is taxonomic context only.

**§12 · Open Questions (outside Foundation).** Type-Compatibility · Set-as-value · finite-outcome · normalization/conversion/tolerance · identity-collapse guard · Composition · Scope-Relations family. All OPEN; examined in future against the ratified Foundation.

**§13 · Backward Compatibility.** No change to `Partition` · `IntervalMembership` · `GapSegmentation` · `Count`.

**§14 · Non-Retroactivity.** Adding this candidate class reclassifies no existing item; the four primitives keep their classes.

**§15 · Future Amendments — CA-R5 corrected (tiered).**
- **A. Foundation-changing amendments** — a semantic change touching Transformation Kind · Information Ownership · D1 · D6 · Boundary vs FRAMING/REDUCTION · or another constitutive Class-membership principle → requires Foundation update + ratification FIRST.
- **B. Non-Foundation semantic amendments** — Composition · output-family constraints · Open-Question resolution · compatibility rules · membership procedure → Versioning + Impact Audit + DR + Owner approval proportional to scope; do NOT auto-open the Foundation.
- **C. Non-semantic amendments** — naming · wording · documentation · reference fix · clarification without semantic change → Documentation Consistency Audit only; no Foundation opening or semantic re-ratification.
- No amendment mechanism may be created that contradicts PART A.

### C · Open Questions (status `OPEN` — outside the Ratification Core)

`Type Compatibility` · `Set-as-value` · `finite outcome` · `normalization/conversion/tolerance` · `identity-collapse guard` · `Composition` · `Scope Relations family`. None is decided; none has leaked into the Foundation or the Draft definition. Each is examined in future against the ratified Foundation.

### D · Candidate Status (documentation pointer — recorded, not re-Ledgered)

- **`Ordinal`** — `RATIFIED · Primitive Operator #5 · member of Canonical Relation Evaluation · Ordinal/contract@v1-2026-07-31` (history: W2 ACCEPTED §G; W3 Discovery §H; W3 Owner Decisions COMPLETE — A1 · B1a · B1b-1 · D1 · F1 · F2 · F3 + Contract Locks A2/A3/B1b-1/C1/D4/F4 + Boundary E1; B1b-2 → Platform Governance; ORD-CF1 2026-07-29; W1 2026-07-22). **RATIFIED member** — Owner-ratified 2026-07-31 following W6 Closure Battery CLEAN PASS; operatorId `Ordinal`; §2 contract = §J; C1–C8 PASS; DEFECT-1 / DEFECT-2 CLOSED.
- **`Equality`** — `CLASS ASSIGNED: Canonical Relation Evaluation · W2-ELIGIBLE · CONTRACT NOT STARTED` (EQ-CF1 class-fit PASS 2026-07-29; W1 COMPLETE 2026-07-22). **NOT a ratified member** — not §2/operatorId/Primitive#/C1–C8-complete/Ledger-Member. Class-Fit ≠ Membership Ratification.

Neither is classified as a member of the Candidate Class; both remain independent candidates pending the class-ratification process.

### E · Decision Record — `DR-C1-PARTB-CLASS-01` · `OWNER-RATIFIED · EFFECTIVE` (2026-07-24)

> References: `Candidate Class Foundation` (§A) · `Candidate Class Draft` §1–§15 (§B) · `Open Questions` (§C) · `Candidate Status` (§D) · `Evidence Chain Record` (§F). No reverse reference is added into §B at this stage (F-R7-1 resolved: Relationship-Note + DR-side references; no draft edit).

**Identity.** DR id `DR-C1-PARTB-CLASS-01` · proposed 2026-07-24 · **ratified 2026-07-24** · Status `OWNER-RATIFIED · EFFECTIVE` · Authority `PART-A-replacement@v1 §8` (PA-B governed class-addition) · Ratified class name: `Canonical Relation Evaluation` · Relation: `DR-C1-PARTA-01` (CLOSED) · Candidate Class Foundation §A · CA-R1–CA-R8.

**Problem (taxonomic gap).** `Ordinal` and `Equality` each completed an independent Fresh W1 against ratified `PART-A-replacement@v1` → both `CLASS-UNRESOLVED`. Neither is FRAMING (output = relation-outcome, not a Scope; no Formation) nor REDUCTION-narrow (input = peer values/readouts, not a consumed Scope; readout→outcome stays CLASS-UNRESOLVED per PART A §6). PART A permits class-addition ONLY via PA-B + DR + Owner Ratification. This DR is NOT created "to insert" the two candidates: the gap is a real taxonomic region (peer-value intrinsic relation evaluation) established by a broad principled Class-Boundary Determination Proof, not by the existence of two candidates. Membership remains subject to W1–W9.

**Evidence Timeline (summary; full record in §F).** 18 steps CA/W1 from `Compare monolith REJECTED` → `Ordinal/Equality W1 Fresh` → `PA-B Family-Evidence INCONCLUSIVE` → `Boundary Proof PARTIAL PASS` → `Mechanism Identity M1 REJECTED` → `Class-Kind Commonality INCONCLUSIVE (M3 refuted)` → `Class-Boundary Determination PROVEN` → `CA-R1/Minimization → D1+D6 only` → `CA-R2 + Delta (Contract-Opaque anchor)` → `Owner Ratification of D1/D6/Guard (2026-07-24)` → `CA-R3 Draft` → `CA-R4 Scope Review` → `CA-R5 Correction` → `CA-R5.5 Sync` → `CA-R6 Eligibility (CONTENT ELIGIBLE · PENDING DR)`.

**Alternatives Considered.** (a) Insert candidates into FRAMING — REJECTED (output ≠ Scope; no Formation). (b) Extend REDUCTION to readout→readout — REJECTED within PART A §6. (c) Keep two independent candidates with no class — HELD until Class-Boundary proven (fallback). (d) Single parametric primitive — REJECTED at Mechanism Identity (M1 negative). (e) Broad "all relation-evaluation" class — REJECTED as over-broad umbrella. (f) Narrow class on Output-Category basis — REJECTED (Scope-containment shares the output category yet is excluded by mechanism). (g) Narrow class on D1+D6+ownership — LEADING PATH (adopted as Foundation).

**Decision Proposed (NOT ratified).** Add a new Operator Class whose Transformation Kind is the evaluation of a canonical relation of a qualified relation-domain between peer relata consumed contract-opaquely, emitting a relation-specific canonical typed outcome. No final name in the Decision. It references the Candidate Class Draft §B §1–§15 (not duplicated) and summarizes: Transformation Kind · Purpose · Information Ownership · D1 · D6 · Hidden-Transformation Guard · Output boundary · boundaries vs FRAMING/REDUCTION · Membership process · Non-Retroactivity.

**Explicit Non-Decisions.** Does NOT approve: `Ordinal` · `Equality` · any Primitive · any Operator membership · W2 · §2 · `operatorId` · Primitive number · Type Compatibility · Set-as-value · finite outcome · normalization/conversion/tolerance · identity-collapse guard · Composition · Scope Relations family.

**Backward Compatibility.** No change to `Partition` / `IntervalMembership` / `GapSegmentation` / `Count`; no change to FRAMING/REDUCTION definitions; no re-ratification.

**Risks + Mitigations.** Class as disguised Output-Category → §8 (Scope-containment shares output, excluded by mechanism) + D1(b) contract-opaque + Information Ownership. Over-broad umbrella → D1 peer-role + structure-blind + D6 canonical-domain-fixed; scope/rule/quantity excluded. Candidate-driven taxonomy → founded on Class-Boundary-Proven (broad principled proof); Non-Bias Audit passed; coherent without candidates. Scope-Relation leakage → §8 contract-ownership exclusion; scope-relations = separate future family. Rule/Criterion leakage → D6 (external rule/param OUT) + §8 criterion role. Identity confusion → §8 identity-comparison-as-Purpose OUT; identity-collapse guard deferred (Contract/System). Structural Typing / auto-admission → D1 no structural typing; membership via W1–W9. Using class to skip W1–W9 → §11 membership process; class = taxonomic context only.

**Effective Rule.** This DR became effective upon explicit Owner Ratification (2026-07-24) of BOTH the class `Canonical Relation Evaluation` AND this DR, in a single act. It is now `EFFECTIVE`.

### F · Evidence Chain Record (documentation)

> Concise governance trace — NOT a verbatim transcript of conversations/proofs. Sufficient for a new reviewer to follow how the process moved from `CLASS-UNRESOLVED` to a Class Draft.

| # | Step | Input question | Verdict | Key finding | Gate forward |
|---|---|---|---|---|---|
| 1 | Compare monolith | single "Compare" operator viable? | REJECTED | unites distinct transformation-kinds | split into candidates |
| 2 | Ordinal W1 Fresh | class-fit of order-evaluation? | CLASS-UNRESOLVED·ACTIVE | C1 holds, not a View, boundary resolved | PA-B question |
| 3 | Equality W1 Fresh | class-fit (no Ordinal carry)? | CLASS-UNRESOLVED·ACTIVE | canonical value-equality ≠ identity/semantic; C1 | PA-B question |
| 4 | PA-B Family-Evidence | family vs two independent? | FAMILY EVIDENCE — INCONCLUSIVE | neither confirmed nor refuted | Boundary Proof |
| 5 | Boundary Proof | independent transformation-kind? | PARTIAL PASS | boundary vs FRAMING/REDUCTION established | Mechanism Identity |
| 6 | Mechanism Identity | one mechanism or two? | SAME-OPERATOR REJECTED (M1−) | two distinct atomic mechanisms (arity 3/2; order/equivalence) | Class-Kind Commonality |
| 7 | Class-Kind Commonality | M2 vs M3? | INCONCLUSIVE → M3 REFUTED | real transformation-kind commonality beyond output-category | Boundary Determination |
| 8 | Class-Boundary Determination | narrow non-arbitrary boundary? | CLASS BOUNDARY PROVEN | Peer-Value Intrinsic Relation Evaluation, structure-blind | PA-B foundation |
| 9 | CA-R1 Foundation Audit | ratifiable foundation (non-bias)? | REQUIRES CORRECTION | foundation sound; core independent of open questions | Minimization |
| 10 | Foundation-Minimization | which of 12 are blockers? | ONLY D1 + D6 | 2 micro-proofs collapse into D1; rest contract/impl/settled | CA-R2 |
| 11 | CA-R2 Minimal Foundation | minimal D1/D6 conditions? | CLEAN — pending anchor | peer-role + structure-blind + canonical-domain-fixed source; D1 ⟂ D6 | Delta |
| 12 | CA-R2 Delta | contract-semantic anchor? | CLEAN — READY | Contract-Opaque anchor is implementation-independent | Owner Ratification |
| 13 | Owner Ratification D1/D6/Guard | ratify foundation? | RATIFIED (2026-07-24) | Foundation authority established | Draft |
| 14 | CA-R3 Draft | full class draft? | CLEAN — READY FOR REVIEW | §1–§15 faithful, no leakage | Scope Review |
| 15 | CA-R4 Scope Review | OQ block? over-hardening? | REQUIRES FOCUSED CORRECTION | core complete, no OQ blocks, neutrality holds; §7/§8/§15 issues | CA-R5 |
| 16 | CA-R5 Focused Correction | fix §7/§8/§15? | CLEAN — READY FOR ELIGIBILITY | role/contract-scoped exclusions, neutral output, tiered amendments | Sync |
| 17 | CA-R5.5 Sync | persist foundation+draft? | DESIGN SOURCE SYNCHRONIZED | artifact stable; diff-scope confined; F-SYNC-1 (DR out of Ledger, intended) | Eligibility |
| 18 | CA-R6 Eligibility | eligible to ratify? | CONTENT ELIGIBLE · PENDING DR | content eligible/independent/scoped; §8 DR prerequisite outstanding | CA-R7 (this DR) |

**Methodological Corrections Preserved.** (1) Mechanism identity ≠ Class identity (M1− does not refute M2). (2) Output Category ≠ Class (Scope-containment shares the output category yet is OUT). (3) Input arity ≠ Class (two inputs is not a criterion). (4) representation/traversal ≠ contract-semantic ownership (Contract-Opaque anchor). (5) Open Questions ≠ Foundation blockers (7 OQ, none blocking). (6) Class Addition ≠ Candidate Ratification (`Ordinal`/`Equality` stay `CLASS-UNRESOLVED`).

### G · `Ordinal W2 · Owner Acceptance of Threshold Outcome` — OWNER-ACCEPTED · RECORDED 2026-07-29

> **Purpose & Scope — W2 is NOT Design and NOT Contract.** The sole purpose of W2 is: **Owner Acceptance of the Threshold Outcome established by W1, and authorization to begin contract design.** W2 does NOT re-examine or reopen W1, and does NOT start W3. It only ACCEPTS or REJECTS the W1 threshold outcome; if accepted, it transitions the candidate to `CONTRACT-PENDING`. Nothing more.

**Candidate:** `Ordinal` · **Class:** `Canonical Relation Evaluation` (RATIFIED, PART A §6b, `@v1.1`).

**1 · W1 Outcome Recap** *(evidence only — NOT re-run).* W1 (2026-07-22, fresh vs `@v1`) established: Ordinal is a genuine candidate — candidate-boundary resolved; single atomic purpose (evaluate canonical order → trichotomy); C1 holds (no known legal contract-preserving decomposition; not a §2.9 View); classified as neither FRAMING nor REDUCTION-narrow. W2 does NOT reopen these facts.

**2 · Class-Fit Recap.** ORD-CF1 (2026-07-29, vs `@v1.1` / §6b) **PASS** — Ordinal FITS `Canonical Relation Evaluation`: D1 (peer + contract-opaque) · D6 (canonical domain-fixed) · TK · Information-Ownership · Output-boundary · Hidden-Transformation-Guard · Boundary-Preservation — all PASS; no Open-Question required for fit.

**3 · The single W2 question.** Does the Owner ACCEPT the W1 Threshold Outcome for Ordinal — that its boundary and purpose are sufficiently established to proceed toward a contract — and authorize transition to `CONTRACT-PENDING` (contract design permitted, NOT started)?

**4 · Boundary Lock** *(governs all future W3/§2; unchanged from W1/ORD-CF1 — no expansion).*
- **Purpose:** evaluate the canonical order relation between two peer relata of a domain with a qualified **total order**.
- **Outcome:** canonical three-valued — `LESS` / `EQUAL` / `GREATER`; exactly one per valid input pair (full trichotomy).
- **Relata:** two peer values (contract-opaque); neither a criterion/rule/pattern/schema/container/frame for the other.
- **Relation source:** canonical, domain-fixed total order (D6); not parameter-supplied, not Producer-dependent, not Judgment.
- **Excluded from the candidate:** Equality-as-a-separate-operator · Difference · Ratio · Threshold · Scope ordering · semantic preference/ranking · partial order · fuzzy order · `INCOMPARABLE` · `UNKNOWN` · any unit/domain conversion. Introducing `INCOMPARABLE` / partial-order / preorder-with-ties is a **Candidate-Boundary change requiring return to W1**, NOT a contract detail.

**5 · Deferred to W3+** *(surfaced, NOT decided in W2 — inputs to W3 Design-Axes).* `ascending` vs `descending` (outcome-interpretation/parameter/presentation) · locale-collation · null-ordering · timezone · unit-alignment (relation-domain-contract/precondition candidates) · total-order vs total-preorder `EQUAL`-semantics clarification. None decided here; none blocked acceptance.

**6 · Explicit Non-Decisions.** W2 does NOT: reopen W1 · open W3 · perform Design-Axes · write §2 · run C1–C8 closure · assign `operatorId` · assign a Primitive number · ratify membership · touch Runtime/Composition/Implementation · resolve any Open Question · change the class or PART A · record a Ledger Member entry.

**7 · Status transition** *(on acceptance).* `CLASS ASSIGNED · W2-ELIGIBLE · CONTRACT NOT STARTED` → `CLASS ASSIGNED · CONTRACT-PENDING` (**authorized to enter contract design (W3), which has not yet begun**). `Equality` unaffected (remains `W2-ELIGIBLE`). Ratified members remain `NONE`.

**8 · Verdict.** `THRESHOLD OUTCOME ACCEPTED · CONTRACT-PENDING` (Owner Acceptance 2026-07-29).

**Governance Note.** `CONTRACT-PENDING` explicitly does **NOT**: grant Primitive status · grant Membership · assign an `operatorId` · assign a Primitive Number · approve a §2 contract. It **ONLY** authorizes opening stage **W3** for the purpose of contract design. **"Authorized for contract design" is NOT "ratified as a Primitive"** — the two must never be conflated. Ordinal becomes a ratified member/Primitive only after completing W3–W9 (Design-Axes → §2 → C1–C8 closure → Ratification), each requiring separate Owner approval. **W2 is a governance checkpoint, not a semantic checkpoint. It authorizes the next stage without changing the candidate's semantics, taxonomy, or ratification status.**

### H · `Ordinal W3 · Design Axes Discovery` — RECORDED · DISCOVERY COMPLETE · OWNER DECISIONS NOT STARTED (2026-07-29)

> **Discovery map ONLY.** No axis is decided; no Design Bundle is chosen; no §2 is written. Separate artifact from §G (W2). Ordinal remains `CLASS ASSIGNED · CONTRACT-PENDING`.

**W3 Decision Axes (6 — recorded WITHOUT decision).** For each: what must be decided · legal alternatives remaining (NOT chosen) · ruled out by the Boundary · §2 impact.

- **A1 · Domain-reference representation mechanism.** *Locked semantic requirement:* an invocation must canonically reference a qualified total-order domain with pinned identity + version; *shared constraint on every representation:* **the referenced/embedded descriptor must identify a pre-authorized, version-pinned domain contract; it may not define or alter the ordering relation per invocation.** *Legal alternatives (representation only):* (i) external pinned reference · (ii) inline descriptor with pinned identity (may not create a new relation-domain ad hoc) · (iii) domain via typed provenance + pinned domain-id. *Ruled out:* parameter-supplied/ad-hoc/Producer-variable relation · unversioned/implicit domain · cross-domain. *§2:* inputContract · versioningRule · determinism. **[DECIDED 2026-07-29 → ALT-3 (refined: authority = domain contract; provenance = carrier only); LOCKED — see "W3 Owner Decisions — Locks" below.]**
- **B1 · Outcome semantic representation & canonical serialization.** *Must decide BOTH the semantic value AND its canonical serialization (not an implementation detail).* *Semantic (B1a):* Canonical Relation States `LESS | EQUAL | GREATER`. *Serialization candidates (for B1b-2 only):* named tokens · numeric codes · typed-enum wire form — NOT expressing magnitude. *Ruled out:* ambiguous/non-canonical encoding · magnitude/quantity encoding · more/other than three outcomes (no INCOMPARABLE/UNKNOWN) · preference/Judgment labels. *§2:* outputContract. **[REFINED 2026-07-29: three layers separated — Semantic Relation State ≠ Programming Type ≠ Wire Serialization. B1a (Semantic) LOCKED as Canonical Relation States (see Locks). B1b SPLIT: B1b-1 Serialization Ownership **LOCKED 2026-07-29** (normative contract = Ordinal; operational realization = Platform); B1b-2 concrete representation **REMOVED from the Ordinal W3 Decision Set → transferred to Platform Governance** (operational realization only; normative authority retained by Ordinal); no encoding chosen. **Axis B CLOSED for Ordinal.**]**
- **D1 · Admissibility of domain-defined null/missing values.** *Must decide only WHETHER v1 permits domains whose contract includes null/missing as full total-order members — NOT how they are ordered.* *Legal alternatives:* (i) inadmissible → precondition failure / no Projection · (ii) admissible only when the qualified domain's total order fully orders them (consumed as ordinary domain values). *Ruled out:* Ordinal inventing a null branch / null policy / UNKNOWN outcome / fallback ordering. *§2:* precondition. **[DECIDED 2026-07-29 → ALT-1, refined: admissibility judged ONLY at the invocation boundary via valid domain-membership; Ordinal never classifies values as null/sentinel/placeholder/unset (that is the domain contract's role); Domain Legality is not Ordinal's responsibility; LOCKED — see Locks.]**
- **F1 · Projection identity model.** *Must decide independently (no automatic import of Count's model).* *Legal alternatives:* (1) outcome NOT part of Semantic Projection Identity, held in content-digest · (2) outcome IS part of Semantic Projection Identity · (3) a third model accepted only if fully specified before decision, including its effect on determinism, replay, and deduplication. *Ruled out:* an undefined "other"; silently importing Count Alt-B without independent justification. *§2:* identity/versioning · provenance. **[DECIDED 2026-07-29 → ALT-1, refined: the identity SUBJECT is the comparison operation; the outcome is a deterministic consequence and NOT part of the semantic identity; Observation Identity is the EVIDENCE, not the subject; LOCKED — see Locks.]**
- **F2 · Contract-versioning boundary.** *Must decide whether a new contract version is required for changes in:* outcome meaning · canonical encoding · domain-reference semantics · input admissibility · direction semantics · identity model · failure semantics · preconditions — versus implementation changes not altering observable contract/identity/output/replay (not a contract change). *Legal alternatives:* the classification of each change class above (full §2 wording deferred). *Ruled out:* — (follows PART A unifying versioning). *§2:* versioningRule. **[DECIDED 2026-07-29 → ALT-1, refined: observability tested on **consumer-visible normative guarantees** (not consumer inference, not runtime-detectability); Observable Contract = the set of guarantees, distinct from Observable Consequences; LOCKED — see Locks.]**
- **F3 · Failure handling outside the three-valued outcome.** *Must decide a failure model such that failure is NEVER a fourth Ordinal outcome.* *Legal alternatives:* (1) invalid invocation → no Ordinal Projection, failure exposed via the governing execution/audit mechanism · (2) no Ordinal Projection + a separately-typed rejection record OUTSIDE the Ordinal outcome contract · (3) other only if it adds no outcome and does not mix failure with relation evaluation. *Ruled out:* fabricating an outcome on failure · converting failure to LESS/EQUAL/GREATER · counting failure as a canonical outcome · approximation. *§2:* precondition · determinism. **[DECIDED 2026-07-29 → ALT-2, refined: three layers — No Invocation / Contract Failure / Execution Failure; Ordinal owns ONLY Contract Failures after a valid invocation exists; No Invocation ≠ Contract Failure; LOCKED — see Locks.]**

**Contract Locks / Confirmations (6 — derived from the Boundary; NOT open choices).**
- **A2 · Same qualified domain identity + exact version.** Both relata must reference the same qualified domain identity and the exact same version. No version-compatibility, cross-version comparison, coercion, invocation-time migration, or version-equivalence inference. Compatible-version support = a separate future contract extension.
- **A3 · Source-agnostic minimal semantic relatum.** "A relatum is a value with explicit, replayable membership in the same qualified, version-pinned total-order domain as its peer relatum." The value's technical source is agnostic and not decided here; Producer allow-lists / Projection compatibility are out of scope.
- **B2 · Deterministic encoding & digest closure.** A contract derivation (not an independent semantic axis): the outcome encoding (B1) must be deterministic and hashable, derived from B1 + the identity model (F1); requires explicit closure.
- **C1 · Fixed canonical domain direction; no direction parameter.** LESS/EQUAL/GREATER are evaluated per the qualified domain's canonical order. v1 has no direction parameter and no consumer-selected inversion (W3 confirms; it does not choose a direction).
- **D4 · No conversion/scaling/alignment/normalization by Ordinal.** Contract must state: same domain identity/version; Ordinal performs no conversion, scaling, unit-alignment, or precision-normalization. The decision is the phrasing, not whether to allow conversion.
- **F4 · Exactly two positionally significant relata.** Exactly two relata; input positions are canonical and semantically significant (`Ordinal(a,b)` and `Ordinal(b,a)` produce inverse outcomes when `a ≠ b`); missing or additional relata = invalid invocation. Positional semantics depend on F1 (identity/replay).

**Boundary Constraint (not an open axis).**
- **E1 · Qualified total order only.** Ordinal v1 = a full qualified total order (trichotomy + antisymmetry per the W1/W2 boundary). No total preorder, no ties between distinct values, no INCOMPARABLE, no UNKNOWN. `EQUAL` = the equality result of the qualified total-order relation, not a general equivalence-classes/ties mechanism. Any request for ties/preorder requires return to W1 or a separate candidate. The distinction from Equality-as-a-separate-operator is preserved (Ordinal's EQUAL does not replace Equality).

**Explicitly Outside W3.** Coverage (OQ-39; not resolved here, subject to existing Coverage Governance) · Composition · Producer allow-lists · class-level finite-outcome governance · Scope relations · descending parameter · domain-specific collation / timezone / units / scaling / precision / normalization mechanisms.

**Governance Note.** This Discovery records the decision MAP only. Recording it does NOT decide any axis, does NOT choose a Design Bundle, does NOT complete W3, and does NOT open W4/§2. The next stage — W3 Owner Decisions — is separate and requires explicit Owner approval.

**W3 Owner Decisions — Locks** *(subsequent per-axis Owner Decisions, post-Discovery; one axis per session — Discovery → Alternatives → Owner Decision → Lock → Audit. Locking an axis does NOT choose a Design Bundle, complete W3, or open §2/W4. Ordinal remains `CONTRACT-PENDING`.)*
- **A1 · Qualified Domain Reference — LOCKED 2026-07-29 (ALT-3, refined).**
  > **Lock:** Ordinal v1 identifies its comparison domain through an explicit, replayable qualified-domain identity carried by each relatum. This identity references a pre-authorized, version-pinned domain contract. The relatum does not define, infer or modify that domain; it only carries a reference to it. All comparison semantics remain owned exclusively by the referenced qualified domain contract.
  >
  > *Carrier vs authority:* the domain (and its ordering relation) pre-exists; the relatum's provenance is the CARRIER of the reference, NOT the source of authority. Consistent with A3 (replayable membership), A2 (same identity+version), D6 (relation domain-fixed). No §2 wording, no Composition, no other axis decided here.
- **B1a · Semantic Outcome — LOCKED 2026-07-29.**
  > **Lock:** The semantic outcome of Ordinal v1 is one of exactly three **Canonical Relation States** — `LESS`, `EQUAL`, `GREATER` — that are mutually exclusive, collectively exhaustive, magnitude-free, quantity-free, preference-free, and judgment-free. A Relation State is a state of the order relation, not a numeric value and not a mere label.
  >
  > *Three-layer separation (governs B1b):* **Semantic Relation State** (this lock) ≠ **Programming Type** (e.g. an `enum` — an implementation concern, NEVER part of the semantic contract) ≠ **Wire Serialization** (the canonical external representation). A programming type must never enter the semantic contract; a wire form must never be chosen for programming convenience.
- **B1b · Serialization — SPLIT.**
  - **B1b-1 · Serialization Ownership — LOCKED 2026-07-29 (ALT-3, normative/operational).**
    > **Lock:** Ordinal v1 owns the normative representation contract of its canonical relation states. This contract defines the mandatory invariants that every valid canonical representation must satisfy, including determinism, injectivity over the three canonical relation states, replay stability, and the absence of magnitude semantics. Platform Governance owns only the operational realization of that contract, including concrete external encodings and transport-specific representations. No platform representation may violate or weaken the normative invariants defined by the Ordinal contract.
    >
    > *Normative vs Operational Ownership:* **Normative** = who sets the rules a representation must satisfy (injective · deterministic · replayable · magnitude-free · stable) — these follow from the operator's meaning and are OWNED BY ORDINAL, not the platform. **Operational** = who realizes the representation concretely (JSON · Protobuf · Database · Binary · Queue) — OWNED BY PLATFORM. Ordinal does NOT own JSON or any wire format; Ordinal DOES own every requirement such a wire format must satisfy. The platform may NOT define the canonical semantics and may NOT alter the canonical representation in any way that violates or weakens Ordinal's normative invariants.
  - **B1b-2 · Concrete representation — REMOVED from the Ordinal W3 Decision Set; ownership TRANSFERRED to Platform Governance (2026-07-29).** The concrete Canonical External Encoding (tokens · integer codes · binary codes · wire forms) is operational and is no longer an Ordinal Design decision. **This transfer does not delegate normative authority. Only the operational realization of the already-locked normative representation contract (B1b-1) is transferred.** The normative invariants are NOT reopened; no platform representation may violate or weaken the Ordinal contract. No encoding chosen. **With this transfer, Axis B is CLOSED for Ordinal** (B1a + B1b-1 locked; B1b-2 out of scope).
- **D1 · Input Admissibility — LOCKED 2026-07-29 (ALT-1, refined).**
  > **Lock:** Ordinal v1 determines input admissibility solely at the invocation boundary. Every relatum presented to Ordinal must already be a valid, replayable member of the referenced qualified domain. Ordinal never classifies, interprets or special-cases values such as null, sentinel, placeholder or unset. Such classifications belong exclusively to the qualified domain contract. If a value is a valid member of that domain, Ordinal treats it as an ordinary domain member. Otherwise the invocation is non-admissible. Missing observations and unknown knowledge states are not domain members and therefore never become admissible relata.
  >
  > *Domain Legality vs Invocation Admissibility:* **Domain Legality** (whether a domain is a valid qualified total order, and what values it contains) is NOT Ordinal's responsibility — a domain that presents itself as a qualified total order is the starting point; Ordinal does not judge a domain's contents. **Invocation Admissibility** (are there two valid relata; do both belong to the same qualified domain referenced/locked at A1; is each a valid member of it) is Ordinal's ONLY responsibility. From Ordinal's view there are exactly two categories: **Valid Domain Members** and **Non-admissible Invocation Inputs**; the vocabulary of null/sentinel/unset/placeholder belongs to the domain contract, not to Ordinal. No new outcome; how a non-admissible invocation is handled remains F3 (open).
- **F1 · Projection Identity — LOCKED 2026-07-29 (ALT-1, refined: Subject vs Evidence).**
  > **Lock:** The semantic subject represented by an Ordinal Relation Identity is the comparison operation itself. The comparison outcome is a deterministic consequence of that operation and is therefore not part of the semantic identity. Observation Identity provides the evidentiary basis required to establish Relation Identity, but it is not itself the semantic subject represented by that identity. Accordingly, the Relation Identity remains stable regardless of the canonical representation chosen for the outcome, provided the locked semantic contract is preserved.
  >
  > *Identity Subject vs Identity Evidence:* the **Subject** (what the identity is OF) = the comparison operation. The **Evidence** (the facts used to establish that two identities are the same) = Observation Identity (relata memberships A3, qualified domain A1, operator identity, positional order F4) together with the locked contract constraints. **Subject ≠ Evidence**, and **Observation Identity ≠ Relation Identity**. The outcome is neither the subject nor required as identity evidence (it is a deterministic consequence). This does NOT decide where/how the outcome is recorded for verification (content/digest = B2/downstream), nor Versioning (F2), Runtime, Serialization (B1b/Platform), or Deduplication — all out of scope here.
- **F2 · Contract-Versioning Boundary — LOCKED 2026-07-29 (ALT-1, refined: consumer-visible normative guarantees).**
  > **Lock:** An Ordinal contract change is considered observable if it changes any normative guarantee explicitly provided by the Ordinal contract to its consumers. These guarantees include, but are not limited to, canonical relation-state semantics, admissibility rules, identity boundaries, deterministic behavior, replay guarantees, normative representation invariants, and qualified-domain assumptions. Internal implementation changes that preserve every normative guarantee do not constitute observable contract changes, regardless of implementation, storage, runtime, transport or deployment differences.
  >
  > *Observable Contract vs Observable Consequences:* the **Observable Contract** is the set of normative GUARANTEES the contract makes — they exist even if no invocation has ever run. **Observable Consequences** (outputs, replay, traceability, behavior for specific inputs) are derived FROM the contract but are NOT the contract. The test is on the **consumer-visible normative guarantees**, NOT on consumer inference and NOT on whether every consequence is immediately detectable in runtime. A change to any normative guarantee is always observable → version-worthy; an implementation-only change preserving all guarantees is never an observable contract change. This does NOT set version numbers, schema versions, migration, backward-compatibility, or the derived versioning rules (§2/downstream).
- **F3 · Failure Semantics — LOCKED 2026-07-29 (ALT-2, refined: three failure layers).**
  > **Lock:** The Ordinal contract governs only Contract Failures that occur after an Ordinal invocation has been established. Contract Failures arise solely from violations of the contract's normative preconditions and never from runtime or infrastructure behavior. Execution Failures remain entirely outside the Ordinal contract. Situations in which no Ordinal invocation exists are likewise outside the Ordinal contract and therefore do not constitute Contract Failures.
  >
  > *Three layers — Invocation Existence precedes Contract Validity:* **(1) No Invocation** (invocation never delivered · rejected at an outer layer · authorization absent · dispatcher never selected Ordinal) — OUTSIDE the contract; **No Invocation ≠ Contract Failure**. **(2) Contract Failure** — a normative precondition (D1 admissibility · A1/A2 domain identity/version · F4 exactly-two-relata · E1 total order · other locked preconditions) is violated after a valid invocation exists → no valid Ordinal Projection (a contract truth, not a reporting decision). **(3) Execution Failure** (runtime crash · I/O · timeout · resource exhaustion · infrastructure) — the contract was valid but the system could not execute it — OUTSIDE the contract. **Only layer (2) belongs to Ordinal.** Failure is never a fourth outcome. The contract names layers (1) and (3) as outside/delegated; it does NOT own error codes, exception types, retry/recovery policies, runtime behavior, API status codes, or logging/monitoring/diagnostics — all downstream.
  >
  > *(With F3 locked, all six W3 Decision Axes — A1 · B1 · D1 · F1 · F2 · F3 — are locked; the Contract Locks A2/A3/B1b-1/C1/D4/F4 and Boundary Constraint E1 stand. Next stage: Design Bundle assembly. No Bundle chosen yet; no §2.)*

### I · Ordinal v1 Design Bundle — DERIVED FROM §H (verbatim) · no §2 · Ordinal `CONTRACT-PENDING`

#### 1 · Purpose
This Design Bundle collects, **verbatim**, the ratified W3 outputs for Ordinal v1 — the Decision-Axis Locks, the Contract Locks, and the Boundary Constraint — into one coherent artifact. It **adds, removes, interprets, resolves, refines, and rewords nothing**. Every clause below is a verbatim copy of its source in §H; the Source Mapping (§8, final) proves one-to-one provenance. **This Bundle is Evidence, not Design**: it makes no new decision and creates no new normative wording.

#### 2 · Included Decision Locks *(verbatim from §H "W3 Owner Decisions — Locks")*
- **A1 · Qualified Domain Reference — LOCKED 2026-07-29 (ALT-3, refined).**
  > **Lock:** Ordinal v1 identifies its comparison domain through an explicit, replayable qualified-domain identity carried by each relatum. This identity references a pre-authorized, version-pinned domain contract. The relatum does not define, infer or modify that domain; it only carries a reference to it. All comparison semantics remain owned exclusively by the referenced qualified domain contract.
  >
  > *Carrier vs authority:* the domain (and its ordering relation) pre-exists; the relatum's provenance is the CARRIER of the reference, NOT the source of authority. Consistent with A3 (replayable membership), A2 (same identity+version), D6 (relation domain-fixed). No §2 wording, no Composition, no other axis decided here.
- **B1a · Semantic Outcome — LOCKED 2026-07-29.**
  > **Lock:** The semantic outcome of Ordinal v1 is one of exactly three **Canonical Relation States** — `LESS`, `EQUAL`, `GREATER` — that are mutually exclusive, collectively exhaustive, magnitude-free, quantity-free, preference-free, and judgment-free. A Relation State is a state of the order relation, not a numeric value and not a mere label.
  >
  > *Three-layer separation (governs B1b):* **Semantic Relation State** (this lock) ≠ **Programming Type** (e.g. an `enum` — an implementation concern, NEVER part of the semantic contract) ≠ **Wire Serialization** (the canonical external representation). A programming type must never enter the semantic contract; a wire form must never be chosen for programming convenience.
- **B1b-1 · Serialization Ownership — LOCKED 2026-07-29 (ALT-3, normative/operational).**
  > **Lock:** Ordinal v1 owns the normative representation contract of its canonical relation states. This contract defines the mandatory invariants that every valid canonical representation must satisfy, including determinism, injectivity over the three canonical relation states, replay stability, and the absence of magnitude semantics. Platform Governance owns only the operational realization of that contract, including concrete external encodings and transport-specific representations. No platform representation may violate or weaken the normative invariants defined by the Ordinal contract.
  >
  > *Normative vs Operational Ownership:* **Normative** = who sets the rules a representation must satisfy (injective · deterministic · replayable · magnitude-free · stable) — these follow from the operator's meaning and are OWNED BY ORDINAL, not the platform. **Operational** = who realizes the representation concretely (JSON · Protobuf · Database · Binary · Queue) — OWNED BY PLATFORM. Ordinal does NOT own JSON or any wire format; Ordinal DOES own every requirement such a wire format must satisfy. The platform may NOT define the canonical semantics and may NOT alter the canonical representation in any way that violates or weakens Ordinal's normative invariants.
- **D1 · Input Admissibility — LOCKED 2026-07-29 (ALT-1, refined).**
  > **Lock:** Ordinal v1 determines input admissibility solely at the invocation boundary. Every relatum presented to Ordinal must already be a valid, replayable member of the referenced qualified domain. Ordinal never classifies, interprets or special-cases values such as null, sentinel, placeholder or unset. Such classifications belong exclusively to the qualified domain contract. If a value is a valid member of that domain, Ordinal treats it as an ordinary domain member. Otherwise the invocation is non-admissible. Missing observations and unknown knowledge states are not domain members and therefore never become admissible relata.
  >
  > *Domain Legality vs Invocation Admissibility:* **Domain Legality** (whether a domain is a valid qualified total order, and what values it contains) is NOT Ordinal's responsibility — a domain that presents itself as a qualified total order is the starting point; Ordinal does not judge a domain's contents. **Invocation Admissibility** (are there two valid relata; do both belong to the same qualified domain referenced/locked at A1; is each a valid member of it) is Ordinal's ONLY responsibility. From Ordinal's view there are exactly two categories: **Valid Domain Members** and **Non-admissible Invocation Inputs**; the vocabulary of null/sentinel/unset/placeholder belongs to the domain contract, not to Ordinal. No new outcome; how a non-admissible invocation is handled remains F3 (open).
- **F1 · Projection Identity — LOCKED 2026-07-29 (ALT-1, refined: Subject vs Evidence).**
  > **Lock:** The semantic subject represented by an Ordinal Relation Identity is the comparison operation itself. The comparison outcome is a deterministic consequence of that operation and is therefore not part of the semantic identity. Observation Identity provides the evidentiary basis required to establish Relation Identity, but it is not itself the semantic subject represented by that identity. Accordingly, the Relation Identity remains stable regardless of the canonical representation chosen for the outcome, provided the locked semantic contract is preserved.
  >
  > *Identity Subject vs Identity Evidence:* the **Subject** (what the identity is OF) = the comparison operation. The **Evidence** (the facts used to establish that two identities are the same) = Observation Identity (relata memberships A3, qualified domain A1, operator identity, positional order F4) together with the locked contract constraints. **Subject ≠ Evidence**, and **Observation Identity ≠ Relation Identity**. The outcome is neither the subject nor required as identity evidence (it is a deterministic consequence). This does NOT decide where/how the outcome is recorded for verification (content/digest = B2/downstream), nor Versioning (F2), Runtime, Serialization (B1b/Platform), or Deduplication — all out of scope here.
- **F2 · Contract-Versioning Boundary — LOCKED 2026-07-29 (ALT-1, refined: consumer-visible normative guarantees).**
  > **Lock:** An Ordinal contract change is considered observable if it changes any normative guarantee explicitly provided by the Ordinal contract to its consumers. These guarantees include, but are not limited to, canonical relation-state semantics, admissibility rules, identity boundaries, deterministic behavior, replay guarantees, normative representation invariants, and qualified-domain assumptions. Internal implementation changes that preserve every normative guarantee do not constitute observable contract changes, regardless of implementation, storage, runtime, transport or deployment differences.
  >
  > *Observable Contract vs Observable Consequences:* the **Observable Contract** is the set of normative GUARANTEES the contract makes — they exist even if no invocation has ever run. **Observable Consequences** (outputs, replay, traceability, behavior for specific inputs) are derived FROM the contract but are NOT the contract. The test is on the **consumer-visible normative guarantees**, NOT on consumer inference and NOT on whether every consequence is immediately detectable in runtime. A change to any normative guarantee is always observable → version-worthy; an implementation-only change preserving all guarantees is never an observable contract change. This does NOT set version numbers, schema versions, migration, backward-compatibility, or the derived versioning rules (§2/downstream).
- **F3 · Failure Semantics — LOCKED 2026-07-29 (ALT-2, refined: three failure layers).**
  > **Lock:** The Ordinal contract governs only Contract Failures that occur after an Ordinal invocation has been established. Contract Failures arise solely from violations of the contract's normative preconditions and never from runtime or infrastructure behavior. Execution Failures remain entirely outside the Ordinal contract. Situations in which no Ordinal invocation exists are likewise outside the Ordinal contract and therefore do not constitute Contract Failures.
  >
  > *Three layers — Invocation Existence precedes Contract Validity:* **(1) No Invocation** (invocation never delivered · rejected at an outer layer · authorization absent · dispatcher never selected Ordinal) — OUTSIDE the contract; **No Invocation ≠ Contract Failure**. **(2) Contract Failure** — a normative precondition (D1 admissibility · A1/A2 domain identity/version · F4 exactly-two-relata · E1 total order · other locked preconditions) is violated after a valid invocation exists → no valid Ordinal Projection (a contract truth, not a reporting decision). **(3) Execution Failure** (runtime crash · I/O · timeout · resource exhaustion · infrastructure) — the contract was valid but the system could not execute it — OUTSIDE the contract. **Only layer (2) belongs to Ordinal.** Failure is never a fourth outcome. The contract names layers (1) and (3) as outside/delegated; it does NOT own error codes, exception types, retry/recovery policies, runtime behavior, API status codes, or logging/monitoring/diagnostics — all downstream.

#### 3 · Contract Locks *(verbatim from §H "Contract Locks / Confirmations")*
- **A2 · Same qualified domain identity + exact version.** Both relata must reference the same qualified domain identity and the exact same version. No version-compatibility, cross-version comparison, coercion, invocation-time migration, or version-equivalence inference. Compatible-version support = a separate future contract extension.
- **A3 · Source-agnostic minimal semantic relatum.** "A relatum is a value with explicit, replayable membership in the same qualified, version-pinned total-order domain as its peer relatum." The value's technical source is agnostic and not decided here; Producer allow-lists / Projection compatibility are out of scope.
- **B2 · Deterministic encoding & digest closure.** A contract derivation (not an independent semantic axis): the outcome encoding (B1) must be deterministic and hashable, derived from B1 + the identity model (F1); requires explicit closure.
- **C1 · Fixed canonical domain direction; no direction parameter.** LESS/EQUAL/GREATER are evaluated per the qualified domain's canonical order. v1 has no direction parameter and no consumer-selected inversion (W3 confirms; it does not choose a direction).
- **D4 · No conversion/scaling/alignment/normalization by Ordinal.** Contract must state: same domain identity/version; Ordinal performs no conversion, scaling, unit-alignment, or precision-normalization. The decision is the phrasing, not whether to allow conversion.
- **F4 · Exactly two positionally significant relata.** Exactly two relata; input positions are canonical and semantically significant (`Ordinal(a,b)` and `Ordinal(b,a)` produce inverse outcomes when `a ≠ b`); missing or additional relata = invalid invocation. Positional semantics depend on F1 (identity/replay).

#### 4 · Boundary Constraints *(verbatim from §H)*
- **E1 · Qualified total order only.** Ordinal v1 = a full qualified total order (trichotomy + antisymmetry per the W1/W2 boundary). No total preorder, no ties between distinct values, no INCOMPARABLE, no UNKNOWN. `EQUAL` = the equality result of the qualified total-order relation, not a general equivalence-classes/ties mechanism. Any request for ties/preorder requires return to W1 or a separate candidate. The distinction from Equality-as-a-separate-operator is preserved (Ordinal's EQUAL does not replace Equality).

#### 4b · Inherited Membership Projections
*Registrations of inherited membership requirements projected from an external ratified authority into §J. §I holds registration metadata only — it does not hold the projected text and is not an authority.*

**IMP-1 · C4 Determinism & Statelessness**
- **Registration ID:** IMP-1
- **Authority / HOME:** C4 §2.5
- **Canonical Rendering:** CPT-1
- **Projection Target:** §J field 8 (determinism)
- **Projection Mode:** verbatim (CPT-1 → §J)
- **Status:** inherited membership registration; not a W3 lock, local contract lock, authority, decision, or norm created in §I.

#### 5 · Deferred Topics *(verbatim; items from §H "Explicitly Outside W3" + the B1b-2 transfer entry; the Deferred/Out-of-Scope split follows the approved skeleton, item text unchanged)*
- **B1b-2 · Concrete representation — REMOVED from the Ordinal W3 Decision Set; ownership TRANSFERRED to Platform Governance (2026-07-29).** The concrete Canonical External Encoding (tokens · integer codes · binary codes · wire forms) is operational and is no longer an Ordinal Design decision. **This transfer does not delegate normative authority. Only the operational realization of the already-locked normative representation contract (B1b-1) is transferred.** The normative invariants are NOT reopened; no platform representation may violate or weaken the Ordinal contract. No encoding chosen. **With this transfer, Axis B is CLOSED for Ordinal** (B1a + B1b-1 locked; B1b-2 out of scope).
- descending parameter
- domain-specific collation / timezone / units / scaling / precision / normalization mechanisms

#### 6 · Out-of-Scope Topics *(verbatim; items from §H "Explicitly Outside W3")*
- Coverage (OQ-39; not resolved here, subject to existing Coverage Governance)
- Composition
- Producer allow-lists
- class-level finite-outcome governance
- Scope relations

#### 7 · Acceptance Checklist *(to be verified by the Bundle Audit)*
- [ ] No new decision.
- [ ] No new normative wording.
- [ ] No resolution of conflicts.
- [ ] No further refinement.
- [ ] No meaning-changing consolidation.
- [ ] No editorial rewording of normative text.
- [ ] No Lock missing.
- [ ] No Lock duplicated.
- [ ] No Lock truncated.
- [ ] No Lock merged with another Lock.
- [ ] No Lock changed even semantically by one word.
- [ ] Every Decision Lock (A1 · B1a · B1b-1 · D1 · F1 · F2 · F3) appears exactly once, verbatim.
- [ ] Every Contract Lock (A2 · A3 · B2 · C1 · D4 · F4) appears exactly once, verbatim.
- [ ] Every Boundary Constraint (E1) appears exactly once, verbatim.
- [ ] Every Deferred Topic appears once, unchanged.
- [ ] Every Out-of-Scope Topic appears once, unchanged.
- [ ] Every Source Mapping entry is one-to-one.
- [ ] Every inherited membership projection is registered exactly once with its Authority HOME, CPT ID, target, and mode; projected contract text must match the CPT referenced by that registration verbatim.

#### 8 · Source Mapping *(one-to-one provenance)*
| Bundle item | Source (§H) | Category | Lock date | Once |
|---|---|---|---|---|
| A1 | §H Locks · A1 | Decision Lock | 2026-07-29 | ✓ |
| B1a | §H Locks · B1a | Decision Lock | 2026-07-29 | ✓ |
| B1b-1 | §H Locks · B1b-1 | Decision Lock | 2026-07-29 | ✓ |
| D1 | §H Locks · D1 | Decision Lock | 2026-07-29 | ✓ |
| F1 | §H Locks · F1 | Decision Lock | 2026-07-29 | ✓ |
| F2 | §H Locks · F2 | Decision Lock | 2026-07-29 | ✓ |
| F3 | §H Locks · F3 | Decision Lock | 2026-07-29 | ✓ |
| A2 | §H Contract Locks · A2 | Contract Lock | (discovery) | ✓ |
| A3 | §H Contract Locks · A3 | Contract Lock | (discovery) | ✓ |
| B2 | §H Contract Locks · B2 | Contract Lock | (discovery) | ✓ |
| C1 | §H Contract Locks · C1 | Contract Lock | (discovery) | ✓ |
| D4 | §H Contract Locks · D4 | Contract Lock | (discovery) | ✓ |
| F4 | §H Contract Locks · F4 | Contract Lock | (discovery) | ✓ |
| E1 | §H Boundary Constraint · E1 | Boundary Constraint | (discovery) | ✓ |
| B1b-2 | §H Locks · B1b-2 transfer | Deferred (transferred) | 2026-07-29 | ✓ |
| descending parameter | §H "Explicitly Outside W3" | Deferred | (discovery) | ✓ |
| collation/timezone/units/scaling/precision/normalization | §H "Explicitly Outside W3" | Deferred | (discovery) | ✓ |
| Coverage (OQ-39) | §H "Explicitly Outside W3" | Out-of-Scope | (discovery) | ✓ |
| Composition | §H "Explicitly Outside W3" | Out-of-Scope | (discovery) | ✓ |
| Producer allow-lists | §H "Explicitly Outside W3" | Out-of-Scope | (discovery) | ✓ |
| class-level finite-outcome governance | §H "Explicitly Outside W3" | Out-of-Scope | (discovery) | ✓ |
| Scope relations | §H "Explicitly Outside W3" | Out-of-Scope | (discovery) | ✓ |
| IMP-1 | CPT-1 (Authority / HOME: C4 §2.5) | Inherited Membership Projection | 2026-07-31 | ✓ |

### J · Ordinal — §2 Contract · **RATIFIED — Primitive Operator #5 — Canonical Relation Evaluation** · `Ordinal/contract@v1-2026-07-31` (Owner-ratified 2026-07-31, following W6 Closure Battery CLEAN PASS)

> **Governance.** Structure = the Ratified §2 Template (11 fields). Content = the §I Bundle ONLY (verbatim). **HOME = the single normative-authority site where a commitment is defined; a Reference is navigational only — it may point to a HOME but may not summarize, interpret, add context, refine or explain.** Contract Metadata (§1–§2) is NOT Projection, NOT a Lock, NOT normative content, and is excluded from the Projection Audit. No new decision, refinement, invariant, boundary, or Open-Question resolution is introduced here.

**Contract Metadata (not Projection; excluded from Projection Audit)**
1. `operatorId` — **`Ordinal`** (assigned at Closure, 2026-07-31). Stable normative identity; PascalCase per the existing scheme; contains no version (version lives in the Contract ID).
2. `class` — **RATIFIED METADATA.** `Canonical Relation Evaluation` (PART A §6b, ratified `@v1.1`).

**Contract Content (Projection of §I — verbatim)**

3. `purpose` — **[Reference-only · navigational]** → `E1` (§5 HOME) · `B1a` (§5 HOME) · `A3` and `F4` (§4 HOME). The purpose is defined by those HOMEs; no normative wording is stated here.

4. `inputContract` — **HOME of A1 · A2 · A3 · F4 · D1 · D4:**
   - **A1:** Ordinal v1 identifies its comparison domain through an explicit, replayable qualified-domain identity carried by each relatum. This identity references a pre-authorized, version-pinned domain contract. The relatum does not define, infer or modify that domain; it only carries a reference to it. All comparison semantics remain owned exclusively by the referenced qualified domain contract.
   - **A2:** Both relata must reference the same qualified domain identity and the exact same version. No version-compatibility, cross-version comparison, coercion, invocation-time migration, or version-equivalence inference. Compatible-version support = a separate future contract extension.
   - **A3:** "A relatum is a value with explicit, replayable membership in the same qualified, version-pinned total-order domain as its peer relatum." The value's technical source is agnostic and not decided here; Producer allow-lists / Projection compatibility are out of scope.
   - **F4:** Exactly two relata; input positions are canonical and semantically significant (`Ordinal(a,b)` and `Ordinal(b,a)` produce inverse outcomes when `a ≠ b`); missing or additional relata = invalid invocation. Positional semantics depend on F1 (identity/replay).
   - **D1:** Ordinal v1 determines input admissibility solely at the invocation boundary. Every relatum presented to Ordinal must already be a valid, replayable member of the referenced qualified domain. Ordinal never classifies, interprets or special-cases values such as null, sentinel, placeholder or unset. Such classifications belong exclusively to the qualified domain contract. If a value is a valid member of that domain, Ordinal treats it as an ordinary domain member. Otherwise the invocation is non-admissible. Missing observations and unknown knowledge states are not domain members and therefore never become admissible relata.
   - **D4:** Contract must state: same domain identity/version; Ordinal performs no conversion, scaling, unit-alignment, or precision-normalization. The decision is the phrasing, not whether to allow conversion.

5. `outputContract` — **HOME of B1a · C1 · B1b-1 · E1:**
   - **B1a:** The semantic outcome of Ordinal v1 is one of exactly three **Canonical Relation States** — `LESS`, `EQUAL`, `GREATER` — that are mutually exclusive, collectively exhaustive, magnitude-free, quantity-free, preference-free, and judgment-free. A Relation State is a state of the order relation, not a numeric value and not a mere label.
   - **C1:** LESS/EQUAL/GREATER are evaluated per the qualified domain's canonical order. v1 has no direction parameter and no consumer-selected inversion (W3 confirms; it does not choose a direction).
   - **B1b-1:** Ordinal v1 owns the normative representation contract of its canonical relation states. This contract defines the mandatory invariants that every valid canonical representation must satisfy, including determinism, injectivity over the three canonical relation states, replay stability, and the absence of magnitude semantics. Platform Governance owns only the operational realization of that contract, including concrete external encodings and transport-specific representations. No platform representation may violate or weaken the normative invariants defined by the Ordinal contract.
   - **E1:** Ordinal v1 = a full qualified total order (trichotomy + antisymmetry per the W1/W2 boundary). No total preorder, no ties between distinct values, no INCOMPARABLE, no UNKNOWN. `EQUAL` = the equality result of the qualified total-order relation, not a general equivalence-classes/ties mechanism. Any request for ties/preorder requires return to W1 or a separate candidate. The distinction from Equality-as-a-separate-operator is preserved (Ordinal's EQUAL does not replace Equality).

6. `parameters` — **[Reference-only · navigational]** → `C1` (§5 HOME) governs the sole parameter-relevant commitment (direction). No Bundle lock defines a parameter for v1.

7. `coverageDeclaration` — **HOME (Coverage item, §I §6):** Coverage (OQ-39; not resolved here, subject to existing Coverage Governance).

8. `determinism` — **HOME of B2 · F1 · F3 (Bundle); includes inherited membership projection registered by IMP-1 from CPT-1, whose Authority/HOME is C4 §2.5:**
   - **B2:** A contract derivation (not an independent semantic axis): the outcome encoding (B1) must be deterministic and hashable, derived from B1 + the identity model (F1); requires explicit closure.
   - **F1:** The semantic subject represented by an Ordinal Relation Identity is the comparison operation itself. The comparison outcome is a deterministic consequence of that operation and is therefore not part of the semantic identity. Observation Identity provides the evidentiary basis required to establish Relation Identity, but it is not itself the semantic subject represented by that identity. Accordingly, the Relation Identity remains stable regardless of the canonical representation chosen for the outcome, provided the locked semantic contract is preserved.
   - **F3:** The Ordinal contract governs only Contract Failures that occur after an Ordinal invocation has been established. Contract Failures arise solely from violations of the contract's normative preconditions and never from runtime or infrastructure behavior. Execution Failures remain entirely outside the Ordinal contract. Situations in which no Ordinal invocation exists are likewise outside the Ordinal contract and therefore do not constitute Contract Failures.
   - **IMP-1 · CPT-1 — inherited membership projection**
     Per C4 (§2.5): Determinism & statelessness — pure function; no state / schedule / inference / side effects.

9. `compositionRules` — **HOME (Composition item, §I §6):** Composition.

10. `versioningRule` — **HOME of F2:** An Ordinal contract change is considered observable if it changes any normative guarantee explicitly provided by the Ordinal contract to its consumers. These guarantees include, but are not limited to, canonical relation-state semantics, admissibility rules, identity boundaries, deterministic behavior, replay guarantees, normative representation invariants, and qualified-domain assumptions. Internal implementation changes that preserve every normative guarantee do not constitute observable contract changes, regardless of implementation, storage, runtime, transport or deployment differences.

11. `openQuestions` — **HOME of the remaining Deferred (§I §5) + Out-of-Scope (§I §6) items:**
    - *Deferred:* B1b-2 — Concrete representation transferred to Platform Governance (operational realization only; normative authority retained by Ordinal) · descending parameter · domain-specific collation / timezone / units / scaling / precision / normalization mechanisms.
    - *Out-of-Scope:* Producer allow-lists · class-level finite-outcome governance · Scope relations.

#### §2 Source Mapping (bidirectional; Metadata excluded)
| Field | HOME (authority) | References (navigational) |
|---|---|---|
| §3 purpose | — | → B1a·E1 (§5) · A3·F4 (§4) |
| §4 inputContract | A1 · A2 · A3 · F4 · D1 · D4 | — |
| §5 outputContract | B1a · C1 · B1b-1 · E1 | — |
| §6 parameters | — | → C1 (§5) |
| §7 coverageDeclaration | Coverage (§I §6) | — |
| §8 determinism | B2 · F1 · F3 (Bundle); IMP-1 registering CPT-1 (Authority/HOME: C4 §2.5) | — |
| §9 compositionRules | Composition (§I §6) | — |
| §10 versioningRule | F2 | — |
| §11 openQuestions | B1b-2 · descending · collation/timezone/units/scaling/precision/normalization · Producer-allow-lists · class-level finite-outcome · Scope-relations | — |

| Bundle Lock/Item | single HOME | Referenced-by |
|---|---|---|
| A1 · A2 · A3 · F4 · D1 · D4 | §4 | (A3/F4/E1 also referenced by §3) |
| B1a · C1 · B1b-1 · E1 | §5 | B1a/E1 by §3 · C1 by §6 |
| Coverage | §7 | — |
| B2 · F1 · F3 | §8 | — |
| IMP-1 · CPT-1 (Authority/HOME: C4 §2.5) | §8 | — |
| Composition | §9 | — |
| F2 | §10 | — |
| B1b-2 · descending · collation/tz/units/scaling/precision/norm · Producer-allow-lists · finite-outcome · Scope-relations | §11 | — |

### K · Equality W2 · Owner Acceptance of W1 Threshold Outcome — OWNER-ACCEPTED · RECORDED 2026-08-06

**1 · Purpose & Scope.** W2 is NOT Design and NOT Contract. The sole purpose of W2 is Owner Acceptance of the Threshold Outcome established by W1, and authorization to begin contract design through W3. W2 does NOT reopen W1 and does NOT itself execute or record W3. It only ACCEPTS or REJECTS the W1 threshold outcome; on acceptance it transitions the candidate to CONTRACT-PENDING. Nothing more.

**2 · Candidate & Class.** Candidate: `Equality`. Class: `Canonical Relation Evaluation` (RATIFIED, PART A §6b, @v1.1).

**3 · W1 Evidence Recap (evidence only — NOT re-run).** W1 (2026-07-22, fresh vs @v1, no Ordinal conclusions carried): candidate boundary resolved — Equality concerns canonical value-equality, not identity-equality and not semantic-equivalence; no known legal decomposition; not a §2.9 View; C1 holds; C2 was CLASS-UNRESOLVED at W1.

**4 · EQ-CF1 Class-Fit Recap.** EQ-CF1 (2026-07-29, vs @v1.1 / §6b, examined independently of Ordinal) PASS — Equality FITS Canonical Relation Evaluation: D1 · D6 · TK · Information-Ownership · Output-boundary · Hidden-Transformation-Guard · value-vs-identity · value-vs-semantic · Boundary-Preservation — all PASS; no Open Question required. Class fit accepted.

**5 · W2 Owner Acceptance — Question & Answer.** Question: Does the Owner ACCEPT the W1 Threshold Outcome for Equality and authorize transition to CONTRACT-PENDING, permitting entry into W3 contract design without starting or approving a contract? Answer: ACCEPTED (Owner, 2026-08-06).

**6 · W1 Candidate Boundary Preserved (no expansion beyond W1).**

- Canonical value-equality.
- Not identity-equality.
- Not semantic-equivalence.
- No expansion beyond the W1 candidate boundary.

**7 · Deferred to W3 (surfaced at W1, NOT decided here).** normalization-visibility · authorized-equivalence-domains · null-equality. None was decided by W2; none blocked acceptance.

**8 · Explicit Non-Decisions.** §K does NOT: assign an operatorId · assign a Primitive number · assign a Contract ID · write or approve a §2 contract · ratify CRE membership · define Outcome vocabulary · define a Domain contract · define a Failure model · define Operation identity · define a Versioning model · register a Determinism projection · itself execute, decide, or record W3 Design-Axes · resolve any Open Question · change the class or PART A.

**9 · Status Transition.** `CLASS ASSIGNED · W2-ELIGIBLE · CONTRACT NOT STARTED` → `CLASS ASSIGNED · CONTRACT-PENDING`. W2 authorized entry into W3 design. Subsequent W3 design decisions are outside the scope of §K and are not materialized by this record. Ordinal is unaffected. Equality remains a candidate, not a ratified member. CONTRACT-PENDING means that design work may proceed toward a contract; no contract yet exists.

**10 · Verdict.** THRESHOLD OUTCOME ACCEPTED · CONTRACT-PENDING (Owner Acceptance 2026-08-06).

**11 · Governance Note.** CONTRACT-PENDING does NOT grant Primitive status, Membership, operatorId, Primitive number, Contract ID, or §2 approval. It records only the W2 authorization to proceed into contract design. "Authorized for contract design" is not "ratified as a Primitive." Equality may become a ratified member or allocated Primitive only through the applicable downstream contract, closure, and ratification stages, each requiring its own governance approval. W2 is a governance checkpoint, not a semantic contract or ratification event.

**12 · Source Mapping.**

| §K clause | Source | Category |
|---|---|---|
| §2 Candidate & Class | PA-B §B + PART A §6b; Equality Ledger row (§4) | evidence (corpus) |
| §3 W1 Evidence Recap | Equality Ledger row (§4), W1 2026-07-22 | evidence (corpus) |
| §4 EQ-CF1 | Equality Ledger row (§4) + §D candidate status, EQ-CF1 2026-07-29 | evidence (corpus) |
| §6 Boundary Preserved | Equality Ledger row (§4): value-equality; ≠ identity-equality; ≠ semantic-equivalence | evidence (corpus) |
| §7 Deferred to W3 | Equality Ledger row (§4): normalization-visibility · authorized-equivalence-domains · null-equality | evidence (corpus) |
| §1 / §5-Q / §8 / §9 / §11 wording | Ordinal §G — STRUCTURAL PRECEDENT ONLY (no semantic reuse) | template |
| §5 Answer · §10 Verdict · date 2026-08-06 | Owner decision recorded now | decision |
| W3 status | W3 design Record is not included in §K | scope note |

### L · Equality W3 · Owner-Approved Design-Axes Record — RECORDED 2026-08-06 · CONTRACT-PENDING

**Scope.** This section records the owner-approved conceptual design-axis locks reached in Equality W3. It records prior decisions; it introduces no new design, no §I Design Bundle, no §2 contract, no registration, no allocation, and no ratification. Equality remains a candidate at `CONTRACT-PENDING`. Ordinal §H is a structural precedent only.

**— Phase A —**

**EA1 · Relation Semantics — LOCKED.** Equality concerns identity of an authorized domain-qualified abstract value. Value is not Representation. Different representations may denote the same abstract value, and representation identity alone does not define value identity. Canonical form may serve as a witness but is neither universally required nor defined by Equality. *Excludes:* representation identity · object/record identity · similarity · approximation · semantic relatedness · business equivalence. *Deferred:* domain binding (EA3) · admissibility (EB3) · canonicalization ownership (EB4).

**EA2 · Criterion Ownership & Boundary — LOCKED.** The equality criterion is supplied by the authorized Domain. Equality does not invent, infer, broaden, or relax that criterion. Any transformation or rule used in evaluation must remain within the boundary of "same authorized abstract value"; similarity, tolerance, approximation, semantic relatedness, or business substitutability do not become Equality merely because a Domain mechanism can compute them. Two guards apply: **(1) Governance guard** — any such rule must be explicit, authorized, version-bound, and replayable; **(2) Relation-boundary guard** — the resulting relation must still mean identity of the same abstract value and must not become Similarity or Approximation. *Excludes:* operator-invented/broadened/relaxed criteria · similarity/tolerance/approximation/business-substitutability as Equality. *Deferred:* exact Domain binding (EA3) · admissibility (EB3) · canonicalization ownership (EB4) · version ownership (ED4).

**EA3 · Domain Binding — LOCKED.** Each Equality operation is bound to one explicit Domain ID and one explicit Domain Version. There is no Domain inference and no Version inference; no cross-domain evaluation and no cross-version evaluation; no hidden compatibility mode and no hidden migration. Replay preserves the same binding. Any value-identity-affecting transformation is explicit, Domain-owned, version-bound, deterministic, replayable, and non-hidden. *Excludes:* inferred/implicit domain or version · cross-domain/version · hidden compatibility/migration. *Deferred:* operation identity (ED1) · membership (EB3) · concrete resolution mechanism.

**— Phase B —**

**EB1 · Arity & Peer Relata — LOCKED.** Equality takes exactly two relata; the two relata are peers with no subject/object hierarchy. Swapping the two admissible relata preserves the Outcome (Outcome symmetry); this symmetry does not establish that the two orderings are the same Operation. A structured value is permitted as a relatum when the Domain defines it as one value. No generic collection equality is created by EB1. *Excludes:* subject/object hierarchy · n-ary/variadic · operator-created collection equality · inferring operation identity from Outcome symmetry. *Deferred:* same-domain/kind (EB2) · admissibility (EB3) · operation identity (ED1).

**EB2 · Same Domain & Version — LOCKED.** Both relata must be admissible under the exact single bound Domain ID and Domain Version (the same authorized abstract-value space). Same runtime representation or type is not required if the Domain admits them. A mismatch is a Failure, never `NOT_EQUAL`. *Excludes:* cross-domain/version evaluation · compatibility-as-identity · operator-owned conversion/coercion. *Deferred:* admissibility proof (EB3) · canonicalization (EB4) · failure taxonomy (EE1).

**EB3 · Relatum Admissibility & Membership — LOCKED.** Admissibility is an upstream precondition; Equality consumes the guarantee and does not itself establish Domain membership. A missing relatum or a broken invocation envelope may be detected structurally; such an envelope guard is not membership validation. Null and Sentinel are not universally inadmissible; they are admissible only when the bound Domain defines them as values. A type may carry evidence of membership but does not define admissibility or Equality. An unresolved reference may itself be a Domain value if the Domain defines it as such. Inadmissibility never becomes `NOT_EQUAL`. *Excludes:* operator membership inference · type as definition of admissibility/Equality · inadmissibility→`NOT_EQUAL`. *Deferred:* proof mechanism · parsing/validation/normalization HOME (EB4/architecture) · detection mechanics (EE2).

**EB4 · Normalization / Canonicalization Ownership — LOCKED.** Canonicalization is not universally required; it is Domain-owned and Equality-agnostic. Equality does not define, select, or infer any parsing, normalization, conversion, or canonicalization policy. Any value-identity-affecting transformation, if used, is explicit, Domain-owned, version-bound, deterministic, replayable, and non-hidden. Canonical form is optional and non-standardized at the Equality level. A required transformation that has not been satisfied yields a Failure, never `NOT_EQUAL`. No new Primitive, Registry, or Engine is authorized. *Excludes:* mandatory universal canonical form · operator-performed normalization · a blanket ban on canonicalization · hidden/caller-inline transformation. *Deferred:* concrete execution locus · whether a given Domain uses canonical form · versioning (ED4).

**— Phase C —**

**EC1 · Outcome Type — LOCKED.** A successful Equality evaluation yields exactly one typed canonical relation state: `EQUAL` or `NOT_EQUAL`. There is no third Outcome. Failure is outside the Outcome domain. The Outcome is not a bare Boolean and carries no similarity score, confidence, validation status, domain-specific label, reason, evidence, or payload within the Outcome value. Outcome identity is not Operation identity. *Excludes:* `UNKNOWN`/`INVALID`/`ERROR`/`PARTIAL` as Outcome members · bare Boolean · score/confidence · domain-specific labels · payload inside the Outcome value. *Deferred:* failure channel (EC2) · outcome/record identity (ED2).

**EC2 · Failure vs Outcome Channel — LOCKED.** Every accepted evaluation attempt that reaches a terminal disposition yields exactly one of: a canonical Outcome, or a Failure — never both and never neither. Failure is not a member of the Equality relation-state and is never `NOT_EQUAL`. There is no partial, degraded, or stale Outcome. Failure is a non-outcome category; its concrete type and representation are deferred, and no delivery mechanism is fixed here. *Excludes:* in-band failure value · `NOT_EQUAL` fallback · Outcome and Failure together · a third state. *Deferred:* envelope mechanism · failure taxonomy/codes (EE1) · replayability.

**— Phase D —**

**ED1 · Operation Identity — LOCKED.** Operation identity is ordered and orientation-preserving. `(a,b)` and `(b,a)` are distinct Operations even though successful evaluation must yield the same Outcome by symmetry. Identity includes the exact Domain binding and stable identities/references of the two admitted relatum participations in their original positional orientation. ED4 later adds Contract Version and any other approved semantic-authority reference. *Excludes:* unordered/commutative operation identity · canonical sorting of relata · value-resolved identity · any dependency on Ordinal. *Deferred:* hashing · replay key · cache key · identifier encoding · concrete reference mechanism.

**ED2 · Outcome & Result-Record Identity — LOCKED.** Four layers remain distinct and never collapse: Operation specification, Evaluation attempt, Terminal disposition, and Result record. `EQUAL` and `NOT_EQUAL` are shared canonical values, not minted per attempt; the occurrence that an attempt produced an Outcome is distinct from the Outcome value. A new execution started after a completed Attempt is a new Attempt; resume, internal backoff, step retry, or continuation within the same execution occurrence are not necessarily new Attempts, and the concrete boundary is deferred to execution architecture. A Specification may be executed zero, one, or many times; a Result record may be zero, one, or many artifacts. No normative identity collapse occurs between Specification, Attempt, Outcome, and Record. *Excludes:* collapsed identity · outcome-keyed record identity · request-ID as operation identity. *Deferred:* identifiers/UUID/hash · persistence · determinism (ED3).

**ED3 · Determinism & Statelessness — LOCKED.** C4 applies. Successful-Outcome determinism holds: under the same complete version-pinned semantic specification, a completed evaluation yields the same canonical Outcome. Statelessness is observational: no hidden state, schedule, inference, environment dependence, or semantic side effects; internal implementation state is permitted only when observationally irrelevant to the canonical Outcome. Failure determinism is not locked. *Subsequent record-readiness evidence (not part of the original ED3 lock):* CPT-1 was later audited and found operator-agnostic and applicable to Equality for future projection; no IMP registration occurs in §L. *Excludes:* implicit-only inheritance of C4 · deriving the commitments from "pure function" · operator-owned domain determinism CPT. *Deferred:* IMP registration and projection (§I) · failure determinism (EE1) · replay-key model.

**ED4 · Versioning Boundary — LOCKED.** Two ownership-aligned version authorities exist: the Domain Version (Domain-owned semantics) and the Equality Contract Version (operator-owned commitments); they are non-overlapping, and an implementation-only change bumps neither. Replay pins both. Different versions yield a different Operation specification. Policy is, by default, governed under Domain authority; a separate versioned policy artifact is not prohibited provided it has one semantic owner, an explicit version, an explicit binding, replayability, no `latest`, no mutable policy, and no dual authority. No Policy Registry is created. A complete specification includes at least the Contract Version, Domain ID, Domain Version, ordered relata references, and any additional approved semantic-authority reference. *Excludes:* a single unified version · subsumption of one authority by the other · a third free-standing policy authority causing dual authority · a version-format decision. *Deferred:* version format · migration · failure-code versioning (EE1).

**— Phase E —**

**EE1 · Failure Taxonomy & Boundary — LOCKED.** Failures fall into four families: **A — Equality Contract Failure**, Equality-owned; **B — Domain / Admission / Authority**, a recognized boundary whose internal taxonomy is owned by the Domain authority; **C — Operational**, a recognized boundary whose internal taxonomy is owned by Execution / Platform; **D — Internal Defect**, a recognized boundary governed by the violated invariant / appropriate supervisory authority. Family classification follows the root authority or invariant violated; persistent versus transient alone does not determine ownership. Failure is not an Outcome and is never `NOT_EQUAL`; a terminal disposition is Outcome XOR Failure; there is no valid "undefined comparison" once two admissible relata have been accepted for evaluation. Semantic authority is immutable under the same Version, and there is no blanket replay guarantee for a failure occurrence, family, code, or diagnosis. *Excludes:* a single flat failure enum · Equality owning the internal taxonomy of B/C/D · codes/wire/exception hierarchy. *Deferred:* codes · messages · wire · persistence · registry · retry · schema · the D↔C distinction at implementation level · the representation of an absent classification.

**EE2 · Failure Detection Obligation — LOCKED.** Four operations remain distinct: **Detection** follows operational capability; **Classification** authority follows semantic ownership (A/B/C/D); **Propagation** carries a Failure toward the Evaluation boundary without transferring ownership; **Preservation** of Outcome XOR Failure is owned by the Evaluation boundary. Classification of Family A is mandatory when Equality's own invocation boundary detects a contract violation; classification of B/C/D is consumed and preserved only when supplied by an authoritative source, and is never invented. A Failure disposition may be valid without a resolved Family classification; the absence of a classification creates no fifth family and no third Outcome, and its representation is deferred. Equality performs no classification inference. A captured internal defect may terminate as a valid Failure; a breach in which the Evaluation boundary itself fails to produce a legal terminal disposition is observed outside the broken Attempt and is not automatically Family D of that same Attempt. The Preservation obligation is normative; its operational realization (any supervisor, API, exception, storage, queue, or retry mechanism) is deferred. *Excludes:* presupposition-only detection · mandatory exact canonical classification · escalating an unclassified-but-preserved Failure to Family D · defining a supervisor API or execution architecture. *Deferred:* supervisor/audit mechanism · codes/messages · the D↔C distinction at family level · the representation of an absent classification.

**Phase Status.** Phases A–E are recorded here as conceptually completed through their respective owner-approved axis decisions. This status records prior conceptual closure; it does not itself create a Contract, Design Bundle, registration, allocation, or ratification.

**Governance Note.** This record materializes owner-approved conceptual locks only. It does not open §I, does not write §2, does not register any projection (including CPT-1/IMP), and does not allocate an operatorId, Primitive number, or Contract ID. Equality remains a candidate of Canonical Relation Evaluation at `CONTRACT-PENDING`; it becomes a ratified member or allocated Primitive only through the applicable downstream stages, each requiring its own governance approval.

**Source Mapping.**

| §L element | Source | Category |
|---|---|---|
| EA1–EE2 locked decisions | Owner-approved W3 design decisions (this session) | decision (owner) |
| value ≠ representation; value-equality vs identity/semantic boundary | §K + Equality Ledger row (§4), W1 / EQ-CF1 | evidence (corpus) |
| class = Canonical Relation Evaluation | PART A §6b + PA-B §B | evidence (corpus) |
| ED3 · C4 applicability | §2.5 (C4) | evidence (corpus) |
| ED3 · CPT-1 operator-agnostic & applicable | Projection Catalog audit — subsequent record-readiness evidence (NOT part of the ED3 lock) | evidence (subsequent) |
| structure of §L | Ordinal §H — STRUCTURAL PRECEDENT ONLY (no semantic reuse) | template |
| record date 2026-08-06 | Owner decision recorded now | decision |

---

## 3 · Operator Inventory  (LEVEL 1 — CLASSIFICATION IN PROGRESS, all PROPOSED)

> Each candidate run through the ratified §2.5 procedure. Results carry ZERO authority until
> owner-ratified item by item. Decompositions of Composite Patterns are PROPOSED only.
> `C1–C8` column: check=pass · x=fail · ?=PROOF-REQUIRED.

| Cand | Proposed classification | Class | C1 | Key uncertainty / Proof |
|---|---|---|---|---|
| F1 Partition | **RATIFIED — Primitive #1** | FRAMING | pass | LOCKED `Partition/contract@v1-2026-07-17` (§3.2/§3.3) |
| F2 Identity-Join | **REJECTED as FRAMING primitive** | — | — | grouping ≡ `Partition`-by-resolvedIdentity (Swap-Test passed; Relational View Principle §2.9). Pair/Tuple Enumeration = **OPEN** (not classified) |
| F3 Window (monolith) | **REJECTED** — no single purpose/Output Contract | — | — | tumbling/single = Partition usage/pattern; overlapping-interval-framing = PROOF (§3.4); session/gap = separate PROOF |
| F4 Coverage-Gate | **NOT a Primitive (PROOF)** | — | — | emits gate/BLOCKED decision → likely Contract/Law (coverage-propagation) or Detector outcome-determination (OQ-44/OQ-39), NOT a FRAMING op |
| R1 Count | **Primitive Operator** | REDUCTION | pass | high confidence |
| R2 Compare | **Primitive Operator** | REDUCTION | pass | compare-mode = parameter? (OQ-04) |
| R3 Aggregate-Baseline | **Composite Pattern** | (pattern) | fail | = Compare(Aggregate(cur), Aggregate(baseline)); extracts new primitive Aggregate; resolves E-Q2 |
| R4 Sequence | **Primitive (tentative)** | REDUCTION | ? | Sequence↔Trend boundary OQ-06; confirm irreducibility |
| R5 Duration | **Primitive Operator** | REDUCTION | pass | relies on interval EventTime; open-interval limit |
| R6 Trend | **Primitive (tentative)** | REDUCTION | ? | may be composite (Window-pairs+Compare); Sequence↔Trend OQ-06 |
| R7 Co-occurrence-Lead-Lag | **Split → 2 Composite Patterns (PROOF)** | (pattern) | fail | Co-occurrence = Window+Join+Count; Lead-Lag = Sequence+offset; resolves E-Q3 |
| R8 Conflict | **Primitive (tentative)** | REDUCTION | ? | conflict grounds-model OQ-06; vs Compare+predicate |
| Normalize | **C0 Prerequisite (EXCLUDED)** | — | — | produces/normalizes Evidence → below Projection; locked C0-prereq (E-Q1) |
| **Aggregate** (new, from R3) | **Primitive Operator** | REDUCTION | pass | statistic-kind = parameter vs distinct ops (OQ-02/OQ-04) |

Note: C2/C3/C4/C5/C6a/C7/C8 pass for every row classified as Primitive above (each is a
deterministic, grounds-anchored, single-class, inventory-independent projection function);
the discriminating axis is C1 (irreducibility) + C5 (layer) for the non-primitives.

### Proposed Composite-Pattern decompositions (PROPOSED — pending owner approval)
- **Aggregate-Baseline** → `Compare( Aggregate(current-frame), Aggregate(baseline-frame) )`.
- **Co-occurrence** → `Count( Identity-Join( Window(a), Window(b) ) )` (shared-window coupling).
- **Lead-Lag** → `Sequence` over two series with a temporal offset (offset repr = PROOF).

### Reshaped picture (PROPOSED)
- **Primitive (FRAMING):** Partition · Identity-Join(?) · Window(?)  — Coverage-Gate REMOVED (PROOF).
- **Primitive (REDUCTION):** Count · Compare · Aggregate(new) · Duration (solid) · Sequence · Trend · Conflict (tentative/PROOF).
- **Composite Patterns:** Aggregate-Baseline · Co-occurrence · Lead-Lag.
- **C0 Prerequisite (excluded):** Normalize.
- **E-Q resolutions (proposed):** E-Q1 Normalize excluded · E-Q2 Aggregate-Baseline = Aggregate(primitive)+pattern · E-Q3 Co-occurrence-Lead-Lag = two patterns · E-Q4 completeness OPEN.

## 3.1 · Proof Outcomes (owner-decided 2026-07-17)
- **Proof 1 — Coverage-Gate:** REJECTED as an Operator (gate = Outcome-Determination OQ-44 + SPEC-07). The narrow "restrict-to-covered-region framing" residue stays a SEPARATE OPEN PROOF. OQ-39 untouched.
- **Proof 2 — Framing:** `Partition` = base FRAMING primitive (approved ONLY once its Output Contract is fully defined — see §3.2). `Window` & `Identity-Join` remain PROOF-REQUIRED (Output-Contract must confirm overlap / cross-source relational linkage).
- **Proof 3 — Sequence/Trend/Conflict:** all remain PROOF-REQUIRED. Trend leans REJECTED-as-primitive (Composite/absorbed). Conflict primitive ONLY if its grounds-model is structural (not semantic Judgment).
- **Membership-is-contract-gated (owner principle):** the inventory closes ONLY when each Primitive has a FULL §2 contract proving its status. No closure by assumption.

## 3.2 · Partition — Full Operator Contract (Bundle B integrated; PROPOSED, one confirmation pending)

1. **operatorId** — `Partition`. Stable purpose-identity (SPEC-03). Criterion VALUE never changes it.
2. **class** — FRAMING.
3. **purpose** — impose a **single-membership, deterministic, disjoint, auditable classification**
   of input grounds into declared categories, **conserving every input ground**. (NOT phrased as a
   universal "equivalence relation" — per owner terminology correction.)
4. **inputContract** —
   - `grounds`: finite set of input grounds (C0 accounts and/or a prior framed scope), each with stable identity.
   - `partitionCriterion` (versioned, pinned): one of {single key-extraction · declarative field/path expression · ordered first-match predicate set · pinned reference to an external versioned criterion contract}. MUST guarantee single-membership. **Rejected in Partition:** multi-key membership · overlapping predicates · any criterion letting a ground land in >1 subset.
   - `domainMode`: CLOSED (with enumerated declared category set) · OPEN.
   - **Two-layer distinction (owner):** the GENERAL evaluator contract may recognize four states
     (`MATCH` · `NO_MATCH` · `NOT_APPLICABLE` · `EVALUATION_ERROR`); the **Partition ENTRY contract
     accepts only a full evaluation restricted to `MATCH(key)` / `NO_MATCH`**, defined for every
     ground in the invocation. An invocation whose criterion is not fully evaluable to those two is
     NOT a valid Partition invocation (see §3.3). The four states are therefore NOT four legal
     Partition outputs.
5. **outputContract** —
   - a **canonical, semantically-unordered** collection of pairwise-**DISJOINT** subsets covering
     every ground in the invocation exactly once;
   - each `MATCH(k)` ground appears exactly once in category `k`'s subset;
   - each `NO_MATCH` ground appears exactly once in the explicit `UNCLASSIFIED` remainder;
   - **`UNCLASSIFIED` means: criterion evaluated successfully but no category matched** — it MUST NOT represent missing value / uncovered evidence / evaluation failure / not-applicable / unresolved identity / any state owned by C0/SPEC-07;
   - **NO exceptions channel in the output.** `⋃ subsets = invocation input`.
   - an invocation whose criterion is not fully evaluable to `MATCH`/`NO_MATCH` produces **NO Partition Projection** (no partial output);
   - CLOSED domain: every declared category (and `UNCLASSIFIED`, if fixed-schema) appears even when empty; OPEN domain: only observed `MATCH` keys produce subsets — an absent category is NOT an empty subset and MUST NOT be read as zero;
   - subset order and intra-subset order are NON-semantic; canonical deterministic encoding for hashing/replay/serialization only; downstream MUST NOT derive meaning from it.
6. **parameters** — `partitionCriterion` (+ `domainMode`, + enumerated category set when CLOSED). Versioned + pinned; a parameter of the invocation/projection, not of operatorId.
7. **coverageDeclaration** — NOT declared by Partition (C6b DEFERRED under OQ-39). [non-blocking]
8. **determinism** — identical grounds + pinned criterion (+domainMode/declared set) + pinned context ⇒ bit-identical output (subsets + `UNCLASSIFIED` remainder + canonical encoding). No state / inference / side effects. An evaluation that is not fully `MATCH`/`NO_MATCH` (i.e. `NOT_APPLICABLE` or `EVALUATION_ERROR`) **prevents Projection creation** — it does not yield a partial or alternative Partition output. [C4]
9. **compositionRules** — FRAMING. Pred = raw grounds ∣ another FRAMING op; MUST NOT follow a REDUCTION (PART A). Succ = any op consuming framed scopes; each emitted subset is itself a framed scope.
10. **versioningRule** — operatorId (purpose) stable; different criterion VALUES do NOT create new operatorIds while purpose + Output Contract are unchanged. Changing criterion VALUE changes the **Projection RESULT identity** (pinned for replay) but NOT the operator version. Changing criterion SCHEMA or Output-Contract MEANING MAY require an operator version per PART A. A purely technical serialization/canonical-encoding migration that changes replay bytes but not the semantic Projection is distinguished from a semantic Output-Contract change — classified per the already-locked identity/version rules, NOT auto-assumed to be a semantic operator-version bump.
11. **openQuestions** —
    - [NON-BLOCKING] detailed field-schema of each admissible criterion form (OQ-04 remainder; forms are fixed, schemas are construction detail).
    - [NON-BLOCKING] coverageDeclaration (OQ-39 / C6b).
    - [NON-BLOCKING, owned elsewhere] the contract that ENFORCES the Partition entry precondition and HANDLES `NOT_APPLICABLE` / `EVALUATION_ERROR` (an evaluator / runtime-execution contract). Partition references it but its own identity/determinism/replay/composition do not depend on its internals.
    - [RESOLVED] D1/D2/D3 per Bundle B; conservation `⋃ subsets = invocation input`; precondition = Option (ii).

## 3.3 · Partition entry precondition + four-state handling (owner-ratified, Option ii)
`Partition` accepts only an invocation whose `partitionCriterion` is defined for EVERY ground and
returns one of exactly two legal results: `MATCH(key)` / `NO_MATCH`. Partition emits NO
`evaluationExceptions` channel. Handling of the four evaluator states at Partition's boundary:
- **MATCH(key)** → ground assigned to the single subset for `key`.
- **NO_MATCH** → evaluation succeeded, no category matched → ground assigned to `UNCLASSIFIED`.
- **NOT_APPLICABLE** → NOT a legal input of a Partition-ready invocation. Must be resolved BEFORE
  invocation per its owning contract: define an applicability scope before the invocation · OR
  represent it as a declared business category if `NOT_APPLICABLE` is a real domain value · OR do
  not run the invocation on that scope. MUST NOT be auto-converted to `NO_MATCH` or `UNCLASSIFIED`.
- **EVALUATION_ERROR** → a criterion-evaluation failure, not a Projection. The Partition invocation
  FAILS: no partial Partition output; no Projection persisted as if complete; the failure is
  recorded/handled by the appropriate runtime/execution contract. The failed ground is NOT silently
  dropped-and-continued (that would break conservation and yield a misleading partial output).

## 3.4 · OIFC — accepted as candidate narrow FRAMING Primitive (CONTRACT-PENDING)
- **Status:** candidate narrow FRAMING Primitive, CONTRACT-PENDING. NOT Composite, NOT orchestration.
- **Purpose (atomic, accepted):** given grounds with a valid coordinate and a PINNED interval space,
  produce for each interval the set of grounds whose coordinate lies within it; a ground may belong
  to >1 frame. One purpose = a multi-membership relation, not a sequence of separate business results.
- **Atomicity wording (CORRECTED per owner — do NOT write "if Partition is atomic, OIFC is atomic"):**
  like Partition, the operation can be defined as a direct per-ground membership mapping, BUT its
  Primitive status rests INDEPENDENTLY on a single purpose + a distinct Output Contract + the absence
  of a legal Known Decomposition per §2.8.
- **Purpose-boundary (LOCKED now):** OIFC **APPLIES** a pinned interval space. It is NOT the owner of
  schedule creation / calendar grid / session boundaries. Explicit interval set may be a direct param;
  a compact spec is admissible ONLY if its expansion is deterministic, pinned, and part of the
  parameter representation. Calendar interpretation / timezone normalization / domain construction stay
  in external contracts. Session/gap segmentation stays excluded. If a future proof shows interval-grid
  GENERATION is an independent semantic op (not mere parameter normalization), revisit via versioning /
  decomposition review.
- **operatorId:** NOT fixed. Neutral `OIFC`. Do not lock `Window`/`IntervalFrame`/`SlidingWindow`
  before purpose+Output Contract close; final name must reflect APPLICATION of interval membership,
  not generation/time-series.
- **Precondition (same as Partition Option-ii):** grounds without valid coordinate are NOT dropped; a
  ready invocation contains only grounds whose coordinate evaluation succeeded; NOT_APPLICABLE /
  EVALUATION_ERROR handled before Projection; no partial output masquerading as a full FrameSet.
- **Open contract decisions (CONTRACT-PENDING):** O-D1 interval-space ownership · O-D2 grounds-without-
  membership · O-D3 inclusivity/bounds (OQ-05).

## 3.5 · OIFC — Full Operator Contract (Bundle O-2 integrated; PROPOSED for ratification)
1. **operatorId** — `IntervalMembership`. Stable purpose-identity: does NOT vary by coordinate domain; time is a possible instantiation, NOT part of the name or purpose; interval values, instance IDs and inclusivity are PARAMETERS; session segmentation, interval generation and ordered-series readout are OUT of contract.
2. **class** — FRAMING.
3. **purpose** — given grounds with a canonical coordinate and a PINNED finite bounded interval space, produce for each interval the set of grounds whose coordinate lies within it (a ground may belong to zero-or-many frames). One purpose = a multi-membership interval-**application** relation. APPLIES a pinned interval space; does NOT own schedule / calendar / session generation.
4. **inputContract** —
   - `grounds`: finite set; each carries a **canonical coordinate** (normalization owned by C0 / domain contract).
   - `intervalSpace`: finite, bounded, pinned; delivered as {explicit expanded interval-instance set · compact deterministic spec with pinned reproducible expansion · pinned versioned reference to an external interval-domain contract}. In ALL forms the **effective expanded interval-instance list is bit-identical reproducible**. Each interval is an **INSTANCE with stable identity** (not a math set with auto-dedup).
   - `inclusivity`: explicit, **uniform** across the whole interval space, pinned into invocation identity. Default `[start,end)`.
   - No hidden dependency on calendar lib / tz db / locale / system clock / unpinned default.
5. **outputContract** — a two-component Projection over two DISTINCT scope types:
   - `FrameSet` — canonical, semantically-unordered set of **`IntervalFrame`** scopes; each `IntervalFrame` is identified by a **single interval-INSTANCE identity** and holds references to **all-and-only** grounds whose coordinate ∈ that interval (under pinned inclusivity). Overlapping intervals ⇒ a ground referenced by multiple frames (legal multi-membership; references, not copies; C0 immutability preserved).
   - `UnframedComplement` — a **typed complement scope** (type `UnframedComplement`, NOT an `IntervalFrame`): all-and-only grounds with zero interval membership. It has NO interval identity, NO bounds, NO positive scope membership. A mandatory VALID Projection component — NOT exceptions / rejections / metadata, and NOT a "remainder window".
   - **Closure invariant:** every invocation ground is a member of ≥1 `IntervalFrame` OR appears exactly once in `UnframedComplement` — never both, never neither. (`Evaluation completeness + reference integrity`, NOT Partition exactly-once.)
   - Frame order + intra-frame order NON-semantic (canonical encoding only); `UnframedComplement` is not ordered among frames.
6. **parameters** — `intervalSpace` (+ delivery form + pinned expansion/reference) · `inclusivity` (default `[start,end)`, uniform). Pinned; parameters of the invocation/projection, not of operatorId.
7. **coverageDeclaration** — NOT declared (C6b DEFERRED / OQ-39). [non-blocking]
8. **determinism** — identical grounds + pinned effective intervalSpace + pinned inclusivity + pinned context ⇒ bit-identical (FrameSet + UnframedGroundSet + canonical encoding). No state/inference/side-effects. A precondition failure yields NO Projection (no partial FrameSet/UnframedGroundSet).
9. **compositionRules** — `IntervalMembership` is FRAMING and does NOT apply after a REDUCTION. Each `IntervalFrame` in the output is an independent framed scope. `UnframedComplement` is a SEPARATE typed ground scope representing zero membership — it is NOT an interval frame (no bounds, no interval identity, not orderable among frames, not a "remainder window"). A downstream operation MUST declare which scope type(s) it accepts (`IntervalFrame` and/or `UnframedComplement`/generic ground scope); there is NO silent coercion between the two types.
10. **versioningRule** — operatorId stable; different intervalSpace/inclusivity VALUES do NOT create new operatorIds. Changing interval VALUES or inclusivity VALUE = parameter change → new Projection identity (pinned for replay), same operator version. Changing expansion SEMANTICS / output SHAPE / boundary MEANING = contract change → operator version per PART A. A technical serialization migration is classified per the locked identity/version rules, not auto-bumped.
11. **openQuestions** — [NON-BLOCKING] final operatorId/name · coverageDeclaration (OQ-39) · external contract enforcing precondition + handling NOT_APPLICABLE/EVALUATION_ERROR + coordinate normalization (C0/domain + evaluator/execution) · [FUTURE] full membership-ledger as a derived projection/optimization (not in v1).

**Two v1 decisions (OWNER-RATIFIED):**
- **Zero-width intervals — REJECTED in precondition.** v1 **contractual invariant**: every valid interval instance satisfies `start < end` on the canonical ordered domain. No empty frame is produced. (This is a contractual invariant, NOT merely derived from `[start,end)`; future point-interval support requires a semantic change + operator version.)
- **Duplicate interval instances — REJECTED, NO silent deduplication.** intervalSpace is a collection of interval **instances with stable identity**; **frame identity = interval-instance identity** (serialization-independent). (a) same bounds + DISTINCT valid instance IDs + declared meaning → legal, two separate frames; (b) the same instance ID appearing more than once → INVALID invocation; (c) a duplicate without a distinct identity → INVALID invocation. No normalization silently drops an instance (silent dedup could change cardinality / lineage / Projection identity invisibly).

**Precondition (invocation-ready iff ALL hold):** every ground has a valid canonical coordinate · intervalSpace fully expandable/reproducible bit-identical · every interval instance satisfies `start < end` (zero-width rejected) · no repeated instance identity and no identity-less duplicate (rejected; no silent dedup) · inclusivity uniform+pinned · no `NOT_APPLICABLE`/`EVALUATION_ERROR`. On any failure: no partial `FrameSet`, no partial `UnframedComplement`, no Projection.

## 3.6 · OIFC — Closure Battery (result)
| Check | Result |
|---|---|
| **C1 (refined §2.8)** | ✓ no legal contract-preserving decomposition from {Partition}+defined structures (Partition can't multi-member; fold/interval-gen/collect are undefined ⇒ barred by implementation-guard); atomic per-ground multi-membership purpose; no hidden KNOWN operator-orchestration |
| **C2 class** | ✓ FRAMING |
| **C3 contract** | ✓ fully declarable (11 fields; two-component Output Contract) |
| **C4 determinism** | ✓ bit-identical under pinned params; failure ⇒ no Projection |
| **C5 layer** | ✓ Projection-layer framing (not Evidence, not Belief) |
| **C6a honesty** | ✓ grounds-anchored (references to immutable grounds); no fabrication (membership = coord∈interval, total decidable) |
| **C7 versioning/identity** | ✓ purpose-id stable; value vs schema vs technical-migration distinguished |
| **C8 inventory-independence** | ✓ definition references coordinate+intervalSpace+inclusivity (params/external), not other operators; passes Swap-Test |
| **Known-Decomposition Test** | ✓ no known legal decomposition; implementation-guard bars the fold argument |
| **Identity / projectionHash** | ✓ over FrameSet(by interval-instance id)+members + UnframedGroundSet + effective interval space + inclusivity + canonical encoding |
| **Replay** | ✓ effective interval list + grounds pinned/reproducible; failed invocation never masquerades as Projection |
| **Composition** | ✓ FRAMING typing; frames + UnframedGroundSet are framed scopes |
| **Precondition completeness** | ✓ covers coordinate/interval/inclusivity/eval-state; failure ⇒ no Projection |
| **Semantic placeholders** | ✗ none (deferrals are non-blocking: coverage OQ-39, external precondition/execution contract, final name, future ledger) |

**Closure result: PASSES.** OIFC is a well-defined narrow FRAMING Primitive under Bundle O-2 + the two v1 decisions; no blocking dependency remains.

## 3.7 · FixedGapSegmentation — Full Operator Contract (F-1 integrated; PROPOSED; working name)
1. **operatorId** — `GapSegmentation` (RATIFIED name). Conceptual purpose = segmentation by gap relation over an ordered domain. "Fixed" is a v1 contract INVARIANT, deliberately NOT in the name. Stable purpose-identity; not by coordinate domain; threshold is a parameter.
   **v1 scope guard:** `GapSegmentation/contract@v1` supports ONLY a single fixed threshold pinned per invocation. Each of the following is NOT an ordinary parameter addition and requires a NEW proof + a decision (new contract version / new operatorId / Composite / separate candidate): adaptive threshold · per-ground threshold · per-pair threshold · accumulated gap · attribute-dependent threshold · arbitrary boundary predicate · calendar-aware threshold · multi-stream segmentation.
2. **class** — FRAMING.
3. **purpose** — given a SINGLE scope of grounds with a canonical coordinate, produce the UNIQUE partition into **maximal disjoint connected runs** under canonical coordinate order and the pinned gap rule (`gap ≤ threshold` connects). Applies a fixed pinned threshold; does NOT own stream-grouping, ordering-readout, or coordinate normalization.
4. **inputContract** —
   - `grounds`: a **single scope** (one stream/population); each has a canonical coordinate in ONE totally-ordered, comparable distance-domain (normalization + units + precision owned by C0/domain). NO `streamKey`/source/role grouping inside the operator (that is a prior `Partition`).
   - `threshold`: pinned; **non-negative, finite**, in the canonical distance-domain of the coordinate.
   - **gap rule (v1 contract constant):** `gap > threshold` opens a new segment (`gap ≤ threshold` connects). Not a free parameter.
   - **canonical ordering (internal):** the operator sorts by (coordinate, then canonical `groundId` as a serialization-only tie-break). Source/ingestion order is NOT semantic and NOT a legal tie-break.
5. **outputContract** — `SegmentSet` (a NEW scope type):
   - the UNIQUE partition into **maximal disjoint runs** (maximality invariant — see below).
   - each `Segment` carries: `segmentId` = **canonical UNORDERED member-identity-set digest** (membership alone determines it; serialization/tie-break do NOT change it; ground-ids are sorted only for a fixed hashing rule, not presented as semantic order); `member` references (all-and-only its grounds); `minMemberCoordinate` and `maxMemberCoordinate` — a **semantic summary of members by coordinate value**, NOT interval bounds (no inclusivity, no continuity claim, not an interval-domain object). When several members share the min/max coordinate, bounds + identity rest on **coordinate values + the member set**, never on a tie-break-selected ground.
   - **single-membership + full conservation:** every input ground is in exactly one segment; `⋃ segments = input`.
   - **empty segments are impossible** (segments are formed from grounds).
   - `SegmentSet` is **semantically UNORDERED** (canonical encoding only); order is DERIVABLE downstream from min/maxMemberCoordinate, NOT from the set and NOT a semantic series. NO `UnframedComplement` (every ground is segmented).
   - **empty input →** per the general **Empty-Input Policy (§2.10, pending ratification)**; proposed: valid empty Projection (empty `SegmentSet`).
6. **parameters** — `threshold` (pinned). gap-rule + canonical-ordering are v1 contract constants (not free parameters). Coordinate-domain identity is pinned context.
7. **coverageDeclaration** — NOT declared (C6b / OQ-39). [non-blocking]
8. **determinism** — identical grounds + pinned threshold + pinned coordinate-domain + pinned context ⇒ bit-identical `SegmentSet` (membership, segment-ids, bounds, canonical encoding). **Membership + boundaries are tie-break-independent** (equal coordinates ⇒ gap 0 ⇒ same segment). No state/inference/side-effects. Precondition failure ⇒ no Projection.
9. **compositionRules** — FRAMING; does NOT apply after a REDUCTION. Each `Segment` is a framed scope consumable downstream (e.g. REDUCTION per segment). Multi-stream sessionization = `Partition`-by-streamKey ∘ this operator (Composite, not part of it). Order for `Sequence`/`Duration` is DERIVED from min/maxMemberCoordinate — not emitted as a semantic series.
10. **versioningRule** — operatorId stable across threshold VALUES. Changing threshold VALUE = parameter change → new Projection identity (pinned for replay), same operator version. Changing the semantic ordering rule / gap rule (`>`→`≥`) / output shape / bounds meaning = contract change → operator version per PART A. A technical change not affecting membership, bounds, canonical encoding, or IDs is NOT a contract change.
11. **precondition + openQuestions** —
    - **Precondition (invocation-ready iff ALL):** every ground has a valid canonical coordinate in ONE totally-ordered comparable distance-domain · **no duplicate ground-identity** (duplicate COORDINATE is legal — gap 0, same segment) · threshold non-negative/finite/comparable · single scope. On failure: no partial `SegmentSet`, no `UnframedComplement`, no auto-singleton, **no Projection**.
    - [NON-BLOCKING] final operatorId/name (after closure).
    - [NON-BLOCKING] coverageDeclaration (OQ-39).
    - [NON-BLOCKING, owned elsewhere] contract enforcing precondition + coordinate normalization + distance-domain (C0/domain + execution).
    - [GOVERNANCE — needs a GENERAL rule] Empty-Input Policy (§2.10) — must be ratified as a general Grammar rule, not locally.

## 3.8 · FixedGapSegmentation — Closure Battery (result)
| Check | Result |
|---|---|
| **C1 (refined §2.8)** | ✓ no known legal contract-preserving decomposition (Boundary-Marking & RDL rejected as operators; Partition only the trivial tail after membership exists; IM needs pinned intervals + is multi-membership; scan/connected-runs undefined ⇒ implementation-guard). Atomic single purpose (maximal-run formation); no hidden KNOWN operator-orchestration |
| **C2 class** | ✓ FRAMING |
| **C3 contract** | ✓ fully declarable (11 fields; `SegmentSet` Output Contract) |
| **C4 determinism** | ✓ bit-identical; tie-break-independent membership/bounds; failure ⇒ no Projection |
| **C5 layer** | ✓ Projection-layer framing |
| **C6a honesty** | ✓ grounds-anchored (member references to immutable grounds); no fabrication; full conservation |
| **C7 versioning/identity** | ✓ purpose-id stable; value vs contract vs technical distinguished; segmentId content-derived; parameter digest at Projection level |
| **C8 inventory-independence** | ✓ defined via coordinate + threshold + gap-rule (params/constants), not other operators; passes Swap-Test |
| **Known-Decomposition** | ✓ no known legal decomposition (intermediates are not independent operator outputs) |
| **Identity / projectionHash** | ✓ operator-version + parameter-digest + canonical set of {segmentId, members, min/max bounds} |
| **Replay** | ✓ all boundary decisions bit-identical reproducible from grounds + pinned params; failed invocation never a Projection |
| **Composition** | ✓ FRAMING; segments are framed scopes; multi-stream = Composite; ordering derived not emitted |
| **Precondition completeness** | ✓ coordinate/duplicate/threshold/scope covered; failure ⇒ no Projection |
| **Semantic placeholders** | ✗ none blocking. ONE governance item: Empty-Input Policy (§2.10) must be ratified as a GENERAL rule (not operator-local) |

**Closure result: PASSES** — contract is complete and well-defined, with ONE cross-cutting governance item (the general Empty-Input Policy §2.10) that is not operator-specific.

## 3.9 · Count — §2 Contract DRAFT (W5; N-2 integrated; NOT ratified, NOT closed)
> `Count` **RATIFIED** as Primitive Operator #4 (REDUCTION) · `Count/contract@v1-2026-07-22` · Owner-ratified 2026-07-22 · recorded in Ledger (§4) + Register · W6 Closure CLEAN + Final Delta-Closure CLEAN · Final Ratification Audit VERIFIED (F-AUDIT-1 synchronized).

1. **operatorId** — `Count` (FINAL, locked at Closure 2026-07-22). Purpose-identity stable; not by scope type; no semantic parameters in v1. Semantic Projection Identity and content digest use `Count` as the canonical operator identity.
2. **class** — **REDUCTION** (first candidate of this class; establishes the REDUCTION contract template). Class composition per PART A: `Reduction→Framing` FORBIDDEN; `Reduction→Reduction` OPEN (inherited SPEC-01 open question — [FLAG-A]).
3. **purpose** — produce a **deterministic cardinality readout of memberships within a SINGLE, supported, pinned scope**. Does NOT count: child-scopes/containers · distinct-entities (post identity-resolution) · values · predicates · weights · relations · coverage · percentages · deltas · trends. Every legal member reference in the scope = one unit. **No deduplication** (no-duplicate-membership is an UPSTREAM scope invariant).
4. **inputContract** (SCOPE-C; revised W5.6 — Count does NOT define a scope abstraction; it references per-type ratified facts) —
   - Count v1 accepts a **SINGLE instance of one of the input types listed in the ratified Compatibility Matrix**, where the instance's **identity, snapshot, and membership are identifiable and verifiable via its producer's contract and its canonical child selector** (per §3.10). **No structural typing · no auto-extension · no arbitrary collection.**
   - **Per-type child identity (see §3.10):** `PartitionSubset` = Parent-Partition-Projection-id + category-key (or `UNCLASSIFIED` role) · `IntervalFrame` = Parent-IM-Projection-id + interval-instance identity · `UnframedComplement` = Parent-IM-Projection-id + `UNFRAMED_COMPLEMENT` role (exactly one per parent) · `Segment` = Parent-GapSeg-Projection-id + `segmentId` (content-derived member-set digest). Member set derives deterministically from the parent snapshot + selector (+ criterion where applicable).
   - **Compatibility Matrix v1:**
     - **SUPPORTED:** `PartitionSubset` · `IntervalFrame` · `UnframedComplement` · `Segment`.
     - **NOT SUPPORTED (v1):** `SubsetSet` · `FrameSet` · `SegmentSet` · any container · arbitrary collection · any object not explicitly listed.
     - **OPEN (outside v1 contract):** `Raw GroundSet` — not rejected in principle; excluded until its own full contract is proven (canonical set identity · pinned snapshot · immutable membership · replayable set digest · the C0-Evidence-scope ↔ C1-Projection-scope relation). [OPEN-EXT]
   - **Multi-membership:** one invocation, one scope; the same Ground may count once in `IntervalFrame` A and once in B; **no global dedup**; Count does NOT accept a `FrameSet`.
5. **outputContract** —
   - **semantic VALUE = arbitrary non-negative integer**, canonical **base-10 decimal**: no sign · no leading zeros · `"0"` the ONLY zero representation. No float/approximation/truncation/saturation/wraparound. (JS safe-int etc. = implementation limit ONLY, not a contract bound.)
   - `Count(valid empty scope) = "0"` — **local Count rule** (§2.10 guarantees the empty invocation is valid/canonical; Count's contract fixes the readout to 0). NO general REDUCTION identity-element rule inferred — [OPEN-GOV].
   - Projection = {semantic value} + **standard Projection envelope** (identity · version · provenance · input reference · content digest). The envelope is NOT part of the value and NOT a Purpose extension. **No rich analytical output** (coverage/percentage/denominator/breakdown/comparison).
6. **parameters** — NONE semantic in v1. A **canonical empty parameter digest** (or equivalent) is retained per the existing Projection-identity law. (Non-blocking dependency: the general identity/digest composition is governed by SPEC-02 and is NOT redefined here — Count references it.)
7. **coverageDeclaration** — NOT declared (C6=C6a; **C6b/OQ-39 stays OPEN, NOT decided via Count**). Count asserts NO completeness/coverage/representativeness/denominator/comparability/absence. `count=10` means ONLY "ten memberships exist in the given scope snapshot." Coverage metadata may live upstream in provenance; it does NOT alter the value.
8. **determinism** — readout independent of member serialization / insertion order / execution time / iteration strategy. Identical pinned scope + Count version ⇒ **bit-identical value + identity + content digest**. Unsupported/invalid input ⇒ **no Projection**. Resource-limit inability to compute the exact value ⇒ **explicit execution failure** (never approximation/partial).
9. **compositionRules** — REDUCTION; consumes a SINGLE framed scope of a SUPPORTED type; emits a cardinality readout consumable downstream (future Compare/Ratio/Trend/Aggregate-over-Count-readouts) WITHOUT re-exposing members. **`Count per each scope in a container` = a MAPPING/Composite**, NOT inside this primitive; Count does not apply to a container. Class-level rule: `Reduction→Framing` forbidden (PART A); `Reduction→Reduction` OPEN [FLAG-A].
10. **versioningRule** — operatorId stable; no semantic parameters in v1. **Contract-change (new version):** membership→distinct-entity · Filter/predicate · weighting · container-count · Raw-GroundSet support · empty-semantics change · integer-domain/encoding change · invalid-scope-handling change · identity-composition change · adding a semantic parameter · approximation. **Implementation-only (no version):** iteration/storage/caching/parallelization/internal-arithmetic — ONLY if output + identity + content-digest + failure-semantics remain canonical and identical.
11. **precondition + openQuestions** —
    - **Precondition (invocation-ready iff ALL):** scope present · scope type SUPPORTED · scope identity present+valid · scope snapshot pinned · reference resolvable · contract version supported · member-set digest matches · no detectable duplicate-membership/corruption · every member reference legal. On any failure: **no Projection** (no partial, no best-effort; failure NEVER converted to 0). Resource-limit → explicit execution failure.
    - **Projection Identity (chosen: alternative B):** Semantic Projection Identity = operator-identity + Count-contract-version + canonical-input-scope-identity + semantic-parameter-digest (empty in v1). The **count value is NOT part of semantic identity** (deterministically derived). **Content Digest** DOES include the count value + all canonical content for replay/corruption verification. **Storage Record ID** = operational only. **same value on different scopes ≠ same Projection** (scope identity differs).
    - **Provenance/Snapshot (envelope):** must include or immutably reference: canonical input-scope-identity · input-scope-type · input-scope contract/version · parent-Projection-identity (when scope came from a Projection) · canonical member-set/snapshot digest · Count operator/contract version · canonical count value/content digest. No need to duplicate the member list if reference+digest allow full replay/verification. A **live/mutable reference is insufficient**. Timestamp/execution-trace = operational provenance only, NOT semantic identity.
    - **Known-Decomposition (preserved):** `Σ1` = math identity; map-to-one/Sum/Aggregate not ratified; accumulator = implementation; no semantic cardinality readout in scope contracts ⇒ not a §2.9 View ⇒ **no known legal decomposition**. A future primitive does not auto-invalidate Count (requires a DR).
    - **Non-blocking dependency (FLAG-C, reworded):** Count references a canonical immutable parent-Projection identity as MANDATED by the producer contracts (Partition/IM/GapSegmentation each pin a replay Projection identity); the general identity COMPOSITION remains governed by SPEC-02 and is NOT redefined in Count's contract.
    - **Explicit non-v1 / open extensions (NOT contract placeholders):** `Raw GroundSet` [OPEN-EXT] · `Container-Count`/`scopeCount` [OPEN] · general REDUCTION empty→identity-element rule [OPEN-GOV] · `Reduction→Reduction` composition [inherited SPEC-01 open, FLAG-A].
    - *(FLAG-B removed — per-type conformance verified in W5.6; OPEN-FORM removed — SCOPE-C chosen, no abstraction; SCOPE-B stays a FUTURE decision, not a Count placeholder.)*

## 3.10 · Child-Input Identity Model (W5.6 documentation delta — SCOPE-C; no contract change)
Documentation only. Each supported input is a semantic CHILD output of a ratified FRAMING Projection,
identified canonically by **parent Projection identity + canonical child selector** (+ child
content-derived identity where it exists). No general Scope abstraction; no new identities; no change
to any FRAMING contract.
- **`PartitionSubset`** — canonical child identity = **Partition Projection identity + canonical category key** (or, for the remainder, **Partition Projection identity + canonical `UNCLASSIFIED` role**). The member set is derived DETERMINISTICALLY from the parent snapshot + criterion + selector.
- **`IntervalFrame`** — canonical child identity = **IntervalMembership Projection identity + canonical interval-instance identity**. The interval-instance identity is content-derived and self-canonical; the parent reference is RETAINED in provenance regardless. Members = grounds with coord ∈ interval (deterministic).
- **`UnframedComplement`** — canonical child identity = **IntervalMembership Projection identity + canonical `UNFRAMED_COMPLEMENT` role**. Exactly ONE such complement exists per parent Projection (the role-selector is unique). Members = grounds of zero interval membership (deterministic).
- **`Segment`** — canonical child identity = **GapSegmentation Projection identity + `segmentId`**, where `segmentId` is the canonical member-set digest per the ratified GapSegmentation contract. A single `Segment` is CONSUMABLE as a standalone child output, even though the registered container is `SegmentSet`.

## 4 · Ratification Ledger

| Item | Level | Status | Owner note / correction | Date |
|---|---|---|---|---|
| **PART A Replacement** (`PART-A-replacement@v1`) | Governance | **RATIFIED** | Owner-ratified official operator-class taxonomy authority; replaces the unrecoverable historical PART A per DR-C1-PARTA-01; PKG-MIN+PA-C+PA-D+PA-B; FRAMING/REDUCTION(narrow) defined by transformation+info-ownership+purpose; Scope=Output-Category (§16); CLASS-UNRESOLVED status; dormant class-addition (PA-B); Backward-Compat + Non-Retroactivity in force; 4 primitives unchanged (no re-ratification). `extent` note = doc-only, not a blocker | 2026-07-22 |
| **DR-C1-PARTA-01** | Governance | **COMPLETED / CLOSED** | PA-3 provenance gap officially closed via ratified Replacement | 2026-07-22 |
| **Operator Class `Canonical Relation Evaluation`** (3rd class) | Governance | **RATIFIED · EFFECTIVE** | Third operator class alongside FRAMING/REDUCTION, added via PA-B. Authority `DR-C1-PARTB-CLASS-01`. Foundation (D1/D6/Contract-Opaque/Hidden-Transformation-Guard) = RATIFIED (PA-B §A). Full definition PA-B §B §1–§15; PART A §6b. **Members: NONE RATIFIED** (unchanged). Candidates: `Ordinal` (CLASS ASSIGNED · CONTRACT-PENDING, ORD-CF1+W2) · `Equality` (CLASS ASSIGNED · W2-ELIGIBLE, EQ-CF1) — 2026-07-29, both NOT members. Additive; FRAMING/REDUCTION + 4 primitives unchanged; no re-ratification | 2026-07-24 |
| **`DR-C1-PARTB-CLASS-01`** | Governance | **OWNER-RATIFIED · EFFECTIVE** | Decision Record authorizing the 3rd class per PART A §8; PA-B §E. Closes OPEN-Q5. Explicit Non-Decisions: does NOT ratify Ordinal/Equality/any operator/membership/§2/W2/operatorId/Primitive#/Type-Compat/Set-as-value/finite-outcome/normalization/identity-collapse/Composition/Scope-Relations-family | 2026-07-24 |
| **`Ordinal`** (candidate) | L1 | **W1-COMPLETE 2026-07-22 → `CLASS ASSIGNED` (ORD-CF1 2026-07-29) → `CONTRACT-PENDING` (Ordinal W2 ACCEPTED 2026-07-29, §G): `Canonical Relation Evaluation`** | W1 (2026-07-22, vs `@v1`): Candidate-Boundary resolved · no known legal decomposition · not §2.9-View · C1 holds · C2 was CLASS-UNRESOLVED. **ORD-CF1 (2026-07-29, vs `@v1.1` / §6b):** FITS `Canonical Relation Evaluation` — D1(peer+contract-opaque)/D6(canonical-domain-fixed)/TK/Ownership/Output/Hidden-Guard/Boundary all PASS; no OQ required for fit. **NOT a ratified member** — no §2 / operatorId / Primitive# / C1–C8-complete / Ledger-Member; Class-Fit ≠ Membership. Deferred (W2/Contract): ascending/descending · collation/null/timezone/units · total-order-vs-preorder | 2026-07-22 / 2026-07-29 |
| **`Equality`** (candidate) | L1 | **W1-COMPLETE 2026-07-22 → `CLASS ASSIGNED` (EQ-CF1 2026-07-29) → `CONTRACT-PENDING` (Equality W2 ACCEPTED 2026-08-06, §K): `Canonical Relation Evaluation`** | W1 (2026-07-22, vs `@v1`, no Ordinal conclusions carried): Candidate-Boundary resolved (canonical value-equality; ≠ identity-equality / semantic-equivalence) · no known legal decomposition · not §2.9-View · C1 holds · C2 was CLASS-UNRESOLVED. **EQ-CF1 (2026-07-29, vs `@v1.1` / §6b, examined independently of Ordinal):** FITS `Canonical Relation Evaluation` — D1/D6/TK/Ownership/Output/Hidden-Guard/value-vs-identity/value-vs-semantic/Boundary-Preservation all PASS; no OQ required for fit. **NOT a ratified member** — no §2 / operatorId / Primitive# / C1–C8-complete / Ledger-Member; Class-Fit ≠ Membership. Deferred (W2/Contract): normalization-visibility · authorized-equivalence-domains · null-equality. **W2 owner-accepted 2026-08-06 (§K) → CONTRACT-PENDING; subsequent W3 design decisions are not materialized by §K; W3 design-axes record materialized (§L); not ratified; no §2/operatorId/Primitive#/Contract-ID allocation.** | 2026-07-22 / 2026-07-29 / 2026-08-06 |
| §0 Nature & Authority Model | L0 | RATIFIED | — | 2026-07-17 |
| §1 Ratification Protocol | L0 | RATIFIED | — | 2026-07-17 |
| §2 Per-Operator Entry Template | L0 | CORRECTED | Added per-field `provenance:` tag + Governance Note (template is design-source, not a PART A quote/publication; future PART A must stay consistent or carry a Decision Record) | 2026-07-17 |
| §2.5 Taxonomy — Contract/Law (7th) | L0.5 | RATIFIED | classification-only category, NOT an operator / NOT in inventory (boundary) | 2026-07-17 |
| §2.5 Taxonomy — Runtime Utility | L0.5 | RATIFIED | classification label only, not a managed PART B inventory | 2026-07-17 |
| §2.5 Criteria C2,C3,C4,C5,C6a,C7,C8 | L0.5 | RATIFIED (ENTAILED) | derived from locked principles | 2026-07-17 |
| **Amendment A3 — §2.5 C2 Reconciliation** | L0.5 | **CORRECTED · Owner-ratified** | Targeted reconciliation of Criterion C2 (three occurrences: §2.5-B / §2.5-C step 4 / §2.5-D) from "FRAMING xor REDUCTION" to "exactly one ratified operator class under the PART A taxonomy". **Trigger:** Amendment A1 / PART A §6b added a ratified third class. **Defect exposed by:** Ordinal W6 Closure Battery (C2). **Authority:** Owner-ratified targeted reconciliation (no new DR — the substantive third-class decision was already ratified in Amendment A1). **Scope:** the three C2 occurrences in §2.5 ONLY. **Semantic preservation:** exactly-one-class unchanged (now rejects both zero-class and multi-class). **Taxonomy authority:** PART A remains the SOLE source of truth for the ratified class set (no class list embedded in §2.5). NOT a PART A clause change (unlike A1/A2); numbered A3 for amendment continuity. 4 primitives unchanged (no reclassification); Ordinal now passes C2 via its single CRE assignment | 2026-07-31 |
| **Amendment A4 — C4 Side-Effects Explicitness Reconciliation** | L0.5 | **CORRECTED · Owner-ratified** | Adds `no side effects` to Criterion C4 (§2.5-B) as an explicit, independently enumerated prohibition alongside `no state`, `no schedule`, and `no inference`. **Trigger:** DEFECT-2 / C4 Source-Text Audit (ST-2). **Grounds:** the Explicit-Only closure requirement — the prohibition was omitted from C4's explicit enumeration — and ratified operator-contract precedent: Partition, IntervalMembership, and GapSegmentation already commit to `no side effects` as a separate explicit item. **Does NOT derive the prohibition from `pure function`.** Does not modify determinism, statelessness, schedule, inference, or the meaning of any existing C4 commitment. **Scope:** §2.5-B only; §2.5-C and §2.5-D remain unchanged, and `schedule` is preserved. No new DR is required because the owner is ratifying a targeted reconciliation of the existing C4 membership criterion on the independent grounds stated above. **Classification:** Normative Explicitness Reconciliation — not documentation-only, not semantic derivation, and not a new class or projection rule. **Normative HOME:** C4 §2.5. **Impact:** Partition, IntervalMembership, and GapSegmentation remain conformant without edits; Count remains deferred under SF-1; Ordinal becomes eligible for explicit C4 projection in the continuing resolution of DEFECT-2. | 2026-07-31 |
| §2.5 Criterion C6b (coverage-declaration) | L0.5 | DEFERRED | stays under OQ-39; NOT decided via membership | 2026-07-17 |
| §2.5 Classification Procedure ordering | L0.5 | RATIFIED (CHOICE) | procedural convention, NOT a semantic principle / not an identity condition | 2026-07-17 |
| §2.5 Criterion C1 (irreducibility) | L0.5 | RATIFIED (Option C) | hard membership requirement; composites → Patterns library | 2026-07-17 |
| §2.7 Pattern-Library Boundary (6 principles) | L0.5 | RATIFIED | boundary only, no full SPEC | 2026-07-17 |
| §2.5 AS A WHOLE | L0.5 | RATIFIED | ratified as a block w/ all above decisions integrated | 2026-07-17 |
| Proof 1 — Coverage-Gate | L1 | REJECTED (as operator) | framing-residue stays a separate OPEN proof; OQ-39 untouched | 2026-07-17 |
| Proof 2 — Partition | L1 | PROOF-REQUIRED | conditionally approved; blocked on Output Contract D1–D3 + OQ-04 (§3.2) | 2026-07-17 |
| Proof 2 — Window, Identity-Join | L1 | PROOF-REQUIRED | Output-Contract must confirm overlap / cross-source linkage | 2026-07-17 |
| Proof 3 — Sequence, Trend, Conflict | L1 | PROOF-REQUIRED | Trend leans reject-as-primitive; Conflict only if structural grounds-model | 2026-07-17 |
| **Partition** | L1 | **RATIFIED — Primitive Operator #1 — FRAMING** | Bundle B; Option (ii) precondition; C6=C6a; contract pinned as `Partition/contract@v1-2026-07-17` (§3.2/§3.3). Future SEMANTIC change routes through versioningRule (field 10). Non-blocking: OQ-04 schema · OQ-39 coverage · external precondition/execution contract | 2026-07-17 |

| C1 Standard — REFINED (§2.8) | rules | RATIFIED | known-decomposition (not absolute); implementation≠semantic decomposition; forward-compat via DR | 2026-07-17 |
| **Window (monolith)** | L1 | **REJECTED** | no single purpose/Output Contract | 2026-07-17 |
| Window — tumbling / single-bounded | L1 | RESOLVED | = `Partition` usage/pattern (not new primitives) | 2026-07-17 |
| **IntervalMembership** (ex-OIFC, from Window overlap residue) | L1 | **RATIFIED — Primitive Operator #2 — FRAMING** | Bundle O-2; contract `IntervalMembership/contract@v1-2026-07-17` (§3.5/§3.6). Output = `FrameSet(IntervalFrame)` + typed `UnframedComplement`; zero-width (`start<end`) & duplicate instances REJECTED in precondition (no silent dedup); C6=C6a. Focused delta-closure (fields 4/5/9+precondition) passed — no identity/replay/composition break. Non-blocking: OQ-39 coverage · external precondition/execution contract | 2026-07-17 |
| Window — session/gap segmentation | L1 | PROOF-REQUIRED (NEXT) | different boundary mechanism (relation-derived); threshold proof opening 2026-07-18 | 2026-07-17 |
| Relational View Principle (§2.9) | rules | RATIFIED | Relation View ≠ Formation; a View alone ≠ Primitive; blocks Join/Pair/CrossMatch/Neighbor/Association as framing primitives | 2026-07-18 |
| **Identity-Join** | L1 | **REJECTED as FRAMING primitive** | grouping ≡ `Partition`-by-resolvedIdentity (Swap-Test passed). `Identity Grouping` = usage of Partition, not a new operator | 2026-07-18 |
| Pair/Tuple Enumeration (ex-Identity-Join residue) | L1 | **OPEN** — unclassified | proven only NOT-FRAMING; family (Reduction / utility / readout / Pattern / non-operator) undetermined — separate proof | 2026-07-18 |
| Relation-Derived Labeling | L1 | **REJECTED as Operator** | implementation/representation detail of a Formation; arbitrary labels, no independent consumer, unifies non-homogeneous mechanisms (fails 5/6 conditions) | 2026-07-19 |
| Boundary Marking | L1 | **NOT an Operator** — internal metadata/utility | break markers = internal derivation evidence of FixedGapSegmentation; not an independent Output Contract | 2026-07-19 |
| **GapSegmentation** (ex-FixedGapSegmentation/S-B) | L1 | **RATIFIED — Primitive Operator #3 — FRAMING** | Bundle F-1 + 3 corrections; `GapSegmentation/contract@v1-2026-07-19` (§3.7/§3.8). Output = `SegmentSet` (registered scope type). Maximal disjoint runs, `gap≤threshold` connects, single scope, single-membership, content-derived segmentId, member-summary bounds. v1 scope guard (no adaptive/per-ground/predicate/multi-stream). Closure PASSES. Inherits §2.10 | 2026-07-19 |
| §2.10 Empty Ground Set | rules | **RATIFIED** | general Grammar rule; empty population ≠ empty configuration; canonical empty projection per operator; no fabrication. Partition & IM inherit (documentation-only, no reopening) | 2026-07-19 |
| `SegmentSet` scope type | type | **REGISTERED** | Segment{segmentId, members, min/maxMemberCoordinate}; invariants per Register; downstream fields excluded from v1 | 2026-07-19 |
| **FRAMING FAMILY** | family | **CLOSED FOR CURRENT INVENTORY** | Partition · IntervalMembership · GapSegmentation ratified; all known FRAMING candidates decided (Window/IdentityJoin/RDL/BoundaryMarking/general-boundary/multi-stream rejected or = usage/Composite). "Current inventory" — future primitives not precluded | 2026-07-19 |
| §3.10 Child-Input Identity Model + `PartitionSubset` + `Segment` registered | type/doc | **REGISTERED (documentation-only)** | SCOPE-C; parent-Projection-id + canonical child selector; NO FRAMING contract change; NO Scope abstraction | 2026-07-22 |
| **Count** | L1 | **RATIFIED — Primitive Operator #4 — REDUCTION** | `Count/contract@v1-2026-07-22` (§3.9/§3.10). Owner-ratified 2026-07-22. Closure CLEAN + Final Delta-Closure CLEAN. Cardinality of memberships of ONE supported scope; allow-list {PartitionSubset·IntervalFrame·UnframedComplement·Segment}; arbitrary non-negative integer (canonical decimal); `Count(valid empty scope)=0` (**LOCAL rule**, zero≠absence, failure≠0); identity EXCLUDES value (value in content-digest); no known decomposition. **empty→0 is LOCAL to Count — NOT a general REDUCTION rule; Count does NOT pre-fix future REDUCTION input/output/empty structure (each needs its own proof).** Out of v1: Raw · Container-Count · general-empty-rule · Reduction→Reduction · SCOPE-B · OQ-39 · Aggregate-decomposition. Finding-1 WITHDRAWN (C8 PASS; C8=operator-inventory-independence, satisfied — input via explicit type-Compatibility, not operator dependence) | 2026-07-22 |
| **Ordinal** | L1 | **RATIFIED — Primitive Operator #5 — Canonical Relation Evaluation** | `Ordinal/contract@v1-2026-07-31` (§J). **Owner-authorized ratification 2026-07-31 following W6 Closure Battery CLEAN PASS** (C1–C8 PASS; Cross-layer PASS; 2 OUT-OF-SCOPE justified). **First ratified member of Canonical Relation Evaluation** (the third operator class). operatorId `Ordinal`. Canonical order-evaluation of two peer relata over ONE qualified total-order domain → `LESS`/`EQUAL`/`GREATER`; determinism/statelessness (pure function; no state/schedule/inference/side effects) projected from C4 §2.5 via CPT-1 (IMP-1) into §J field 8. DEFECT-1/C2 closed via Amendment A3; DEFECT-2/C4 closed via Amendment A4 + Projection Catalog CPT-1 + IMP-1 + §J projection. Out-of-contract: wire-encoding (Platform), Composition, finite-outcome, Scope-relations, coverage (OQ-39). SF-1/SF-2 unaffected; Count/Equality unchanged; no new class; no Primitive renumbering | 2026-07-31 |

### Ratified Operator Classes Register

> **SNAPSHOT of the current ratified operator-class inventory** (`PART-A-replacement@v1.1`) — NOT a Ledger of decisions. Governance: a Register entry is NOT itself a Ratification (the §4 Ledger holds the decision events); a **Candidate is NOT a Member**; a change in Candidate status is NOT a change in Class; **adding a Member requires completing W1–W9 + a separate Operator ratification**. This Register lists ratified members and formally-recorded class-addition candidates; in-progress operator-inventory classification (§3 — e.g. tentative REDUCTION primitives under PROOF) is tracked in §3 + the §4 Ledger, not duplicated here.

**`FRAMING`**
- **Status:** `RATIFIED` · **Version/date:** PART A `@v1` (2026-07-22)
- **Authority:** PART A §5 + ratified operator contracts
- **Transformation Kind:** creation of new Scope Formation (membership / boundaries / grouping over an input set)
- **Input/Output boundary:** consumes grounds / prior Projection → output ∈ Scope Category
- **Ratified members:** `Partition` · `IntervalMembership` · `GapSegmentation`
- **Active candidates:** none currently recorded
- **Composition:** per PART A §9
- **Full definition:** PART A §5

**`REDUCTION`**
- **Status:** `RATIFIED` · **Version/date:** PART A `@v1` (2026-07-22); first member `Count` ratified 2026-07-22
- **Authority:** PART A §6 + `Count` ratification
- **Transformation Kind:** consumes supported Scope(s) → non-Scope readout by reducing the Scope's structural information (no Formation)
- **Input/Output boundary:** input = supported Scope(s) → output = non-Scope readout
- **Ratified members:** `Count`
- **Active candidates:** none recorded (`Ordinal`/`Equality` are NOT recorded here — they are candidates of `Canonical Relation Evaluation`)
- **Composition:** `Reduction→Framing` FORBIDDEN · `Reduction→Reduction` OPEN [OPEN-Q2]
- **Full definition:** PART A §6

**`Canonical Relation Evaluation`**
- **Status:** `RATIFIED · EFFECTIVE` · **Effective date:** 2026-07-24 (PART A `@v1.1` / §6b)
- **Authority:** `DR-C1-PARTB-CLASS-01` + PART A Amendment A1
- **Transformation Kind:** canonical domain-fixed relation evaluation (D6) between peer relata consumed contract-opaquely (D1) → canonical relation-specific typed outcome
- **Input/Output boundary:** input = two peer relata (contract-opaque; not Scope-structural) → output = relation-specific canonical typed outcome (NOT Scope, NOT Quantity, NOT Judgment)
- **Ratified members:** `Ordinal` — Primitive Operator #5, `Ordinal/contract@v1-2026-07-31`, ratified 2026-07-31 (first member of this class)
- **Active candidates:** `Equality` — `CLASS ASSIGNED · W2-ACCEPTED · CONTRACT-PENDING · NOT A RATIFIED MEMBER` (EQ-CF1 2026-07-29; W2 owner-accepted 2026-08-06, §K). (`Ordinal` is no longer an active candidate — it is now a ratified member, above.)
- **Composition:** `OPEN`
- **Full definition:** PART A §6b + PA-B §A–§B

### Ratified Contracts Register
- **`Partition/contract@v1-2026-07-17`** — Primitive Operator #1, class FRAMING. Frozen text = §3.2 (11 fields) + §3.3 (entry precondition). Any change that alters the SEMANTIC Output Contract or criterion schema requires a new contract version via field 10; a purely technical serialization migration is classified per the locked identity/version rules, not auto-bumped.
- **`IntervalMembership/contract@v1-2026-07-17`** — Primitive Operator #2, class FRAMING. Frozen text = §3.5 (11 fields, as corrected) + §3.6 (closure). Multi-membership interval APPLICATION over a pinned interval space. Output = `FrameSet` of `IntervalFrame` + typed `UnframedComplement` (distinct scope types, no silent coercion). Precondition rejects zero-width intervals (`start<end` invariant) and duplicate/identity-less instances (no silent dedup). Does NOT own generation/calendar/session; time is one instantiation. Inherits §2.10 (empty ground set ≠ empty FrameSet). Semantic Output-Contract/boundary/expansion change routes through field 10.
- **`GapSegmentation/contract@v1-2026-07-19`** — Primitive Operator #3, class FRAMING. Frozen text = §3.7 (11 fields, F-1 + 3 corrections) + §3.8 (closure). Purpose = the UNIQUE partition of a SINGLE scope of grounds into maximal disjoint runs where adjacent grounds connect iff `gap ≤ threshold` (uniform fixed pinned threshold). Output = `SegmentSet`. `segmentId` = canonical unordered member-set digest; `min/maxMemberCoordinate` = member summaries (NOT interval bounds). Single-membership + full conservation; empty segments impossible; no UnframedComplement; not an ordered series. Inherits §2.10 (empty ground set → empty `SegmentSet`). v1 scope guard: single fixed threshold only; adaptive/per-ground/per-pair/accumulated/attribute/predicate/calendar/multi-stream each need a new proof. Semantic change routes through field 10.

- **`Count/contract@v1-2026-07-22`** — Primitive Operator #4, class **REDUCTION** (the FIRST reduction; establishes the REDUCTION contract TEMPLATE — but does NOT force future reductions to adopt its input/output/empty structure without their own proof). Frozen text = §3.9 (11 fields) + §3.10 (child-input identity model). **Purpose:** deterministic cardinality of memberships of a SINGLE supported pinned scope. **Supported inputs (explicit compatibility; no structural typing / no auto-extension):** `PartitionSubset` · `IntervalFrame` · `UnframedComplement` · `Segment`. **Output:** arbitrary non-negative integer, canonical base-10 decimal (`"0"` the only zero). **Empty:** `Count(valid empty scope)=0` — LOCAL rule (NOT a general REDUCTION rule); zero≠absence; failure NEVER→0. **No semantic parameters (v1).** **Exclusions:** containers/`scopeCount` · Raw GroundSet · distinct/filter/weight/coverage/percentage/comparison/trend. **Identity:** value NOT in semantic identity (in content-digest); child input identified by parent-Projection-id + canonical selector (§3.10). **Coverage non-claim** (C6a; OQ-39 open). No known legal decomposition. Semantic change routes through field 10.

- **`Ordinal/contract@v1-2026-07-31`** — Primitive Operator #5, class **Canonical Relation Evaluation** (the FIRST member of the third class). Frozen text = §J (11 fields; §2 Contract projected verbatim from Bundle §I). **Purpose:** deterministic evaluation of the canonical order relation between two peer relata of one qualified total-order domain, emitting exactly one of three Canonical Relation States `LESS` / `EQUAL` / `GREATER`. **Inputs:** two peer relata, same qualified domain identity+version, no conversion (A1/A2/A3/F4/D1/D4). **Output:** three Canonical Relation States (B1a); normative representation invariants owned by Ordinal, operational realization Platform (B1b-1); canonical direction, no direction parameter (C1). **Identity:** subject = the comparison operation; outcome a deterministic consequence, not part of identity (F1). **Determinism/statelessness:** pure function; no state / schedule / inference / side effects — projected verbatim from C4 §2.5 via CPT-1 (registered by IMP-1) into §J field 8; plus B2/F1/F3. **Failure:** Contract Failures only (F3; No Invocation / Contract Failure / Execution Failure three-layer boundary). Out of contract: wire encoding (Platform-owned), Composition, class-level finite-outcome, Scope relations, coverage (OQ-39), descending/collation/timezone/unit mechanisms. W6 Closure Battery CLEAN PASS; DEFECT-1 (C2) closed via Amendment A3; DEFECT-2 (C4) closed via Amendment A4 + CPT-1 + IMP-1 + §J projection. Semantic change routes through versioningRule (§J field 10).

### Projection Catalog

Canonical projection renderings. Each CPT is a rendering artifact only—not an authority, registry, contract, lock, requirement, criterion, or decision. Normative authority always remains the cited HOME. A CPT holds the single approved text that dependent registrations may project verbatim.

CPT identifiers are rendering identifiers only and carry no normative meaning. Authority changes require review of every dependent CPT and registration; CPT changes require explicit approval and must not occur silently.

Fidelity is verified across two separate boundaries:
1. Authority ↔ CPT semantic and source fidelity.
2. CPT ↔ projected contract verbatim fidelity.

§I contains registration metadata only and does not duplicate CPT text.

**CPT-1**
- **Authority (HOME):** C4 (§2.5), Primitive-Operator membership criterion; explicit enumeration reconciled by Amendment A4.
- **Canonical Projection Text:** "Per C4 (§2.5): Determinism & statelessness — pure function; no state / schedule / inference / side effects."
- **Binding:** CPT-1 is the approved canonical projection rendering of C4 §2.5. Authority remains C4. CPT-1 does not define, modify, interpret, qualify, or replace C4 and is not an authority, registry, contract, lock, requirement, criterion, or decision.

### Registered Scope Types
- **`SegmentSet`** (from `GapSegmentation`) — a set of `Segment` scopes. Each `Segment` carries: `segmentId`, member ground references, `minMemberCoordinate`, `maxMemberCoordinate`. Invariants: no empty segment · every ground in exactly one segment · no overlap · ⋃members = input · each segment maximal per gap rule · identity from canonical member set · bounds are member summaries only · not an ordered series. Excluded from v1 (downstream/Composite concerns): ordinal · previous/nextSegmentId · duration · gapFromPrevious · session status · minimum size · role · streamKey.
- (`IntervalFrame`, `UnframedComplement` — from `IntervalMembership`, §3.5.)
- **`PartitionSubset`** (from `Partition`) — REGISTERED as an existing semantic CHILD output of a Partition Projection (a disjoint subset). **Registration-only (documentation): NO new operator contract, NO change to the Partition contract, NO Scope superclass/interface/capability.** Type status: semantic child output. Canonical selector: a category key, or the `UNCLASSIFIED` role. Identity derives from parent Partition Projection identity + selector (§3.10). Members derive deterministically from parent snapshot + criterion + selector.
- **`Segment`** (from `GapSegmentation`) — REGISTERED as a semantic CHILD output type. Parent output: `SegmentSet`. Status: semantic child output. Canonical child selector/identity: **GapSegmentation Projection identity + `segmentId`** (`segmentId` = canonical member-set digest, ratified). Consumable as a standalone child output. **NO independent operator, NO semantic change to the GapSegmentation contract, NO general parent type, NO Register schema change.**
