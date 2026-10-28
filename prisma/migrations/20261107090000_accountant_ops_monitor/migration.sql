-- Accountant package — operations monitoring (G5 milestone 1, M2)
--
-- WHAT THIS ADDS (three tables; nothing existing is changed)
--   "AccountantOpsRun"         platform: one row per run of the accountant sweep or of its monitor — when it started
--                              and finished, how it ended, and counts (numbers and booleans only, by CHECK). A run
--                              that never finishes stays RUNNING: that is how a crashed or timed-out run is seen.
--   "AccountantOpsAlert"       platform: one row per platform-level finding (the sweep did not run, failed, or the
--                              monitor could not look everywhere) while it is open, and its notification bookkeeping.
--   "AccountantBusinessAlert"  tenant: the same for one business's finding (a month not prepared in time, a failed or
--                              stuck preparation, an overdue retry, a stuck or uncertain send, a failure, a bounce, a
--                              spam complaint, a silent webhook). A code, a subject (a month or a delivery id) and a
--                              closed detail — never an address, a link, a token, a name or a document.
--
-- ONE OPEN ALERT PER FINDING
--   A partial unique index allows one OPEN row per (code, subject) — per business for the tenant table — so two
--   monitors running at the same moment cannot open the same alert twice (INSERT … ON CONFLICT DO NOTHING). A
--   finding that recovers is resolved (resolvedAt); if it comes back it is a new row. Notifications are claimed by a
--   conditional UPDATE of notifyCount / resolvedNotifiedAt, so of two concurrent monitors exactly one sends.
--
-- ISOLATION
--   "AccountantBusinessAlert": ENABLE + FORCE RLS, per-command policies on app.current_business_id (SELECT, INSERT,
--   UPDATE — no DELETE), a composite (businessId, id) key, the business FK. The two platform tables carry no tenant
--   key and no business data (no id of any business, no free text: closed by CHECK), like "PlatformAuditEvent".
--
-- PRIVILEGES — named explicitly; the migration role's DEFAULT PRIVILEGES are taken back first
--   app_runtime: SELECT, INSERT and UPDATE of the bookkeeping columns only. No DELETE, no TRUNCATE, anywhere.
--   The admin console's read (app_admin) is NOT granted here: it is the separate migration
--   20261107092000_accountant_ops_admin_read, so that cross-business visibility is its own decision.
--
-- Additive. Rollback: .acct/ops-rollback.sql (owner-run; refuses while any of the three tables holds a row).

-- ── 1. AccountantOpsRun (platform) ──────────────────────────────────────────────────────────────

CREATE TABLE "AccountantOpsRun" (
  "id" SERIAL NOT NULL,
  "kind" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "finishedAt" TIMESTAMP(3),
  "outcome" TEXT NOT NULL,
  "counts" JSONB NOT NULL DEFAULT '{}',
  "errorCode" TEXT,
  CONSTRAINT "AccountantOpsRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AccountantOpsRun_kind" CHECK ("kind" IN ('SWEEP', 'MONITOR')),
  CONSTRAINT "AccountantOpsRun_source" CHECK ("source" IN ('VERCEL_CRON', 'GITHUB_ACTIONS')),
  CONSTRAINT "AccountantOpsRun_outcome" CHECK ("outcome" IN ('RUNNING', 'OK', 'FAILED')),
  CONSTRAINT "AccountantOpsRun_finished_shape" CHECK (("outcome" = 'RUNNING') = ("finishedAt" IS NULL)),
  CONSTRAINT "AccountantOpsRun_finished_after_start" CHECK ("finishedAt" IS NULL OR "finishedAt" >= "startedAt"),
  CONSTRAINT "AccountantOpsRun_errorCode" CHECK ("errorCode" IS NULL OR "errorCode" ~ '^[A-Za-z0-9_:.-]{1,64}$'),
  -- Counts only: an object of numbers, booleans and nested objects — no string anywhere.
  CONSTRAINT "AccountantOpsRun_counts_closed" CHECK (
        jsonb_typeof("counts") = 'object'
    AND octet_length("counts"::text) <= 4096
    AND NOT jsonb_path_exists("counts", 'strict $.** ? (@.type() == "string" || @.type() == "array")')
  )
);
CREATE INDEX "AccountantOpsRun_kind_startedAt_idx" ON "AccountantOpsRun"("kind", "startedAt" DESC);

-- ── 2. AccountantOpsAlert (platform) ────────────────────────────────────────────────────────────

CREATE TABLE "AccountantOpsAlert" (
  "id" SERIAL NOT NULL,
  "code" TEXT NOT NULL,
  "subjectKey" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "detail" JSONB NOT NULL DEFAULT '{}',
  "openedAt" TIMESTAMP(3) NOT NULL,
  "lastSeenAt" TIMESTAMP(3) NOT NULL,
  "notifyCount" INTEGER NOT NULL DEFAULT 0,
  "lastNotifiedAt" TIMESTAMP(3),
  "resolvedAt" TIMESTAMP(3),
  "resolvedNotifiedAt" TIMESTAMP(3),
  CONSTRAINT "AccountantOpsAlert_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AccountantOpsAlert_code" CHECK ("code" ~ '^[A-Z][A-Z0-9_]{2,47}$'),
  CONSTRAINT "AccountantOpsAlert_subject" CHECK ("subjectKey" ~ '^(-|[a-z]:[A-Za-z0-9_-]{1,40})$'),
  CONSTRAINT "AccountantOpsAlert_severity" CHECK ("severity" IN ('CRITICAL', 'HIGH', 'MEDIUM')),
  CONSTRAINT "AccountantOpsAlert_lifecycle" CHECK (
        "lastSeenAt" >= "openedAt"
    AND "notifyCount" BETWEEN 0 AND 10000
    AND ("notifyCount" = 0) = ("lastNotifiedAt" IS NULL)
    AND ("resolvedAt" IS NULL OR "resolvedAt" >= "openedAt")
    AND ("resolvedNotifiedAt" IS NULL OR "resolvedAt" IS NOT NULL)),
  -- Codes and counts only: string values are short machine tokens (no address, link or text can fit).
  CONSTRAINT "AccountantOpsAlert_detail_closed" CHECK (
        jsonb_typeof("detail") = 'object'
    AND octet_length("detail"::text) <= 1024
    AND NOT jsonb_path_exists("detail", 'strict $.** ? (@.type() == "string" && !(@ like_regex "^[A-Za-z0-9_:.-]{0,64}$"))')
  )
);
CREATE UNIQUE INDEX "AccountantOpsAlert_open_key" ON "AccountantOpsAlert"("code", "subjectKey") WHERE "resolvedAt" IS NULL;
CREATE INDEX "AccountantOpsAlert_openedAt_idx" ON "AccountantOpsAlert"("openedAt" DESC);

-- ── 3. AccountantBusinessAlert (tenant) ─────────────────────────────────────────────────────────

CREATE TABLE "AccountantBusinessAlert" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "code" TEXT NOT NULL,
  "subjectKey" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "detail" JSONB NOT NULL DEFAULT '{}',
  "openedAt" TIMESTAMP(3) NOT NULL,
  "lastSeenAt" TIMESTAMP(3) NOT NULL,
  "notifyCount" INTEGER NOT NULL DEFAULT 0,
  "lastNotifiedAt" TIMESTAMP(3),
  "resolvedAt" TIMESTAMP(3),
  "resolvedNotifiedAt" TIMESTAMP(3),
  CONSTRAINT "AccountantBusinessAlert_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AccountantBusinessAlert_code" CHECK ("code" ~ '^[A-Z][A-Z0-9_]{2,47}$'),
  CONSTRAINT "AccountantBusinessAlert_subject" CHECK ("subjectKey" ~ '^(-|[a-z]:[A-Za-z0-9_-]{1,40})$'),
  CONSTRAINT "AccountantBusinessAlert_severity" CHECK ("severity" IN ('CRITICAL', 'HIGH', 'MEDIUM')),
  CONSTRAINT "AccountantBusinessAlert_lifecycle" CHECK (
        "lastSeenAt" >= "openedAt"
    AND "notifyCount" BETWEEN 0 AND 10000
    AND ("notifyCount" = 0) = ("lastNotifiedAt" IS NULL)
    AND ("resolvedAt" IS NULL OR "resolvedAt" >= "openedAt")
    AND ("resolvedNotifiedAt" IS NULL OR "resolvedAt" IS NOT NULL)),
  CONSTRAINT "AccountantBusinessAlert_detail_closed" CHECK (
        jsonb_typeof("detail") = 'object'
    AND octet_length("detail"::text) <= 1024
    AND NOT jsonb_path_exists("detail", 'strict $.** ? (@.type() == "string" && !(@ like_regex "^[A-Za-z0-9_:.-]{0,64}$"))')
  )
);
CREATE UNIQUE INDEX "AccountantBusinessAlert_businessId_id_key" ON "AccountantBusinessAlert"("businessId", "id");
CREATE UNIQUE INDEX "AccountantBusinessAlert_open_key" ON "AccountantBusinessAlert"("businessId", "code", "subjectKey")
  WHERE "resolvedAt" IS NULL;
CREATE INDEX "AccountantBusinessAlert_openedAt_idx" ON "AccountantBusinessAlert"("openedAt" DESC);
ALTER TABLE "AccountantBusinessAlert" ADD CONSTRAINT "AccountantBusinessAlert_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AccountantBusinessAlert" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AccountantBusinessAlert" FORCE ROW LEVEL SECURITY;
CREATE POLICY accountant_business_alert_tenant_select ON "AccountantBusinessAlert" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY accountant_business_alert_tenant_insert ON "AccountantBusinessAlert" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY accountant_business_alert_tenant_update ON "AccountantBusinessAlert" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ── 4. Privileges — named explicitly ────────────────────────────────────────────────────────────

REVOKE ALL ON "AccountantOpsRun", "AccountantOpsAlert", "AccountantBusinessAlert" FROM PUBLIC;
REVOKE ALL ON SEQUENCE "AccountantOpsRun_id_seq", "AccountantOpsAlert_id_seq", "AccountantBusinessAlert_id_seq" FROM PUBLIC;

-- Whatever the migration role's DEFAULT PRIVILEGES handed out on the new objects goes first (the Daily Tasks G4
-- finding: Production's default privileges grant more than a migration names).
DO $do$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT c.oid::regclass::text AS rel, pg_get_userbyid(x.grantee) AS grantee, c.relkind
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
     WHERE c.relname IN ('AccountantOpsRun', 'AccountantOpsAlert', 'AccountantBusinessAlert',
                         'AccountantOpsRun_id_seq', 'AccountantOpsAlert_id_seq', 'AccountantBusinessAlert_id_seq')
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

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT ON "AccountantOpsRun" TO app_runtime;
    GRANT UPDATE ("finishedAt", "outcome", "counts", "errorCode") ON "AccountantOpsRun" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "AccountantOpsRun_id_seq" TO app_runtime;

    GRANT SELECT, INSERT ON "AccountantOpsAlert" TO app_runtime;
    GRANT UPDATE ("severity", "detail", "lastSeenAt", "notifyCount", "lastNotifiedAt", "resolvedAt", "resolvedNotifiedAt")
      ON "AccountantOpsAlert" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "AccountantOpsAlert_id_seq" TO app_runtime;

    GRANT SELECT, INSERT ON "AccountantBusinessAlert" TO app_runtime;
    GRANT UPDATE ("severity", "detail", "lastSeenAt", "notifyCount", "lastNotifiedAt", "resolvedAt", "resolvedNotifiedAt")
      ON "AccountantBusinessAlert" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "AccountantBusinessAlert_id_seq" TO app_runtime;
  END IF;
END
$do$;
