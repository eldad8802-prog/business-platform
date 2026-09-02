# Observability / Program P0 — salvage decision

**Status:** decision recorded · **Date:** 2026-09-03 · **Verdict:** *salvage the
concept, reimplement later — do not merge the code as-is.*

## Why this document exists

The abandoned `feat/corporate-marketing-warm-alignment` branch carried a complete,
tested `lib/observability/` module — **1,724 lines across 9 files**, of which 737
lines were verification tests — that exists nowhere in `main`. The branch is being
deleted. This document is the decision about that code, so the reasoning is not
lost with it.

**The code itself was deliberately NOT copied into `main`.** Carrying 1,724 lines
of unwired code into the repository purely to preserve it would add a second
observability authority that nothing calls and that the next engineer would have
to evaluate from scratch. The design documents are archived instead — see
[`archive/dubiz-program-p0-runtime-truth-design-v1.md`](archive/dubiz-program-p0-runtime-truth-design-v1.md)
and [`archive/dubiz-program-p0-work-packages-v1.md`](archive/dubiz-program-p0-work-packages-v1.md),
which specify all 12 P0 packages in full.

## What was built

Program P0 · *Runtime Truth* · Capability INF-01 · gaps B15 / X17 / C3. Its
defining sentence: **"P0 adds no capability to the system. It gives the system the
ability to know its own state."** Twelve packages were specified; three were built.

| Package | What it is | Verdict |
|---|---|---|
| **P0-01 · Signal Context** | The signal envelope: version, severity, environment, actor, operation, plus a pure validator. No I/O, no env reads, no dependency on anything in the codebase. | **CONCEPT RETAINED** |
| **P0-03 · Logger + Redaction** | One emitter, so every signal carries the P0-01 envelope. Three invariants: never throws, kill-switch (`OBSERVABILITY_SIGNALS`), and a four-layer redaction guard enforcing *"a runtime signal carries IDENTIFIERS and METADATA, never CONTENT."* | **CONCEPT RETAINED** |
| **P0-04 · Request Context** | `AsyncLocalStorage` propagation so the logger does not have to be hand-fed an envelope at every call site. | **DO NOT RESTORE AS-IS** |
| P0-02, P0-05 – P0-12 | Config schema, server/client error capture, health, alert routing, telemetry, restore drill. | Never built |

## The binding constraints for a future implementation

1. **P0-01 and P0-03 are still unsolved on `main` and still worth building.**
   `main` has **409 `console.*` call sites**, no structured logger, and no
   redaction guard. The envelope-plus-emitter design is sound and dependency-free;
   it can be reimplemented close to the original.

2. **P0-04 must NOT be restored as written.** It predates D2. `main` now has
   `lib/tenant/context.ts` (D2 / P5-1) — an `AsyncLocalStorage` tenant-context
   primitive that is fail-closed and **already load-bearing in production** under
   the RLS programme, plus `lib/tenant/job.ts` for background work. Introducing a
   second, parallel `AsyncLocalStorage` store for observability would duplicate
   the mechanism and create two independent notions of "the current execution".

3. **Build on `lib/tenant/context.ts`. Do not create a parallel
   `AsyncLocalStorage`.** A future request-context package should extend or
   compose with the existing tenant context, not run beside it.

4. **The external sink was never implemented.** P0-05 owns the sink definition
   exclusively, precisely so it is never built twice. Until it exists, any logger
   writes to the process stream — the same destination the existing `console.*`
   calls already reach. A logger without P0-05 changes *shape*, not destination;
   that is fine as a first step, but it is not "we have observability".

5. **Two claims in the original code need re-verification before reuse.** The
   P0-04 header asserts *"the repo declares `runtime = nodejs` in 45 places and
   edge runtime in ZERO"* and P0-03 counts *"437 existing `console.*` calls"*.
   Both were measured in August 2026 against a branch that is now 133 commits
   behind. The `console.*` count on `main` today is 409. Re-measure; do not
   inherit the numbers.

## Why the module had zero consumers

Not neglect — design. Its own documentation states: *"NOT a migration. The 437
existing `console.*` calls are untouched. New code is born correct; old code moves
when it is touched for other reasons."* It was substrate for packages that never
arrived (P0-05 sink, P0-07 health, P0-08 alert routing), built on a branch that
was never merged. Wiring it would have meant wrapping 100+ route handlers by hand,
because the design explicitly refuses to introduce `middleware.ts` (*"Gap H3
belongs to P1"*).

## Where the code is, if it is ever wanted verbatim

The 9 files and the three `verify:*` npm script lines are in the offline salvage
snapshot taken before the branch was deleted:
`c:\dev\dubiz-salvage-2026-09-02\observability\`, alongside
`corporate-branch.bundle` and the working-tree archive. That snapshot is **local
and not backed up** — anyone relying on it should copy it somewhere durable first.
