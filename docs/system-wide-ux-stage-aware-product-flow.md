# System‑Wide UX Rule — Stage‑Aware Product Flow (Mandatory)
  
This is a **system‑wide UX rule**. It is not limited to Billing.
  
**Goal**: reduce friction by ensuring every screen/flow guides the user with the correct action, the correct outcome, and the next step — at the right time — without turning the product into “wizards everywhere”.
  
---
  
## The principle (mandatory)
Every flow in the system must be **stage‑aware**.
  
The system must not make the user:
  
- search for the next step
- scroll aimlessly
- figure out “what now” alone
- go back to see results
- hunt for critical CTAs
- guess what’s missing to proceed
  
Instead, each screen must detect the current stage and present:
  
- the **right action**
- the **right result**
- the **next step**
  
---
  
## Stage model (shared vocabulary)
Use this model (or an equivalent set of stages) for every flow:
  
| User stage | What the system does |
| --- | --- |
| Start | Shows setup / first action clearly |
| In progress / data entry | Shows progress + next action |
| Healthy / ready | Promotes the next meaningful action |
| Success | Reveals the result immediately + next step |
| Missing requirements | Shows what’s missing **before** failure |
| Action completed | Moves focus to output/share/continue |
| Entity closed / completed | Hides irrelevant actions, shows the new stage actions |
  
Notes:
  
- “Entity” = a Quote / Invoice / Purchase / Task / Document / Conversation / Import run / etc.
- Stage must be derived from **server state** (status, relationships, constraints), not only from UI local state.
  
---
  
## Mandatory UX rules
### 1) Never make the user search for the next step
Every screen must explicitly answer:
  
**What do I do now?**
  
Implementation patterns:
  
- A clear **primary CTA** per stage
- A “Next step” section or inline nudge near the action area
- Don’t bury the next step below long content
  
### 2) Success must reveal the result immediately
After a successful action, the UI must:
  
- reveal the **result** (created entity, updated status, generated output)
- reveal **share / download / continue**
- move **focus** (auto scroll, anchor jump, highlight, or opening a result panel)
  
Must not require:
  
- scrolling to another section to find output
- “go back” navigation to discover what changed
  
### 3) Missing requirements should appear before failure
Do not let the user click a CTA and then get a generic error for something predictable.
  
Instead, pre‑surface:
  
- what is missing
- why it matters
- how to fix it (with a direct CTA)
  
### 4) Closed/completed entities must change available actions
If an entity moved stage (e.g., Quote converted, Invoice issued, Purchase approved, Task closed):
  
- old actions disappear or become disabled with an explicit reason
- new, relevant actions appear for the new stage
  
### 5) Scroll should feel intentional
Avoid long pages where the primary action/result is far away.
  
Prefer:
  
- sticky action bars
- progressive reveal of sections
- auto focus / anchor transitions after success
  
### 6) The system should guide, not just render data
Every screen should behave like a workflow guide, not a “data dump”.
  
---
  
## Anti‑goals (avoid)
This rule does **not** mean:
  
- wizard everywhere
- popup overload
- excessive animations
- forced flows
  
We want **friction reduction**, not new complexity.
  
---
  
## Working method for any new/changed screen (required)
For each feature/screen/flow, map:
  
1. What stage is the user in **now**
2. What the user is trying to achieve
3. The next step the user needs to take
4. What happens after success (where does the result appear)
5. What is missing to proceed (requirements, prerequisites)
6. Which actions are no longer relevant (closed/completed states)
  
Deliverables (minimum):
  
- a stage list (2–7 stages)
- a per‑stage: primary CTA + success outcome + next step
  
---
  
## Definition of Done (system‑wide)
A screen is **not done** if:
  
- the user must search for a CTA
- the user must infer the next step
- success does not reveal the result immediately
- there is unnecessary scroll/friction
- the entity is in a new stage but old actions still appear
- missing requirements are discovered only after failure
  
---
  
## Quick per‑screen checklist (copy/paste)
- [ ] I can name the **current stage** from server state
- [ ] I can name the **next stage**
- [ ] There is exactly one **primary CTA** for this stage
- [ ] After success, the **result is revealed immediately**
- [ ] After success, user sees **share/download/continue**
- [ ] Missing requirements are **visible before** the CTA is clickable
- [ ] Closed/completed entities **hide irrelevant actions**
- [ ] Scrolling is intentional (sticky actions / focus / progressive sections)
  
