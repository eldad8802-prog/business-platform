-- Leads W1 — grant rollback. Restores the pre-Leads-W1 privilege posture.
-- :ROLE = the tenant runtime role for the environment.
--
-- Revokes ONLY what `d2-p7-leads-w1-grants.sql` added. It deliberately does NOT
-- touch the `p7w1_tenant` policy or the ENABLE/FORCE flags on "Lead": those
-- belong to D2/P7 Wave 1 and predate this wave, so unwinding them here would
-- silently roll back someone else's substrate.
--
-- Never drops roles.

REVOKE SELECT, INSERT, UPDATE ON "Lead" FROM :ROLE;
REVOKE USAGE, SELECT ON SEQUENCE "Lead_id_seq" FROM :ROLE;
