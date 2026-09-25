# Business Knowledge Snapshot and cross-domain intelligence (M7)

This is the canonical contract for what Dubiz currently **knows** about **one** business, and for the
deterministic rules that connect knowledge across domains.

The code implements this document:

- Contract: [`lib/knowledge/snapshot/snapshot.contract.ts`](../../lib/knowledge/snapshot/snapshot.contract.ts)
- Governed producers: [`snapshot-sources.ts`](../../lib/knowledge/snapshot/snapshot-sources.ts)
- Assembly: [`assemble.ts`](../../lib/knowledge/snapshot/assemble.ts)
- Cross-domain rules: [`cross-domain.ts`](../../lib/knowledge/snapshot/cross-domain.ts)
- Entry point: [`build-snapshot.ts`](../../lib/knowledge/snapshot/build-snapshot.ts)

## The AI boundary

```
PRODUCT DATABASE
        ↓
DETERMINISTIC LEARNING SYSTEM   facts · claims · measures · temporal knowledge · identity
        ↓
BUSINESS KNOWLEDGE SNAPSHOT     buildBusinessKnowledgeSnapshot(businessId, { asOf?, includeGaps? })
────────────────────────────────  AI boundary: M8 (not built)
```

M8 consumes the snapshot and never the database. It does not need Prisma models and does not
reconstruct business truth. If it needs something the snapshot lacks, the answer is a new governed
knowledge producer here, not SQL access for a model.

## Contract: `BusinessKnowledgeSnapshot` (`bks.v1`)

| Field | Meaning |
|---|---|
| `businessId`, `asOf` | exactly one business; the instant freshness, exposure and windows are judged at |
| `knowledge[]` | typed knowledge items (below), ACTIVE only |
| `relationships[]` | identity relationships between this business's records |
| `crossDomainFindings[]` | deterministic, non-causal combinations of knowledge from several domains |
| `conflicts[]` | disagreements, kept rather than silently resolved |
| `knowledgeGaps[]` | what is not known yet, normalized |
| `snapshotFingerprint` | sha256 of the **semantic** content: no row ids, no volatile timestamps, no stats |
| `stats` | counts, truncations, serialized bytes, largest section, query budget. This is the only part that may be logged. |

**Knowledge item.** Each item carries:

- `slot` (semantic identity), `kind`, `domain`, `subject` (typed id or null), `key`
- `ruleId`, `ruleVersion`, `authority`, `value` (structured, never free text)
- `observationCount`, `window`, `status`, `freshness {ageDays, fresh}`
- `evidence {fingerprint, refCount}`, `caveats[]`, `provenance[]` (store + row id), `conflictIds[]`

**Kinds**, kept distinct: `FACT`, `CLAIM`, `MEASURE`, `BASELINE`, `STABLE_PATTERN`, `TREND`,
`MATERIAL_CHANGE`, `ANOMALY`, `OWNER_DECISION`. Relationships and findings are their own sections, so
they are never flattened into "insights".

## Authority classes

A consumer must be able to tell "the ledger says" from "Dubiz inferred". Classes, strongest first:

| Class | Meaning | Source |
|---|---|---|
| `AUTHORITATIVE_DOMAIN_STATE` | read from the product's own ledgers | L0 facts (installments + allocations, issued documents, stock alerts); awaiting-payment; payables exposure; CollectionAction |
| `OWNER_CONFIRMED` | a person of this business decided it | insight decisions; owner-confirmed identity; the owner's own vendor category |
| `AUTHORITATIVE_IDENTIFIER` | bound by a state-issued identifier | valid tax id (M5 check digit) |
| `KNOWLEDGE_MEASURE` | a governed M2/M4 rule | KnowledgeMeasure |
| `TEMPORAL_DERIVATION` | a governed M6 rule over the business's own history | TemporalKnowledge |
| `DERIVED_CLAIM` | Business Memory's categorical inference (may be contested) | DerivedClaimProjection |
| `CROSS_DOMAIN_DERIVATION` | an M7 rule; never stronger than its premises | findings |
| `MACHINE_PROPOSAL` | a suggestion awaiting a person; **never a premise** | EntityLinkProposal (PROPOSED) |

## What enters the snapshot, and what stays out

| In (governed) | Out |
|---|---|
| ACTIVE KnowledgeMeasure | STALE, SUPERSEDED or reversed rows (kept in storage for audit) |
| ACTIVE TemporalKnowledge | raw evidence rows, OCR or document text, message or email bodies |
| DerivedClaimProjection with its candidates | names, phones, emails, tax ids, free-text notes, titles |
| insight decisions (ADOPTED / DISMISSED) | provider payloads, tokens, error strings |
| identity bound by owner or tax id; proposals as PROPOSED or REJECTED | phone-resemblance bindings (older Party engine, `BELIEVED`) |
| L0 facts, structured fields only (no title or summary) | anything read "because it was convenient" |
| per-customer receivables exposure and per-payee payables exposure, as counts and amounts | |
| INSUFFICIENT results, as gaps | |

A vendor claim's subject is the learned-vendor row id, or an opaque digest of the key; never the
vendor's name. Labels, when a product surface needs them, are a future governed label resolver.

## Knowledge gaps

- INSUFFICIENT measures and temporal artifacts become **gaps**, never knowledge.
- Gaps are normalized to **one per (rule, reason)**, with `subjectsAffected`, the `have` range
  (min–max), `need` and `needSpanDays`. Thirty sparse vendor series make one gap, not thirty.
- A cross-domain rule whose premises are missing states `PREMISE_UNAVAILABLE`.
- Every non-READY family (below) appears as a `RULE_BLOCKED` gap, so "Dubiz cannot know this yet, and
  why" is itself knowledge.

## Deduplication and conflict

**Deduplication.** Items are grouped by semantic slot:

- Same value: one item, all provenances kept. For example, two stored rows with the same measure
  become one item with two references.
- Different values: every side is kept and a `DIVERGENT_SAME_SLOT` conflict is recorded, **UNRESOLVED**.
- Storage is never deduplicated. Only the representation is.

**Conflicts.** Precedence applies **only where authority genuinely exists**:

| Conflict | Resolution |
|---|---|
| `COMPETING_CLAIM_VALUES`: a claim holds several candidate values | UNRESOLVED |
| `MACHINE_VS_OWNER`: a derived category differs from the owner's own category (set at approval) | RESOLVED_BY_AUTHORITY → `OWNER_CONFIRMED`; both sides kept |
| `PROPOSAL_VS_AUTHORITATIVE_IDENTITY`: an open proposal contradicts an owner or tax-id binding | RESOLVED_BY_AUTHORITY → the binding; both kept |
| `DIVERGENT_SAME_SLOT` | UNRESOLVED |

## Relationships and identity

- **ACTIVE** `SAME_COUNTERPARTY` relationships come only from `PartyResolutionClaim` rows that are
  **OWNER_CONFIRMED**, or **DETERMINISTIC_EXACT with a TAX_ID signal**.
  - SELF_ANCHOR rows are excluded.
  - Phone-based bindings from the older Party engine are excluded: resemblance is not identity.
- Proposals appear as `PROPOSED` (`MACHINE_PROPOSAL`) or `REJECTED` (the owner's no). Neither can be
  a premise.
- FK links (invoice → customer, installment → commitment → payee, reminder → customer) are
  authoritative and are used directly by the rules. They are not re-persisted.
- **No merge authority** is granted. An unresolved identity yields a gap, never a guess.

## Cross-domain rules

Derived **at snapshot time** from the current premises. There is no table, and therefore no
migration:

- A finding cannot outlive a reversed, stale or superseded premise; it simply is not produced.
- Each finding lists its premises with authority and store references, so it can be walked back:
  finding → measure / exposure / identity → evidence links → business records.

A premise is usable only if it is ACTIVE and **fresh**: age ≤ 45 days (`PREMISE_MAX_AGE_DAYS`).

### X-COLL-01 v1: `EXPOSURE_WITH_RECORDED_ACTIVITY`

- **Domains:** billing, collections (customers).
- **Premises:**
  - Awaiting-payment: issued, customer-linked invoices past their expected date with a balance
    (`AUTHORITATIVE_DOMAIN_STATE`).
  - CollectionAction, owner-initiated reminders in the last 90 days, joined by the verified `customerId`.
- **Value:** invoices awaiting, max days awaiting, total outstanding, currency, recorded reminders
  (90 days), reminders since the exposure began, and days since the last reminder.
- **Establishes:** an overdue exposure exists and this many reminders are recorded **in Dubiz**.
- **Caveats:**
  - `REMINDERS_OUTSIDE_DUBIZ_NOT_OBSERVED`
  - `A_RECORDED_REMINDER_PROVES_NEITHER_DELIVERY_NOR_EFFECT`
  - `REFUNDS_NOT_NETTED_KNOWN_ACCOUNTING_GAP`
- **Not built:** "payment after reminder". `paidAt` is processing time, and sequence is not effect.

### X-PARTY-01 v1: `LINKED_COUNTERPARTY_CONDITION`

- **Domains:** suppliers, documents, payables.
- **Premises:**
  - An ACTIVE relationship (owner or tax id) binding two or more of the supplier, payee and
    document-vendor records to one Party.
  - Fresh ACTIVE knowledge keyed to those subjects: `supplier:<id>`, `payee:<id>`, `party:<id>`.
  - Open payables exposure to the linked payees.
- **Fires only** when at least two domains are present. Otherwise it records a
  `PREMISE_UNAVAILABLE` gap.
- **Establishes:** these records are one counterparty by authority, and this knowledge about it
  co-occurs across domains.
- **Caveat:** `VOIDED_PAYMENT_DOES_NOT_CASCADE_KNOWN_GAP`.

**Causality.** Neither rule, nor any finding type, asserts a cause, driver or impact. `causal: false`
is fixed, and tests assert that the wording avoids causal language.

## Cross-domain family audit

| Family | Status | Why |
|---|---|---|
| A customer / collections / payments | **READY** (X-COLL-01) | Exposure + recorded reminders. Payment-after-reminder is not built. |
| B supplier / purchasing / payables | **READY** (X-PARTY-01) | Only through authoritative identity. |
| C documents / suppliers / payables | **READY** (X-PARTY-01) | Document knowledge is keyed to a resolved Party. |
| D inventory / purchasing / suppliers | BLOCKED_PRODUCT_DEFECT | INV-05 is corrupted by the POS held-sale defect; restock ↔ receiving is one event, not a relationship. |
| E leads / customers / billing / revenue | BLOCKED_SENSOR | No authoritative lead → paying-customer link. |
| F response / conversations / leads | BLOCKED_SENSOR | `senderType` is client-asserted; first-response has no writer. |
| G cost / obligations / payments | PARTIAL | A commitments list alone is single-domain; its cross-domain half is X-PARTY-01. |
| H document processing / financial operations | NOT_JUSTIFIED | Both sides are documents-domain. |

## Determinism, bounds and performance

- **Deterministic.**
  - Everything is ordered by slot. Row ids are provenance, not semantics.
  - Re-derived rows with new ids give the same fingerprint.
  - L0 facts are evaluated by their own engine at build time. Every other section is judged as of `asOf`.
- **Bounded.**
  - Caps: knowledge 400, relationships 200, findings 100, conflicts 100, gaps 100.
  - Ordering puts business-level items first, then entity-level. Cuts are counted in
    `stats.truncated`, never silent.
  - Evidence is referenced by fingerprint and count, never listed, so years of history do not grow
    the snapshot. The battery proves this with 300 extra historical documents.
- **Queries.**
  - Nine stored-knowledge queries in one tenant transaction, plus the two existing domain engines.
  - The count is fixed and independent of history. There is no N+1 and no cache.
  - Measurement did not justify caching. Any future cache must key on `businessId` first and be
    invalidated by the knowledge fingerprints.

## Owner behavior

The snapshot records only what an owner explicitly did: decisions and confirmations. Silence is not
rejection. It makes no psychological inference (careless, price-sensitive, and the like).

## Out of scope, deliberately

- Recommendations, prioritization and actions.
- LLMs, prompts, embeddings, vector stores and RAG.
- Multi-tenant snapshots or cohorts.

## Production proof status

Recorded at M7 closure. See the closure report.
