# Dubiz AI Constitution v1.1 (WP6)

> **Constitution Status:** `Ratified` (ratified 2026-07-02 per WP9 GOV-1) · **Version:** v1.2 · **Effective Date:** upon ratification
> **Legacy Scope:** existing AI services grandfathered per WP9 §10; G-14 items (incl. the 4 ungated clients) are scheduled remediation.
> **New Development Scope:** new/changed AI calls bind AI rules in full (§9 matrix).
> Shared machinery in **WP9 §9–§14**.

**Date:** 2026-07-02 (v1.1)
**Depends on:** [compliance-constitution-system-audit-v1.md](compliance-constitution-system-audit-v1.md) (finding G-14, §2.8 AI data flows), [governance-constitution-v1.md](governance-constitution-v1.md) (WP9 shared machinery), [compliance-constitution-review-ratification-report-v1.md](compliance-constitution-review-ratification-report-v1.md)
**Consistent with:** `docs/dubiz-business-brain-product-constitution-v1.md`, `docs/dubiz-business-brain-foundation-v1.md`, `docs/dubiz-evidence-learning-ledger-design-v1.md`, [privacy-constitution-v1.md](privacy-constitution-v1.md)
**Normative language:** MUST / MUST NOT / SHOULD / MAY per RFC 2119.

---

## 1. Purpose (מטרה)

To govern how Dubiz uses AI/LLMs so that AI capabilities are **transparent, bounded, human-accountable, and privacy-safe**. This constitution defines what data may and may not enter a model, how AI outputs are treated, and who is responsible for them. It complements — and does not restate — the **Business Brain** product constitution, which governs the *judgment* behavior of the Brain; this document governs the *mechanics and compliance* of model usage.

## 2. Scope

Every AI/LLM invocation in the platform. **Complete current inventory (v1.2 — corrected per Validation §1; the v1.1 list was stale):** content generation (`lib/features/content/llm/content-llm.service.ts`), script generation (`lib/services/script-ai.service.ts`), concept generation (`lib/services/concept-ai.service.ts`), **human-insight engine (`lib/features/content/.../human-insight.engine.ts`)**, and **story-premise engine (`.../story-premise.engine.ts`)** — all on **OpenAI `gpt-4.1-mini`** — plus document OCR (`lib/services/documents/google-vision-ocr.service.ts`, Google Vision). The AI-provider inventory MUST be kept current (AI-V2); a stale inventory is a defect. Applies to all present/future model providers and to any Brain/agentic capability. **Scope note:** requirements shaped around the LLM call pattern (AI-2 scrubber, AI-4 enable-flag, AI-5 model-id) apply to **LLM/generative** calls; the **Google Vision OCR** path is governed by AI-3 (which explicitly carves out that OCR sends full document bytes) — a developer MUST NOT try to satisfy AI-2's prompt-scrubber on the OCR byte-stream (it is nonsensical to redact bytes and still OCR them).

## 3. Principles

- **AI-P1 Human accountability.** AI output is a **suggestion**, never an autonomous authority. A human (or a governed deterministic system) remains responsible for consequential actions. Consistent with the Brain constitution ("trusted advisor," not decision-maker) and `payments-authority-principle-v1.md` (AI/webhook signal ≠ authority).
- **AI-P2 Privacy-safe prompts.** Personal data minimization (WP2 P-1) applies to prompts. **Customer PII MUST NOT be sent to an LLM provider** absent a specific lawful basis + Privacy Review.
- **AI-P3 Transparency.** Users MUST be able to know when content/decisions are AI-assisted. AI-generated artifacts MUST be distinguishable from verified facts (consistent with the Documents "Financial Truth" boundary and Brain honesty rulings).
- **AI-P4 Graceful degradation.** AI is a fail-safe enhancement: every AI path MUST have a deterministic fallback (already the pattern — services return `null`/templates on failure). AI unavailability MUST NOT break a core flow.
- **AI-P5 Bounded output.** Model output MUST be validated/guarded before use (existing "domain guard" relevance check in the content service is the model to generalize).
- **AI-P6 No silent training on user data.** User/customer data MUST NOT be used to train or fine-tune models without an explicit, documented, lawful decision (WP2 P-2 purpose limitation).

## 4. Mandatory Requirements

### 4.1 Allowed / prohibited data
- **AI-1 Allowed by default:** non-personal business context — business category, offer/service labels, content goals, marketing strategy, platform rules. (These are business-confidential, see AI-8.)
- **AI-2 Prohibited by default (without Privacy Review + lawful basis):** customer PII (names, phones, emails, tax IDs), message/conversation content, raw financial-document PII, and any special-category data. **Enforcement (resolves Review m-5):** because this MUST is otherwise only developer discipline, the gated AI services (AI-4) MUST route prompts through a **prompt-data classification/scrub step** with a test asserting prohibited categories are not present; free-text fields (WP2 P-1) MUST be treated as potentially PII-bearing. `Phase-in Required` (the scrubber is a scheduled build; until it exists, this is enforced by mandatory Privacy Review on every AI-touching PR).
- **AI-3** OCR of user documents (Google Vision) sends **full document bytes** to the processor; this is an established data flow and MUST remain governed by the Privacy data-flow map (WP2 §5) and a DPA (WP5).

### 4.2 Governance & configuration
- **AI-4** Every model call MUST go through a gated service with an explicit enable flag and runtime diagnostics (existing pattern: `CONTENT_LLM_ENABLED`, `getContentLLMRuntimeDiagnostics`). No ad-hoc direct calls. **Legacy reconciliation (v1.2 — resolves Validation §5.5 / Should-Fix #12):** four existing module-level OpenAI clients (`script-ai.service.ts`, `concept-ai.service.ts`, `human-insight.engine.ts`, `story-premise.engine.ts`) are **not** gated today — these are **Legacy Scope** (grandfathered per WP9 §10, gap G-14) and are NOT merge-blockers, but they MUST be brought behind a gated service on next material change. **Enforcement:** the mechanizable rule is a lint — **"no `new OpenAI(` (or equivalent client construction) outside an approved gated service"** — which is `Phase-in Required` (WP7 DEV-13) and, once active, blocks *new* ungated calls and flags the four legacy ones. This makes AI-4 enforceable rather than aspirational.
- **AI-5** Model identity and version MUST be explicit and configurable (existing `CONTENT_LLM_MODEL` default `gpt-4.1-mini`). Model changes are a governed change (WP9). New AI capabilities SHOULD target the most capable appropriate Claude/approved model per current platform standards; provider/model selection is a **product decision** where not already set.
- **AI-6** API keys MUST be env-only and never logged (SEC-8); the audit confirmed keys are not logged in the AI services — this MUST be preserved.

### 4.3 Transparency, logging & responsibility
- **AI-7 Transparency (v1.2 — made implementable; resolves Validation §6.1 / Must-Fix #1).** The v1.1 rule ("default-on marker on *every* AI output, Immediately Enforceable") was **unimplementable as written**: the content pipeline fuses AI and deterministic-template output into one provenance-less object (`ai-content.service.ts:958-1089`) and the API returns it flag-less — there is no field to mark, and no data-contract rule created one. The corrected rule:
  1. **Precondition (the real requirement):** the AI output **data contract MUST carry a provenance field** (e.g. `source: "ai" | "template" | "mixed"`) at the object boundary, so provenance is not discarded before the API. `Phase-in Required` — this is a data-contract build, not a lint of a field that doesn't exist.
  2. **Scope:** the "AI-assisted" transparency marker applies to AI output that is **persisted or surfaced as a result the user relies on** (e.g. an extracted financial field next to verified truth, a saved AI insight). A **draft the user is actively editing** (content generation is always an editable draft) is **exempt** — it is self-evidently a draft, and marking every keystroke-editable field adds no honesty.
  3. Once the provenance field exists, the marker becomes machine-checkable (component-prop / lint); until then AI-7 is enforced by Product Review on AI-surfacing PRs. Consequential AI suggestions MUST additionally show their basis (Brain constitution).
  This removes the "0 code hits but Immediately Enforceable" contradiction by naming the missing mechanism as the precondition and scoping out drafts.
- **AI-8 Confidentiality of prompts:** business-confidential prompt content (strategy/offers) is sent to external providers subject to their retention; this MUST be disclosed in the Privacy Policy (WP4/WP2 §7) and MUST inform provider selection.
- **AI-9 Logging:** AI decisions that affect the product record SHOULD be captured via the existing evidence/learning mechanisms (`ExtractionSnapshot`, `ReviewEvent`, `docs/dubiz-evidence-learning-ledger-design-v1.md`) — write-only to the engine, for evidence-based RCA, **not** auto-learning.
- **AI-10 Human override:** any AI-suggested action a user can accept MUST be reviewable and reversible before it becomes an authoritative record (AI-P1).

## 5. Definition of Done (AI) — an AI-touching change is NOT complete without

1. Data sent to the model classified against AI-1/AI-2; no prohibited data without Privacy Review (AI-2).
2. Call routed through a gated, flagged service with explicit model id (AI-4/AI-5).
3. Deterministic fallback present and tested (AI-P4).
4. Output validated/guarded before use (AI-P5).
5. Transparency handled where output could be mistaken for verified fact (AI-7).
6. New provider/data-flow added to the Privacy data-flow map + DPA check (AI-3, WP2/WP5).
7. Keys env-only, not logged (AI-6).

## 6. Verification / Audit

- **AI-V1** The Privacy Review (WP7 DEV-2) MUST cover prompt data for any AI-touching PR.
- **AI-V2** Provider/model inventory MUST be maintained (part of WP5 processor inventory).
- **AI-V3** Amendment 13 note: data-subject rights (access/correction/deletion) are to be **strictly enforced for AI systems** (WP2 §1 sources) — AI features MUST NOT place personal data beyond the reach of the WP2 §6 rights machinery.

## 7. Remediation Guidance

1. Add an explicit **prompt-data classification** step to the AI services and Privacy Review (AI-2).
2. Register OpenAI + Google Vision in the WP5 processor/DPA inventory with retention terms (AI-3/AI-8).
3. Generalize the content-service "domain guard" into a shared output-validation utility (AI-P5).
4. Add AI-assisted labeling where outputs surface next to verified data (AI-7).

## 8. Enforcement & Classification Matrix (per WP9 §11–§13)

| Req | Classification | Enforcement | Evidence |
|-----|----------------|-------------|----------|
| AI-P1/AI-10 human accountability & override | Immediately Enforceable | Code Review + Product Review | Architecture Decision |
| AI-1 allowed data | Immediately Enforceable | Code Review | Code Verified |
| AI-2 prohibited data + scrubber (LLM calls only; OCR via AI-3) | Phase-in Required | CI (test) + Legal/Privacy Review | Code Verified (m-5) |
| AI-3 OCR full-bytes flow governed | Immediately Enforceable | Code Review + Legal Review | Code Verified |
| AI-4 gated service (new) / legacy 4 clients (grandfathered) | Immediately Enforceable (new) → Phase-in (lint + legacy) | Linter + Code Review | Code Verified (G-14) |
| AI-5 explicit model id/version | Immediately Enforceable / Product Decision (provider std) | Code Review | Code Verified |
| AI-6 keys env-only, not logged | Immediately Enforceable | CI (secret-scan) + Code Review | Code Verified |
| AI-7 provenance field (precondition) → AI-assisted marker on persisted/consequential output | Phase-in Required | Code Review → Linter/component-prop | Code Verified (0 markers today) |
| AI-8 prompt-confidentiality disclosure | Phase-in Required | Legal Review | Official Documentation |
| AI-9 decision logging (evidence ledger) | Phase-in Required | Code Review | Architecture Decision |

## 9. Exception Process

Exceptions to any AI-requirement follow **WP9 §14**. An AI-2 exception (sending restricted data to a model) additionally requires Privacy **and** Legal Review sign-off with a hard expiry.

## 10. Future Compatibility

- **Autonomous AI Agents:** **Conflict** — AI-P1/AI-10 forbid autonomous authority (human override before an authoritative record). Enabling agents that *act* directly requires an explicit **governance amendment** defining an "action-authority" model (WP9 §15) — it MUST NOT be added silently. **Future Requirement (Conflict).**
- **Voice Interfaces:** voice recordings are sensitive/biometric-adjacent → new privacy + a11y criteria → **Future Requirement**.
- **Public API:** exposing AI features to third parties needs per-client data-handling + abuse controls → **Future Requirement**.
- **Multi-language:** model prompt/response governance is language-agnostic; add per-language quality/guard rules → minor extension.
- **Marketplace / Mobile / Enterprise / Multi-region / Multi-currency:** no new AI principle; data-residency of model providers ties to WP5 CMP-12.

## 11. Changelog (v1.1)

- **AI-7 made measurable** (default-on marker + listed exemptions replacing "where a user could mistake") — *resolves:* **Review M-5**.
- **AI-2 given an enforcement path** (prompt scrubber + test; interim mandatory Privacy Review) — *resolves:* **Review m-5**.
- **Added §8 matrix, §9 exception ref, §10 Future Compatibility (flags autonomous-agents Conflict), Status/phase-in header** (WP9).
- **(v1.2) AI-7 made implementable** — provenance-field precondition + drafts-exempt scope; reclassified Immediately Enforceable → Phase-in — *resolves:* Validation Must-Fix #1.
- **(v1.2) §2 scope corrected** — added the 2 missed LLM engines (human-insight, story-premise); clarified LLM-vs-OCR requirement applicability — *resolves:* Validation §1 stale-inventory.
- **(v1.2) AI-4 legacy reconciliation** — 4 ungated clients marked Legacy/G-14; lint rule as enforcement — *resolves:* Validation Should-Fix #12.
- **Status → Candidate for Ratification (v1.2).**

## 12. References (sources of truth — not duplicated here)

- `docs/dubiz-business-brain-product-constitution-v1.md`, `docs/dubiz-business-brain-foundation-v1.md` — Brain judgment behavior.
- `docs/dubiz-evidence-learning-ledger-design-v1.md` — engine-decision/correction ledger.
- `payments-authority-principle-v1.md` — signal-vs-authority.
- [privacy-constitution-v1.md](privacy-constitution-v1.md) (WP2), WP5 Compliance, [development-constitution-v1.md](development-constitution-v1.md) (WP7).
- [compliance-constitution-system-audit-v1.md](compliance-constitution-system-audit-v1.md) §2.8, G-14.
