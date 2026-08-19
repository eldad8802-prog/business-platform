# Dubiz Development Constitution v1.1 (WP7)

> **Constitution Status:** `Ratified` (ratified 2026-07-02 per WP9 GOV-1) · **Version:** v1.1 · **Effective Date:** upon ratification
> **Legacy Scope:** the gate applies to **new/changed** PRs from the Effective Date (WP9 §10); it does not retroactively re-review merged history.
> **New Development Scope:** every in-scope PR from the Effective Date.
> Shared machinery in **WP9 §9–§14**.

**Date:** 2026-07-02 (v1.1)
**Depends on:** [compliance-constitution-system-audit-v1.md](compliance-constitution-system-audit-v1.md) (finding G-15), [governance-constitution-v1.md](governance-constitution-v1.md) (WP9 shared machinery), [compliance-constitution-review-ratification-report-v1.md](compliance-constitution-review-ratification-report-v1.md)
**Governs:** the development process itself — the mechanism that keeps every other constitution enforced.
**Normative language:** MUST / MUST NOT / SHOULD / MAY per RFC 2119.

---

## 1. Purpose (מטרה)

To make compliance **part of development, not an audit after it**. This constitution defines the mandatory verification every change MUST pass before it is considered complete, so that no new feature accumulates accessibility, privacy, security, legal, or regulatory debt. It is the enforcement layer for WP1–WP6 and WP8–WP9.

Root cause it addresses: audit finding **G-15** — strong but scattered governance with **no per-PR compliance gate**, which is the mechanism by which drift accumulates.

## 2. Scope

Applies to **every** Pull Request that changes product behavior: application code, API endpoints, screens, database schema/migrations, integrations, AI capabilities, infrastructure/config, and public-website content. Applies to human- and agent-authored changes equally. Documentation-only PRs are exempt from the code gates but MUST still satisfy the Documentation Constitution (WP8).

## 3. Principles

- **DEV-P1 Compliance is a definition-of-done, not a phase.** "Works" is necessary but not sufficient; a change is done only when it is compliant.
- **DEV-P2 The reviews are inherited, not reinvented.** Each review references its owning constitution as the source of truth; this document does not restate their rules.
- **DEV-P3 Evidence over assertion.** A review is passed by pointing to what was checked, not by claiming "N/A" without reason.
- **DEV-P4 No silent gaps.** A gap that cannot be closed in-PR is tracked with an owner and a target — never shipped invisibly (consistent with `docs/dubiz-product-decisions-v1.md` honesty rulings and the Accessibility A-1 rule).
- **DEV-P5 Least surprise for the reviewer.** The PR states which surfaces it touches and which constitutions therefore apply.

## 4. Mandatory Requirements

### 4.1 The compliance checklist (every applicable PR)

Each PR description MUST include a **Compliance Verification** block. For each review, the author MUST state one of: `Pass` (with what was checked), `N/A` (with a one-line reason), or `Tracked gap` (with owner + issue link).

- **DEV-1 Accessibility Review** — required when the PR touches UI. Source of truth: [accessibility-constitution-v1.md](accessibility-constitution-v1.md) §7 DoD. MUST confirm `eslint-plugin-jsx-a11y` passes and the a11y DoD items apply.
- **DEV-2 Privacy Review** — required when the PR touches personal data (collect/store/derive/share). Source of truth: [privacy-constitution-v1.md](privacy-constitution-v1.md) §10 DoD (the seven questions, inventory + data-flow updates).
- **DEV-3 Security Review** — required when the PR touches auth, authorization, secrets, encryption, integrations, file handling, or endpoints. Source of truth: [security-constitution-v1.md](security-constitution-v1.md) DoD, which governs the existing `security-*` planning docs.
- **DEV-4 Legal Review** — required when the PR changes user-facing data handling, payment/subscription terms, disclosures, or public-website copy. Source of truth: WP4 Legal Constitution.
- **DEV-5 Compliance Review** — required when the PR touches a regulated domain (tax/billing, payments, a third-party platform obligation, or an OAuth scope). Source of truth: WP5 Compliance Constitution and the domain rules already frozen in AGENTS.md (billing/tax, payment-secretary).

### 4.2 Automated gates (CI — blocking)

- **DEV-6** CI MUST run and block on: type-check, lint (including `eslint-plugin-jsx-a11y` once WP1 R-2 lands), and the existing test suite.
- **DEV-7** Secrets MUST NOT be introduced into source or committed config. CI SHOULD run secret-scanning; `.env*` MUST remain git-ignored (audit G-1).
- **DEV-8** Database changes MUST be **expand-only / backward-compatible** migrations per the ratified release pipeline (`docs/dubiz-production-release-pipeline-v1.md`, `docs/production-migration-runbook.md`). Destructive migrations MUST follow the documented multi-phase expand→migrate→contract process.

### 4.3 Domain-specific non-negotiables (already binding via AGENTS.md — restated as gates)

- **DEV-9** Billing/invoices changes MUST comply with the frozen billing-compliance family (AGENTS.md). MUST NOT mutate issued invoices, weaken numbering, or bypass auditability.
- **DEV-10** Payment-Secretary / Business-Obligation changes MUST comply with that canonical family (AGENTS.md); MUST NOT create a new financial source of truth.
- **DEV-11** Secretary behavior changes MUST conform to `docs/dubiz-secretary-behavior-model-v1.md`.
- **DEV-12** UI/flow changes MUST conform to `docs/system-wide-ux-stage-aware-product-flow.md` and the Frame/Archetype/Visual-Language family.

### 4.4 Mechanizable vs Judgement enforcement *(added v1.1; resolves Review M-6)*

The Review found the gate is largely **self-attested prose**. To make it real, every requirement's enforcement (per its constitution's matrix, WP9 §12) falls into one of two buckets, and this constitution treats them differently:

- **DEV-13 Mechanizable gates (CI/Linter/schema-check) — MUST be automated, not attested.** Concretely mechanizable now or on a short horizon: `eslint-plugin-jsx-a11y` (WP1 A-16), secret-scan (SEC-8), expand-only migration check (DEV-8), "no new PII table without an inventory entry" (schema-diff vs WP2 §4), "no direct LLM call outside a gated service" (lint, WP6 AI-4), "customer-PII-to-LLM" scrubber test (WP6 AI-2), security-header presence (SEC-18). These MUST become CI/lint rules during implementation; while a given check is unbuilt, its requirement is `Phase-in Required` and the gap is tracked (not silently "passed").
- **DEV-14 Judgement reviews — MUST carry a rubric, not a bare checkbox.** Requirements that cannot be machine-decided (e.g. "is this the right lawful basis", "is this AI output consequential") remain human reviews (DEV-1…DEV-5) but each MUST reference a short rubric in its owning constitution so the reviewer evaluates against criteria, not vibes. A `Pass` MUST cite what was checked; an unexplained `Pass`/`N/A` is not acceptable (DEV-V1).
- **DEV-15 Honesty of the gate.** The PR template MUST visually separate "automated (green/red)" from "human-attested (rubric)" so no one mistakes a prose checkbox for a mechanical guarantee. This directly answers the Review finding that the anti-drift mechanism was overstated as enforcement.

## 5. Definition of Done (development) — a change is NOT complete without

1. The **Compliance Verification** block present, with an explicit status for every applicable review (DEV-1…DEV-5).
2. All automated gates green (DEV-6…DEV-8).
3. Every applicable domain non-negotiable satisfied (DEV-9…DEV-12).
4. Any gap that could not be closed is a **tracked** item with owner + target (DEV-P4), and also recorded in the System Audit if it is a new compliance gap.
5. Documentation updated per WP8 where behavior or architecture changed.

## 6. Verification / Audit

- **DEV-V1** A PR MUST NOT be merged if any applicable review is blank or unjustified. The reviewer verifies the block, not just the code.
- **DEV-V2** The set of mandatory reviews SHOULD be encoded as a PR template so it cannot be forgotten (remediation item below).
- **DEV-V3** Periodic sampling of merged PRs (cadence owned by WP9 Governance) confirms the gate is being honored, not rubber-stamped.

## 7. Remediation Guidance

Ordered by leverage:
1. Add a **PR template** containing the §4.1 Compliance Verification block (DEV-V2). Highest leverage, lowest cost.
2. Land the `eslint-plugin-jsx-a11y` CI gate (Accessibility R-2) so DEV-1/DEV-6 become enforceable, not advisory.
3. Add secret-scanning to CI (DEV-7) following the G-1 secret rotation.
4. Document the expand-only migration check as an explicit CI/review step (DEV-8).

## 8. Enforcement & Classification Matrix (per WP9 §11–§13)

| Req | Classification | Enforcement | Evidence |
|-----|----------------|-------------|----------|
| DEV-1…DEV-5 review block | Immediately Enforceable | Code Review (PR template) | Architecture Decision |
| DEV-6 typecheck/lint/tests | Immediately Enforceable | CI | Code Verified |
| DEV-7 no secrets / secret-scan | Immediately Enforceable / Phase-in (scanner) | CI + Code Review | Code Verified |
| DEV-8 expand-only migrations | Immediately Enforceable | CI + Code Review | Architecture Decision |
| DEV-9…DEV-12 domain non-negotiables | Immediately Enforceable | Code Review | Architecture Decision (AGENTS.md) |
| DEV-13 mechanizable→automated | Phase-in Required | CI + Linter | Architecture Decision |
| DEV-14 judgement→rubric | Immediately Enforceable | Code Review | Architecture Decision |
| DEV-15 gate honesty (template split) | Phase-in Required (template) | Code Review | Architecture Decision |

## 9. Exception Process

Exceptions follow **WP9 §14**. A PR MUST NOT bypass a mechanizable gate (DEV-13) via self-attestation; skipping an automated gate requires an Exception Register entry with owner + expiry, not a checkbox.

## 10. Future Compatibility

- **Mobile / Public API / Marketplace / Enterprise / Multi-region / Multi-currency / AI Agents:** WP7 is the process layer and is **domain-agnostic** — as each domain's constitution adds requirements, they slot into the DEV-1…DEV-5 reviews and the DEV-13 mechanizable set automatically. The only additions needed per domain: new CI rules (DEV-13) and new review rubrics (DEV-14). No structural change to WP7 anticipated.

## 11. Changelog (v1.1)

- **Added §4.4 (DEV-13/14/15) mechanizable-vs-judgement split** — *why:* the anti-drift gate was self-attested prose; *resolves:* **Review M-6** by separating automated gates from rubric-backed human reviews and requiring template honesty.
- **Added §8 matrix, §9 exception ref, §10 Future Compatibility, Status/legacy-scope header** (WP9 §10/§14).
- **Status → Candidate for Ratification.**

## 12. References (sources of truth — not duplicated here)

- [compliance-constitution-system-audit-v1.md](compliance-constitution-system-audit-v1.md) — current state & gaps.
- [accessibility-constitution-v1.md](accessibility-constitution-v1.md) (WP1), [privacy-constitution-v1.md](privacy-constitution-v1.md) (WP2), [security-constitution-v1.md](security-constitution-v1.md) (WP3), WP4/WP5/WP6/WP8/WP9.
- `AGENTS.md` — billing/tax, payment-secretary, secretary-behavior, UX non-negotiables.
- `docs/dubiz-production-release-pipeline-v1.md`, `docs/production-migration-runbook.md` — release & migration process.
- `docs/dubiz-product-decisions-v1.md` — honesty / no-silent-gap rulings.
