-- PERSISTENT LOGIN — privilege verification for "AuthSession" and
-- "AuthSessionSecret". READ ONLY. Safe to run at any time.
--
-- BIDIRECTIONAL BY CONSTRUCTION. Every check carries BOTH expectations — the
-- corrected contract and the post-migration state that precedes it — and is
-- judged against both. So the same file proves correction.sql worked AND proves
-- rollback.sql restored exactly what it claimed, with no editing and no second
-- artefact to drift out of step.
--
-- Read the summary rows at the bottom of the output. Exactly one of
-- MATCHES CORRECTED / MATCHES PRE-CORRECTION should say YES. If neither does,
-- the database is in a third state that nobody designed.
--
-- IT PROVES EFFECTIVE PRIVILEGE, NOT relacl TEXT.
--
-- Reading the ACL string tells you what was granted. has_table_privilege and
-- has_column_privilege tell you what the role can actually do, resolving role
-- membership on the way. That distinction is the whole point here: app_runtime
-- and app_auth are NOLOGIN group roles, and the identities Production connects
-- as are app_runtime_prod and app_auth_prod, which hold nothing directly and
-- inherit everything. A check against the groups alone would prove nothing
-- about the connections that actually happen, so all four are tested.
--
-- WHY TABLE-LEVEL AND COLUMN-LEVEL ARE BOTH CHECKED
--
-- has_table_privilege(role, tbl, 'UPDATE') answers only for a table-level grant;
-- it is FALSE when the role holds column-level UPDATE alone. has_column_privilege
-- answers TRUE for either. The corrected contract therefore requires
-- table-level UPDATE to be FALSE and specific columns to be TRUE — and that
-- pair is exactly what makes the withheld columns meaningful. Checking only one
-- of the two would let a table-level grant hide behind a passing column check.
--
-- THE COLUMN SETS ARE COMPLETE, NOT SAMPLED. Every column of both tables is
-- asserted for INSERT and for UPDATE, so a privilege nobody intended cannot sit
-- in a column nobody thought to name.

WITH
roles(role, plane) AS (
  VALUES ('app_runtime','tenant'), ('app_runtime_prod','tenant'),
         ('app_auth','auth'),      ('app_auth_prod','auth')
),
-- A role or table that does not exist would make has_*_privilege raise, which
-- reads as a broken query rather than a missing object. Filter, then report the
-- absence explicitly in the summary.
present AS (
  SELECT r.role, r.plane FROM roles r
   WHERE EXISTS (SELECT 1 FROM pg_roles pr WHERE pr.rolname = r.role)
),
tbls(tbl) AS (VALUES ('AuthSession'), ('AuthSessionSecret')),
privs(priv) AS (
  VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),
         ('TRUNCATE'),('REFERENCES'),('TRIGGER')
),
cols AS (
  SELECT c.table_name AS tbl, c.column_name AS col
    FROM information_schema.columns c
   WHERE c.table_schema = 'public'
     AND c.table_name IN ('AuthSession','AuthSessionSecret')
),

-- ── 1. table-level privileges ───────────────────────────────────────────────
sec_table AS (
  SELECT '1 TABLE' AS section, p.role, p.plane, t.tbl AS object, v.priv,
         has_table_privilege(p.role, ('public."'||t.tbl||'"')::regclass, v.priv) AS observed,
         CASE WHEN p.plane = 'tenant' THEN false
              -- the auth plane holds SELECT and DELETE at table level; INSERT and
              -- UPDATE are column-level only, so table-level must read FALSE
              WHEN v.priv IN ('SELECT','DELETE') THEN true
              ELSE false END AS exp_corrected,
         CASE WHEN p.plane = 'auth' THEN false
              -- what the default ACL {app_runtime=arwd} confers, and no more
              WHEN v.priv IN ('SELECT','INSERT','UPDATE','DELETE') THEN true
              ELSE false END AS exp_pre
    FROM present p, tbls t, privs v
),

-- ── 2. INSERT, every column of both tables ──────────────────────────────────
sec_insert AS (
  SELECT '2 INSERT COL' AS section, p.role, p.plane, c.tbl||'.'||c.col AS object,
         'INSERT' AS priv,
         has_column_privilege(p.role, ('public."'||c.tbl||'"')::regclass, c.col, 'INSERT') AS observed,
         CASE WHEN p.plane = 'tenant' THEN false
              -- a session is never born revoked
              WHEN c.tbl = 'AuthSession'
                   AND c.col IN ('revokedAt','revokedReason') THEN false
              ELSE true END AS exp_corrected,
         -- table-level INSERT makes has_column_privilege true for every column
         (p.plane = 'tenant') AS exp_pre
    FROM present p, cols c
),

-- ── 3. UPDATE, every column of both tables ──────────────────────────────────
sec_update AS (
  SELECT '3 UPDATE COL' AS section, p.role, p.plane, c.tbl||'.'||c.col AS object,
         'UPDATE' AS priv,
         has_column_privilege(p.role, ('public."'||c.tbl||'"')::regclass, c.col, 'UPDATE') AS observed,
         CASE WHEN p.plane = 'tenant' THEN false
              -- nothing may ever update a rotation record
              WHEN c.tbl = 'AuthSessionSecret' THEN false
              -- rotation and revocation only. Everything absent from this list is
              -- withheld on purpose: absoluteExpiresAt is the 90-day ceiling,
              -- tokenVersionAtIssue is the global logout switch, userId is which
              -- account the session belongs to.
              WHEN c.col IN ('secretHash','lastUsedAt','idleExpiresAt',
                             'revokedAt','revokedReason') THEN true
              ELSE false END AS exp_corrected,
         (p.plane = 'tenant') AS exp_pre
    FROM present p, cols c
),

all_checks AS (
  SELECT * FROM sec_table
  UNION ALL SELECT * FROM sec_insert
  UNION ALL SELECT * FROM sec_update
),
judged AS (
  SELECT *,
         (observed = exp_corrected) AS ok_corrected,
         (observed = exp_pre)       AS ok_pre
    FROM all_checks
),
counts AS (
  SELECT (SELECT count(*) FROM public."AuthSession")       AS sessions,
         (SELECT count(*) FROM public."AuthSessionSecret") AS secrets
),
tally AS (
  SELECT count(*) AS total,
         count(*) FILTER (WHERE NOT ok_corrected) AS bad_corrected,
         count(*) FILTER (WHERE NOT ok_pre)       AS bad_pre
    FROM judged
)

-- ── detail: only the rows that disagree with the CORRECTED contract ─────────
-- A passing run prints no detail rows at all, so anything printed here is the
-- finding rather than something to read past.
SELECT section, role, object, priv,
       observed::text        AS observed,
       exp_corrected::text   AS expected_corrected,
       exp_pre::text         AS expected_pre_correction
  FROM judged
 WHERE NOT ok_corrected
 ORDER BY section, role, object, priv;

-- ── summary: run this second ────────────────────────────────────────────────
WITH
roles(role, plane) AS (
  VALUES ('app_runtime','tenant'), ('app_runtime_prod','tenant'),
         ('app_auth','auth'),      ('app_auth_prod','auth')
),
present AS (
  SELECT r.role, r.plane FROM roles r
   WHERE EXISTS (SELECT 1 FROM pg_roles pr WHERE pr.rolname = r.role)
),
tbls(tbl) AS (VALUES ('AuthSession'), ('AuthSessionSecret')),
privs(priv) AS (
  VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),
         ('TRUNCATE'),('REFERENCES'),('TRIGGER')
),
cols AS (
  SELECT c.table_name AS tbl, c.column_name AS col
    FROM information_schema.columns c
   WHERE c.table_schema='public' AND c.table_name IN ('AuthSession','AuthSessionSecret')
),
sec_table AS (
  SELECT p.role, p.plane,
         has_table_privilege(p.role, ('public."'||t.tbl||'"')::regclass, v.priv) AS observed,
         CASE WHEN p.plane='tenant' THEN false
              WHEN v.priv IN ('SELECT','DELETE') THEN true ELSE false END AS exp_corrected,
         CASE WHEN p.plane='auth' THEN false
              WHEN v.priv IN ('SELECT','INSERT','UPDATE','DELETE') THEN true
              ELSE false END AS exp_pre
    FROM present p, tbls t, privs v
),
sec_insert AS (
  SELECT p.role, p.plane,
         has_column_privilege(p.role, ('public."'||c.tbl||'"')::regclass, c.col, 'INSERT') AS observed,
         CASE WHEN p.plane='tenant' THEN false
              WHEN c.tbl='AuthSession' AND c.col IN ('revokedAt','revokedReason') THEN false
              ELSE true END AS exp_corrected,
         (p.plane='tenant') AS exp_pre
    FROM present p, cols c
),
sec_update AS (
  SELECT p.role, p.plane,
         has_column_privilege(p.role, ('public."'||c.tbl||'"')::regclass, c.col, 'UPDATE') AS observed,
         CASE WHEN p.plane='tenant' THEN false
              WHEN c.tbl='AuthSessionSecret' THEN false
              WHEN c.col IN ('secretHash','lastUsedAt','idleExpiresAt','revokedAt','revokedReason')
                THEN true ELSE false END AS exp_corrected,
         (p.plane='tenant') AS exp_pre
    FROM present p, cols c
),
judged AS (
  SELECT observed, exp_corrected, exp_pre FROM sec_table
  UNION ALL SELECT observed, exp_corrected, exp_pre FROM sec_insert
  UNION ALL SELECT observed, exp_corrected, exp_pre FROM sec_update
)
SELECT
  (SELECT count(*) FROM judged)                                          AS checks_run,
  (SELECT count(*) FROM judged WHERE observed <> exp_corrected)          AS mismatches_vs_corrected,
  (SELECT count(*) FROM judged WHERE observed <> exp_pre)                AS mismatches_vs_pre_correction,
  CASE WHEN (SELECT count(*) FROM judged WHERE observed <> exp_corrected) = 0
       THEN 'YES' ELSE 'no' END                                          AS matches_corrected,
  CASE WHEN (SELECT count(*) FROM judged WHERE observed <> exp_pre) = 0
       THEN 'YES' ELSE 'no' END                                          AS matches_pre_correction,
  (SELECT count(*) FROM public."AuthSession")                            AS authsession_rows,
  (SELECT count(*) FROM public."AuthSessionSecret")                      AS authsessionsecret_rows,
  -- A role that does not exist is silently skipped above, so say so here rather
  -- than letting four expected identities quietly become two.
  (SELECT count(*) FROM present)                                         AS roles_found_of_4;
