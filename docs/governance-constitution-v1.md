# Dubiz Governance Constitution v1.2 (WP9)

> **Constitution Status:** `Ratified` (ratified 2026-07-02 per WP9 GOV-1) · **Version:** v1.2 · **Effective Date:** upon ratification (GOV-1)
> **Legacy Scope:** existing governance docs are grandfathered to the naming/versioning rules on their next substantive edit.
> **New Development Scope:** all new/edited governance documents from the Effective Date.
> This document is the **canonical home** for the shared v1.1 machinery (Status lifecycle, Effective-Date model, Classification / Enforcement / Evidence-Quality taxonomies, Exception Process). Every other constitution references §10–§15 here rather than restating them.

**Date:** 2026-07-02 (v1.1)
**Depends on:** [compliance-constitution-system-audit-v1.md](compliance-constitution-system-audit-v1.md), [compliance-constitution-review-ratification-report-v1.md](compliance-constitution-review-ratification-report-v1.md)
**Consistent with:** `docs/dubiz-cross-cutting-constitution-v1.md`, `docs/dubiz-release-control-plane-v1-final-ratification.md`, `AGENTS.md`
**Normative language:** MUST / MUST NOT / SHOULD / MAY per RFC 2119.

---

## 1. Purpose (מטרה)

To define **how the constitutional framework itself is governed** — how documents are approved, versioned, changed, and audited, how exceptions are granted, and who owns each domain. This is the meta-constitution that keeps the family (WP1–WP8 + the System Audit) coherent and prevents both drift and unilateral change.

## 2. Scope

The lifecycle of every governance/constitutional document in `docs/`, the amendment of canonical families named in `AGENTS.md`, the exception process for all constitutional requirements, the audit cadence, and ownership assignment. Applies to all contributors, human and agent.

## 3. Principles

- **GOV-P1 Constitutions change only through governance.** No constitutional requirement is silently overridden in code or PR; change flows through this document's process (extends the existing "change canonical doc first" rule in AGENTS.md).
- **GOV-P2 Consistency is preserved.** Every amendment MUST keep code, documentation, and actual behavior consistent (the Initiative's permanent constraint).
- **GOV-P3 Evidence and honesty.** Amendments follow Evidence-First; unresolved points are marked `Unknown — requires legal review` / `Unknown — requires product decision`, never guessed.
- **GOV-P4 Exceptions are explicit, owned, and time-boxed.** A waiver is a tracked decision with rationale, owner, and expiry — never a silent omission (consistent with `dubiz-product-decisions-v1.md` no-silent-gap ruling).
- **GOV-P5 One owner per domain.** Every constitution has a named accountable owner; ambiguity of ownership is itself a governance defect.

## 4. Mandatory Requirements

### 4.1 Approval & ratification
- **GOV-1** A constitution enters force only when **approved by its owner and the initiative sponsor**; until then it is `Draft vN` (as all WP1–WP9 docs currently are). The ratification pattern follows the precedent of `dubiz-release-control-plane-v1-final-ratification.md`.
- **GOV-2** Approval MUST be recorded (status header + change note). "Binding upon approval" means the Draft's requirements are advisory until ratified, then mandatory.

### 4.2 Versioning & change management
- **GOV-3** Documents are versioned (`-v1`, then `v1.1`/`v2`). Substantive changes bump the version and add a dated change note (WP8 DOC-8).
- **GOV-4** A superseding document MUST reference what it replaces; the superseded document MUST point forward. No orphaned or silently-abandoned constitutions.
- **GOV-5** Amending a **canonical family** (billing/tax, payment-secretary, secretary-behavior, UX, Visual Language) MUST be done in that family's canonical document first (AGENTS.md rule), then propagated.

### 4.3 Exceptions
- **GOV-6** An exception to any constitutional requirement MUST be a written decision containing: the rule waived, scope, rationale, compensating controls, owner, and **expiry date**. Open-ended waivers are prohibited (GOV-P4).
- **GOV-7** Every active exception MUST be listed in the System Audit as a tracked gap until it expires or is remediated.

### 4.4 Ownership
- **GOV-8** Each constitution has a named owner accountable for its currency and audits. Suggested mapping (to be confirmed — **Unknown — requires product decision** on named individuals):
  - WP1 Accessibility, WP2 Privacy, WP3 Security, WP4 Legal (with counsel), WP5 Compliance, WP6 AI, WP7 Development, WP8 Documentation, WP9 Governance.
  - Legal text ownership (WP4) and DPO determination (WP2) require counsel.

### 4.5 Periodic compliance audits
- **GOV-9** The System Audit MUST be re-run/refreshed at a defined cadence (**recommended quarterly**, and on any material law/platform-policy change). Each refresh re-classifies every area (Implemented / Partial / Missing / Unknown).
- **GOV-10** Time-driven external obligations MUST be calendared: Google CASA annual re-verification (WP5 CMP-6), any Amendment-13 pen-test/risk-assessment cycle (WP3 SEC-V2), and legal-instrument consistency review (WP4 LEG-V2).

## 5. Definition of Done (governance) — a constitutional change is NOT complete without

1. Version bumped + dated change note (GOV-3).
2. Owner approval recorded (GOV-1/2).
3. Canonical-family precedence respected (GOV-5).
4. Consistency across code/docs/behavior preserved (GOV-P2); System Audit updated.
5. Any exception recorded per GOV-6 and mirrored in the audit (GOV-7).
6. Forward/backward supersession links present where applicable (GOV-4).

## 6. Verification / Audit

- **GOV-V1** At each audit cadence (GOV-9), verify: no contradictions across constitutions, all cross-references resolve, every requirement is verifiable, every DoD is consistent, and every gap appears in the System Audit (this is the standing definition of the Initiative's final consistency pass).
- **GOV-V2** Exceptions are reviewed for expiry; lapsed exceptions become open violations.
- **GOV-V3** Ownership coverage is confirmed (no unowned constitution).

## 7. Remediation Guidance

1. Ratify the Draft family (WP1–WP9 + audit) with named owners (GOV-1/GOV-8).
2. Stand up the exceptions register (GOV-6/7) — even if empty at ratification.
3. Calendar the external time-boxed obligations (GOV-10).
4. Schedule the first quarterly audit refresh (GOV-9).

## 9. Constitution Status lifecycle (canonical)

Every constitution MUST carry a **Constitution Status** in its header, one of:
- **Draft** — under authoring; requirements advisory only; MUST NOT gate development.
- **Candidate for Ratification** — content complete and independently reviewed; awaiting owner sign-off. Requirements are advisory but frozen for review; changes are tracked in a Changelog.
- **Ratified** — approved per GOV-1; requirements binding from the Effective Date, subject to the Effective-Date model (§10).
- **Superseded** — replaced; MUST link forward to its successor (GOV-4).

Transitions: Draft → Candidate → Ratified → (later) Superseded. Downgrading a Ratified constitution requires a governed change (GOV-1/GOV-5).

## 10. Effective-Date model & transition (canonical) — resolves Review C-2

A Ratified constitution binds through three explicit scopes that every constitution MUST state in its header:

- **Effective Date** — the date its requirements begin to bind (default: its ratification date).
- **Legacy Scope** — code/surfaces that existed **before** the Effective Date. **GOV-10a:** existing surfaces are **grandfathered**: a constitution's `Immediately Enforceable` requirements do **not** retroactively mark all pre-existing code non-compliant. Instead, each domain's audit gaps (System Audit §3) become the tracked, scheduled remediation for legacy scope. Legacy code is **not** a mergeable-blocker purely for pre-existing non-compliance.
- **New Development Scope** — any new or **materially changed** code/surface from the Effective Date. **GOV-10b:** `Immediately Enforceable` requirements bind in full here; touching a legacy surface obligates compliance **for the changed code path**, not a rewrite of the whole surface (the "campsite rule"), unless a requirement explicitly says otherwise.

This is the systemic phase-in that prevents ratification from freezing development while still stopping *new* debt. It replaces per-file waivers with a principled legacy/new boundary. No requirement is weakened — its **binding time** is scoped.

- **GOV-10c — current legal duties are NOT grandfathered (resolves Review MAJOR-2).** Grandfathering (GOV-10a) and `Phase-in Required` cover **internal best-practice debt and not-yet-in-force targets only**. A requirement that implements a **current, in-force statutory/regulatory duty** (e.g. Amendment-13 breach notification; ERPD accessibility statement/coordinator; secret hygiene) MUST carry a **mandatory expiration date** recorded in the Exception Register (§14) — it may be phased-in on *timeline* but never left open-ended. Any `Phase-in Required` row whose subject is a current legal duty MUST cite GOV-10c and an expiry. This closes the loophole where a live legal obligation is dressed as an untimed "scheduled build."

## 11. Requirement Classification taxonomy (canonical)

Every requirement in every constitution MUST be classified as exactly one of:
- **Immediately Enforceable** — bindable at the Effective Date for New Development Scope with an existing enforcement path.
- **Phase-in Required** — the principle is binding, but a mechanism/precondition must be built first (carries a target). Not a waiver — a scheduled activation.
- **Future Requirement** — applies only when a future capability/domain arrives (see each doc's Future Compatibility).
- **Legal Review Required** — cannot be finalized without counsel; advisory until resolved.
- **Product Decision Required** — cannot be finalized without an owner product decision; advisory until resolved.

Each constitution expresses these in an **Enforcement & Classification Matrix** (§12 defines the enforcement column; §13 the evidence column). **Ordered compounds are permitted** where a precondition gates activation — written as `A → B` (e.g. `Legal Review Required → Phase-in Required`), meaning "resolve A first, then B binds." This is a single sequenced classification, not two independent ones (resolves Review MINOR-4).

## 12. Enforcement taxonomy (canonical)

Each requirement's enforcement method MUST be one (or more) of: **CI**, **Linter**, **Code Review**, **Manual Audit**, **Product Review**, **Legal Review**, **Security Review** — or explicitly **Not-Mechanically-Enforceable (judgement)** when no automated/procedural check can decide it. A requirement that is Not-Mechanically-Enforceable MUST say so openly and carry a review **rubric** rather than pretend to be a gate (resolves Review M-5/M-6 by honest labeling).

## 13. Evidence-Quality taxonomy (canonical)

Every factual claim / status in a constitution or the audit MUST be tagged with its evidence tier:
- **Code Verified** — confirmed against source (cite file:line).
- **Official Documentation** — vendor/product docs.
- **Legal Source** — statute/regulation/standard text or authoritative legal summary.
- **Regulatory Source** — regulator guidance.
- **Architecture Decision** — a ratified internal decision doc.
- **Assumption** — reasoned but unverified (MUST be flagged, never presented as fact).
- **Unknown** — no evidence; pair with `requires legal review` / `requires product decision`.

## 14. Canonical Exception Process (expands GOV-6/GOV-7)

No constitution exists without this mechanism. Every exception (waiver) to any constitutional requirement MUST be a written record in the **Exception Register** (maintained alongside the System Audit) containing all of:
- **Justification** — why the exception is needed.
- **Owner** — accountable person.
- **Risk** — the compliance/security/legal risk accepted.
- **Expiration Date** — mandatory; open-ended waivers are prohibited (resolves Review M-9).
- **Approval** — who approved (per GOV-1 authority).
- **Tracking** — link to the tracked gap in the System Audit.

An expired exception becomes an open violation (GOV-V2). Exceptions MUST be reviewed at each audit cadence (GOV-9).

## 14a. Freeze-and-implement rule & Constitution Backlog v2 *(added v1.2 — ratified owner decision)*

- **GOV-16 Freeze-and-implement.** After **v1.2**, the constitutional authoring phase is **closed**. The family stops being improved as a writing exercise and becomes the **binding working document**. Continuing to refine the constitution instead of implementing it is itself a governance failure (a document that never ratifies never governs).
- **GOV-17 New gaps go to Backlog v2, not into v1.x.** Any gap, improvement, or good idea discovered **after v1.2** — including during implementation — MUST NOT be patched directly into the constitutions. It is recorded in **[compliance-constitution-backlog-v2.md](compliance-constitution-backlog-v2.md)** and handled later through the normal Governance change process (GOV-1/GOV-3/GOV-5) as a deliberate, versioned amendment. This prevents perpetual-draft paralysis while keeping the door open for evolution.
- **GOV-18 Exception:** the only thing that reopens the constitution *before* Backlog-v2 processing is a **fundamentally new, previously-unknown failure** that makes a ratified requirement unsafe or false — handled as an emergency amendment (GOV-1), not as routine refinement.

## 15. Future Compatibility

- **Mobile / Marketplace / Enterprise / AI Agents / Public API / Multi-region / Multi-currency:** WP9 is domain-agnostic and **already compatible** — it governs *how* constitutions change, not any product domain. Adding governance for any future domain uses §9–§14 unchanged. The one addition needed when those domains arrive is a populated **Future Governance Gap register** (Review report §7) tracked under GOV-9; the three "Conflict" domains (Marketplace, Autonomous AI Agents, Multi-currency) MUST be introduced via an explicit amendment because they touch frozen non-negotiables.

## 16. Enforcement & Classification Matrix (WP9 requirements)

| Req | Classification | Enforcement | Evidence |
|-----|----------------|-------------|----------|
| GOV-1/2 ratification & approval | Immediately Enforceable | Manual Audit (governance) | Architecture Decision |
| GOV-3/4 versioning & supersession | Immediately Enforceable | Code Review + Manual Audit | Architecture Decision |
| GOV-5 canonical-family precedence | Immediately Enforceable | Code Review | Architecture Decision |
| GOV-6/7 + §14 exception process | Immediately Enforceable | Manual Audit | Architecture Decision |
| GOV-8 ownership | Product Decision Required | Product Review | Unknown (named owners) |
| GOV-9 audit cadence | Phase-in Required | Manual Audit | Architecture Decision |
| GOV-10 external time-boxed obligations | Phase-in Required | Manual Audit + Legal Review | Legal/Regulatory Source |
| §9–§13 taxonomies | Immediately Enforceable | Code Review | Architecture Decision |

## 17. Changelog (v1.1)

- **Added §9 Constitution Status lifecycle** — *why:* the Review required an explicit Draft/Candidate/Ratified/Superseded model per doc; *resolves:* the ratification-readiness process gap.
- **Added §10 Effective-Date model & transition** — *why:* ratifying MUSTs would instantly mark all legacy code non-compliant and block development; *resolves:* **Review C-2** (missing grandfathering) systemically, without weakening any requirement (only its binding time is scoped).
- **Added §11 Classification / §12 Enforcement / §13 Evidence-Quality taxonomies** — *why:* the owner requested every requirement be classified and its enforcement + evidence tier made explicit; *resolves:* Review M-5/M-6 (non-measurable / self-attested requirements) via honest labeling.
- **Added §14 Canonical Exception Process** — *why:* every constitution must have an exception mechanism with mandatory expiry; *resolves:* **Review M-9** (untimed tracked gaps) and centralizes the register.
- **Added §15 Future Compatibility, §16 Enforcement Matrix.**
- **(v1.1a) Added GOV-10c** — current legal duties are not grandfathered; mandatory expiry — *resolves:* second-review MAJOR-2. **§11 ordered-compound classifications** — *resolves:* MINOR-4.
- **(v1.2) Added §14a GOV-16/17/18** — freeze-and-implement rule + Constitution Backlog v2 mechanism (owner's strategic decision: after v1.2, stop refining, start implementing; new gaps → Backlog v2 via Governance).
- **Status → Candidate for Ratification (v1.2).**

## 18. References (sources of truth — not duplicated here)

- `docs/dubiz-cross-cutting-constitution-v1.md` — meta-level cross-cutting constraints inherited by all frameworks.
- `docs/dubiz-release-control-plane-v1-final-ratification.md` — ratification precedent.
- `AGENTS.md` — canonical-family declarations and the "change canonical doc first" rule.
- [development-constitution-v1.md](development-constitution-v1.md) (WP7), [documentation-constitution-v1.md](documentation-constitution-v1.md) (WP8), [compliance-constitution-system-audit-v1.md](compliance-constitution-system-audit-v1.md) (rolling status), [compliance-constitution-review-ratification-report-v1.md](compliance-constitution-review-ratification-report-v1.md) (findings this v1.1 resolves).
