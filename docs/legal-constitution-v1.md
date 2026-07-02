# Dubiz Legal Constitution v1.1 (WP4)

> **Constitution Status:** `Ratified` (ratified 2026-07-02 per WP9 GOV-1) · **Version:** v1.1 · **Effective Date:** upon ratification
> **Legacy Scope:** existing Privacy/Terms pages grandfathered per WP9 §10; reconciliation with actual behavior is scheduled remediation.
> **New Development Scope:** any new user-facing data/money behavior binds LEG rules in full (§11 matrix).
> Shared machinery in **WP9 §9–§14**. Binding legal *text* remains `Legal Review Required`.

**Date:** 2026-07-02 (v1.1)
**Depends on:** [compliance-constitution-system-audit-v1.md](compliance-constitution-system-audit-v1.md), [governance-constitution-v1.md](governance-constitution-v1.md) (WP9 shared machinery), [compliance-constitution-review-ratification-report-v1.md](compliance-constitution-review-ratification-report-v1.md)
**Consistent with:** `app/(corporate)/privacy/page.tsx`, `app/(corporate)/terms/page.tsx`, [privacy-constitution-v1.md](privacy-constitution-v1.md), [compliance-frameworks-constitution-v1.md](compliance-frameworks-constitution-v1.md)
**Normative language:** MUST / MUST NOT / SHOULD / MAY per RFC 2119.
**Caveat:** This constitution governs the **existence, coverage, and code↔document consistency** of legal instruments. It is **not legal advice**; drafting/approval of legally binding text is **Unknown — requires legal review** by qualified counsel.

---

## 1. Purpose (מטרה)

To ensure Dubiz has the legal instruments every feature legally requires, and that **the application's behavior always matches its legal documentation** — the documentation never describes functionality that does not exist, and the application never performs undisclosed behavior where disclosure is legally required ("Legal by Design").

## 2. Scope

All public-facing legal instruments and disclosures: Terms of Service, Privacy Policy, Cookie Policy, AI Usage Policy, Payment/Subscription Terms, Refund Policy, Acceptable Use Policy, Copyright/Trademark notices, Security Statement, Data Processing Agreement (DPA), and (future) SLA. Applies to the corporate website (`app/(corporate)/*`) and any in-app legal surface.

## 3. Principles

- **LEG-P1 Behavior = disclosure.** No gap between what the system does and what the legal documents say. A behavior change that affects users' data or money MUST be reflected in the relevant instrument in the same release.
- **LEG-P2 Existence before feature.** A feature whose lawful operation depends on a disclosure/agreement MUST NOT ship before that instrument exists (e.g., taking payments requires payment/refund terms).
- **LEG-P3 One truth per instrument.** Each legal instrument has one canonical page; other surfaces link to it.
- **LEG-P4 Plain, Hebrew-first, accessible.** Legal pages are user-facing UI and MUST meet WP1 accessibility.
- **LEG-P5 Counsel owns the text.** This constitution mandates coverage and consistency; the binding wording is owned by legal counsel (WP9 ownership).

## 4. Mandatory Requirements — required instruments & status

Legend: **Present** = page exists (evidence); **Missing** = not found; **Unknown — requires legal review** = existence insufficient without counsel sign-off.

- **LEG-1 Terms of Service** — **Present** (`app/(corporate)/terms/page.tsx`). MUST be kept consistent with actual service behavior (LEG-P1) and reviewed by counsel.
- **LEG-2 Privacy Policy** — **Present** (`app/(corporate)/privacy/page.tsx`, updated 2026-06-04, operator PRO MAX GROUP). MUST stay in sync with the WP2 data inventory and data-flow map, including disclosure that business-confidential prompt content is sent to AI providers (WP6 AI-8) and that documents are processed by Google Vision (WP2 §5).
- **LEG-3 Cookie Policy** — **Status resolved v1.1: essential-only, no third-party trackers** (Code Verified: zero matches for gtag/GTM/Mixpanel/PostHog/Amplitude/Segment/Hotjar/fbevents; cookies set only in OAuth flows `app/api/taxes/oauth/*`, `app/api/integrations/gmail/connect`). → A cookie-**consent banner is NOT legally required** for essential/functional cookies; a short **cookie disclosure** in the Privacy Policy (LEG-2) SUFFICES. `Immediately Enforceable` (disclosure). **Precondition:** if any non-essential/analytics cookie is later added, a Cookie Policy + consent mechanism become MUST (re-triggers WP2 consent).
- **LEG-4 AI Usage Policy** — **Missing**. Required given AI features (WP6). MUST disclose AI assistance, limitations, human-accountability, and prompt-data handling.
- **LEG-5 Payment & Subscription Terms** — **Missing/Unknown**. Required because payment flows exist (Cardcom/Tranzila). MUST define charges, billing, and provider roles. **Requires legal review**.
- **LEG-6 Refund Policy** — **Missing/Unknown**. Required where payments/subscriptions exist. **Requires legal review + product decision** on refund terms.
- **LEG-7 Acceptable Use Policy** — **Missing**. SHOULD define prohibited use; partial content may exist inside ToS (LEG-1) — **requires verification**.
- **LEG-8 Copyright / Trademark notices** — **Unknown — requires verification** (brand assets governed by `docs/dubiz-brand-book-v1.md`).
- **LEG-9 Security Statement** — **Missing** (public). Internal posture exists (`security-policy.md`, WP3); a public statement MAY summarize it. **Requires legal review** before publishing claims.
- **LEG-10 DPA (Data Processing Agreement)** — **Missing/Unknown**. For B2B customers whose data Dubiz processes, and vis-à-vis Dubiz's own sub-processors (WP5 CMP-11). **Requires legal review**.
- **LEG-11 SLA** — **Not required now**; flagged future (per `stability-and-production-readiness.md`).

## 5. Definition of Done (legal) — a user-facing/data/money change is NOT complete without

1. Every affected legal instrument identified and updated in the same release (LEG-P1).
2. No feature dependent on a missing instrument shipped (LEG-P2).
3. New data flows/processors reflected in the Privacy Policy (LEG-2, WP2/WP5).
4. New AI-user-facing behavior reflected in the AI Usage Policy once it exists (LEG-4).
5. Legal pages meet WP1 accessibility (LEG-P4).
6. Any text requiring counsel is flagged **Unknown — requires legal review**, not self-authored as binding.

## 6. Verification / Audit

- **LEG-V1** The Legal Review (WP7 DEV-4) is mandatory for PRs changing user-facing data handling, payments/subscriptions, disclosures, or public copy.
- **LEG-V2** A periodic **behavior↔document consistency check** (WP9 cadence) MUST confirm each instrument still matches system behavior; drift is a tracked gap.
- **LEG-V3** Instrument inventory (§4) MUST be re-reviewed whenever a new regulated capability (payments, AI, cookies, mobile) ships.

## 7. Remediation Guidance (risk order)

1. Reconcile the existing Privacy Policy + ToS with the WP2 inventory/data-flow map and WP6 AI disclosure (LEG-2) — highest legal-exposure, lowest cost.
2. Add **Payment/Subscription Terms + Refund Policy** before any production payment expansion (LEG-5/6) — **requires legal review + product decision**.
3. Add **AI Usage Policy** (LEG-4) and **Cookie Policy** if trackers are used (LEG-3).
4. Add **DPA** for B2B/sub-processors (LEG-10).
5. Verify cookie/tracker usage and copyright/trademark notices (LEG-3/8).

## 8. Enforcement & Classification Matrix (per WP9 §11–§13)

| Req | Classification | Enforcement | Evidence |
|-----|----------------|-------------|----------|
| LEG-1 ToS / LEG-2 Privacy Policy (exist) | Immediately Enforceable (consistency) | Legal Review + Manual Audit | Code Verified |
| LEG-2 sync with WP2 inventory + AI disclosure | Phase-in Required | Legal Review + Code Review | Code Verified |
| LEG-3 Cookie disclosure (essential-only) | Immediately Enforceable | Legal Review | Code Verified |
| LEG-4 AI Usage Policy | Phase-in Required | Legal Review | Assumption (needed given WP6) |
| LEG-5 Payment/Subscription Terms | Legal Review Required | Legal Review | Code Verified (payments exist) |
| LEG-6 Refund Policy | Legal Review Required + Product Decision Required | Legal + Product Review | Unknown |
| LEG-7 AUP | Phase-in Required | Legal Review | Unknown |
| LEG-8 Copyright/Trademark | Product Decision Required | Legal Review | Unknown |
| LEG-9 public Security Statement (+ breach ref WP3 SEC-20) | Phase-in Required | Legal Review | Legal Source |
| LEG-10 DPA (processor per WP2 §4a) | Legal Review Required | Legal Review | Architecture Decision |
| LEG-11 SLA | Future Requirement | Legal Review | Assumption |
| Accessibility statement text (WP1 A-21) | Phase-in Required | Legal Review | Legal Source |

## 9. Exception Process

Exceptions to any LEG-requirement follow **WP9 §14**. Because legal text is `Legal Review Required`, any waiver that ships a feature ahead of its required instrument MUST carry counsel approval and a hard expiry.

## 10. Future Compatibility

- **Marketplace:** seller/marketplace terms, marketplace liability, and PCI-scope escalation → **Future Requirement** (new instruments).
- **Mobile:** App Store / Play legal disclosures + in-app purchase terms → **Future Requirement** (ties WP5 CMP-9).
- **Public API:** API Terms of Use + developer agreement → **Future Requirement**.
- **Enterprise:** MSA/DPA/SLA for enterprise contracts → extends LEG-10/LEG-11.
- **Multi-currency / Multi-region:** foreign consumer-protection + cross-border terms → **Future Requirement**.
- **AI Agents:** autonomous-action disclosures + liability terms → **Future Requirement** (ties WP6).

## 11. Changelog (v1.1)

- **LEG-3 resolved to essential-only cookies (Code Verified)** — *resolves:* Review §4 Unknown (cookies); consent banner not required, disclosure suffices.
- **Added cross-references** to WP3 SEC-20/21 breach notification (public Security Statement, LEG-9) and WP1 A-21 accessibility statement (legal text ownership).
- **Added §8 matrix, §9 exception ref, §10 Future Compatibility, Status/phase-in header** (WP9).
- **Status → Candidate for Ratification** (note: legal *text* remains Legal Review Required — the constitution is ratifiable; the instruments it mandates are not yet drafted).

## 12. References (sources of truth — not duplicated here)

- `app/(corporate)/privacy/page.tsx`, `app/(corporate)/terms/page.tsx` — existing public instruments.
- [privacy-constitution-v1.md](privacy-constitution-v1.md) (WP2), [compliance-frameworks-constitution-v1.md](compliance-frameworks-constitution-v1.md) (WP5), [ai-constitution-v1.md](ai-constitution-v1.md) (WP6), [security-constitution-v1.md](security-constitution-v1.md) (WP3), [accessibility-constitution-v1.md](accessibility-constitution-v1.md) (WP1).
- `docs/dubiz-brand-book-v1.md` — brand/trademark assets.
- [compliance-constitution-system-audit-v1.md](compliance-constitution-system-audit-v1.md) — findings & status.
