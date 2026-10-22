-- ============================================================================================================
-- 20261026090000_payment_settlement_facts — what a payment CHARGED, what the provider SETTLED, its FEE and the
-- NET that reached the business, each number with where it came from (docs/payments/SETTLEMENT-FACTS-DESIGN.md).
-- MIGRATION ONLY: no schema.prisma, no runtime code reads or writes this table yet.
--
-- "PaymentSettlementFact": one row per fact VERSION about one "PaymentTransaction" (a settlement, or a reversal
-- — a reversal is a PaymentTransaction with a negative amount, in the payment's own currency):
--   kind     CHARGED  the amount + currency the customer was charged (always the transaction's own: enforced)
--            SETTLED  what the provider settled for it (amount + currency, e.g. ILS for a USD charge), with the
--                     provider's conversion rate when it states one (units of rateQuote for ONE rateBase,
--                     rateBase = the charged currency, rateQuote = the settled currency)
--            FEE      what the provider kept (positive), or gave back (negative, e.g. on a reversal)
--            NET      what was transferred to the business
--   source   PROVIDER parsed from the provider's own data (sourceRef = the provider's reference, required)
--            BANK     a matched bank line ("ExternalTransaction" of the same business and currency, required)
--            MANUAL   entered by the owner (recordedByUserId + a note, required)
--   There is deliberately NO source for a computed, representative (Bank of Israel) or display rate: such a number
--   is never a fact about money received and cannot be stored here.
--
-- Versions, never edits: append-only for everyone (UPDATE / DELETE / TRUNCATE refused by trigger, the owner
-- included; the one exception is the FK action that blanks recordedByUserId when a user is erased). A correction
-- is a new row whose supersedesId names the fact it replaces — same transaction, same kind; each fact is
-- superseded at most once and each (transaction, kind) has one first version, so every kind is one linear chain
-- and exactly one CURRENT fact (the one nothing supersedes).
--
-- Invariants (DB-enforced):
--   * the row's business owns the transaction (through its "PaymentRequest") — explicit, not only via RLS;
--   * only a PAID transaction has facts; CHARGED equals the transaction's amount and currency; CHARGED / SETTLED
--     carry the transaction's sign, NET that sign or zero;
--   * a rate only on SETTLED, only across two different currencies, from the charged to the settled currency;
--   * when the current SETTLED, FEE and NET are all in ONE currency, NET = SETTLED − FEE (checked at commit, so
--     the three may be written in one transaction). Across currencies nothing is computed;
--   * writers of one transaction's facts are serialised (transaction-scoped advisory lock), and only under
--     READ COMMITTED, so the commit-time check always sees the other writer's committed rows.
--
-- Tenant table: RLS ENABLED + FORCED, a read policy and an append policy (no change / removal policy), SELECT +
-- INSERT for the runtime only. The owner's DEFAULT PRIVILEGES hand every new table / sequence to the runtime
-- wholesale (the G4 finding of 20261018090000): every such grant is taken back first, then exactly these.
-- No SECURITY DEFINER function: every guard runs as the writer, and refuses what that writer cannot see.
--
-- Builds on 20261018090000_daily_tasks_foundation (public.task_user_same_business). Does NOT depend on
-- 20261025090000_currency_settings_fx_rates (no object of it is named): the two apply in either order.
-- Additive only: no existing table, column, row, policy, trigger or grant is changed or removed.
-- Reversal: .sfx/rollback.sql (owner-run, refuses while the table holds a row).
-- ============================================================================================================

-- ── 1. The table ───────────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE "PaymentSettlementFact" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "paymentTransactionId" INTEGER NOT NULL,
  "kind" TEXT NOT NULL,
  "amount" DECIMAL(18,2) NOT NULL,
  "currency" TEXT NOT NULL,
  "providerRate" DECIMAL(20,10),
  "rateBase" TEXT,
  "rateQuote" TEXT,
  "source" TEXT NOT NULL,
  "sourceRef" TEXT,
  "externalTransactionId" INTEGER,
  "occurredAt" TIMESTAMP(3),
  "note" TEXT,
  "idempotencyKey" TEXT,
  "supersedesId" INTEGER,
  "recordedByUserId" INTEGER,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaymentSettlementFact_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentSettlementFact_kind" CHECK ("kind" IN ('CHARGED', 'SETTLED', 'FEE', 'NET')),
  -- The money engine's registry (lib/money/currency.ts). Widening it is a deliberate migration.
  CONSTRAINT "PaymentSettlementFact_currency" CHECK ("currency" IN ('ILS', 'USD', 'EUR')),
  CONSTRAINT "PaymentSettlementFact_source" CHECK ("source" IN ('PROVIDER', 'BANK', 'MANUAL')),
  -- A charge or a settlement of nothing is not a fact. (FEE and NET may be zero: "no fee" is worth recording.)
  CONSTRAINT "PaymentSettlementFact_amount_nonzero" CHECK ("kind" NOT IN ('CHARGED', 'SETTLED') OR "amount" <> 0),
  -- The provider's conversion rate: all three or none (NOT NULL spelled out: a NULL would pass a CHECK); only on SETTLED; positive; between two different
  -- registry currencies; quoted in the settled currency (the base is checked against the charge by trigger).
  CONSTRAINT "PaymentSettlementFact_rate_shape" CHECK (
       ("providerRate" IS NULL AND "rateBase" IS NULL AND "rateQuote" IS NULL)
    OR ("kind" = 'SETTLED' AND "providerRate" > 0 AND "rateBase" IS NOT NULL AND "rateQuote" IS NOT NULL
        AND "rateBase" IN ('ILS', 'USD', 'EUR') AND "rateQuote" IN ('ILS', 'USD', 'EUR')
        AND "rateBase" <> "rateQuote" AND "rateQuote" = "currency")),
  -- Where the number came from — each source carries its own evidence.
  CONSTRAINT "PaymentSettlementFact_bank_line" CHECK (("source" = 'BANK') = ("externalTransactionId" IS NOT NULL)),
  CONSTRAINT "PaymentSettlementFact_provider_ref" CHECK ("source" <> 'PROVIDER' OR "sourceRef" IS NOT NULL),
  CONSTRAINT "PaymentSettlementFact_manual_note" CHECK ("source" <> 'MANUAL' OR btrim(coalesce("note", '')) <> ''),
  -- A bank line shows money arriving, not what the customer was charged.
  CONSTRAINT "PaymentSettlementFact_charged_source" CHECK ("kind" <> 'CHARGED' OR "source" <> 'BANK'),
  CONSTRAINT "PaymentSettlementFact_not_self" CHECK ("supersedesId" IS NULL OR "supersedesId" <> "id"),
  CONSTRAINT "PaymentSettlementFact_text_lengths" CHECK (
        ("sourceRef" IS NULL OR char_length("sourceRef") BETWEEN 1 AND 512)
    AND ("note" IS NULL OR char_length("note") <= 1000)
    AND ("idempotencyKey" IS NULL OR char_length("idempotencyKey") BETWEEN 1 AND 200))
);

-- One first version per (transaction, kind); each fact superseded at most once ⇒ one linear chain per kind.
CREATE UNIQUE INDEX "PaymentSettlementFact_first_version_key"
  ON "PaymentSettlementFact"("paymentTransactionId", "kind") WHERE "supersedesId" IS NULL;
CREATE UNIQUE INDEX "PaymentSettlementFact_supersedesId_key"
  ON "PaymentSettlementFact"("supersedesId") WHERE "supersedesId" IS NOT NULL;
-- A re-delivered provider / bank observation is the same fact, never a second one.
CREATE UNIQUE INDEX "PaymentSettlementFact_businessId_idempotencyKey_key"
  ON "PaymentSettlementFact"("businessId", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL;
CREATE INDEX "PaymentSettlementFact_businessId_paymentTransactionId_idx"
  ON "PaymentSettlementFact"("businessId", "paymentTransactionId");
CREATE INDEX "PaymentSettlementFact_businessId_kind_currency_idx"
  ON "PaymentSettlementFact"("businessId", "kind", "currency");
CREATE INDEX "PaymentSettlementFact_externalTransactionId_idx"
  ON "PaymentSettlementFact"("externalTransactionId") WHERE "externalTransactionId" IS NOT NULL;

-- Financial evidence is never removed by a cascade: a business, a transaction, a bank line or a fact that a fact
-- rests on cannot be deleted while the fact exists. A user who recorded a fact may be erased (the reference is
-- blanked; who recorded it stays in the payment audit trail).
ALTER TABLE "PaymentSettlementFact" ADD CONSTRAINT "PaymentSettlementFact_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentSettlementFact" ADD CONSTRAINT "PaymentSettlementFact_paymentTransactionId_fkey"
  FOREIGN KEY ("paymentTransactionId") REFERENCES "PaymentTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentSettlementFact" ADD CONSTRAINT "PaymentSettlementFact_externalTransactionId_fkey"
  FOREIGN KEY ("externalTransactionId") REFERENCES "ExternalTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentSettlementFact" ADD CONSTRAINT "PaymentSettlementFact_supersedesId_fkey"
  FOREIGN KEY ("supersedesId") REFERENCES "PaymentSettlementFact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentSettlementFact" ADD CONSTRAINT "PaymentSettlementFact_recordedByUserId_fkey"
  FOREIGN KEY ("recordedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 2. The fact guard (BEFORE INSERT) ──────────────────────────────────────────────────────────────────────

-- Runs as the writer (SECURITY INVOKER): the runtime sees only its own business's transactions, bank lines and
-- facts through their FORCE RLS, so anything of another business is "not found" and refused; a BYPASSRLS writer
-- sees everything, so every relation is ALSO compared explicitly.
CREATE OR REPLACE FUNCTION public.payment_settlement_fact_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  t_amount numeric;
  t_currency text;
  t_status text;
  t_business integer;
  e_business integer;
  e_currency text;
  s_txn integer;
  s_kind text;
  s_business integer;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS09',
      MESSAGE = 'SETTLEMENT_FACT_ISOLATION: settlement facts are recorded only under READ COMMITTED';
  END IF;
  -- Serialise the writers of one transaction's facts until commit (see the commit-time check below).
  PERFORM pg_advisory_xact_lock(hashtext('PaymentSettlementFact'), NEW."paymentTransactionId");

  -- The database's own clock, never the writer's.
  NEW."recordedAt" := CURRENT_TIMESTAMP;

  SELECT t."amount", t."currency", t."status"::text, r."businessId"
    INTO t_amount, t_currency, t_status, t_business
    FROM "PaymentTransaction" t JOIN "PaymentRequest" r ON r."id" = t."paymentRequestId"
   WHERE t."id" = NEW."paymentTransactionId";
  IF NOT FOUND OR t_business IS DISTINCT FROM NEW."businessId" THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS02',
      MESSAGE = 'SETTLEMENT_FACT_OTHER_BUSINESS: the payment transaction does not belong to this business';
  END IF;
  IF t_status <> 'PAID' THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS03',
      MESSAGE = format('SETTLEMENT_FACT_NOT_PAID: a %s transaction has no settlement facts', t_status);
  END IF;

  IF NEW."kind" = 'CHARGED' AND (NEW."currency" <> t_currency OR NEW."amount" <> t_amount) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS04',
      MESSAGE = 'SETTLEMENT_FACT_CHARGED_MISMATCH: CHARGED is the transaction''s own amount and currency';
  END IF;
  IF (NEW."kind" IN ('CHARGED', 'SETTLED') AND sign(NEW."amount") <> sign(t_amount))
     OR (NEW."kind" = 'NET' AND sign(NEW."amount") NOT IN (0, sign(t_amount))) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS04',
      MESSAGE = format('SETTLEMENT_FACT_SIGN: %s must move money in the transaction''s direction', NEW."kind");
  END IF;
  IF NEW."providerRate" IS NOT NULL AND NEW."rateBase" <> t_currency THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS04',
      MESSAGE = 'SETTLEMENT_FACT_RATE_BASE: the provider rate converts FROM the charged currency';
  END IF;

  IF NEW."source" = 'BANK' THEN
    SELECT e."businessId", e."currency" INTO e_business, e_currency
      FROM "ExternalTransaction" e WHERE e."id" = NEW."externalTransactionId";
    IF NOT FOUND OR e_business IS DISTINCT FROM NEW."businessId" THEN
      RAISE EXCEPTION USING ERRCODE = 'DZS05',
        MESSAGE = 'SETTLEMENT_FACT_BANK_LINE: the bank line does not belong to this business';
    END IF;
    IF e_currency IS DISTINCT FROM NEW."currency" THEN
      RAISE EXCEPTION USING ERRCODE = 'DZS05',
        MESSAGE = 'SETTLEMENT_FACT_BANK_CURRENCY: a bank fact is in the bank line''s own currency';
    END IF;
  END IF;
  IF NEW."source" = 'MANUAL' AND NEW."recordedByUserId" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS06',
      MESSAGE = 'SETTLEMENT_FACT_MANUAL_ACTOR: a manual fact names the user who entered it';
  END IF;

  IF NEW."supersedesId" IS NOT NULL THEN
    SELECT f."paymentTransactionId", f."kind", f."businessId" INTO s_txn, s_kind, s_business
      FROM "PaymentSettlementFact" f WHERE f."id" = NEW."supersedesId";
    IF NOT FOUND OR s_business IS DISTINCT FROM NEW."businessId"
       OR s_txn IS DISTINCT FROM NEW."paymentTransactionId" OR s_kind IS DISTINCT FROM NEW."kind" THEN
      RAISE EXCEPTION USING ERRCODE = 'DZS07',
        MESSAGE = 'SETTLEMENT_FACT_SUPERSEDES: a correction replaces a fact of the same transaction and kind';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER "PaymentSettlementFact_guard"
  BEFORE INSERT ON "PaymentSettlementFact"
  FOR EACH ROW EXECUTE FUNCTION public.payment_settlement_fact_guard();

-- The recording user belongs to the same business (the guard 20261018090000 built for user references).
CREATE TRIGGER "PaymentSettlementFact_user_same_business"
  BEFORE INSERT ON "PaymentSettlementFact"
  FOR EACH ROW EXECUTE FUNCTION public.task_user_same_business('recordedByUserId');

-- ── 3. NET = SETTLED − FEE, at commit ──────────────────────────────────────────────────────────────────────

-- Among the CURRENT facts of the transaction (those nothing supersedes): when SETTLED, FEE and NET are all
-- present and all in one currency, they must add up. Deferred to commit so a writer may record the three (or a
-- correction of two) in one transaction. Different currencies: no arithmetic, nothing refused.
CREATE OR REPLACE FUNCTION public.payment_settlement_fact_net_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  s_amount numeric; s_currency text;
  f_amount numeric; f_currency text;
  n_amount numeric; n_currency text;
BEGIN
  SELECT max(c."amount") FILTER (WHERE c."kind" = 'SETTLED'), max(c."currency") FILTER (WHERE c."kind" = 'SETTLED'),
         max(c."amount") FILTER (WHERE c."kind" = 'FEE'),     max(c."currency") FILTER (WHERE c."kind" = 'FEE'),
         max(c."amount") FILTER (WHERE c."kind" = 'NET'),     max(c."currency") FILTER (WHERE c."kind" = 'NET')
    INTO s_amount, s_currency, f_amount, f_currency, n_amount, n_currency
    FROM "PaymentSettlementFact" c
   WHERE c."paymentTransactionId" = NEW."paymentTransactionId"
     AND NOT EXISTS (SELECT 1 FROM "PaymentSettlementFact" s WHERE s."supersedesId" = c."id");
  IF s_amount IS NOT NULL AND f_amount IS NOT NULL AND n_amount IS NOT NULL
     AND s_currency = f_currency AND f_currency = n_currency
     AND n_amount <> s_amount - f_amount THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS08',
      MESSAGE = format('SETTLEMENT_FACT_NET_MISMATCH: net %s %s is not settled %s minus fee %s',
                       n_amount, n_currency, s_amount, f_amount);
  END IF;
  RETURN NULL;
END
$fn$;

CREATE CONSTRAINT TRIGGER "PaymentSettlementFact_net_check"
  AFTER INSERT ON "PaymentSettlementFact"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.payment_settlement_fact_net_check();

-- ── 4. Append-only ─────────────────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.payment_settlement_fact_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  -- The FK action of "recordedByUserId" (ON DELETE SET NULL, a user's erasure): that column alone, to NULL.
  IF TG_OP = 'UPDATE' AND pg_trigger_depth() > 1 AND NEW."recordedByUserId" IS NULL
     AND (to_jsonb(NEW) - 'recordedByUserId') = (to_jsonb(OLD) - 'recordedByUserId') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'DZS01',
    MESSAGE = format('SETTLEMENT_FACT_APPEND_ONLY: %s on %I is refused; a correction is a new fact that supersedes it',
                     TG_OP, TG_TABLE_NAME);
END
$fn$;

CREATE TRIGGER "PaymentSettlementFact_append_only" BEFORE UPDATE OR DELETE ON "PaymentSettlementFact"
  FOR EACH ROW EXECUTE FUNCTION public.payment_settlement_fact_append_only();
CREATE TRIGGER "PaymentSettlementFact_no_truncate" BEFORE TRUNCATE ON "PaymentSettlementFact"
  FOR EACH STATEMENT EXECUTE FUNCTION public.payment_settlement_fact_append_only();

-- ── 5. Row-level security ──────────────────────────────────────────────────────────────────────────────────

ALTER TABLE "PaymentSettlementFact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PaymentSettlementFact" FORCE ROW LEVEL SECURITY;
-- Read and append only. No UPDATE or DELETE policy exists, so those reach no row for any role without BYPASSRLS.
CREATE POLICY payment_settlement_fact_tenant_select ON "PaymentSettlementFact" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY payment_settlement_fact_tenant_insert ON "PaymentSettlementFact" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ── 6. Privileges — named explicitly ───────────────────────────────────────────────────────────────────────

-- Whatever the owner's DEFAULT PRIVILEGES handed out on the new table, its sequence and the functions goes, from
-- every grantee — then exactly what is listed below is granted.
DO $do$
DECLARE
  g record;
BEGIN
  FOR g IN
    SELECT DISTINCT c.oid::regclass::text AS obj, c.relkind, x.grantee
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
     WHERE c.oid IN ('public."PaymentSettlementFact"'::regclass, 'public."PaymentSettlementFact_id_seq"'::regclass)
       AND x.grantee <> c.relowner AND x.grantee <> 0
  LOOP
    IF g.relkind = 'S' THEN
      EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM %I', g.obj, pg_get_userbyid(g.grantee));
    ELSE
      EXECUTE format('REVOKE ALL ON TABLE %s FROM %I', g.obj, pg_get_userbyid(g.grantee));
    END IF;
  END LOOP;
  FOR g IN
    SELECT DISTINCT p.oid::regprocedure::text AS obj, x.grantee
      FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x
     WHERE p.oid IN ('public.payment_settlement_fact_guard()'::regprocedure,
                     'public.payment_settlement_fact_net_check()'::regprocedure,
                     'public.payment_settlement_fact_append_only()'::regprocedure)
       AND x.grantee <> p.proowner AND x.grantee <> 0
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', g.obj, pg_get_userbyid(g.grantee));
  END LOOP;
END
$do$;
REVOKE ALL ON "PaymentSettlementFact" FROM PUBLIC;
REVOKE ALL ON SEQUENCE "PaymentSettlementFact_id_seq" FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_settlement_fact_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_settlement_fact_net_check() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_settlement_fact_append_only() FROM PUBLIC;

-- The runtime reads and appends facts; nothing else, and no other role.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT ON "PaymentSettlementFact" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "PaymentSettlementFact_id_seq" TO app_runtime;
  END IF;
END
$do$;
