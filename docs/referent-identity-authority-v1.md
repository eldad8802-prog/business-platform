# RIA-1 · Referent Identity Authority Contract v1

**Status:** RATIFIED · **Version:** v1 · **Scope:** semantic / governance contract, implementation-independent.

> This document materializes the already-ratified RIA-1 §0–§9 semantic contract as the in-repo source of authority. It introduces **no** new semantic decisions, changes **no** locks, and defines **no** production matching heuristics, DB representation, APIs, or feature wiring. Per-turn verification scans, ratification checklists, and drafting recommendations from the ratification dialogue are intentionally omitted (canonical corpus, not transcript); every normative lock, OPEN/DEFERRED item, and guard is preserved with its ratified identifier.

## Authority & Relationship to C0 and Detection Grammar
RIA is **post-C0**. It consumes immutable C0 Evidence (CanonicalObservation accounts) and emits Identity Assertions and derived Identity State (the Current Identity Interpretation). It never mutates C0. Detection Grammar and other reasoning layers **consume** RIA's resolved/aligned identity but do **not** own identity resolution. Product features do **not** own RIA authority.

```
Source Features → Translators / C0 → CanonicalObservation / Evidence
  → RIA (Identity Authority) → Current Identity Interpretation
  → Detection Grammar / reasoning → downstream Belief / Judgment layers
```

## Terminology
Canonical Referent (identity anchor), Source Referent Binding (grounds from a C0 account), Authority-Capable Source vs Authorized Basis, Identity Assertion (immutable), Identity State / Current Identity Interpretation (derived), SAME / DISTINCT / UNRESOLVED (relation outcomes), CONFLICT (derived state-health), Method Policy / Minting Policy, Recorded-time vs Effective-time, EvaluationTime, Knowledge-As-Of / Effective-State-At / Historical-Execution-Replay. Definitions are normative within the sections below.

---

# RIA-1 · §0 — Purpose, Layer Boundary & Non-Negotiable Invariants

**Working glossary (normative terms for §0; not yet a registry):**
- **Source Referent Binding** — the translator-asserted `identityBinding` carried on a C0 `CanonicalObservation` (grounds; "what the source claimed about who/what it is about").
- **Canonical Referent** — the per-tenant canonical identity to which one or more Source Referent Bindings may resolve.
- **Referent Identity Assertion (RIA-A)** — a single, provenance-bearing, versioned RIA determination relating a Source Referent Binding (or a Canonical Referent) to a Canonical Referent. Its **outcome-state model** (conceptually: establish-sameness · establish-distinctness · withhold-resolution) is **not yet encoded or locked** (§0.7 I4).
- **Referent Identity State** — the corrigible, versioned aggregate of RIA-A's; a **corrigible derived identity state — not Evidence and not a Business Belief**. *(Term settled; the historical "belief-producer" label is not adopted. The exact internal representation/structure of the State remains OPEN, §0.9 R3.)*

## §0.1 · Purpose
> RIA is the single **per-tenant authority** that determines the **canonical referent identity relation** between Source Referent Bindings (as carried on immutable C0 Canonical Observations) and Canonical Referents — with the authority to **establish sameness**, **establish distinctness where authoritative grounds exist**, or **explicitly withhold resolution** where sufficient authority is absent — so that Evidence originating in different Feature Domains may be reasoned about together **without inventing sameness**: traceably, deterministically-replayably, and corrigibly. The precise outcome-state encoding is **not ratified here** (§0.7 I4).

| # | Invariant | Tag |
|---|---|---|
| P1 | RIA exists solely to **establish or withhold canonical referent identity relations**; it is not a reasoning engine, not a matcher-of-record, and produces no business conclusion. | **RATIFY-NOW** |
| P2 | RIA is **required before** any cross-source reasoning that depends on referent identity; absent an RIA determination, cross-source alignment is illegal (an invented join). | **RATIFY-NOW** |

## §0.2 · What RIA OWNS
| # | Invariant | Tag |
|---|---|---|
| O1 | RIA owns every **cross-source canonical-identity determination** between Source Referent Bindings and Canonical Referents. *(The exact outcome-state model is OPEN, §0.7 I4 — not locked here.)* | **RATIFY-NOW** |
| O2a | RIA owns **canonical identity authority and namespace semantics** for Canonical Referents (tenant-scoping, versioned lifecycle of Assertions). | **RATIFY-NOW** |
| O2b | **Who mints Canonical Referent IDs** — RIA itself vs a separate canonical-entity system that RIA merely references — is **not decided here**. | **OPEN** |
| O3 | RIA owns the **provenance and version** of each Referent Identity Assertion. | **RATIFY-NOW** |
| O4 | Cross-domain / cross-representation identity is resolved **above** the entities/bindings and **never** via a cross-domain foreign key or raw-string aggregation. | **INHERITED** — Party Strategy §4, §6(#3,#4) (ratified, main) |

## §0.3 · What RIA explicitly does NOT own
| # | Invariant | Tag |
|---|---|---|
| N1 | RIA does **not** own or produce **Evidence**. It never creates, edits, deletes, re-seals, or re-times a C0 Canonical Observation. | **INHERITED** — C0 report §9/§11 + append-only identity model (main) |
| N2 | RIA does **not** own **business meaning / Phenomenon-Belief / Judgment**. A Referent Identity State is **not** a Business Belief and must not be labelled or consumed as one. | **RATIFY-NOW** |
| N3 | RIA does **not** own **Concept meaning, Value, Coverage, or observation-Provenance** — those remain C0/registry-owned. | **INHERITED** — C0 `normalize`/registries (main) |
| N4 | RIA performs **no** Detection-Grammar operator evaluation and is **not** a Detection-Grammar primitive. | **RATIFY-NOW** |
| N5 | The **Translator** may describe what a source claims/supplies (a Source Referent Binding = grounds) but is **not** the final authority on cross-source canonical identity. | **RATIFY-NOW** |

## §0.4 · Layer Position
> **Source Features → Translators → C0 (immutable Canonical Observations w/ Source Referent Bindings) → RIA (corrigible Referent Identity State) → legally-aligned grounds → Detection Grammar → Business Belief / Judgment.**

| # | Invariant | Tag |
|---|---|---|
| L1 | **Final cross-source canonical identity authority does not occur before or inside C0 normalization.** Translators/C0 may still carry **authoritative source identity claims as grounds**; RIA is the layer that interprets those grounds as cross-source canonical identity authority. | **RATIFY-NOW** |
| L2 | RIA consumes only `readonly` C0 outputs (Canonical Observations + their Source Referent Bindings) and its own prior Assertions. | **INHERITED** — C0 §11 boundary ("C1 may receive readonly accounts") |
| L3 | RIA emits **aligned grounds** (a resolved-referent view) downstream; it hands nothing back into C0. | **RATIFY-NOW** |

## §0.5 · Immutable Evidence vs Corrigible Identity State
| # | Invariant | Tag |
|---|---|---|
| E1 | Evidence (C0 Canonical Observation) is **immutable and append-only**; a Referent Identity Assertion is **corrigible**. | **INHERITED** — C0 append-only (main) |
| E2 | A changed identity understanding is represented **forward-only** — a new / superseding Assertion under a new version — **never** by mutating Evidence or a prior Assertion in place. | **RATIFY-NOW** |
| E3 | The identity artifact is a **corrigible derived identity state — not Evidence and not a Business Belief.** *(Term settled; representation/structure of the State: §0.9 R3 OPEN.)* | **RATIFY-NOW** |

## §0.6 · Tenant Isolation
| # | Invariant | Tag |
|---|---|---|
| T1 | Canonical Referent identity is **business/tenant-scoped**. The same real-world entity participating in two different businesses **does not thereby become one shared Business-Brain Canonical Referent**. | **INHERITED + RATIFY-NOW** — `Party.businessId` + Party Strategy (main); principle extended here to generic referents |
| T2 | No RIA Assertion may relate bindings across tenants; cross-business identity reasoning is forbidden. | **RATIFY-NOW** |
| T3 | Whether the tenant is carried **inside** the Canonical Referent identity, or the **namespace is scoped by tenant**, or **both** — not decided here. | **OPEN** |
| T4 | Enforcement location (RIA boundary · DG execution boundary · impossible-by-construction) and the **failure semantics** of a cross-tenant attempt — defense-in-depth preferred, but must be contract-justified, not invented. | **OPEN** |
| T5 | **A tenant mismatch must never degrade into an identity outcome** (it is never SAME, DISTINCT, or UNRESOLVED). Cross-tenant input is a **boundary violation / inadmissible invocation**, not an identity result. *(Exact failure family: OPEN, cross-ref T4.)* | **RATIFY-NOW** (principle) · **OPEN** (failure family) |

## §0.7 · Non-Invention
| # | Invariant | Tag |
|---|---|---|
| I1 | Absence of an authoritative identity relation is **never** converted into sameness. | **RATIFY-NOW** *(evidence: Party §6#3 no-string-authority)* |
| I2 | Inability to prove SAME is **not** proof of DISTINCT. | **RATIFY-NOW** |
| I3 | Under uncertainty, bindings **remain unmerged and separately attributable**; uncertainty must **not** be silently collapsed into sameness. *(Whether to raise a flag / task / suggestion / review is product/workflow behavior — out of §0, deferred.)* | **RATIFY-NOW** |
| I4 | The intended conceptual state set is **establish-sameness / establish-distinctness / withhold-resolution**; the encoded triple (e.g. `SAME / DISTINCT / UNRESOLVED`) is **not locked** until its dedicated Contract Proof (why UNRESOLVED≠DISTINCT; why failure-to-prove-SAME≠DISTINCT; what authority yields DISTINCT; SAME/DISTINCT evidence-burden symmetry; SAME↔DISTINCT correction without rewriting Evidence). | **OPEN** |
| I5 | **No transitive invention.** RIA may not infer an identity relation merely because two bindings each share some **non-authoritative** attribute or intermediary relation — e.g. same name; same phone without an authorized method-policy; same address; same invoice-counterparty text; both probabilistically linked to a third candidate. *(Transitivity of SAME itself — if/when SAME becomes a canonical equivalence relation — is deferred; no invented transitive joins now.)* | **RATIFY-NOW** |

## §0.8 · Provenance
| # | Invariant | Tag |
|---|---|---|
| PR1 | Every Referent Identity Assertion is **provenance-bearing** — it can explain *on what basis* it relates a binding to a Canonical Referent. | **RATIFY-NOW** |
| PR2 | Provenance must at least suffice to preserve **re-attribution** (which downstream grounds were aligned under which Assertion/version). | **RATIFY-NOW** |
| PR3 | The **exact provenance field set** (binding · canonical referent · method · authority · timestamp · version · evidence · tenant · human-vs-machine · supersession-link) — beyond the explainable + re-attributable principle — is specified later. | **DEFERRED** |

## §0.9 · Replayability
| # | Invariant | Tag |
|---|---|---|
| R1 | RIA is **replayable**: any reasoning relying on a resolution must be able to determine **which Identity State / Authority / Policy version** established the relation. | **RATIFY-NOW** |
| R2 | RIA determinations are **versioned**; a determination is bound to the version under which it was made. | **RATIFY-NOW** |
| R3 | The **mechanism** (RIA snapshot/version · identity-graph snapshot · assertion-set digest · `ReplayDependencyContext` extension · operation-level manifest) — and the internal representation of the Referent Identity State — is a **requirement only** here, not chosen. | **OPEN** |
| R4 | Replay must **preserve the identity state actually used by the historical reasoning operation**; replay must **not** silently substitute today's corrected identity state **unless the execution mode explicitly requests reprocessing under a newer identity version**. | **RATIFY-NOW** (principle) · **OPEN** (encoding) *(parallels C0 replay modes: HISTORICAL_REPLAY vs REPROCESS_NEW_EPOCH — main)* |

## §0.10 · Generic Applicability
| # | Invariant | Tag |
|---|---|---|
| G1 | RIA is a **generic Referent Identity foundation** for **PARTY, RESOURCE, COMMITMENT** — not a Customer/Supplier matcher. | **RATIFY-NOW** *(evidence: C0 referent-taxonomy PARTY/RESOURCE/COMMITMENT — main)* |
| G2 | Customer / Supplier / Lead / Payee / Payer are **roles / business representations of a Party**, not separate identity universes, **where consistent with the Party architecture**. *(This is identity **semantics** only — it does NOT mandate migrating any product Customer/Supplier schema into roles.)* | **INHERITED** — Party Strategy §Tier-3 (main) |
| G3 | Per-type resolution **nature** (PARTY & RESOURCE = continuous identity; COMMITMENT = identity **derived** from the entities it connects + lifecycle) is acknowledged; concrete rules specified later. | **DEFERRED** |
| G4 | **EVENT** as primitive vs dissolved is **not decided**; RIA-1 will present the contradiction + implications; deferred unless required to close PARTY/RESOURCE/COMMITMENT v1. | **DEFERRED** |

## §0.11 · Deferred from v1
| # | Item | Tag |
|---|---|---|
| D1 | Concrete resolution methods / authority-level taxonomy (Authoritative-deterministic · Verified-external-identifier · Evidence-signal · Candidate-probabilistic · Human-confirmed) + versioned method-policy. **"Name alone is never identity authority"** carried forward. | **DEFERRED** (name-never-authority = **INHERITED**, Party §6#3) |
| D2 | Exact provenance schema (PR3). | **DEFERRED** |
| D3 | Outcome-state model lock + its Contract Proof (I4). | **OPEN** |
| D4 | Replay mechanism + State representation (R3). | **OPEN** |
| D5 | Tenant representation (T3) · enforcement-location + failure semantics (T4/T5). | **OPEN** |
| D6 | Canonical Referent ID minting/lifecycle (O2b). | **OPEN** |
| D7 | RESOURCE/COMMITMENT concrete resolution rules (G3); EVENT (G4). | **DEFERRED** |
| D8 | Any resolver / schema / runtime. | **DEFERRED** |

---

---

# RIA-1 · §1 — Identity Relation Semantics
## 0 · Framing — Three Disposition Categories (חדש, מכונן)
כל invocation של RIA נופל לאחת **שלוש קטגוריות דיספוזיציה נפרדות ובלעדיות**; **אף אחת אינה מתחזה לאחרת:**
1. **Relation Outcome (healthy, valid)** — קביעת-יחס-זהות תקינה: `SAME / DISTINCT / UNRESOLVED`.
2. **Failure / Invalid Invocation** — מחוץ ל-relation domain: tenant-mismatch (§0 T5) · cross-type · malformed · unsupported referent-type · missing-required-version · corrupt-authority-state · internal-defect.
3. **State-Health Condition** — `CONFLICT`: קיימות Assertions authoritative **בתוקף** וסותרות; **אין יחס-זהות שמיש** לזוג. **CONFLICT אינו Relation Outcome ואינו Failure-invocation — הוא בריאות-State.**
**RS0 · Category Separation.** Relation Outcome ≠ Failure ≠ State-Health. אין masquerade בין הקטגוריות. **RATIFY.**

## 1 · Executive §1 Verdict
> **RATIFY (scoped)** — סמנטיקת-היחס ניתנת-להוכחה ועקבית. ה-encoding `SAME | DISTINCT | UNRESOLVED` מומלץ לנעילה כ-**relation-outcome set (healthy valid בלבד)**, סוגר §0 I4. **חריג יחיד שנשאר OPEN:** סמנטיקת **DISTINCT בצורת binding→referent** (לא הוכחה זהה ל-referent↔referent). CONFLICT מנוסח מחדש כ-state-health (לא UNRESOLVED).

## 2 · Two Forms of the Relation (חדש — הפרדה מפורשת)
RIA מפעיל **מנוע-סמכות אחד** על **שתי צורות** (אין engines נפרדים):
- **Form-1 · Binding Resolution:** `Source Referent Binding → Canonical Referent` (attachment/resolution של binding לזהות-קנונית).
- **Form-2 · Canonical Identity Relation:** `Canonical Referent ↔ Canonical Referent` (יחס בין שתי זהויות-קנוניות).
**תחולת המצבים על הצורות:**
| מצב | Form-1 (binding→referent) | Form-2 (referent↔referent) |
|---|---|---|
| SAME | **חל** (binding מתחבר ל-R אחד) | **חל** (⟹ reconciliation, §9) |
| UNRESOLVED | **חל** | **חל** |
| DISTINCT | **OPEN** — לא הוכח שסמנטיקת "binding אינו denotes R" זהה ל-affirmative-non-identity | **חל** (affirmative non-identity) |
**RS2-FORM.** SAME ו-UNRESOLVED חלים זהה על שתי הצורות; **DISTINCT ב-Form-1 נשאר OPEN** עד הוכחה נפרדת. **RATIFY** (עם OPEN מסומן).

## 3 · SAME — Contract Proof
**טענה:** A **SAME** B ⟺ הם denote **Canonical Referent אחד** באותו tenant ו-identity-domain. affirmative.
- **SAME הוא equivalence relation מלא:**
  - **Reflexive: כן.** `identity(A,A)` עבור Canonical Referent תקף = **SAME** (לא UNRESOLVED, לא DISTINCT). *(אי-יכולת לאדמט/לבנד את A היא Failure — קטגוריה 2 — לא UNRESOLVED.)*
  - **Symmetric: כן.** `A SAME B ⟺ B SAME A`.
  - **Transitive: כן (equivalence).** `A SAME B ∧ B SAME C ⟹ A SAME C`.
- **הבחנה קריטית (§0 I5):** **transitivity מתמטית אינה authority לייצר SAME-assertions חדשים ע"י pairwise chaining.** RIA **אינו רשאי לחתום** assertion חדש `A SAME C` רק כי קיימות שתי Assertions. היחס הטרנזיטיבי **נצרך דרך canonical identity state authority** (חברות ב-Canonical Referent אחד), לא דרך שרשור-זוגות. → **מתמטיקה = כן; invented-pairwise-authority = לא.**

## 4 · DISTINCT — Contract Proof (הזהיר ביותר)
**טענה:** A **DISTINCT** B ⟺ *affirmatively known **not** to denote the same canonical entity* — **לא** "failed to prove SAME" (§0 I2). דורש **affirmative distinctness authority**.
- **Evidence-burden (סוג-סמכות; policy נדחה D1):** affirmative distinctness authority. דוגמאות-לניתוח (לא נעולות): שני authoritative-internal-IDs שונים · שני external-identifiers מאומתים-שונים · source ש**מבחין מפורשות** · mutually-exclusive lifecycle facts · human-confirmation.
- **D1 · Symmetric: כן.**
- **D2 · Transitive: לא.** `A≠B ∧ B≠C ⇏ A≠C`. **non-transitive.**
- **Reflexive: irreflexive** (`A DISTINCT A` לעולם לא).
- **D3 · DISTINCT בתוך cluster שכבר SAME:** **CONFLICT** (§8) — state-health, לא outcome.
- **Form scope:** מוכח ל-Form-2 (referent↔referent). **Form-1 DISTINCT — OPEN** (§2).

## 5 · UNRESOLVED — Contract Proof
**טענה (חיובית):** *RIA currently lacks sufficient authority to establish either sameness or distinctness.* לא error · לא not-found · לא DISTINCT · לא FALSE.
- **U1 · Explicit מול default:** (א) **default (open-world):** היעדר-Assertion בתוקף ⟹ המצב **UNRESOLVED מכללא** (keep-separate, §0 I3); (ב) **explicit UNRESOLVED Assertion** מותר (ל-provenance/replay).
- **U2 · Versioned/corrigible:** explicit = versioned/corrigible; default = פונקציה של קבוצת-ה-Assertions-בתוקף הגרסאית.
- **U3 · Joint same-referent reasoning תחת UNRESOLVED?** **לא** (§0 P2). מוכח.
- **U4 · להסיק DISTINCT מ-UNRESOLVED?** **לא** (§0 I2). מוכח.
- **Symmetry (מתוקן):** ה**שאלה הסמנטית** "האם A זהה ל-B?" **סימטרית**. **ייצוג** ה-explicit-withholding (האם record יחיד מכסה שני הכיוונים) **= OPEN** — לא נועל representation-symmetry שלא הוכחה.
- **Reflexivity (מתוקן):** **N/A** — `identity(A,A)` = **SAME**, לעולם לא UNRESOLVED.

## 6 · Outcome vs Failure
- **Valid Relation Outcome** = `SAME/DISTINCT/UNRESOLVED` (קטגוריה 1).
- **Failure/Invalid** = קטגוריה 2 (§0).
- **אינווריאנט (Outcome-XOR-Failure, מקביל ל-Equality EC2):** *"A valid invocation may legitimately resolve to **UNRESOLVED**. An invalid invocation must **not** masquerade as UNRESOLVED."*
- **Failure-families לא ננעלות** (§0 T4).

## 7 · Open-World Semantics — **RATIFY (חוק-יסוד)**
> **Not-known-SAME ⇏ DISTINCT. Not-known-DISTINCT ⇏ SAME.** ברירת-המחדל = UNRESOLVED. (מגבה I1/I2/I5/U4.)

## 8 · Assertion vs Current vs Historical State  ·  Assertion Immutability (מתוקן)
- **Assertion (record):** **append-only, לא-מְמוּטָּט** — the record itself is immutable. אך ה-**applicability** שלו (האם בתוקף) **ניתנת ל-supersession**.
- **Current Referent Identity State:** **corrigible** — נגזר מקבוצת-ה-Assertions-**בתוקף** כעת.
- **Historical State:** מה שהיה בתוקף בזמן reasoning היסטורי.
- **Correction אינה mutation של historical assertion** — היא Assertion-חדש שמְשַׁנֶּה applicability של קודם.
- **דוגמת t1 SAME → t3 DISTINCT-supersedes-applicability:** Evidence **לא משתנה**; **historical replay של t1 → SAME** (ה-State שהיה בתוקף אז); **current אחרי t3 → DISTINCT** (§0 E1/E2/R4). Coherent.

## 9 · Contradiction Analysis — CONFLICT (מתוקן — לא UNRESOLVED)
שתי Assertions authority-bearing **בתוקף** וסותרות (`A SAME B` ∧ `A DISTINCT B`, אף לא מוחלפת):
- **CONFLICT הוא state-health condition נפרד** (קטגוריה 3), **לא Relation Outcome ולא UNRESOLVED**.
- **בזמן CONFLICT: אין identity relation שמיש** ל-downstream. downstream **אינו רשאי לצרוך** את הזוג כ-SAME/DISTINCT/UNRESOLVED.
- **אין silent winner** לפי timestamp/confidence.
- **Representation + adjudication mechanism = OPEN.**
- *(אין state רביעי ב-Relation-Outcome; הוכח שזו state-health, לא relation-outcome.)*

## 10 · Canonicalization Meaning (מתוקן — reconciliation, לא merge)
- **Form-1 SAME:** binding מתחבר ל-**Canonical Referent אחד**.
- **Form-2 SAME:** **requires reconciliation into one canonical identity state** (במקום "merge"). ה-**mechanism** (merge/supersession/alias/re-parenting) = **lifecycle OPEN**.
- **נעול:** SAME ⟹ *one canonical identity, regardless of representation strategy* (minting = O2b OPEN).

## 11 · Role Independence — **RATIFY**
> Customer-X ו-Supplier-Y **יכולים להיות SAME Party**. **הבדל-role לבדו אינו DISTINCT.** Payee/Payer, Lead/Customer = **roles, לא identity-outcomes** (§0 G2). identity-semantics בלבד — **לא** migration של product-schema.

## 12 · Referent-Type Compatibility
- **Same-type** (PARTY↔PARTY · RESOURCE↔RESOURCE · COMMITMENT↔COMMITMENT): המצבים **חוקיים**.
- **Cross-type** (PARTY↔RESOURCE וכו'): **מחוץ ל-relation domain (Failure/invalid-or-unsupported)** — **לא** DISTINCT, **לא** UNRESOLVED. *(type-mismatch אסור שיהפוך אוטומטית ל-DISTINCT — §1 constraint.)* **סיווג מדויק (invalid מול unsupported) = OPEN** (מקביל T4/T5).

## 13 · Tenant Boundary — **RATIFY (re-affirm §0 T5)**
> `A@Tenant1` מול `B@Tenant2`: **אינו SAME/DISTINCT/UNRESOLVED** — מחוץ ל-valid relation domain (boundary violation). failure-family = OPEN.

## 14 · Correction Transitions (מתוקן — authorized-transition-basis)
**עיקרון:** Relation outcomes **אינם בלתי-הפיכים**, אך **כל שינוי דורש later authorized transition basis**. אין עדיין מושג של authority "גוברת" — יוגדר בחוזה מאוחר (D1) אם בכלל.
ששת ה-transitions = **`SEMANTICALLY PERMITTED SUBJECT TO AUTHORIZED TRANSITION BASIS`**:
| Transition | מצב |
|---|---|
| UNRESOLVED→SAME · UNRESOLVED→DISTINCT · SAME→DISTINCT · DISTINCT→SAME · SAME→UNRESOLVED · DISTINCT→UNRESOLVED | כולן **PERMITTED SUBJECT TO AUTHORIZED TRANSITION BASIS** |
בכל transition: Assertion היסטורי **record נשמר** (append-only); ה-**applicability** משתנה; current-state משתנה; **re-attribution** נדרש; **Evidence לעולם לא משתנה**. **ה-basis/justification המדויק לכל transition = DEFERRED (D1).**

## 15 · Relation Algebra (נבנה מחדש)
*(CONFLICT אינו עמודה — הוא state-health, לא relation-outcome.)*
| Property | SAME | DISTINCT | UNRESOLVED |
|---|---|---|---|
| Category | Relation Outcome | Relation Outcome | Relation Outcome |
| Positive assertion | **YES** (affirmative) | **YES** (affirmative; needs distinctness-authority) | withholding (explicit) / open-world **default** |
| Reflexive | **YES** (`A,A`=SAME) | **NO** (irreflexive) | **N/A** (self=SAME) |
| Symmetric | **YES** | **YES** | question **YES**; explicit-record representation **OPEN** |
| Transitive | **YES** (equivalence) — consumable via canonical identity state; **no invented pairwise authority** | **NO** | **NO** |
| Allows joint same-referent reasoning | **YES** | **NO** (contrast-only) | **NO** |
| Proves non-identity | **NO** | **YES** | **NO** |
| Applies · Form-1 (binding→referent) | **YES** | **OPEN** | **YES** |
| Applies · Form-2 (referent↔referent) | **YES** (⟹ reconciliation) | **YES** | **YES** |
| Outcome corrigible | **YES** (subject to authorized basis) | **YES** (subject to authorized basis) | **YES** (subject to authorized basis) |
| Assertion record | append-only / immutable | append-only / immutable | append-only / immutable (explicit) |
| Replay-versioned | **YES** | **YES** | **YES** (explicit; default = fn(versioned in-force set)) |

## 16 · Proposed Normative §1 Text (RS1–RS14)
- **RS0 · Category Separation.** Relation Outcome ≠ Failure ≠ State-Health; no masquerade. **RATIFY.**
- **RS1 · Open-World.** Not-known-SAME⇏DISTINCT; not-known-DISTINCT⇏SAME; default UNRESOLVED. **RATIFY.**
- **RS2 · Relation-Outcome Set.** A **healthy, valid** identity-relation determination is exactly one of `SAME / DISTINCT / UNRESOLVED`. **This set is exhaustive only for healthy, valid identity-relation determinations; it is NOT exhaustive over execution (Failure) or state-health (CONFLICT) dispositions.** **RATIFY** (closes §0 I4).
- **RS3 · Two Forms.** One authority engine over Form-1 (binding→referent) and Form-2 (referent↔referent); no separate engines. SAME/UNRESOLVED apply to both; **DISTINCT-in-Form-1 OPEN.** **RATIFY** (with OPEN).
- **RS4 · SAME.** Affirmative; equivalence relation (reflexive, symmetric, transitive); ⟹ one canonical identity; **transitivity is consumable via canonical identity state, never minted by pairwise chaining.** **RATIFY.**
- **RS5 · DISTINCT.** Affirmative non-identity requiring distinctness-authority; symmetric; **irreflexive**; **non-transitive**; never from failure-to-prove-SAME. **RATIFY** (Form-2; Form-1 OPEN).
- **RS6 · UNRESOLVED.** Positive withholding; open-world default + optional explicit; grants no joint same-referent reasoning; entails no distinctness; not error/DISTINCT/FALSE; question-symmetric (record-symmetry OPEN); reflexivity N/A (self=SAME). **RATIFY.**
- **RS7 · Outcome-XOR-Failure.** Valid invocation may be UNRESOLVED; invalid must not masquerade as UNRESOLVED. **RATIFY** (families OPEN).
- **RS8 · State Layering & Assertion Immutability.** Assertion **record** append-only/immutable; its **applicability** supersedable; **State corrigible**; correction is not mutation of a historical assertion; replay pins the state actually used. **RATIFY.**
- **RS9 · Contradiction = State-Health.** Conflicting in-force authoritative Assertions = `CONFLICT`, a state-health condition — **not** a relation outcome, **not** UNRESOLVED; under it **no usable identity relation** for downstream; no silent winner; representation/adjudication OPEN. **RATIFY** (mechanism OPEN).
- **RS10 · Canonicalization.** SAME ⟹ one canonical identity; Form-2 SAME ⟹ **reconciliation into one canonical identity state** (merge/alias/re-parent = lifecycle OPEN). **RATIFY.**
- **RS11 · Role Independence.** Role difference alone is never DISTINCT; roles are not identity outcomes. **RATIFY.**
- **RS12 · Type Compatibility.** Same-type valid; cross-type outside relation domain, must not auto-become DISTINCT (exact class OPEN). **RATIFY** (principle).
- **RS13 · Tenant Boundary.** Cross-tenant outside relation domain — never SAME/DISTINCT/UNRESOLVED. **RATIFY** (re-affirms §0 T5).
- **RS14 · Corrections.** Relation outcomes are not irreversible; every change requires a **later authorized transition basis**; the six transitions are **permitted subject to authorized basis**; records preserved, applicability changes, re-attribution required, Evidence immutable; justification matrix DEFERRED. **RATIFY** (principle).

## 17 · What Remains OPEN (§1)
- **DISTINCT בצורת Form-1** (binding→referent) — סמנטיקה זהה לא הוכחה (RS3/RS5).
- CONFLICT representation + adjudication mechanism (RS9).
- explicit-UNRESOLVED record-symmetry + storage (RS6).
- cross-type exact classification: invalid מול unsupported (RS12).
- transition-justification matrix + "authorized transition basis" definition (RS14 · D1).
- כל OPEN/DEFERRED מ-§0 (methods/authority-policy · VAT/phone/email · minting · tenant-representation+failure-family · provenance-schema · replay-encoding · RESOURCE/COMMITMENT rules · EVENT · implementation).

---

---

# RIA-1 · §2 — Identity Authority & Resolution Methods
## 1 · Executive §2 Verdict
> **RATIFY** — מודל-הסמכות מתוקן כך ש**שום מחלקה/מקור אינו authority בפני עצמו**: authority היא **תוצאה** של evaluation תחת **versioned Method Policy** applicable, ו-**RIA בלבד מפיק Identity Assertions**. הוסרו כל הניסוחים שהפכו class/verified/human/candidate/prior לסמכות-אוטומטית. Form-1 סוגר את §1-OPEN מבלי לנעול semantic-state חדש.

## 2 · The Authority Chain (מתוקן — Authorized Basis = תוצאת evaluation)
```
Evidence / Ground (C0, immutable)
  → Identity Signal            (ground relevant to identity)
  → [Identity Candidate]        (OPTIONAL — a proposal derived from signals)
  → Method-Policy Evaluation    (applicable · versioned · tenant · referent-type/domain)
  → { Authorized Basis  |  No Authorized Basis }
  → RIA Identity Assertion      (emitted by RIA only)
  → Identity State              (derived from in-force Assertions)
```
- **`Authorized Basis` אינו artifact שהגיע מבחוץ** — הוא **תוצאת ה-authority-evaluation** תחת policy. **RA1.**
- **`No Authorized Basis` על evaluation תקין → UNRESOLVED** (לא Failure, לא DISTINCT) — withholding לגיטימי. **RA14.**
- **Candidate נשאר Candidate היסטורי**; ה-Authorized Basis הוא determination נפרד עם provenance אליו/ל-contributors. **RA12.**

## 3 · Authority Ownership (מתוקן — decision ≠ evidence-validation)
| מי | קובע | סמכות |
|---|---|---|
| Source/Translator/C0 | *"source claims X"* | ground/signal |
| **External Verifier** | *"identifier X is verified in namespace N"* | **verified fact** — verification-authority, **לא** identity-authority |
| **RIA Method Policy** | *"this verified fact is a sufficient basis for SAME/DISTINCT in this identity domain"* | **identity-authority** (Authorized Basis) |
| **RIA** | מפיק Identity Assertion | **owner של final canonical identity determination** |
- **RA2 · Only RIA emits Identity Assertions.**
- **RA4 · Verification ≠ Identity Authority.** RIA אינו בהכרח owner של validation-של-כל-evidence; אך רק RIA-policy קובע אם fact-מאומת נושא identity-authority.

## 4 · Authority-Capable Sources ≠ Authorized Basis (התיקון המרכזי)
**RA3 · Authority Class ≠ Authorized Basis.** היות מקור **Internal / Verified-External / Prior-Mapping / Human** **אינו** מרשה, כשלעצמו, Identity-Assertion. **Authorized Basis מתקיים רק כתוצאה של instance שעבר את ה-applicable versioned Method Policy** בכפוף ל: policy-version · tenant · referent-type/domain · verification/admission requirements · provenance · required scope/permissions · conflict/state-health checks.

| Authority-Capable Source | *Can it become an Authorized Basis under policy?* | *Assert by itself?* |
|---|---|---|
| **Internal / Canonical** | כן — אם policy מכירה בו כמספיק לזהות | **לא — רק RIA מפיק Assertion** |
| **Verified External** | כן — אם מאומת **ו-policy** מכירה בו | **לא** |
| **Prior Mapping** | כן — רק תחת §… (lineage+applicable+no-conflict, RA19) | **לא** |
| **Human** | כן — actor-scoped, תחת policy (RA11) | **לא** |
| **Derived / Probabilistic** | **לא — candidate-only**; input ל-evaluation | **לא** |
**RA5.** ה-taxonomy מונה **authority-capable sources**, לא "asserters". השאלה לכל אחד: *"can it become an Authorized Basis under policy?"* — לעולם לא *"can it assert?"*.

## 5 · Determinism ≠ Authority — **RA6**
> Determinism = reproducibility (נדרש ל-replay, §0 R). Authority = justification. **צירים נפרדים.** `same normalized name` דטרמיניסטי אך לא-authority; exact phone/email דטרמיניסטי אך לא-authority אלא-אם policy הגדירה. **RATIFY.**

## 6 · Identifier Equality — **RA7 (מרוכך; "proves" רק תחת policy)**
> **Identifier equality MAY authorize SAME only when the applicable versioned Method Policy establishes that the identifier's namespace semantics, issuer guarantees, scope, lifecycle, referent type, verification, and reassignment properties are sufficient for identity.** גם identifier unique/non-reassigned אינו מספיק ללא: same-referent-type · scope תואם · issuer-semantics שהם **entity-identity** ולא account/location/document · הכרה של policy. **אין "proves" מחוץ ל-policy.** **RATIFY.**

## 7 · Name / Phone / Email
- **RA8 · Name.** **Name alone is never sufficient identity authority** — לא SAME, לא DISTINCT; signal/candidate בלבד (inherited Party §6#3). **RATIFY.**
- **RA9 · Phone/Email.** signals; **authority-capable רק** תחת versioned policy עם provenance + sharing/reassignment guards + referent-type + version (shared/recycled/generic/employee/changed/typo/multi-party). **RATIFY.**

## 8 · Source-Claimed ≠ Verified ≠ Authorized (VAT/Registration) — **RA10**
> שלושה שלבים נפרדים (חד מאוד):
> 1. `OCR/source claims VAT=X` → **Ground/Signal**.
> 2. `registry/authoritative source verifies VAT=X` → **Verified Identity Signal / authority-capable fact**.
> 3. `Method Policy authorizes this verified VAT` → **Authorized Basis**.
> 4. `RIA` → SAME/DISTINCT/UNRESOLVED **Assertion**.
> **אותו string ≠ אותה authority.** verified-identifier **≠** Authorized-Basis. **RATIFY.**
*(issuer/namespace · foreign-entities · sole-proprietors · missing · OCR-error · formatting = per-domain policy, deferred.)*

## 9 · Human Authority — **RA11 (מתוקן)**
> **Human confirmation from an appropriately-scoped actor MAY become an Authorized Basis under the applicable Method Policy** — ה-policy חייבת להגדיר לפחות: actor-authority/permission · tenant · referent/domain-scope · exact-proposition-confirmed · provenance · policy-version. **Human אינו identity-authority מעצם היותו human.** אינו overriding-אוטומטית; `Human-SAME` מול `Verified-External-DISTINCT` = **CONFLICT (§1 RS9)**. **RATIFY.**

## 10 · Probabilistic / Candidate — **RA12 (anti-laundering wording)**
> **A Candidate is never mutated or promoted into authority.** **Method Policy may evaluate candidate-producing signals and, if its explicit authorization contract is satisfied, produce a *separate* Authorized Basis** carrying provenance to the candidate/contributors. ה-score עצמו **אינו** מקודם לסמכות; הוא נשאר Candidate היסטורי. **אין emergent "score → SAME".** **RATIFY** (thresholds deferred).

## 11 · Composition — **RA13 (anti-laundering invariant)**
> **Combining multiple non-authoritative signals does not inherently create authority.** רק **explicit versioned Method Policy** רשאית להגדיר combination כבסיס מספיק, וה-Authorized Basis **חייב לשמר provenance לכל ה-contributors.** **אסור** `weak + weak + weak = authority` רק מריבוי-signals. **RATIFY** (combinations/thresholds deferred).

## 12 · UNRESOLVED Path — **RA14**
> **Valid Method-Policy evaluation with insufficient authority yields UNRESOLVED — not Failure and not DISTINCT.** `No Authorized Basis` **אינו absence-of-output**; הוא מצדיק **RIA withholding determination** (explicit UNRESOLVED, §1 RS6). **RATIFY.**

## 13 · SAME vs DISTINCT Authorization — **RA15 (מחוזק)**
> Method Policy **חייבת להגדיר בנפרד:** SAME-authorization-conditions · DISTINCT-authorization-conditions. **`DISTINCT = NOT SAME` אסור — גם ברמת policy.** DISTINCT דורש affirmative distinctness-authority עצמאי; לעולם לא נגזר משלילת-sameness. **RATIFY** (§1 RS5 · §0 I2).
- **RA16 · Negative evidence.** absent/mismatched non-authoritative signal **אינו** DISTINCT-authority (different-names/missing-attrs/different-contact ≠ DISTINCT). **RATIFY.**

## 14 · Method Policy Ownership & Versioning — **RA17 + RA18**
- **RA17 · Ownership.** Method Policy **אינה Feature-owned heuristic** — היא חלק מ-**RIA authority contract/configuration**. **Features מספקים signals, לא מגדירים identity-policy לעצמם.** מבנה (global contract + per-type/domain policy + tenant-instantiation/config) — **tenant-scope חייב explicit**; tenant-specific-semantics לא נעולים ללא בסיס (schema deferred). **RATIFY.**
- **RA18 · Versioning/Replay.** כל Assertion **מעגן את Method-Policy-version + ה-Authorized-Basis**; replay משתמש ב-policy ה-pinned; reprocessing תחת policy חדשה = mode מפורש. (policy-v1=SAME → historical-replay נשאר SAME; policy-v2 → current-reprocess יכול UNRESOLVED. §0 R4 · §1 RS8/RS14.) **RATIFY.**

## 15 · Prior Mapping — **RA19**
> Prior-mapping הוא **authority-capable input, לא authority-כי-הוא-קיים.** שמיש **רק** אם ה-Method-Policy קובעת ש: המ-mapping עדיין **applicable** · policy/version תקפים · **אין conflict** · tenant/type תואמים · **ו-lineage ל-original-Authorized-Basis נשמר**. **אין circular authority** (*"SAME כי פעם אמרנו SAME"* ללא provenance-מקורי אסור). **RATIFY.**

## 16 · RESOURCE / COMMITMENT — **RA20 (illustrative-only; semantics deferred)**
- **דוגמאות illustrative בלבד (לא נעולות):** *barcode/SKU/provider-item-ID/internal-inventory-ID* ל-RESOURCE; *invoice-ID/obligation-ID/order-ID/provider-txn-ID* ל-COMMITMENT.
- **הוסר מהנעילה:** *"barcode = product-type-not-instance"* ו-*"invoice-ID = Canonical/Internal"* — אלה **domain-specific semantic claims לא-מוכחים כחוק אוניברסלי.**
> **RA20 · מה נעול:** ה-**generic authority model** (chain · class≠basis · verification≠authority · method-policy) **חל על PARTY / RESOURCE / COMMITMENT**. **ה-identifier/referent semantics אינם generic** — הם per-domain Method Policy ו-**DEFERRED** (exact referent-semantics של barcode/SKU/invoice/provider-IDs = per-domain, deferred). **RATIFY.**

## 17 · Form-1 DISTINCT — **RA21 (סוגר §1-OPEN ללא נעילת-negative)**
`Source Referent Binding → Canonical Referent R`:
- **נעול:** binding **אינו canonical peer**; לכן **canonical DISTINCT algebra אינו חל על Form-1** (Form-2 DISTINCT ≠ Form-1).
- **DEFERRED:** ה-negative/withholding/rejection semantics של binding-resolution **אינם נעולים** — יוכרעו ב-resolution/admission-mechanics contract. *("exclusion / non-attachment" = candidate-terminology בלבד, **לא lock**.)*
> **RA21.** §1-OPEN (Form-1 DISTINCT) **נסגר** ברמת ה-algebra (לא חל), **בלי ליצור semantic-state חדש** לפני הזמן. **RATIFY (partial-closure).**

## 18 · Conflict Timing — **RA22**
> אם **Method Policy מכריעה precedence *לפני*** ששתי Assertions-בתוקף נוצרות → **ייתכן שלא נוצר CONFLICT.** אם כבר קיימות **שתי authoritative Assertions incompatible + in-force** → **§1 CONFLICT** (state-health, אין usable-relation). **Precedence, אם תוגדר, חייבת explicit/versioned — לא implicit.** **אין להגדיר precedence כעת.** **RATIFY.**

## 19 · Proposed Normative §2 Locks (RA1–RA22)
| Lock | תוכן | סטטוס |
|---|---|---|
| RA1 | Authority chain; Authorized-Basis = תוצאת Method-Policy-Evaluation; Candidate optional | RATIFY |
| RA2 | **Only RIA emits Identity Assertions** | RATIFY |
| RA3 | **Authority Class ≠ Authorized Basis** (capable≠authorized; only via passing policy) | RATIFY |
| RA4 | **Verification ≠ Identity Authority** | RATIFY |
| RA5 | Authority-capable sources taxonomy ("become-basis-under-policy?", not "assert?") | RATIFY |
| RA6 | Determinism ≠ Authority | RATIFY |
| RA7 | Identifier equality authorizes SAME only under versioned policy (no "proves" outside policy) | RATIFY |
| RA8 | Name-alone never authority | RATIFY (inherited) |
| RA9 | Phone/Email = signals; authority-capable only under versioned policy+guards | RATIFY |
| RA10 | Source-claimed ≠ verified ≠ Authorized-Basis (3-step) | RATIFY |
| RA11 | Human = authority-capable-under-policy, scoped/corrigible, not-by-being-human; may CONFLICT | RATIFY |
| RA12 | Candidate never mutated/promoted into authority; separate Authorized-Basis w/ provenance | RATIFY |
| RA13 | Composition anti-laundering; only explicit policy; preserve all-contributor provenance | RATIFY |
| RA14 | No-Authorized-Basis on valid eval → UNRESOLVED (not Failure/DISTINCT) | RATIFY |
| RA15 | SAME-auth & DISTINCT-auth defined **separately**; `DISTINCT=NOT SAME` forbidden even in policy | RATIFY |
| RA16 | Absent/mismatched non-authoritative signal ≠ DISTINCT authority | RATIFY |
| RA17 | Method Policy = RIA-owned authority-config, not Feature-heuristic; Features supply signals only; tenant-scope explicit | RATIFY |
| RA18 | Assertion pins policy-version+basis; replay uses pinned policy; reprocessing explicit | RATIFY |
| RA19 | Prior-mapping = authority-capable input via preserved lineage; no circular self-authority | RATIFY |
| RA20 | Generic authority model across PARTY/RESOURCE/COMMITMENT; **identifier semantics NOT generic** (deferred) | RATIFY |
| RA21 | Form-1: binding≠canonical-peer; canonical-DISTINCT-algebra N/A; negative-semantics DEFERRED | RATIFY (partial) |
| RA22 | Conflict = two incompatible in-force authoritative Assertions ⟹ §1 CONFLICT; precedence only explicit/versioned; none now | RATIFY |

## 21 · OPEN / DEFERRED (§2)
- Form-1 **negative/rejection semantics** (RA21) → resolution/admission-mechanics contract.
- **Method-Policy schema** + structure (global/type/tenant) (RA17) · **thresholds/combination-rules** (RA12/RA13) · **precedence-policy** content (RA22).
- Per-**identifier/referent-type semantics** (RA7–RA10/RA20).
- **Provenance schema** (§0 PR3) · minting (§0 O2b) · replay-encoding (§0 R3) · CONFLICT-adjudication (§1 RS9) · UNRESOLVED-record-symmetry (§1 RS6) · cross-type-exact-class (§1 RS12) · transition-justification-matrix (§1 RS14) · RESOURCE/COMMITMENT-rules (§0 G3) · EVENT (§0 G4) · implementation.

---

---

# RIA-1 · §3 — Assertion & Identity State: Structure, Lifecycle, Supersession, Re-Attribution & Replay-State
*Prefix: `AS`. כל דבר נעול ב-§0/§1/§2 = INHERITED (לא נפתח מחדש).*

## 1 · Executive §3 Verdict
> **RATIFY** — עקרון-העל של §3: **ההיסטוריה ה-append-only היא ה-authority היחיד; applicability, in-force, ו-Current-State הם כולם *derived* ממנה + מ-context.** אין mutable-status ואין current-state-table כ-primary-truth. Assertion נשאר "RIA קבע SAME/DISTINCT/UNRESOLVED" (לא lifecycle-command); ה-artifact המדויק של supersession, ה-temporal-model, וה-encoding — DEFERRED. אין reopening של §0–§2.

## 2 · The Two Artifacts — **AS1**
| Artifact | טבע | מקור |
|---|---|---|
| **Identity Assertion** | **record immutable, append-only** — מה RIA קבע בזמן, תחת policy/basis | INHERITED §1 RS8 · §2 RA18 |
| **Identity State** | **view נגזר, ניתן-לחישוב-מחדש** — הקביעה השמישה כעת, מחושבת מההיסטוריה | INHERITED §1 RS7/RS8; מפורמל AS5 |
**AS1.** שני ה-artifacts נפרדים ולעולם לא קורסים: Assertion = היסטוריה-immutable-primary; State = הווה-נגזר-corrigible. **RATIFY.**

## 3 · Assertion — Required Semantic Components — **AS2**
Assertion תקף נושא (semantic; **schema DEFERRED**, §0 PR3):
1. **Subject(s) + Form** (F1 binding→referent / F2 referent↔referent) (§1 RS3).
2. **Determination** — **relation-outcome אחד: `SAME | DISTINCT | UNRESOLVED`** (§1 RS2). *(UNRESOLVED רשאי להיכתב מפורשות כ-**intentional withholding** — זהו **אותו** relation-outcome, **לא** outcome רביעי בשם "explicit-withholding". CONFLICT אינו נכתב כ-Assertion — הוא derived, AS11.)*
3. **Authorized-Basis reference** (§2 RA1/RA3).
4. **Method-Policy version — pinned** (§2 RA18 · AS10).
5. **Tenant** (§0 T).
6. **Referent-type/domain.**
7. **Provenance + lineage** ל-Authorized-Basis (AS7 · §0 PR1/PR2).
8. **Assertion-identity + recorded-time.**
**AS2.** קבוצת-הרכיבים מחייבת; schema DEFERRED. **RATIFY** (requirement).

## 4 · Assertion Immutability — **AS3** (INHERITED, מועמק)
> ה-record **append-only ולעולם לא מְמוּטָּט**. correction/supersession/retraction הם **facts חדשים בהיסטוריה**, **לעולם לא עריכת-record**. **RATIFY** (INHERITED §1 RS8).

## 5 · No Mutable Applicability — **AS4 (תיקון-ליבה)**
> **ל-Assertion-record אין mutable applicability state.** `in-force` / `superseded` / `applicable` הם **derived classifications** המחושבים מתוך ה-**append-only assertion+supersession history + ה-context הרלוונטי** — **לא** property שמשנה ערך, **ולא** mutable `status` שהוא primary-truth. **RATIFY.**

## 6 · Supersession / Correction — **AS5** (מתוקן — artifact deferred)
> Supersession/correction **מיוצג append-only**, **מפנה ל-prior-assertion(s) שעל-applicability שלהן הוא משפיע**, ו**דורש authorized-transition-basis** (§1 RS14 · §2). **ה-artifact/form המדויק DEFERRED** — **לא** נעול ש-supersession *חייב* להיות Identity-Assertion, **ולא** ממציאים artifact חדש עכשיו. כך Assertion נשאר "RIA determined SAME/DISTINCT/UNRESOLVED", לא lifecycle-command. **RATIFY** (requirement) · form **DEFERRED**.

## 7 · Current Identity State — Derivation — **AS6** (מתוקן — input מדויק)
> **Current Identity State = derivation דטרמיניסטית/ניתנת-לחישוב-מחדש מתוך:**
> `append-only assertion history` + `append-only supersession/correction (lifecycle) facts` + `applicable pinned policy/context`.
> **ה-`in-force set` הוא intermediate derived set, לא input-primary.** השרשרת:
> `immutable history + applicable context → derive applicability → derive usable Identity State`.
> **אין mutable current-state table כ-authority.** materialized-view/cache **מותר** כ-implementation-detail עתידי — אך **לעולם לא primary-authority**. **RATIFY.**

## 8 · No Silent Reinterpretation Under New Policy — **AS7 (תיקון #10)**
> כל **historical determination שומר את ה-policy/basis ה-pinned שלו** (§2 RA18); הוא **לעולם לא מחושב-מחדש תחת policy עדכנית** באופן שמשנה את משמעותו. **Reprocessing תחת Method-Policy חדשה = evaluation מפורש חדש, לא reinterpretation שקט של Assertions ישנים.** *(current applicability/lifecycle-policy, אם תוגדר בעתיד — נפרד; schema DEFERRED.)* **RATIFY.**

## 9 · Lineage — **AS8** (INHERITED §2 RA19)
> provenance שומר **lineage ל-Authorized-Basis**; **אין circular self-authority** (*"SAME כי פעם אמרנו SAME"* ללא provenance-מקורי אסור). **RATIFY** (INHERITED §2 RA19).

## 10 · Re-Attribution — **AS9** (מתוקן — requirement, לא mechanism)
> **הדרישה:** *identity correction must not silently leave downstream reasoning attributed to obsolete identity state.* לכן: **any downstream artifact whose meaning depends on an identity determination MUST be traceable to the exact identity state / basis / context it consumed, sufficiently to support replay and re-attribution after correction**; ו-**correction must enable identification and re-attribution/reprocessing of downstream dependents.**
> **DEFERRED (encoding + mode):** הדרך (assertion-references · state snapshot/version · digest · replay-manifest · אחר) ו-האם propagation synchronous/automatic/queued/replay-based. **RATIFY** (requirement) · mechanism **DEFERRED**.

## 11 · Historical Replay vs As-Of Reconstruction — **AS10** (מתוקן — שני concepts)
> **הפרדה:**
> - **Historical Execution Replay (RATIFY):** משחזר את ה-**state/context שהיה pinned ונצרך בפועל** ע"י ההרצה ההיסטורית (§1 RS8/RS14 · §2 RA18 · §0 R4). דוגמה: t1 `A SAME B` → t3 supersede `A DISTINCT B`: replay-של-t1 → **SAME**; current → **DISTINCT**; Evidence-immutable.
> - **General As-Of Identity Reconstruction** (*"מה היה ה-identity-state התקף בזמן T?"*): **אינו בהכרח אותו query** אם בעתיד יהיו retroactive-corrections/effective-time. **DEFERRED** (תלוי AS12/temporal-model).
> **RATIFY** (historical-execution-replay requirement) · as-of-general **DEFERRED**. encoding **DEFERRED** (§0 R3).

## 12 · CONFLICT — Derived State-Health — **AS11** (מתוקן — applicability-overlap, לא syntactic)
> **CONFLICT הוא תכונה נגזרת של ה-State**, לא Assertion מאוחסן ולא outcome רביעי. הוא נובע מ-**incompatible authoritative determinations שה-derived-applicability שלהן חופפת ב-identity-context הרלוונטי** — לא בהכרח "אותם subjects" syntactic בלבד; **policy/domain/version/scope עשויים לקבוע** אם הן באמת מתנגשות. תחת CONFLICT: **אין usable relation** ל-downstream; **אין silent winner**. **detection algorithm DEFERRED.** **RATIFY** (requirement · INHERITED §1 RS9).

## 13 · UNRESOLVED — One Outcome; Default Scope — **AS12** (מתוקן)
> **UNRESOLVED הוא relation-outcome אחד** (§1 RS6), **לא** outcome רביעי. הוא רשאי להיות (א) **explicitly recorded** (intentional withholding), (ב) **default** בהיעדר סמכות-SAME/DISTINCT מספקת בתוקף.
> **Default-UNRESOLVED חל אך ורק על שאלת-זהות valid, healthy, admitted:** *"For a valid, healthy, admitted identity question, absence of sufficient applicable SAME or DISTINCT authority yields UNRESOLVED."* **invalid / cross-tenant / cross-type-unsupported / CONFLICT — לעולם לא נופלים ל-default-UNRESOLVED** (§1 RS0/RS9/RS12/RS13 · §2 RA14). **RATIFY.**

## 14 · Temporal Sufficiency — **AS13** (מתוקן — requirement, לא model-choice)
> **RATIFY (requirement):** *Every assertion/correction lifecycle fact must carry sufficient temporal/order information to permit deterministic historical reconstruction according to the temporal model eventually ratified.*
> **OPEN (temporal model):** assertion/recorded-time · effective/valid-time · ordering · retroactivity · correction-effective-date. **Full bitemporality אינה נדרשת כרגע — וגם אינה נשללת מראש.** *(הוסרה כל טענת-מספיקות "assertion-time + order מספיקים".)*

## 15 · State Reproducible-Identifiability — **AS14 (חדש — requirement)**
> **A consumed Identity State must be uniquely reproducible / identifiable from its authoritative inputs / context** (תומך ב-AS9/AS10 ללא בחירת-encoding). **DEFERRED:** stateId · digest · snapshot-encoding · graph-version. **RATIFY** (requirement) · encoding **DEFERRED**.

## 16 · Tenant Scope — **AS15** (INHERITED §0 T)
> כל Assertion וכל Identity-State-נגזר **tenant-scoped**; אין חוצה-tenant (§0 T2 · §1 RS13). **RATIFY** (INHERITED).

## 17 · Proposed Normative §3 Locks (AS1–AS15)
| Lock | תוכן | סטטוס |
|---|---|---|
| AS1 | Assertion(immutable-record) ≠ Identity-State(derived-view); לא קורסים | RATIFY |
| AS2 | Assertion required components; determination = one of SAME/DISTINCT/UNRESOLVED (no 4th) | RATIFY · schema DEFERRED |
| AS3 | Assertion record append-only/immutable; corrections = new facts | RATIFY (INHERITED §1 RS8) |
| AS4 | **No mutable applicability state**; in-force/superseded = derived classifications | RATIFY |
| AS5 | Supersession/correction append-only, refs prior + authorized-transition-basis; **artifact DEFERRED** | RATIFY · form DEFERRED |
| AS6 | **Current State = derived from immutable history + lifecycle-facts + pinned context**; in-force = intermediate-derived; cache-allowed-not-authority | RATIFY |
| AS7 | **No silent reinterpretation** of old assertions under new policy; reprocessing = new explicit evaluation | RATIFY |
| AS8 | Lineage to Authorized-Basis; no circular self-authority | RATIFY (INHERITED §2 RA19) |
| AS9 | Re-attribution **requirement** (downstream traceable to consumed state/basis/context); encoding+propagation DEFERRED | RATIFY(req) · mech DEFERRED |
| AS10 | Historical-execution-replay RATIFY; general as-of ≠ necessarily same; DEFERRED | RATIFY(partial) · DEFERRED |
| AS11 | CONFLICT = derived state-health (applicability-overlap in identity-context); not 4th/stored; no silent winner | RATIFY (INHERITED §1 RS9) · algo DEFERRED |
| AS12 | UNRESOLVED = one outcome (explicit or default); default only for valid/healthy/admitted question | RATIFY (INHERITED §1 RS6) |
| AS13 | Temporal-sufficiency **requirement**; temporal-model (recorded/effective/order/retroactivity) OPEN | RATIFY(req) · model OPEN |
| AS14 | Consumed State must be uniquely reproducible/identifiable; state-ID encoding DEFERRED | RATIFY(req) · encoding DEFERRED |
| AS15 | Assertion + derived State tenant-scoped | RATIFY (INHERITED §0 T) |

## 19 · OPEN / DEFERRED (§3)
- **Supersession/correction artifact & form** (AS5) · האם צריך להבחין Identity-Assertion / Supersession-Correction-Act.
- **Concrete Assertion/State schema & storage** (AS2 · §0 PR3) · **State-ID/digest/snapshot encoding** (AS14).
- **Re-attribution propagation mechanism + mode** (AS9) → downstream-consumption contract.
- **Replay-state encoding** + **general as-of query** (AS10 · §0 R3).
- **Temporal model** (recorded/effective-time/ordering/retroactivity; full-bitemporality) (AS13).
- **CONFLICT detection algorithm + adjudication** (AS11 · §1 RS9).
- **Current applicability/lifecycle-policy** (if defined later) (AS7).
- **Canonical Referent minting/lifecycle** (§0 O2b · §1 RS10) → **§4 candidate** (§3 מתייחס ל-Canonical Referent כ-opaque identity בלבד).
- כל שאר §0/§1/§2 OPEN/DEFERRED — נשמרים.

---

---

# RIA-1 · §4 — The Canonical Referent
*Prefix: `CR`. נעול ב-§0–§3 = INHERITED.*

## 1 · Executive §4 Verdict
> **RATIFY** — ה-Canonical Referent הוא **identity anchor בלבד** (לא truth-container). **שלושה artifacts נפרדים:** Canonical-Referent · Source-Referent-Binding · Authorized-Minting-Basis. **Minting = decision מורשה נפרד מ-matching, שאינו binding, שאינו Identity-Assertion, ושאינו uniqueness-proof;** duplicate-anchors לגיטימיים תחת open-world, וה-requirement הוא **reconcilability**. כל ה-mechanisms (minting-trigger · reconciliation · split · lifecycle-set · type-correction · encoding) DEFERRED. אין reopening §0–§3.

## 2 · Three Distinct Artifacts (הבסיס של §4)
| Artifact | מהו |
|---|---|
| **Canonical Referent** | identity anchor (CR1) |
| **Source Referent Binding** | source-side claim/reference שעשוי לפתור לאותו anchor (§2) |
| **Authorized Minting Basis** | authority המרשה **יצירת** anchor תחת minting-policy — **אינו בהכרח Binding** (CR3) |

## 3 · Canonical Referent — Definition — **CR1**
> **A Canonical Referent is a stable, tenant-scoped, type-bound identity anchor to which ZERO OR MORE Source Referent Bindings may be attributed over its history, provided that its creation was authorized by the applicable minting contract/policy.**
מובחן מ: Evidence(C0) · Source-Referent-Binding · Authorized-Minting-Basis · Identity-Assertion · Identity-State · Product-entity/record · Role · attributes/payload. **RATIFY.**
*(zero-current-bindings ברגע נתון — לא מורשה אוטומטית ולא נאסר; ראה CR20.)*

## 4 · Identity Anchor vs Entity Record — **CR2**
> anchor **בלבד — NOT an entity-record holding attributes.** facts חיים ב-Evidence(C0)/roles/derived-state. **Proof:** §0 N1/N3 (RIA לא owns facts) + C0 immutable-evidence + **Party-precedent** (`Party={id,businessId,timestamps}`, bare-node) + historical-ER (*"Identity=מצע-הצבירה"*). **RATIFY.**

## 5 · Minting Basis ≠ Source Binding — **CR3 (התיקון המרכזי)**
> - **Every minting act requires an Authorized Minting Basis under the applicable minting policy.**
> - **An Authorized Minting Basis need NOT itself be a Source Referent Binding.**
> - **Existence of a Source Referent Binding does NOT itself authorize minting** (משמר את §2 authority-model).
> **RATIFY.**

## 6 · Human Action ≠ Automatically a Binding — **CR4**
> Human-action עשויה לספק: minting-request · authority-capable-evidence · Authorized-Minting-Basis · product-entity-creation — **אך אינה בהכרח Source Referent Binding.** (הוסרה הנעילה הקודמת *"human-created customer IS a binding"* — לא הוכחה.) **RATIFY.**

## 7 · Minting ≠ Identity Assertion — **CR5**
> **Minting does not itself emit a Form-2 Identity Assertion.** **Minting-authorization ו-identity-relation-authorization הן authority-questions נפרדות.** (Identity-Assertion §3 = determination של SAME/DISTINCT/UNRESOLVED; Minting = creation-authorization של anchor — decision/artifact-classes שונים.) **RATIFY.**

## 8 · Minting Creates No Determination — **CR6**
> **Minting a new Canonical Referent creates no SAME or DISTINCT determination against any existing referent merely by virtue of minting** (מ-CR: `mint new R` ≠ `DISTINCT from all existing`, §1 RS1 open-world). **אין conceptual all-pairs UNRESOLVED graph.** אם בעתיד קיימת שאלת-זהות **valid/healthy/admitted** בין R-חדש ל-R-אחר וללא סמכות-SAME/DISTINCT מספקת → **§3 AS12 מחזיר UNRESOLVED** (per-question, לא graph). **RATIFY** (חשוב ל-scale + open-world).

## 9 · Minting Is Not a Uniqueness Proof — **CR7 (חדש)**
> **Minting is not a uniqueness proof.** מערכת-ה-minting **אינה יכולה לדעת** שאין referent קיים לאותה real-world-entity. **RATIFY.** *(מונע ניסיון-עתידי לאכוף global-uniqueness שאין לנו authority להבטיח.)*

## 10 · Duplicate Anchors Are Not Corruption — **CR8 (חדש)**
> שני Canonical Referents שמתברר מאוחר שהם SAME **אינם בהכרח corruption** — הם תוצאה לגיטימית של **open-world knowledge** (ואחד מתפקידי-RIA לפתור אותם). **Semantic requirement:** לאחר **sufficient SAME authority**, המערכת **חייבת להיות מסוגלת reconcile** אותם (לא operational-tolerance — requirement). **RATIFY.**

## 11 · Stable Identifier vs Corrigible Identity-State — **CR9**
> **הפרדה:**
> - **Referent identifier stability:** ID **immutable · opaque · tenant-scoped · non-semantic · never-reused** (encoding DEFERRED).
> - **Identity-state corrigibility:** SAME/DISTINCT/reconciliation **יכולים להשתנות** דרך סמכות חדשה (§3 corrigible-state).
> *"stable"* מתייחס ל-**identifier**, **לא** מרמז ש-identity-state אינו corrigible. **RATIFY.**

## 12 · Reconciliation Semantics (Form-2 SAME) — **CR10**
> `R1 SAME R2` → **the canonical identity state must represent the affected anchors as reconciled according to the applicable reconciliation semantics.** **Invariants:** Evidence-immutable (§0 N1/§3 AS3) · lineage-survives (§2 RA19) · downstream replayable (§3 AS9/AS10) · **no ID reuse** (CR9) · historical-interpretable (§3 AS10).
> **Mechanism (survivor+alias / new-R / cluster / representative / supersession) DEFERRED** — לא מונח.
> **OPEN:** האם **SAME-Assertion לבדו** מפעיל reconciliation, או נדרש **authorized lifecycle fact/act נוסף** (§3 AS5). **RATIFY** (invariants) · mechanism **DEFERRED** · trigger **OPEN**.

## 13 · Split / Reversal — **CR11** (mechanism-neutral)
> אם `R1 SAME R2` ואז סמכות קובעת שגוי: **אסור "למחוק merge".** Requirements (mechanism-neutral, **ללא הנחת cluster-artifact**):
> - **the historical reconciliation state and the historical relationship among the affected referent anchors remain reconstructible/interpretable** (§3 AS10);
> - **downstream artifacts whose attribution depended on the reconciled identity state must be identifiable for re-attribution/reprocessing** *(Evidence עצמו לא "עובר לתיקייה" — CR2/CR24)*;
> - provenance preserved (§2 RA19).
> **Mechanism DEFERRED.** **RATIFY** (requirements).

## 14 · Reconciliation Does Not Erase Existence — **CR12 (חדש · consistency ל-§3)**
> **Reconciliation of identity state does not retroactively erase the existence/history of the participating Canonical Referent anchors.** anchor נשאר **historically addressable** גם כאשר current-Identity-State מ-reconcile אותו עם anchor אחר (נדרש ל-§3 replay/AS10). **current-lookup DEFERRED.** **RATIFY.**

## 15 · Lifecycle — **CR13** (derived מ-authorized-lifecycle-history)
> **Canonical Referent lifecycle classification is derived from its append-only AUTHORIZED LIFECYCLE HISTORY and applicable context** — **לא רק** מ-identity-assertions (**minting עצמו הוא lifecycle-fact**; privacy/retirement עשויים להיות lifecycle-facts אחרים), ו**לא mutable-enum-status** (§3 AS4/AS6). **specific lifecycle-fact-types + state-set DEFERRED.** **RATIFY** (derived) · types/set **DEFERRED**.

## 16 · Deletion / Retention Boundary — **CR14**
> **Product-record deletion alone does not authorize destruction of canonical identity history** (ל-replay/lineage). אך **privacy/erasure/anonymization obligations may impose transformations that must be reconciled with replay/provenance requirements under the Privacy Constitution.** **§4 אינו מעל privacy-law/constitution.** **RATIFY** (deletion-boundary) · privacy-erasure **DEFERRED** (dependency: Privacy Constitution). *(מתח privacy↔replay מסומן.)*

## 17 · Role Independence — **CR15** (INHERITED §1 RS11)
> Customer/Supplier/Payee/Payer/Lead = **projections, לא identity**; **anchor אחד נושא roles מרובים**; **role ≠ Referent-ID חדש.** **RATIFY** (INHERITED). *(אין role-schema.)*

## 18 · Referent-Type Rules — **CR16** (type immutability — Option A, proven)
> **Proof:** referent-type הוא **identity-defining** — Party-anchor ו-Resource-anchor הם **identity-domains שונים** (§1 RS12: relations legal רק same-type). לכן **type of a given anchor is immutable** (חלק מזהותו).
> **Mistyped anchor** (נוצר בטעות RESOURCE במקום PARTY) **מתוקן ע"י append-only correction** (retire/supersede + mint correctly-typed + re-attribution), **לא ע"י mutation של type** — **מנגנון התיקון DEFERRED** (reconciliation/split-adjacent, CR10/CR11). subtype/role ≠ referent-type. **EVENT deferred** (§0 G4). **RATIFY** (immutability proven) · correction-mechanism **DEFERRED**.

## 19 · Tenant Rules — **CR17** (no existence-assumption)
> tenant-scoped (§0 T · §3 AS15). **Canonical Referents, when created independently in different tenants for the same real-world entity, remain distinct tenant-local anchors with no RIA relation between them.** **אין global-identity-graph; אין cross-tenant-reconciliation.** **RATIFY** (INHERITED; מנוסח ללא הנחת-existence).

## 20 · C0 Boundary — **CR18** (INHERITED §0 L1/N)
> C0 נושא bindings/grounds; **אינו mint/identity-authority**; Canonical-Referent-lifecycle **post-C0**; **0 C0-change.** **RATIFY** (INHERITED).

## 21 · Product-Model Relationship — **CR19** (implementation-neutral)
> **Product models may supply source-side identity references/signals that participate in Form-1 resolution to a Canonical Referent**, and **remain separate product records.** **Exact Product-Entity → Source-Binding mapping DEFERRED** (מונע coupling בין RIA ל-Prisma-models). migration DEFERRED (§1 RS11). **RATIFY** (weak-semantic-relationship) · mapping **DEFERRED**.

## 22 · Zero / Multiple Binding Semantics — **CR20**
> **Zero or more Source Referent Bindings may resolve/attribute to the same Canonical Referent according to authorized identity state.**
> - **Multiple:** RATIFY (בסיס cross-feature-alignment) — **separately-attributable · no evidence-collapse · no source-mutation** (§0 N1/N3).
> - **Zero-current:** **מותר** כאשר referent נוצר מ-Authorized-Minting-Basis-שאינו-Binding, **או** כאשר bindings היסטוריים כבר אינם currently-applicable. **לא נאסר מראש.**
> **RATIFY.**

## 23 · Reconciliation Lifecycle Effect — **CR21** (requirement ≠ artifact)
> **Any reconciliation lifecycle effect must be authorized, provenance-bearing, uniquely reproducible/identifiable, and replayable** (§3 AS14). **Whether represented by SAME-Assertion-alone / a separate lifecycle-fact / a derived-effect — OPEN/DEFERRED** (§3 AS5). **RATIFY** (requirement) · representation **OPEN**.

## 24 · Minting Authorization — Distinctness — **CR22**
> **Minting authorization is semantically distinct from SAME authorization and DISTINCT authorization.** (**לא** "third class" — עשויים להתווסף correction/reconciliation authorization-classes.) **Artifact-structure (standalone Minting-Policy vs Method-Policy-section) OPEN.** **RATIFY** (distinctness) · structure **OPEN**.

## 25 · Non-Invention Guards — **CR23 + CR24**
- **CR23 · No fabrication.** **Minting fabricates no facts about the real-world entity** (name/VAT/phone/customer-status/supplier-status/business-meaning — מ-Evidence/roles/derived-state). **guard:** *"The existence of a Canonical Referent itself proves only that an authorized identity anchor was created — NOT that any particular descriptive claim about the real-world entity is true."* **RATIFY.**
- **CR24 · Not a truth-container.** anchor, **לא** container המחליף source-Evidence או מחזיק mutable-business-facts (אין master-record הסותר C0). **RATIFY.**

## CR25 (מתוקן)
> **CR25 · Correction Compatibility.** Minting, reconciliation, split/reversal, and type-correction semantics must preserve an **append-only authorized history sufficient to** derive current state, preserve provenance and lineage, support required re-attribution, and reproduce historical identity interpretation under replay. **No lifecycle representation or artifact type is implied by this requirement.**
*(משמר AS3 immutable-history · AS6 derived-state · AS9 re-attribution · AS10 historical-replay · AS14 reproducible-identity; CR21 representation נשאר OPEN.)*
## 27 · Proposed Normative §4 Locks (CR1–CR25)
| Lock | תוכן | סטטוס |
|---|---|---|
| CR1 | Def: tenant-scoped type-bound anchor; zero-or-more bindings; minting-authorized | RATIFY |
| CR2 | Anchor only — no attributes | RATIFY |
| CR3 | Minting requires Authorized-Minting-Basis; basis ≠ binding; binding-existence ≠ minting-authority | RATIFY |
| CR4 | Human action ≠ automatically a Source Binding | RATIFY |
| CR5 | Minting ≠ Identity Assertion; minting-auth & relation-auth separate | RATIFY |
| CR6 | Minting creates no SAME/DISTINCT and no all-pairs UNRESOLVED graph | RATIFY |
| CR7 | Minting is not a uniqueness proof | RATIFY |
| CR8 | Duplicate anchors legitimately exist; reconcilability required after sufficient SAME | RATIFY |
| CR9 | Identifier-stability vs identity-state-corrigibility separate | RATIFY · encoding DEFERRED |
| CR10 | Reconciliation invariants; mechanism DEFERRED; SAME-alone-vs-separate-fact OPEN | RATIFY · mech DEFERRED · trigger OPEN |
| CR11 | Split mechanism-neutral (no cluster-artifact); reconstructible + re-attributable | RATIFY · mech DEFERRED |
| CR12 | Reconciliation does not erase anchor existence/history | RATIFY |
| CR13 | Lifecycle derived from authorized-lifecycle-history (not just assertions; not enum) | RATIFY · types/set DEFERRED |
| CR14 | Product-deletion ≠ authorize identity-history destruction; privacy under Privacy Constitution | RATIFY · privacy DEFERRED |
| CR15 | Roles = projections, not identity | RATIFY (INHERITED §1 RS11) |
| CR16 | Type identity-defining ⇒ immutable; mistype→append-only-correction (mech deferred) | RATIFY · correction-mech DEFERRED |
| CR17 | Tenant-local; independent same-entity anchors distinct, no RIA relation; no global graph/cross-tenant reconciliation | RATIFY (INHERITED) |
| CR18 | C0 not mint/identity-authority; post-C0; 0 C0-change | RATIFY (INHERITED) |
| CR19 | Product models supply source-side references/signals to Form-1; mapping DEFERRED (no Prisma coupling) | RATIFY · mapping DEFERRED |
| CR20 | Zero-or-more bindings per anchor; separately-attributable; no-collapse; zero-current allowed | RATIFY |
| CR21 | Reconciliation effect authorized/provenance/reproducible/replayable; representation OPEN | RATIFY · repr OPEN |
| CR22 | Minting-auth semantically distinct from SAME/DISTINCT-auth (not "third class"); structure OPEN | RATIFY · structure OPEN |
| CR23 | Minting fabricates no facts; existence proves only authorized-anchor-created | RATIFY |
| CR24 | Not a truth-container | RATIFY |
| CR25 | Correction-compatibility: append-only authorized history sufficient for derive-state / provenance+lineage / re-attribution / historical-replay; **no representation or artifact-type implied** | RATIFY |

## 29 · OPEN / DEFERRED (§4)
- **Minting trigger-policy** + **Minting-authorization artifact-structure** (CR3/CR22).
- **Reconciliation mechanism** + **SAME-alone-vs-separate-lifecycle-fact trigger** (CR10/CR21 · §1 RS10).
- **Split/reversal mechanism** + ambiguous-downstream (CR11).
- **Lifecycle fact-types + state-set** (CR13) · **Referent-ID/reconciliation-identity encoding** (CR9/CR21).
- **Type-correction mechanism** (CR16) · **privacy-erasure/anonymization** (CR14 · Privacy Constitution) · **current-lookup post-reconciliation** (CR12) · **Product-Entity→Binding mapping** (CR19).
- כל §0–§3 OPEN/DEFERRED — נשמרים.

---

---

# RIA-1 · §5 — Identity Policy Substrate: Method & Minting Authorization
*Prefix: `MP`. נעול ב-§0–§4 = INHERITED.*

## 0 · The Four Layers (מכונן — כל §5 שומר עליהן)
| שכבה | פלט | שם חי |
|---|---|---|
| **Method-Policy Evaluation** | `Authorized Basis \| No-Authorization \| Failure` | §5 |
| **RIA Determination** | `Identity Assertion` (SAME/DISTINCT/UNRESOLVED) | §3 |
| **Identity State** (derived) | current-state + **CONFLICT** | §1/§3 |
| **Mint Execution** | anchor-creation operation (consumes Authorized-Minting-Basis) | §4 |
**MP0 · Layer Separation.** אף שכבה אינה מתחזה לאחרת: Policy מעריכה · RIA קובע · State נגזר · Mint מבצע. **RATIFY.**

## 1 · Executive §5 Verdict
> **RATIFY** — שכבת-ה-policy עקבית: **common substrate + decision-type-specialized authorizations**. תוקן: contradiction-in-evaluation ≠ CONFLICT · human-input ≠ CONFLICT · no-match ≠ DISTINCT ≠ mint-authorization · policy-replay ≠ side-effect-replay · No-Authorization ≠ UNRESOLVED-record ≠ State · authorization-identity ≠ mint-operation-identity · runtime-evaluator ≠ authority-source. סוגר §2 RA13 + §4 CR3/CR22 ברמת-policy-contract; mechanics/schema DEFERRED. אין reopening §0–§4.

## 2 · Policy Definition — **MP1**
> Identity Method Policy = **named, versioned, RIA-owned authorization contract** הקובע אם ה-authority-capable-inputs מספקים את authorization-conditions ל-**decision-type ספציפי**, בתוך scope. מובחן מ: Evidence · Authority-Class · Authorized-Basis · Source-Binding · Identity-Assertion · Identity-State · Canonical-Referent · Runtime. **RATIFY.**

## 3 · Substrate + Decision-Type Specialization — **MP2** (extensibility מרוסן)
> מסגרת-policy אחת (substrate) המנהלת authorization מיוחד ל-`SAME` / `DISTINCT` / `Minting`. **The substrate may support additional authorization decision-types under later contracts** — **אך §5 אינו מרתף ש-correction/reconciliation ישתמשו באותו output-type `Authorized Basis`**; exact lifecycle-authorization-semantics = §6+. **RATIFY** (substrate + open-extensibility).

## 4 · Versioning — **MP3**
> policy identity+version · deterministic-evaluation-under-pinned-inputs · historical-reproducibility · **policy-update לעולם לא משנה בשקט Assertion היסטורי** (§3 AS7). **RATIFY** · encoding **DEFERRED**.

## 5 · Decision-Specific Authorization — **MP4**
> authorization מוגדר **בנפרד** ל-SAME/DISTINCT/Minting: **SAME-sufficient ≠ DISTINCT-sufficient** (§2 RA15) · **Minting-sufficient ≠ SAME/DISTINCT-sufficient** (§4 CR3). אין generic `high-confidence→identity`. **RATIFY.**

## 6 · Method Definition — **MP5**
> Method = **named, versioned authorization procedure over admitted inputs** ≠ signal (`verified VAT`=signal; Method=כיצד הוא משתתף). **RATIFY.**

## 7 · Signal / Basis / Method + No Shortcut — **MP6**
> `Signal → Method-Evaluation → Authorized-Basis → (RIA) Assertion`. **אין `Signal → Assertion`.** **RATIFY** (INHERITED §2).

## 8 · Composition — **MP7** (terminology מדויק)
> Method-Evaluation פועלת על **admitted signals** ו/או **prior authorized facts/bases שה-lineage שלהם independently-valid** (authority-capable-inputs) — **ואינה מקבלת כ-input Authorized-Basis מאותה החלטה עצמה (no recursion).** composition **explicit + provenance-preserving**; **must not launder weak evidence into authority** (§2 RA13); אם prior-Authorized-Basis הוא input — provenance/lineage **חייב למנוע circular self-authorization** (MP11). אין scoring-engine. combinators **DEFERRED**. **RATIFY.**

## 9 · Confidence — **MP8**
> **Confidence alone never creates identity authority.** אם תשומש — משמעות+סף explicit; אין `score>0.8→SAME`. **RATIFY.**

## 10 · Authoritative Signals — **MP9** (inheritance מאומת)
> **authority של signal = policy-defined** (type/source/jurisdiction/method), **לא universal**. **חריג universal יחיד — INHERITED §2 RA8 (global lock):** *"Name alone is never sufficient identity authority"* (לא SAME, לא DISTINCT). *(מאומת: §2 RA8 נעל globally, לא illustrative.)* שאר-signals = policy-level. **RATIFY.**

## 11 · Human Authority — **MP10** (layer-corrected)
> Method-Policy מגדירה אם human-determination הופכת Authorized-Basis (reason/provenance/actor-scope/version, §2 RA11); **לא override-אוטומטי**. **Human input never directly creates CONFLICT.** *(human-SAME כ-signal בתוך evaluation → אין CONFLICT; CONFLICT רק אם RIA כבר הפיק authoritative-SAME-Assertion ובמקביל קיים applicable authoritative-DISTINCT-Assertion — §1/§3.)* **RATIFY.**

## 12 · Prior Mapping — **MP11**
> prior-mapping משתתף **רק** דרך **preserved-lineage ל-original-Authorized-Basis + still-applicable + no-conflict** (§2 RA19). **cached/stale ≠ authority; אין circular-authority.** **RATIFY.**

## 13 · Contradiction Handling — **MP12** (layer-corrected · הליבה)
> **Contradictory admitted inputs within a Method-Policy Evaluation** מטופלים per-policy ו-**may prevent authorization → `No-Authorization`, or (per an explicit contract) → `Failure`. They do NOT themselves constitute Identity-State CONFLICT.** **CONFLICT** מתעורר **רק** ב-state-derivation מ-**separate authoritative Assertions שה-applicability שלהן חופפת incompatibly** (§1 RS9 · §3 AS11). **אין silent-winner;** explicit-precedence = policy/lifecycle issue **OPEN**. **RATIFY.**

## 14 · Failure vs No-Authorization vs UNRESOLVED — **MP13** (הפרדת-שכבות)
> - **Policy-level:** `No-Authorization` = evaluation **succeeded** but authorized no decision-basis · `Failure` = evaluation **could not validly execute**.
> - **RIA relation/state-level:** `UNRESOLVED` = **valid/healthy/admitted identity question** without sufficient applicable SAME/DISTINCT authority (§3 AS12).
> **No-Authorization may contribute to an UNRESOLVED determination/state — but is not the same artifact.** אין cross-masquerade. **RATIFY.**

## 15 · Minting Policy — **MP14** (סוגר §4 CR3/CR22 ברמת-policy)
> `Authorized Minting Basis` = **output של Minting-decision-type evaluation** המרשה יצירת anchor חדש. **need not be a binding** (§4 CR3); **binding-existence ≠ minting-authority**. **Minting מתרחש אך ורק:** `Minting Method Evaluation → Authorized Minting Basis`. use-cases generic; product-rules **DEFERRED**. **RATIFY.**

## 16 · No-Match ≠ DISTINCT ≠ Minting-Authorization — **MP15** (מתוקן)
> **Failure to establish SAME with an existing referent does not establish DISTINCT and does not by itself authorize minting.** *(`no match found` **אינו** Authorized-Minting-Basis.)* **A Minting Policy MAY treat the result/history of an appropriate bounded resolution attempt as ONE admitted input to a *separate* Minting authorization evaluation.** (משמר §4 CR3/CR6/CR7.) **RATIFY.**

## 17 · Resolve-before-Mint — **MP16** (מתוקן)
> **Whether a resolution attempt is required before Minting Evaluation is policy-dependent** (Option C). **`resolution result ≠ mint authorization`** — גם אם resolution נכשל למצוא SAME, **Minting authorization עצמאי עדיין נדרש**. **RATIFY** · per-source-policy **DEFERRED**.

## 18 · Authorization-Identity vs Mint-Operation-Identity — **MP17** (מופרד)
> - **Authorization identity:** `Authorized Minting Basis` חייב להיות **reproducibly identifiable/traceable** מה-policy-evaluation שלו.
> - **Minting operation identity:** כאשר authorization **נצרך לבצע mint**, ה-**logical minting operation** חייבת להיות identifiable מספיק ל-**idempotent execution**.
> **Re-execution/retry of the same logical minting operation must not mint an additional anchor.**
> **DEFERRED:** האם op-identity נגזרת מה-Basis · Basis חד-פעמי-מול-reusable · token/idempotency-key · encoding/storage/runtime. *(replay של Method-Evaluation אינו mint-retry — MP21.)* **RATIFY** (requirement).

## 19 · Policy Scope — **MP18**
> scope **explicit**; **tenant-scope חובה** (§0 T); type/source/jurisdiction/method/purpose **זמינים, לא כולם נדרשים**. **RATIFY.**

## 20 · Policy Selection — **MP19** (anti-outcome-shopping)
> policy/version selection = **authorized, deterministic, context-pinned** function של tenant/type/source/purpose — **לא feature-chosen-per-call**. **Policy/method selection must be determined *before* observing the desired authorization outcome, and may not be switched post-evaluation merely because another policy would produce SAME/DISTINCT/Minting.** selection **replayable + pinned ל-Basis** (§3 AS10). mechanism **DEFERRED**. **RATIFY.**

## 21 · Policy Evolution — **MP20**
> historical-assertion נשאר תחת policy ה-pinned (§3 AS7); no-silent-reinterpretation; re-evaluation-תחת-policy-חדשה = evaluation/history חדש; mandatory/automatic-reprocessing **DEFERRED**. **RATIFY.**

## 22 · Replay — Pure Authorization vs Side-Effect — **MP21** (מתוקן)
> **Replaying a Method-Policy Evaluation reproduces its authorization result; it does NOT itself repeat the minting side-effect nor emit another Identity Assertion.** Policy-replay = **pure authorization replay**; execution/lifecycle-replay = **שכבה נפרדת**. determinism + pinning (admitted-inputs · policy-id/version · method · relevant-context). serialization **DEFERRED**. **RATIFY.**

## 23 · Policy Provenance — **MP22** (evaluator-terminology מופרד)
> Authorized-Basis traceable ל: **authority-capable-source provenance** · **policy/method identity** · **execution/evaluator provenance (רק אם contractually-relevant)**. **Runtime evaluator ≠ authority-source** — *authority comes from the ratified policy + Authorized-Basis chain, not from the software process merely executing it.* schema **DEFERRED**. **RATIFY.**

## 24 · Feature Boundary — **MP23 (THE cross-feature guard)**
> **Features may contribute signals and request identity resolution/minting, but may NOT privately define competing identity-authority rules.** Domain/source-specific **Methods** רק **תחת RIA policy-authority** (§2 RA17). **RATIFY.**

## 25 · Generic vs Type-Specific — **MP24**
> PARTY/RESOURCE/COMMITMENT חולקים framework; concrete rules/methods per-type/domain; **אין VAT-on-RESOURCE.** **RATIFY** (INHERITED).

## 26 · Policy Output — **MP25** (No-Authorization ≠ State/Assertion)
> **Method-Policy Evaluation output ∈ { typed Authorized-Basis (SAME/DISTINCT/Minting/…) | No-Authorization | Failure }.** **Policy אינה יוצרת Canonical-Referent ואינה emits Assertion** (RIA עושה, §4 CR5 · §2 RA2). **No-Authorization is a policy-evaluation result — NOT an Identity Assertion and NOT an Identity State**, ו-**does not require materializing an explicit UNRESOLVED Assertion** (כפוף §1 RS6). **RATIFY.**

## 27 · Tenant / Security Guard — **MP26**
> **Cross-tenant inputs/policies אינם UNRESOLVED — הם invalid/Failure** (§0 T5 · §1 RS13); **אין cross-tenant signal-mixing.** **RATIFY** (INHERITED).

## 28 · Proposed Normative §5 Locks (MP0–MP26)
| Lock | תוכן | סטטוס |
|---|---|---|
| MP0 | Four-layer separation (Policy/Determination/State/Mint) | RATIFY |
| MP1 | Policy = named/versioned/RIA-owned authorization contract | RATIFY |
| MP2 | Substrate + decision-type-specialized; extensible; no premature correction/reconciliation output-type | RATIFY |
| MP3 | Versioned/deterministic/reproducible; no silent historical change | RATIFY · encoding DEFERRED |
| MP4 | SAME≠DISTINCT≠Minting authorization sufficiency | RATIFY |
| MP5 | Method ≠ signal | RATIFY |
| MP6 | Signal→Method→Basis→Assertion; no Signal→Assertion | RATIFY (INHERITED §2) |
| MP7 | Composition over admitted-signals/prior-valid-bases; no recursion/laundering; no circular self-auth | RATIFY · combinators DEFERRED |
| MP8 | Confidence alone never authority | RATIFY |
| MP9 | Signal-authority policy-defined; name-alone-never-authority (INHERITED §2 RA8 global) | RATIFY |
| MP10 | Human policy-gated; not auto-override; **human input never directly creates CONFLICT** | RATIFY |
| MP11 | Prior-mapping via lineage+applicable+no-conflict; no circular authority | RATIFY |
| MP12 | **Contradiction-in-evaluation → No-Authorization/Failure, NOT CONFLICT**; CONFLICT only from incompatible applicable authoritative Assertions | RATIFY |
| MP13 | Policy-level {No-Authorization,Failure} vs State-level {UNRESOLVED}; not same artifact | RATIFY |
| MP14 | Authorized-Minting-Basis = Minting-eval output; ≠binding; mint only via Minting-eval | RATIFY · rules DEFERRED |
| MP15 | **No-match ≠ DISTINCT ≠ minting-authorization**; resolution-result = one admitted input to separate Minting eval | RATIFY |
| MP16 | Resolve-before-mint policy-dependent; **resolution-result ≠ mint-authorization** | RATIFY · per-source DEFERRED |
| MP17 | Authorization-identity vs mint-operation-identity separated; retry-idempotent; encoding DEFERRED | RATIFY |
| MP18 | Scope explicit; tenant mandatory; others optional | RATIFY |
| MP19 | Policy-selection authorized/deterministic/pinned; **no post-eval outcome-shopping** | RATIFY · mechanism DEFERRED |
| MP20 | Policy-evolution forward-only; reprocessing DEFERRED | RATIFY |
| MP21 | **Policy-replay = pure authorization replay ≠ side-effect/assertion replay**; pinning req | RATIFY · serialization DEFERRED |
| MP22 | Provenance separated; **runtime-evaluator ≠ authority-source** | RATIFY · schema DEFERRED |
| MP23 | **No feature-owned identity policy** | RATIFY |
| MP24 | Generic framework + type/domain methods; no VAT-on-RESOURCE | RATIFY |
| MP25 | Output={Authorized-Basis\|No-Authorization\|Failure}; **No-Authorization ≠ Assertion ≠ State** | RATIFY |
| MP26 | Cross-tenant = invalid/Failure (not UNRESOLVED); no signal-mixing | RATIFY (INHERITED) |

## 30 · OPEN / DEFERRED (§5)
1. Concrete **Method schema** + combinators/thresholds (MP7/MP8) · full **Method-Policy schema** (MP1).
2. Concrete **Minting rules** (MP14) · resolve-before-mint per-source (MP16) · **mint-operation-identity/idempotency encoding** (MP17).
3. **Policy-selection mechanism** (MP19) · mandatory/automatic **reprocessing** (MP20).
4. **Replay serialization/pinning encoding** (MP21) · **policy-provenance schema** (MP22).
5. Per-identifier signal-authority rules (MP9 · §2 RA5–RA10) · **precedence-policy** content (MP10/MP12 · §2 RA22).
6. **כל §0–§4 OPEN/DEFERRED** נשמרים (reconciliation/split/lifecycle mechanics · replay-encoding · temporal-model · CONFLICT-adjudication · re-attribution-mechanism · provenance-schema · Form-1-negative · RESOURCE/COMMITMENT-rules · EVENT · implementation).

---

---

# RIA-1 · §6 — Temporal, Applicability & Replay Model
*נעול ב-§0–§5 = INHERITED. Prefix: `TR`.*

## 1 · Executive §6 Verdict
> **RATIFY** — RIA v1 = **dual-time semantics** (recorded/knowledge-time **חובה** + effective/valid-semantics **זמין בעת-הצורך**). **effective-time עצמו corrigible append-only** (temporal-corrections נוספות, לעולם לא ממטטות). **Current-State = Effective-State-At(EvaluationTime מפורש)**, אין `Date.now()` authority. **full-bitemporal-infrastructure DEFERRED — לא נדחה-כמיותר.** applicability = contextual/temporal; לא נבחר reconciliation/split representation ולא encoding.

## 2 · Temporal Concepts — **TR1** (Execution מדויק)
| מושג | הגדרה |
|---|---|
| **Recorded/Knowledge Time** | מתי RIA רשמה assertion/correction/lifecycle-info — **necessary תמיד** |
| **Effective/Valid Time** | מתי ה-semantics חלים על ה-interpretation — **necessary כ-capability, optional per-fact** |
| **Query Time** | לאיזה זמן מבקשים reconstruction — **necessary** |
| **Execution reference** | **Historical-Execution-Replay is keyed by execution-identity + its pinned consumed-context; wall-clock execution-timestamp alone does not define the replay state.** execution-record חייב: identify-execution · pin-consumed-identity-state/context · temporal-provenance-לaudit |
**TR1.** *(אין טענה ש-execution-time לעולם אינו semantic-axis בתחומים אחרים — ב-RIA §6 די בהיות ה-replay keyed-by-execution-identity+pinned-context.)* **RATIFY.**

## 3 · Recorded ≠ Effective Time — **TR2**
> recorded-time ≠ effective-time; `recordedAt=Aug10, effectiveFrom=Jul1` **representable** (Model-B). **RATIFY.**

## 4 · Retroactivity — **TR3**
> correction **MAY carry effective-time reaching a past point**, **ללא mutation של record** (§3 AS3). *(Model-A forward-only נדחה; Model-C — §29.)* **RATIFY.**

## 5 · Knowledge History vs Current-Effective Belief — **TR4**
> **"מה ידענו אז"** (knowledge/recorded) ≠ **"מה אנו מאמינים כעת שהיה נכון ב-T"** (current-effective, המשתמש ב-info-מאוחר-מורשה שה-effective מגיע ל-T). **retroactive-correction ≠ rewriting-history.** **RATIFY** (INHERITED §3 AS3).

## 6 · Effective-Time Corrections Are Corrigible History — **TR5 (חדש · ליבה)**
> **Effective-time semantics themselves are part of append-only corrigible temporal history.** **A later authorized temporal correction never mutates an earlier recorded temporal claim; it adds new authorized history from which applicability is re-derived.**
> **דוגמה:** C1 (recorded Aug10) → relation effective-from-Jul1; C2 (recorded Aug20) → authoritatively corrects the effective boundary to Jul15. **שתי ה-facts נשמרות append-only.** ומכאן:
> - **Knowledge-As-Of(recorded=Aug15, effective-Jul10)** → משחזר את **ה-temporal-claim הקודם (Jul1)** — כי C2 טרם נרשם.
> - **Current Effective-State-At(Jul10)** → עשוי להשתמש ב-**temporal-interpretation המתוקן (Jul15)**.
> - **Historical Execution Replay** → נשאר what-execution-consumed.
> **RATIFY.** *(representation/artifact DEFERRED — §29 מוכיח representability בלי לטעון ש-full-C מיותר.)*

## 7 · Historical Execution Replay — **TR6**
> execution-relative; משחזר את ה-basis/context ש-E **צרך בפועל**; **later corrections must NOT silently change its answer.** **RATIFY.**

## 8 · General Temporal Reconstruction — **TR7** (שתי שאלות)
> **Knowledge-As-Of(T)** (info recorded/authorized עד recorded-time-T; history-boundary, TR17) ⊕ **Effective-State-At(T)** (identity effective ב-effective-time-T תחת reconstruction-context). **שתי שאלות נפרדות — אין `asOf(T)` יחיד.** **RATIFY.**

## 9 · Execution-Replay ≠ General-Reconstruction — **TR8**
> **NOT** `replay(execution) == reconstruct(T)` universally; later-corrections legitimately מפרידים. **RATIFY.**

## 10 · Applicability Model & Contextuality — **TR9**
> `applicable/superseded/in-force` (§3 AS4 derived) מחושבים מ: assertion-history · supersession/temporal-correction-history · effective-semantics · policy/context-pinning · tenant · referent-type · **temporal/reconstruction-context**. **An assertion is not universally "applicable" in isolation — applicability is derived relative to a temporal/reconstruction context** (what-execution-consumed / no-longer-current / effective-for-one-interval / superseded-under-current). **RATIFY** · schema DEFERRED.

## 11 · Supersession Temporal Invariant — **TR10** (כללי, לא latest-row)
> **Applicability transitions are derived from the authorized lifecycle/temporal history and its effective semantics; recorded order alone is insufficient.** **`latest row wins` אסור.** *(supersession artifact עצמו OPEN, §3 AS5 — לכן אין הנחה ש-B יחיד תמיד supersedes A.)* **RATIFY.**

## 12 · Correction Temporal Shape — **TR11** (לא single-effectiveFrom-only)
> `A recorded t1` → `correction C recorded t3`; **A's record preserved.** **A correction/reversal must carry or derive sufficient temporal semantics to determine the interval(s)/point(s) over which its corrected interpretation is applicable** — ברוב המקרים `effectiveFrom`, אך **exact temporal shape = part of the temporal-representation contract (DEFERRED)**; אין נעילת single-boundary-only. **RATIFY.**

## 13 · Split / Reversal Temporal Basis — **TR12** (מספק ל-§7)
> §6 הופך את **interval(s)/point(s) של הפרשנות-המתוקנת ל-representable** (TR11); **ה-split/reconciliation MECHANISM נשאר §7.** **RATIFY** (representability).

## 14 · Late-Arriving Information — **TR13**
> **arrival/recording order ≠ effective-world order** (Model-B). determinism דורש ordering חד-משמעי כאשר temporal-facts שווים/חופפים → **tie-break contract-defined או DEFERRED** (TR26). **RATIFY.**

## 15 · Future-Effective — **TR14** (DEFERRED, compatible)
> future-effective **לא-נדרש ל-v1** (DEFERRED; אין scheduling). **EvaluationTime semantics (TR16) חייבים להישאר compatible אם capability תתווסף** — אין lock המניח ש-future-effective אינו קיים. **DEFER.**

## 16 · Open-Ended Applicability — **TR15**
> `from T onward until superseded` = **semantic interval**, ללא arbitrary end-date; **representation DEFERRED** (לא requirement ל-`end=null`). **RATIFY.**

## 17 · Current State — **TR16** (EvaluationTime מפורש, ללא wall-clock)
> **Current Identity State is Effective-State-At(EvaluationTime) under the authoritative current-history visibility boundary, where EvaluationTime is explicit or deterministically supplied by the execution/reconstruction context.** `current` = convenience-semantic; **EvaluationTime חייב pinned/explicit מספיק לשחזור; אין hidden `Date.now()` authority.** future-effective-facts (אם ייתמכו) נבחנים מול EvaluationTime. **RATIFY.**

## 18 · Knowledge-As-Of Boundary — **TR17** (recorded-by-T ≠ applicable)
> **הפרדה:** *Recorded-by-T* (fact קיים ב-history) מול *Authorized/applicable-under-the-historical-reconstruction-context* (admissible-for-derivation). **Knowledge-As-Of uses only history visible by the recorded-time boundary AND only according to the authority/applicability semantics valid for that reconstruction context.** **`recorded ≤ T → automatically applicable` אסור.** **RATIFY.**

## 19 · No Future-Knowledge Leakage — **TR18 + TR19**
- **TR18.** **Knowledge-As-Of must NOT consume assertions/lifecycle-info not yet recorded/authorized within its history boundary** (audit/learning-evaluation). **RATIFY.**
- **TR19.** **Current-effective-state-for-past-time MAY legitimately differ from what-was-knowable-then** (retroactive-effective) — **≠ rewriting-history.** **RATIFY.**

## 20 · Policy-Version Interaction — **TR20** (INHERITED §5 MP20)
> Assertion-provenance (נשאר תחת policy-מפיק) · Current-reconstruction (**policy חדשה אינה מפרשת מחדש assertion ישן**) · Re-evaluation (policy חדשה → history חדש). **RATIFY.**

## 21 · State Reproducibility — **TR21** (semantic pinning; INHERITED §3 AS14)
> חייב-pinned: history-visibility-boundary · temporal-query-semantics (איזו משלוש-השאלות + T) · **EvaluationTime** · applicable-policy/context · tenant/type · lifecycle-basis. **encoding DEFERRED** (§0 R3). **RATIFY.**

## 22 · CONFLICT & UNRESOLVED Over Time — **TR22 + TR23**
- **TR22 · CONFLICT not timeless.** SAME/DISTINCT עשויים לסתור **רק בחלק מהטווח**; CONFLICT derived-relative-to-applicability/context/time (§1 RS9 · §3 AS11). adjudication DEFERRED. **RATIFY.**
- **TR23 · UNRESOLVED not permanent.** later-authority משנה current/effective; **execution-replay נשאר what-was-consumed.** **RATIFY.**

## 23 · Re-Attribution Temporal Basis — **TR24** (traceability, לא algorithm)
> `whether artifact needs reprocessing` **אינו נקבע רק ע"י ה-effective-time של ה-correction** — נדרש גם: **identity-state actually-consumed · correction-effective-reach · relevant business/event-time (אם downstream תלוי בו) · reconstruction-policy/context.** **§6 נועל temporal-traceability requirement, לא decision-algorithm ולא propagation** (§3 AS9). **RATIFY.**

## 24 · Determinism & Ordering — **TR25 + TR26**
- **TR25 · Replay determinism (universal).** אותו temporal-reconstruction-spec + אותה visible-authoritative-history + אותו pinned-context (כולל EvaluationTime) → **אותו state.** **אין תלות ב-wall-clock / unordered-DB-rows / latest-row / mutable-feature-state.** **RATIFY.**

## TR26 (מתוקן) — Ordering & Ambiguity
> **When multiple authorized temporal facts cannot be ordered by their recorded/effective temporal semantics alone, the contract must either provide an explicit deterministic semantic ordering rule/token OR surface an explicit temporal ambiguity/failure condition. Incidental persistence order, database row order, or an implementation sequence number that has NOT been granted contractual ordering semantics MUST NOT determine authority or applicability.**
> - **contractual semantic ordinal/token** — חוקי בעתיד (אם החוזה יגדיר אותו כחלק סמנטי מה-append-only history);
> - **incidental sequence / DB-row / storage-engine / auto-increment-as-precedence** — **אסור**;
> - ordering-representation-mechanism **DEFERRED**.
> **Temporal ambiguity ≠ automatically §1 Identity-State CONFLICT** (נשמר). **RATIFY** · tie-break/token **DEFERRED**.
## 25 · Tenant / Type — **TR27 + TR28**
- **TR27 · Tenant.** temporal-reconstruction tenant-scoped; אין cross-tenant history; cross-tenant-data אינו historical-evidence. **RATIFY** (INHERITED §0 T).
- **TR28 · Type.** PARTY/RESOURCE/COMMITMENT חולקים framework; type-specific temporal-rules רק later; **EVENT deferred.** **RATIFY.**

## TR29 (מתוקן — Option B) — Bitemporality Verdict
> ### Recommended v1 semantic model: **`RECORDED/KNOWLEDGE TIME + EFFECTIVE/VALID SEMANTICS`** (dual-time semantics)
> - **mandatory recorded-time**;
> - **effective temporal semantics available where required**;
> - **Every fact must have sufficient temporal semantics to derive applicability under the applicable temporal contract.**
> - **append-only corrections to BOTH identity claims AND temporal claims** (TR5);
> - **explicit history-visibility-boundary** (TR17/TR18) + **explicit EvaluationTime** (TR16/TR21);
> - **no requirement yet for a specific full-bitemporal persistence/query engine.**
>
> **`The default temporal interpretation for facts without an explicit effective specification remains DEFERRED`** — לא ננעל default (כגון effective-from-recorded-time) ללא Contract-Proof; לא ממציאים default לנוחות.
> **`Full formal bitemporal implementation = DEFERRED` — NOT "rejected because unnecessary."** Semantic bitemporality may be required even if full bitemporal infrastructure is not. **RATIFY dual-time semantics · DEFER (default-interpretation + full-bitemporal-infrastructure).**
## 27 · Proposed Normative §6 Locks (TR1–TR29)
| Lock | תוכן | סטטוס |
|---|---|---|
| TR1 | Recorded/Effective/Query axes; Execution replay keyed-by-identity+pinned-context (not wall-clock) | RATIFY |
| TR2 | Recorded ≠ Effective; representable | RATIFY |
| TR3 | Retroactivity via Model-B; no record mutation | RATIFY |
| TR4 | Knowledge-history vs current-effective; retroactive ≠ rewrite | RATIFY |
| TR5 | **Effective-time semantics themselves append-only corrigible; temporal-correction adds history, never mutates** | RATIFY · artifact DEFERRED |
| TR6 | Historical-Execution-Replay execution-relative; corrections don't change it | RATIFY |
| TR7 | General = Knowledge-As-Of ⊕ Effective-State-At (distinct) | RATIFY |
| TR8 | replay(execution) ≠ reconstruct(T) universally | RATIFY |
| TR9 | Applicability derived & contextual, not universal-in-isolation | RATIFY · schema DEFERRED |
| TR10 | Applicability transitions from lifecycle/temporal history + effective semantics; not latest-row | RATIFY · artifact DEFERRED |
| TR11 | Correction carries/derives sufficient temporal semantics for applicable interval(s); not single-effectiveFrom-only; shape DEFERRED | RATIFY |
| TR12 | Split/reversal temporal-basis representable; mechanism §7 | RATIFY |
| TR13 | Arrival-order ≠ effective-order; tie-break DEFERRED | RATIFY |
| TR14 | Future-effective DEFERRED; EvaluationTime-compatible | DEFER |
| TR15 | Open-ended interval semantic; representation DEFERRED | RATIFY |
| TR16 | Current = Effective-State-At(explicit EvaluationTime); no hidden wall-clock | RATIFY |
| TR17 | Knowledge-As-Of: visible-by-recorded-boundary AND per reconstruction-context applicability; recorded≤T ≠ applicable | RATIFY |
| TR18 | No future-knowledge leakage | RATIFY |
| TR19 | Current-effective-of-past may differ from knowable-then (≠ rewrite) | RATIFY |
| TR20 | Policy-versions don't reinterpret old assertions | RATIFY (INHERITED §5) |
| TR21 | Semantic pinning (boundary/query/EvaluationTime/policy/tenant/type/lifecycle); encoding DEFERRED | RATIFY |
| TR22 | CONFLICT not timeless; derived over time; adjudication DEFERRED | RATIFY |
| TR23 | UNRESOLVED not permanent; execution-replay stable | RATIFY |
| TR24 | Re-attribution temporal traceability (state-consumed+correction-reach+business/event-time+context); not algorithm/propagation | RATIFY |
| TR25 | Replay determinism; no wall-clock/DB-row/latest-row/mutable-state | RATIFY |
| TR26 | Ordering: contractual semantic ordinal/token allowed-future; **incidental DB/sequence/storage order MUST NOT determine authority/applicability**; else explicit ambiguity/failure; ambiguity≠auto-CONFLICT | RATIFY · tie-break/token DEFERRED |
| TR27 | Temporal reconstruction tenant-scoped | RATIFY (INHERITED) |
| TR28 | Type framework shared; type-specific later; EVENT deferred | RATIFY |
| TR29 | **Dual-time semantics required; every fact must carry sufficient temporal semantics for applicability; default-for-facts-without-explicit-effective DEFERRED; full-bitemporal infrastructure DEFERRED (not rejected)** | RATIFY · defaults+full-C DEFERRED |

## 30 · OPEN / DEFERRED (§6)
- **Default temporal interpretation** for facts without explicit effective specification (TR29) — **חדש ב-deferred**.
- **Contractual semantic ordering token/ordinal** representation + tie-break for equal recorded+effective (TR26/TR13) · **temporal-failure/ambiguity disposition taxonomy** (TR26).
- **Full-bitemporal infrastructure/engine** (TR29) · **Future-effective/scheduling** (TR14).
- **Exact temporal shape of corrections** (point/interval/multi) (TR11) · **Temporal encoding** (recorded/effective representation · state-ID/snapshot) (TR15/TR21 · §0 R3 · §3 AS14).
- **Supersession/correction artifact** (TR5/TR10/TR11 → §7) · **CONFLICT temporal-adjudication** (TR22) · **re-attribution propagation** (TR24) · **type-specific temporal rules** (TR28) · **EVENT** (§0 G4).
- **כל §0–§5 OPEN/DEFERRED** (reconciliation/split mechanics §7 · Method-Policy schema · privacy · implementation).

---

# RIA-1 · §7 — Reconciliation, Split & Identity Lifecycle Semantics
*נעול ב-§0–§6 = INHERITED. ההכרעות D1–D4 = OWNER-RATIFIED.*

## 1 · Executive §7 Verdict
> **RATIFY** — §7 = **representation-neutral semantic mechanics** של **Authorized Identity Lifecycle Change (AILC)** מעל ה-**derived current-identity-interpretation**. **applicable-authorized-SAME → derived-reconciliation בלבד** (D1); **materialized-effects נפרדים+DEFERRED**; CONFLICT/UNRESOLVED **חוסמים collapse**; anchors **נשמרים היסטורית**; four-way-attribution **לא קורס**; partial-split נתמך; type-correction=append-only-retire+re-attribution. **לא צצה החלטה סמנטית חדשה מעבר ל-D1–D4 והמוכתב** → self-ratify מותר. **לא נבחר survivor/alias/cluster/pointer/persistence.**

## 2 · Scope & Layer Boundary — **RC0**
> §7 מגדיר את הסמנטיקה של AILC מעל ה-**derived Identity State** (§3 AS6). הוא **צורך** §0–§6, **אינו** בוחר representation/persistence, **אינו** מבצע materialized-mutation, **אינו** נוגע ב-C0/Evidence. Layers (§5 MP0) נשמרים: Policy-authorizes · RIA-asserts · **State-derives (כאן) · Mint/Materialized-executes (deferred).** **RATIFY.**

## 3 · Definitions — **RC1**
- **Authorized Identity Lifecycle Change (AILC):** משפחה סמנטית של שינויי-זהות-מורשים מעל ה-derived-state.
- **Kinds:** `Reconciliation` · `Reversal/Split` · `Type-Correction` (distinct).
- **Current Identity Interpretation (CII):** ה-derived equivalence-class-interpretation תחת authoritative-current-temporal-reconstruction-context (D4).
- **Historical Anchor:** Canonical Referent שנשאר קיים-היסטורית (§4 CR12).
- **Four-Way Attribution:** Original · Current-Interpretation · Effective-At(T) · Execution.
**RATIFY** (definitions; encoding DEFERRED).

## 4 · Authorized Identity Lifecycle Change — **RC2** (D2)
> **Reconciliation, Reversal/Split, ו-Type-Correction הם משפחה אחת — AILC — עם shared invariants:** authorization (§2/§5) · append-only-history (§3 AS3) · provenance · lineage (§2 RA19) · temporal-semantics (§6) · replay/reconstruction-compat (§6) · correction-compat (§4 CR25). **הם transition-kinds נבדלים עם semantics נפרדים — לא אותה פעולה.** **artifact/schema/enum-encoding DEFERRED.** **RATIFY.**

## 5 · Reconciliation Semantics — **RC3** (D1)
> **Applicable authoritative SAME ⟹ the derived CII treats the involved referents as one identity equivalence-class.** **SAME alone MUST NOT imply mutation/materialization of product-storage, feature-FKs, indexes, mappings, or downstream artifacts.** `Authorized SAME → Derived Reconciliation`; **NOT** `Authorized SAME → Storage Mutation`. materialized-reconciliation-effect = **separate execution concern, authorized-separately, DEFERRED** (RC22). **RATIFY.**

## 6 · Current Identity Resolution — **RC4** (D4)
> **Current Identity Resolution = the derived equivalence-class interpretation produced under the authoritative current temporal reconstruction context.** referents **נשארים anchors היסטוריים נפרדים** ובכל-זאת **משתייכים לאותה CII**. **אינו מחייב** survivor / canonical-winner / group-row / pointer / alias / rewritten-FK. **representation DEFERRED.** **RATIFY.**

## 7 · Equivalence / Transitivity — **RC5** (INHERITED §1 RS4)
> CII = **equivalence-closure של applicable-authorized-SAME** תחת temporal-context — **consumable-via-derived-canonical-state, NO invented-pairwise** (§1 RS4/§0 I5). closure **מוגבל ע"י** applicable-DISTINCT/CONFLICT (RC6). **RATIFY** (inherit).

## RC6 (מתוקן) — DISTINCT / UNRESOLVED / CONFLICT — Bounds on the Closure (no graph-cut)
> - **UNRESOLVED:** אין reconcile (§5 no-match≠merge · §1 I2).
> - **DISTINCT — שני מקרים נבדלים:**
>   - **(a) Constraining (ללא contradictory SAME path):** applicable-DISTINCT בין referents פירושו ש**אסור לגזור אותם לאותה equivalence-class** — ה-closure (RC5) פשוט **לעולם אינו כולל את שניהם**. זהו **bound תקין ובריא** על ה-closure — **לא cut, לא CONFLICT** (הם מעולם לא היו equivalent).
>   - **(b) Contradictory (ה-SAME-closure applicable מחייב equivalence של אותם referents ש-applicable-DISTINCT מחייב distinctness שלהם):** **זהו CONFLICT** (§1 RS9). **RIA MUST NOT** perform graph-cut · `DISTINCT wins` · `SAME wins` · maximal-consistent-subset · edge-deletion · arbitrary-partition · או כל auto-derived-partition. reconciliation **abstains** (D3); ה-derived Identity State של ה-referents-המעורבים = **CONFLICT**; **non-actionable-for-reconciliation** עד ש-authorized-later-history מניב applicability שאינה-CONFLICT.
> - **דוגמה מחייבת:** `R1 SAME R2` · `R2 SAME R3` · `R1 DISTINCT R3`, כולם applicable באותו temporal-reconstruction-context → **derived Identity State = CONFLICT**. **אסור** לגזור אוטומטית `{R1,R2}`/`{R3}` או כל partition.
> - **ניגוד:** אם SAME היסטורי **כבר אינו applicable** בגלל authorized correction/supersession/effective-time (§3/§6), אז DISTINCT **משתתף בגזירת state תקין ללא CONFLICT**.
> - **DEFERRED:** CONFLICT-adjudication-algorithm · SAME↔DISTINCT precedence · graph-algorithm מעבר לאמור. **RATIFY.**
## 9 · Historical Anchor Preservation — **RC7 + RC8** (INHERITED §4 CR12/CR9 · §3 AS3)
> **No destructive merge.** reconciliation **לעולם לא מוחקת/בולעת anchor**; anchors **נשארים historically-existent**; **IDs never-reused**. **RATIFY** (inherit).

## 10 · Four-Way Attribution — **RC9** (INHERITED §6)
> **Original-Attribution (immutable) · Current-Interpretation (derived) · Effective-Attribution-At(T) (derived) · Execution-Attribution (stable) — coexist, לעולם לא קורסים.** **RATIFY.**

## 11 · Split / Reversal — **RC10** (INHERITED §4 CR11 · §6 TR12)
> later-authorized-DISTINCT-correction (effective per §6) **מפריד את ה-current/effective-interpretation** מ-ה-temporal-basis שלו; **historical-state + reconciliation-history נשמרים; Historical-Execution-Replay unchanged; Evidence immutable.** **RATIFY.**

## 12 · Partial Split — **RC11**
> ה-equivalence-interpretation **חייב לתמוך partial-separation** (`R1 SAME R2` נשאר, `R3 DISTINCT` עוזב) via **re-derivation** מ-ה-assertion/correction-history — **ללא destructive/survivor-requirement** (מבחן-מכריע נגד survivor-only). **RATIFY.**

## 13 · Correction-of-Correction — **RC12** (INHERITED §6 TR5)
> `reconcile → reverse → correct-reversal` — כולם **append-only temporal-corrections**; reconstruction **דטרמיניסטי** מ-visible-history + EvaluationTime. **RATIFY** (inherit).

## 14 · Type-Correction — **RC13** (D2 + INHERITED §4 CR16 · §1 RS12)
> anchor-**type immutable**; mistype-correction = **retire the mistyped anchor's current-applicability + a correctly-typed anchor carries the bindings via interpretive re-attribution + append-only correction-record.** ה-mistyped-anchor **נשאר historically-existent** (RC8). שני ה-anchors **אינם related-by-SAME** (cross-type אסור, §1 RS12) — הקשר הוא **type-correction lifecycle-change, לא identity-equivalence ולא relation-outcome רביעי** (§1 RS2 נשמר). **linking-mechanism DEFERRED.** **RATIFY.**

## 15 · Interpretive Re-attribution — **RC14** (D1/D2)
> **Interpretive re-attribution = DEFAULT** (current-query מבינה historical-artifact תחת CII). **Materialized re-attribution / business-reprocessing = separate execution concern, DEFERRED** (§3 AS9-propagation-mechanism). **Original source-provenance/attribution always-reproducible** (§4 CR2 · §3). **RATIFY.**

## 16 · Cross-Feature Resolution — **RC15** (use-case מרכזי)
> Documents/Payments/Conversations/CRM/Inventory/other-features **may consume the shared CII view WITHOUT rewriting their source records**; ה-view **ממפה feature-referents/bindings ל-current-equivalence-class**. (זהו ה-derived-state §3 AS6 שהפך consumable, D4.) **RATIFY.**

## 17 · Feature-FKs ≠ Identity Authority — **RC16** (INHERITED §MP23 · Party-strategy)
> **Product/entity foreign keys are feature storage; RIA identity interpretation is a separate authority layer.** **updating a feature FK is NOT identity reconciliation.** feature-FKs מפנים ל-feature-entities (שעשויים להיות Source-Bindings, §4 CR19). **RATIFY.**

## 18 · Tenant / Type Boundaries — **RC17 + RC18** (INHERITED)
> **Tenant:** אין cross-tenant reconciliation/interpretation/re-attribution/survivor/group; cross-tenant=invalid (§0 T5 · CR17). **Type:** reconciliation/equivalence **same-type-only** (§1 RS12); cross-type=invalid; **EVENT out-of-scope** (§0 G4). **RATIFY** (inherit).

## 19 · Temporal Integration with §6 — **RC19** (INHERITED §6)
> כל AILC-effect **recorded/effective per §6 dual-time**; Knowledge-As-Of / Effective-State-At / Historical-Execution-Replay **distinct**; **explicit EvaluationTime**; correction-of-effective **append-only**. **§7 יורש §6 בקפדנות — אינו ממציא temporal.** **RATIFY.**

## 20 · Replay / Determinism — **RC20** (INHERITED §6 TR25)
> **same authoritative-history + same temporal-context → same derived CII.** אין תלות ב-wall-clock/DB-order/latest-row/mutable-feature-state. **RATIFY.**

## 21 · Materialized Effects Boundary — **RC22** (D1/D3)
> **SAME/AILC derive interpretation only; any materialized mutation/execution is a separate authorized contract, DEFERRED.** **Derived-state recomputation = deterministic/replayable, needs NO operation-ID.** **Materialized-execution idempotency = DEFERRED** (עד שחוזה-materialized-execution קיים). **RATIFY.**

## 22 · No Rewrite Guards — **RC21**
> **No Evidence/C0 mutation** (§0 N1) · **no historical-execution rewrite** (§6 TR6) · **no policy-version rewriting of historical lifecycle interpretation** (§5 MP20 · §6 TR20). **RATIFY.**

## 23 · Representation Neutrality — **RC23**
> **No §7 rule requires** survivor · alias · cluster-row · canonical-group-ID · parent-pointer · mutable-canonicalReferentId · FK-rewrite · DB-merge. **all encoding DEFERRED.** **RATIFY.** *(אומת ב-Representation-Stress-Test §25.)*

## 26 · Proposed Normative Locks (RC0–RC23) — RATIFY-summary
RC0 scope-neutral · RC1 definitions · RC2 AILC-family · RC3 SAME→derived-reconciliation-not-storage · RC4 CII=derived-equivalence-class · RC5 transitivity-via-derived-state · RC6 DISTINCT/UNRESOLVED/CONFLICT-block-collapse · RC7 no-destructive-merge · RC8 anchor-preservation · RC9 four-way-attribution · RC10 split/reversal · RC11 partial-split · RC12 correction-of-correction · RC13 type-correction-append-only · RC14 interpretive-re-attribution-default · RC15 cross-feature-view-no-rewrite · RC16 feature-FKs≠authority · RC17 tenant · RC18 same-type · RC19 temporal-inherit-§6 · RC20 replay-determinism · RC21 no-rewrite-guards · RC22 materialized-boundary-deferred · RC23 representation-neutral. **כולם RATIFY.**

## 27 · Forbidden-Shortcut Scan (כולם חסומים)
`SAME→delete-duplicate`(RC7) · `SAME→rewrite-FKs`(RC3/RC16) · `SAME→choose-winner`(RC4) · `latest-anchor-wins`(§6 TR10/RC20) · `feature-customerId-defines-identity`(RC16) · `reconciliation-mutates-C0`(RC21) · `reconciliation-mutates-historical-Assertion`(RC21/§3 AS3) · `reconciliation-rewrites-Execution-Replay`(RC21/§6 TR6) · `CONFLICT→best-guess`(RC6) · `UNRESOLVED→probable-merge`(RC6) · `split-deletes-reconciliation-history`(RC10/RC8) · `type-correction-mutates-anchor-type`(RC13) · `current-interpretation-replaces-original-attribution`(RC9/RC14) · `materialized-state-defines-truth`(RC22/§3 AS6) · `DB-topology-defines-SAME`(RC20/RC23). ✅

## 29 · OPEN / DEFERRED (§7 — נשמרים כנדרש)
survivor/alias/cluster/pointer representation · persistence/storage-schema · reconciliation-operation-ID · materialized-execution-mechanism · materialized-re-attribution-propagation · downstream-business-reprocessing · CONFLICT-adjudication · Method-Policy-concrete-schema · privacy/erasure · API/product-behavior · encoding/hashing · **type-correction linking-mechanism** · **EVENT** · full-failure-taxonomy · **כל §0–§6 OPEN/DEFERRED**.

---

# RIA-1 · §8 — Production Method-Policy Authorization Structure
*Prefix: `PA`. §0–§7 = INHERITED. Meta-contract: how a versioned Method Policy turns admitted signals into a typed Authorized Basis for SAME / DISTINCT / Minting; it allocates no concrete identifier rule.*

## §8 Terminology
- **Evaluation Context** — a pinned body of admitted evidence/signals + scope + temporal context; may be relevant to more than one Authorization Question.
- **Authorization Question** — one typed, single-decision-category question (SAME **or** DISTINCT **or** Minting) over a bounded candidate.
- **Authorization Evaluation** — the application of the applicable versioned Method Policy to an Evaluation Context to answer **one** Authorization Question.

## §8 Normative Locks (PA1–PA26)
- **PA1** — A Method Policy is a **named, versioned, RIA-owned authorization contract**; not feature-owned. *(MP1/RA17)*
- **PA2** — Every Method Policy declares an **explicit scope**: tenant (mandatory), Referent Type, the decision-categories it may authorize, its method(s), and temporal applicability. *(MP18/MP24/RA17/§6)*
- **PA3** — A Method Policy is **deterministic under a pinned evaluation context, auditable, provenance-preserving, replay-compatible**. *(MP3/MP21/RA18/§6)*
- **PA4** — A Method Policy declares **separately** the authorization conditions for each decision-category (SAME / DISTINCT / Minting). *(MP4/RA15)*
- **PA5** — Serialization / schema / DB / registry representation of a policy is **DEFERRED**. *(§0 R3)*
- **PA6** — An **Authorization Evaluation** answers exactly **one Authorization Question**. A single pinned **Evaluation Context** MAY be evaluated against **multiple** Authorization Questions, each by its own Authorization Evaluation. *(MP0/RA1)*
- **PA7** — Evaluation **semantic inputs** (requirement, not a DTO): the candidate referent/binding(s) · admitted evidence/signals · Method-Policy identity+version · tenant · Referent Type · EvaluationTime/temporal context · relevant authority & lifecycle context. Encoding **DEFERRED**. *(§2/§5/§6)*
- **PA8** — Evaluation output ∈ **{ Authorized Basis | No-Authorization | Failure }**. *(MP25)*
- **PA9 · Cardinality** — Each Authorization Question is scoped to one decision-category and yields **at most one Authorized Basis** for that question (zero ⇒ No-Authorization). Multiple relations/candidates ⇒ multiple Authorization Evaluations. **The same admitted evidence / Evaluation Context MAY supply grounds relevant to both a SAME and a DISTINCT Authorization Question**; single-question cardinality **MUST NOT** be read as eliminating authority-relevant SAME/DISTINCT co-authorization. *(ratified D1)*
- **PA10** — Keep **five** layers distinct, never conflated: **multiple Evidence ≠ multiple grounds ≠ multiple Authorization Questions ≠ multiple Authorized Bases ≠ multiple Assertions.** Several grounds for one question = **one** Basis (multi-ground provenance). *(MP7/RA13)*
- **PA11** — SAME-fail **⇏** DISTINCT; no-match **⇏** DISTINCT and **⇏** Minting-authorization. *(RA15/RA16/MP15)*
- **PA12** — **DISTINCT requires affirmatively-established distinctness authority**; never derived from absence/mismatch. *(RA15/RA16)*
- **PA13** — **Layer distinction:** *authority-level* contradiction (grounds around one question) is **not** *state-level* CONFLICT (two applicable authoritative **Assertions** incompatible → §1 RS9 / §7 RC6-b). *(MP12/RC6)*
- **PA14 · No silent winner** — **(a)** Contradictory admitted inputs **within a single** Authorization Evaluation ⇒ **No-Authorization**, or **Failure** per an explicit policy contract — never a silent winner, never CONFLICT-by-itself *(MP12)*. **(b)** **Cross-question co-authorization** (one Evaluation Context authorizing a SAME and a DISTINCT question) is bound by the same **no-silent-winner** constraint; its **governed backstop** is that the two Authorized Bases, if asserted, become two applicable contradictory **Assertions → STATE-level CONFLICT (RC6-b)**. Whether an **authority-layer disposition** (abstain / No-Authorization / Failure) MAY *additionally* apply to (b) **before** assertion is **OPEN** — not solvable by precedence. *(MP12/RC6/RA22)*
- **PA15 · Precedence expressibility only** — §8 ratifies **no** precedence content (RA22 holds). IF a future contract authorizes precedence it must be **explicit, versioned, scoped, provenance-bearing**; absent it, contradictory grounds → No-Auth/Failure (authority) and contradictory applicable Assertions → CONFLICT (state). *(RA22/MP12)*
- **PA16 · Identifier-authority condition SLOTS** (dimensions, not values) — a policy authorizing on an identifier signal MUST be able to condition on: identifier namespace/type · issuer · jurisdiction · tenant/domain scope · Referent Type · verification state/method · verification age/freshness · lifecycle · reassignment · recycling/reuse · expiry · historical ownership/applicability · effective temporal context. **§8 defines the slots; §9 fills them.** *(RA7/RA9/RA10/RA20)*
- **PA17** — The applicable Method Policy is chosen by an **authorized, deterministic, context-pinned** function of {tenant, Referent Type, decision-category, source/method, purpose, temporal applicability}, **determined before observing the desired outcome**; **not feature-chosen**; **no post-evaluation outcome-shopping**. Selection mechanism/registry **DEFERRED**. *(MP19/RA17)*
- **PA18** — **Tenant-scope mandatory; cross-tenant inputs/policies are invalid/Failure, never SAME/DISTINCT.** *(MP26/§0-T)*
- **PA19** — **Referent-Type isolation:** no cross-type authorization; type-specific methods only. *(MP24/RA20)*
- **PA20** — Temporal applicability governs every Evaluation via **explicit EvaluationTime / pinned temporal context** (no wall-clock). *(§6 TR16/TR21)*
- **PA21** — For a pinned evaluation context the authorization result is **reproducible**, semantically pinning admitted-inputs · policy id+version · method · tenant · Referent Type · EvaluationTime/temporal context · relevant authority/lifecycle context. Encoding **DEFERRED**. *(§6 TR25/MP3/RA18)*
- **PA22** — **Policy-replay = pure authorization replay**: it reproduces the authorization result and does **not** re-emit an Assertion nor repeat a mint side-effect. *(MP21)*
- **PA23** — An Authorized Basis preserves (semantic categories, not JSON): Method-Policy identity+version · decision-category · contributing admitted grounds/signals with provenance · temporal applicability · scope (tenant/type) · the source bindings/referents · evaluator provenance *if contractually relevant*, with **runtime-evaluator ≠ authority-source**. Schema **DEFERRED**. *(MP22/RA13)*
- **PA24** — **`PartyResolutionClaim` / Tier-3 Party resolution is NOT an independent identity authority.** Under RIA-only-asserts (RA2) and no-feature-owned-policy (MP23), when activated it must operate **under RIA authority**: its resolutions are RIA Identity Assertions produced via an applicable Method Policy, **or** its signals/claims are admitted evidence/candidates feeding one — never a parallel authority. The Party Identity Strategy's tiers/direction/prohibitions remain **binding and complementary**. Absorb / wrap / migrate / deprecate mechanism **DEFERRED**. *(RA2/MP23/RC16 + Party Strategy)*
- **PA25** — Existing/future **feature-local matching** (exact-phone customer upsert, supplier advisory match, DB uniqueness, import dedup) does **not** become RIA identity authority by existing; it may be an evidence-producer / feature-local mechanic / migration candidate, but carries **no identity authority** absent an authorized Method Policy. **DB uniqueness / persistence order / feature FK ≠ referent-identity authority.** *(RC16/MP23/TR26)*
- **PA26** — Four dispositions stay distinct: **Authorized Basis** · **No-Authorization** (valid eval, insufficient authority → contributes to UNRESOLVED) · **Method-Policy Failure** (eval could not validly execute) · **Identity-State CONFLICT** (derived from incompatible applicable Assertions, §1/§7 — not an evaluation output). Evaluation ambiguity **⇏** CONFLICT. §8 closes only {Basis, No-Auth, Failure}; **full failure taxonomy DEFERRED**. *(MP13/RA14/RC6)*

## §8 OPEN / DEFERRED
**Cross-question SAME/DISTINCT authority-layer pre-assertion disposition (PA14(b))** · precedence content (PA15) · Method-Policy schema/serialization/registry/selection-mechanism (PA5/PA17) · replay/provenance encoding (PA21/PA23) · concrete Minting rules (MP14) · CONFLICT adjudication · re-attribution propagation · full failure taxonomy (PA26) · Party absorb/wrap/migrate mechanism (PA24) · runtime/persistence/APIs/feature-wiring · **כל §0–§7 OPEN/DEFERRED**.

---

# RIA-1 · §9 — Concrete Identifier & Signal Authority Semantics
*Prefix: `IA`. §0–§8 = INHERITED. PARTY identifiers only. Every "may authorize" means: a verified identifier→referent proposition, under an applicable versioned Method Policy satisfying §8, MAY support production of an Authorized Basis — the identifier is never itself an authority artifact.*

## §9 Identifier Ontology
Two orthogonal axes: **(a) identity namespace** — ת.ז. (natural person, Ministry of Interior) · ח.פ. (legal person, Corporations Authority); **(b) VAT status** — עוסק מורשה / עוסק פטור (turnover-based classification, **not** identifiers). §9 authorizes on **(a)** only. Natural-person / legal-person are **PARTY-domain qualifications** (top-level RIA types remain PARTY/COMMITMENT/RESOURCE; encoding DEFERRED, IA15).

## §9 Normative Locks (IA1–IA17)
*(tags: CD Contract-derived · OV Officially-verified · PD owner-ratified · COND external fact not established)*
- **IA1 · ת.ז. SAME-capability** — For `PARTY·natural-person`, a **verified ת.ז.→person binding** MAY support a **SAME** Authorized Basis **only** under a §8 Method Policy pinning authoritative source, namespace, Referent Type, tenant, verification state, temporal context, policy/version, provenance. `same 9 digits → SAME` **forbidden**. *(CD·OV·PD1)*
- **IA2 · ת.ז. bounds** — Luhn check-digit = **structural validity only** (≠ existence, ≠ binding, ≠ authority); existence ≠ binding; evaluated at explicit EvaluationTime; **no post-death non-reuse claim**. *(OV·COND)*
- **IA3 · ח.פ. SAME-capability** — For `PARTY·legal-person`, a **verified ח.פ.→legal-person registry binding** MAY support **SAME** under a Method Policy pinning registry source, namespace, Referent Type, verification state, **effective temporal context**, policy/version, provenance. Authority = the registry binding, not the number's VAT usage. *(CD·OV·PD1)*
- **IA4 · ח.פ. effective-time bound** — ח.פ. SAME/DISTINCT authority is **effective-time-bounded to the verified binding**; **no permanent-non-reassignment claim** (reassignment NOT-ESTABLISHED). *(OV·COND)*
- **IA5 · VAT-status EXCLUDE** — עוסק מורשה/פטור are **statuses, not namespaces**; **MUST NOT** independently authorize SAME/DISTINCT; underlying identifier = ת.ז./ח.פ.; `פטור↔מורשה` (or תיק close/reopen) is **not** an identity change; may be admitted context. Not bound to `CustomerTaxIdType`. *(OV·PD1)*
- **IA6 · phone/email never-alone SAME** — endpoint equality/verification **MUST NOT alone** authorize SAME; MAY be evidence/corroborating/bound-through under a future policy; **§9 ratifies NO concrete sufficiency formula (OPEN)**; control≠ownership≠party-identity≠SAME-authority. *(CD·OV·PD2·OPEN)*
- **IA7 · phone/email never DISTINCT** — difference/mismatch/absence/expiry/failed-verification/changed-endpoint **MUST NOT** authorize DISTINCT (only fails to prove SAME). *(CD·PD2)*
- **IA8 · internal-ID Class-A only** — storage uniqueness has **no** RIA authority; `Customer.id`/`Supplier.id`/feature-FK/DB-PK/uniqueness ≠ authority; **same-DB-row ≠ cross-feature SAME**; a canonical-internal identifier is authority-capable **only** if a policy governs it as **§2 Class-A**; `CanonicalReferentId` is **not** automatically a SAME signal. *(CD·PA25/RC16/§2)*
- **IA9 · affirmative-DISTINCT ת.ז.** — **Two independently authoritative verified ת.ז.→person bindings, each binding a different national-ID value to a different natural-person referent under the applicable Method Policy/context, MAY support affirmative DISTINCT.** Authority arises from `verified binding A + verified binding B + policy`, **never from `A ≠ B`**; raw unequal values alone never authorize DISTINCT. *(CD·OV·PD3)*
- **IA10 · affirmative-DISTINCT ח.פ.** — different **verified** ח.פ.→legal-person bindings MAY support affirmative DISTINCT **only within the effective temporal scope** of the registry bindings; **no timeless non-reassignment claim**. If the temporal/lifecycle context is insufficient to support the DISTINCT proposition → **No-Authorization** (**not** Failure; Failure only where the Evaluation itself cannot validly execute per §8/PA26). *(OV·COND·PD3)*
- **IA11 · negative-DISTINCT guards** — DISTINCT **NEVER** from: no-match · failed-SAME · missing signal · stale verification · phone/email mismatch · VAT-status difference · syntax mismatch · unverified raw-string difference. *(CD, inherits RA16/PA12)*
- **IA12 · verification-source proposition-specific trust** — no generic "trusted"; a policy must state **which proposition** a source is authoritative for (syntax-only / existence / identifier→referent binding / current-status / historical-binding) and preserve the **11 categories** (namespace/type · source · what-it-establishes · verification-state · freshness/time · binding · Referent Type · tenant · effective-temporal · policy/version · provenance); `official ≠ unlimited authority`; `current-status ≠ historical identity`. *(CD·PD4)*
- **IA13 · temporal guards** — explicit **EvaluationTime** + applicable temporal context + verification freshness/age; **no hidden `effectiveFrom=recordedAt`**; if the required temporal proposition is unavailable the policy **must not fabricate applicability**; no new default. *(CD·§6/PA20)*
- **IA14 · OTHER No-Authorization-until-classified** — `OTHER`/ungoverned-namespace **MUST NOT** authorize SAME/DISTINCT (may remain evidence); authority requires an explicitly governed identifier class/policy; **no best-effort fallback**. *(CD·PD5)*
- **IA15 · Referent-Type isolation** — ת.ז.→`PARTY·natural`; ח.פ.→`PARTY·legal`; no VAT/phone/email/internal rule silently crosses Referent Types; no PARTY-identifier rule on RESOURCE/COMMITMENT. Natural/legal = **PARTY-domain qualification**; **encoding DEFERRED** — §9 mints no new top-level type. *(CD·PA19/RA20)*
- **IA16 · Minting separation** — identifier SAME/DISTINCT authority **does not imply Minting authorization** (MP14/MP15); §9 defines **no** Minting conditions; verified ת.ז./ח.פ. triggers **no** automatic Canonical-Referent creation. *(CD)*
- **IA17 · schema observation (non-normative)** — governance semantics key on **actual namespace + proposition**, not on `CustomerTaxIdType {AUTHORIZED_DEALER, EXEMPT_DEALER, LTD_COMPANY, PRIVATE_ID, OTHER}` (which conflates identity namespace `LTD_COMPANY`/`PRIVATE_ID` with VAT status `AUTHORIZED_DEALER`/`EXEMPT_DEALER`); §9 **must not inherit that conflation**; **no migration/redesign/deprecation now**. *(OV·observation-only)*

## §9 OPEN / DEFERRED
phone/email concrete corroboration **sufficiency** (IA6) · **ח.פ. reassignment/non-reuse fact** (IA4/IA10, OFFICIAL-NOT-ESTABLISHED) · **ת.ז. post-death reuse** (IA2, OFFICIAL-NOT-ESTABLISHED) · cross-question authority-layer disposition (PA14(b)) · `OTHER` future identifier policies (IA14) · RESOURCE/COMMITMENT identifier authority (RA20) · concrete Minting rules · Method-Policy schema/registry (§10) · replay/provenance encoding · production runtime/persistence · schema-mismatch remediation (IA17) · Party migration · CONFLICT adjudication · feature wiring.

---
---

## Global Non-Negotiable Invariants
- RIA is post-C0.
- C0 Evidence remains immutable.
- Translator/source claims are grounds, not final identity authority.
- Canonical identity is tenant-scoped.
- SAME / DISTINCT / UNRESOLVED are healthy relation outcomes only.
- CONFLICT is state-health, not a fourth relation outcome.
- SAME is an equivalence relation, but pairwise chaining is not authority.
- Authority Class ≠ Authorized Basis.
- Verification ≠ Identity Authority.
- Only RIA emits Identity Assertions.
- Assertion history immutable; Identity State derived/corrigible.
- Canonical Referent = identity anchor, not truth container.
- Minting ≠ SAME/DISTINCT/uniqueness proof.
- Features do not own identity policy.
- Recorded-time ≠ effective semantics.
- Knowledge-As-Of ≠ Effective-State-At ≠ Historical Execution Replay.
- Current state uses explicit EvaluationTime.
- SAME → derived reconciliation, not storage mutation.
- No destructive merge.
- Original attribution remains reproducible.
- Cross-feature consumers may consume the Current Identity Interpretation without source rewrite.
- Feature FKs do not become RIA authority.

## Global OPEN / DEFERRED Ledger
The following are explicitly **unresolved / deferred** and are NOT decided by this contract:
- Concrete Method-Policy representation / registry / versioning / selection schema (§10).
- Concrete phone/email corroboration sufficiency (§9 IA6); ח.פ. reassignment & ת.ז. post-death reuse remain OFFICIAL-NOT-ESTABLISHED and effective-time-guarded (§9 IA4/IA2/IA10).
- Cross-question SAME/DISTINCT authority-layer pre-assertion disposition (§8 PA14(b) — RC6-b remains the state-level backstop).
- CONFLICT adjudication.
- Survivor / alias / cluster / pointer representation.
- Persistence / storage.
- Materialized reconciliation execution.
- Materialized re-attribution propagation.
- Replay / state encoding.
- Temporal default when effective semantics are omitted.
- Full bitemporal infrastructure.
- Temporal tie-break token / ordering mechanism.
- Privacy / erasure interaction.
- Type-correction linking mechanism.
- EVENT.
- Full failure taxonomy.
- APIs / product wiring.

## Forbidden Shortcuts
- `token/name/value match → SAME`, `mismatch → DISTINCT`.
- `contradictory SAME/DISTINCT → auto-partition / graph-cut / SAME-wins / DISTINCT-wins / maximal-consistent-subset / edge-deletion / temporary-survivor` (RC6-b).
- `UNRESOLVED → probable-merge`, `CONFLICT → best-guess`.
- `incidental DB-row / sequence order → authority/applicability` (TR26).
- `materialized-state defines truth`; `current-interpretation replaces original attribution`.
- `split deletes reconciliation history`; `type-correction mutates anchor type`.
- `feature FK → identity authority`; `verification → authority`.

## Cross-Section Consistency Invariants
- §1 SAME (RS4) operates under §6 applicability; §3 AS6 derives state; §7 RC5/RC6 reconcile via derived state only.
- CONFLICT is defined identically across §1 RS9, §3 AS11, §7 RC6-b (incompatible applicable assertions → abstain).
- Authority (§2) → Policy evaluation (§5) → Authorized Basis → Assertion (§3) → derived State/CII (§3/§7); no layer is bypassed.
- Temporal applicability (§6) governs which assertions are in force for every §1/§3/§7 derivation.
- Anchors (§4) are preserved across all §7 reconciliation/split; nothing is destroyed.

## Implementation Boundary
RIA-1 defines semantic authority and lifecycle rules. It does **not** itself define production matching heuristics, DB representation, APIs, or feature wiring. A separate fixtures-only runtime proof (Minimum Cross-Feature Executable Proof) demonstrates §0–§7 mechanically and is held until this governance lands.

## Provenance / Ratification Note
§0–§7 are transcribed verbatim from their ratified drafts in the RIA-1 ratification dialogue. Mechanical, non-semantic touches applied during materialization: (1) conversational preamble/closing framing removed; (2) H1 status tags "(REVISED/DRAFT · CONTRACT-PENDING)" dropped; (3) per-turn Consistency-Check/Scan, Ratification-Checklist, Scenario-Proof/Stress-Test, and Exact-Recommendation blocks omitted (canonical corpus, not transcript); (4) the three ratified single-lock corrections applied in place — **CR25** (§4), **TR26 + TR29** (§6), and **RC6** (§7) — superseding their base wording, with the superseded drafts excluded. No lock was renumbered; all identifiers (RS0–RS14, RA1–RA22, AS1–AS15, CR1–CR25, MP0–MP26, TR1–TR29, RC0–RC23) are preserved.

**§8 & §9 materialization (non-semantic transcription):** §8 (PA1–PA26, including the corrected PA6/PA9/PA10/PA14 and the PA14(b) cross-question OPEN) and §9 (IA1–IA17, including the ratified IA9 clarification — affirmative DISTINCT arises from two independently authoritative verified bindings + policy, never from raw `A ≠ B` — and the IA10 clarification — insufficient temporal/lifecycle authority → No-Authorization, not Failure) are transcribed verbatim from their ratified in-conversation drafts. No new decisions; identifiers PA1–PA26 and IA1–IA17 preserved; per-turn scenario proofs and consistency scans omitted (canonical corpus, not transcript).
