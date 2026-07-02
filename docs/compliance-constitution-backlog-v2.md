# Constitution Backlog v2

**Status:** Living backlog — established by WP9 §14a (GOV-16/17/18) at v1.2 ratification
**Date opened:** 2026-07-02
**Purpose:** the single home for constitution **text improvements** discovered after v1.2. Per **GOV-16 (freeze-and-implement)** the authoring phase is closed after v1.2; per **GOV-17** any new gap/idea — including ones found during implementation — is recorded here and handled later as a deliberate, versioned Governance amendment (GOV-1/GOV-3/GOV-5), **not** patched into the v1.x constitutions. Only a fundamentally new, previously-unknown failure (GOV-18) may reopen a ratified constitution before its Backlog-v2 item is processed.

> This backlog holds **constitution-document** improvements. It is distinct from the **code/ops remediation backlog** (the `Phase-in Required` builds tracked in each constitution's remediation section + the System Audit gaps), which proceeds during implementation.

---

## 1. Simplification sweep (from Validation §8 — non-blocking polish)

Deferred deliberately: these reduce size/echo but change no obligation, so they are not ratification blockers. Batch into a single "v2 simplification" amendment.

| # | Item | Constitutions touched |
|---|------|-----------------------|
| S-1 | `signal≠authority` stated 4× (SEC-P5, SEC-14, CMP-10, principle doc) → keep principle doc + SEC-14; make the others cross-references | WP3, WP5 |
| S-2 | tax/billing owner-of-truth stated 3× (AGENTS.md, CMP-4, DEV-9) → collapse CMP-4 restatement to a pointer | WP5, WP7 |
| S-3 | Amendment-13 pen-test "Unknown—legal" stated 3× (SEC-V2, WP2 §1, CMP-6) → one owner (CMP-6) + cross-refs | WP2, WP3, WP5 |
| S-4 | WP2 §2 "seven questions" ≈ WP7 DEV-1..5 "Compliance Verification block" → merge into one PR-template section | WP2, WP7 |
| S-5 | WP1 §6 QA checklist ≈ §7 DoD (~70% overlap) → one references the other | WP1 |
| S-6 | Relocate A-21/A-22 (accessibility statement + coordinator — legal/content duties) from WP1 to WP4 with a WP1 pointer | WP1, WP4 |
| S-7 | Demote A-7 44×44 non-gating line to a style-guide note | WP1 |
| S-8 | AI-8 (prompt-confidentiality disclosure) → cross-reference to WP2 §5/§7 | WP6 |
| S-9 | AI-9 (log AI decisions) → scope explicitly to persisted/consequential AI, not every content call | WP6 |

*(S-6 was in Validation Must/Should but is a relocation, not a correctness fix — deferred to v2 to avoid churn; A-21/A-22 are already reclassified `Legal Review Required` in WP1 v1.2, which removes the blocking concern.)*

---

## 2. Clarity / definition improvements (non-blocking, from Validation §4)

| # | Item | Notes |
|---|------|-------|
| C-1 | Define the **WP6-vs-Brain "agentic" boundary** — is a deterministic judgment engine (Business Status) in WP6 scope? | WP6/Brain seam; today Brain has zero LLM so nothing binds — safe to defer |
| C-2 | Define **"consequential AI suggestion"** with a rubric (referenced by AI-7/AI-10, DEV-14) | rubric addition |
| C-3 | SEC-1 terminology: "signed-token" vs "JWT" naming drift (code is custom HMAC) | cosmetic |
| C-4 | Give **SEC-3 an interim contract** (e.g. token-version column + denylist) so revocation is buildable from WP3 without the D1 doc | delegation-depth improvement |
| C-5 | Add a **numbering-invariant one-liner** to DEV-9 (gapless? per-year? per-business?) or an explicit pointer, so numbering is buildable | currently delegated to frozen family |
| C-6 | Elevate **amount/currency-match on payment verification** from principle-doc prose to an enforceable SEC-14 MUST | real gap; code doesn't check amount today |
| C-7 | **A-11 "background MUST be `inert`" for inline (non-portal) modals** — clarify WP1 that for a modal rendered inline (not via a portal), the inert-background intent is satisfied by `aria-modal="true"` + a focus trap, with true DOM `inert` achievable once the shared `useAccessibleDialog` primitive (A-18) portals the dialog. Discovered in W1 pilot (movement-modal). Clarification, not a requirement defect. | W1 pilot finding; route via Governance, do not patch WP1 directly |

---

## 3. Coverage improvements (non-blocking, from Validation §7)

| # | Item | Notes |
|---|------|-------|
| V-1 | Add an **OAuth `redirect_uri` registration precondition** requirement (the Gmail blocker) to WP5/WP7 release checklist | ops/release gap |
| V-2 | Consider whether **client-fetch-vs-HTTP-redirect mechanics** (the Gmail `opaqueredirect` class) warrant any constitutional lever, or stay a code-review concern | likely stays code-review; record decision |
| V-3 | SEC-16 **inbound webhook-fetched media** guidance (size/type/SSRF on `mediaId`) — currently upload-centric | extend SEC-16 |

---

## 4. Processing rule

Each item is picked up only via the Governance change process once implementation is underway and priorities are set. Adding to this backlog is **not** a commitment to implement; it is a commitment **not to lose the finding**. Items graduate to a versioned amendment (v2.x) with the same rigor as v1.x (evidence-first, matrix, changelog, independent review).

## 5. References
- [governance-constitution-v1.md](governance-constitution-v1.md) §14a (GOV-16/17/18) — the mechanism.
- [compliance-constitution-validation-report-v1.md](compliance-constitution-validation-report-v1.md) — source of items (§8 simplification, §4 ambiguities, §7 incidents).
