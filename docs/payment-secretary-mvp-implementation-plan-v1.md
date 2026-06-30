# Payment Secretary MVP — Implementation Plan v1

> **Type:** Implementation plan (Product → Engineering handoff). Inherits and
> does not reopen the frozen canon: Product Spec, UX Blueprint, Business
> Obligation Domain, Integration Model, Secretary Behavior Model, and the
> AGENTS.md guards.
> **Optimize for:** shipping the smallest version that proves the core promise —
> not architectural elegance.
>
> **The promise this MVP must deliver:**
> *"From the moment I register an obligation, someone remembers it for me until
> it is closed."*

Every scope decision below was filtered through one question: *is this required
for the first version that proves the value?* If no, it is in §7 (Deferred).

---

## 1. MVP Scope

### Exists in version one
1. **Hand off an obligation (manual capture).** The owner tells the secretary
   *who, how much, when* (Obligee, amount, due moment), with optional simple
   recurrence (e.g. monthly). Confirmed with *"From this moment on, I'll remember
   it for you."*
2. **The secretary remembers and watches it.** Each obligation persists with a
   single identity and an operational state, scoped to the business.
3. **The Morning Briefing (conclusion first).** One verdict — **Calm / Busy /
   Critical** — derived by the canonical Morning State rules (Blueprint §0.2),
   then prepared items surfaced **one focus at a time**.
4. **Owner actions on a surfaced obligation:** **confirm handled** (operational
   closure → *Met*, owner-asserted), **postpone** (sets a follow-up), **release**
   (commitment no longer exists → *Released*).
5. **Follow-through & loop closure.** Postponed items resurface once, at the
   right moment. Closed loops are confirmed calmly.
6. **Recurring regeneration.** When a recurring obligation closes, the next
   instance is recognized automatically; the owner never re-enters it.
7. **First-time trust.** Onboarding posture: until the owner affirms the
   recurring backbone, the secretary is **"still settling in"** and never issues a
   global "you're in control."
8. **"What I'm watching" (on demand only).** A calm, grouped view of tracked
   obligations — never the default surface, never a raw table.

### Intentionally does NOT exist yet
- No automatic discovery from Documents / Supplier / Billing / email / OCR / AI.
- No consumption of Payments/bank settlement events — **closure is owner-asserted
  only** (canonical and valid per Domain §9.7).
- No reconciliation/merge across sources (only one source exists: manual).
- No notifications / push / email reminders — the briefing is pull, on open.
- No partial payments, installments, multi-currency, or money movement.
- No Business Brain cross-analysis, no Learning Engines, no cash-flow forecasting.
- No complex recurrence (RRULE-grade); only simple fixed cadence.

---

## 2. Existing Building Blocks (reuse, do not rebuild)

| Need | Reuse | Path |
|---|---|---|
| DB client | Prisma singleton, `businessId` multi-tenancy, `Decimal` money, enums, timestamps | `lib/prisma.ts`; patterns in `prisma/schema.prisma` (e.g. `BillingDocument`, `Task` with `dueDate`/`TaskStatus`) |
| Service structure | Deps-injection pattern (store port + deps), `ValidationError`, best-effort audit | `lib/services/payments/payments.deps.ts`, `lib/services/payments/payment-request.service.ts`, `payments.types.ts` |
| API conventions | `getCurrentUser(req)` → `user.businessId`; `handleError`; serialize `Decimal` as string | `lib/auth.ts`, `lib/handle-error.ts`, `app/api/payments/requests/route.ts`, `app/api/billing/documents/[id]/settlement-state/route.ts` |
| Briefing surface | The **attention / conclusion-first** surface and feed pattern to extend | `app/(shell)/attention/page.tsx`, `app/api/inbox/attention/route.ts`, `components/inbox/PriorityFeedPanel.tsx` + `inbox-priority-feed-shared.ts` |
| Hebrew time/formatting | `formatFeedTime`, `formatWaiting`, snippet/truncation helpers | `components/inbox/inbox-priority-feed-shared.ts` |
| Settlement signal (future) | `FinancialEvent` stream + `ensurePaymentPostedEvent` (already wired on verified PAID) | `lib/services/financial-events/financial-event.service.ts`, `payments.deps.ts` `onVerifiedPaid` |
| Supplier commitment (future source) | `PurchaseOrder` / `PurchaseOrderLine` | `prisma/schema.prisma` |
| Navigation | Add a `(shell)` page + a tab | `app/(shell)/layout.tsx`, `components/navigation/bottom-bar.tsx` |
| Test convention | `verify:*` runnable scripts via `tsx` | `package.json` scripts; `lib/services/integrations/whatsapp/*.verify.test.ts` |

**Integration stance:** the secretary is a coordinator (AGENTS.md guard). It
**reads** from these and **does not** become a second financial source of truth.
For the MVP, the only intake is manual and the only closure signal is the owner.

---

## 3. Required Work (work packages)

Six packages. Each produces visible progress.

**WP1 — Operational core (pure, no infra).**
The heart of the product as a pure function: given the set of obligations and
"now," produce the **Morning State verdict** + the **ordered attention items** +
the **silent set**, exactly per Blueprint §0.2. Plus the obligation types and the
recurrence "next instance" calculation. Fully unit-testable with zero DB.

**WP2 — Persistence.**
A single additive `BusinessObligation` model (operational projection):
`businessId`, Obligee (name), amount (`Decimal`), dueAt, operational state
(WATCHED / NEEDS_ATTENTION / MET / RELEASED / BREACHED), source (`MANUAL`),
recurrence (simple cadence + nullable), followUpAt (nullable), timestamps. Plus a
business-level **orientation** flag (owner affirmed the backbone). Additive
migration only.

**WP3 — Application services (deps pattern).**
`recognize` (create), `update`, `postpone` (set followUpAt), `confirmHandled`
(close Met, owner-asserted), `release`, and `regenerateRecurring` (on close).
Mirror `payments.deps.ts` — a store port + `obligation.deps.ts`. Closure is
idempotent. No direct Prisma in services.

**WP4 — API.**
Under `app/api/obligations/*`: a **briefing** endpoint (GET → verdict + prepared
items + orientation posture), `create`, `update`, and an `action` endpoint
(confirm / postpone / release). Reuse auth + error + Decimal-serialization
conventions.

**WP5 — UI (the morning conversation).**
The Briefing surface (Hero verdict for Calm/Busy/Critical, one-focus-at-a-time),
the **Tell-the-Secretary** capture, the on-demand **What I'm watching**, and the
**onboarding / empty** states. Reuse inbox feed component patterns and tokens.
Plus one navigation entry.

**WP6 — Tests.**
`verify:obligations-state` (WP1 rules: the three states, attention ordering,
recurrence next-instance), and service idempotency/closure tests. Woven in as
each package lands, not at the end.

---

## 4. Dependencies

```
WP1 (pure core) ───────────────┐
   (no dependencies; build first)│
                                 ▼
WP2 (persistence) ──► WP3 (services) ──► WP4 (API) ──► WP5 (UI + nav)
                                 ▲                          ▲
                                 └────────── WP6 (tests) ───┘
                                   (parallel, per package)
```

- **WP1 depends on nothing** — start immediately, in parallel with everything.
- **WP5 (UI) can begin against a stubbed briefing response** before WP4 is wired,
  because the briefing shape comes straight from WP1's output type.
- **WP6** runs alongside each package; WP1's rules are testable on day one.
- The graph is deliberately flat: one model, one service module, one API group,
  one surface.

---

## 5. MVP Sequence (maximize early validation, minimize rework)

1. **WP1 first** — encode the Morning State rules and recurrence as a pure,
   tested function. This locks the most load-bearing, most ambiguity-prone
   decision into code once, and yields the briefing's output shape.
2. **WP2** — the single additive model + orientation flag + migration.
3. **WP3** — services over the store, reusing the deps pattern; closure
   idempotent.
4. **WP4** — the briefing endpoint first (read path = fastest demo), then
   create/action.
5. **WP5** — capture → briefing → actions → onboarding states; wire navigation
   last.
6. **WP6** — finalize the verify scripts and service tests as gates.

Rationale: the read/verdict path is provable earliest (WP1→WP4 briefing→WP5
Hero), so the *feeling* ("it told me I'm in control") can be validated before the
full write surface exists.

---

## 6. Done Criteria

- **WP1:** given fixtures, the function returns the correct state for each
  canonical case — break-today → Critical; multiple-soon/none-today → Busy;
  none-needed → Calm; not-oriented → scoped (never global Calm). Attention items
  come back ordered most-consequential-first. Recurrence yields the correct next
  due moment. All covered by `verify:obligations-state`.
- **WP2:** migration applies cleanly on the dev branch; an obligation round-trips
  with `businessId` scoping; `Decimal` and dates persist without precision loss.
- **WP3:** create/update/postpone/confirm/release behave per Domain lifecycle;
  `confirmHandled` is idempotent; closing a recurring obligation creates exactly
  one next instance; no service touches Prisma directly.
- **WP4:** authenticated request returns a briefing scoped to the business;
  unauthorized → 401; `Decimal` serialized as string; actions change state and
  return the updated briefing.
- **WP5:** opening the surface shows a conclusion first (never a list);
  one-focus-at-a-time holds; capture ends with the handoff confirmation; a
  not-oriented business never sees global "you're in control"; the owner can
  always leave.
- **WP6:** `verify:obligations-state` and service tests pass in CI/local.

> **Definition of MVP done:** an owner can hand off an obligation, see it
> remembered, be told each morning whether they're in control, act on what needs
> them, and have recurring items remembered without re-entry — end to end.

---

## 7. Deferred Items (protect the MVP)

Postponed by design (each is a known §8/Integration future, not a gap):
- Automatic discovery: Documents intake, OCR, email parsing, AI extraction.
- Supplier-commitment-sourced obligations (PurchaseOrder → payable).
- Bank integration (discovery + settlement).
- Settlement-event consumption from Payments (event-verified closure).
- Source reconciliation/merge (manual ↔ canonical) — only needed once a second
  source exists.
- Business Brain cross-analysis / Situations; Learning Engines.
- Notifications / push / scheduled reminders (MVP briefing is pull-on-open).
- Partial payments, installments, multi-currency, money movement.
- Advanced recurrence and calendar-grade scheduling.

When these arrive they integrate as **new signal sources** per the Integration
Model — the coordinator does not change.

---

## 8. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| **Migration against managed Postgres (Neon)** — prod migrations are manual/out-of-band (per project history). | Keep the model **additive-only**; validate on the dev branch first; ship via the established out-of-band migration step before deploy. No destructive changes. |
| **The one undefined product constant: the "near window"** (when an item becomes due-soon). | Define **one named constant** in WP1 (recommend: surfaces within 7 days; Critical = due today or overdue). Single source, not scattered. Tunable later without touching UI. |
| **Drift into a to-do app** (owner-asserted closure feels like reporting to software). | Enforce Behavior Model: closure is **offered, never interrogated**; copy is acknowledgment, not "did you pay?". Reviewed against `dubiz-secretary-behavior-model-v1.md`. |
| **No cron / background worker.** | MVP derives state and follow-ups **at read time** (on open). No scheduler needed; documented as deferred. |
| **Morning State ambiguity creep.** | Already canonically defined (Blueprint §0.2); WP1 encodes it verbatim as one pure function — no re-litigation in UI or API. |
| **Scope creep toward auto-discovery / settlement.** | AGENTS.md guard + §7 deferred list; any such work requires updating the canonical docs first. |

---

## 9. Recommended First Build

**If one developer starts tomorrow morning, build WP1: the pure operational-state
core** — a single tested function:

> `deriveBriefing(obligations, now, config) → { state: Calm | Busy | Critical |
> StillSettlingIn, attention: Obligation[] /* ordered */, watching: Obligation[]
> }`, plus the obligation types and the recurrence next-instance calculation.

**Why first:**
- It is the **product's spine.** The Morning State verdict *is* the secretary's
  identity; getting it exactly right is the difference between a secretary and a
  reminder app.
- It carries **zero infrastructure** — no DB, no API, no auth — so it ships and
  demos on day one and de-risks the single most ambiguity-prone decision before
  any wiring exists.
- **Everything downstream consumes its output type.** The API response shape and
  the UI Hero both derive from it, so building it first lets WP4 and WP5 proceed
  against a stable contract (even stubbed).
- It forces the canonical rules (Blueprint §0.2, §0.3) into code **once**, in a
  fully testable place — exactly where future debate must not reopen.

From there: WP2 (model) → WP3 (services) → WP4 (briefing endpoint) → WP5 (the
morning surface), with WP6 tests woven through.

---

## Appendix — canon respected

- **Coordinator only, no new financial truth** (Domain §2, AGENTS.md): the
  `BusinessObligation` model is an operational projection; closure is operational
  awareness, never accounting.
- **Outbound only** (Domain §6): the business is always the payer; this never
  touches Receivables.
- **Owner-asserted closure is canonical** (Domain §9.7): manual capture +
  owner-confirmed closure is the legitimate MVP, not a stopgap — and the future
  settlement path is already defined (Integration §4) without changing the
  surface (Blueprint §0.5).
- **Behavior** inherited from `dubiz-secretary-behavior-model-v1.md`; **UX** from
  the Blueprint; **states** from §0.2. No product, UX, domain, or integration
  decision is reopened here.
