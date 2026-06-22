<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:system-wide-ux-rules -->
# System‑wide UX rule (MANDATORY): Stage‑aware product flow

This is a **system‑wide requirement** for every screen/flow (Billing, Documents, OCR review, Inventory, Supplier Purchases, Inbox, Content, Revenue, Pricing, Business Status, and any future flows).

Rule doc: `docs/system-wide-ux-stage-aware-product-flow.md`
<!-- END:system-wide-ux-rules -->

<!-- BEGIN:billing-compliance-rules -->
# Billing Compliance rule (MANDATORY): Tax authority readiness

Every Billing/Invoices change must follow the compliance source of truth in `docs/billing-compliance-tax-authority-readiness-plan.md`.

Binding compliance hardening architecture (non-negotiables, H1–H6 phases, anti-patterns) is frozen in `docs/billing-compliance-hardening-plan.md`. Do not start H1+ compliance implementation without checking that document.

Implementation sequencing for compliance foundations is defined in `docs/billing-compliance-implementation-plan.md`.

Phase 1 immutable issued validation is defined in `docs/billing-compliance-phase-1-immutable-issued-review.md`.

Credit and cancellation legal reversal planning is defined in `docs/billing-credit-cancellation-architecture-plan.md`.

Implementation-safe planning for credit/cancellation is defined in `docs/billing-credit-cancellation-implementation-review.md`.

Final Phase 2A credit/reversal execution scope is defined in `docs/billing-credit-reversal-phase-2a-scope-review.md`.

Dedicated Billing audit foundation planning is defined in `docs/billing-dedicated-audit-foundation-plan.md`.

Dedicated Billing audit implementation scope is defined in `docs/billing-dedicated-audit-implementation-scope-review.md`.

Dedicated Billing audit Phase 3A implementation planning is defined in `docs/billing-dedicated-audit-phase-3a-implementation-review.md`.

Authority / SHAAM readiness foundation planning is defined in `docs/billing-authority-shaam-readiness-foundation-plan.md`.

Do not introduce Billing behavior that mutates issued invoices, weakens numbering, bypasses auditability, implies unsupported payment/authority states, or creates legal reversal through deletion/editing instead of explicit lifecycle records.
<!-- END:billing-compliance-rules -->

<!-- BEGIN:supplier-domain-rules -->
# Supplier Domain rule (MANDATORY): Supplier-assisted Restocking

Every change to Suppliers, Purchasing, Supplier Catalog, Product Mapping, Purchase Orders, or Receiving must follow the canonical constitution in `docs/dubiz-supplier-domain-constitution-v1.md` (v1.2, LOCKED). The derived domain model is in `docs/dubiz-supplier-domain-design-v1.md`.

Non-negotiable invariants: Inventory Item is the System of Record of Physical Reality (changes only via append-only movements; from the supplier domain only via Receiving). Supplier = Role on Party (identity via Party/Entity Resolution), never a free-text root entity. Supplier catalog/price/availability/status = External Account → Evidence (Reported Reality), advisory only, never the record. Product Mapping = Entity Resolution applied to Products (corrigible binding-belief with confidence + provenance, fail-safe no-auto-merge), never a hard table. PO = Commitment Reality, Receiving = Physical Settlement — never collapse them (no "approval = full receiving"). No "Signal" primitive. Financial settlement stays in Documents.

Anti-goals (do not build): ERP lifecycle, Marketplace/discovery, Supplier CRM, three-way matching, AP/accounting, supplier portal, catalog-as-master, auto-procurement.
<!-- END:supplier-domain-rules -->
