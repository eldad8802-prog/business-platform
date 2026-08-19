# Compliance Implementation Master Plan v1

**Status:** Draft v1 — the engineering work-plan that turns the **Ratified** constitution into a built system.
**Date:** 2026-07-02
**Governs:** how Dubiz implements the ratified Compliance Constitution family (WP1–WP9, ratified 2026-07-02 per GOV-1).
**Constraint (this phase):** planning only. **No code, no PR, no new CI, no DoD change** until this plan is approved. Execution then proceeds in small waves (§10).

> This plan does not create or alter any requirement — the constitutions are frozen (WP9 GOV-16). It **sequences the existing `Phase-in Required` obligations and open gaps (G-1…G-26) into buildable workstreams.**

---

## 1. Executive Summary

The constitution is ratified and is now the Source of Truth. Its requirements bind **new development immediately** (WP9 §10 New-Development Scope); **legacy surfaces are grandfathered** with scheduled remediation — **except current legal duties and P0 security, which are not grandfathered** (GOV-10c, SEC-9).

Implementation is therefore two tracks running in parallel:
- **Track A — Enablement (make the gate real):** the mechanisms the constitution *assumes* but that don't exist yet — the PR compliance block (WP7), the CI/lint gates, and the shared primitives (a11y, blind-index, provenance). Until these land, "Immediately Enforceable" requirements are enforced only by manual review. **Track A is the highest-leverage work** — it converts prose into automated prevention.
- **Track B — Remediation (close the gaps):** the 26 tracked gaps, sequenced P0→P3 by risk, each closed in a small verify-then-review-then-ship wave.

The single most important early moves: **P0 secret rotation (G-1)**, the **PR compliance template (G-15)**, and the **`eslint-plugin-jsx-a11y` CI gate (G-7)** — together they stop *new* debt on day one. The heaviest legal-exposure items (accessibility remediation, privacy data-subject rights, breach-notification process) follow immediately, gated where necessary on the legal/product determinations already identified.

After all workstreams complete, a **Compliance Freeze Audit** (§13) establishes the constitution-vs-code-vs-behavior baseline for Dubiz's future.

---

## 2. Current Compliance Status (baseline at ratification)

Evidence-based, from the System Audit (G-1…G-26) + Validation. "The system," not the documents.

- **Strong / implemented:** multi-tenant isolation (query + crypto AAD), payments authority model (signal≠authority), billing immutability + audit trail, credential-at-rest encryption (WhatsApp/payment/authority), OAuth state+PKCE, SHAAM export (certified-not-registered), pipeline durability (as code convention, now to be constitutionalized).
- **Missing mechanisms (Track A):** no PR compliance gate, no `eslint-plugin-jsx-a11y`, no shared a11y primitives, no provenance field, no blind-index, no consent/erasure/export machinery, no incident-response process, no security headers, no processor/DPA inventory.
- **Not grandfathered (must act regardless):** G-1 secret rotation (P0 ops); current legal duties — breach notification (SEC-20/G-20), accessibility statement *if legally applicable* (A-21/A-22/G-19), data-subject rights (P-10c).
- **Blocked on external determinations:** lawful basis, controller/processor confirmation, DPO/large-DB, GDPR scope, PCI SAQ, cross-border/residency, Google CASA — all `Legal Review Required` / `Product Decision Required` (advisory until resolved; do not block ratification, do gate specific builds).

---

## 3. Workstreams

Each workstream: **Scope · Deliverables · Dependencies · Estimated Complexity · Blocking/Non-blocking · Owner (placeholder).** Complexity = S/M/L/XL (relative effort, not calendar). "Blocking" = blocks a Production Readiness Gate.

### WS-1 Accessibility (owner: `TBD — A11y lead`)
- **Scope:** WP1 across Product UI + Corporate site. Gaps G-7/8/9 (+ G-19 legal-gated).
- **Deliverables:** (a) install `eslint-plugin-jsx-a11y` + CI gate; (b) shared primitives — `useAccessibleDialog` (focus trap/restore/Escape/inert), skip-link, reduced-motion utility, accessible-field wrapper (A-18); (c) retrofit dialogs (Secretary capture sheet, MovementModal) to A-11; (d) retrofit forms to A-15; (e) global `:focus-visible` baseline + reduced-motion sweep; (f) contrast-verify `lib/design/tokens.ts`; (g) accessibility statement page + coordinator **if legally applicable** (gated on WS-4).
- **Dependencies:** WS-6 (CI) for the lint gate; WS-4 (legal) for G-19 applicability.
- **Complexity:** L. **Blocking** (legal exposure; DoD gate for UI). 

### WS-2 Privacy (owner: `TBD — Privacy/Data lead + counsel`)
- **Scope:** WP2 data-subject-rights machinery + retention. Gaps G-2/3/4/5/6/12.
- **Deliverables:** (a) **lawful-basis map + controller/processor determination** (with counsel) — *precedes consent build*; (b) consent record + capture/withdrawal **only if** consent is the basis; (c) right-to-erasure workflow (routed per §4a role; honors legal-retention; audited); (d) retention policy + TTL/purge for messages/conversations/stale imports; (e) full export (CRM/messages/account); (f) sensitive-read auditing (P-12a MUST for rights surfaces); (g) PII-at-rest for operational stores (shared with WS-3 blind-index).
- **Dependencies:** counsel (lawful basis, roles); WS-3 (encryption/blind-index); WS-11 (processor/DPA inventory).
- **Complexity:** XL. **Blocking** (Amendment-13 duties).

### WS-3 Security (owner: `TBD — Security lead`)
- **Scope:** WP3. Gaps G-1/10/11/16/20/22/23/24/26 + SEC-18/Tranzila/key-rotation.
- **Deliverables:** (a) **G-1 rotate `.env` secrets + managed store (P0, not waivable)**; (b) server-side session revocation (D1) + logout invalidation; (c) blind-index/deterministic-encryption for `phone`/`taxId` operational stores (SEC-11) — shared with WS-2; (d) Gmail token AAD binding (G-26) + legacy `enc_v0:` sweep (G-16); (e) **incident-response/breach-notification process (SEC-20, current legal duty — timed)**; (f) **SEC-24 persist-before-enrichment durability + verify-test**; (g) security headers (SEC-18); (h) Tranzila webhook verification hardening; (i) intra-business roles (SEC-6, product-gated); (j) backups/DR governance (SEC-22, + erasure coupling with WS-2); (k) vulnerability-disclosure channel (SEC-23); (l) key-rotation policy (SEC-12); (m) SEC-19 audit-event coverage for enumerated actions.
- **Dependencies:** WS-11 (secret store infra); WS-2 (erasure↔backups, blind-index); counsel (breach timing, SAQ).
- **Complexity:** XL. **Blocking** (P0 + current legal duty subset).

### WS-4 Legal (owner: `TBD — Legal counsel`)
- **Scope:** WP4 + the `Legal Review Required` determinations feeding other WS. Gaps G-18 + determinations.
- **Deliverables:** (a) determinations: lawful basis, controller/processor, DPO/large-DB, GDPR scope, PCI SAQ, cross-border basis, A-21/A-22 threshold applicability; (b) instruments: reconcile Privacy Policy/ToS with actual behavior, AI Usage Policy, Payment/Subscription Terms, Refund Policy, DPA, cookie disclosure, public Security Statement; (c) breach-notification timing/obligations input to WS-3.
- **Dependencies:** none internal (upstream of many WS); external counsel availability.
- **Complexity:** L. **Blocking** for the builds it gates (consent, DPA, payment terms, A-21/A-22); **Non-blocking** for ratification (already done).

### WS-5 AI (owner: `TBD — AI/Content lead`)
- **Scope:** WP6. Gap G-14 + AI-4/AI-7 mechanisms.
- **Deliverables:** (a) **provenance field** on AI output data-contract (AI-7 precondition); (b) AI-assisted marker on persisted/consequential surfaces (drafts exempt); (c) gate the 4 legacy OpenAI clients + the "no `new OpenAI(` outside gated service" lint (AI-4); (d) prompt-data classification/scrubber + test for LLM calls (AI-2); (e) keep AI-provider inventory current (AI-V2); (f) generalize output-validation guard (AI-P5).
- **Dependencies:** WS-6 (lint/CI); WS-2 (PII-in-prompt policy).
- **Complexity:** M. **Non-blocking** (drafts exempt; interim Privacy Review) — except the ungated-client lint which is cheap and high-value.

### WS-6 Development Workflow (owner: `TBD — Eng lead`)
- **Scope:** WP7 — the per-PR gate. Gap G-15.
- **Deliverables:** (a) **PR template with the Compliance Verification block** (DEV-1…DEV-5, split automated vs judgement per DEV-15); (b) review rubrics for the judgement items (DEV-14); (c) the DEV-13 mechanizable-checks backlog handed to WS-7.
- **Dependencies:** none (pure process artifact). **Highest leverage.**
- **Complexity:** S. **Blocking** (this *is* the anti-drift gate).

### WS-7 CI/CD (owner: `TBD — DevEx/Platform lead`)
- **Scope:** the mechanizable gates (WP7 DEV-6/7/8/13). Gaps enforcement for G-7 etc.
- **Deliverables (each a CI/lint check):** typecheck+lint+tests (exists); `eslint-plugin-jsx-a11y` (G-7); secret-scan (SEC-8); expand-only migration check (DEV-8); "no `new OpenAI(` outside gated service" (AI-4); "no new PII-bearing table without a Data-Inventory entry" schema-diff (P-8); security-header presence check (SEC-18); SEC-24 durability verify-test; customer-PII-to-LLM test (AI-2); link-integrity check for governance docs (DOC-V2).
- **Dependencies:** WS-6 (defines what to enforce); each owning WS (defines the rule).
- **Complexity:** L. **Blocking** (converts MUSTs into prevention).

### WS-8 Corporate Website (owner: `TBD — Web lead`)
- **Scope:** `app/(corporate)/*`. SEC-18 headers, A11y, legal pages, public access class.
- **Deliverables:** (a) security headers via `next.config`/middleware (SEC-18); (b) a11y baseline (skip-link, landmarks, contrast) per WS-1; (c) accessibility statement + coordinator page **if applicable** (WS-4); (d) cookie disclosure + link the missing legal instruments (WS-4); (e) any public form uses the SEC-4 public/unauthenticated pattern (rate-limit, no tenant data).
- **Dependencies:** WS-1, WS-3 (headers), WS-4 (legal pages).
- **Complexity:** M. **Blocking** (security headers + current-legal-duty pages).

### WS-9 Product UI (owner: `TBD — Frontend lead`)
- **Scope:** authenticated app screens (Secretary, Inbox, Inventory, Billing, Settings). A11y + AI markers.
- **Deliverables:** (a) adopt WS-1 primitives across new/changed screens; (b) retrofit the worst legacy dialogs/forms (capture sheet, MovementModal) on next material change; (c) surface AI-assisted markers (WS-5); (d) reduced-motion compliance.
- **Dependencies:** WS-1 (primitives), WS-5 (provenance).
- **Complexity:** L. **Non-blocking** for legacy (grandfathered); **Blocking** for new screens.

### WS-10 Backend/API (owner: `TBD — Backend lead`)
- **Scope:** API routes, services. Tenant-scoping, public class, encryption, audit, durability, webhooks, revocation.
- **Deliverables:** (a) enforce SEC-4 three-class scoping on new endpoints; (b) blind-index read/write path (WS-3); (c) audit events for enumerated actions (SEC-19); (d) SEC-24 persist-before-enrichment on all ingestion paths; (e) session-revocation backend (WS-3); (f) Tranzila webhook verify; (g) SHAAM production-identity guard (CMP-13).
- **Dependencies:** WS-3, WS-2.
- **Complexity:** L. **Blocking** (durability, isolation).

### WS-11 Infrastructure (owner: `TBD — Platform/Infra lead`)
- **Scope:** secret store, backups/DR, monitoring, rate-limiter tuning, data residency.
- **Deliverables:** (a) **managed secret store + rotation (P0, with WS-3 G-1)**; (b) backup/DR posture + documented restore (SEC-22); (c) rate-limiter timeout tuning + health-check (SEC-17 Upstash lesson); (d) processor region inventory for cross-border/residency (CMP-12); (e) monitoring/alerting for breach-relevant events (SEC-19/SEC-20).
- **Dependencies:** WS-4 (residency legal basis).
- **Complexity:** L. **Blocking** (P0 secret rotation).

### WS-12 Documentation (owner: `TBD — Docs/Governance owner`)
- **Scope:** WP8 + keeping the audit and inventories current.
- **Deliverables:** (a) **processor/DPA inventory** artifact (WP5 CMP-11) + **data-flow map** artifact (WP2 §5) — currently prose only; (b) retention-policy document (per-category periods, with WS-4); (c) keep the System Audit rolling status current as gaps close; (d) terminology register (DOC-9); (e) Exception Register with expiry dates for current-legal-duty phase-ins.
- **Dependencies:** WS-2/WS-4 (inventory content).
- **Complexity:** M. **Non-blocking** (but DOC-V3 keeps the audit truthful — required for the Freeze Audit).

---

## 4. Execution Phases

| Phase | Theme | Contents |
|-------|-------|----------|
| **P0** | Stop the bleeding + turn on the gate | G-1 secret rotation (WS-3/WS-11); PR compliance template (WS-6); `eslint-plugin-jsx-a11y` + secret-scan CI (WS-7); assign owners (GOV-8); open Exception Register with expiries (WS-12); kick off counsel engagement (WS-4). |
| **P1** | Highest exposure + current legal duties | A11y primitives + form/dialog retrofit + tooling (WS-1/9); privacy lawful-basis→consent/erasure/retention (WS-2, after WS-4 determinations); breach-notification/incident-response process (WS-3); SEC-24 durability gate (WS-3/7/10); security headers (WS-3/8); Google CASA planning (WS-4). |
| **P2** | Complete rights + security surface | Full export, access audit, PII blind-index (WS-2/3); session revocation, Tranzila hardening, backups/DR (WS-3/11); processor/DPA inventory + data-flow map (WS-12); AI provenance+scrubber+gating (WS-5); legal instruments — AI usage/payment/refund/DPA (WS-4). |
| **P3** | Hardening + completeness | Intra-business roles (WS-3); legacy Gmail token sweep + AAD (WS-3); vuln-disclosure (WS-3); key-rotation policy (WS-3); SHAAM prod guard (WS-10); cross-border/residency (WS-11/4); Backlog v2 simplification (Governance). |

Phases are risk-ordered, not calendar-bound. A later-phase item MAY start early if it is cheap and unblocked (e.g. vuln-disclosure `security.txt`).

---

## 5. CI Enforcement Matrix

How each obligation is actually enforced (per WP9 §12; DEV-13 mechanizable vs DEV-14 judgement). "—" = not applicable to that channel.

| Obligation | CI | Lint | Code Review | Audit | Business Decision | Legal Review |
|-----------|----|------|-------------|-------|-------------------|--------------|
| jsx-a11y (A-16) | ✅ block | ✅ | ✅ | — | — | — |
| Secrets not in source (SEC-8) | ✅ secret-scan | — | ✅ | — | — | — |
| Expand-only migrations (DEV-8) | ✅ | — | ✅ | — | — | — |
| No LLM call outside gated service (AI-4) | ✅ (lint in CI) | ✅ | ✅ | — | — | — |
| New PII table ⇒ inventory entry (P-8) | ✅ schema-diff | — | ✅ | ✅ | — | — |
| Security headers present (SEC-18) | ✅ header-check | — | ✅ | — | — | — |
| Persist-before-enrichment (SEC-24) | ✅ verify-test | — | ✅ | — | — | — |
| Customer-PII-to-LLM prohibited (AI-2) | ✅ test | — | ✅ | — | — | ✅ (borderline) |
| Tenant-scoping / 3 access classes (SEC-4) | ⚠️ partial (isolation tests) | — | ✅ | ✅ | — | — |
| AI-assisted marker (AI-7) | ⚠️ after provenance field | ✅ component-prop | ✅ | — | ✅ (exemptions) | — |
| Data-subject rights machinery (WP2 §6) | ✅ tests | — | ✅ | ✅ | ✅ (retention periods) | ✅ (lawful basis) |
| Incident-response process (SEC-20) | — | — | ✅ | ✅ | — | ✅ (notify timing) |
| Accessibility statement (A-21/22) | — | — | ✅ | ✅ | ✅ (coordinator) | ✅ (applicability) |
| Intra-business roles (SEC-6) | ✅ tests | — | ✅ | — | ✅ (role model) | — |
| Processor/DPA inventory (CMP-11) | — | — | ✅ | ✅ | — | ✅ (DPA) |
| Google CASA (CMP-5/6) | — | — | — | ✅ | ✅ (budget) | ✅ |
| PCI SAQ / cross-border (CMP-10/12) | — | — | — | ✅ | — | ✅ |
| Per-PR Compliance block (DEV-1..5) | ⚠️ template presence | — | ✅ (the gate) | ✅ (sampling) | — | — |

Judgement items (no full CI) are enforced by **Code Review against a rubric** (DEV-14) + **periodic Audit sampling** (GOV-9) — honestly labeled, not pretend-automated (DEV-15).

---

## 6. Success Criteria (system complies, not just docs)

The system is constitution-compliant when **all** of:
1. **Track A live:** PR compliance block enforced; all §5 CI/lint gates green and blocking; shared primitives (a11y, blind-index, provenance) exist and are used.
2. **No un-timed current-legal-duty gaps:** every SEC-20/A-21-22/P-10c item is either done or has a live Exception-Register entry with a future expiry (GOV-10c).
3. **Data-subject rights operational:** a real erasure/export/access request can be fulfilled end-to-end, audited, routed per controller/processor role.
4. **P0 closed:** secrets rotated + managed store; no secret in source (CI-proven).
5. **Durability proven:** SEC-24 verify-test passes on every ingestion path; an induced enrichment failure never loses an artifact.
6. **Isolation proven:** SEC-4 three-class scoping holds; isolation tests cover new surfaces; no public endpoint touches tenant data.
7. **Legal instruments match behavior:** Privacy Policy/ToS reconciled; required instruments published; processor/DPA inventory current.
8. **Audit is truthful:** the System Audit shows every G-item closed or as a tracked, timed exception — verified by the Freeze Audit (§13).

Per-workstream success = its Deliverables shipped + verified + its CI gate green + its DoD items enforced on new code.

---

## 7. Risk Register

| ID | Risk | Likelihood | Impact | Mitigation |
|----|------|-----------|--------|-----------|
| R-1 | Legal determinations delay privacy/consent build (they gate WS-2) | High | High | Start counsel engagement in P0; build role-agnostic scaffolding meanwhile; don't build consent before lawful basis (m-6) |
| R-2 | Google CASA lead-time (weeks, paid) risks Gmail suspension | Med | High | P1 planning + budget decision now; treat as external deadline in Exception Register |
| R-3 | Blind-index migration on `phone`/`taxId` risks breaking Party Resolution/billing | Med | High | Prototype behind flag; dual-read; verify dedupe parity before cutover; statutory-record carve-out already prevents touching legal snapshots |
| R-4 | Secret rotation (G-1) causes integration outage if mis-sequenced | Med | High | Rotate per-provider with staged validation; never big-bang; verify each integration post-rotation |
| R-5 | Fail-closed rate-limiter tuning repeats the Upstash outage | Med | Med | SEC-17 timeout-tolerance guidance; health-check; canary |
| R-6 | Retrofitting legacy a11y at scale is large; risk of scope creep | High | Med | Grandfather legacy (WP9 §10); enforce only on new/changed; retrofit worst dialogs first |
| R-7 | The gate becomes rubber-stamped (M-6 risk) | Med | High | DEV-15 template honesty (automated vs judgement); audit sampling; mechanize as much as possible (WS-7) |
| R-8 | Owners unassigned → workstreams stall | High | High | GOV-8 owner assignment is a P0 exit criterion |
| R-9 | Provenance field (AI-7) touches shared content data-contract | Low | Med | Additive field; drafts exempt; no behavior change |

---

## 8. Rollout Strategy

- **Wave-based, per the owner's rule:** each wave = **Implementation → Verification → Compliance Review → Production Readiness → next wave.** No wave starts before the prior passes its Production Readiness Gate (§11).
- **Track A (enablement) waves first** — they make every later wave enforceable and cheap to verify.
- **Small, reversible slices:** prefer additive migrations (expand-only, DEV-8), feature flags, and dual-read/dual-write for risky data changes (blind-index, encryption).
- **Legacy vs new discipline:** every wave enforces the requirement on new/changed code; legacy remediation is a separate, scheduled backlog so waves stay small.
- **Current-legal-duty items are timed** (Exception Register) so they cannot silently slip.

---

## 9. Verification Strategy

- **Automated:** CI gates (§5) + `*.verify.test.ts` for isolation, durability (SEC-24), rights-machinery, blind-index dedupe parity. jest-axe/Playwright-axe for a11y critical flows.
- **Manual:** WP1 §6 QA checklist for UI; keyboard + screen-reader passes on top flows; Privacy/Security/Legal reviews per WP7 rubrics.
- **Evidence discipline:** every "done" claim cites the test/PR/artifact (Evidence-First carries into implementation). No workstream is "done" on assertion.
- **Per-wave Compliance Review:** the WP7 block is filled and verified for the wave's changes before Production Readiness.

---

## 10. Execution Model (waves) — for reference after approval

Each wave carries: scope (small), the WS it advances, its verification plan, its Production Readiness Gate, and its rollback. Suggested first waves (illustrative, not yet started):
- **W0:** owners + PR template + secret-scan/jsx-a11y CI + secret rotation (P0).
- **W1:** a11y primitives + one exemplar screen retrofit + jsx-a11y enforcement.
- **W2:** privacy determinations (counsel) landing → erasure/export scaffolding.
- **W3:** SEC-24 durability gate + incident-response process.
- … subsequent waves per P2/P3.

---

## 11. Production Readiness Gates

A change/wave reaches production only when:
1. Its CI gates (§5) are green and blocking.
2. Its Verification (§9) passed — automated + manual as applicable.
3. Its WP7 Compliance Verification block is complete and reviewed (no blank/unjustified review).
4. No new **current-legal-duty** gap is introduced un-timed (GOV-10c).
5. Expand-only migration confirmed (DEV-8); rollback defined.
6. Documentation updated (DOC-5) and the System Audit reflects the change (DOC-V3).
7. For data-touching waves: data-subject-rights impact considered; inventory/data-flow map updated.

---

## 12. Ownership & Governance interface

- Owners are placeholders (`TBD`) until GOV-8 assignment (a P0 exit criterion).
- **No requirement changes during implementation.** New gaps discovered while building go to **Constitution Backlog v2** (GOV-17), never patched into the ratified v1.x — unless a fundamentally new failure triggers GOV-18 emergency amendment.
- The Exception Register (WP9 §14) tracks every timed current-legal-duty phase-in and every waiver.

---

## 13. Post-Implementation — Compliance Freeze Audit (owner-recommended; NOT now)

After all workstreams complete, run a **Compliance Freeze Audit** — the first full three-way comparison:
- **Constitution** (what is required) ↔ **Code** (what is implemented) ↔ **Behavior** (what the running system actually does).
This produces Dubiz's **compliance Baseline** — the reference against which every future change is measured. It is scheduled as the final Production Readiness Gate of the whole initiative, not part of any build wave, and feeds the ongoing GOV-9 quarterly audit cadence.

---

## 14. References
- Ratified constitutions: WP1–WP9 (docs/*-constitution-v1.md).
- [System Audit](compliance-constitution-system-audit-v1.md) (G-1…G-26) · [Validation Report](compliance-constitution-validation-report-v1.md) · [v1.2 Closure Report](compliance-constitution-v1_2-closure-report.md) · [Backlog v2](compliance-constitution-backlog-v2.md) · [Ratification Recommendation](compliance-constitution-ratification-recommendation-v1.md).
