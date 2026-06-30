# Payment Secretary MVP — UX Blueprint v1

> **Type:** UX Blueprint (canonical). Translates
> `docs/payment-secretary-mvp-product-spec-v1.md` into a buildable experience.
> **Status:** Product discovery closed. This is the binding behavioral
> definition — a designer and an engineer must be able to build the *same*
> product from it without reinterpretation.
> **Not in scope here:** visual design, components, pages, layout, framework.
> This blueprint is about **human interaction**, governed by one question:
>
> **"What would the secretary naturally do next?"**

---

## 0. Resolved Product Decisions (binding — part of this blueprint)

These close the open items from the Pre-Implementation Review. They are
product rules, not algorithms.

### 0.1 Secretary Position — operational coordination domain

The Payment Secretary is an **operational coordination domain**. It is **not** a
financial ledger and **not** a system of record. It does not own financial
truth; it **consumes** truth from other Dubiz domains (Documents, Billing,
Supplier, Payments, and future bank integrations).

A **Business Obligation** inside the secretary is therefore an **operational
projection** — the secretary's *awareness* of a commitment whose authoritative
truth is owned elsewhere. The secretary decides what deserves attention, what
stays silent, what to remember, and what to follow until closure. It is an
**Operations Coordinator, not a ledger.** Every decision in this blueprint
inherits this position.

> Build implication: the obligation model is designed to be *fed by intake
> channels and updated by domain events*. The MVP wires only the **manual**
> intake channel and **owner-confirmed** settlement signal — but it is built as a
> consumer, never as a standalone CRUD silo.

### 0.2 Canonical Morning State rules

The morning state is a **conclusion about control**, never a count. Exactly
three exist. Classify by the most severe condition present
(**Critical > Busy > Calm**). "Needs you" means *the owner must make a decision
or take an action the secretary cannot take on its own, within the near
window.* Obligations the secretary is simply tracking and that are on schedule
**do not "need you"** and stay silent.

| State | Canonical rule | Secretary's posture |
|---|---|---|
| **Critical** | At least one obligation is **act-today-or-there-is-a-consequence** — overdue, due today, or a hard external deadline lands today (salaries, tax, a post-dated check clearing). *If the owner does nothing today, something breaks.* | Names the one thing, **explains why it can't wait**, presents the prepared action. |
| **Busy** | **No** break-today item, **and** more than one obligation needs the owner within the near window. *Several things are coming; none is on fire today.* | "I've prepared everything." Presents them **one focus at a time**, calmly. |
| **Calm** | **No** break-today item, **and** at most one minor thing to note; everything else tracked and on schedule. *Nothing needs you today.* | Reassures first. Mentions the one minor note lightly, or nothing. |

> **Honesty gate (interacts with 0.3):** the *global* reassurance "you're in
> control" is only available once the secretary is **oriented** (0.3). Before
> that, reassurance is *scoped* — "nothing you've told me about needs you today"
> — never a global all-clear.

### 0.3 First-Time Trust

The secretary **cannot claim control before it knows the business.** False Calm
on an empty system is the single fastest way to destroy trust.

- **On first launch** the secretary introduces itself and its job, then invites
  the owner to hand off obligations — starting with the **recurring backbone**
  (rent, salaries, key suppliers, taxes, standing orders).
- **Before it is oriented** the secretary's posture is **"Still settling in."**
  It never says "everything is under control." It says, in effect: *"I don't
  know all your obligations yet — let's start with the ones you never want to
  forget."*
- **"Oriented"** is reached when the owner affirms the recurring backbone is
  reasonably captured ("that's the main ones"). Orientation is owner-affirmed,
  not inferred from a number.
- Only after orientation does the **global Calm** verdict unlock. Before it, all
  reassurance is explicitly scoped to "what you've told me so far."

### 0.4 Manual Entry Philosophy

Manual entry exists in the MVP **to validate the secretary's behavior, not
because capture is the product.** The owner still feels relief because **relief
is earned over time, not at the moment of capture**:

- Entry is reframed as **handing off**, not data entry. The defining gesture is
  the owner *telling the secretary something so they can stop holding it.*
- The confirming line after every capture is the emotional core:
  **"From this moment on, I'll remember it for you."**
- The first entry is a one-time deposit into the secretary's memory; from then
  on the owner never carries that obligation again. The payoff is every morning
  *after* — it was remembered, surfaced at the right time, followed to closure.
- Therefore capture must feel like *speaking to a secretary*, never like
  completing a form. Minimum asked, secretary fills the rest, owner confirms.

### 0.5 Closure Semantics

In the MVP, closure is **owner-confirmed** (owner says "handled"). In the
future, closure arrives as a **settlement event** from Payments/Billing/bank and
auto-closes. **The owner experience must be identical across both:**

- The secretary **offers** closure as a light acknowledgment — *"want me to mark
  the rent handled?"* — it **never interrogates** ("did you pay?").
- When a future event arrives, the secretary simply does the same gesture on the
  owner's behalf — *"I saw the rent went out — closing that one. ✓"*
- **MVP "Closed" = owner-asserted (unverified).** Future "Closed" =
  event-verified. The *word and the feeling* stay constant; only the trigger
  changes. The blueprint is written so no surface needs to change when
  verification arrives.

---

## 1. Experience Principles

**How the secretary behaves**
- It **prepares before it speaks.** By the time the owner arrives, the thinking
  is done.
- It **leads with a conclusion**, never with data.
- It **handles one thing at a time** and waits.
- It **remembers everything** so the owner can forget it.
- It **follows up** on what was postponed — once, at the right moment.
- It **closes every loop** and says so.
- It **disappears when not needed.** Silence is a feature, not a gap.

**What the owner should feel**
- *Briefed, not tasked.* *Relieved, not informed.* *In control, not in charge of
  the software.*
- The arc every morning: **anxiety → clarity → confidence → relief.**

**What must never happen**
- Never open with a list, table, or count.
- Never present a raw, unprepared problem.
- Never ask the owner to assemble context, browse, or interpret.
- Never make the owner report status to the system ("did you pay?").
- Never issue false reassurance before the secretary is oriented.
- Never leave the owner without either a clear next action or an explicit
  "nothing needed."

---

## 2. The Morning Conversation

The morning is a **30-second briefing**, structured identically in all states:
**Verdict → (prepared focus, if any) → close & reassure.** Only the content and
tone differ by state.

### 2.1 Calm Morning
1. **Verdict (the exhale):** *"Good morning. You're in control today — nothing
   needs you."*
2. **Optional minor note (light):** *"One small thing: the electricity bill is
   due Thursday. I've got it — I'll remind you Wednesday."*
3. **Close:** the owner leaves. No list is offered or required. (On demand only,
   they may ask *"what are you watching?"* — see §5.4.)

### 2.2 Busy Morning
1. **Verdict:** *"Good morning. A few things are coming up this week — I've got
   them ready. Let's take the first."*
2. **One focus at a time:** the most pressing prepared item, with the decision
   pre-assembled. *"The supplier payment to X, ₪4,200, is due Sunday. Want me to
   keep it on track for Sunday, or move it?"*
3. **Wait → handle → next.** After the owner decides/acknowledges, the next
   surfaces. The owner is told the shape up front (*"three things this week"*) so
   nothing feels concealed, but they are never shown all three at once.
4. **Close:** *"That's everything that needed you. I'll watch the rest."*

### 2.3 Critical Morning
1. **Verdict:** *"Good morning. One thing needs you today — and here's why."*
2. **The critical item + the reason:** *"Salaries run today, ₪38,000. If it
   doesn't go out today, your team is paid late. Everything's prepared."*
3. **The prepared action / decision.** If several are genuinely critical, the
   secretary states the count honestly and presents the **most consequential
   first**, one at a time: *"There are two things today. The most important is
   salaries — let's handle it first."*
4. **Close:** once the critical item(s) are handled, the morning drops to its
   true residual tone (Busy or Calm) and closes there.

---

## 3. User Journey (complete flow)

```
            ┌─────────────────────────────────────────────────────┐
            │ OPEN  →  the secretary has already assessed control  │
            └─────────────────────────────────────────────────────┘
                                   │
                 ┌─────────────────┴──────────────────┐
                 │ Is the secretary ORIENTED? (0.3)    │
                 └─────────────────┬──────────────────┘
                       NO ◄────────┴────────► YES
                        │                      │
        ┌───────────────▼─────────┐   ┌────────▼──────────────┐
        │ STILL SETTLING IN        │   │ MORNING VERDICT       │
        │ - introduces itself      │   │ (conclusion first)    │
        │ - invites handoff of     │   └────────┬──────────────┘
        │   recurring backbone     │     ┌───────┼────────┐
        │ - scoped reassurance only│   CALM    BUSY    CRITICAL
        └───────────┬──────────────┘     │       │        │
                    │                     │   one-focus  one-focus
              (capture loop)              │   at a time  + reason
                    │                     │       │        │
                    ▼                     │       ▼        ▼
        ┌────────────────────────┐        │   ┌─────────────────────┐
        │ TELL-THE-SECRETARY      │        │   │ SINGLE ITEM FOCUS   │
        │ "what should I remember"│        │   │ decide / ack /      │
        │ → "I'll remember it     │        │   │ postpone / close    │
        │    for you" ✓           │        │   └─────────┬───────────┘
        └───────────┬─────────────┘        │             │
                    │                       │      more items? ──yes──┐
            owner affirms backbone          │             │           │
                    │                       │            no           │
                    └─────────► ORIENTED    │             │           │
                                            ▼             ▼           │
                              ┌──────────────────────────────┐        │
                              │ CLOSE & REASSURE              │◄───────┘
                              │ "that's everything that       │
                              │  needed you. I'll watch       │
                              │  the rest."  → owner leaves    │
                              └──────────────────────────────┘
```

**Every transition has a defined exit:**
- From Verdict, Calm → leave (or, on demand, "What I'm Watching").
- From any Single Item Focus → **decide**, **acknowledge**, **postpone** (sets a
  follow-up), or **close** (owner-confirmed, §0.5).
- From Tell-the-Secretary → captured + handoff confirmation → back to briefing.
- The owner can **always leave**; nothing traps them in a list.

---

## 4. Interaction Model

| Secretary action | When it happens |
|---|---|
| **Says** | States the verdict and what it has prepared. Always conclusion-first. |
| **Asks** | Only when it needs a decision it cannot make itself: prioritize between criticals, confirm an amount it's unsure of, or offer closure. One ask at a time, fully prepared. |
| **Waits** | After surfacing one item. It never stacks a second item on an undecided first. |
| **Reassures** | On Calm mornings, and after every closed loop: *"Done — I'll keep watching."* |
| **Escalates** | When a tracked obligation crosses into break-today, it raises the morning to Critical and **explains why now.** |
| **Follows up** | On a postponed item, it re-surfaces **once, at the right moment** — never repeated nagging. |
| **Disappears** | When nothing needs the owner. No engagement-driven pings. Silence = "you're covered." |

---

## 5. Screen Responsibilities (responsibility, not visual design)

### 5.1 The Morning Briefing (the Hero)
- **Question it answers:** *"Am I in control today?"*
- **Why it exists:** it is the product's spine — the conclusion before anything
  else.
- **Entered:** every time the owner opens the secretary.
- **Left:** when nothing needs the owner, or when all surfaced items are handled.

### 5.2 The Single Item Focus
- **Question:** *"What about this one — and what do you want to do?"*
- **Why:** it is where one prepared decision is made, in isolation.
- **Entered:** when the secretary surfaces an obligation that needs the owner.
- **Left:** on decide / acknowledge / postpone / close. Returns to briefing.

### 5.3 Tell-the-Secretary (capture / handoff)
- **Question:** *"What should I remember for you?"*
- **Why:** the manual intake channel (§0.4); the moment of handoff.
- **Entered:** during onboarding, or whenever the owner hands off a new
  obligation.
- **Left:** when captured and the secretary confirms *"I'll remember it for
  you."*

### 5.4 What I'm Watching (on-demand only)
- **Question:** *"What are you tracking for me?"*
- **Why:** to let the owner *verify* the secretary is holding everything — the
  proof behind the reassurance.
- **Entered:** **only on demand** — never the default surface.
- **Left:** back to the briefing.
- **Constraint:** even here it is a *calm summary grouped by meaning*, never a
  raw data table. (Cognitive Firewall, §6.)

---

## 6. Information Hierarchy — the Cognitive Firewall

Three tiers, strictly separated. **Meaning always precedes data.**

| Tier | Contains | Visibility |
|---|---|---|
| **Attention** | Obligations that **need the owner** today/soon (a decision or action) | Surfaced in the briefing, one at a time |
| **Silent** | Obligations the secretary is **tracking and on schedule** | Not shown; secretary is simply watching. Available via "What I'm Watching" on demand |
| **Hidden** | Raw data — amounts breakdowns, dates, source documents, history | Behind the meaning; only on demand, never in front of a conclusion |

**The Cognitive Firewall principle:** the owner is shown *conclusions and
prepared decisions*. Underlying data exists and is reachable, but it never leads.
What deserves attention is surfaced; everything on-schedule stays silent;
raw data appears only when explicitly requested.

---

## 7. Wireframe Sketches (low-fidelity — structure only)

**Calm Morning**
```
┌──────────────────────────────────────────────┐
│  Good morning.                                 │
│  You're in control today — nothing needs you.  │   ← VERDICT (conclusion)
│                                                │
│  (light note)  Electricity due Thu — I've got  │   ← at most one minor note
│                it. I'll remind you Wed.        │
│                                                │
│            · · · (nothing else) · · ·          │
│                                                │
│  [ what are you watching? ]   ← on demand only │
└──────────────────────────────────────────────┘
```

**Busy Morning (one focus at a time)**
```
┌──────────────────────────────────────────────┐
│  Good morning.                                 │
│  A few things this week — I've got them ready. │   ← VERDICT
│  Let's take the first.                         │
│                                                │
│  ┌──────────────────────────────────────────┐ │
│  │ Supplier X · ₪4,200 · due Sunday          │ │   ← SINGLE FOCUS
│  │ Prepared. Keep it on Sunday, or move it?  │ │
│  │   [ keep on track ]   [ move ]            │ │
│  └──────────────────────────────────────────┘ │
│                                                │
│  (2 more this week — I'll bring them next)     │   ← honest shape, not shown
└──────────────────────────────────────────────┘
```

**Critical Morning**
```
┌──────────────────────────────────────────────┐
│  Good morning.                                 │
│  One thing needs you today — here's why.       │   ← VERDICT + REASON
│                                                │
│  ┌──────────────────────────────────────────┐ │
│  │ Salaries run today · ₪38,000              │ │   ← THE critical item
│  │ If it doesn't go out today, your team is  │ │
│  │ paid late. Everything's prepared.         │ │
│  │   [ it's handled ]   [ I need to move it ]│ │   ← prepared action
│  └──────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
```

**Tell-the-Secretary (handoff)**
```
┌──────────────────────────────────────────────┐
│  What should I remember for you?               │
│  ┌──────────────────────────────────────────┐ │
│  │ (who)        Rent — landlord              │ │   ← minimum asked;
│  │ (how much)   ₪9,000                       │ │     secretary fills rest
│  │ (when)       1st of each month            │ │
│  └──────────────────────────────────────────┘ │
│  ✓ From this moment on, I'll remember it       │   ← the emotional core
│    for you.                                    │
└──────────────────────────────────────────────┘
```

---

## 8. Empty States

- **First launch (not oriented):** introduction + invitation. *"Hi — I'm your
  secretary. My job is to remember every payment you owe, so you don't have to.
  Let's start with the ones you never want to forget."* **Never** "all clear."
- **No obligations yet:** scoped, honest. *"I don't know your obligations yet.
  Tell me the first one and I'll take it from there."* Provisional posture, not
  Calm.
- **Everything under control (oriented + on schedule):** the *true* Calm —
  *"You're in control today. Nothing needs you."* This is earned, not default.
- **Still learning the business (partially oriented):** scoped reassurance —
  *"Nothing you've told me about needs you today. Want to add anything else I
  should be watching?"* Never global all-clear until oriented.

---

## 9. Edge Cases (UX behavior — model must hold, no new features)

- **Many urgent obligations:** Critical morning. Secretary **states the count
  honestly** and presents the **most consequential first**, one at a time:
  *"There are three things today — let's start with the most important."* Honest
  about scale; never a simultaneous pile.
- **No urgent obligations:** Calm. Secretary disappears after reassurance.
- **Dozens of recurring obligations:** they live in the **Silent tier**. The
  briefing stays constant in size regardless of count. "What I'm Watching" groups
  them by meaning (e.g. "monthly fixed," "suppliers") — never a wall of rows.
- **Forgotten obligation surfaces:** framed as a **save, never a blame** — *"I
  caught this for you: the insurance renews Friday."* This is a Wow moment, not an
  accusation ("you forgot").
- **Postponed obligation:** owner says "not now" → secretary sets a follow-up and
  re-surfaces **once**, at the right moment. *"Bringing this back — the supplier
  payment you moved is now due tomorrow."*
- **Owner returns after weeks away:** **no backlog dump.** A "welcome back"
  conclusion: *"Welcome back. While you were away I kept everything tracked. Two
  things need you now — here's the first."* What was handled/on-schedule stays
  silent; only what needs them now is surfaced, prioritized.

---

## 10. UX Invariants (never violated)

1. **Always begin with a conclusion; never with a list.**
2. **Meaning before data** — never expose raw data before its meaning (Cognitive
   Firewall).
3. **One thing at a time** — never stack a second decision on an undecided first.
4. **Never overload** — honest about scale, but never show the pile.
5. **Prepare before asking** — the owner never assembles context themselves.
6. **Never make the owner report to the system** — closure is *offered*, never
   interrogated.
7. **Never issue false reassurance** — global Calm only after orientation;
   otherwise scoped.
8. **Always close the loop and say so** — no surfaced item is left dangling.
9. **Never leave the owner without a next action or an explicit "nothing
   needed."**
10. **Disappear when not needed** — silence is the highest service; no
    engagement pings.
11. **The owner can always leave** — nothing traps them in a list or a flow.
12. **The owner must never feel they are managing software** — every interaction
    feels like a 30-second briefing with a trusted secretary.

---

## Appendix — inheritance & consistency

This blueprint inherits, and does not redefine:
- The Product Spec (`payment-secretary-mvp-product-spec-v1.md`) — mission,
  obligation lifecycle, three states, cognitive rules.
- Dubiz product constitution & visual language — conclusion-before-list,
  one-primary-action, calm-over-productivity, honesty, restraint.
- The coordination-domain position (§0.1), consistent with
  `payments-collections-policy-v1.md` (the secretary consumes truth owned by
  Billing/Supplier/Payments; it does not re-own it).

No new paradigm is introduced. This document only translates the approved
product definition into binding interaction behavior.
