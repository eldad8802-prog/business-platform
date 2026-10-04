-- P3-A lab only (never Production): one md5 over EVERYTHING P3-A and P2 own in the catalog —
-- constraints (definitions), policies (command, roles, expressions), row-level security flags,
-- table and column privileges, indexes (definitions), enum labels (order included).
--
-- Taken on a lab with the P3-A pair applied, and again on a lab with the full joint release
-- (P3-A pair + M6). Equal digests prove M6 changes nothing P3-A or P2 owns: BusinessTrustClaim RLS,
-- P2 fact authority, P2 statement constraints, the objective channel, PUBLIC_WHATSAPP semantics.
-- Names only (never oids), so two databases compare.
WITH t(rel) AS (VALUES ('BusinessTrustClaim'), ('BusinessIdentityStatement'), ('BusinessIdentityFactAuthority')),
cls AS (SELECT c.oid, c.relname::text AS rel, c.relrowsecurity, c.relforcerowsecurity, c.relacl
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
        JOIN t ON t.rel = c.relname WHERE c.relkind = 'r'),
types(typ) AS (VALUES ('BusinessIdentityFact'), ('BusinessIdentityDimension'), ('BusinessIdentitySource'),
  ('BusinessIdentityStatus'), ('ConversionChannel'), ('TrustClaimKind'), ('TrustClaimClass'), ('TrustClaimStatus'),
  ('TrustVerificationMethod')),
items(x) AS (
  SELECT 'con|' || cls.rel || '|' || k.conname || '|' || pg_get_constraintdef(k.oid) FROM pg_constraint k JOIN cls ON cls.oid = k.conrelid
  UNION ALL
  SELECT 'pol|' || p.tablename || '|' || p.policyname || '|' || p.cmd || '|' || p.permissive || '|' || p.roles::text
         || '|' || coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')
  FROM pg_policies p JOIN t ON t.rel = p.tablename WHERE p.schemaname = 'public'
  UNION ALL
  SELECT 'rls|' || rel || '|' || relrowsecurity || '|' || relforcerowsecurity FROM cls
  UNION ALL
  SELECT 'acl|' || rel || '|' || coalesce(relacl::text, '') FROM cls
  UNION ALL
  SELECT 'col|' || cls.rel || '|' || a.attname || '|' || format_type(a.atttypid, a.atttypmod) || '|' || a.attnotnull
         || '|' || coalesce(a.attacl::text, '')
  FROM pg_attribute a JOIN cls ON cls.oid = a.attrelid WHERE a.attnum > 0 AND NOT a.attisdropped
  UNION ALL
  SELECT 'idx|' || cls.rel || '|' || pg_get_indexdef(i.indexrelid) FROM pg_index i JOIN cls ON cls.oid = i.indrelid
  UNION ALL
  SELECT 'enum|' || ty.typname || '|' || e.enumsortorder || '|' || e.enumlabel
  FROM pg_type ty JOIN pg_enum e ON e.enumtypid = ty.oid JOIN types ON types.typ = ty.typname
)
SELECT md5(string_agg(x, E'\n' ORDER BY x)) AS fingerprint, count(*) AS items FROM items;
