-- D2 / P7-W4E-A — least-privilege grants (PER-ENVIRONMENT artifact).
--
-- :ROLE = the tenant runtime role (Preview: app_runtime_preview_p4b).
--
-- Deliberately split into two sections so the PRE-CONTEXT capability of the
-- runtime role is auditable on its own. Everything in section 1 is reachable
-- only under an established tenant context (FORCE RLS + GUC). Everything in
-- section 2 is reachable with NO tenant at all, so it is kept as small as the
-- architecture allows and every verb is justified.

-- ============================================================
-- 1. TENANT RUNTIME GRANTS (FORCE-RLS'd; every row filtered by the GUC)
--
-- Verbs are code-observed from the payments store, which is the only file that
-- touches these tables:
--   PaymentAuditEvent          S,I    append-only ledger (create + list); never
--                                     updated or deleted by any live path
--   BusinessPaymentConnection  S,I,U  connect/disconnect upsert + status reads
--   FinancialEvent             S,I    ensurePaymentPostedEvent: findUnique +
--                                     create only (idempotent on the composite)
--   PaymentTransaction         S,I    verified settlement record + lookups;
--                                     transactions are immutable once written
--
-- ZERO DELETE anywhere: the erasure manifest RETAINS the payment/fiscal family
-- (paymentRequest, paymentTransaction, paymentAuditEvent, financialEvent are
-- all in RETAIN_MODELS), and no live path deletes any of these rows.
--
-- PaymentRequest already carries the P4-B pilot grant (SELECT). W4E-A adds the
-- INSERT/UPDATE the create/settle flows actually need — without them the module
-- cannot function under the least-privilege role at all.
-- ============================================================

GRANT SELECT, INSERT, UPDATE ON "PaymentRequest" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "PaymentRequest_id_seq" TO :ROLE;

GRANT SELECT, INSERT ON "PaymentTransaction" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "PaymentTransaction_id_seq" TO :ROLE;

GRANT SELECT, INSERT ON "PaymentAuditEvent" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "PaymentAuditEvent_id_seq" TO :ROLE;

GRANT SELECT, INSERT, UPDATE ON "BusinessPaymentConnection" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "BusinessPaymentConnection_id_seq" TO :ROLE;

GRANT SELECT, INSERT ON "FinancialEvent" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "FinancialEvent_id_seq" TO :ROLE;

-- ============================================================
-- 2. BOOTSTRAP GRANTS (NO RLS — reachable with no tenant context)
--
-- Exactly two tables, five call sites, all inside the named bootstrapStep()
-- helper in payment-store.prisma.ts:
--
--   PaymentWebhookEvent      S,I,U  the provider ledger. Written before any
--                                   tenant is known (that is its whole point),
--                                   carries no businessId, and is DB-idempotent
--                                   on (provider, providerEventId). UPDATE is
--                                   required to stamp processingStatus.
--   PaymentProviderRouting   S,I,U  routing hint only. SELECT is the pre-context
--                                   read; INSERT/UPDATE come from upsert() in
--                                   the OWNER-AUTHENTICATED creation flow, which
--                                   runs under a tenant context — the verbs are
--                                   on the same role, so they are listed here
--                                   with that asymmetry stated rather than
--                                   split into a second role.
--
-- Why a non-RLS bootstrap table is still safe:
--   * it stores routing identifiers ONLY — no amount, currency, status,
--     customer, description, credential, token, or provider payload, so a full
--     disclosure of every row reveals no business or financial data;
--   * it is never the tenant authority: the callback re-reads the STORED
--     PaymentRequest under the routed tenant's own GUC and proceeds only when
--     PaymentRequest.businessId equals the routed businessId, so a tampered
--     routing row can only cause a loud refusal, never a cross-tenant write;
--   * unique (provider, providerRequestId) means two businesses can never
--     claim one provider reference, and unique paymentRequestId means a
--     request's routing cannot be forked;
--   * every row is written server-side from a session-derived businessId.
--
-- ZERO DELETE on both: nothing in the runtime removes a ledger or routing row.
-- ============================================================

GRANT SELECT, INSERT, UPDATE ON "PaymentWebhookEvent" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "PaymentWebhookEvent_id_seq" TO :ROLE;

GRANT SELECT, INSERT, UPDATE ON "PaymentProviderRouting" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "PaymentProviderRouting_id_seq" TO :ROLE;

-- ============================================================
-- 3. No admin grants in W4E-A — verified: no admin-client consumer reads any
-- W4E-A table. Granting app_admin read of payment credentials or audit trails
-- with no consumer would be pure attack surface.
-- ============================================================
