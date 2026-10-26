-- ============================================================================
-- user-email-case-audit.sql
--
-- Read-only AUDIT for "Continue with Google", milestone 3: how User.email letter case meets a Google address.
--
-- Google addresses arrive folded (lower case). An account opened before signup folded addresses may hold one
-- with capital letters. The Google sign-in looks an address up case-insensitively (lower("email"), the
-- index below) and STOPS — no ticket, no link, no new account — when the account found does not hold the
-- folded address exactly (the person signs in with the address and the password). This audit measures what
-- that rule meets in Production:
--   * the case-folded unique index of 20261011090200 exists, is unique and valid, on lower("email");
--   * therefore no two accounts share an address up to letter case (measured, not assumed);
--   * how many accounts hold an address that is not folded (informational: those accounts cannot link Google
--     until their address is folded — a separate, owner-approved data change, never done by this audit).
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend. Check 3 always PASSes; its
-- observed_count is the information.
-- PRIVACY: catalog and counts only — never an address. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== user email case audit: legend (n -> check) =='
\echo ' 1 User_email_casefold_key: unique, valid, on lower(email) (observed = such indexes)'
\echo ' 2 no two accounts share an address up to letter case (observed = such groups)'
\echo ' 3 informational: accounts whose address holds capital letters (observed = accounts)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
usr AS (SELECT c.oid FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname = 'User' AND c.relkind = 'r'),
casefold AS (SELECT 1 FROM pg_class i JOIN pg_index x ON x.indexrelid = i.oid
             WHERE i.relname = 'User_email_casefold_key' AND x.indrelid = (SELECT oid FROM usr)
               AND x.indisunique AND x.indisvalid AND pg_get_indexdef(i.oid) LIKE '%lower(email)%'),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM casefold) = 1, (SELECT count(*) FROM casefold)
  UNION ALL SELECT 2, NOT EXISTS (SELECT 1 FROM "User" GROUP BY lower("email") HAVING count(*) > 1),
                      (SELECT count(*) FROM (SELECT 1 FROM "User" GROUP BY lower("email") HAVING count(*) > 1) g)
  UNION ALL SELECT 3, true, (SELECT count(*) FROM "User" WHERE "email" <> lower("email"))
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
