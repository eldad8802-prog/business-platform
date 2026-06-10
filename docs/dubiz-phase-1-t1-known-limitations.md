# Phase 1 / T1 — Known Limitations

> Scope: `lib/services/party/party-resolution.service.ts` (corrigible Party resolution foundation).
>
> **STATUS: KL-1 and KL-2 are RESOLVED (T2 Readiness).** Both are closed by the
> **anchor claim** (`method: SELF_ANCHOR`, `confidence: UNKNOWN`, null signal):
> every subject now gets at least one active claim and is lookup-able via
> role→party, while null-signal anchors stay invisible to candidate resolution
> (no pollution). See `dubiz-phase-1-t2-readiness-v1.md`. The original entries are
> kept below for history.

## KL-1 — Singleton (no-signal) Party is not lookup-able via role→party

A role-row with **no strong signal** (e.g. a name-only Lead) resolves to a fresh
**singleton `Party` with zero `PartyResolutionClaim` rows** (outcome `SINGLETON`).

Because `lookupPartyForRoleRow` resolves a subject *through its active claims*, a
no-signal singleton has no claim and is therefore **not reachable** from the
role-row. The `Party` row exists but the subject↔Party link is not materialized.

- **Why accepted for T1:** nothing consumes the Party graph yet, and the schema
  keeps `signalType`/`signalValue` non-nullable (a claim must carry a basis).
- **T2 follow-up:** decide the representation for "exists without identity"
  (e.g. a basis-less anchor claim, or a nullable-signal claim) so every role-row
  is reachable before backfill makes the graph authoritative.

## KL-2 — Signal-conflict resolution (resolved in T1, noted for awareness)

When a subject's strong signals disagree (phone → Party A, taxId → Party B), the
subject is anchored to its **own isolated `Party`** and **no signal claims are
written** — so the conflicting phone/taxId values are *not* re-mapped to a second
Party and candidate lookup stays clean (verified by tests
`conflict creates no polluting claims` and
`phone signal still resolves to original Party after conflict`).

- **Consequence:** a conflicted subject is anchored but, like KL-1, is not
  lookup-able via its (unwritten) signals. Same T2 follow-up as KL-1.
- **Status:** the earlier index-pollution behavior was **fixed in T1**; this entry
  documents the resulting (safe, under-merged) state.

---

**T2 follow-up ticket (required before backfill):** materialize subject↔Party
linkage for signal-less / conflicted subjects (KL-1, KL-2).
