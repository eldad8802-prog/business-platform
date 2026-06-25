# Dubiz Collections / Dunning Domain — Design v1

**Type:** Business-domain design (Collections/Dunning). Design draft.
**Status: Design Draft** — pre-ratification. Business domain only; no schema, no
API, no UI, no engine, no AI, no planner, no learning, no implementation.
**Canonical baseline (do not edit):** `docs/payments-collections-policy-v1.md`
(Status: Ratification Candidate).

This document **extends** the ratified Payments & Collections Policy
constitution into a full Collections domain design. It **inherits** every
decision in the baseline and **must not duplicate, restate-as-authority, or
contradict** it. Where a concept is defined in the baseline, this document
references it and designs the domain *around* it.

**Scope:** this document covers **Receivable-level collection only** — the
pursuit of a single Receivable. **Customer-level / consolidated collection**
(one pursuit or one touch spanning multiple Receivables of a customer) is **not
part of this model**; it is a future extension (see §8) and is not designed
here — only its scope boundary is marked.

## Inheritance (from the canonical baseline — not re-decided here)
- **Entities & owners:** Receivable (Billing), Payment Policy (Payments),
  Collections Policy (Collections), Collection Strategy (Collections, register =
  Plan), Collection Effort (Collections, register = Execution), PaymentRequest
  (Payments), Settlement (Provider verification / Authority), Closure (Billing).
- **Chain:** Collections Policy (ambient law) governs → Receivable → Collection
  Strategy → Collection Effort → PaymentRequest → Settlement → Closure.
- **Four registers:** Permission / Plan / Execution / Authority.
- **Authority Principle** (`docs/payments-authority-principle-v1.md`): only a
  *verified* payment may transition to PAID; Closure and receipts derive from
  verified PAID only; idempotent (exactly once).
- **Guardrail:** Collection Strategy is a *declarative plan*, never an engine.
- **Billing compliance:** numbering / immutability / auditability are never
  bypassed.

## Domain invariants (consequences of the baseline; stated, not newly decided)
1. **At most one ACTIVE Collection Effort per Receivable** — no double-dunning.
2. **The Effort never closes the debt.** It observes **Billing Closure** and
   stops; Billing performs Closure.
3. **Completion is driven by Billing Closure, not by the settlement source.** A
   Billing Closure may arise from a verified provider settlement, a
   manually-recorded Billing payment, or any future lawful closure of the
   Receivable. The Authority Principle still governs the *provider* path: a
   provider payment reaches PAID only via verification.
4. **Strategy is provider-blind**; Steps name channels and intents, never a
   provider.
5. **No engine in this document** — selection/decision/optimization are future
   extension points (§8), explicitly excluded from the canonical domain.

---

## 1. Collections Lifecycle (Collection Effort)

A **Collection Effort** is the *execution-register* instance that pursues one
Receivable under one bound Strategy (version-pinned, see §2). It is the live
history of the pursuit — never the debt itself, never the payment attempt.

**Creation & trigger.** An Effort is created when collection begins for a
Receivable. The *trigger* is authorized by Collections Policy (baseline:
auto-creation permitted? is a business permission):
- **Manual** — a business actor starts collection.
- **Automatic** — only if Collections Policy permits; automatic creation makes a
  *pursuit*, never a financial artifact (baseline invariant).
On creation the Effort binds (a) the Receivable, (b) the selected Strategy
version.

**States (of the pursuit, distinct from PaymentRequest/Receivable states):**
- `PLANNED` — Effort created and Strategy bound; not yet started.
- `ACTIVE` — steps of the bound Strategy are being realized.
- `AWAITING_PAYMENT` — a PaymentRequest is live; pursuit waits on the customer /
  on verification.
- `PAUSED` — held by the business (dispute, manual hold).
- `COMPLETED` — terminal; Receivable settled — i.e. **Billing Closure** (from
  any lawful source).
- `CANCELLED` — terminal; collection withdrawn by the business.
- `EXHAUSTED` — terminal; Strategy steps ended without settlement (e.g.
  write-off candidate).

These describe the *pursuit's* live status. They never duplicate
`PaymentRequest` status (PENDING/PAID/…) nor the Receivable's owed/settled
status (Billing).

**Events that advance it:** a step is realized; a reminder is sent; the customer
responds/views; a PaymentRequest is created; a link expires; an escalation
occurs; the business pauses/resumes/cancels; **a Settlement is verified**
(Authority).

**What ends it (terminal only via):**
- **Billing Closure** (from any lawful settlement source) → `COMPLETED`,
- business withdrawal → `CANCELLED`,
- Strategy exhausted / written-off → `EXHAUSTED`.

**Relationships:**
- **Receivable:** an Effort pursues exactly one Receivable; at most one ACTIVE
  per Receivable.
- **PaymentRequest:** an Effort may spawn 0..n PaymentRequests over time (a step
  can create/renew an attempt). The attempt is governed by Payment Policy; its
  creation is an Effort event.
- **Settlement:** a verified PAID on a PaymentRequest is *one* source that leads
  to Billing Closure; the provider path reaches PAID only via verification
  (Authority Principle).
- **Closure (completion trigger):** the Effort completes when **Billing performs
  Closure** (allocation / remaining → 0). Billing Closure may originate from a
  verified provider settlement, a manually-recorded Billing payment, or any
  future lawful closure of the Receivable. Collections depends on **Billing
  Closure**, never on its source; the Effort never declares Closure.

**Boundary — reversal / chargeback.** A chargeback or settlement reversal is a
**Payments/Billing** event, not a Collections concern and not modeled here. If
it re-opens a Receivable or re-opens a balance, Collections simply starts a new
Effort for it. No new lifecycle and no new primitive — only this boundary note.

---

## 2. Collection Strategy Library

**What a Strategy is** (baseline): a named, declarative, selectable *pursuit
plan* (intent), provider-blind, bounded by Policy.

**What it contains:**
- an **ordered / conditional sequence of Collection Steps** (§3) — the plan;
- **timing intent** between steps (e.g. "wait N days") — Plan register, not an
  attempt property;
- **stop conditions** (e.g. on verified PAID, on cancel);
- **declared capability usage** (e.g. "offers installments", "allows partial")
  — usable only where Payment Policy permits;
- **metadata** — name, description, intended-use label (e.g. "VIP", "High
  Risk"). The label is descriptive intent, **not** a selection algorithm.

**Inheritance from Policy.** A Strategy may only use what the Policies permit:
channels within the Collections-Policy allowed set, within the reminder ceiling
and quiet hours; partial/installments only if Payment Policy permits. **Policy
is the envelope; Strategy chooses within it.** A Strategy can never widen a
permission.

**Replacement (re-binding).** A Receivable's bound Strategy may be swapped (e.g.
escalate "Gentle" → "Aggressive") as a **declarative re-binding of intent**. The
domain permits re-binding; *who/what decides* to re-bind is either a business
override (§7, manual) or a future engine (§8) — the **decision mechanism is out
of scope**.

**Versioning.** A Strategy is a **versioned declarative artifact**. Editing
produces a new version; an in-flight Effort stays pinned to the version it
started under (the plan an Effort follows is immutable for audit). Versions are
Active or Archived.

**Illustrative catalog entries** (declarative plans, not algorithms):
Gentle Reminder · Standard Collection · Aggressive Collection · Installment
First · Human First · High Risk · VIP Customer. Each is simply a *different
ordered Step plan* with different timing/channel intent — nothing more.

---

## 3. Collection Steps

A **Step** is a single declarative unit of a Strategy plan — an intended action
or a gating condition. A Step is **not executable logic**; it is a declared
intent whose realization belongs to Execution (Effort) and whose permission
belongs to Policy.

**Step types (business model only):**
| Step | Nature | Register when realized |
|---|---|---|
| **Wait** | time/condition gate | Plan → Execution timing |
| **Send Payment Link** | intent to create/attach a PaymentRequest | Execution creates the attempt (Payment Policy governs it) |
| **Reminder** | generic nudge | Execution (delivery) |
| **WhatsApp / Email / SMS** | deliver link/reminder via a channel | Execution; channel must be Policy-permitted |
| **Phone Call** | human task | Execution (human action) |
| **Human Escalation** | hand to a person | Execution (human handoff) |
| **Renew Link** | regenerate an expired PaymentRequest | Execution (new attempt) |
| **Offer Installments** | intent (within Payment Policy permission) | Plan intent; capability reconciled at Execution |
| **Offer Partial Payment** | intent (within permission) | Plan intent |
| **Stop Collection** | terminal step | Execution → terminal Effort state |

Each Step carries declarative parameters (e.g. "wait 3 days", "channel =
WhatsApp"). Steps are **Plan**; their realization is **Execution**; their
permissibility is **Policy**. The mapping of a Step to a concrete realization is
the engine's concern (§8) — out of scope here.

---

## 4. Collection Timeline

The Effort holds a **Timeline** — an append-only history (Execution register) of
the pursuit.

**Definitions (no overlap):**
- **Event** — anything that happened, recorded in time (umbrella term): an
  action, an external occurrence, or an outcome.
- **Action** — a *deliberate* execution taken per the plan (a realized Step):
  "sent WhatsApp", "created PaymentRequest", "escalated to human".
- **Outcome** — the *result* of an action or external event: "delivered",
  "failed", "link viewed", "no response", "verified PAID".
- Relationship: an **Action** produces an **Outcome**; both, plus external
  occurrences, are **Events** on the Timeline.

**Audit Trail.** The Timeline is the immutable, append-only audit record:
who/what/when, the **Strategy version in force**, and — for any state change to
settlement — the **authority basis** (verification), per the Authority
Principle. Nothing is overwritten; state is derived from / recorded alongside
the append-only log. This satisfies the baseline's idempotency and Billing
auditability (referenced, not redefined).

**Full history.** Every Step realization, channel delivery, customer signal,
PaymentRequest lifecycle event, and verified Settlement is retained on the
Timeline for the life of the Receivable and beyond (audit retention).

---

## 5. Strategy Execution Boundary

Three layers, sharpening the baseline registers + guardrail:

| Layer | Owns | Question | In this domain? |
|---|---|---|---|
| **Strategy (Intent)** | the declarative plan (ordered Steps, timing intent) | *what do we intend?* | ✅ yes |
| **Execution (Effort)** | realizing steps, recording Events/Outcomes, live pursuit state | *what happened?* | ✅ yes |
| **Engine (Decision)** | choosing a strategy, deciding when/what to advance, adapting | *what should we do next & why?* | ❌ **excluded** (future, §8) |

**Boundary rules:**
- Intent never executes; it only declares.
- Execution never *decides* the strategy; it **follows** the bound plan plus
  explicit triggers (business overrides, verified events).
- The **Engine** (selection / planning / routing / optimization / learning) sits
  *above* Intent and is **not part of this canonical domain**. No algorithm,
  planner, AI, routing engine, or learning appears here.

This is the baseline Guardrail (§11) applied to the domain: a Strategy is a
thing you can point at and contradict; an Engine is a function that computes —
and is out of scope.

---

## 6. Strategy Catalog

How a business manages its library of strategies (a managed set of declarative
artifacts — not an engine):
- **Built-in strategies** — Dubiz-provided templates.
- **Custom strategies** — business-authored, within Policy permissions.
- **States of a catalog entry:** `Active` · `Archived` · `Default`.
- **Default** — the business-level default strategy (baseline §8: a
  business-level decision).
- **Versioning** (§2) — entries are versioned; archived versions are retained
  for audit and for in-flight Efforts pinned to them.
- **Permitted set** — Collections Policy authorizes *which strategies are
  permitted* (baseline ownership). Catalog management operates within that
  authorization and can never widen Policy.

---

## 7. Business Overrides

Per baseline §8 (business-vs-document boundary). Override **scopes** and
**precedence** (highest wins), all bounded by non-overridable Policy:

1. **Manual override** — a human changes the live Effort's strategy/step (pause,
   skip, escalate now, stop).
2. **Per-customer override** — a customer is bound to a strategy (e.g. always
   VIP / always High Risk).
3. **Per-document override** — this Receivable/invoice uses a chosen strategy.
4. **Business default** — the default strategy for the business.

**Cannot be overridden (hard law):**
- Collections Policy ceilings/permissions (max reminders, quiet hours, allowed
  channels, which strategies are permitted).
- Compliance gates (e.g. whether auto-receipt is enabled).
- The **Authority Principle** (only verified → PAID / Closure).
- Payment Policy attempt-permissions (a strategy cannot "offer partial" where
  partial is not permitted).

Overrides choose *within* the permitted envelope; they never widen it.

---

## 8. Future Extension Points (named only — not designed, not implemented)

Each sits **above** Strategy (in the Engine layer) and connects at a defined
seam. None is part of this canonical domain.

| Extension | Seam (where it connects) | Consumes |
|---|---|---|
| **AI Recommendation** | suggests which Strategy/Step to bind/advance | Timeline + Receivable + (future) Business Awareness |
| **Business Awareness** | feeds customer/risk/relationship context into strategy selection | future Business Brain layer (`[[project_business_status_mapping]]`) |
| **Routing Engine** | dynamically selects provider/channel at execution | active connections; multi-provider routing (deferred in baseline) |
| **Learning Engine** | optimizes strategies from realized outcomes | Timeline Outcomes |
| **Optimization** | tunes timing/cadence within Policy limits | Timeline + Policy envelope |
| **Consolidated / Customer-level Campaign** | coordinates collection across multiple Receivables of a customer | per-Receivable Efforts (this domain stays per-Receivable; see Scope) |

All extension points are **consumers/selectors above the Intent layer** — they
may *choose or advise*, but Strategy stays a declarative plan and Effort stays
the execution record. They are explicitly **out of scope** for this document.

---

## Relationship to canonical documents
- **Canonical baseline:** `docs/payments-collections-policy-v1.md` — this design
  inherits and never edits it.
- **Authority:** `docs/payments-authority-principle-v1.md` — verification is the
  sole authority for PAID/Closure.
- **Financial Truth boundary:** Documents = incoming-document verification;
  Billing owns the Receivable and Closure.
- **Billing compliance:** numbering / immutability / auditability preserved.

## Non-goals (this document)
No schema, Prisma, API, UI, React, database, TypeScript, implementation,
workflow engine, automation engine, AI, planner, or learning. Business domain
ontology and boundaries only — a Design Draft intended for future Ratification.
