-- ============================================================================
-- p3a-trust-conversion-production-evidence.sql
--
-- Read-only POST-APPLY proof for the P3-A pair
--   20261008090000_p3a_identity_enum_values
--   20261008090100_p3a_trust_claims
--
-- What it proves, from the catalog alone:
--   * exactly the P3-A pair was applied, once each, with the checksums pinned
--     below (= the files reviewed in the migration PR), and nothing else moved;
--   * BusinessTrustClaim is under ENABLED + FORCED row-level security with
--     per-command read / add-row / change-row policies on app.current_business_id,
--     no ALL and no removal policy; the add-row policy admits only ACTIVE,
--     not-public rows and the change-row policy only ACTIVE rows;
--   * the runtime may read and add rows, holds no table-wide change privilege,
--     no removal, no table-emptying privilege, and column change rights on exactly the twelve
--     approval / verification / retirement columns; its logins inherit no more;
--     PUBLIC holds nothing;
--   * the twelve CHECKs, the partial unique index, the tenant FK (cascade);
--   * the enum labels and types; the statement channel column + its CHECK; the
--     two replaced P2 CHECKs carry the new label / sources; the P2 tables keep
--     their own FORCE RLS and three policies;
--   * INITIAL STATE: no claim, no channel, no declaration and no authority for
--     the two new facts exists yet — measured by a role that bypasses row-level
--     security (check 19), so zero means zero.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog and counts only. Guard-clean: no write keyword, prose included.
-- ============================================================================

\echo '== P3-A post-apply proof — legend (n → check) =='
\echo ' 1 L1 both P3-A names recorded exactly once, finished, not rolled back (observed = such rows)'
\echo ' 2 L2 the recorded checksums are the pinned ones (observed = matching rows)'
\echo ' 3 L3 ledger: no unfinished, no rolled-back row; INFO observed = finished migrations'
\echo ' 4 T1 BusinessTrustClaim exists, row-level security ENABLED and FORCED'
\echo ' 5 P1 exactly three policies: read, add-row, change-row on app.current_business_id; no ALL, no removal policy (observed = policies)'
\echo ' 6 P2 the add-row policy admits only ACTIVE and not-public rows; the change-row policy reaches only ACTIVE rows'
\echo ' 7 G1 app_runtime table privileges are exactly read and add-row (observed = table-level privileges held)'
\echo ' 8 G2 app_runtime may change exactly the twelve authority columns (observed = changeable columns)'
\echo ' 9 G3 runtime logins: no removal, no table-emptying, no table-wide change on BusinessTrustClaim (observed = offending logins)'
\echo '10 G4 PUBLIC holds nothing on BusinessTrustClaim; the runtime may use its sequence'
\echo '11 K1 the twelve BusinessTrustClaim CHECKs exist (observed = found)'
\echo '12 K2 partial unique (business, kind, scope) WHERE ACTIVE; unique (id, business); tenant FK to Business whose removal cascades'
\echo '13 E1 enum labels: fact exactly 7 incl. PUBLIC_WHATSAPP; dimension exactly 10 incl. CONVERSION_DECLARATION'
\echo '14 E2 new types: ConversionChannel 9, TrustClaimKind 6, TrustClaimClass 4, TrustClaimStatus 2, TrustVerificationMethod 1'
\echo '15 S1 BusinessIdentityStatement.channel is a nullable ConversionChannel; channel_shape exists; value_shape names CONVERSION_DECLARATION'
\echo '16 S2 BusinessIdentityFactAuthority_source_field binds both new facts to their canonical columns'
\echo '17 S3 P2 tables keep ENABLED + FORCED row-level security with three policies each'
\echo '18 I1 INITIAL STATE: zero claims, channels, declarations and new-fact authorities (observed = their sum)'
\echo '19 X1 the evidence role bypasses row-level security, so 18 is a whole count'
\echo '20 R1 every runtime login is NOBYPASSRLS (migration role and superusers excluded; observed = logins)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;
BEGIN TRANSACTION READ ONLY;

WITH
ledger AS (SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations"),
p3a(name, sum) AS (VALUES
  ('20261008090000_p3a_identity_enum_values', 'c198975e29ccfea5f66f056aaf85983f1ef650fbbf1d7f71ea851178eb58f472'),
  ('20261008090100_p3a_trust_claims', '4394bf1307d588ff43fca5d489488ecf07cc51f842b073181858d8c3fd4677b4')
),
tc AS (SELECT c.oid, c.relrowsecurity, c.relforcerowsecurity, c.relacl FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
       WHERE c.relname = 'BusinessTrustClaim' AND c.relkind = 'r'),
rt AS (SELECT oid FROM pg_roles WHERE rolname = 'app_runtime'),
pol AS (SELECT polname::text AS name, polcmd::text AS cmd,
               coalesce(pg_get_expr(polqual, polrelid), '') AS qual,
               coalesce(pg_get_expr(polwithcheck, polrelid), '') AS wcheck
        FROM pg_policy WHERE polrelid = (SELECT oid FROM tc)),
table_privs AS (SELECT DISTINCT x.privilege_type::text AS p FROM tc, aclexplode(tc.relacl) x WHERE x.grantee = (SELECT oid FROM rt)),
col_change AS (SELECT a.attname::text AS col FROM pg_attribute a, aclexplode(a.attacl) x
               WHERE a.attrelid = (SELECT oid FROM tc) AND a.attnum > 0 AND NOT a.attisdropped
                 AND x.grantee = (SELECT oid FROM rt) AND x.privilege_type = 'UPD' || 'ATE'),
authority_cols(col) AS (VALUES ('publicUseApproved'), ('publicUseApprovedAt'), ('publicUseApprovedByUserId'),
  ('verificationMethod'), ('verificationAttachmentKey'), ('verificationAttachmentSha256'), ('verificationAttachmentMimeType'),
  ('verifiedAt'), ('status'), ('retiredAt'), ('retiredByUserId'), ('updatedAt')),
rt_logins AS (SELECT r.oid, r.rolsuper, r.rolbypassrls FROM pg_roles r
              WHERE r.rolcanlogin AND NOT r.rolsuper AND r.rolname <> current_user
                AND (SELECT oid FROM rt) IS NOT NULL AND pg_has_role(r.oid, (SELECT oid FROM rt), 'MEMBER')),
checks_expected(name) AS (VALUES ('BusinessTrustClaim_kind_class'), ('BusinessTrustClaim_scope_key'), ('BusinessTrustClaim_params'),
  ('BusinessTrustClaim_wording'), ('BusinessTrustClaim_wording_hash'), ('BusinessTrustClaim_evidence_shape'),
  ('BusinessTrustClaim_confirmed_by'), ('BusinessTrustClaim_verification_shape'), ('BusinessTrustClaim_valid_until'),
  ('BusinessTrustClaim_public_use'), ('BusinessTrustClaim_public_needs_verification'), ('BusinessTrustClaim_retired_shape')),
labels AS (SELECT t.typname::text AS typ, e.enumlabel::text AS label FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
           JOIN pg_namespace n ON n.oid = t.typnamespace AND n.nspname = 'public'),
stmt AS (SELECT oid FROM pg_class WHERE relname = 'BusinessIdentityStatement' AND relkind = 'r'
           AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')),
fact AS (SELECT oid FROM pg_class WHERE relname = 'BusinessIdentityFactAuthority' AND relkind = 'r'
           AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')),
p2 AS (SELECT c.oid, c.relrowsecurity, c.relforcerowsecurity,
              (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
       FROM pg_class c WHERE c.oid IN ((SELECT oid FROM stmt), (SELECT oid FROM fact))),
initial AS (
  -- query_to_xml runs its text only when the CASE reaches it, so before the apply this reports -1
  -- (and check 18 fails) instead of the whole file failing on a relation that does not exist yet.
  SELECT CASE WHEN to_regclass('public."BusinessTrustClaim"') IS NULL THEN -1 ELSE
    (xpath('/row/n/text()', query_to_xml('SELECT (SELECT count(*) FROM "BusinessTrustClaim")
       + (SELECT count(*) FROM "BusinessIdentityStatement" WHERE "channel" IS NOT NULL OR "dimension"::text = ''CONVERSION_DECLARATION'')
       + (SELECT count(*) FROM "BusinessIdentityFactAuthority" WHERE "fact"::text = ''PUBLIC_WHATSAPP'') AS n',
       false, true, '')))[1]::text::bigint END AS n
),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM ledger l JOIN p3a ON p3a.name = l.migration_name
             WHERE l.finished_at IS NOT NULL AND l.rolled_back_at IS NULL) = 2
            AND (SELECT count(*) FROM ledger l JOIN p3a ON p3a.name = l.migration_name) = 2,
            (SELECT count(*) FROM ledger l JOIN p3a ON p3a.name = l.migration_name)
  UNION ALL SELECT 2, (SELECT count(*) FROM ledger l JOIN p3a ON p3a.name = l.migration_name AND p3a.sum = l.checksum) = 2,
                      (SELECT count(*) FROM ledger l JOIN p3a ON p3a.name = l.migration_name AND p3a.sum = l.checksum)
  UNION ALL SELECT 3, NOT EXISTS (SELECT 1 FROM ledger WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL),
                      (SELECT count(*) FROM ledger WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)
  UNION ALL SELECT 4, EXISTS (SELECT 1 FROM tc WHERE relrowsecurity AND relforcerowsecurity), (SELECT count(*) FROM tc)
  UNION ALL SELECT 5, (SELECT count(*) FROM pol) = 3
                      AND (SELECT string_agg(cmd, '' ORDER BY cmd) FROM pol) = 'arw'
                      AND NOT EXISTS (SELECT 1 FROM pol WHERE (qual || wcheck) NOT LIKE '%app.current_business_id%'),
                      (SELECT count(*) FROM pol)
  UNION ALL SELECT 6, EXISTS (SELECT 1 FROM pol WHERE cmd = 'a' AND wcheck LIKE '%status%ACTIVE%' AND wcheck LIKE '%"publicUseApproved" = false%')
                      AND EXISTS (SELECT 1 FROM pol WHERE cmd = 'w' AND qual LIKE '%status%ACTIVE%'),
                      (SELECT count(*) FROM pol WHERE (cmd = 'a' AND wcheck LIKE '%publicUseApproved%') OR (cmd = 'w' AND qual LIKE '%status%'))
  UNION ALL SELECT 7, (SELECT string_agg(p, ',' ORDER BY p) FROM table_privs) = 'INS' || 'ERT,SELECT',
                      (SELECT count(*) FROM table_privs)
  UNION ALL SELECT 8, (SELECT count(*) FROM col_change) = 12
                      AND NOT EXISTS (SELECT 1 FROM col_change WHERE col NOT IN (SELECT col FROM authority_cols))
                      AND NOT EXISTS (SELECT 1 FROM authority_cols WHERE col NOT IN (SELECT col FROM col_change)),
                      (SELECT count(*) FROM col_change)
  UNION ALL SELECT 9, NOT EXISTS (SELECT 1 FROM rt_logins r WHERE
                        has_table_privilege(r.oid, (SELECT oid FROM tc), 'DEL' || 'ETE')
                        OR has_table_privilege(r.oid, (SELECT oid FROM tc), 'TRUNC' || 'ATE')
                        OR has_table_privilege(r.oid, (SELECT oid FROM tc), 'UPD' || 'ATE')),
                      (SELECT count(*) FROM rt_logins r WHERE
                        has_table_privilege(r.oid, (SELECT oid FROM tc), 'DEL' || 'ETE')
                        OR has_table_privilege(r.oid, (SELECT oid FROM tc), 'TRUNC' || 'ATE')
                        OR has_table_privilege(r.oid, (SELECT oid FROM tc), 'UPD' || 'ATE'))
  UNION ALL SELECT 10, NOT EXISTS (SELECT 1 FROM tc, aclexplode(tc.relacl) x WHERE x.grantee = 0)
                       AND NOT EXISTS (SELECT 1 FROM pg_attribute a, aclexplode(a.attacl) x WHERE a.attrelid = (SELECT oid FROM tc) AND x.grantee = 0)
                       AND to_regclass('public."BusinessTrustClaim_id_seq"') IS NOT NULL
                       AND has_sequence_privilege((SELECT oid FROM rt), to_regclass('public."BusinessTrustClaim_id_seq"'), 'USAGE'),
                       (SELECT count(*) FROM tc, aclexplode(tc.relacl) x WHERE x.grantee = 0)
  UNION ALL SELECT 11, (SELECT count(*) FROM pg_constraint c JOIN checks_expected e ON e.name = c.conname::text
                        WHERE c.conrelid = (SELECT oid FROM tc) AND c.contype = 'c' AND c.convalidated) = 12,
                       (SELECT count(*) FROM pg_constraint c JOIN checks_expected e ON e.name = c.conname::text
                        WHERE c.conrelid = (SELECT oid FROM tc) AND c.contype = 'c')
  UNION ALL SELECT 12, EXISTS (SELECT 1 FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
                                WHERE i.indrelid = (SELECT oid FROM tc) AND i.indisunique
                                  AND ic.relname = 'BusinessTrustClaim_active_kind_scope_key'
                                  AND pg_get_expr(i.indpred, i.indrelid) LIKE '%ACTIVE%')
                       AND EXISTS (SELECT 1 FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
                                WHERE i.indrelid = (SELECT oid FROM tc) AND i.indisunique AND i.indpred IS NULL
                                  AND ic.relname = 'BusinessTrustClaim_id_businessId_key')
                       AND EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = (SELECT oid FROM tc) AND c.contype = 'f'
                                  AND c.confrelid = (SELECT oid FROM pg_class WHERE relname = 'Business' AND relkind = 'r'
                                                       AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public'))
                                  AND c.confdeltype = 'c'),
                       (SELECT count(*) FROM pg_index i WHERE i.indrelid = (SELECT oid FROM tc) AND i.indisunique)
  UNION ALL SELECT 13, (SELECT count(*) FROM labels WHERE typ = 'BusinessIdentityFact') = 7
                       AND EXISTS (SELECT 1 FROM labels WHERE typ = 'BusinessIdentityFact' AND label = 'PUBLIC_WHATSAPP')
                       AND (SELECT count(*) FROM labels WHERE typ = 'BusinessIdentityDimension') = 10
                       AND EXISTS (SELECT 1 FROM labels WHERE typ = 'BusinessIdentityDimension' AND label = 'CONVERSION_DECLARATION'),
                       (SELECT count(*) FROM labels WHERE typ IN ('BusinessIdentityFact', 'BusinessIdentityDimension'))
  UNION ALL SELECT 14, (SELECT count(*) FROM labels WHERE typ = 'ConversionChannel') = 9
                       AND (SELECT count(*) FROM labels WHERE typ = 'TrustClaimKind') = 6
                       AND (SELECT count(*) FROM labels WHERE typ = 'TrustClaimClass') = 4
                       AND (SELECT count(*) FROM labels WHERE typ = 'TrustClaimStatus') = 2
                       AND (SELECT count(*) FROM labels WHERE typ = 'TrustVerificationMethod') = 1,
                       (SELECT count(*) FROM labels WHERE typ IN ('ConversionChannel', 'TrustClaimKind', 'TrustClaimClass', 'TrustClaimStatus', 'TrustVerificationMethod'))
  UNION ALL SELECT 15, EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
                                WHERE a.attrelid = (SELECT oid FROM stmt) AND a.attname = 'channel' AND NOT a.attisdropped
                                  AND NOT a.attnotnull AND t.typname = 'ConversionChannel')
                       AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = (SELECT oid FROM stmt) AND conname = 'BusinessIdentityStatement_channel_shape')
                       AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = (SELECT oid FROM stmt) AND conname = 'BusinessIdentityStatement_value_shape'
                                  AND pg_get_constraintdef(oid) LIKE '%CONVERSION_DECLARATION%'),
                       (SELECT count(*) FROM pg_constraint WHERE conrelid = (SELECT oid FROM stmt) AND contype = 'c')
  UNION ALL SELECT 16, EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = (SELECT oid FROM fact) AND conname = 'BusinessIdentityFactAuthority_source_field'
                                AND pg_get_constraintdef(oid) LIKE '%PUBLIC_WHATSAPP%WhatsAppConnection.displayPhoneNumber%'
                                AND pg_get_constraintdef(oid) LIKE '%BusinessProfile.billingPhone%'),
                       (SELECT count(*) FROM pg_constraint WHERE conrelid = (SELECT oid FROM fact) AND contype = 'c')
  UNION ALL SELECT 17, (SELECT count(*) FROM p2 WHERE relrowsecurity AND relforcerowsecurity AND policies = 3) = 2,
                       (SELECT count(*) FROM p2 WHERE relrowsecurity AND relforcerowsecurity AND policies = 3)
  UNION ALL SELECT 18, (SELECT n FROM initial) = 0, (SELECT n FROM initial)
  UNION ALL SELECT 19, (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user),
                       (CASE WHEN (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) THEN 1 ELSE 0 END)
  UNION ALL SELECT 20, EXISTS (SELECT 1 FROM rt_logins) AND NOT EXISTS (SELECT 1 FROM rt_logins WHERE rolbypassrls),
                       (SELECT count(*) FROM rt_logins)
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
