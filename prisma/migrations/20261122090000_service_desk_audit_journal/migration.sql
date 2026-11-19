-- ============================================================================================================
-- 20261122090000_service_desk_audit_journal — Service Desk P4: every write leaves an audit event.
--
-- Owner decision 2026-11-09 (P4, structure approved): a launch prerequisite. Three parts, NO change to any existing
-- function, table column, policy or grant:
--
--   1. ServiceCaseEvent (the case journal) gains four STATUS-PRESERVING events — the technician assigned, the intake data
--      recorded, a cover decision recorded, QA results recorded. Each bumps the case version (seq = version, as every
--      event) and leaves status, hold, cancel request and outcome as they were; the existing guards already demand that
--      the event's after-state equals the case (service_event_matches_case), so they need no change. A new CHECK makes
--      the four "in place" and pairs each action with its event type. The payload stays closed (ServiceCaseEvent_
--      payload_closed: tokens, numbers, booleans — never free text).
--   2. ServiceSettingsEvent — an append-only journal of settings changes: which fields changed (tokens, never values), the
--      settings version, who and when. FORCE RLS, per-command SELECT / INSERT policies, SELECT + INSERT to the runtime
--      only; UPDATE only by its own erasure path, DELETE only by a cascade, TRUNCATE never.
--   3. service_settings_journal_erase_business() — SECURITY DEFINER, for account deletion: blanks the acting user and the
--      request digest of the business's settings events (the case journal is already blanked by service_erase_business).
--      Its own function, so this migration is independent of #1026 (which replaces service_desk_ui_erase_business and
--      service_settings_guard — neither is touched here).
--
-- After an account deletion a settings event keeps: id, businessId, settingsVersion, changedFields (field-name tokens),
-- actor = OWNER_USER, occurredAt, idempotencyKey (a random UUIDv7 — its only content is its creation time).
-- ============================================================================================================

-- ── 1. The case journal: four status-preserving events ──────────────────────────────────────────────────────
ALTER TYPE "ServiceEventType" ADD VALUE IF NOT EXISTS 'case.technician_assigned';
ALTER TYPE "ServiceEventType" ADD VALUE IF NOT EXISTS 'intake.recorded';
ALTER TYPE "ServiceEventType" ADD VALUE IF NOT EXISTS 'coverage.recorded';
ALTER TYPE "ServiceEventType" ADD VALUE IF NOT EXISTS 'qa.recorded';
ALTER TYPE "ServiceCaseAction" ADD VALUE IF NOT EXISTS 'ASSIGN_TECHNICIAN';
ALTER TYPE "ServiceCaseAction" ADD VALUE IF NOT EXISTS 'RECORD_INTAKE';
ALTER TYPE "ServiceCaseAction" ADD VALUE IF NOT EXISTS 'RECORD_COVERAGE';
ALTER TYPE "ServiceCaseAction" ADD VALUE IF NOT EXISTS 'RECORD_QA';

-- The four records never move the case: same status, same hold, same cancel request, by the owner — and each action
-- comes only with its own event type (compared as text: the new enum values are not used before this transaction ends).
ALTER TABLE "ServiceCaseEvent" ADD CONSTRAINT "ServiceCaseEvent_record_in_place" CHECK (
      ("action"::text IN ('ASSIGN_TECHNICIAN', 'RECORD_INTAKE', 'RECORD_COVERAGE', 'RECORD_QA'))
    = ("eventType"::text IN ('case.technician_assigned', 'intake.recorded', 'coverage.recorded', 'qa.recorded'))
  AND ("action"::text <> 'ASSIGN_TECHNICIAN' OR "eventType"::text = 'case.technician_assigned')
  AND ("action"::text <> 'RECORD_INTAKE' OR "eventType"::text = 'intake.recorded')
  AND ("action"::text <> 'RECORD_COVERAGE' OR "eventType"::text = 'coverage.recorded')
  AND ("action"::text <> 'RECORD_QA' OR "eventType"::text = 'qa.recorded')
  AND ("action"::text NOT IN ('ASSIGN_TECHNICIAN', 'RECORD_INTAKE', 'RECORD_COVERAGE', 'RECORD_QA') OR (
            "fromStatus" = "toStatus"
        AND "holdReasonBefore" IS NOT DISTINCT FROM "holdReasonAfter"
        AND "cancellationRequestedBefore" = "cancellationRequestedAfter"
        AND "actor" = 'OWNER_USER')));

-- ── 2. The settings journal ─────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "ServiceSettingsEvent" (
  "id"              SERIAL NOT NULL,
  "businessId"      INTEGER NOT NULL,
  "settingsVersion" INTEGER NOT NULL,
  "changedFields"   TEXT[] NOT NULL,
  "actor"           "ServiceActor" NOT NULL,
  "actorUserId"     INTEGER,
  "occurredAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "idempotencyKey"  TEXT NOT NULL,
  "requestDigest"   TEXT,
  "digestKeyId"     TEXT,
  CONSTRAINT "ServiceSettingsEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ServiceSettingsEvent_version" CHECK ("settingsVersion" >= 1),
  -- Field names only, from a closed set: never a value, never free text.
  CONSTRAINT "ServiceSettingsEvent_fields" CHECK (
        cardinality("changedFields") BETWEEN 1 AND 4
    AND "changedFields" <@ ARRAY['defaultStaffMemberId', 'warrantyTemplate', 'activeTermsVersionId', 'activeStatutoryNoticeVersionId']::text[]),
  CONSTRAINT "ServiceSettingsEvent_only_owner_has_user" CHECK ("actor" = 'OWNER_USER' OR "actorUserId" IS NULL),
  CONSTRAINT "ServiceSettingsEvent_by_owner" CHECK ("actor" = 'OWNER_USER'),
  CONSTRAINT "ServiceSettingsEvent_tokens" CHECK (
        "idempotencyKey" ~ '^[A-Za-z0-9:_#-]{8,200}$'
    AND ("requestDigest" IS NULL OR "requestDigest" ~ '^[0-9a-f]{64}$')
    AND ("digestKeyId" IS NULL OR "digestKeyId" ~ '^[A-Za-z0-9_-]{1,32}$')
    AND (("requestDigest" IS NULL) = ("digestKeyId" IS NULL)))
);
CREATE UNIQUE INDEX "ServiceSettingsEvent_businessId_idempotencyKey_key" ON "ServiceSettingsEvent"("businessId", "idempotencyKey");
CREATE UNIQUE INDEX "ServiceSettingsEvent_businessId_settingsVersion_key" ON "ServiceSettingsEvent"("businessId", "settingsVersion");
CREATE INDEX "ServiceSettingsEvent_businessId_occurredAt_idx" ON "ServiceSettingsEvent"("businessId", "occurredAt");
-- No foreign key to ServiceSettings: the journal outlives the settings row (an account deletion may remove it).
ALTER TABLE "ServiceSettingsEvent" ADD CONSTRAINT "ServiceSettingsEvent_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceSettingsEvent" ADD CONSTRAINT "ServiceSettingsEvent_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The acting user belongs to the business (the foundation's shared guard, reused unchanged).
CREATE TRIGGER "ServiceSettingsEvent_user_same_business"
  BEFORE INSERT OR UPDATE OF "businessId", "actorUserId" ON "ServiceSettingsEvent"
  FOR EACH ROW EXECUTE FUNCTION public.service_user_same_business('actorUserId');

-- An insert names the settings version it records: the business's settings row must be at exactly that version.
CREATE OR REPLACE FUNCTION public.service_settings_event_matches()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."ServiceSettings" s WHERE s."businessId" = NEW."businessId" AND s."version" = NEW."settingsVersion") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU12', MESSAGE = 'SERVICE_SETTINGS_EVENT_MISMATCH: the event must name the settings version this transaction wrote';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_settings_event_matches() FROM PUBLIC;
CREATE TRIGGER "ServiceSettingsEvent_matches_settings" BEFORE INSERT ON "ServiceSettingsEvent"
  FOR EACH ROW EXECUTE FUNCTION public.service_settings_event_matches();

-- Append-only: UPDATE only on the erasure path (marker + table owner, blanking user and digest) or the FK's SET NULL of
-- a removed user; DELETE only through a cascade; TRUNCATE never.
CREATE OR REPLACE FUNCTION public.service_settings_event_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  in_erasure boolean :=
        current_setting('dubiz.service_settings_journal_erasure', true) = 'on'
    AND current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = TG_RELID);
  scrubbable constant text[] := ARRAY['actorUserId', 'requestDigest', 'digestKeyId'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF in_erasure
       AND (to_jsonb(NEW) - scrubbable) = (to_jsonb(OLD) - scrubbable)
       AND NEW."actorUserId" IS NULL AND NEW."requestDigest" IS NULL AND NEW."digestKeyId" IS NULL THEN
      RETURN NEW;
    END IF;
    IF pg_trigger_depth() > 1 AND NEW."actorUserId" IS NULL
       AND (to_jsonb(NEW) - 'actorUserId') = (to_jsonb(OLD) - 'actorUserId') THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = 'DZU13',
    MESSAGE = format('SERVICE_SETTINGS_EVENT_APPEND_ONLY: %s on %I is refused; the settings journal is append-only', TG_OP, TG_TABLE_NAME);
END
$fn$;
REVOKE ALL ON FUNCTION public.service_settings_event_guard() FROM PUBLIC;
CREATE TRIGGER "ServiceSettingsEvent_append_only" BEFORE UPDATE OR DELETE ON "ServiceSettingsEvent"
  FOR EACH ROW EXECUTE FUNCTION public.service_settings_event_guard();
CREATE TRIGGER "ServiceSettingsEvent_no_truncate" BEFORE TRUNCATE ON "ServiceSettingsEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION public.service_journal_truncate_guard();

ALTER TABLE "ServiceSettingsEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ServiceSettingsEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY service_settings_event_tenant_select ON "ServiceSettingsEvent" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_settings_event_tenant_insert ON "ServiceSettingsEvent" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- Privileges, named explicitly (the 1.3-0 pattern): the owner's DEFAULT PRIVILEGES hand every new table to the runtime
-- with all rights, so every grant that is not the owner's is revoked first — then exactly SELECT + INSERT are given.
REVOKE ALL ON "ServiceSettingsEvent" FROM PUBLIC;
REVOKE ALL ON SEQUENCE "ServiceSettingsEvent_id_seq" FROM PUBLIC;
DO $do$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT c.oid::regclass::text AS rel, pg_get_userbyid(x.grantee) AS grantee, c.relkind
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
     WHERE c.relname IN ('ServiceSettingsEvent', 'ServiceSettingsEvent_id_seq')
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
GRANT SELECT, INSERT ON "ServiceSettingsEvent" TO app_runtime;
GRANT USAGE, SELECT ON SEQUENCE "ServiceSettingsEvent_id_seq" TO app_runtime;

-- ── 3. Account deletion of the settings journal ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.service_settings_journal_erase_business()
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
    RAISE EXCEPTION USING ERRCODE = 'DZU14', MESSAGE = 'SERVICE_SETTINGS_JOURNAL_ERASURE_NO_CONTEXT: no tenant context; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public."Business" b WHERE b."id" = v_business
                   AND (b."deletionRequestedAt" IS NOT NULL OR b."deletedAt" IS NOT NULL)) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU14', MESSAGE = 'SERVICE_SETTINGS_JOURNAL_ERASURE_NOT_DELETING: only a business being deleted; nothing was changed';
  END IF;
  PERFORM set_config('dubiz.service_settings_journal_erasure', 'on', true);
  UPDATE public."ServiceSettingsEvent" SET "actorUserId" = NULL, "requestDigest" = NULL, "digestKeyId" = NULL
   WHERE "businessId" = v_business AND ("actorUserId" IS NOT NULL OR "requestDigest" IS NOT NULL OR "digestKeyId" IS NOT NULL);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('dubiz.service_settings_journal_erasure', 'off', true);
  RETURN v_n;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_settings_journal_erase_business() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.service_settings_journal_erase_business() TO app_runtime;
