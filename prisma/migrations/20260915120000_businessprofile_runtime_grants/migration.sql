-- BusinessProfile — the two privileges the tenant runtime needs in order to
-- SAVE a business's invoice identity. Grants only. No schema change, no policy
-- change, no new table, no column.
--
-- WHY THIS IS NEEDED
--
-- `PATCH /api/billing/invoice-profile` is how a business fills in the identity
-- that every tax invoice is issued under — legal name, business kind, tax id,
-- address, phone, email. It writes with `businessProfile.upsert`, so it needs
-- INSERT the first time and UPDATE every time after.
--
-- The runtime holds neither. `scripts/security/d2-p7-wave1-grants.sql` granted
-- `SELECT` and said why: "the runtime never inserts BusinessProfile". That was
-- true when it was written — signup deliberately does not create a profile row
-- (asserted in .tx3a1/exact-grant-battery.mjs), and the only reader at the time
-- was deals-generate. It stopped being true once the billing-identity form
-- existed, and nobody noticed because Production still connected as an owner
-- role. The D2 runtime cutover made `app_runtime` real, and saving the form has
-- been refused with 42501 ever since.
--
-- Measured, on a real PostgreSQL, as a NOBYPASSRLS role, with this table's
-- shipped `p7w1_tenant` policy in place:
--
--   SELECT only  + no tenant context  -> 42501 permission denied  (INSERT and UPDATE)
--   SELECT only  + tenant context     -> 42501 permission denied  (INSERT and UPDATE)
--   +INSERT/UPDATE + no tenant context -> 42501 new row violates row-level security
--   +INSERT/UPDATE + tenant context    -> INSERT and UPDATE both succeed
--
-- So the privilege and the tenant context are each necessary and neither is
-- sufficient. This migration supplies the privilege half. The code half — the
-- route running under `billingTenantTx` — is a SEPARATE, LATER PR, because the
-- migration must be applied in Production before the code that depends on it
-- ships. Granting early is safe in a way that deploying early is not: until the
-- route carries tenant context, RLS still refuses every write, so this file on
-- its own changes no observable behaviour.
--
-- WHY THE SEQUENCE GRANT IS NOT OPTIONAL
--
-- `BusinessProfile.id` is `autoincrement()`, so an INSERT that does not name it
-- calls `nextval('"BusinessProfile_id_seq"')`, which needs USAGE on the
-- sequence. Without it the INSERT fails with
--   42501 permission denied for sequence BusinessProfile_id_seq
-- even though the table grant is present — proven, and easy to miss because the
-- table grant looks complete on its own.
--
-- WHAT IS DELIBERATELY NOT HERE
--
-- No DELETE. A profile is anonymised in place, never deleted: account erasure
-- updates its PII fields and leaves the row, and the only `businessProfile
-- .deleteMany` call sites in the repo are a test teardown and a manual smoke
-- script, neither of which runs as this role in Production. A privilege with no
-- consumer is residue, and this one would be residue on the table that carries
-- the business's legal identity.
--
-- No REVOKE either. Removing a privilege is a different decision from adding
-- the two that are missing, and it belongs to whoever is willing to answer for
-- what might already depend on it.
--
-- No TRUNCATE, REFERENCES, TRIGGER, no GRANT ALL, no schema-wide grant, no
-- ownership, no BYPASSRLS. The table keeps ENABLE + FORCE ROW LEVEL SECURITY
-- and `p7w1_tenant` exactly as 20260825120000 left them: this file does not
-- mention them, so it cannot weaken them. Tenant isolation continues to rest on
-- the policy, and was re-proven under these exact grants — a business holding
-- INSERT and UPDATE still cannot write, or even see, another business's row.
--
-- Guarded on the role existing, so this is a clean no-op on a database that has
-- no `app_runtime` — a fresh developer database, or CI. Only the NOLOGIN group
-- is named; every environment attaches its own LOGIN identity, and membership
-- is how the privilege resolves at connection time. Re-runnable: GRANT is
-- idempotent.

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON "BusinessProfile" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "BusinessProfile_id_seq" TO app_runtime;
  END IF;
END
$do$;
