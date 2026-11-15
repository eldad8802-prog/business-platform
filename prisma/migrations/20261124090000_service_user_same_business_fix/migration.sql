-- ============================================================================================================
-- 20261124090000_service_user_same_business_fix — Service Desk: deleting a user who is named in TWO (or more) user
-- columns of one row no longer fails; a user of another business still can never be attached.
--
-- Migration only. ONE function body is replaced (CREATE OR REPLACE — same name, same signature, same oid, same owner,
-- same grants, still SECURITY INVOKER with the same search_path), so every trigger that uses it — in Production and in
-- every Draft migration that sorts after this one — keeps its definition and gets the fix. No table, column, type,
-- index, constraint, trigger, policy, grant or row is added, changed or removed.
--
-- THE DEFECT. public.service_user_same_business(col, …) runs BEFORE INSERT OR UPDATE OF businessId + the user columns
-- of a row and demands that EVERY named column holds NULL or a user of the row's business. The "User" foreign keys are
-- ON DELETE SET NULL, and PostgreSQL runs those actions one constraint at a time: deleting a user who is, say, both the
-- sender and the decider of a quote first runs UPDATE … SET "sentByUserId" = NULL. That UPDATE fires the guard, which
-- re-checks "decidedByUserId" — still the deleted user, whose "User" row is already gone — and raises
-- SERVICE_USER_OTHER_BUSINESS. The user cannot be deleted at all.
--
-- THE FIX. The guard still judges the FINAL value of EVERY named column, on every INSERT and every UPDATE:
--   (1) NULL, or a user that exists AND belongs to the row's business → valid (as before);
--   (2) otherwise refused (as before) — with exactly one exception, all four conditions together:
--         * the statement is an UPDATE, and
--         * this column keeps the value it already had (OLD = NEW: this statement attaches nobody), and
--         * no "User" row with that id exists at all (it is not a user of ANOTHER business — there is no such user), and
--         * the guard runs inside another trigger (pg_trigger_depth() > 1) — where PostgreSQL runs the foreign key's
--           ON DELETE SET NULL action of the user being deleted;
--   (3) a column named in the trigger that the row does not have is refused (a mistyped trigger argument used to pass
--       silently as "NULL").
-- Why the exception cannot leave an illegal attachment: the value is not set by this statement (OLD = NEW), so it was
-- checked when it was written; its user no longer exists, so it names no business at all; and every column the guard
-- checks has a NOT DEFERRABLE foreign key to "User" ON DELETE SET NULL (premise below, proven again by the evidence),
-- so the same DELETE statement sets this column to NULL too, before the statement ends. A changed column, an INSERT, a
-- user of another business, a user that exists — none of them reaches the exception.
--
-- Rejected designs (the reasoning in full is in the PR): a DEFERRED constraint trigger re-reading the row at COMMIT
-- (moves every refusal from the statement to COMMIT, needs the row re-read under the committing role's RLS, needs every
-- trigger in Production AND in seven Draft branches recreated, and leaves an illegal row readable inside the
-- transaction); INSERT-only triggers (the decision, the legal approval, the presentation and the return are UPDATEs that
-- attach a user — they would no longer be checked); skipping the check at trigger depth > 1 (any nested write would
-- skip it); one trigger per column (checks only the changed column, not the row's final state).
--
-- Rollback: .sdusb/rollback.sql re-creates the 20261112090000 function text byte for byte (and the ledger row is
-- removed). Nothing else to undo: no row is written by this migration.
-- ============================================================================================================

-- ── 0. Premises (nothing is changed when one fails) ─────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_fn oid := to_regprocedure('public.service_user_same_business()');
  v_bad text;
  v_triggers integer;
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'SERVICE_USER_SAME_BUSINESS_FIX: public.service_user_same_business() is missing (the Service Desk foundation 20261112090000); nothing was changed';
  END IF;
  IF position('SERVICE_USER_COLUMN_UNKNOWN' IN (SELECT prosrc FROM pg_proc WHERE oid = v_fn)) > 0 THEN
    RAISE EXCEPTION 'SERVICE_USER_SAME_BUSINESS_FIX: already applied (the function already carries the fix); nothing was changed';
  END IF;
  -- Exactly the foundation's text (20261112090000, lines 406–427): no other migration has replaced it since.
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = v_fn) <> 'b64faf1eb6700089bf6529ae76542036'
     OR (SELECT prosecdef OR prolang <> (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
               OR prorettype <> 'trigger'::regtype
               OR coalesce(array_to_string(proconfig, ','), '') <> 'search_path=pg_catalog, public, pg_temp'
           FROM pg_proc WHERE oid = v_fn) THEN
    RAISE EXCEPTION 'SERVICE_USER_SAME_BUSINESS_FIX: public.service_user_same_business() is not the 20261112090000 function (text, language, owner rights or search_path differ); nothing was changed';
  END IF;
  -- The existence lookups below must see every user: "User" carries no row-level security.
  IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'public."User"'::regclass) THEN
    RAISE EXCEPTION 'SERVICE_USER_SAME_BUSINESS_FIX: "User" has row-level security; the guard could not see every user; nothing was changed';
  END IF;
  -- Every trigger using the function: BEFORE, FOR EACH ROW, INSERT and/or UPDATE only, not a constraint trigger, enabled.
  SELECT count(*) INTO v_triggers FROM pg_trigger WHERE tgfoid = v_fn;
  SELECT string_agg(format('%s.%s', t.tgrelid::regclass, t.tgname), ', ') INTO v_bad
    FROM pg_trigger t
   WHERE t.tgfoid = v_fn
     AND (    (t.tgtype & 1) = 0          -- not FOR EACH ROW
           OR (t.tgtype & 2) = 0          -- not BEFORE
           OR (t.tgtype & 8) <> 0         -- DELETE
           OR (t.tgtype & 32) <> 0        -- TRUNCATE
           OR (t.tgtype & 64) <> 0        -- INSTEAD OF
           OR t.tgconstraint <> 0 OR t.tgenabled <> 'O' OR t.tgnargs < 1);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'SERVICE_USER_SAME_BUSINESS_FIX: trigger(s) of an unexpected shape use the function: %; nothing was changed', v_bad;
  END IF;
  -- Every column a trigger names is an existing integer column with exactly one single-column, NOT DEFERRABLE foreign
  -- key to "User"("id") ON DELETE SET NULL. This is what makes the one exception safe: a deleted user's id cannot
  -- outlive the DELETE statement in any column the guard checks.
  WITH args AS (
    SELECT t.tgrelid, t.tgname, a.col
      FROM pg_trigger t
      CROSS JOIN LATERAL unnest((string_to_array(encode(t.tgargs, 'escape'), '\000'))[1:t.tgnargs]) AS a(col)
     WHERE t.tgfoid = v_fn
  )
  SELECT string_agg(format('%s.%s(%s)', args.tgrelid::regclass, args.tgname, args.col), ', ') INTO v_bad
    FROM args
   WHERE NOT EXISTS (
           SELECT 1 FROM pg_attribute att
            WHERE att.attrelid = args.tgrelid AND att.attname = args.col AND NOT att.attisdropped
              AND att.atttypid = 'integer'::regtype)
      OR (SELECT count(*) FROM pg_constraint k
            JOIN pg_attribute att ON att.attrelid = k.conrelid AND att.attnum = k.conkey[1]
           WHERE k.contype = 'f' AND k.conrelid = args.tgrelid AND cardinality(k.conkey) = 1 AND att.attname = args.col
             AND k.confrelid = 'public."User"'::regclass
             AND k.confkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public."User"'::regclass AND attname = 'id')]
             AND k.confdeltype = 'n' AND NOT k.condeferrable) <> 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'SERVICE_USER_SAME_BUSINESS_FIX: column(s) without exactly one NOT DEFERRABLE "User" foreign key ON DELETE SET NULL: %; nothing was changed', v_bad;
  END IF;
  IF v_triggers < 14 THEN
    RAISE EXCEPTION 'SERVICE_USER_SAME_BUSINESS_FIX: % trigger(s) use the function, Production has 14 (20261112–20261122); nothing was changed', v_triggers;
  END IF;
END
$do$;
SET lock_timeout = '5s';

-- ── 1. The guard: the final value of every named user column ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.service_user_same_business()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  new_row constant jsonb := to_jsonb(NEW);
  old_row constant jsonb := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END;
  col text;
  uid integer;
BEGIN
  FOREACH col IN ARRAY TG_ARGV LOOP
    IF NOT (new_row ? col) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'DZS03',
        MESSAGE = format('SERVICE_USER_COLUMN_UNKNOWN: %I has no column %I to check', TG_TABLE_NAME, col);
    END IF;
    uid := (new_row ->> col)::integer;
    -- The final value: no user, or a user of the row's business.
    CONTINUE WHEN uid IS NULL;
    CONTINUE WHEN EXISTS (SELECT 1 FROM "User" u WHERE u."id" = uid AND u."businessId" = NEW."businessId");
    -- The one exception: the ON DELETE SET NULL action of the user being deleted is clearing ANOTHER column of this row
    -- first. This column is unchanged by the statement, names no existing user (so no user of another business), and
    -- its own NOT DEFERRABLE ON DELETE SET NULL foreign key clears it within the same DELETE statement.
    CONTINUE WHEN TG_OP = 'UPDATE'
              AND pg_trigger_depth() > 1
              AND (old_row ->> col)::integer = uid
              AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = uid);
    RAISE EXCEPTION USING
      ERRCODE = 'DZS03',
      MESSAGE = format('SERVICE_USER_OTHER_BUSINESS: %I.%I must name a user of the same business', TG_TABLE_NAME, col);
  END LOOP;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_user_same_business() FROM PUBLIC;

-- ── 2. Post-conditions (the transaction fails whole when one does not hold) ─────────────────────────────────
DO $do$
DECLARE
  v_fn oid := to_regprocedure('public.service_user_same_business()');
BEGIN
  IF (SELECT prosecdef OR coalesce(array_to_string(proconfig, ','), '') <> 'search_path=pg_catalog, public, pg_temp'
        OR has_function_privilege('public', v_fn, 'EXECUTE') FROM pg_proc WHERE oid = v_fn) THEN
    RAISE EXCEPTION 'SERVICE_USER_SAME_BUSINESS_FIX: the replaced function is SECURITY DEFINER, lost its search_path or is executable by PUBLIC';
  END IF;
  IF position('SERVICE_USER_COLUMN_UNKNOWN' IN (SELECT prosrc FROM pg_proc WHERE oid = v_fn)) = 0 THEN
    RAISE EXCEPTION 'SERVICE_USER_SAME_BUSINESS_FIX: the function was not replaced';
  END IF;
END
$do$;
