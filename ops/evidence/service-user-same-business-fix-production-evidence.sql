-- ============================================================================
-- service-user-same-business-fix-production-evidence.sql
--
-- Read-only EVIDENCE after migration 20261124090000_service_user_same_business_fix was applied.
--
-- Proves:
--   * the migration is recorded once, finished, not rolled back, with the reviewed file's checksum; the ledger is clean;
--   * public.service_user_same_business() is exactly the reviewed text (md5 of its body), plpgsql, SECURITY INVOKER,
--     search_path pg_catalog, public, pg_temp, not executable by PUBLIC;
--   * the 14 triggers still use it (the function was replaced in place: same oid), each BEFORE / FOR EACH ROW / on new
--     rows and changed rows only / enabled; every column they check has exactly one NOT DEFERRABLE foreign key to
--     "User" that sets NULL when the user goes;
--   * "User" carries no row level security; the owner of the Service tables carries BYPASSRLS or is a superuser;
--   * existing data: no row names, in a checked column, a user of another business or a missing user;
--   * informational: column pairs of one row naming the same user (these users can now be removed).
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== service user same business fix evidence: legend (n -> check) =='
\echo ' 1 the migration is recorded once, finished, not rolled back'
\echo ' 2 ledger: no unfinished and no rolled-back row'
\echo ' 3 the ledger checksum is the reviewed migration file'
\echo ' 4 service_user_same_business(): the reviewed text (md5 of its body)'
\echo ' 5 the function: plpgsql, SECURITY INVOKER, search_path ending in pg_temp'
\echo ' 6 the function executable by PUBLIC (expected 0)'
\echo ' 7 triggers using the function (expected 14)'
\echo ' 8 of them: not BEFORE / not FOR EACH ROW / fired on row removal or table wipe / constraint / disabled (expected 0)'
\echo ' 9 checked columns without exactly one NOT DEFERRABLE User foreign key that sets NULL when the user goes (expected 0)'
\echo '10 User has row level security (expected 0)'
\echo '11 the owner of ServiceQuote carries BYPASSRLS or is a superuser'
\echo '12 rows naming a user of another business or a missing user in a checked column (expected 0)'
\echo '13 column pairs of one row naming the same user (informational: these users can now be removed)'

WITH fn AS (
  SELECT p.oid, p.prosrc, p.prosecdef, p.prolang, p.prorettype, array_to_string(p.proconfig, ',') AS cfg
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'service_user_same_business' AND p.pronargs = 0
), trg AS (
  SELECT t.* FROM pg_trigger t JOIN fn ON t.tgfoid = fn.oid
), args AS (
  SELECT trg.tgrelid, trg.tgname, a.col, a.pos
    FROM trg CROSS JOIN LATERAL unnest((string_to_array(encode(trg.tgargs, 'escape'), '\000'))[1:trg.tgnargs]) WITH ORDINALITY AS a(col, pos)
), c AS (
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261124090000_service_user_same_business_fix'
                     AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS observed, 1 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL), 0
  UNION ALL SELECT 3, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261124090000_service_user_same_business_fix'
                          AND checksum = '54ec7a888d245c0a2fe2df00be2d13f4a5224785c32484a05b699b2ff5b81232'), 1
  UNION ALL SELECT 4, (SELECT count(*) FROM fn WHERE md5(fn.prosrc) = '2a37254b2dcac028a3849078b188f54b' AND fn.prosrc LIKE '%SERVICE_USER_COLUMN_UNKNOWN%'), 1
  UNION ALL SELECT 5, (SELECT count(*) FROM fn WHERE NOT fn.prosecdef AND fn.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
                          AND fn.prorettype = 'trigger'::regtype AND fn.cfg = 'search_path=pg_catalog, public, pg_temp'), 1
  UNION ALL SELECT 6, (SELECT count(*) FROM fn WHERE has_function_privilege('public', fn.oid, 'EXECUTE')), 0
  UNION ALL SELECT 7, (SELECT count(*) FROM trg), 14
  UNION ALL SELECT 8, (SELECT count(*) FROM trg WHERE (tgtype & 1) = 0 OR (tgtype & 2) = 0 OR (tgtype & (8 | 32 | 64)) <> 0
                          OR tgconstraint <> 0 OR tgenabled <> 'O' OR tgnargs < 1), 0
  UNION ALL SELECT 9, (SELECT count(*) FROM args
                        WHERE NOT EXISTS (SELECT 1 FROM pg_attribute att WHERE att.attrelid = args.tgrelid AND att.attname = args.col
                                            AND NOT att.attisdropped AND att.atttypid = 'integer'::regtype)
                           OR (SELECT count(*) FROM pg_constraint k JOIN pg_attribute att ON att.attrelid = k.conrelid AND att.attnum = k.conkey[1]
                                WHERE k.contype = 'f' AND k.conrelid = args.tgrelid AND cardinality(k.conkey) = 1 AND att.attname = args.col
                                  AND k.confrelid = 'public."User"'::regclass AND k.confdeltype = 'n' AND NOT k.condeferrable) <> 1), 0
  UNION ALL SELECT 10, (SELECT count(*) FROM pg_class WHERE oid = 'public."User"'::regclass AND relrowsecurity), 0
  UNION ALL SELECT 11, (SELECT count(*) FROM pg_class k JOIN pg_roles r ON r.oid = k.relowner
                         WHERE k.relname = 'ServiceQuote' AND k.relnamespace = 'public'::regnamespace AND (r.rolbypassrls OR r.rolsuper)), 1
  UNION ALL SELECT 12, (SELECT coalesce(sum((xpath('/row/n/text()', query_to_xml(format(
                           'SELECT count(*) AS n FROM %s r WHERE r.%I IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public."User" u WHERE u."id" = r.%I AND u."businessId" = r."businessId")',
                           args.tgrelid::regclass, args.col, args.col), false, true, '')))[1]::text::bigint), 0) FROM args), 0
  UNION ALL SELECT 13, (SELECT coalesce(sum((xpath('/row/n/text()', query_to_xml(format(
                           'SELECT count(*) AS n FROM %s r WHERE r.%I IS NOT NULL AND r.%I = r.%I',
                           x.tgrelid::regclass, x.col, x.col, y.col), false, true, '')))[1]::text::bigint), 0)
                         FROM args x JOIN args y ON y.tgrelid = x.tgrelid AND y.tgname = x.tgname AND y.pos > x.pos), NULL
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
  FROM c
 ORDER BY n;
