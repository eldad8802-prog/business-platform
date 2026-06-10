# Phase 1 / T2 Readiness — Close KL-1 / KL-2

> Short readiness decision before T2 (backfill). Closes the two T1 known
> limitations so **every subject gets a lookup-able Party without polluting
> signal resolution**.
>
> **Not in this doc:** running a migration, running backfill, runtime wiring,
> intake/Billing changes. This is the decision + the minimal shape it implies.

## The problem (recap)

`lookupPartyForRoleRow` resolves a subject *through its active claims*.
A subject with **no strong signal** (KL-1, name-only) or a **signal conflict**
(KL-2, after the T1 fix) is anchored to a `Party` with **zero claims** → its
`Party` exists but is **not reachable** from the role-row.

Constraint: the fix must NOT write a phone/taxId claim for these subjects —
that would re-map a signal value to a second Party and pollute
`findCandidatePartyBySignalTx`.

## Decision

> ## ✅ Anchor claim without signal — NOT a separate claim type / table.

A subject↔Party link with **no signal basis** is represented as a regular
`PartyResolutionClaim` with a **null signal** and an explicit anchor method.

**Why this, not a separate ownership record (Option B):**
- The claim *already is* the corrigible subject↔Party link; the signal is only
  its *basis*. A basis-less claim is the faithful representation of "exists
  without identity" (ER §3.2) — no new concept.
- **One source of truth** for subject↔Party stays in one table; a separate
  ownership table would split link from evidence and create a second place that
  must agree on the subject's Party.
- **No pollution, structurally:** candidate lookup filters on a concrete
  `signalType`, so null-signal anchors are invisible to it — pollution is
  impossible by construction, not by convention.
- **Minimal & additive:** relax two columns on the (new, unreleased) claim
  table + one enum value. Zero touch to existing tables.

## Minimal shape (what T2 implements — not run here)

**Schema (additive, on the new `PartyResolutionClaim` only):**
- `signalType` → nullable (`PartySignalType?`)
- `signalValue` → nullable (`String?`)
- `PartyResolutionMethod` += `SELF_ANCHOR`
- A **new additive migration** (CREATE/ALTER on the new table only). *Not run in
  readiness.* (Folds cleanly with the unapplied T1 migration.)

**Service:**
- No-signal subject (today `SINGLETON`, 0 claims) → singleton Party **+ one
  anchor claim** `{ signalType: null, signalValue: null, method: SELF_ANCHOR,
  confidence: KNOWN, status: ACTIVE }`.
- Conflict subject (today isolated Party, 0 claims) → isolated Party **+ one
  anchor claim** (same shape).
- `findCandidatePartyBySignalTx` — **unchanged**; queries a concrete
  `signalType` (add a defensive `signalType: { not: null }` if desired). Anchors
  never match → never returned as a candidate.
- `lookupPartyForRoleRow` — **unchanged**; now finds the anchor claim → the
  previously-zero-claim subjects become readable.

**Confidence note:** anchor `confidence = KNOWN` means *the ownership is
certain* (the subject trivially belongs to its own singleton). It says nothing
about broader identity — that is precisely what the *absence of signal claims*
encodes. (Tunable; KNOWN is the recommended default.)

## What this closes

| Item | After anchor claim |
|---|---|
| **KL-1** no-signal not lookup-able | ✅ anchor claim → lookup-able |
| **KL-2** conflict not lookup-able | ✅ anchor claim → lookup-able |
| Totality (every subject → readable Party) | ✅ every subject has ≥1 active claim |
| No signal pollution | ✅ null-signal anchors invisible to candidate lookup |

## Corrigible upgrade path (T3 runtime, not T2)

If a strong signal later appears for an anchored subject and matches/forms a
signal-bearing Party, the anchor is **retracted** and a signal claim created —
a corrigible upgrade from "unidentified" to "identified". **Not needed for T2
backfill** (each subject is processed once: it has signals → signal claims, or
none → one anchor). Noted so the runtime wiring (T3) handles it.

## Test additions for T2 (conceptual)

- No-signal subject → `lookupPartyForRoleRow` returns its Party.
- Conflict subject → `lookupPartyForRoleRow` returns its Party.
- A later subject with a real signal is **not** matched to an anchor
  (no candidate pollution).
- (T3) anchored subject gains a strong signal → re-resolves off the anchor.

## Readiness call

> **READY to implement the anchor-claim closure, then design T2 backfill.**
> Decision made (anchor claim, not separate type); shape is minimal and additive;
> closes KL-1/KL-2 with no pollution by construction.
>
> **Sequence:** (1) implement anchor-claim shape + new additive migration
> (not run) + unit tests; (2) re-run T1 suite green; (3) design T2 backfill on
> top. No migration/backfill executed until explicitly approved.
