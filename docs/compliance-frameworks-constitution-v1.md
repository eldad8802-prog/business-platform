# Dubiz Compliance (Frameworks) Constitution v1.1 (WP5)

> **Constitution Status:** `Ratified` (ratified 2026-07-02 per WP9 GOV-1) · **Version:** v1.2 · **Effective Date:** upon ratification
> **Legacy Scope:** current integrations grandfathered per WP9 §10; G-13/G-17/G-25 are scheduled remediation.
> **New Development Scope:** new regulated-domain work or new scope/processor binds CMP rules in full (§9 matrix).
> Shared machinery in **WP9 §9–§14**. Owner-of-truth per framework stays in the domain constitutions (CMP-P1).

**Date:** 2026-07-02 (v1.1)
**Depends on:** [compliance-constitution-system-audit-v1.md](compliance-constitution-system-audit-v1.md) (findings G-13, §2.8), [governance-constitution-v1.md](governance-constitution-v1.md) (WP9 shared machinery), [compliance-constitution-review-ratification-report-v1.md](compliance-constitution-review-ratification-report-v1.md)
**Consistent with:** billing/tax family in AGENTS.md, [privacy-constitution-v1.md](privacy-constitution-v1.md), [accessibility-constitution-v1.md](accessibility-constitution-v1.md), [security-constitution-v1.md](security-constitution-v1.md)
**Normative language:** MUST / MUST NOT / SHOULD / MAY per RFC 2119.

---

## 1. Purpose (מטרה)

To map every **external regulatory and platform framework** that applies to Dubiz to a single owner-of-truth document, and to classify each obligation as Implemented / Partial / Missing / Not-applicable / Unknown. This constitution is the **regulatory index**; the detailed rules live in their domain constitutions (privacy, accessibility, security, billing/tax) which it references rather than duplicates.

## 2. Scope

All external frameworks that bind Dubiz as a Hebrew-first B2B SaaS operating in Israel and integrating Google, Meta, and payment providers: Israeli Privacy Law, GDPR, Israeli accessibility law, Israeli Tax Authority obligations, Google OAuth/API policies, Meta platform policies, mobile-store policies (conditional), and payment-provider/PCI obligations.

## 3. Principles

- **CMP-P1 Each framework has one owning constitution.** This document indexes; the owner defines. No obligation is governed in two places.
- **CMP-P2 Status is evidence-based.** Every classification cites code, a document, or an external standard. Absence is "Missing" or "Unknown — requires legal review / requires verification," never assumed compliant.
- **CMP-P3 Compliance is verified before "complete."** A regulated-domain change passes the WP7 Compliance Review (DEV-5).
- **CMP-P4 Processors are governed.** Every external data processor MUST be inventoried with purpose, data categories, and DPA status (closes audit G-13).

## 4. Mandatory Requirements — framework mapping

### 4.1 Israeli Protection of Privacy Law (Amendment 13, in force Aug 2025)
- **CMP-1** Owner of truth: **WP2 Privacy Constitution**. Status: **Partial** (policy pages exist; data-subject-rights machinery Missing — G-2…G-6). DPO/large-sensitive-DB obligations: **Unknown — requires legal review**.

### 4.2 GDPR (where EU data subjects involved; else best-practice baseline)
- **CMP-2** Owner: **WP2**. Status: **Partial**. Applicability scope (does Dubiz process EU residents' data?) is **Unknown — requires product/legal decision**.

### 4.3 Israeli accessibility — IS 5568 / ERPD Law
- **CMP-3** Owner: **WP1 Accessibility Constitution**. Legal floor WCAG 2.0 AA; adopted target WCAG 2.2 AA. Status: **Partial** (RTL/tokens present; governance/tooling now defined by WP1 but code remediation pending — G-7/8/9).

### 4.4 Israeli Tax Authority obligations (billing / invoices / SHAAM)
- **CMP-4** Owner of truth: the **frozen billing-compliance family** (AGENTS.md; `billing-compliance-hardening-plan.md`, `billing-authority-shaam-readiness-foundation-plan.md`, `billing-shaam-uniform-file-export-foundation-plan.md`, `docs/compliance/tax-authority/*`). Status: **Uniform export certified against the simulator, not yet registered** (v1.2 — the v1.1 blended "Implemented/Partial" was not evidence-precise; the accurate state is *certified-but-not-registered*, per `uniform-export-certification.md`). This constitution MUST NOT restate or override those rulings.
- **CMP-13 SHAAM production-identity guard (v1.2 — Should-Fix #10; derives from the verified latent incident):** the uniform-export config carries a simulator `isSimulator` flag with **placeholder** vendor identity (`uniform-config.ts:48-61`, Code Verified), but **no code reads it as a guard** (grep: zero guard sites; the certification doc marks the guard "recommended, future"). A production export path MUST **refuse to emit** a uniform file when the active config is simulator/placeholder identity — so a real file is never stamped with `00000001`/`DUBIZ`. `Phase-in Required` (small guard + test). Owner: Billing/Tax. Owns audit **G-25**. This is a *safety* guard, not a new financial rule — it does not restate or override the frozen family (respects CMP-4).

### 4.5 Google OAuth / API policy (restricted scopes) — **verified, load-bearing**
- **CMP-5** Dubiz uses `gmail.readonly`, a **restricted scope**, and **stores** the resulting data on its servers. Per Google policy this **MUST** have: (a) app verification for the restricted scope, and (b) a **CASA security assessment** by a Google-approved assessor — for a restricted scope with server-side storage this is the **higher tier (penetration test)** — with **annual re-verification**.
- **CMP-6** Status: **Unknown — requires verification** of Dubiz's current OAuth app-verification/CASA state. This is a **mandatory external obligation with cost and lead-time**; it MUST be tracked at P1 regardless of current state (see backlog). Failure risks Gmail-integration suspension.
- **CMP-7** Requesting any additional restricted/sensitive Google scope is a governed change (WP9) and re-triggers verification/CASA.

### 4.6 Meta / WhatsApp platform policy
- **CMP-8** Owner of integration truth: `whatsapp-documents-intake-mvp-spec.md` + connection services. Meta requires business verification, app review for messaging permissions, and adherence to the WhatsApp Business data policies. Status: **Partial/Unknown** — the embedded-signup + token handling is Implemented (audit §2.8), but the platform-review/business-verification status is **Unknown — requires verification**.

### 4.7 Apple App Store / Google Play
- **CMP-9** Status: **Not Applicable (current) — Code Verified** (no `react-native`/`expo`/`@capacitor`/`cordova` in `package.json`). **Trigger:** if a mobile app is built, App Store / Play data-safety, privacy-nutrition-label, mandatory account-deletion, and permission-disclosure requirements become mandatory and MUST be added here before submission. Recorded as a conditional `Future Requirement`, not a silent omission.

### 4.8 Payment providers / PCI
- **CMP-10** Owner: `payments-*` family + `security-constitution-v1.md`. Dubiz **never stores card data** (hosted checkout; only `cardLast4`), which places it in the reduced-scope PCI posture (SAQ-A-type) — **exact SAQ classification is Unknown — requires payment-provider/QSA confirmation**. Cardcom uses verified authority (`GetLpResult`); **Tranzila webhook verification MUST be hardened before production** (SEC-14).

### 4.9 Processor / DPA inventory (cross-framework) — **closes G-13**
- **CMP-11** A maintained inventory of all external processors MUST exist: Google (Gmail, Vision), Meta/WhatsApp, OpenAI, Cardcom, Tranzila, Cloudflare R2, Creatomate, Pexels, Neon, Upstash. For each: purpose, data categories, region, retention, and DPA status. New processors MUST be added before first use (WP2 P-9).

### 4.10 Cross-border transfer / data residency *(added v1.1; resolves Review M-2)*
- **CMP-12** Personal data flows to non-Israel processors (OpenAI, Google, Meta, Cloudflare R2, Neon, Upstash, Creatomate, Pexels — regions currently **Unknown — requires verification**). A **transfer-basis + residency rule** MUST be established: each processor's data region MUST be recorded (CMP-11) and the lawful cross-border-transfer basis (Amendment 13 / GDPR Ch. V) confirmed with counsel. `Legal Review Required` + `Phase-in Required`. Registered as audit **G-21**.

## 5. Definition of Done (compliance) — a regulated-domain change is NOT complete without

1. The applicable framework(s) identified and the owning constitution referenced (CMP-P1).
2. Status impact recorded here and, if it creates/closes a gap, in the System Audit.
3. Any new external processor added to the CMP-11 inventory with DPA status.
4. Any new Google/Meta scope or store-submission implication flagged for verification (CMP-5…CMP-9).
5. Tax/billing changes routed to the frozen billing-compliance family, unaltered by this document (CMP-4).

## 6. Verification / Audit

- **CMP-V1** WP7 Compliance Review (DEV-5) is mandatory for regulated-domain PRs.
- **CMP-V2** The framework-mapping table (§4) MUST be re-checked at the governance audit cadence (WP9) and whenever a law/platform-policy change is observed.
- **CMP-V3** Google CASA annual re-verification (CMP-6) and any periodic pen-test obligation (WP3 SEC-V2) MUST be calendared once applicability is confirmed.

## 7. Remediation Guidance (risk order)

1. **P1:** determine Google OAuth app-verification/CASA status for `gmail.readonly` and plan the assessment (CMP-5/6) — external lead-time makes this urgent.
2. Build the processor/DPA inventory (CMP-11 / G-13).
3. Confirm Meta/WhatsApp platform-review status (CMP-8).
4. Legal determinations: GDPR applicability, PCI SAQ class, DPO/large-DB (with WP2/WP3).
5. Record the conditional mobile-store obligations as a standing item (CMP-9).

## 8. Enforcement & Classification Matrix (per WP9 §11–§13)

| Req | Classification | Enforcement | Evidence |
|-----|----------------|-------------|----------|
| CMP-1 IL Privacy (→WP2) | Legal Review Required | Legal Review | Legal Source |
| CMP-2 GDPR applicability | Product Decision Required + Legal Review Required | Legal Review | Unknown |
| CMP-3 accessibility (→WP1) | Immediately Enforceable (new) | Code Review + Manual Audit | Legal Source |
| CMP-4 tax/SHAAM (→billing family) | Immediately Enforceable | Code Review + Manual Audit | Architecture Decision |
| CMP-5/6 Google restricted-scope + CASA | Legal Review Required + Product Decision Required (budget/timing) | Manual Audit + Legal Review | Official Documentation (G-17) |
| CMP-7 new Google scope governance | Immediately Enforceable | Code Review | Official Documentation |
| CMP-8 Meta/WhatsApp platform review | Legal Review Required | Manual Audit | Unknown |
| CMP-9 Apple/Play | Future Requirement | Product Review | Code Verified (none) |
| CMP-10 payments/PCI SAQ | Legal Review Required | Legal Review + Security Review | Code Verified (no card data) |
| CMP-11 processor/DPA inventory | Phase-in Required | Manual Audit + Legal Review | Architecture Decision (G-13) |
| CMP-12 cross-border/residency | Legal Review Required → Phase-in | Legal Review | Unknown (G-21) |
| CMP-13 SHAAM production-identity guard | Phase-in Required | CI (test) + Code Review | Code Verified (G-25) |

## 9. Exception Process

Exceptions to any CMP-requirement follow **WP9 §14**. External-obligation lapses (CMP-5/6 CASA, CMP-8 Meta) cannot be self-waived — they require the external body's status, so the "exception" is a tracked remediation with a hard external deadline, not a discretionary waiver.

## 10. Future Compatibility

- **Marketplace:** escalates PCI scope (Dubiz may touch funds flow) + adds marketplace-platform obligations → **Future Requirement**; touches a frozen non-negotiable (Payment Secretary "not a processor").
- **Mobile:** activates CMP-9 (Apple/Play) fully.
- **Public API / Integrations Marketplace:** Dubiz becomes a platform provider → third-party app-review + data-sharing frameworks → **Future Requirement**.
- **Multi-region:** activates CMP-12 residency in full → **Future Requirement**.
- **Multi-currency:** foreign tax-authority obligations beyond the Israel-specific billing family → **Future Requirement** (Conflict with Israel-only tax scope).
- **Enterprise:** SOC 2 / ISO 27001 customer requirements → **Future Requirement** (new framework rows).

## 11. Changelog (v1.1)

- **CMP-9 confirmed N/A by evidence** (no mobile stack) — *resolves:* Review §4 Unknown (mobile).
- **Added §4.10 CMP-12 cross-border/data-residency** — *resolves:* **Review M-2**; registers audit **G-21**.
- **Added §8 matrix, §9 exception ref, §10 Future Compatibility, Status/phase-in header** (WP9).
- **(v1.2) Added CMP-13 SHAAM production-identity guard** (refuse to emit simulator/placeholder identity in prod) — *resolves:* Validation Should-Fix #10; owns G-25.
- **(v1.2) CMP-4 status made evidence-precise** — "certified-but-not-registered" replaces the blended "Implemented/Partial" — *resolves:* Validation §5 ambiguity.
- **Status → Candidate for Ratification (v1.2).**

## 12. References (sources of truth — not duplicated here)

- Billing/tax: AGENTS.md family + `billing-compliance-*`, `billing-authority-shaam-readiness-foundation-plan.md`, `docs/compliance/tax-authority/*`.
- [privacy-constitution-v1.md](privacy-constitution-v1.md), [accessibility-constitution-v1.md](accessibility-constitution-v1.md), [security-constitution-v1.md](security-constitution-v1.md), [ai-constitution-v1.md](ai-constitution-v1.md), [development-constitution-v1.md](development-constitution-v1.md).
- External: [Google restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification), [Google CASA (2025)](https://deepstrike.io/blog/google-casa-security-assessment-2025).
- [compliance-constitution-system-audit-v1.md](compliance-constitution-system-audit-v1.md) — findings & status.
