# Compliance Constitution — Ratification Recommendation v1

**Status:** Draft v1 — final recommendation of the Review & Ratification phase
**Date:** 2026-07-02
**Inputs:** the v1.1 constitutional package (WP1–WP9 + System Audit + Final Report), the first independent [Review & Ratification Report](compliance-constitution-review-ratification-report-v1.md), the v1.1 remediation pass, and a **second independent review** (fresh-eyes auditor) of v1.1 plus its v1.1a fixes.
**Method:** evidence-based. The verdict is chosen strictly on what two independent reviews found and what the v1.1/v1.1a passes demonstrably resolved — not on a desire to progress.

---

## 1. Recommendation

> ## ✅ Ready with Conditions

**Not** "Ready for Ratification" (unconditional), because ratification still depends on owner sign-off, named owners, and several external legal/product determinations that document editing cannot resolve. **Not** "Major Revision Required" or "Not Ready", because both independent reviews confirm the framework is structurally sound and every Critical/Major finding has been resolved and verified cross-document. The conditions in §4 are **bounded and mostly external** — none requires re-architecting the constitutions.

---

## 2. Evidence basis for the verdict

Two independent adversarial reviews were run by auditors who did not write the documents:

**First review** found 3 Critical, 9 Major, 7 Minor. The v1.1 pass resolved them; the **second review verified**:
- **C-1** (encrypt-vs-lookup) → **RESOLVED**, and confirmed *consistent across both* WP2 P-6 and WP3 SEC-11 (same identifiers, same blind-index mechanism, same single owner). Called "the cleanest fix in the package."
- **C-2** (phase-in) → **RESOLVED** via WP9 §10 legacy/new-scope model.
- **C-3** (controller/processor) → **RESOLVED** via WP2 §4a (+ P-8a/P-8b), consistent with WP4 LEG-10 and WP5 CMP-11.
- **M-1** (breach process), **M-5/M-6** (measurability + mechanizable-vs-judgement), **M-7** (platform-admin carve-out), **M-8** (P-12 split), **M-9** (untimed gap, for SEC-3), **m-1** (single owner), **m-6** (lawful-basis-before-consent) → all **RESOLVED**.
- Taxonomies used consistently across all matrices; no disguised weakenings found (LEG-3 cookie downgrade verified as evidence-driven, not a weakening).

**Second review** then found 3 residual Majors + 2 Minors from uneven application of the *new* v1.1 machinery. These were fixed in **v1.1a**:
- **MAJOR-1** (G-22 backups/DR & G-23 vuln-disclosure were ownerless) → **fixed:** WP3 SEC-22/SEC-23 now own them; erasure↔backup coupling stated.
- **MAJOR-2** (current legal duties SEC-20 / A-21 / A-22 phased-in with no expiry — the M-9 loophole re-appearing) → **fixed:** new **WP9 GOV-10c** ("current legal duties are NOT grandfathered; mandatory expiry required"), applied to SEC-20, A-21, A-22.
- **MAJOR-3** (WP1 matrix bundled always-applicable MUSTs with primitive-dependent ones) → **fixed:** rows un-bundled (A-3 vs A-4; A-9/A-10/A-12/A-14 Immediately Enforceable vs A-11/A-13 Phase-in).
- **MINOR-1** (WP2 current rights phased-in without expiry) → **fixed:** Rule P-10c.
- **MINOR-4** (compound classifications vs "exactly one") → **fixed:** WP9 §11 now permits ordered `A → B` compounds.

**Consistency of record:** all inter-document links resolve; GOV-10c is defined in WP9 and propagated to WP1/WP2/WP3; all nine constitutions carry `Candidate for Ratification` status. The earlier overstated "no contradictions found" claim was corrected (m-7).

**Net:** every Critical and Major from both reviews is resolved and verified. No structural rework remains. That is the definition of "Ready with Conditions," not "Major Revision."

---

## 3. What is genuinely settled

- The 9-constitution framework + rolling System Audit is internally consistent, cross-referenced, and free of the contradictions the reviews surfaced.
- The C-1 architectural impossibility is resolved with a real mechanism (searchable encryption / blind index), single-owned by WP3.
- Ratification will **not** freeze development: WP9 §10 grandfathers legacy scope while binding new development — with GOV-10c ensuring current legal duties are *not* hidden behind open-ended phase-ins.
- Every requirement is classified (5-way) and mapped to an enforcement method + evidence tier; the anti-drift gate honestly separates automated checks from rubric-backed human review (WP7 §4.4).

---

## 4. Conditions for ratification (must be met at/*before* sign-off)

These are the reasons the verdict is *conditional*. Each is classified so it is clear whether it blocks ratification or is carried as advisory.

### 4.1 Governance conditions (block unconditional ratification — cheap, internal)
1. **Owner sign-off (WP9 GOV-1)** — the family is `Candidate`; ratification is an explicit approval act. `Product Decision Required`.
2. **Named owners per constitution (WP9 GOV-8)** — currently `Unknown`. `Product Decision Required`.
3. **Open the Exception Register and set mandatory expiry dates** for every current-legal-duty phase-in: SEC-20 (breach process), A-21/A-22 (accessibility statement/coordinator), and the WP2 current rights (P-10c). Per GOV-10c these cannot ratify as open-ended.

### 4.2 Operational condition (independent of ratification)
4. **P0 secret rotation (G-1 / SEC-9)** — rotate the live `.env` secrets + managed store. Not waivable; not blocked by ratification but should be done immediately.

### 4.3 External determinations (do NOT block ratification — correctly classified as advisory-until-resolved)
The framework is designed so these are held as `Legal Review Required` / `Product Decision Required` and are advisory until resolved; ratification proceeds with them tracked:
- **Legal Review Required:** controller/processor confirmation (WP2 §4a), lawful-basis map (P-3), DPO / large-sensitive-DB determination, GDPR applicability (CMP-2), PCI SAQ class (CMP-10), cross-border transfer basis (CMP-12), breach-notification timing (SEC-21), legal instrument text (WP4 LEG-4/5/6/10).
- **Product Decision Required:** retention periods (P-11), intra-business role model (SEC-6), accessibility-coordinator identity (A-22), Google CASA budget/timing (CMP-5/6).

### 4.4 Scheduled build backlog (post-ratification, per each constitution's remediation section)
The `Phase-in Required` items (a11y tooling/primitives, consent/erasure/export/retention, PII blind-index, session revocation, security headers, incident-response process, backups/DR, vuln-disclosure, processor/DPA inventory) become the implementation backlog once ratified — with current-legal-duty items carrying GOV-10c expiries.

---

## 5. Path to unconditional "Ready for Ratification"

1. Assign owners (GOV-8) and obtain sign-off (GOV-1).
2. Populate the Exception Register with the current-legal-duty expiries (§4.1.3).
3. Action P0 secret rotation (§4.2).
4. Kick off the legal-counsel engagement for the §4.3 determinations (they don't block ratification but gate several build items).

Once §4.1 is done, the family flips to `Ratified` (WP9 §9) and the Initiative moves to the implementation phase (CI, PR template, Definition-of-Done wiring) — **which remains out of scope until ratification, per the owner's instruction.**

---

## 6. References

- Reviewed package: [System Audit](compliance-constitution-system-audit-v1.md); WP1 [Accessibility](accessibility-constitution-v1.md), WP2 [Privacy](privacy-constitution-v1.md), WP3 [Security](security-constitution-v1.md), WP4 [Legal](legal-constitution-v1.md), WP5 [Compliance](compliance-frameworks-constitution-v1.md), WP6 [AI](ai-constitution-v1.md), WP7 [Development](development-constitution-v1.md), WP8 [Documentation](documentation-constitution-v1.md), WP9 [Governance](governance-constitution-v1.md).
- [Review & Ratification Report](compliance-constitution-review-ratification-report-v1.md) (first review + findings register).
- [Initiative Final Report](compliance-constitution-initiative-final-report-v1.md).
