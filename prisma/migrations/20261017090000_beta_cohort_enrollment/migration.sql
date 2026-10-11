-- Beta cohort enrollment (migration only)
--
-- WHAT THIS ADDS
--   "BusinessBetaEnrollment": at most one row per business, recording that the business was opened
--   through the closed-beta signup (an allowlisted address with a valid invitation). It is the durable
--   fact the beta access policy (lib/beta/beta-access-policy.ts, the application PR) reads to decide
--   whether integrations that are not yet open to beta testers — Meta (WhatsApp Business, Facebook /
--   Instagram lead forms) and the Tax Authority — show "coming soon" and are refused on the server.
--   The row restricts; it never grants. A business with no row is exactly what it is today.
--     * cohort is a short lowercase label (e.g. closed-beta-2026-10), format-checked, not a closed list;
--     * source is how the row came to be — today only CLOSED_BETA_SIGNUP;
--     * the row is written in the SAME transaction as the account it describes, or not at all.
--
-- WHO MAY DO WHAT (FORCE RLS; every role but the table owner is subject to the policies)
--   app_auth    — the signup plane: INSERT on the four columns, and only rows whose source is
--                 CLOSED_BETA_SIGNUP. No SELECT (the write returns nothing), no UPDATE, no DELETE.
--   app_runtime — the tenant plane: SELECT, bound by RLS to app.current_business_id — a business
--                 reads its own row and no other. No INSERT, no UPDATE, no DELETE: a business can
--                 neither enroll nor leave on its own.
--   PUBLIC      — nothing.
--   The owner's default privileges would otherwise hand app_runtime INSERT / SELECT / UPDATE / DELETE on
--   the whole table (20260908200000_auth_session_privilege_contract); they are revoked first and the
--   privileges above are named explicitly.
--
-- WHAT IT DELIBERATELY DOES NOT ADD
--   - no backfill: every existing business gets no row, so nothing changes for anyone already here;
--   - no DELETE policy, no catch-all policy, no policy without a FOR clause, no sequence (the key is
--     businessId);
--   - no column on Business: nothing that already reads Business can be affected.
--   The business row's removal cascades to its enrollment (a referential action, not a grant).
--
-- Additive only: one table, two check constraints, one foreign key, two policies, explicit privileges.

CREATE TABLE "BusinessBetaEnrollment" (
  "businessId" INTEGER NOT NULL,
  "cohort" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "BusinessBetaEnrollment_pkey" PRIMARY KEY ("businessId"),
  CONSTRAINT "BusinessBetaEnrollment_cohort" CHECK ("cohort" ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  CONSTRAINT "BusinessBetaEnrollment_source" CHECK ("source" IN ('CLOSED_BETA_SIGNUP'))
);

ALTER TABLE "BusinessBetaEnrollment" ADD CONSTRAINT "BusinessBetaEnrollment_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Row-level security ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "BusinessBetaEnrollment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessBetaEnrollment" FORCE ROW LEVEL SECURITY;

-- Signup plane. It runs before any tenant context exists (inside the signup transaction), so its reach
-- is set by its column privileges and by this check, not by a GUC.
CREATE POLICY beta_enrollment_auth_insert ON "BusinessBetaEnrollment" FOR INSERT TO app_auth
  WITH CHECK ("source" = 'CLOSED_BETA_SIGNUP');

-- Tenant plane: a business reads its own enrollment, and only its own.
CREATE POLICY beta_enrollment_runtime_select ON "BusinessBetaEnrollment" FOR SELECT TO app_runtime
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ── Privileges, named explicitly ───────────────────────────────────────────────────────────────

REVOKE ALL ON "BusinessBetaEnrollment" FROM PUBLIC;

REVOKE ALL ON "BusinessBetaEnrollment" FROM app_runtime;
GRANT SELECT ON "BusinessBetaEnrollment" TO app_runtime;

REVOKE ALL ON "BusinessBetaEnrollment" FROM app_auth;
GRANT INSERT ("businessId", "cohort", "source", "createdAt") ON "BusinessBetaEnrollment" TO app_auth;
