-- ============================================================================
-- p2-business-identity-initial-state.sql
--
-- Read-only evidence of the INITIAL STATE after migration
--   20261004090000_p2_business_identity
-- was applied (release-migrate run 36951977443), while the P2 application
-- (PR-2) is not deployed — that the migration seeded no identity statement and
-- no identity-fact authority (nothing auto-approved), and that no application
-- writer has populated either table.
--
-- WHAT IT ESTABLISHES, precisely:
--   * BusinessIdentityStatement and BusinessIdentityFactAuthority are CURRENTLY
--     EMPTY, as seen by the evidence login — conclusive only when that login
--     bypasses RLS (evidence_role_bypasses_rls = t is REQUIRED; see caveat);
--   * the tuples-added counter PostgreSQL statistics currently report for the
--     two tables is zero.
-- It does NOT establish an absolute historical guarantee beyond what those
-- statistics can show: the counter restarts when statistics are reset.
--
-- Companion to sec-p2-business-identity-production-evidence.sql (#614), which
-- proves the catalog (columns, constraints, indexes, RLS, policies, privileges);
-- kept as its own file so that proof and its forensic lab stay unchanged.
--
-- WHAT IS READ: row COUNTS of the two tables and their pg_stat_user_tables
-- counters. No column of either table is selected — no statement text, contact
-- value, hash, name or id reaches the output.
--
-- Output: ONE row, built for the public-log redaction filter: count-named
-- integers and booleans only, so every value survives redaction.
--
-- Caveat, stated rather than hidden: both tables FORCE row level security, so a
-- visible count of 0 proves emptiness only when the evidence login bypasses RLS.
-- initial_state_empty is t only when all four numbers are zero AND
-- evidence_role_bypasses_rls is t — the count alone is never sufficient. The
-- tuples-added counter is independent of RLS but restarts with the statistics.
--
-- SELECT-only, inside a READ ONLY transaction that always ends in ROLLBACK. The
-- workflow guard rejects any write keyword anywhere in this file, prose
-- included, so the wording avoids those words.
-- ============================================================================

SET statement_timeout = '30s';
SET default_transaction_read_only = on;
BEGIN TRANSACTION READ ONLY;

\echo '== P2 initial state (one row): all four *_count = 0, evidence_role_bypasses_rls = t, initial_state_empty = t (currently empty under a BYPASSRLS evidence role; statistics tuples-added counter zero) =='
WITH state AS (
  SELECT
    (SELECT count(*) FROM "BusinessIdentityStatement")     AS statement_visible_count,
    (SELECT count(*) FROM "BusinessIdentityFactAuthority") AS fact_authority_visible_count,
    coalesce((SELECT sum(s.n_tup_ins) FROM pg_stat_user_tables s
               WHERE s.schemaname = 'public'
                 AND s.relname IN ('BusinessIdentityStatement', 'BusinessIdentityFactAuthority')), 0)::bigint AS tuples_added_count,
    coalesce((SELECT sum(s.n_live_tup) FROM pg_stat_user_tables s
               WHERE s.schemaname = 'public'
                 AND s.relname IN ('BusinessIdentityStatement', 'BusinessIdentityFactAuthority')), 0)::bigint AS live_tuple_count,
    coalesce((SELECT r.rolsuper OR r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user), false) AS evidence_role_bypasses_rls
)
SELECT statement_visible_count,
       fact_authority_visible_count,
       tuples_added_count,
       live_tuple_count,
       evidence_role_bypasses_rls,
       (evidence_role_bypasses_rls
        AND statement_visible_count = 0 AND fact_authority_visible_count = 0
        AND tuples_added_count = 0 AND live_tuple_count = 0)                AS initial_state_empty
  FROM state;

ROLLBACK;
