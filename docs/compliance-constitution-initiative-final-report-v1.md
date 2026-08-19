# Dubiz Compliance Constitution Initiative — Final Report v1

**Status:** Draft v1 — deliverable summary of the Compliance Constitution Initiative
**Date:** 2026-07-02
**Entry point for:** the full constitutional framework (WP1–WP9) + rolling System Audit.

> This report is the index and executive summary. The **binding** content lives in the individual constitutions and the System Audit, which are the sources of truth. Nothing here overrides them.

---

## 1. What was delivered

**Method:** Evidence First throughout. Every legal claim was verified against an external source (IS 5568 / ERPD; Privacy Law Amendment 13; Google restricted-scope/CASA); every technical claim cites code/schema; every unknown is marked `Unknown — requires legal review` or `Unknown — requires product decision` rather than guessed.

| # | Deliverable | Document |
|---|-------------|----------|
| 0 | System Audit (rolling status) | [compliance-constitution-system-audit-v1.md](compliance-constitution-system-audit-v1.md) |
| WP1 | Accessibility Constitution | [accessibility-constitution-v1.md](accessibility-constitution-v1.md) |
| WP2 | Privacy Constitution | [privacy-constitution-v1.md](privacy-constitution-v1.md) |
| WP3 | Security Constitution | [security-constitution-v1.md](security-constitution-v1.md) |
| WP4 | Legal Constitution | [legal-constitution-v1.md](legal-constitution-v1.md) |
| WP5 | Compliance (Frameworks) Constitution | [compliance-frameworks-constitution-v1.md](compliance-frameworks-constitution-v1.md) |
| WP6 | AI Constitution | [ai-constitution-v1.md](ai-constitution-v1.md) |
| WP7 | Development Constitution (per-PR gate) | [development-constitution-v1.md](development-constitution-v1.md) |
| WP8 | Documentation Constitution | [documentation-constitution-v1.md](documentation-constitution-v1.md) |
| WP9 | Governance Constitution | [governance-constitution-v1.md](governance-constitution-v1.md) |

All nine constitutions are **drafted and internally consistent** (cross-references verified, terminology unified, all gaps registered in the System Audit). They are **Draft v1** — advisory until ratified per WP9 GOV-1.

**Consistency pass results:** all inter-document links resolve; all 25 referenced pre-existing docs exist; WCAG target consistent (2.0 AA floor / 2.2 AA target) across WP1↔WP5; every gap appears in the System Audit; DoD structure consistent.

> **Correction (v1.1, resolves Review m-7):** the original claim "no contradictions found" was **overstated**. The subsequent independent Review found real contradictions the automated link/reference pass could not catch — C-1 (encrypt-vs-lookup), M-7 (every-endpoint vs platform-admin), M-8 (SHOULD/MUST in one clause), M-9 (untimed tracked-gap). All are resolved in the v1.1 pass. A link/reference consistency pass is **not** a semantic-contradiction check; the two must not be conflated. See [compliance-constitution-review-ratification-report-v1.md](compliance-constitution-review-ratification-report-v1.md).

---

## 2. Gaps identified (18 total, G-1…G-18)

Full detail and evidence in the System Audit §3. Summary by remediation type below (a gap may need more than one).

### 2.1 Gaps requiring **code changes**
- **G-2** Consent record + capture/withdrawal (WP2)
- **G-3** Right-to-erasure workflow (WP2)
- **G-4** Retention/TTL + purge (WP2) — *also needs a product decision on periods*
- **G-5** Full data export (CRM/messages/account) (WP2)
- **G-6** PII-at-rest encryption (WP2/WP3)
- **G-7** `eslint-plugin-jsx-a11y` gate + fixes (WP1)
- **G-8** Form accessibility (labels/required/invalid/error linkage) (WP1)
- **G-9** Focus trap, skip links, reduced-motion, focus baseline (WP1)
- **G-10** Server-side session revocation (WP3, D1 decided)
- **G-11** Intra-business role granularity (WP3) — *also a product decision on the role model*
- **G-12** Personal-data access auditing / SAR surface (WP2)
- **G-14** AI prompt-data classification + AI-assisted labeling (WP6)
- **G-15** Per-PR compliance gate: PR template + CI (`jsx-a11y`, secret-scan) (WP7)
- **G-16** Legacy Gmail `enc_v0:` token sweep + file rename (WP3)
- Security hardening: **Tranzila webhook verification** (WP3 SEC-14); **security headers** confirm/implement (WP3 SEC-18, currently Unknown)

### 2.2 Gaps requiring an **operational action** (not code)
- **G-1 (P0)** Rotate all secrets currently in working-tree `.env`; adopt managed secret store. *(Not in git history, but treat as exposed.)*

### 2.3 Gaps requiring a **business / product decision**
- Retention periods per data category (part of G-4)
- Intra-business role model design (part of G-11)
- GDPR applicability (does Dubiz process EU residents' data?) (WP5 CMP-2)
- **G-17** Google CASA: budget + timing decision for the (paid, weeks-long) assessment
- Provider/model selection standards for AI (WP6 AI-5)
- Named constitution owners (WP9 GOV-8)
- Refund/subscription terms content (part of G-18, with legal)

### 2.4 Gaps requiring **legal counsel** (`Unknown — requires legal review`)
- **G-18** Legal instruments: Cookie Policy, AI Usage Policy, Payment/Subscription Terms, Refund Policy, DPA, public Security Statement (WP4)
- Lawful-basis map per processing purpose (WP2 §3)
- **DPO / Data Security Officer** requirement under Amendment 13 (WP2 §1)
- **"Large sensitive database"** classification → 18-month pen-test/risk-assessment duty (WP2/WP3 SEC-V2)
- **PCI SAQ classification** confirmation (WP5 CMP-10)
- **G-17** Google restricted-scope/CASA obligation (legal+compliance dimension) (WP5 CMP-5/6)
- Reconciliation that Privacy Policy/ToS text matches actual behavior (WP4 LEG-2)

---

## 3. Prioritized backlog (P0–P3)

**P0 — immediate, operational:**
1. **G-1** Rotate `.env` secrets + managed secret store. *(Owner: ops. Blocks safe production.)*

**P1 — highest exposure; start now (some have external lead-time):**
2. **G-15 / WP7** PR template with the Compliance Verification block + turn on CI gates — *the mechanism that stops all future drift.*
3. **G-7/8/9 / WP1** Enable `eslint-plugin-jsx-a11y`, build shared a11y primitives (dialog focus, skip link, reduced-motion, accessible field), retrofit forms/dialogs. *(Highest legal-exposure domain: IS 5568, ₪50k statutory damages without proof of harm.)*
4. **G-2/3/4 / WP2** Consent record, right-to-erasure, retention framework. *(Amendment 13, statutory damages.)*
5. **G-17 / WP5** Determine Google OAuth verification/CASA status for `gmail.readonly` and plan the assessment — external, paid, weeks-long; risk of Gmail-integration suspension if lapsed.
6. **Legal kickoff:** DPO determination, GDPR scope, PCI SAQ class, lawful-basis map, behavior↔policy reconciliation.

**P2 — complete the data-rights + security surface:**
7. **G-5** Full export (CRM/messages/account); **G-6** PII-at-rest encryption; **G-12** sensitive-read auditing (WP2).
8. **G-10** Session revocation (WP3/D1); **Tranzila** webhook hardening; **security headers** confirm (WP3).
9. **G-13 / WP5** Processor/DPA inventory.
10. **G-18 / WP4** Reconcile Privacy Policy + ToS; add AI Usage Policy; add Payment/Subscription + Refund terms (with legal) before any payment expansion.
11. **G-14 / WP6** Prompt-data classification utility + AI-assisted labeling.

**P3 — hardening, completeness, ratification:**
12. **G-11** Intra-business roles; **G-16** legacy Gmail token sweep + rename; key-rotation policy (WP3).
13. **G-18** DPA, Cookie Policy (if trackers), copyright/trademark verification (WP4).
14. **WP1** logical-property migration; contrast verification of tokens.
15. **WP9** Ratify the Draft family with named owners; stand up the exceptions register; calendar the quarterly audit + external time-boxed obligations (Google CASA annual, any Amendment-13 pen-test cycle).

---

## 4. What "done" now means for Dubiz

Per the Initiative's permanent rule: **no new feature, integration, API, screen, workflow, database change, AI capability, or public-website change is complete unless it complies with this constitution.** The enforcement mechanism is the **WP7 per-PR Compliance Verification** (Accessibility, Privacy, Security, Legal, Compliance reviews), backed by CI gates and the tracked-gap discipline. The framework evolves only through **WP9 governance**, always preserving consistency between code, documentation, and actual behavior.

---

## 5. Recommended next actions (for the owner)

1. Action **P0 secret rotation** (G-1) — independent of everything else.
2. **Ratify** the Draft constitutions and assign owners (WP9 GOV-1/GOV-8) — this flips them from advisory to binding.
3. Approve the **P1 build backlog** and the **legal-counsel engagement** (the legal unknowns gate several P1/P2 items).
4. Decide the **Google CASA** path (G-17) early because of its external lead-time.

## 6. References

- Rolling status: [compliance-constitution-system-audit-v1.md](compliance-constitution-system-audit-v1.md)
- The nine constitutions: WP1–WP9 (§1 table).
- Root governance: `AGENTS.md` / `CLAUDE.md`.
- External sources cited within WP1 (IS 5568), WP2 (Amendment 13), WP5 (Google CASA).
