# Payment Secretary MVP — Canonical Product Specification v1

> **Type:** Product Specification (canonical). Not UX, not implementation, not
> architecture, not API, not database.
> **Status:** Ratified product decisions transcribed into one buildable spec.
> **Role of this document:** Head of Product. Any PM, designer, or engineer
> should be able to read this and build *exactly the same product*.
>
> **The single test applied to every line below:**
> *"Will this make the owner genuinely feel that someone is remembering,
> tracking and managing obligations for them?"* If no — it is not in the MVP.

---

## 0. What this product is — and is not

We are building the **first MVP of a digital business secretary**. Its only
responsibility is to help a business owner stay in complete control of their
**future business obligations**.

| It is NOT | It IS |
|---|---|
| An ERP | A secretary who remembers obligations for you |
| An accounting screen | A 30-second morning conversation |
| An AI assistant | A presence that already prepared everything before you arrived |
| A list of payments | A conclusion: *"Are you in control today?"* |

This MVP inherits the existing Dubiz product constitution and visual language
(conclusion-before-list, one primary action, calm-over-productivity, honesty,
restraint). It introduces **no new philosophy and no new paradigm.**

---

## 1. What problem does the MVP solve?

Business owners do not fail because they lack information. They fail because they
**cannot continuously hold every future financial obligation in their head**
while simultaneously running the business.

The lived pain is one sentence:

> **"I'm afraid I forgot something."**

The owner is not asking for analytics, dashboards, or optimization. They are
asking to be **relieved of the burden of remembering**. Every obligation they
must pay — and the question of whether anything is slipping — currently lives in
their memory, sticky notes, and anxiety. That is the cost the MVP removes.

**What the MVP solves:** it takes ownership of *remembering, tracking and
following* every future obligation, so the owner no longer has to.

---

## 2. Who is the user?

The **business owner** — the single person ultimately responsible for the
business's obligations being met.

Defining characteristics that shape every decision in this spec:

- **Time-starved.** They open the product between two real-world tasks. They have
  seconds, not minutes.
- **Cognitively loaded.** Their attention is the scarcest resource in the
  business. The product must *protect* it, never tax it.
- **Not a finance professional.** They think in plain business terms — *"the rent,"
  "the supplier," "the salaries"* — not in ledgers, aging buckets, or statuses.
- **Anxious about the unknown.** Their fear is not a specific bill; it is the
  *possibility of a forgotten one*. Relief comes from trusting that someone else
  is watching.
- **Trust-driven.** They will only delegate remembering if the secretary proves,
  repeatedly, that it remembers better than they do.

The user is **not** an accountant, a bookkeeper, or a finance team. Those are
out of scope as users for this MVP.

---

## 3. What emotional journey does the user experience?

The MVP is an emotional product before it is a functional one. The journey has a
single arc: **from quiet dread to delegated calm.**

1. **Before opening (the carried weight).** "Did I forget something? Is anything
   about to surprise me?" — a low, constant background anxiety.
2. **The moment of opening (the exhale).** The first thing they meet is not data
   but a *conclusion* about their control. The secretary has already looked.
3. **The 30 seconds (being briefed, not working).** They feel *briefed by someone
   who prepared*, not confronted by a tool that demands input. Everything that
   needed organizing is already organized.
4. **The single decision (agency without burden).** At most, they confirm or
   acknowledge the one thing that genuinely needs them. The secretary did the
   preparation; the owner only supplies the judgment.
5. **Leaving (earned trust).** They close the product believing: *"It's handled.
   I can stop holding this in my head."* The carried weight is transferred.

Over repeated mornings the arc compounds into the core feeling:

> **"I no longer need to keep all my obligations in my head. Someone is
> remembering, tracking and following them for me."**

---

## 4. What happens from clicking the Hero until leaving the feature?

The entire experience is framed as a **morning conversation with a secretary**,
not a session in software. The owner should never feel they "opened an app."

### 4.1 The Golden Rule governs the entry

> **Never start with a list. Always start with a conclusion.**

The very first thing presented answers the only question the owner woke up with:

> **"Am I under control today?"**

The secretary has *already* assessed everything before the owner arrived. The
entry is a **verdict**, not a workspace.

### 4.2 The secretary sets the tone — one of three Morning States

The secretary — not the owner, and not a raw count of items — decides which of
exactly three states defines the morning. (Full definitions in §5.3.)

- **Calm Morning** — everything is under control; at most one small thing to note.
- **Busy Morning** — several things need attention; the secretary has already
  prepared each one.
- **Critical Morning** — an immediate decision is required; the secretary explains
  *why* it matters now.

The tone, language, and density of the entire experience flow from this state.
The owner feels *read*, not *sorted*.

### 4.3 The 30-second flow

1. **Hero / conclusion.** The owner meets the morning verdict in plain language:
   what the secretary concluded about their control today.
2. **The prepared briefing.** Beneath the conclusion, the secretary presents *only
   what it has already organized* — obligations grouped and framed as a human
   would brief them, never as a raw table. Nothing here is an unsolved problem
   dumped on the owner; everything is presented as *already handled or ready for a
   decision*.
3. **The single act of attention (if any).** When something requires the owner,
   the secretary surfaces **one** thing at a time, with the preparation already
   done and the decision reduced to a confirmation or acknowledgment. The owner is
   never asked to assemble context themselves.
4. **Loop closure.** When the owner acts (or when nothing needs them), the
   secretary confirms the loop is closed and that it will keep watching. The owner
   leaves knowing follow-up is owned by the secretary, not by them.

### 4.4 Leaving

The owner leaves after seconds, with a single takeaway: **"It's handled."** No
unfinished homework, no open lists, no nagging sense that something is still
sitting unread. The secretary keeps remembering after the owner closes it.

---

## 5. What is the responsibility of the secretary?

The secretary is the product's protagonist. Its responsibility is **to carry the
burden of obligation-control on the owner's behalf.**

### 5.1 What the secretary owns

- **Remembering every obligation** — so the owner never has to.
- **Tracking each obligation over time** — who, how much, when.
- **Following up** — watching obligations as their due dates approach.
- **Closing every loop** — nothing is dropped, forgotten, or left ambiguous.
- **Deciding the morning's tone** — translating the underlying state of all
  obligations into one of the three Morning States.
- **Preparing before asking** — doing the organizing work *before* the owner
  arrives, so the owner only supplies judgment.
- **Protecting the owner's attention** — surfacing the few things that matter and
  shielding everything else.

### 5.2 The Cognitive Rules (non-negotiable behavior of the secretary)

The secretary **always**:

- protects the owner's attention
- prepares before asking
- remembers everything
- follows up
- closes every loop

The secretary **never**:

- presents raw problems
- starts with data
- overloads the owner

These rules are binding on every screen, message, and interaction in the MVP.

### 5.3 The three Morning States (canonical definitions)

| State | Meaning | Secretary's posture |
|---|---|---|
| **Calm Morning** | Everything is under control. At most one small thing to note. | Reassures first. Mentions the one item lightly, already handled or trivially actionable. |
| **Busy Morning** | Several things need attention. | "I've prepared everything." Presents the prepared items calmly, one focus at a time — never as a pile. |
| **Critical Morning** | An immediate decision is required now. | Names the urgent thing plainly, **explains why it is critical**, and presents the prepared decision. Does not bury it. |

There are **exactly three** states. The secretary chooses one per morning. The
state is a *conclusion about control*, not a tally of items.

---

## 6. The lifecycle of a Business Obligation inside the MVP

The **Business Obligation** is the core entity. Everything in the product
revolves around it. Examples: rent, electricity, salaries, supplier payments,
Net 30 / Net 60 terms, insurance, taxes, standing orders, future checks.

> Documents are not the core. Payments are not the core. **Obligations are.**

An obligation is *a future financial commitment the owner is responsible for
meeting.* Its lifecycle inside the MVP:

1. **Known** — the secretary becomes aware an obligation exists and now *remembers
   it for the owner*. From this moment the owner no longer has to hold it in mind.
2. **Tracked** — the secretary holds the obligation's essentials: **who, how much,
   when**. It keeps these current and watches the calendar against them.
3. **Surfaced (when it matters)** — as the obligation approaches relevance (its
   timing, or a change that needs attention), the secretary raises it — *prepared*
   — into the morning briefing, weighted by the Morning State logic. Until then it
   stays handled and out of the owner's way.
4. **Decided / Acted** — when the obligation needs the owner, the secretary
   presents the single act of attention. The owner confirms or acknowledges.
5. **Closed** — the obligation is settled or otherwise resolved; the secretary
   **closes the loop** and confirms it is done. It is no longer a source of worry.
6. **Remembered (after closure)** — the secretary retains awareness so that
   recurring obligations (rent, salaries, standing orders) are remembered for next
   time, reinforcing the promise that nothing must be re-entered into the owner's
   head.

The defining property across the whole lifecycle: **the obligation lives in the
secretary's memory, never in the owner's.**

---

## 7. Which capabilities belong in the MVP?

A capability is **in** only if it makes the owner feel that someone is
remembering, tracking, and managing obligations for them.

- **The morning conclusion** — a single verdict answering *"Am I in control
  today?"* before any list. *(The product's spine.)*
- **The three Morning States** — Calm / Busy / Critical, chosen by the secretary
  to set the tone.
- **Obligation memory** — the secretary remembers each obligation (who, how much,
  when) so the owner doesn't.
- **Obligation tracking over time** — the secretary keeps obligations current and
  watches their due dates.
- **Prepared briefing** — obligations presented as an already-organized human
  briefing, never a raw table.
- **One act of attention at a time** — when the owner is needed, exactly one
  prepared decision is surfaced, reduced to confirm/acknowledge.
- **Follow-up and loop closure** — the secretary follows obligations to resolution
  and confirms each loop closed.
- **Recurring-obligation memory** — recurring obligations are remembered for next
  time without re-entry.

Every one of these passes the test in §0. Anything that does not is in §8.

---

## 8. Which capabilities are explicitly out of scope?

Out of scope for this MVP — not because they are bad, but because they do **not**
serve the single feeling, or they would turn the secretary into a tool:

- **ERP, accounting, or bookkeeping functionality** of any kind.
- **Reporting, analytics, dashboards, charts, optimization, forecasting.**
- **Raw lists or tables as the entry point** (violates the Golden Rule).
- **Receivables / collections** — chasing what *customers owe the business*. This
  MVP is about the owner's *outbound* obligations only. (Collections is governed
  separately by `docs/payments-collections-policy-v1.md` and is its own domain.)
- **Executing payments / moving money / provider integrations** inside this
  feature. The secretary tracks and remembers obligations; it is not a payment
  rail in the MVP.
- **A general AI assistant / chat / Q&A surface.**
- **Multi-user, accountant, or team workflows** — the user is the owner alone.
- **Configuration-heavy setup, policies, strategies, rules engines.**
- **Any flow that asks the owner to do organizing work the secretary should have
  done first.**
- **More than three Morning States**, or any state that is a count rather than a
  conclusion.

> Future AI capabilities are named here **only** to mark the MVP boundary. The
> MVP must work as a secretary *without* them.

---

## 9. Product Invariants

These must hold on every screen and in every interaction. They are the product's
constitution for this MVP.

1. **Conclusion before list.** The owner always meets a conclusion first, never a
   list. *"Am I in control today?"* is answered before anything is enumerated.
2. **The secretary prepares before it asks.** The owner is never handed unprepared
   work. Organizing happens before the owner arrives.
3. **One thing at a time.** When attention is needed, exactly one prepared act is
   surfaced. Never a pile.
4. **The obligation lives in the secretary's memory, not the owner's.** Nothing
   requires the owner to re-remember or re-enter what was already known.
5. **Every loop is closed.** No obligation is dropped, orphaned, or left
   ambiguous. The secretary confirms closure.
6. **Exactly three Morning States, each a conclusion about control** — never a
   tally of items.
7. **Obligation is the core entity.** Documents and payments are inputs/outputs,
   never the center.
8. **Calm over productivity.** The product optimizes for the owner's peace of
   mind, not for feature density or throughput.
9. **The owner never feels they opened software.** The register is a 30-second
   human briefing throughout.
10. **The test gates everything:** if a thing does not make the owner feel
    *someone is remembering, tracking and managing obligations for them*, it does
    not ship.

---

## 10. Anti-Patterns

Explicitly forbidden. Each is a direct violation of an invariant or cognitive
rule.

- **Opening with a list, table, or grid.** (Violates the Golden Rule.)
- **Presenting a raw problem** ("you have 7 unpaid items") without preparation or
  conclusion.
- **Starting with data** — counts, totals, charts — before a conclusion.
- **Overloading the owner** with multiple simultaneous decisions or dense screens.
- **Asking the owner to organize, sort, filter, or assemble context themselves.**
- **Making the owner re-enter or re-remember** obligations the secretary should
  already hold.
- **Leaving loops open** — surfacing something and then not following it to
  closure.
- **Tool-like tone** — statuses, fields, jargon, settings — instead of a secretary
  briefing in plain language.
- **A Morning State that is a count, not a conclusion**, or inventing a fourth
  state.
- **Turning the secretary into a generic assistant** that answers arbitrary
  questions instead of owning obligation-control.
- **Feature creep toward ERP/accounting** under the justification of "while we're
  here."

---

## 11. How do we measure success?

Success is measured against the **one thing the MVP must prove**:

> *"Dubiz behaves like a business secretary."*

Because the product is emotional, the primary measures are about *felt relief and
earned trust*, not engagement volume.

**Primary signals (does the owner feel relieved and in control?):**

- The owner reports they **no longer keep obligations in their head** / no longer
  fear forgetting. ("I'm afraid I forgot something" disappears.)
- The owner **trusts the morning verdict** enough to act on it without
  re-checking elsewhere.
- The owner **returns each morning** for the briefing as a habit — they treat the
  secretary as the source of truth for "am I in control."
- **No surprise obligations** reach the owner that the secretary failed to
  remember. (Forgotten-obligation incidents → zero is the goal.)

**Supporting signals:**

- The morning interaction genuinely takes **seconds**, not minutes.
- The owner **acts on the single surfaced item** rather than bouncing away
  confused.
- **Loops close** — surfaced obligations reliably reach resolution.

**Explicit non-metrics (do NOT optimize for these):** time-in-app, number of
screens viewed, feature usage breadth, items listed. More usage is *not* the
goal; *less worry* is.

---

## 12. The "Wow Moments" — proof the owner now has a secretary

Each is a moment where the owner *feels the burden was lifted* — proof the
promise is real.

1. **"It already knew."** The owner opens the product and the obligation they were
   privately anxious about is already there — remembered, tracked, prepared —
   before they had to think of it.

2. **"It told me I'm fine."** On a Calm Morning, the secretary's first words are a
   reassurance — *you're under control* — and the owner exhales. The product gave
   peace, not a task.

3. **"It prepared everything."** On a Busy Morning, instead of a pile of problems,
   the owner finds each item already organized and framed — and thinks *"I would
   have spent an hour on this."*

4. **"It caught the critical one — and told me why."** On a Critical Morning, the
   secretary surfaces the one urgent obligation, explains plainly why it can't
   wait, and hands over a prepared decision. The owner avoids a real miss.

5. **"It remembered so I didn't have to."** A recurring obligation (rent,
   salaries, a standing order) shows up next cycle without the owner re-entering
   anything. The realization lands: *I can stop holding this in my head.*

6. **"It closed the loop."** The owner acts once, the secretary confirms it's
   handled and that it will keep watching — and the worry is gone, not just
   deferred.

When these moments are felt repeatedly, the owner stops treating Dubiz as
software and starts treating it as **their secretary** — which is the only thing
this MVP set out to prove.

---

## Appendix — inheritance (no new philosophy introduced)

This spec is consistent with, and derives from, already-ratified Dubiz decisions:

- **Conclusion-before-list, one-primary-action, calm-over-productivity, honesty,
  restraint** — Dubiz product constitution & visual language.
- **Obligation as a first-class business primitive** — consistent with the
  Payments & Collections ontology (`docs/payments-collections-policy-v1.md`),
  where an obligation is an owned, tracked debt with a lifecycle. This MVP applies
  the same primitive to the owner's *outbound* obligations.
- **Attention directed at a meaningful, identity-bearing unit over time** —
  consistent with the Situation investigation
  (`docs/dubiz-situation-concept-investigation-v1.md`): the secretary directs the
  owner's attention to *what matters now*, assembled and tracked across time.

Nothing in this document redefines those foundations; it transcribes the ratified
Payment Secretary decisions into one buildable product specification.
