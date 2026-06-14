# Dubiz Brain — Signals Dissolution Note v1

> **A decision record, not a constitution.** It documents the architectural
> conclusion that **"Signal" is not a real primitive** in the Dubiz Brain, the
> reasoning behind it, and the rule that prevents it from being reintroduced as a
> layer. No code, no schema, no implementation.

---

## The decision

**"Signal" is dissolved as an architectural primitive.** It is not a layer, not an
atom, and not an object with an independent contract. It is retained only as informal
shorthand (see "Permitted residual use"), never as something the Brain processes.

---

## Why it was dissolved

Under the rigorous epistemic framework already fixed (Evidence & Reality
Constitution, Belief Formation Constitution, Brain Internal Architecture v1), every
attempted meaning of "Signal" collapses into an object that already exists:

1. **Every candidate meaning resolves to something defined.** Event / observation →
   *Evidence*. Pattern / delta / gap → *Belief* (formed by Direct Formation,
   Inference, or Expectation-Violation). "Something worth noticing" → *Awareness
   Object*. There is no residue requiring a distinct "Signal."

2. **The things that "feel like signals" but come from no sensor confirm the error.**
   Blind spots and missing coverage are *second-order Beliefs* (about the system's own
   limits); missing settlement is a *declared gap / Unknown Condition*; a critical
   unknown is a *Gap-Awareness Object*. None is a sensor emission; calling them
   "signals" hid a category error.

3. **It ambiguously straddles meaning-free and meaning-laden.** Used for both a raw
   account ("something happened") and a salient finding ("something matters"), "Signal"
   becomes a vector for collapsing the IS / MATTERS boundary and for
   confidence-laundering — letting significance enter at ingress without passing
   through Judgment.

4. **It ambiguously straddles persistent and ephemeral.** Sometimes it meant the
   immutable Evidence record (persistent), sometimes the moment of arrival (a transient
   trigger). A single concept cannot be both; the inconsistency shows it is not one
   thing.

5. **It has no coherent contract of its own.** The only coherent contract for ingress
   raw material is the *Evidence* contract (raw, meaning-free, worth-free,
   provenance-stamped). The moment a thing carries meaning, worth, or evaluation, it is
   already a Belief or an Awareness Object — not ingress material.

---

## What "Signal" maps to

| When "Signal" meant… | It is actually… |
|---|---|
| an event / observation / raw account | **Evidence** |
| a delta / pattern / trend / anomaly | **Belief** (Direct Formation / Inference / Synthesis) |
| an absence against a norm | **Belief** via Expectation-Violation, and/or a **Gap-Awareness Object** |
| "something worth noticing" | an **Awareness Object** (Judgment applied) |
| a blind spot / missing coverage | a **second-order Belief** about the system's own limits |
| a missing settlement / critical unknown | a **declared gap / Unknown Condition** or **Gap-Awareness Object** |

There is no row that resolves to a new, distinct "Signal" object.

---

## The official ingress

The ingress side of the Brain is, precisely:

```
Account → Evidence → Belief Formation → World Model
```

It is **not**:

```
Signal → …
```

Sensors emit **Accounts**. The Brain mints them into **Evidence** (immutable,
meaning-free, provenance-stamped). Belief Formation then decides, with warrant,
whether to form Beliefs into the World Model. There is no "Signal" stage between
sensor and Evidence, and nothing in the Brain "processes signals."

This conclusion **confirms**, rather than contradicts, Brain Internal Architecture
v1, which already defines the ingress as Account → Evidence with no Signal layer.

---

## Reconciling the historical use in Sensor Mapping

The Sensor Mapping work (Billing, Documents, Inbox, WhatsApp, Inventory, Pricing) used
the word "signal" loosely — e.g. "Layer 1 Raw Signals," "Layer 2 Derived Signals,"
"Layer 3 Cross-Source Signals." Under this decision, those were never a distinct
primitive:

- **Layer 1 "signals"** were *Evidence* (raw accounts a sensor can provide).
- **Layer 2 "signals"** were *Beliefs* formed by Direct Formation within one sensor.
- **Layer 3 "signals"** were *Beliefs* formed by Synthesis across sensors.

The Sensor Mapping remains valid and useful: it is a catalog of **what each sensor can
afford** — the Evidence it can provide and the Beliefs that Evidence can support. The
word "signal" there should be read as **sensor affordance**, not as a runtime object.

---

## Permitted residual use

"Signal" may be used **only** as informal shorthand, never as an architectural layer:

1. **Sensor-affordance vocabulary** — "what a sensor can signal / tell us," when
   cataloging sensor capabilities. It always means "the Evidence it can provide and the
   Beliefs that Evidence can support."
2. **Colloquial verb** — "the sensor signals an account," meaning it emits an account.

Any use of "Signal" as a **noun denoting a distinct object the Brain stores or
processes**, or as a **layer in the pipeline**, is incorrect and must be re-expressed
as Evidence, Belief, or Awareness Object.

---

## Anti-reintroduction rule

If a future proposal introduces "Signal" as a layer, atom, or object with its own
contract, it must first answer: *which of Evidence, Belief, or Awareness Object does
this actually denote?* If it denotes one of them, use that term. If it denotes none of
them, that is a genuinely new finding requiring its own First-Principles review — but
it may not be smuggled in under the dissolved word "Signal."

---

## Non-Implementation Status

This note records an architectural decision only. It does not implement the Brain,
define a schema, signals, ingestion mechanics, UI, or product behavior. It fixes the
conceptual conclusion that "Signal" is not a primitive, and the rule that keeps the
ingress defined as Account → Evidence → Belief Formation → World Model.
