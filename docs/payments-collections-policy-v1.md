# Dubiz Payments & Collections Policy — Constitution v1 (Ontology)

**Type:** Business constitution / ontology. Ratification-ready.
**Status: Ratification Candidate** — Ontology only; no engine, no implementation.
**Defines:** how Dubiz manages collection **independent of any payment provider**.

This document defines *entities and ownership*, not mechanism. It sits above the
generic Payments layer and inherits three existing constitutions:

- **Payments Authority Principle** (`docs/payments-authority-principle-v1.md`):
  webhook = signal; provider verification = authority; only a verified payment
  may transition to PAID.
- **Documents = Financial Truth:** the Obligation (debt) is owned by **Billing**,
  never by Payments.
- **Billing compliance:** numbering, immutability, and auditability are never
  bypassed by collection.

---

## 1. Ontological entities

Two layers: **rule primitives** (policies) and **world primitives** (things
that exist and are pursued). Each has exactly one owner.

### Rule primitives (the law)
| Primitive | Owns | Owner layer |
|---|---|---|
| **Payment Policy** | the permissions & properties of a single payment attempt | Payments |
| **Collections Policy** | the permitted envelope & defaults of the pursuit process | Collections |

### World primitives (the things)
| Primitive | What it is | Owner |
|---|---|---|
| **Obligation / Receivable** | what is owed (open debt) | Billing |
| **Collection Strategy** | the *chosen plan* for pursuing a debt (intent) | Collections |
| **Collection Effort** | the *realized execution/history* of pursuing one debt | Collections |
| **Payment Intent (PaymentRequest)** | a single attempt to collect a specific amount | Payments |
| **Payment Authority (Settlement)** | verified truth that payment occurred | Provider verification (Authority Principle) |
| **Closure** | the business event that the debt is settled | Billing |

**Top invariant:** Payments **executes attempts**; it is never the owner of the
debt and never declares its closure. One Receivable may spawn zero-to-many
PaymentRequests over time.

---

## 2. The model chain (updated)

Collections Policy is **ambient law** that authorizes and bounds the whole
chain — it is not a link in it. Collection Strategy is the new link between the
Receivable and the Effort.

```
            Collections Policy        ← ambient law (authorizes / bounds; not a link)
                 │ governs
                 ▼
Receivable
   ↓
Collection Strategy     ← the chosen pursuit plan (intent)
   ↓
Collection Effort       ← the realized execution (events)
   ↓
PaymentRequest          ← one action of the plan (NOT necessarily the first)
   ↓ (Payment Policy governs the attempt; Authority verifies)
Settlement → Closure
```

**Why Strategy must exist:** without it, the model silently assumes "to pursue =
immediately create a PaymentRequest." Approaches such as "phone before link" or
"wait N days before creating an attempt" prove there is an intent layer that
precedes the attempt. Strategy is precisely what separates *pursuit plan* from
*payment attempt*.

---

## 3. The four registers

Every fact in the model belongs to exactly one register:

| Register | Question | Home |
|---|---|---|
| **Permission** | what is *allowed*? | Payment Policy / Collections Policy |
| **Plan** | what is *intended* for this debt? | Collection Strategy |
| **Execution** | what *happened*? | Collection Effort |
| **Authority** | what is *verified-true*? | Settlement (Authority Principle) |

---

## 4. The two cuts (overlap resolution)

These two cuts close the model so that **no fact can belong to two primitives**.

**Cut 1 — a capability splits into up to three distinct facts:**
Any capability (partial payment, installments, channel) is not one fact but up
to three: its **Permission** (Policy), its **Plan/deployment** (Strategy), and
its **Execution** (Effort). "Partial allowed" ≠ "pursue partial-before-full" ≠
"collected ₪X partially."

**Cut 2 — Payment Policy vs Collections Policy split by subject:**
- **Payment Policy** = permissions/properties of a **single payment attempt**
  (the attempt's shape).
- **Collections Policy** = permissions/envelope of the **pursuit campaign**
  (the dunning process).

---

## 5. Ownership Test (four questions per primitive)

### Payment Policy
1. **Single question:** what constitutes a *valid payment attempt*, and what are
   its properties?
2. **Only it may hold:** partial-payment permission, installments permission (as
   a valid attempt structure), currency, attempt amount bounds, and the
   **canonical link-expiry duration**.
3. **Must not hold:** pursuit ordering/timing (Strategy); allowed-channel set &
   reminder ceiling (Collections Policy); execution history (Effort); amount owed
   (Receivable); settlement truth (Authority).
4. **Breaks if deleted:** no definition of a valid attempt — partial / installments
   / expiry / currency become hardcoded or undefined; attempts cannot be bounded
   or validated; compliance of the *ask* is lost.

### Collections Policy
1. **Single question:** what is *permitted and required* in the pursuit process,
   and what are the defaults (the law)?
2. **Only it may hold:** the allowed-channel set, reminder ceiling, quiet hours,
   whether automatic creation is permitted, which Strategies are permitted,
   compliance limits (e.g. whether auto-receipt is allowed), aging definitions.
3. **Must not hold:** the concrete plan for a given debt (Strategy);
   attempt-shape permissions like partial / installments / expiry (Payment
   Policy); execution history (Effort).
4. **Breaks if deleted:** pursuit becomes ungoverned — infinite reminders, any
   channel, no quiet hours, no authorization of Strategies, no compliance gate →
   legal/operational risk.

### Collection Strategy
1. **Single question:** *how* do we prefer to pursue this specific debt — in what
   order, timing, and conditions?
2. **Only it may hold:** channel order/preference, inter-step timing (wait N
   days, reminder spacing as a plan), partial-before-full sequencing,
   prefer-installments-by-segment, escalate-to-human as a planned step,
   first-action (phone before link), variant by customer type / debt size.
3. **Must not hold:** permissions/ceilings (the Policies); attempt-internal
   properties like expiry/currency (Payment Policy); what actually happened
   (Effort); provider identity; any decision-engine logic.
4. **Breaks if deleted:** "how we prefer to pursue" has no home → ordering/timing
   collapse into Effort (intent conflated with execution) or Policy (per-case
   plan conflated with law); different approaches per segment become
   unrepresentable; "phone before link / wait N days" cannot be expressed as
   intent.

### Collection Effort
1. **Single question:** what was *actually done* in the pursuit, and what is its
   live state?
2. **Only it may hold:** touches sent (when / which channel), outcomes/responses,
   current pursuit state, the PaymentRequest instances actually created, history.
3. **Must not hold:** rules/permissions (the Policies); the intent/plan
   (Strategy); the canonical debt (Receivable); settlement truth (Authority).
4. **Breaks if deleted:** no record of what happened → no pursuit-state tracking,
   no idempotency, no audit, no stop-on-completion; the realized world is lost.

---

## 6. Final Ownership Matrix (every fact → a single owner)

| Fact / Capability | Owner | Register | Why not the others |
|---|---|---|---|
| Partial-payment permission | Payment Policy | Permission (attempt) | not a plan (Strategy); subject is the attempt, not the pursuit |
| Installments permission / validity | Payment Policy | Permission (attempt) | same as above |
| Currency / attempt amount bounds | Payment Policy | Permission (attempt) | property of the ask, not the pursuit |
| Canonical link-expiry duration | Payment Policy | Property (attempt) | pursuit timing ≠ attempt lifespan |
| Definition of "paid" (verification-bound) | Payment Policy → defers to Authority | Property (attempt) | the truth itself lives in Authority |
| Allowed-channel set | Collections Policy | Permission (pursuit) | the order belongs to Strategy; this is pursuit permission |
| Reminder ceiling / quiet hours | Collections Policy | Permission (pursuit) | a ceiling ≠ a plan; not an attempt property |
| Automatic-creation permitted? | Collections Policy | Permission (pursuit) | business rule, not a per-debt plan |
| Which Strategies are permitted | Collections Policy | Permission (pursuit) | Policy authorizes Strategy |
| Compliance limits (auto-receipt) | Collections Policy | Permission (pursuit) | law, not plan/execution |
| Channel order / preference | Collection Strategy | Plan | permission in Policy; execution in Effort |
| Wait-before-create / reminder spacing | Collection Strategy | Plan (timing) | pursuit timing ≠ attempt expiry |
| Partial-before-full sequencing | Collection Strategy | Plan | the partial *permission* is in Payment Policy |
| Prefer-installments by segment | Collection Strategy | Plan | the installments *permission* is in Payment Policy |
| First action (phone before link) | Collection Strategy | Plan | intent, not execution |
| Escalate-to-human (as a planned step) | Collection Strategy | Plan | the actual escalation event = Effort |
| Variant by customer type / debt size | Collection Strategy | Plan | choosing a plan, not a law |
| Touches sent / channel / actual timing | Collection Effort | Execution | plan ≠ execution |
| Outcomes / responses / live pursuit state | Collection Effort | Execution | only the realized world |
| PaymentRequest instances created | Collection Effort | Execution | the attempt is governed by Payment Policy; its creation is an Effort event |

---

## 7. The four contested capabilities — explicit rulings

| Capability | Permission → | Plan → | Execution → |
|---|---|---|---|
| **Partial payment** | "partial allowed" = **Payment Policy** | "partial-before-full" = **Strategy** | "collected ₪X partially" = **Effort** |
| **Installments** | "installments is a valid structure" = **Payment Policy** | "prefer installments for high debt" = **Strategy** | "installment plan applied" = **Effort** |
| **Link expiry** | canonical expiry duration = **Payment Policy** (attempt lifespan) | "wait N days before creating / reminder spacing" = **Strategy** (pursuit timing) | "link expired at T" = **Effort** |
| **First channel** | "which channels are allowed" = **Collections Policy** | "preferred channel / order" = **Strategy** | "sent on WhatsApp at T" = **Effort** |

Link expiry is the only one of the four that does not split three ways; it is
resolved by Cut 2 — it is a property of the attempt itself → Payment Policy.

---

## 8. Business-level vs document-level decisions

Principle: **the business sets the permitted envelope; the document chooses
within it.**

| Decision | Level |
|---|---|
| Which providers are connected/active | Business only |
| Whether auto-receipt is enabled | Business only (compliance) |
| Allowed channels, reminder ceiling, quiet hours | Business (envelope) |
| Which Strategies are permitted | Business (envelope) |
| Default link-expiry | Business default; document may override |
| Strategy chosen for this debt (within permitted) | Document / receivable |
| Provider for this attempt (within active) | Document; else default |
| Amount (full/partial within permission), description | Document |
| The actual send channel | Document / action |

---

## 9. Post-payment events (verified PAID only, idempotent)

A verified PAID triggers a defined set of business events, each **exactly once**:

1. **Settlement recorded** (PaymentTransaction) — Payments.
2. **Debt closure / allocation** — Billing (this is Closure; not Payments).
3. **Receipt issuance** — only if policy permits and the receipt capability is
   compliance-ready.
4. **Notifications** — to the business, optionally to the customer.
5. **Collection Effort stops** for that debt.

**Invariant:** Payments signals "verified settlement"; Billing decides
Closure. No post-payment event runs on an unverified signal.

---

## 10. Provider-agnostic invariant

- The policy speaks only in business verbs: obligation, amount, channel, timing,
  settlement, closure. It never references provider concepts.
- **Collection Strategy is provider-blind** — even more strictly than Payment
  Policy: it must not know that providers exist (channels and timing only, never
  a provider name). Capabilities such as installments are expressed as *intent*;
  reconciling them with a provider's actual capability is an execution concern,
  not a Strategy concern.
- Any policy statement that cannot be phrased without naming a provider is
  invalid for this constitution.

---

## 11. The Guardrail — Strategy is a plan, not an engine

Collection Strategy is the **declarative, selectable pursuit plan** — a thing
that can be pointed at and contradicted. It is **not** the engine that selects or
executes it. The discriminating test: "is this a thing you can point at and
contradict, or a function that computes behavior?" — Strategy is the former; an
engine is the latter and is **excluded from the constitution**.

Explicitly **outside this constitution** (they belong to implementation / the
collection engine): decision algorithms, planner, routing, AI/learning,
workflow, lifecycle, strategy-replacement, and identity evolution.

---

## 12. Canonical (ratified) vs implementation-recommendation

**Canonical (binding — to ratify):**
1. The entity set: Receivable, Payment Policy, Collections Policy, Collection
   Strategy, Collection Effort, PaymentRequest, Settlement, Closure.
2. Payments executes attempts and never owns the debt or its closure.
3. The model chain (§2), with Collections Policy as ambient law.
4. The four registers (§3): Permission / Plan / Execution / Authority.
5. The two cuts (§4) and the final Ownership Matrix (§6).
6. The contested-capability rulings (§7).
7. Business-vs-document boundary (§8).
8. Post-payment events are verified-PAID-only and idempotent (§9).
9. The provider-agnostic invariant (§10) and the Strategy guardrail (§11).

**Implementation-recommendation (decided later, not canon):** concrete default
values (expiry duration, reminder counts, thresholds), the exact channel set,
the automatic-vs-manual default, and any multi-provider routing. These are named
here only to mark them as **out of the constitution**.
