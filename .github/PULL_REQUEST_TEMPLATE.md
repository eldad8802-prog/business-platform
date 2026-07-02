<!--
Dubiz Compliance Verification block — required by the ratified Development Constitution (WP7, DEV-1…DEV-5, DEV-15).
Source of truth: docs/development-constitution-v1.md. Do not delete this block.
Fill every applicable review with: Pass (what you checked) / N/A (one-line reason) / Tracked gap (owner + link).
Legacy note (WP9 §10): existing surfaces are grandfathered — you must comply for the CODE YOU CHANGE, not rewrite the whole surface.
-->

## What & why
<!-- Short description of the change and its purpose. -->

## Surfaces touched (check all that apply → determines which reviews are required)
- [ ] UI / screens / components  → Accessibility Review
- [ ] Personal data (collect / store / derive / share) → Privacy Review
- [ ] Auth / authz / secrets / encryption / integrations / file handling / endpoints → Security Review
- [ ] User-facing data handling / payments / subscriptions / disclosures / public copy → Legal Review
- [ ] Regulated domain (tax-billing / payments / a Google/Meta scope / OAuth) → Compliance Review
- [ ] Database schema / migration
- [ ] AI / LLM call

---

## Compliance Verification (WP7 DEV-1…DEV-5)
> For each applicable review: `Pass` (cite what you checked) · `N/A` (one-line reason) · `Tracked gap` (owner + issue link). An unexplained Pass/N/A is not acceptable (DEV-V1).

- **Accessibility (WP1):** <!-- Pass/N/A/Tracked — jsx-a11y clean on changed files; A-9/10/11/12/15 for new controls/dialogs/forms; reduced-motion; RTL -->
- **Privacy (WP2):** <!-- Pass/N/A/Tracked — the seven questions (§2); inventory/data-flow updated (P-8/P-9); no customer PII to LLM; retention considered -->
- **Security (WP3):** <!-- Pass/N/A/Tracked — tenant-scoped (SEC-4 class); fail-closed; secrets not in source; new sensitive-at-rest encrypted; webhooks verified; audited -->
- **Legal (WP4):** <!-- Pass/N/A/Tracked — instruments in sync with behavior; nothing shipped ahead of a required disclosure -->
- **Compliance (WP5):** <!-- Pass/N/A/Tracked — framework/owner identified; new processor → inventory+DPA; new Google/Meta scope flagged; tax/billing routed to frozen family -->

## Automated gates (DEV-6/7/8 — must be green; DEV-15: these are machine-checked, not attested)
- [ ] Type-check · lint · tests pass
- [ ] No secrets in source / committed config (`.env*` git-ignored)
- [ ] DB change is expand-only / backward-compatible (production-migration-runbook)
- [ ] `eslint-plugin-jsx-a11y` clean on changed files *(once the gate lands; interim: manual a11y QA)*

## Domain non-negotiables (DEV-9…DEV-12 — if touched)
- [ ] Billing: no mutation of issued invoices, numbering intact, auditability preserved
- [ ] Payment-Secretary / Obligations: no new financial source of truth (outbound-only)
- [ ] Secretary behavior conforms to the canonical behavior model
- [ ] UI/flow conforms to stage-aware flow + Frame / Archetype / Visual-Language

## Tracked gaps introduced (if any)
> Anything not closed in this PR (WP9 §14 Exception Register): rule · owner · **expiry date** · link. Current legal duties MUST be timed (GOV-10c). New constitution gaps → Constitution Backlog v2, never patched into v1.x (GOV-17).

- 

## Docs updated (DEV-DoD #5 / DOC-5)
- [ ] Behavior/architecture change reflected in the canonical doc(s); System Audit updated if a gap changed
