# Dubiz Business Obligation — Canonical Domain Definition v1

> **Type:** Canonical business domain definition (ubiquitous language).
> **Status:** Foundation document. Defines *what a Business Obligation is* inside
> Dubiz, in business language only.
> **Not in this document:** events, APIs, schemas, tables, fields, state
> machines, CQRS, event sourcing, backend or frontend implementation. Those
> belong to the next Wave.
> **Role:** every future Dubiz domain (Billing, Documents, Suppliers, Payments,
> Business Brain, Learning Engines, AI, future integrations) must be able to read
> this and answer the same question identically:
>
> **"What is a Business Obligation, and what role does my domain play in its life?"**

This document is the business foundation. The **Payment Secretary** is *how the
owner experiences* this domain; the **Business Obligation domain** is *the
business concept itself.* They are not the same thing, and this document defines
the latter.

---

## 1. Domain Mission

**The problem this domain exists to solve:** a business carries many future
commitments to pay — rent, salaries, suppliers, taxes, insurance, standing
orders, post-dated checks, Net-30/60 terms. No single existing domain holds the
**complete, forward-looking, cross-source picture of everything the business
must pay, watched until each one is met.** That picture lives today only in the
owner's head — which is exactly the burden Dubiz removes.

**Why this domain is independent from Billing, Payments, Documents and
Suppliers:** each of those owns a *fragment of realized truth*, and each is
*backward- or artifact-facing*:

- **Billing** owns invoices the business *issues* and the *Receivables* owed to
  it (inbound).
- **Documents** owns the *evidentiary facts* extracted from artifacts (the
  Financial Truth Layer).
- **Suppliers** owns supplier *relationships and commitments* (e.g. purchase
  orders), scoped to restocking.
- **Payments** owns payment *attempts and verified settlement* (execution).

None of them owns the **forward, cross-source, will-it-be-met** view of the
business's *own outbound commitments*. That view — *operational awareness of
obligations until they are honored* — is the Business Obligation domain. It
exists because the gap is real: the future-facing coordination of payables has
no home in the realized-truth domains.

> Mirror note: the **Collections** domain (`payments-collections-policy-v1.md`)
> is the *inbound* counterpart — pursuing what customers owe the business. The
> Business Obligation domain is its **outbound mirror** — the business as the
> party that owes. They share structure and must never be conflated.

---

## 2. Domain Responsibility

### What this domain OWNS
**Operational coordination of outbound commitments-to-pay:**
- **Recognition** — knowing an obligation exists and giving it a single,
  continuous identity.
- **Awareness** — holding *who, how much, when* as the forward expectation.
- **Attention** — deciding what needs the owner now, and what stays silent.
- **Follow-through** — watching each obligation over time until it is met.
- **Operational closure** — recognizing that an obligation has been honored (or
  released, or breached) and ceasing to watch it.

### What this domain NEVER owns
| Concern | True owner |
|---|---|
| **Financial truth** (the authoritative monetary reality) | Accounting / Documents (Financial Truth Layer) |
| **Accounting truth** (postings, balances, books) | Accounting |
| **Payment execution & verification** | Payments (attempt) + Authority (verified settlement) |
| **Document ownership** (the artifact and its extracted facts) | Documents |
| **The underlying commitment where another domain owns it** (e.g. a purchase order) | Suppliers (and the originating domain) |
| **The inbound inverse** (money owed *to* the business) | Billing / Collections (Receivables) |

**The defining cut:** the Business Obligation domain owns the
**will-it-be-met / does-it-need-attention** dimension (operational). The
originating and truth domains own the **what-is-it / is-it-true / was-it-paid**
dimension (truth). These are **orthogonal** — they describe different things
about the same commitment, so they never compete for ownership.

---

## 3. Canonical Definition

> **A Business Obligation is a recognized commitment by the business to pay a
> determinable amount to a determinable party at a determinable time — held so
> that it is never forgotten and followed until it is honored.**

**What it is:**
- **Forward-looking** — at recognition it is always a *future* commitment to
  meet.
- **Outbound** — the business is always the *payer*. Direction is fixed.
- **Singular and identified** — it is one continuous thing with its own identity,
  accumulating follow-through over time.
- **Operational** — it is the business's *awareness and pursuit* of a
  payment-to-be-made, not the money itself and not the proof of payment.

**What it is not:**
- Not the money, the ledger entry, or the accounting record.
- Not the document that evidences it.
- Not the payment that fulfills it, nor proof that payment occurred.
- Not a Receivable (that is the inbound inverse — owed *to* the business).
- Not a user-created task or reminder; it reflects a *real commitment in the
  world*, sourced from reality, not invented by the owner for convenience.

**When it begins:** at **Recognition** — the moment a real future
commitment-to-pay becomes known to the domain (from any source) and is given
identity. The commitment may have existed in the world earlier (a lease signed,
staff hired, an order placed); the *obligation* begins when the domain recognizes
it.

**When it ends:** at **explicit closure** — when it is **Met** (honored),
**Released** (the underlying commitment ceased to exist), or **Breached** (the
moment to meet it passed without fulfillment, recognized honestly). An obligation
**never ends by silently disappearing.**

---

## 4. Domain Boundaries

In every case the rule is the same: **the other domain owns the truth; the
Business Obligation domain recognizes and coordinates the commitment-to-meet.**

- **Billing.** Billing owns invoices the business *issues* and *Receivables*
  (inbound), including numbering, immutability, and the financial closure of its
  own debts. A Business Obligation is the *outbound mirror* and is never owned by
  Billing. When the business *receives* a bill, the obligation domain recognizes
  the payable; Billing/Documents own the artifact.
- **Documents.** Documents is the Financial Truth Layer — it owns the artifact
  and its extracted facts. The obligation domain *consumes* document-sourced facts
  to recognize and update obligations (e.g. a received bill → an obligation; a
  receipt → evidence of closure). It never owns the document or its extraction.
- **Suppliers.** The Supplier domain owns supplier *relationships* and supplier
  *commitments* (purchase orders as commitments, per the Supplier constitution).
  A supplier-payment obligation *recognizes the payable arising from* a supplier
  commitment; it does not re-own the purchase order. Suppliers own "what was
  ordered and received"; the obligation domain owns "the resulting payment must
  be met."
- **Payments.** Payments owns payment *attempts*; **Authority** owns *verified
  settlement*. The obligation domain consumes verified settlement to recognize an
  obligation as **Met**. It never executes, routes, or verifies payment.
- **Business Brain.** The Brain owns *meaning and cross-analysis across the whole
  business* — forming Situations, insights, and recommendations. The obligation
  domain supplies a clean stream of forward commitments and their operational
  states; the Brain may compose meaning *over* many obligations. The obligation
  domain owns the operational life of **a single obligation**; the Brain owns
  **cross-obligation meaning**. (An obligation is Reality-level; a "cash-flow
  risk" spanning many is a Situation — Brain-level. See
  `dubiz-situation-concept-investigation-v1.md`.)
- **Learning Engines.** They *observe outcomes* of obligations (met on time?
  postponed? breached?) to learn and improve. They read from the obligation's
  life; they never own or alter it.

**No duplicated responsibility:** where a commitment already has a home (a PO, a
received invoice), the obligation domain *references and coordinates* it; it does
not create a second source of truth.

---

## 5. Business Lifecycle (pure business reality)

1. **Commitment exists (in the world).** The business takes on, or already
   carries, a future payment commitment — signs a lease, employs staff, places an
   order, receives a recurring bill, owes a tax.
2. **Recognition.** The commitment becomes known to the domain and is given a
   single continuous identity. From here, the business no longer has to carry it
   in memory.
3. **Watched / On track.** The domain holds the forward expectation (who, how
   much, when) and watches it. Nothing is required of the owner; it stays silent.
4. **Attention.** As the moment approaches, or something changes, the obligation
   needs the owner — a decision or an action only the business can make.
5. **Action.** The business acts: pays, schedules, moves, disputes, or otherwise
   addresses it.
6. **Closure (one of three, always explicit):**
   - **Met / Honored** — the commitment was fulfilled. The domain recognizes this
     and stops watching.
   - **Released** — the underlying commitment ceased to exist (order cancelled,
     lease ended). There is nothing left to meet.
   - **Breached / Lapsed** — the moment passed without fulfillment. The domain
     recognizes the reality honestly; it does not hide a miss.
7. **Recurrence (for recurring commitments).** When a commitment repeats (monthly
   rent, salaries, standing orders), the **next instance is recognized** while the
   **series identity persists.** The business never re-enters what recurs.

> The lifecycle is *forward at the start* and *closed only by an explicit
> outcome*. "Forgotten" is not a lifecycle state — its absence is the domain's
> entire reason to exist.

---

## 6. Business Invariants (always true)

1. **Direction is fixed.** Every Business Obligation is *outbound* — the business
   is the payer. A Receivable is never a Business Obligation.
2. **Every obligation has the three forward essentials:** a party to be paid
   (the **Obligee**), an expected **amount**, and an expected **due moment** —
   even when approximate.
3. **Every obligation has exactly one operational owner** (this domain) **and
   exactly one truth-source** for its underlying facts. The two are orthogonal and
   **never compete.**
4. **One obligation, one identity.** The same real commitment is never silently
   duplicated when observed from a second source; recognition reconciles to the
   existing identity.
5. **Operational state never replaces financial truth.** The domain's "Met" is
   *awareness* that the commitment was honored — not an accounting closure and not
   a verification of payment.
6. **The domain never declares settlement.** It *consumes* verified settlement
   from the Authority; it never asserts that money moved.
7. **Validity does not require verification.** An owner-asserted (unverified)
   obligation is fully valid; verification raises *confidence*, it is not a
   condition of *existence*.
8. **Every obligation has an expected outcome** — to be Met — and ends only
   through an explicit closure (Met, Released, or Breached). **No obligation ever
   disappears silently.**
9. **The business is never made to carry an obligation in its own memory** once
   recognized; remembering it is the domain's job.

---

## 7. Domain Language (ubiquitous vocabulary)

**Official terms — use these:**
- **Business Obligation** (within this domain, "Obligation") — a forward,
  outbound commitment-to-pay.
- **Obligee** — the party to be paid (landlord, supplier, employee, tax
  authority). The business is always the payer.
- **Amount (expected)** — what is owed, as a forward expectation.
- **Due moment** — when it must be met.
- **Source** — where the obligation was recognized from (owner-declared,
  Documents, Suppliers, Billing, future integrations).
- **Recognition** — the obligation becoming known and identified.
- **Attention** — the operational condition of needing the owner now.
- **Watched / On track** — tracked, on schedule, requiring nothing.
- **Follow-through** — the domain's pursuit of the obligation until closure.
- **Met / Honored** — fulfilled (operational closure).
- **Released** — the underlying commitment ceased; nothing left to meet.
- **Breached / Lapsed** — the moment passed unfulfilled.
- **Recurring Obligation / Recurrence** — a commitment that regenerates as a
  persisting series.
- **Operational closure** — the domain's recognition that watching can stop;
  distinct from financial/accounting closure.

**Forbidden terms — never use these for this domain:**
- **Task / To-do / Reminder** — implies a user-invented note, not a real
  commitment. (Reminder-list drift.)
- **Ledger / posting / journal / balance** — accounting truth, owned elsewhere.
- **Receivable / debt-owed-to-us** — the inbound inverse; never this domain.
- **Invoice / bill** *as the obligation itself* — those are documents/sources,
  owned by Documents/Billing.
- **Payment** *as something this domain performs* — execution belongs to
  Payments.
- **"Paid (verified)"** *declared by this domain* — settlement truth belongs to
  the Authority.

---

## 8. Domain Relationships (conceptual, not technical)

- **Obligation ↔ Commitment.** An obligation is the *payment dimension* of a
  commitment. A commitment ("we agreed to X" — a lease, a purchase order) may give
  rise to *one or many* obligations (monthly rent, installments). Commitment =
  the agreement; Obligation = "we must pay Y by Z because of it."
- **Obligation ↔ Document.** A document may be the *source/evidence* of an
  obligation (a received bill) or evidence of its *closure* (a receipt). The
  document is proof; the obligation is the commitment-to-meet. Documents owns the
  proof; this domain owns the meeting of it.
- **Obligation ↔ Supplier.** A supplier is a *counterparty in a role*. A supplier
  obligation is simply one whose Obligee is a party in the supplier role. The
  Supplier domain owns the relationship and the order; this domain owns the
  payable's operational life.
- **Obligation ↔ Payment.** A payment is an *act that meets* an obligation, fully
  or partially. One obligation may be met by **zero-to-many** payments over time
  (mirroring "one Receivable may spawn many payment attempts"). Payment is
  execution; the obligation is the thing-to-be-met.
- **Obligation ↔ Settlement.** Settlement is the *verified truth* that payment
  occurred. It is the authoritative signal that lets this domain recognize an
  obligation as **Met**. (Per the Payments Authority Principle.)
- **Obligation ↔ Billing.** Billing handles the business's *issued* invoices and
  *Receivables* (inbound); this domain handles the business's *own payables*
  (outbound). They are mirror domains and must never be merged.

---

## 9. Domain Decisions (never reopen)

1. A Business Obligation is a **forward, outbound commitment-to-pay**; the
   business is always the payer. **Receivables are not obligations.**
2. The domain owns **operational coordination only** — never financial truth,
   accounting truth, payment execution, or documents.
3. **One operational owner (this domain) + one truth-source**, orthogonal and
   never competing.
4. The domain **consumes settlement; it never executes or verifies payment.**
5. **Recognition reconciles to identity** — the same real commitment is never
   duplicated across sources.
6. **Operational closure ≠ financial closure.** "Met" is awareness, not
   accounting.
7. **Owner-asserted (unverified) obligations are canonical and valid** —
   verification is a confidence dimension, not an existence gate. (Manual
   recognition is legitimate, not a stopgap.)
8. An obligation ends **only** through explicit closure — **Met, Released, or
   Breached** — never silent disappearance.
9. Within Dubiz, **"Obligation" unqualified means this outbound concept;**
   inbound is always **"Receivable."**
10. This is a **coordination domain, not a record/ledger.**

These decisions exist to end future debate about terminology, ownership, and
responsibility. They are not to be reopened by later technical waves.

---

## 10. Domain Anti-Patterns (what it must never become)

- **Not a ledger or accounting system** — it holds no balances, postings, or
  books.
- **Not an ERP module** — it does not absorb procurement, inventory, HR, or
  finance functions.
- **Not a reminder or to-do list** — it coordinates *real commitments reconciled
  with truth*, never user-invented notes.
- **Not a payment processor** — it never moves or verifies money.
- **Not a document store** — it references evidence owned by Documents.
- **Not a system of record for financial truth** — truth lives in the originating
  domains.
- **Not a relationship/CRM owner** — the Supplier domain owns counterparty
  relationships.
- **Not a forecasting or cash-flow engine** — per-obligation coordination only;
  cross-obligation meaning belongs to the Business Brain.
- **Not a competing source of truth** — it must never drift from, or override,
  the domains that own the underlying facts.

---

## Appendix — consistency with ratified Dubiz foundations

- **Mirror of Collections** (`payments-collections-policy-v1.md`): same
  structural separation of *plan/execution/authority*, applied to the outbound
  direction. "One obligation, many payment attempts" mirrors "one Receivable,
  many PaymentRequests." Authority owns verified settlement in both.
- **Documents = Financial Truth** (`project_documents_truth_layer`): this domain
  consumes facts; it never owns truth.
- **Situation** (`dubiz-situation-concept-investigation-v1.md`): an obligation is
  Reality-level (an identified, accumulating unit); meaning that spans many
  obligations (e.g. a liquidity risk) is a Situation, owned by the Brain.
- **Payments Authority Principle:** only verified settlement transitions an
  obligation to Met; webhooks/signals are not authority.

No new paradigm is introduced. This document gives the Business Obligation its
canonical business identity, ownership, language, and boundaries, so that the
technical architecture of the next Wave is built on one shared understanding.
