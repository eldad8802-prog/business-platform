# Dubiz Accessibility Constitution v1.1 (WP1)

> **Constitution Status:** `Ratified` (ratified 2026-07-02 per WP9 GOV-1) · **Version:** v1.2 · **Effective Date:** upon ratification
> **Legacy Scope:** existing screens/components are grandfathered per WP9 §10; their gaps (G-7/8/9) are the scheduled remediation, not a merge-blocker.
> **New Development Scope:** all new or materially changed UI binds to `Immediately Enforceable` rows in full (see §11 matrix).
> Shared machinery (Status, Effective-Date, Classification/Enforcement/Evidence taxonomies, Exceptions) is defined once in **WP9 §9–§14**.

**Date:** 2026-07-02 (v1.1)
**Depends on:** [compliance-constitution-system-audit-v1.md](compliance-constitution-system-audit-v1.md) (findings G-7, G-8, G-9), [governance-constitution-v1.md](governance-constitution-v1.md) (WP9 shared machinery), [compliance-constitution-review-ratification-report-v1.md](compliance-constitution-review-ratification-report-v1.md)
**Consistent with:** `docs/dubiz-visual-language-v1.md`, `docs/dubiz-product-decisions-v1.md`, `lib/design/tokens.ts`
**Normative language:** MUST / MUST NOT / SHOULD / MAY per RFC 2119.

> Accessibility is mandatory, not optional. This document is the system-wide accessibility contract for every current and future Dubiz screen, component, flow, email, PDF, and public-website page. A feature is **not done** until it satisfies the Definition of Done in §7.

---

## 0. Purpose (מטרה) & Scope

**Purpose:** to make WCAG-conformant accessibility a built-in architectural constraint for Dubiz, closing audit findings G-7/G-8/G-9, so no screen ships accessibility debt.

**Scope:** every user-facing surface — screens, components, dialogs, forms, feeds, emails, generated PDFs, and public-website pages (`app/**`, `components/**`), Hebrew-first / RTL. Applies to human- and agent-authored UI changes. Enforced through the WP7 Accessibility Review (DEV-1). **Scope clarification (v1.2 — resolves Validation §4.3 ambiguity):** the **public marketing site** (`app/(corporate)/*`) **is** fully in accessibility scope — the same A-rules (landmarks, skip-link, contrast, keyboard, RTL) apply; there is **no** lighter "public a11y profile." (Note: the public site is separately **out of tenant/PII scope** — see WP2/WP3 public-marketing exemption — but that does not reduce its accessibility obligations.)

---

## 1. Legal basis & conformance target (evidence-based)

**Legal floor (binding minimum):** **WCAG 2.0 Level AA**, as adopted by Israeli Standard **IS 5568** under the *Equal Rights for Persons with Disabilities (Service Accessibility) Regulations, 2013* (ERPD Law). IS 5568 applies to **every service offered to the general public** above the revenue exemption threshold; non-compliance is a civil infraction carrying statutory damages of **up to ₪50,000 with no requirement to prove actual damage**. (Sources cited at end.)

**Adopted engineering target (this constitution):** **WCAG 2.2 Level AA.**

- Rationale: WCAG 2.2 AA is a superset of 2.0 AA — meeting it satisfies the legal floor and adds low-cost, high-value criteria (target size, focus-not-obscured, dragging alternatives, consistent help, accessible authentication). The marginal cost over 2.0 AA is small; the risk reduction and future-proofing are large.
- **Rule A-1:** Dubiz **MUST** meet WCAG 2.0 AA (legal floor) on every public-facing surface and **SHOULD** meet WCAG 2.2 AA everywhere. Any surface not yet at 2.2 AA **MUST** still be at 2.0 AA and **MUST** carry a tracked gap. **Clarification (v1.2 — resolves Validation §5.7 / Should-Fix #11):** while WCAG **2.2 as a whole** is SHOULD, this constitution **adopts specific 2.2 AA criteria as gating MUSTs** where they are cheap and high-value — currently **A-7 target size (2.5.8)** and **A-12 focus-not-obscured (2.4.11)**. These enumerated criteria are MUST (and appear in the DoD) even though the broader 2.2 conformance is SHOULD. There is no contradiction: 2.2-overall = SHOULD; the named 2.2 criteria = MUST.

**Non-negotiable context:** the product is **Hebrew-first / RTL**. RTL correctness is a first-class accessibility requirement, not a styling afterthought.

---

## 2. Design principles (the "why")

1. **Perceivable, Operable, Understandable, Robust (POUR)** are the four pillars; every rule below traces to one.
2. **Keyboard is the baseline, not the enhancement.** If it works with a mouse but not a keyboard, it is broken.
3. **The DOM is the source of truth for assistive tech.** Visual order MUST match DOM/focus order. Never fake structure with CSS that a screen reader cannot follow.
4. **Semantics before ARIA.** Use the correct native element first (`<button>`, `<a>`, `<nav>`, `<h1>`…). ARIA is a patch for gaps native HTML cannot express — "No ARIA is better than bad ARIA."
5. **Honesty (inherited from the Visual Language).** An accessible name MUST describe what the control actually does. No decorative labels, no lies to the screen reader.
6. **Calm includes motion restraint.** Respect `prefers-reduced-motion`; motion is never required to understand or operate anything.
7. **RTL is correctness.** Logical direction, mirrored icons where directional, correct bidi handling for mixed Hebrew/Latin/numeric content.

---

## 3. UI rules (screen / page level) — MUST

- **A-2 Language & direction:** every document root sets `lang="he"` and `dir="rtl"` (already at `app/layout.tsx:34`). Sub-trees with a different language MUST set their own `lang`. Numeric/Latin fields that require LTR MUST scope `dir="ltr"` locally (pattern already used in `BusinessIdentitySetupForm`).
- **A-3 Landmarks:** every page MUST expose one `<main>`, plus `<nav>`, `<header>`, and `<footer>` where present. There MUST be exactly one `<h1>` per page; headings MUST be hierarchical (no skipped levels).
- **A-4 Skip link:** every shell layout MUST provide a "דלג לתוכן" skip link as the first focusable element, targeting `<main>`. *(Closes audit gap G-9.)*
- **A-5 Reflow & zoom:** content MUST be usable at 320 CSS px width and at 200% zoom without loss of content or horizontal scrolling (WCAG 1.4.10, 1.4.4).
- **A-6 Contrast:** text MUST meet ≥ 4.5:1 (normal) / 3:1 (large); UI components & focus indicators MUST meet ≥ 3:1 (WCAG 1.4.3, 1.4.11). Token pairings in `lib/design/tokens.ts` MUST be contrast-verified (see A-16). The low-alpha focus ring flagged in the audit MUST be replaced with a ≥ 3:1 indicator.
- **A-7 Target size:** the **gating** threshold is ≥ 24×24 CSS px for interactive targets (WCAG 2.2 2.5.8, the pass/fail criterion). A separate **non-gating target** is ≥ 44×44 for primary touch controls (best practice, tracked but not a merge-blocker). DoD gating uses the 24×24 MUST only. *(Review M-5: threshold ambiguity resolved.)*
- **A-8 Reduced motion:** every animation/transition MUST be gated by `@media (prefers-reduced-motion: reduce)` (or a shared utility). Motion MUST NOT be the only way information is conveyed. *(Closes audit gap G-9; today only one such rule exists.)*

---

## 4. Component rules — MUST

- **A-9 Real controls:** clickable elements MUST be `<button>`/`<a>`. `role="button"` on a `<div>`/`<article>` is a last resort and, if used, MUST implement `tabindex="0"` **and** Enter/Space handlers **and** a correct accessible name. *(Audit found `role="button"` articles in `DocumentCard.tsx` — migrate toward native semantics.)*
- **A-10 Accessible name:** every interactive element MUST have a non-empty accessible name (visible text, `aria-label`, or `aria-labelledby`). Icon-only buttons MUST carry `aria-label` (pattern already present in `Header.tsx`, `bottom-bar.tsx`).
- **A-11 Dialogs / sheets / overlays:** any modal surface (`action-sheet.tsx`, `movement-modal.tsx`, `DocumentFilePreviewOverlay.tsx`, future) MUST:
  1. use `role="dialog"` + `aria-modal="true"` + an accessible name;
  2. **trap focus** within the dialog while open;
  3. move focus to the dialog (or its first control) on open;
  4. **restore focus** to the invoking element on close;
  5. close on `Escape`;
  6. mark background content `inert`/`aria-hidden`.
  *(Audit found 1–5 partially present, focus trap + restoration missing — G-9. A shared `useAccessibleDialog` primitive SHOULD be created so this is inherited, not re-implemented.)*
- **A-12 Focus visibility:** a visible focus indicator (≥ 3:1) MUST appear for keyboard focus on every interactive element. The `:focus-visible` pattern already used on content pages SHOULD be promoted to a global baseline. Focus MUST NOT be obscured by sticky headers/sheets (WCAG 2.2 2.4.11).
- **A-13 Live regions:** asynchronous status, toasts, and validation summaries MUST be announced via `aria-live` (`polite` for status, `assertive`/`role="alert"` for errors). *(Toast + billing status already do this; extend to all async feedback.)*
- **A-14 State:** toggle/expand/selected states MUST expose `aria-expanded` / `aria-pressed` / `aria-selected` (FAB already does `aria-expanded`).

## 4a. Forms — MUST *(closes audit gap G-8)*

- **A-15 Labeling & errors:** every input MUST have a programmatic label (`<label for>` or wrapping `<label>`). Every field with a hint MUST link it via `aria-describedby`. Required fields MUST set `aria-required`. Invalid fields MUST set `aria-invalid` **and** link the error text via `aria-describedby`. On submit failure, focus MUST move to the first invalid field or an error summary, and errors MUST be announced (`role="alert"`). Error messages MUST be specific and text-based (not color-only). *(Audit found `aria-invalid` on a single field only.)*

## 4b. Legal accessibility obligations (non-technical) — MUST *(added v1.1; resolves Review Critical Gap §5.5)*

Israeli accessibility law (IS 5568 / ERPD) requires more than technical WCAG conformance. Evidence: Legal Source (Deque Israel guidance; gov.il accessibility-declaration practice). These are **current** duties, not future:

A-21/A-22 concern the Israeli obligation to publish an accessibility statement + coordinator. **Applicability is `Legal Review Required` (v1.2 — resolves Validation §5.3 / Must-Fix #3; corrects the v1.1a over-assertion):** the public-site operator is an **עוסק פטור** (exempt dealer, ID 312260110 — Code Verified `app/(corporate)/contact/page.tsx`), and IS 5568/ERPD applies to services **above the revenue-exemption threshold** (WP1 §1 sources). Whether this operator meets the threshold is a legal question — so A-21/A-22 MUST NOT be asserted as a hard, timed current-legal-duty (the v1.1a GOV-10c tagging was too strong). **Rule:** counsel MUST confirm applicability; **if applicable**, A-21/A-22 become a current-legal-duty and inherit GOV-10c (timed, not grandfathered); **until confirmed**, they are `Legal Review Required` and advisory.

- **A-21 Accessibility statement (הצהרת נגישות):** *if applicable* — the site MUST publish an accessibility statement page (arrangements made, conformance target, known limitations, last-review date). No such page exists today in `app/(corporate)/*` (Code Verified: only about/contact/privacy/terms/home) — registered as gap **G-19**.
- **A-22 Accessibility coordinator (רכז נגישות):** *if applicable* — the site MUST publish the contact details of a designated accessibility coordinator. Naming the coordinator (if built) is `Product Decision Required`.

---

## 5. Developer requirements — MUST

- **A-16 Tooling gate:** the repo MUST enable `eslint-plugin-jsx-a11y` (`recommended` or stricter) in `eslint.config.mjs`, and CI MUST fail on its errors. *(Closes audit gap G-7 — no a11y tooling exists today.)*
- **A-17 Logical CSS:** new styles MUST use logical properties (`inset-inline-start`, `margin-inline`, `padding-inline`, `text-align: start`) instead of physical `left`/`right` so RTL is inherited, not hand-patched. Existing physical-property code SHOULD be migrated opportunistically.
- **A-18 Shared primitives:** accessibility behaviors (dialog focus management, skip link, reduced-motion utility, accessible field wrapper) MUST live in shared components/hooks under `components/ui` or `lib`, so correctness is inherited platform-wide rather than re-derived per feature.
- **A-19 Non-text content:** meaningful images MUST have `alt`; decorative images MUST have empty `alt=""`. Uploaded/generated media in feeds MUST expose a text alternative or be marked decorative.
- **A-20 No keyboard traps** (except intentional, escapable modal focus traps) and **no positive `tabindex`** (> 0).

---

## 6. QA checklist (per screen)

Manual pass, in addition to automated checks:

- [ ] Tab through the entire screen: order is logical, every interactive element is reachable and has a visible focus ring.
- [ ] Operate every control with keyboard only (Enter/Space/Escape/arrows as appropriate).
- [ ] Open every dialog/sheet: focus moves in, is trapped, returns on close, Escape works.
- [ ] Screen-reader pass (VoiceOver/NVDA) in Hebrew: names, roles, states, and error announcements are correct.
- [ ] Zoom to 200% and narrow to 320px: no content loss, no horizontal scroll.
- [ ] `prefers-reduced-motion` on: no essential motion.
- [ ] Contrast check on text, icons, and focus indicators.
- [ ] RTL: layout, icon direction, and mixed Hebrew/number/Latin text render correctly.
- [ ] Forms: labels, required/invalid states, and error-to-field linkage verified.

---

## 7. Definition of Done (a11y) — a feature is NOT complete without all of these

1. `eslint-plugin-jsx-a11y` passes with **zero** errors on the changed files (A-16). *(v1.2 phase-in caveat — resolves Validation §5.7: until the plugin is installed (A-16 is `Phase-in Required`), this DoD item is satisfied by the manual §6 QA checklist; it becomes a hard CI gate the moment the plugin lands. The DoD is not un-satisfiable in the interim.)*
2. New/changed screens pass the §6 QA checklist.
3. All new interactive elements meet A-9, A-10, A-12, A-7.
4. All new dialogs meet A-11 (focus trap + restore + Escape).
5. All new forms meet A-15.
6. All new animations meet A-8 (reduced-motion gated).
7. New color pairings are contrast-verified (A-6/A-16).
8. New CSS uses logical properties (A-17).
9. Any known WCAG gap is tracked with an owner and target (Rule A-1), never silently shipped.

---

## 8. Testing requirements

- **Static:** `eslint-plugin-jsx-a11y` in CI (blocking).
- **Automated component/E2E:** introduce `axe-core` / `jest-axe` (or Playwright + `@axe-core/playwright`) for critical flows (auth, billing/invoice creation, document review, payments, settings). Automated tooling catches ~30–40% of issues — it is necessary, not sufficient.
- **Manual:** the §6 checklist for any screen-level change; periodic full-keyboard + screen-reader audit of the top flows (owned per §9 of the Governance Constitution once ratified).

---

## 9. Accessibility review process

- Every PR that touches UI MUST include an **Accessibility Review** line in its description (what was checked against this constitution, DoD items satisfied, any tracked gap).
- This review is one of the mandatory reviews defined by the **Development Constitution (WP7)**; a UI PR is not mergeable without it.
- New shared primitives (A-18) get extra scrutiny because their correctness propagates platform-wide.
- Exceptions require the exception process defined by the **Governance Constitution (WP9)** — time-boxed, owned, and tracked; never a silent waiver.

---

## 10. Remediation backlog seeded by the audit

Priority order to bring the **existing** surface up to this constitution (from audit G-7/8/9):

1. Enable `eslint-plugin-jsx-a11y` + fix surfaced errors (A-16). *(Highest leverage, unblocks the gate.)*
2. Build shared primitives: `useAccessibleDialog` (focus trap/restore), skip link, reduced-motion utility, accessible field wrapper (A-18).
3. Retrofit dialogs/sheets to A-11; retrofit forms to A-15.
4. Global reduced-motion sweep (A-8) and global `:focus-visible` baseline (A-12).
5. Contrast-verify `lib/design/tokens.ts` pairings; fix focus-ring alpha (A-6).
6. Opportunistic logical-property migration (A-17).

---

## 11. Enforcement & Classification Matrix (per WP9 §11–§13)

| Req | Classification | Enforcement | Evidence |
|-----|----------------|-------------|----------|
| A-1 conformance (2.0 AA floor / 2.2 AA target) | Immediately Enforceable (new dev) | Code Review + Manual Audit | Legal Source (IS 5568) |
| A-2 lang/dir | Immediately Enforceable | Linter (jsx-a11y) + Code Review | Code Verified (`app/layout.tsx:34`) |
| A-3 landmarks (one main/h1, hierarchy) | Immediately Enforceable (new dev) | Linter + Code Review | Code Verified |
| A-4 skip link | Phase-in Required (skip-link primitive) | Linter + Code Review | Code Verified (gap G-9) |
| A-5 reflow/zoom / A-6 contrast | Immediately Enforceable (new dev) | Manual Audit + tooling | Official Documentation (WCAG) |
| A-7 target size (24×24 gate) | Immediately Enforceable | Code Review | Official Documentation |
| A-8 reduced motion | Phase-in Required (shared utility) | Linter + Code Review | Code Verified (gap G-9) |
| A-9 real controls / A-10 accessible name / A-12 focus visibility / A-14 state | Immediately Enforceable (new dev) | Linter + Code Review | Code Verified |
| A-11 dialog focus-trap/restore / A-13 live regions | Phase-in Required (shared `useAccessibleDialog`) | Linter + Code Review | Code Verified |
| A-15 forms | Phase-in Required (accessible field wrapper) | Linter + Code Review | Code Verified (gap G-8) |
| A-16 jsx-a11y CI gate | Phase-in Required (install + baseline) | CI + Linter | Code Verified (absent, G-7) |
| A-17 logical CSS / A-18 primitives / A-19 alt / A-20 no traps | Immediately Enforceable (new dev) | Linter + Code Review | Code Verified |
| A-21 accessibility statement (applicability TBD — עוסק פטור) | Legal Review Required → (if applicable) Phase-in timed | Legal Review + Manual Audit | Legal Source (gap G-19) |
| A-22 accessibility coordinator | Legal Review Required → Product Decision (name) | Legal Review + Product Review | Legal Source |

## 12. Exception Process

Exceptions to any A-requirement follow the canonical process in **WP9 §14** (justification, owner, risk, mandatory expiration, approval, tracking) and are recorded in the shared Exception Register. No accessibility requirement may be waived open-endedly.

## 13. Future Compatibility

- **Mobile:** **Partial.** This constitution is web/DOM-centric (WCAG success criteria, ARIA, `eslint-plugin-jsx-a11y`). Native mobile apps will require an added section mapping to platform a11y APIs (iOS UIAccessibility / Android accessibility) and store a11y policies. *(Future Requirement.)*
- **Multi-language:** **Partial** — A-2 handles per-language `lang`; full i18n (translated a11y statement, RTL/LTR switching) needs an i18n governance addition.
- **AI Agents / Voice:** voice/conversational UIs need their own a11y criteria (not covered). **Future Requirement.**
- **Marketplace / Enterprise / Public API / Multi-region / Multi-currency:** no accessibility-specific conflict; A-rules apply unchanged to any new web surface.

## 14. Changelog (v1.1)

- **Added §4b (A-21 accessibility statement, A-22 coordinator)** — *why:* Israeli law mandates a published accessibility statement + coordinator beyond technical WCAG; WP1 omitted them; *resolves:* Review Critical Gap §5.5; registers audit **G-19**.
- **Clarified A-7 gating threshold (24×24 MUST; 44×44 non-gating)** — *why:* DoD referenced A-7 ambiguously; *resolves:* Review **M-5**.
- **Added §11 Enforcement & Classification Matrix, §12 Exception ref (WP9 §14), §13 Future Compatibility** — *why:* owner's v1.1 structure; classifies every A-req and its enforcement/evidence.
- **Added Status header + Effective-Date/Legacy/New scope** (WP9 §10) — *why:* Review **C-2** phase-in; legacy screens grandfathered, new UI binds fully.
- **(v1.1a) A-21/A-22 tagged current-legal-duty with mandatory expiry (GOV-10c)** — *resolves:* second-review **MAJOR-2**.
- **(v1.1a) Un-bundled matrix rows** (A-3 vs A-4; split A-9/A-10/A-12/A-14 Immediately Enforceable from A-11/A-13 Phase-in) — *resolves:* second-review **MAJOR-3** (always-applicable MUSTs no longer mis-tagged Phase-in).
- **(v1.2) A-21/A-22 reclassified to `Legal Review Required`** (operator is עוסק פטור, applicability TBD) — *resolves:* Validation Must-Fix #3 (corrects v1.1a over-assertion).
- **(v1.2) A-1 clarified** (named 2.2 criteria A-7/A-12 adopted as MUST though 2.2-overall is SHOULD) + **DoD#1 phase-in caveat** — *resolves:* Validation Should-Fix #11 internal inconsistencies.
- **(v1.2) §0 scope clarified** — public marketing site is fully in a11y scope (no lighter profile) — *resolves:* Validation §4.3 ambiguity.
- **Status → Candidate for Ratification (v1.2).**

---

## Sources

- [accessiBe — IS 5568 compliance](https://accessibe.com/compliance/is-5568)
- [BOIA — Israel's Digital Accessibility Laws: An Overview](https://www.boia.org/blog/israels-digital-accessibility-laws-an-overview)
- [Deque — Israel's accessibility laws](https://www.deque.com/mena-digital-accessibility-laws/israel/)

*IS 5568 is based on WCAG 2.0 AA; ERPD Law provides for statutory damages up to ₪50,000 without proof of harm; applies to services offered to the public above the revenue exemption threshold.*
