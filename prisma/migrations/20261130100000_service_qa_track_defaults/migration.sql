-- ============================================================================================================
-- 20261130100000_service_qa_track_defaults — Service Desk: the business's own DEFAULT QA list per service track (T1–T7).
-- DRAFT — never applied without the owner's separate approval. Order: after 20261129090000 (QA lists, #1124), which it
-- requires (its ServiceQaList table and its erasure marker helper service_qa_in_erasure are the premise).
--
-- Owner decision 2026-11-12: the default is chosen BY THE BUSINESS, per track — never derived from its category; the
-- built-in templates stay suggestions only. A case opened on a track whose QA is not OFF names the default list's CURRENT
-- version (through the existing, journaled choice of #1124: CHOOSE_QA_LIST at the case's version 2 — the case guard,
-- unchanged, still refuses a list on the INSERT); an explicit choice at the opening overrides it; no default = no list
-- (REQUIRED falls back to the built-in template, as today). Changing the default never touches an existing case: a case
-- names a list VERSION (ServiceCase.qaListId / qaListVersion), never the default.
--
--   "ServiceQaTrackDefault"   ONE append-only table — the journal IS the state (the shape of ServiceQaListEvent, the
--                             idempotency ledger of the command too): each row is "track T of business B names list L (or
--                             none) from revision n". The current default of a track is its highest revision. A change is
--                             the next revision (exactly max + 1 — the unique key settles two writers racing for it); a
--                             list named must be an ACTIVE list of the same business at that moment (composite FK + guard).
--                             Archiving the list later does not rewrite anything: the opening then treats an archived
--                             default as no default (the code reads the list's state), and restoring it makes it count again.
--   erasure                   service_qa_track_defaults_erase_business() — SECURITY DEFINER, its own function: who acted
--                             and the request digest are blanked in place (the same marker as the QA lists' erasure).
--
-- Unchanged: every existing table, row, constraint, policy, grant, enum and function. No column is added anywhere.
-- ============================================================================================================

-- ── 0. Premises ─────────────────────────────────────────────────────────────────────────────────────────────
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    RAISE EXCEPTION 'SERVICE_QA_TRACK_DEFAULTS: role app_runtime is missing; nothing was changed';
  END IF;
  IF to_regclass('public."ServiceQaList"') IS NULL OR NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'ServiceQaList_businessId_id_key') THEN
    RAISE EXCEPTION 'SERVICE_QA_TRACK_DEFAULTS: the QA lists migration (20261129090000) is not applied; nothing was changed';
  END IF;
  IF to_regprocedure('public.service_qa_in_erasure(oid)') IS NULL OR to_regprocedure('public.service_user_same_business()') IS NULL
     OR to_regprocedure('public.service_journal_truncate_guard()') IS NULL OR to_regprocedure('public.service_ui_business_writable(integer)') IS NULL THEN
    RAISE EXCEPTION 'SERVICE_QA_TRACK_DEFAULTS: the Service Desk helper functions are missing; nothing was changed';
  END IF;
  IF to_regclass('public."ServiceQaTrackDefault"') IS NOT NULL THEN
    RAISE EXCEPTION 'SERVICE_QA_TRACK_DEFAULTS: "ServiceQaTrackDefault" already exists; nothing was changed';
  END IF;
END
$do$;

SET lock_timeout = '5s';

-- ── 1. The table ────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "ServiceQaTrackDefault" (
  "id"             SERIAL NOT NULL,
  "businessId"     INTEGER NOT NULL,
  -- the service track (lib/services/service-desk/service-profiles.ts SERVICE_TRACKS) — a code token
  "track"          TEXT NOT NULL,
  "revision"       INTEGER NOT NULL,
  -- NULL = the track has no default (cleared)
  "listId"         INTEGER,
  "actor"          "ServiceActor" NOT NULL,
  "actorUserId"    INTEGER,
  "occurredAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "idempotencyKey" TEXT NOT NULL,
  "requestDigest"  TEXT,
  "digestKeyId"    TEXT,
  CONSTRAINT "ServiceQaTrackDefault_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ServiceQaTrackDefault_track" CHECK ("track" IN ('T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7')),
  CONSTRAINT "ServiceQaTrackDefault_revision" CHECK ("revision" >= 1),
  -- the first revision of a track names a list (there is nothing to clear before it)
  CONSTRAINT "ServiceQaTrackDefault_first_names_list" CHECK ("revision" > 1 OR "listId" IS NOT NULL),
  CONSTRAINT "ServiceQaTrackDefault_by_owner" CHECK ("actor" = 'OWNER_USER'),
  CONSTRAINT "ServiceQaTrackDefault_tokens" CHECK (
        "idempotencyKey" ~ '^[A-Za-z0-9:_#-]{8,200}$'
    AND ("requestDigest" IS NULL OR "requestDigest" ~ '^[0-9a-f]{64}$')
    AND ("digestKeyId" IS NULL OR "digestKeyId" ~ '^[A-Za-z0-9_-]{1,32}$')
    AND (("requestDigest" IS NULL) = ("digestKeyId" IS NULL)))
);
CREATE UNIQUE INDEX "ServiceQaTrackDefault_businessId_id_key" ON "ServiceQaTrackDefault"("businessId", "id");
CREATE UNIQUE INDEX "ServiceQaTrackDefault_businessId_track_revision_key" ON "ServiceQaTrackDefault"("businessId", "track", "revision");
CREATE UNIQUE INDEX "ServiceQaTrackDefault_businessId_idempotencyKey_key" ON "ServiceQaTrackDefault"("businessId", "idempotencyKey");
CREATE INDEX "ServiceQaTrackDefault_businessId_listId_idx" ON "ServiceQaTrackDefault"("businessId", "listId") WHERE "listId" IS NOT NULL;
ALTER TABLE "ServiceQaTrackDefault" ADD CONSTRAINT "ServiceQaTrackDefault_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- the list is one of THIS business (a list is archived, never deleted)
ALTER TABLE "ServiceQaTrackDefault" ADD CONSTRAINT "ServiceQaTrackDefault_list_tenant_fkey"
  FOREIGN KEY ("businessId", "listId") REFERENCES "ServiceQaList"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServiceQaTrackDefault" ADD CONSTRAINT "ServiceQaTrackDefault_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The acting user belongs to the business (the foundation's shared guard, reused unchanged).
CREATE TRIGGER "ServiceQaTrackDefault_user_same_business"
  BEFORE INSERT OR UPDATE OF "businessId", "actorUserId" ON "ServiceQaTrackDefault"
  FOR EACH ROW EXECUTE FUNCTION public.service_user_same_business('actorUserId');

-- ── 2. The guard ────────────────────────────────────────────────────────────────────────────────────────────
-- A row is written once, by an owner user, while the business is writable: the track's NEXT revision (never a gap, never
-- backwards), naming an ACTIVE list of the business (read FOR SHARE: an archive waits for this to commit) or none. Then
-- append-only: UPDATE only by the erasure (user and digest to NULL, under the QA erasure marker) or the FK action of a
-- deleted user; DELETE only by the cascade of a deleted business; TRUNCATE never.
CREATE OR REPLACE FUNCTION public.service_qa_track_default_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  scrubbable constant text[] := ARRAY['actorUserId', 'requestDigest', 'digestKeyId'];
  v_last integer;
  l record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF public.service_qa_in_erasure(TG_RELID)
       AND (to_jsonb(NEW) - scrubbable) = (to_jsonb(OLD) - scrubbable)
       AND NEW."actorUserId" IS NULL AND NEW."requestDigest" IS NULL AND NEW."digestKeyId" IS NULL THEN
      RETURN NEW;
    END IF;
    IF pg_trigger_depth() > 1 AND NEW."actorUserId" IS NULL
       AND (to_jsonb(NEW) - 'actorUserId') = (to_jsonb(OLD) - 'actorUserId') THEN
      RETURN NEW;
    END IF;
  ELSE
    IF NOT public.service_ui_business_writable(NEW."businessId") THEN
      RAISE EXCEPTION USING ERRCODE = 'DZU02', MESSAGE = 'SERVICE_UI_BUSINESS_DELETING: the business is being deleted; nothing was written';
    END IF;
    IF NEW."actorUserId" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'DZS09', MESSAGE = 'SERVICE_QA_TRACK_DEFAULT_NEW: a default is chosen by an owner user';
    END IF;
    SELECT max("revision") INTO v_last FROM public."ServiceQaTrackDefault"
     WHERE "businessId" = NEW."businessId" AND "track" = NEW."track";
    IF NEW."revision" <> coalesce(v_last, 0) + 1 THEN
      RAISE EXCEPTION USING ERRCODE = 'DZS09',
        MESSAGE = format('SERVICE_QA_TRACK_DEFAULT_REVISION: track %s is at revision %s; a change is the next one', NEW."track", coalesce(v_last, 0));
    END IF;
    IF NEW."listId" IS NOT NULL THEN
      SELECT "archivedAt" INTO l FROM public."ServiceQaList" WHERE "businessId" = NEW."businessId" AND "id" = NEW."listId" FOR SHARE;
      IF NOT FOUND OR l."archivedAt" IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'DZS09', MESSAGE = 'SERVICE_QA_TRACK_DEFAULT_LIST: a default names an active QA list of its business';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'DZS09',
    MESSAGE = format('SERVICE_QA_TRACK_DEFAULT_APPEND_ONLY: %s on %I is refused; a default is changed by its next revision', TG_OP, TG_TABLE_NAME);
END
$fn$;
REVOKE ALL ON FUNCTION public.service_qa_track_default_guard() FROM PUBLIC;
CREATE TRIGGER "ServiceQaTrackDefault_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ServiceQaTrackDefault"
  FOR EACH ROW EXECUTE FUNCTION public.service_qa_track_default_guard();
CREATE TRIGGER "ServiceQaTrackDefault_no_truncate" BEFORE TRUNCATE ON "ServiceQaTrackDefault"
  FOR EACH STATEMENT EXECUTE FUNCTION public.service_journal_truncate_guard();

-- ── 3. Erasure (account deletion) ───────────────────────────────────────────────────────────────────────────
-- CONTRACT: no arguments; the business is the tenant context. Refuses (DZS08, nothing changed) without a context or when
-- that business is not being deleted. Otherwise blanks IN PLACE, for that business only:
--   ServiceQaTrackDefault  actorUserId, requestDigest, digestKeyId
-- Kept: the track, the revision, the list id (a number), the time, the request key (a random UUIDv7). Call it in the
-- purge transaction with the other Service Desk erase functions (order-independent). Re-run safe (0 the second time).
CREATE OR REPLACE FUNCTION public.service_qa_track_defaults_erase_business()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_business integer := NULLIF(current_setting('app.current_business_id', true), '')::integer;
  v_n integer := 0;
BEGIN
  IF v_business IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS08', MESSAGE = 'SERVICE_QA_TRACK_DEFAULTS_ERASURE_NO_CONTEXT: no tenant context; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public."Business" b WHERE b."id" = v_business
                   AND (b."deletionRequestedAt" IS NOT NULL OR b."deletedAt" IS NOT NULL)) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS08', MESSAGE = 'SERVICE_QA_TRACK_DEFAULTS_ERASURE_NOT_DELETING: the business is not being deleted; nothing was changed';
  END IF;
  PERFORM set_config('dubiz.service_qa_erasure', 'on', true);
  UPDATE public."ServiceQaTrackDefault" SET "actorUserId" = NULL, "requestDigest" = NULL, "digestKeyId" = NULL
   WHERE "businessId" = v_business AND ("actorUserId" IS NOT NULL OR "requestDigest" IS NOT NULL OR "digestKeyId" IS NOT NULL);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('dubiz.service_qa_erasure', 'off', true);
  RETURN v_n;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_qa_track_defaults_erase_business() FROM PUBLIC;

-- ── 4. Row-level security — per operation; no DELETE policy; UPDATE only for the owner-run erasure ──────────
ALTER TABLE "ServiceQaTrackDefault" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ServiceQaTrackDefault" FORCE ROW LEVEL SECURITY;
CREATE POLICY service_qa_track_default_tenant_select ON "ServiceQaTrackDefault" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_qa_track_default_tenant_insert ON "ServiceQaTrackDefault" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_qa_track_default_tenant_update ON "ServiceQaTrackDefault" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ── 5. Privileges — named explicitly: the runtime reads and appends, nothing else ───────────────────────────
REVOKE ALL ON "ServiceQaTrackDefault" FROM PUBLIC;
REVOKE ALL ON SEQUENCE "ServiceQaTrackDefault_id_seq" FROM PUBLIC;
DO $do$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT c.oid::regclass::text AS rel, pg_get_userbyid(x.grantee) AS grantee, c.relkind
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
     WHERE c.relname IN ('ServiceQaTrackDefault', 'ServiceQaTrackDefault_id_seq')
       AND c.relnamespace = 'public'::regnamespace
       AND x.grantee <> c.relowner AND x.grantee <> 0
  LOOP
    IF r.relkind = 'S' THEN
      EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM %I', r.rel, r.grantee);
    ELSE
      EXECUTE format('REVOKE ALL ON TABLE %s FROM %I', r.rel, r.grantee);
    END IF;
  END LOOP;
END
$do$;
GRANT SELECT, INSERT ON "ServiceQaTrackDefault" TO app_runtime;
GRANT USAGE, SELECT ON SEQUENCE "ServiceQaTrackDefault_id_seq" TO app_runtime;
GRANT EXECUTE ON FUNCTION public.service_qa_track_defaults_erase_business() TO app_runtime;
