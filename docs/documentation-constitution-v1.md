# Dubiz Documentation Constitution v1.1 (WP8)

> **Constitution Status:** `Ratified` (ratified 2026-07-02 per WP9 GOV-1) · **Version:** v1.1 · **Effective Date:** upon ratification
> **Legacy Scope:** existing docs adopt the naming/version/header conventions on their next substantive edit (WP9 §10).
> **New Development Scope:** all new/edited governance docs from the Effective Date.
> Shared machinery in **WP9 §9–§14**.

**Date:** 2026-07-02 (v1.1)
**Depends on:** [compliance-constitution-system-audit-v1.md](compliance-constitution-system-audit-v1.md), [governance-constitution-v1.md](governance-constitution-v1.md) (WP9 shared machinery), [compliance-constitution-review-ratification-report-v1.md](compliance-constitution-review-ratification-report-v1.md)
**Consistent with:** `AGENTS.md`, `CLAUDE.md`, the existing `docs/` corpus (107 documents)
**Normative language:** MUST / MUST NOT / SHOULD / MAY per RFC 2119.

---

## 1. Purpose (מטרה)

To keep documentation **synchronized with actual system behavior** and to ensure every architectural, integration, regulatory, and compliance decision is durably recorded. Dubiz already has a strong documentation culture; this constitution makes it a **binding requirement** rather than a convention, closing the "documentation drifts from reality" risk.

## 2. Scope

All governance and design documentation under `docs/`, the root `AGENTS.md`/`CLAUDE.md`, and any decision record that affects architecture, data, integrations, compliance, or product behavior. Applies to human- and agent-authored changes.

## 3. Principles

- **DOC-P1 Documentation reflects reality.** A document MUST describe the system as it is, or clearly mark aspirational/planned content as such. Silent drift is prohibited.
- **DOC-P2 Decisions are durable.** Load-bearing decisions are written down, versioned, and referenceable — not held only in chat, PRs, or memory.
- **DOC-P3 One source of truth per topic.** Each domain has a canonical document; others reference it (this is how the whole constitution family already works). No copy-paste forks.
- **DOC-P4 Evidence-first.** Documentation follows the Initiative rule: claims cite code/standard/law/document; unknowns are marked `Unknown — requires legal review` / `Unknown — requires product decision`.
- **DOC-P5 Consistent terminology.** Shared terms (Business Obligation, Receivable, Authority, Party, Financial Truth, Constitution, WP) carry the meaning fixed by their owning documents.

## 4. Mandatory Requirements

- **DOC-1 Architectural decisions** MUST be documented (new or updated `docs/*` doc, or an entry in an existing canonical doc) before or with the implementing change.
- **DOC-2 Integrations** MUST be documented: purpose, data flow, scopes, credential handling, and the owning processor entry (WP5 CMP-11).
- **DOC-3 Regulatory / legal changes** MUST be documented in the owning compliance/privacy/legal constitution and reflected in the System Audit status.
- **DOC-4 Compliance decisions** (including exceptions and tracked gaps) MUST be recorded with owner and rationale (ties to WP9 exception process).
- **DOC-5 Sync obligation:** when behavior changes, the affected canonical document(s) MUST be updated in the **same** change (DEV-DoD WP7 item 5). A PR that changes behavior without updating stale docs is incomplete.
- **DOC-6 Canonical-family integrity:** the load-bearing families named in `AGENTS.md` (billing/tax, payment-secretary/business-obligation, secretary-behavior, UX stage-aware, Visual Language / Frame / Product Decisions) MUST NOT be contradicted by new docs; changes to them are made **in the canonical document first** (existing rule for secretary behavior — generalized here).
- **DOC-7 Naming & discoverability:** governance documents live under `docs/` with descriptive kebab-case names and a `Status`/`Date` header. Constitutions use the `*-constitution-v1.md` convention established by this Initiative.
- **DOC-8 Versioning:** substantive changes bump the document version and note the change (WP9 change management). Superseded docs MUST say what replaced them.
- **DOC-9 Terminology register:** shared terms SHOULD be traceable to the document that defines them; new load-bearing terms MUST be defined in a canonical doc, not left implicit.

## 5. Definition of Done (documentation) — a change is NOT complete without

1. Behavior/architecture change reflected in the canonical doc(s) in the same PR (DOC-5).
2. New integrations/processors documented (DOC-2) and added to WP5 inventory.
3. New compliance decisions/exceptions/gaps recorded (DOC-4) and mirrored in the System Audit.
4. No contradiction introduced against a canonical family (DOC-6).
5. Version/date header updated for substantive edits (DOC-8).
6. Unknowns marked explicitly (DOC-P4).

## 6. Verification / Audit

- **DOC-V1** Documentation currency is checked at the WP9 governance audit cadence: sample canonical docs against current behavior; drift → tracked gap.
- **DOC-V2** Cross-reference integrity: every `[[link]]`/relative link in a governance doc MUST resolve; broken references are defects (this Initiative's consistency pass is the first application).
- **DOC-V3** The System Audit ([compliance-constitution-system-audit-v1.md](compliance-constitution-system-audit-v1.md)) is the single rolling status document and MUST be updated as constitutions and code evolve.

## 7. Remediation Guidance

1. Adopt the `*-constitution-v1.md` + `Status/Date/Depends-on/References` header convention across future governance docs (DOC-7).
2. Add the "docs updated?" item to the PR template (WP7).
3. Establish the terminology register incrementally, starting from terms already defined across the constitution family (DOC-9).

## 8. Enforcement & Classification Matrix (per WP9 §11–§13)

| Req | Classification | Enforcement | Evidence |
|-----|----------------|-------------|----------|
| DOC-1 architectural decisions documented | Immediately Enforceable | Code Review | Architecture Decision |
| DOC-2 integrations documented + processor entry | Immediately Enforceable | Code Review | Architecture Decision |
| DOC-3 regulatory changes documented | Immediately Enforceable | Code Review + Legal Review | Architecture Decision |
| DOC-4 compliance decisions/exceptions recorded | Immediately Enforceable | Manual Audit | Architecture Decision |
| DOC-5 behavior→doc sync in same PR | Immediately Enforceable | Code Review | Architecture Decision |
| DOC-6 canonical-family integrity | Immediately Enforceable | Code Review | Architecture Decision |
| DOC-7 naming/status header convention | Immediately Enforceable (new) / Phase-in (legacy) | Code Review | Code Verified |
| DOC-8 versioning | Immediately Enforceable | Code Review | Architecture Decision |
| DOC-9 terminology register | Phase-in Required | Manual Audit | Assumption |
| DOC-V2 link integrity | Immediately Enforceable | CI (link check) | Code Verified |

## 9. Exception Process

Exceptions follow **WP9 §14**. Shipping behavior without its documentation update (DOC-5) requires an Exception Register entry with owner + expiry — stale docs are not a silent default.

## 10. Future Compatibility

- **All future domains (Mobile, Marketplace, Enterprise, AI Agents, Public API, Multi-region, Multi-currency):** WP8 is domain-agnostic — every new domain's docs inherit DOC-1…DOC-9 unchanged. The terminology register (DOC-9) should expand as each domain introduces load-bearing terms. No structural change anticipated.

## 11. Changelog (v1.1)

- **Added §8 matrix, §9 exception ref, §10 Future Compatibility, Status/legacy-scope header** (WP9 §10/§14). No requirement content changed.
- **Status → Candidate for Ratification.**

## 12. References (sources of truth — not duplicated here)

- `AGENTS.md`, `CLAUDE.md` — root governance and canonical-family declarations.
- [development-constitution-v1.md](development-constitution-v1.md) (WP7 — sync obligation), [governance-constitution-v1.md](governance-constitution-v1.md) (WP9 — versioning/exceptions), [compliance-frameworks-constitution-v1.md](compliance-frameworks-constitution-v1.md) (WP5 — processor inventory).
- [compliance-constitution-system-audit-v1.md](compliance-constitution-system-audit-v1.md) — rolling status.
