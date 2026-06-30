# Dubiz Business Obligation — Canonical Integration Model v1

> **Type:** Canonical business integration model (domain collaboration contract).
> **Status:** Foundation document. Defines how the Business Obligation domain
> collaborates with the rest of Dubiz, in business language only.
> **Not in this document:** APIs, message brokers, queues, event payloads/schemas,
> state machines, or any implementation technology. Those belong to a later Wave.
> **Builds on:** `dubiz-business-obligation-domain-v1.md` (the canonical domain),
> `payment-secretary-mvp-product-spec-v1.md`, and
> `payment-secretary-mvp-ux-blueprint-v1.md`.
> **Role:** every Dubiz domain must read this and know exactly *what it owns, what
> it publishes, what it consumes, and what it never changes* with respect to a
> Business Obligation — without creating duplicate truth, duplicate ownership, or
> conflicting responsibility.

Throughout: the **Business Obligation domain** is the operational coordinator.
The **Payment Secretary** is how the owner experiences it. "Coordinator" below
means the Business Obligation domain.

---

## 1. Integration Philosophy

A Business Obligation is **outbound, forward-looking, and cross-source**: the
business's commitment to pay, watched until it is honored. No single existing
domain holds that picture, because each existing domain owns only a **slice of
realized truth**:

- *Existence of a commitment* may originate in Suppliers (a purchase order),
  Documents (a received bill), the owner's own knowledge (rent, salaries), or a
  bank feed.
- *The amount and timing* may be stated by the owner, extracted from a document,
  or carried by a supplier commitment.
- *Whether it was paid* is owned only by Payments / verified settlement.
- *The evidence* is owned by Documents.

**Operational awareness is assembled, not authored.** The coordinator composes
these distributed truth-slices into **one watched obligation with a single
identity**, and adds the one thing no truth-domain provides: the forward
*will-it-be-met / does-it-need-attention / has-it-been-followed-to-closure*
dimension.

This is the same assembly pattern Dubiz already recognizes: distributed facts
composed into an identity-bearing unit of awareness (see
`dubiz-situation-concept-investigation-v1.md`). The coordinator exists precisely
because **assembling and following the outbound commitment is a responsibility
that the realized-truth domains structurally do not have.**

> The cut that makes integration safe: truth-domains own *what is true*; the
> coordinator owns *whether it will be met and what needs attention*. These are
> **orthogonal** — they describe different things about the same commitment, so
> they never compete.

---

## 2. Canonical Sources — what each domain may do

For each domain: what truth it owns, whether it can **originate** an obligation
(cause one to be recognized), whether it can cause an **operational update**,
whether it can cause **operational closure**, or whether it **only provides
signals / only consumes**.

> **Foundational rule for this whole section:** *originate / update / close* mean
> "**emit a signal that causes** the coordinator to recognize, re-time, or
> close." The **act itself** — instantiating the operational obligation, changing
> its operational state, closing it — is **always performed by the coordinator
> alone.** Sources never reach inside the coordinator; they speak in business
> meaning and the coordinator decides.

- **Manual Entry (owner)** — *Owns truth:* the owner-asserted facts of an
  owner-declared commitment (until a canonical source links). *Originate:* **yes**
  (owner hands off an obligation). *Update:* **yes** (owner edits who/amount/when).
  *Close:* **yes**, as owner-confirmed Met/Released (unverified). *Note:* canonical
  for the MVP, not a stopgap.
- **Documents** — *Owns truth:* the artifact and its extracted facts (the
  Financial Truth Layer). *Originate:* **yes** (a received bill/contract reveals a
  commitment). *Update:* **yes** (re-extraction corrects amount/date). *Close:*
  **signal only** (a receipt is *evidence* of closure; the coordinator decides).
- **Billing** — *Owns truth:* invoices the business *issues* and *Receivables*
  (inbound). *Originate / Update / Close:* **no — out of direction.** Billing is
  the **inbound mirror**; it does not own outbound obligations. (Tax/VAT payable
  arising from issued activity is recognized via accounting/owner declaration, not
  authored by Billing.) Listed here to **lock the mirror boundary.**
- **Suppliers** — *Owns truth:* supplier relationships and supplier commitments
  (purchase orders as commitments). *Originate:* **yes** (a commitment implies a
  payable). *Update:* **yes** (commitment changed → amount/timing changes).
  *Close:* **signal only** (commitment cancelled → *release* signal; the
  coordinator decides closure).
- **Payments** — *Owns truth:* payment attempts and, via the **Authority**,
  verified settlement. *Originate:* **no.** *Update:* **signal** (attempt
  failed → still owed). *Close:* **authoritative signal** — verified settlement is
  *the* signal that lets the coordinator recognize **Met**.
- **Business Brain** — *Owns truth:* meaning and cross-analysis across the whole
  business. *Originate / Update / Close:* **no.** **Consumer** of obligations
  (composes Situations and recommendations over many of them); may emit
  **advisory** meaning that influences *framing/priority*, never lifecycle or
  truth.
- **Learning Engines** — *Owns truth:* learned patterns over outcomes. *Originate
  / Update / Close:* **no.** **Pure consumer** (reads outcomes: met on time,
  postponed, breached). Anything they produce is **advisory only**, never
  authoritative.
- **Future Bank Integration** — *Owns truth:* observed account movement.
  *Originate:* **yes** (a recurring debit reveals a commitment). *Update:*
  **signal** (changed standing order). *Close:* **authoritative signal** (an
  outgoing payment observed → settlement). Integrates as *just another source* of
  the same signal meanings.

---

## 3. Business Signals (conceptual — not schemas)

A small, finite vocabulary of **business meanings** that domains emit. Any
source maps onto these; new sources add no new meanings.

| Signal (business meaning) | Emitted by (examples) | What it asserts |
|---|---|---|
| **Obligation discovered** | Manual Entry, Documents, Suppliers, Bank | "A future commitment-to-pay exists." |
| **Obligation details changed** | Documents (re-extraction), Manual Entry, Suppliers | "The amount or counterparty of an existing commitment changed." |
| **Due moment changed** | Suppliers, Manual Entry, Documents, Bank | "When it must be met has moved." |
| **Supplier commitment changed** | Suppliers | "The order behind a payable changed in scope/terms." |
| **Settlement observed (verified)** | Payments / Authority, Bank | "Payment for this commitment occurred and is verified-true." |
| **Closure evidence available** | Documents | "A receipt/proof of meeting exists" (evidence, not authority). |
| **Owner confirmed handled** | Manual Entry (owner) | "The owner asserts this was met" (unverified). |
| **Obligation cancelled / released** | Suppliers, Manual Entry | "The underlying commitment no longer exists." |
| **Cross-obligation meaning** | Business Brain | "These obligations together mean something" (advisory). |

These are **meanings, not messages.** This document does not define their form.

---

## 4. Business Obligation Reactions

For each signal, what the coordinator should **understand and do** — at the
level of operational awareness only.

| Signal | Coordinator's understanding / reaction |
|---|---|
| **Obligation discovered** | **Recognize** — create operational awareness with a single identity; begin watching. If it reconciles to an existing identity, **merge**, do not duplicate. |
| **Obligation details changed** | **Update awareness** of who/amount; re-assess attention. Never overwrite the source's truth. |
| **Due moment changed** | **Update timing**; re-evaluate whether/when this needs the owner. |
| **Supplier commitment changed** | **Update the payable's awareness** to match the commitment; if scope dropped to nothing, treat as **release**. |
| **Settlement observed (verified)** | **Close operationally as Met**; stop watching. Authoritative. |
| **Closure evidence available** | Treat as **supporting evidence**; raise confidence. Decide closure (do not auto-trust as authority). |
| **Owner confirmed handled** | **Close operationally as Met (unverified)**; stop watching. Await later verification to raise confidence. |
| **Obligation cancelled / released** | **Close operationally as Released**; remove operational concern. Not a payment. |
| **Cross-obligation meaning** | **Adjust framing/priority** of attention only. Never change lifecycle, amount, timing, or ownership. |
| *(no signal, due moment near)* | **Raise owner attention** on the coordinator's own timing logic (the Morning State rules). |
| *(no signal, on schedule)* | **Wait / stay silent.** |
| *(signal it does not own meaning for)* | **Ignore** — do not invent truth. |

---

## 5. Ownership Matrix

Exactly one owner per responsibility. **Origination** may be plural (it is a
*trigger*, not ownership; all originations reconcile to one identity).
**Operational state — update and closure — has a single owner: the coordinator.**

| Domain | Owns Truth (of…) | Originates Obligation (signal) | Updates Operational State | Closes Operational State | Consumes Obligation |
|---|---|---|---|---|---|
| **Business Obligation (coordinator)** | operational awareness only | — (acts on others' signals) | **YES (sole)** | **YES (sole)** | — (it *is* the obligation) |
| **Manual Entry (owner)** | owner-asserted facts | yes | via signal | via signal (owner-confirmed) | reads |
| **Documents** | artifact + extracted facts | yes | via signal | evidence signal only | — |
| **Billing** | issued invoices + Receivables (inbound) | no (mirror) | no | no | — |
| **Suppliers** | supplier relationships + commitments | yes | via signal | release signal only | — |
| **Payments / Authority** | attempts + verified settlement | no | via signal | authoritative settlement signal | — |
| **Business Brain** | cross-business meaning | no | no (advisory framing only) | no | **YES** |
| **Learning Engines** | learned patterns | no | no | no | **YES** |
| **Future Bank** | observed account movement | yes | via signal | authoritative settlement signal | — |

Reading the matrix: only the coordinator **updates or closes** operational
state. Sources only **originate or signal**. Truth columns never overlap on the
same fact. Consumers (Brain, Learning) **read and never write**.

---

## 6. Integration Invariants (never violated)

1. **Financial truth never moves into the coordinator.** It composes awareness
   *from* truth; it never becomes the truth.
2. **Operational state never overwrites financial truth.** If the coordinator's
   awareness and an owner's truth disagree, the truth-owner wins on the fact; the
   coordinator adjusts its awareness.
3. **Exactly one operational owner** — the Business Obligation domain — updates and
   closes operational state. No other domain reaches inside it.
4. **One commitment → one obligation identity.** Multiple originations reconcile;
   the coordinator never holds two obligations for the same real commitment.
5. **Settlement is authoritative only from the Authority** (verified settlement /
   bank). Evidence and owner confirmation raise confidence but are not settlement
   truth.
6. **Domains communicate through business meaning, not implementation detail** —
   the signal vocabulary of §3, nothing source-specific.
7. **Owner-asserted obligations are valid** — verification changes confidence, not
   existence.
8. **No obligation is ever silently dropped.** It ends only through explicit
   operational closure (Met / Released / Breached).
9. **Consumers never write.** Brain and Learning read obligations and emit only
   advisory meaning.

---

## 7. Failure Scenarios (business level)

- **A source is temporarily unavailable.** The coordinator keeps its **last known
  awareness** and **keeps watching** on its own timing. It never invents truth and
  never drops the obligation; it may treat the awareness as **stale / lower
  confidence** until the source returns.
- **Signals arrive late.** The coordinator's job is **eventual awareness**, not
  real-time truth. When a late signal arrives, awareness catches up. For a given
  fact, the **latest authoritative truth wins**; operational state realigns
  accordingly.
- **Multiple domains report the same obligation.** **Reconciliation to one
  identity** is mandatory (Invariant #4). If identity is ambiguous, the coordinator
  holds the reports as *candidate-same* and lets the originating truth disambiguate
  — but it **never creates duplicate ownership** and never double-watches one
  commitment.
- **Manual entry later links to a canonical source.** The owner-declared
  obligation is **reconciled (merged) into the canonical identity**: its
  follow-through history is **preserved**, its truth-source **upgrades** from
  owner-asserted to canonical, and its **confidence rises**. No new obligation is
  created and no history is lost.
- **Settlement reported after the owner already confirmed it.** The obligation was
  already **Met (unverified)**; the verified settlement simply **upgrades
  confidence to verified** — the closure does not re-open and the owner is not
  asked again. **Exception (Invariant #2):** if the verified truth says *not paid*
  while the owner had confirmed Met, the **authority wins** — the coordinator
  **honestly re-opens operational concern** and brings it back to attention.

---

## 8. Future Expansion

The architecture is **open for new sources, closed against change to the
coordinator** — at the business level:

- A new domain integrates by doing three things: **own its own truth**, **emit
  signals in the shared vocabulary** (§3), and **consume obligations read-only if
  it needs them**.
- Because integration happens at the level of **business meaning** (a finite set
  of signal meanings), not per-source mechanics, adding **email parsing, AI
  extraction, additional banks, new commitment types** adds *new origins of
  existing meanings* — never new responsibilities inside the coordinator.
- The coordinator's ownership, lifecycle, language, and invariants **do not change**
  when a new source appears. A new bank is "another origin of *discovered* and
  *settlement observed*." New AI extraction is "another origin of *discovered* and
  *details changed*."
- **Guard:** if a proposed integration cannot be expressed in the existing signal
  vocabulary without giving a source the power to *update or close operational
  state directly*, that is a violation — the source must emit meaning and let the
  coordinator decide. Ontology, ownership, or lifecycle changes require updating
  the canonical domain document first (per AGENTS.md).

---

## Appendix — consistency with ratified Dubiz foundations

- **Domain (`dubiz-business-obligation-domain-v1.md`):** this model is the
  collaboration layer over that domain; the orthogonal operational↔truth cut and
  the outbound-only rule are inherited unchanged.
- **Collections mirror (`payments-collections-policy-v1.md`):** "one obligation,
  many payment attempts; Authority owns verified settlement" applies identically
  in the outbound direction.
- **Documents = Financial Truth:** Documents originates and evidences; it never
  loses ownership of the artifact or its facts to the coordinator.
- **Authority Principle:** only verified settlement closes an obligation as Met;
  signals and evidence raise confidence but are not authority.
- **Situation:** the Brain composes meaning across obligations (Situations); the
  coordinator owns the single obligation's operational life.

No new paradigm is introduced. This document defines, in business terms, exactly
how every domain collaborates with the Business Obligation domain — so the later
technical architecture, events, and implementation are built on one shared
understanding.
