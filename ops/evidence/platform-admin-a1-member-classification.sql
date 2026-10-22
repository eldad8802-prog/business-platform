-- ============================================================================
-- platform-admin-a1-member-classification.sql
--
-- Read-only Production CLASSIFICATION of every LOGIN role that is a member of app_admin, before
-- migration 20261024090000_platform_admin_a1 gives app_admin column-scoped SELECT.
--
-- Why: the A1 preflight (run 39796073296, 10/10 PASS) reported INFO 11 = 1 LOGIN member of app_admin,
-- before the read login exists. On PostgreSQL 16+ the role that made app_admin (20260825090000) is
-- itself recorded as a member WITH ADMIN OPTION, INHERIT FALSE, SET FALSE: it can administer the
-- membership but receives none of app_admin's privileges. This file proves which case it is.
--
-- NAMES NEVER APPEAR: one row per member, true/false flags and counts only.
--   is_session_role        it is the role this evidence session runs as (the migration / owner role)
--   owns_business          it owns "Business" (the schema owner: already holds every table privilege)
--   admin_opt / inherit_opt / set_opt   the membership options as recorded in pg_auth_members
--   inherits_app_admin     pg_has_role USAGE: privileges of app_admin flow to it
--   can_set_app_admin      pg_has_role SET: it could SET ROLE app_admin
--   superuser / bypassrls  role attributes
--   other_groups_n         how many other groups it belongs to
-- A row with inherits_app_admin = false AND can_set_app_admin = false gains nothing from the A1 SELECT.
-- PRIVACY: catalog only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== platform admin A1: LOGIN members of app_admin, classified (one row per member, no names) =='

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
adm AS (SELECT oid FROM pg_roles WHERE rolname = 'app_admin'),
biz AS (SELECT c.relowner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'Business' AND c.relkind = 'r'),
mem AS (SELECT r.oid, r.rolname, r.rolsuper, r.rolbypassrls, m.admin_option, m.inherit_option, m.set_option
        FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
        WHERE m.roleid = (SELECT oid FROM adm) AND r.rolcanlogin)
SELECT
  row_number() OVER (ORDER BY mem.oid)                                    AS member_n,
  mem.rolname = current_user                                              AS is_session_role,
  mem.oid = (SELECT relowner FROM biz)                                    AS owns_business,
  mem.admin_option                                                        AS admin_opt,
  mem.inherit_option                                                      AS inherit_opt,
  mem.set_option                                                          AS set_opt,
  pg_has_role(mem.oid, (SELECT oid FROM adm), 'USAGE')                    AS inherits_app_admin,
  pg_has_role(mem.oid, (SELECT oid FROM adm), 'SET')                      AS can_set_app_admin,
  mem.rolsuper                                                            AS superuser,
  mem.rolbypassrls                                                        AS bypassrls,
  (SELECT count(*) FROM pg_auth_members m2 WHERE m2.member = mem.oid AND m2.roleid <> (SELECT oid FROM adm)) AS other_groups_n
FROM mem
ORDER BY member_n;

ROLLBACK;
