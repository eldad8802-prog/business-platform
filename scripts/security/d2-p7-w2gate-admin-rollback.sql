-- D2 / P7-W2-GATE — admin foundation rollback (policies + grants).
--
-- Removes the additive admin SELECT policies and every starter grant from the
-- app_admin group. Deliberately does NOT drop app_admin or the environment
-- login role (:LOGIN_ROLE) — dormant roles preserve Neon pooler OID
-- stability; a role with zero grants, zero policies and zero membership value
-- is inert. Tenant policies (p4b_tenant, p7w1_tenant), FORCE RLS and the
-- tenant runtime role are untouched by construction.

DROP POLICY IF EXISTS p7adm_read ON "Conversation";
DROP POLICY IF EXISTS p7adm_read ON "BillingDocument";

REVOKE ALL PRIVILEGES ON "Conversation" FROM app_admin;
REVOKE ALL PRIVILEGES ON "BillingDocument" FROM app_admin;
REVOKE ALL PRIVILEGES ON "User" FROM app_admin;
REVOKE ALL PRIVILEGES ON "Business" FROM app_admin;
REVOKE ALL PRIVILEGES ON "PlatformFeaturePolicy" FROM app_admin;
REVOKE ALL PRIVILEGES ON "PlatformAuditEvent" FROM app_admin;
REVOKE ALL PRIVILEGES ON SEQUENCE "PlatformAuditEvent_id_seq" FROM app_admin;
REVOKE ALL PRIVILEGES ON SCHEMA public FROM app_admin;
