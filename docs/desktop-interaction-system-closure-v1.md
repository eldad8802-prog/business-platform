# Desktop Interaction System — Closure v1

> This is a **closure record**, not a new roadmap or a planning phase. It documents
> why the Desktop Interaction System (DIS) workstream existed, what was actually
> implemented and proven, and why it is now closed. It creates **no** obligations.
>
> **Evidence base:** `origin/main` at `9f75927` (merge of PR #217). All PR merge
> SHAs cited below were verified present in that lineage at authoring time.

---

## 1. Status

**DIS STATUS: COMPLETE / CLOSED.**

**Closure basis:** the two foundational hypotheses of DIS — that a reusable
**structural** workspace primitive and a reusable **content** primitive can make
Dubiz workspaces genuinely desktop-grade — have both been **demonstrated in
Production** on real consumers.

Closure **does not** mean every Dubiz screen has been converted to every DIS
primitive, nor that all desktop UX work in Dubiz is permanently finished. It means
the foundational approach is proven and no ratified DIS contract requires further
adoption. Additional adoption is optional and demand-driven (see §8–§10).

---

## 2. Original Problem

Dubiz had already achieved adaptive/responsive **framing** (an adaptive app shell,
breakpoint-aware layouts). The remaining problem was not screen width — it was that
several important desktop **workspaces still behaved like mobile interfaces enlarged
onto a desktop canvas**. The founding audit characterized these as **"two-pane
jackets"**: a desktop *shell* wrapped around *phone-shaped content*.

The class of problem included:

- desktop shell around phone-shaped content;
- card-list patterns where a denser desktop presentation was more appropriate;
- duplicated per-screen structural (master/detail) behavior;
- inconsistent master/detail behavior across screens;
- money presentation implemented independently per feature;
- the risk of fixing each screen separately instead of creating **reusable
  interaction contracts**.

DIS was intended to fix the **content/interaction system** — not merely to add
desktop breakpoints.

---

## 3. Objective

Establish reusable interaction/layout and content **primitives** that let Dubiz
workspaces become genuinely desktop-grade while **preserving mobile behavior** and
avoiding per-screen duplication.

The system was intended to support:

- an adaptive shell;
- reusable workspace structure (list ↔ detail, split/shared);
- reusable dense content presentation (tables);
- financial/money-aware presentation;
- URL/history-compatible interaction;
- RTL;
- accessibility;
- **progressive adoption** rather than wholesale rewrites.

(No requirements beyond those actually established during the workstream are claimed
here.)

---

## 4. Architectural Model

The architecture that emerged, conceptually:

```
Design System v1
  ↓
Interaction / layout contracts
  ↓
Shared primitives
  ↓
Feature configuration / composition
  ↓
Screens
```

Relevant primitives and their roles (all present on `origin/main`):

### WorkspaceLayout — `components/ui/workspace-layout.tsx`
Generic structural workspace primitive: two cleanly-separable regions (fixed-width
`start` + flexible `end`), a consumer-selected breakpoint, `switch` collapse
behavior, and a `shared`/`split` scroll model. Presentational; owns no data, route,
selection, or breakpoint decision.
Proven through **two** materially different consumers:
- **Customers** — `switch` + `shared` scroll;
- **Inbox** — `switch` + `split` scroll.

### MasterDetailLayout — `components/ui/master-detail-layout.tsx`
Earlier structural list↔detail primitive (shared scroll), still used by **Payments**.
It remains valid, working code. Its continued existence **does not keep DIS open**
and it is **not** marked deprecated by this document.

### DataTable — `components/ui/data-table/data-table.tsx`
Generic, presentational dense-data primitive (native `<table>`, declarative columns,
RTL, in-cell accessible row-open; no sorting/selection/keyboard-grid/sticky/grouping
/state). First Production consumer: **Documents inbox**.

### MoneyCell / formatMoney — `components/ui/money-cell.tsx`, `lib/ui/money.ts`
Shared money **presentation** semantics (he-IL, `maximumFractionDigits: 2`, `null → "—"`,
tabular numerals, RTL-safe) introduced with DataTable adoption. Presentation only —
no financial calculation. First consumer: Documents inbox.

### EmptySelection — `components/ui/empty-selection.tsx`
Pre-existing shared empty-selection primitive used by list↔detail surfaces.

(No primitives or contracts beyond those present in the repository are claimed.)

---

## 5. Delivery / Evidence Timeline

Merged lineage on `main`, chronological (PR — purpose — merge SHA, all verified in
lineage):

| PR | Purpose | Merge SHA |
|----|---------|-----------|
| #152 | Adaptive App Shell (mobile bottom-bar / tablet rail / desktop sidebar) | `141200d` |
| #153 | Payments adaptive Master–Detail (introduced MasterDetailLayout) | `56f02c4` |
| #154 | Customers adaptive Master–Detail | `1c61346` |
| #158 | Customers adopt WorkspaceLayout (structural primitive introduced) | `00e3bd3` |
| #162 | Inbox navigation prerequisite (single URL source of truth) | `d1733c0` |
| #173 | Inbox URL prerequisite (clear conversation URL via native history) | `4cb345d` |
| #210 | **Artifact B** — Inbox adopts WorkspaceLayout `switch+split` | `c61ff1a` |
| #217 | **Artifact C** — DataTable + MoneyCell/formatMoney + Documents inbox adoption | `9f75927` |

**#210 and #217** each additionally received, in sequence: implementation
verification (types/lint/build), **Browser QA**, **Preview** verification,
**Production** deployment verification, and post-merge **cleanup/closure**.

(No evidence is claimed for the earlier PRs beyond what the repository history
supports: each is a merged commit in the current `main` lineage.)

---

## 6. What Has Been Proven

### Structural — PROVEN
WorkspaceLayout is demonstrated by **two materially different consumers**:
- **Customers** (route-layout host, `shared` scroll);
- **Inbox** (in-page composition, `split` scroll, dual CSS-toggled surfaces).

This proves reusable structural behavior across genuinely different workspace needs
— not a single-screen abstraction.

### Content — PROVEN (one runtime consumer)
DataTable + MoneyCell/formatMoney run in Production via the **Documents inbox**.
Artifact C's validation demonstrated, among other things:
- desktop dense table presentation;
- mobile card presentation preserved;
- a single `min-width: 1024px` responsive boundary (no fractional dead zone);
- money-format **parity** with the prior formatter;
- null vendor/category/amount fallbacks;
- long-vendor truncation without horizontal overflow;
- row-open navigation to the existing review route;
- keyboard/screen-reader accessible row-open;
- page-owned vertical scrolling (no nested/double scroll);
- native table semantics;
- zero Artifact-C-originated runtime/console errors during QA.

**Evidence boundary (fact):** DataTable currently has **one** runtime consumer
(Documents inbox). This document does **not** claim two runtime consumers. The
content-primitive contract was additionally *paper-validated* against Inventory at
design time, but that is a design-level validation, not a second runtime adoption.

---

## 7. Closure Decision

*(Normative.)*

**DIS is CLOSED.** Rationale:

1. The adaptive shell exists (#152).
2. A reusable **structural** primitive (WorkspaceLayout) is demonstrated across two
   diverse consumers (Customers, Inbox).
3. A reusable desktop **content** primitive (DataTable + MoneyCell) is implemented
   and demonstrated in Production (Documents inbox).
4. Mobile behavior was **preserved**, not replaced.
5. The approach moved Dubiz beyond screen-specific desktop patches toward reusable
   interaction contracts.
6. No ratified DIS contract requires universal adoption or a second DataTable
   runtime consumer.

Therefore additional adoption is **not a prerequisite** for DIS closure.

---

## 8. Explicit Non-Requirements

DIS closure does **NOT** require any of the following. None of these is outstanding
work; none keeps DIS open:

- a second DataTable consumer;
- Inventory DataTable adoption;
- Payments migration from MasterDetailLayout to WorkspaceLayout;
- deletion of MasterDetailLayout;
- universal MoneyCell/formatMoney migration;
- converting every card list into a table;
- bulk-action primitives;
- inline-edit primitives;
- additional keyboard-interaction systems;
- converting every desktop surface;
- achieving primitive uniformity for its own sake.

These may be pursued later **only** when independently justified by product need.

---

## 9. Optional Future Opportunities

Recorded as **optional / demand-driven**, not backlog obligations:

### Inventory DataTable adoption
A potential second DataTable consumer. Worth doing only if Inventory has a concrete
desktop-density / product need (it already has consumer-owned search/sort/filter,
which the primitive intentionally does not own).

### Payments structural consolidation
A potential MasterDetailLayout → WorkspaceLayout migration (would let MasterDetailLayout
be retired). Must be justified separately: Payments/Collection is a **governed
Payment Secretary** surface, so any UX change is subject to that domain's canonical
rules.

### Money presentation consolidation
Additional consumers may migrate to MoneyCell/formatMoney where doing so removes real
duplication or fixes a real inconsistency — not for uniformity alone.

### Future interaction primitives
Bulk actions, inline editing, advanced keyboard behavior, etc. should be introduced
**only** when demanded by an actual workflow.

**Rule:** *Primitive existence is not sufficient justification for adoption.*

---

## 10. Anti-Drift Rule

*(Normative.)*

DIS must **not** be reopened merely because:

- another screen *could* use DataTable;
- another formatter *could* use MoneyCell;
- another workspace *could* use WorkspaceLayout;
- two primitives overlap;
- consistency *could* theoretically be increased.

Any future change in this area must state an **independent** product / UX /
maintenance problem it solves. *"Use the primitive because it exists"* is not
sufficient justification.

---

## 11. Known Evidence Limitation

**No original ratified DIS architecture / Definition-of-Done document was found on
`main`.** The closure definition in this record was therefore **reconstructed** from:

- repository history and merged implementation lineage;
- the primitive contracts (code + doc-comments);
- the validated Artifact B / Artifact C evidence (QA, Preview, Production);
- the strategic checkpoints taken during the workstream.

This document does **not** claim to be the original specification. It records the
**final reconstructed source of truth and the closure decision**. Readers should
distinguish:

- **FACT** — the repository state and merged lineage cited above;
- **RECONSTRUCTED CLOSURE DECISION** — §7, §8, §10 (a judgment, made from that
  evidence, that the original objective is met);
- **OPTIONAL FUTURE WORK** — §9 (never required for closure).

---

## 12. Final State

```
DIS: COMPLETE / CLOSED

Structural foundation:  PROVEN IN PRODUCTION
Content foundation:     PROVEN IN PRODUCTION (one runtime consumer)

WorkspaceLayout:        Customers + Inbox
MasterDetailLayout:     Payments (valid existing code; not deprecated)
DataTable:              Documents inbox
MoneyCell / formatMoney: Documents inbox

Additional adoption:    OPTIONAL / DEMAND-DRIVEN
Next DIS artifact:      NONE
```
