# Dubiz Brain — Internal Architecture v1

> **A conceptual architecture document only.** No code, no schema, no migrations,
> no UI, no API, no signals, no Hero, no product implementation. It fixes the
> *internal conceptual structure* of the Dubiz Brain as derived from the sensor
> mapping (Billing, Documents, Inbox, WhatsApp, Inventory, Pricing) and from the
> Evidence & Reality, Judgment, and Product constitutions.
>
> It sits beneath those constitutions as the structural model they govern, and
> above any future implementation, which it does **not** prescribe.

---

## 0. Core principle — the Brain is not a pipeline

**Dubiz Brain is not a one-way pipeline. It is an awareness loop around a
persistent World Model.** Evidence enters, beliefs are formed and reconciled,
judgment selects what matters, an action is proposed and delivered, its outcome
returns as new evidence, and learning tunes the loop. The structure is a **cycle**,
not a line — a system that perceives, models, judges, acts, observes the result,
and adjusts.

Everything below describes the parts of that loop and the laws that bind them.

---

## 1. Boundaries (not Brain-core)

The Brain has an ingress and an egress. Neither is the Brain itself.

- **Sensors — ingress from the world.** The senses (features) that emit accounts of
  what they perceive. They are *outside* the Brain; the Brain receives from them.
  Sensors do not produce meaning and have no judgment authority.
- **Delivery — egress to the human.** The boundary at which the Brain surfaces (or
  withholds) what it has judged worth the owner's attention. The mirror of Sensors.

The Brain proper is everything between these boundaries.

---

## 2. Evidence — the immutable input log (outside the World Model)

**Evidence does not live inside the World Model.** Evidence is an **immutable,
append-only log of accounts/claims** received from sensors.

- Evidence is **certain only about itself**: that a given account was received from
  a given source, at a given time, with a given provenance.
- Evidence is **never certain about the world.** What it asserts about the world is
  an *alleged claim*, not a fact.
- Evidence is referenced (cited) by beliefs as their grounding; it is never revised.

---

## 3. The World Model holds exactly one atom: the Belief

The World Model is the Brain's held model of the world. It contains **one kind of
atom and only one: the Belief.**

### 3.1 Belief = a Held Proposition

> **Belief = the system holds that P, to degree d, on grounds g.**

A Belief is a single proposition the system has *adopted* — not a source's
assertion, and not a bag of assertions, but the system's own stance.

Every Belief **must** carry:
- **Proposition** — the content that can be true or false.
- **Scope** — what the belief is about (see §6).
- **Confidence** — the degree to which it is held. Mandatory; a belief without a
  degree is not a belief.
- **Grounds / Provenance** — traceable to Evidence (or to other beliefs that bottom
  out in Evidence). Mandatory; an ungrounded belief may not be held.
- **Time** — temporal anchoring. Mandatory; confidence decays with time, so age is
  part of the belief.
- **Corrigibility** — it can be challenged, revised, retracted. Mandatory; an
  incorrigible belief is a dogma, not a belief.

### 3.2 No belief is Truth

**A Belief is never Truth.** "Fact," "Reality," "Human-Confirmed," and "Settled" are
not separate categories — they are **high-confidence Beliefs.** The World Model holds
no absolute truth; it holds beliefs at varying confidence. The moment a belief
presents itself as incontrovertible fact, it has overclaimed.

---

## 4. Claim vs Belief

These differ in **ownership and stance**:

- **Claim** — what a *source* asserted. Attributed to the source, inert, immutable.
  Lives in the **Evidence log**. ("Invoice 123 *claims* the transaction was 5,000.")
- **Belief** — what the *system* holds. Owned by the system, active, corrigible,
  grounded in claims. Lives in the **World Model**. ("The transaction was 5,000,
  held at confidence C, grounded in invoice 123.")

A Belief is the system's stance on a proposition, formed by **adopting** a claim,
**reconciling** conflicting claims, or **synthesizing** a conclusion no single claim
made. A Belief is not a collection of claims; it is one proposition that cites them.

---

## 5. Reality / Belief / Hypothesis are bands, not layers

These are not separate stages. They are **confidence bands within the single World
Model:**

- **Hypothesis** — a weak / unconfirmed Belief, held below the assertion threshold.
- **Belief** — a held position at ordinary confidence.
- **Fact / Reality / Settled** — a high-confidence Belief.

There is no Truth band. Evidence does not flow from Reality to Hypothesis or back;
these bands coexist as the stratification of one model.

---

## 6. Scope — not Subject

A belief is always *about* something, but **not always about an entity.** The old
"Subject slot" is generalized to a **Scope slot.** A belief's scope may be:

- a **Party / entity** (the most common case),
- a **business-wide state**,
- a **class / category**,
- a **market / industry**,
- the **system's own self-knowledge**,
- a **source's reliability**,
- a **blind spot**.

A belief may exist without an entity-subject, but never without a scope.

---

## 7. Identity is both a Fabric and an Engine

Two different things share the name "Identity":

- **Identity Fabric** — a *structural law*: every epistemic object binds to a
  scope/subject. It is the binding-slot present on every object, not a processing
  component.
- **Identity Resolution Engine** — an *active Brain component* that produces
  **corrigible identity-beliefs** ("this signal designates this entity"; "these two
  are the same entity"). Its output lives in the World Model as Beliefs.

The Engine is unique among fabrics: its output is itself a contestable belief in the
model. **The Identity Resolution Engine is a precondition for cross-entity Synthesis**
— the Brain cannot relate facts across entities until it has resolved which entity is
which.

---

## 8. Two producers of Beliefs

Beliefs enter the World Model through two peer producers:

- **Direct Formation** — a belief formed from a single source's evidence (aggregation
  / thresholds within one source). Often identity-light. Tends to be **higher
  confidence** (single high-provenance source).
- **Synthesis** — a belief formed by relating beliefs/evidence **across
  entities / sources / time**. Identity-dependent. Tends to be **lower confidence but
  higher reach** (cross-referenced inference). Synthesis is **not a downstream stage**
  — it is a **recursive producer** that *reads* the World Model and *writes new
  beliefs back into it*, as a peer to Direct Formation.

> Synthesis trades certainty for reach. The Brain must hold both kinds of belief,
> weighted by their different confidence profiles.

---

## 9. Judgment

**Judgment does not depend on Synthesis.** Judgment consumes the **entire World
Model** — all beliefs, however formed.

> **Corrected law: Worth ⊆ World Model** (not "Worth ⊆ Synthesis"). Judgment may rank
> any belief that exists in the model — a directly-formed belief ("a gap in invoice
> numbering," "no stock count in 60 days," "no business address") needs no synthesis
> at all, and is often the most certain and most actionable.

Judgment evaluates beliefs along three faculties:

- **Worth** = f(**Impact**, **Confidence**, **Time Window**).
- **Routing** — influenced by **Worth**, **Actionability**, **Recurrence / History**.
- **Delivery** — influenced by **Cognitive Cost**, **Competition for Attention**,
  **Cooldown**.

Judgment never raises the confidence of the belief beneath it.

---

## 10. Memory — the substrate, not a stage

**Memory is not a pipeline layer. It is the substrate in which the World Model lives
over time.** Without Memory there is no:

- recurrence,
- decay,
- non-repetition,
- learning,
- change over time,
- "what changed since last time."

The World Model is not momentary; it persists and evolves inside Memory.

---

## 11. Second-order beliefs (real but finite)

Most "beliefs about beliefs" collapse into confidence — *a belief's confidence is an
attribute, not a separate belief*, so there is no infinite recursion. But there is a
**genuine, finite second order**: beliefs about

- source reliability,
- calibration,
- blind spots,
- the system's own self-knowledge.

These do not reduce to any single first-order belief's confidence; they are beliefs
about classes of beliefs and about the epistemic apparatus itself. They are exactly
what Learning produces and what the Evidence Constitution's "declare your blind
spots" requires. The Brain has **two finite orders**, not infinite recursion.

---

## 12. Outcome — Evidence that returns

**Outcome is not a new type.** It is **Evidence, tagged** as the result of a
Recommendation, a human decision, or a previous action. It re-enters at the Evidence
log and closes the loop. A recommendation whose outcome has not returned is an open
loop, and impact may not be claimed for it.

---

## 13. Learning — a feedback loop

**Learning is not an ordinary pipeline stage. It is a feedback loop.** It reads
**Outcomes + human corrections** and tunes, backward, several parts of the loop:

- the weighting of evidence,
- belief formation,
- source reliability (second-order beliefs),
- judgment calibration.

There is no learning without an Outcome or a human correction.

---

## 14. The architecture, stated

**Boundaries**
```
Sensors ↓ (ingress from the world)
Delivery ↑ (egress to the human)
```

**Fabrics** (present in every epistemic object; never strippable)
```
Provenance · Confidence · Temporal · Scope / Identity · Memory
```

**Core loop**
```
Evidence Log
  → Direct Formation / Identity Resolution
    → World Model
       ⇄ Synthesis
    → Judgment
      → Recommendation
        → Delivery
          → Outcome Evidence
            → Learning
              ⟲ back into formation / calibration
```

The fabrics thread through every step of the core loop. The loop is closed: Delivery
leads to Outcome, Outcome re-enters as Evidence, and Learning feeds back into
formation and calibration.

---

## 15. Cardinal Safety Rules

The Brain's integrity is defined by what it refuses to do. These are absolute:

1. **No Truth-claiming** — nothing is asserted as incontrovertible fact.
2. **No Confidence-laundering** — a low-provenance belief never inherits high
   confidence.
3. **No Absence-as-Negation** — missing evidence is never asserted as "did not
   happen."
4. **No Claim-to-Belief promotion without grounds** — a source's assertion becomes a
   belief only on traceable grounds.
5. **No Belief-to-Fact promotion** — a belief never silently becomes "truth."
6. **No Judgment on raw Evidence outside the World Model** — Worth ⊆ World Model.
7. **No Synthesis across entities without Identity Resolution.**
8. **No Recommendation without an action path.**
9. **No Learning without an Outcome or a human correction.**

---

## 16. Non-Implementation Status

This document **does not implement the Brain.** It does **not** define a schema, a
data model, signals, APIs, UI, or product behavior. It does **not** describe how any
layer is built, stored, or served. It fixes **only the conceptual architecture** of
the Dubiz Brain — the parts of the awareness loop, their contracts, and the laws that
bind them — as the stable foundation that future design and implementation must
honor, but which it deliberately leaves unspecified.
