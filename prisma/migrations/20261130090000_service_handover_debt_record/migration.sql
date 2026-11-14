-- ============================================================================================================
-- 20261130090000_service_handover_debt_record — Service Desk: the handover (DELIVER) record becomes as complete as the
-- work-completion record of M1 (ServiceCompletion, 20261127090000), and the approver of a sensitive exception is stored
-- apart from the actor. DRAFT — never applied without the owner's separate approval.
-- Order: after 20261127090000 (M1, #1118), which is after 20261126090000 (#1104) and 20261125090000 (#1096). Independent
-- of 20261128090000 (parts reservation guard), 20261129090000 (QA lists) and 20261130100000 (QA track defaults): none of
-- them names ServiceHandover or a function replaced here.
--
-- Owner requirements (2026-11-11): the exact balance at the handover; an overpayment in its own field; a reason when a
-- debt stays open; who acted, who approved and when; an immutable history. UNKNOWN never becomes a record; a debt never
-- without approval + reason; an overpayment never silently "zero debt"; never debt AND overpayment; existing handovers
-- and their history untouched.
--
-- LEGACY COMPATIBILITY — the discriminator "recordVersion":
--   1  every handover written before this migration (the constant DEFAULT: no table rewrite, every existing row becomes 1
--      as it is). A version-1 row keeps exactly its old shape and rules (openBalanceAgorot may be <= 0, a reason without an
--      approver); none of the new columns may be set on it (ServiceHandover_legacy_shape). It can never be "upgraded":
--      the row is immutable (service_handover_guard) and recordVersion is not erasable.
--   2  every handover written from now on — the ONLY version an INSERT accepts (service_handover_record_guard). Its CHECKs
--      are the ServiceCompletion rules: a known balance (debt >= 0 and overpayment >= 0, NOT NULL, never both > 0), a debt
--      carries reason + approval time (+ approver at birth), no debt carries none; the same for the loaner exception.
--   Every new CHECK is therefore a FULL, VALIDATED constraint (not NOT VALID): every existing row satisfies it, because each
--   one constrains only version 2 or requires version 1 to have the new columns NULL — which they are.
--
-- ACTOR / APPROVER: "actorUserId" did the handover; "debtApprovedByUserId" / "loanerApprovedByUserId" approved the
-- exception. Until an independent approver verification exists (an approval made from the approver's OWN authenticated
-- session), an approver can only be the authenticated user who acts: the handover INSERT guard refuses an approver
-- different from the actor (SERVICE_APPROVER_NOT_ACTOR). Two columns, one rule today — a future flow replaces the guard
-- function, never the data. The same rule for the work completion lives in M1 itself (20261127090000,
-- service_completion_guard, owner decision 2026-11-12): this migration does not touch ServiceCompletion; its premise
-- only requires that rule to be in place.
--
--   ServiceHandover   + recordVersion, overpaidAgorot, debtApprovedByUserId, debtApprovedAt, loanerApprovedByUserId,
--                     loanerApprovedAt; 5 CHECKs; 2 FKs to "User" (ON DELETE SET NULL); the same-business trigger now also
--                     checks the two approvers; a new BEFORE INSERT guard; service_handover_guard replaced (the approvers
--                     are erasable / nulled by a deleted user's FK action like the actor)
--   ServiceCompletion untouched (approver = actor is M1's own rule — required by the premise)
--   erasure           service_handover_record_erase_business() — SECURITY DEFINER, its own function: clears the two
--                     approvers (service_erase_business clears the rest of the handover by its fixed column list)
--
-- Unchanged: every existing row (new columns NULL / the constant default), every other table, policy and grant (the
-- table grants of ServiceHandover cover the new columns), every other function.
-- ============================================================================================================

-- ── 0. Premises ─────────────────────────────────────────────────────────────────────────────────────────────
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    RAISE EXCEPTION 'SERVICE_HANDOVER_RECORD: role app_runtime is missing; nothing was changed';
  END IF;
  IF to_regclass('public."ServiceHandover"') IS NULL OR to_regclass('public."ServiceCompletion"') IS NULL
     OR to_regclass('public."User"') IS NULL OR to_regclass('public."Business"') IS NULL THEN
    RAISE EXCEPTION 'SERVICE_HANDOVER_RECORD: ServiceHandover, ServiceCompletion (M1), User or Business is missing; nothing was changed';
  END IF;
  IF to_regprocedure('public.service_handover_guard()') IS NULL OR to_regprocedure('public.service_completion_guard()') IS NULL
     OR to_regprocedure('public.service_user_same_business()') IS NULL OR to_regprocedure('public.service_ui_business_writable(integer)') IS NULL
     OR to_regprocedure('public.service_tracks_in_erasure(oid)') IS NULL THEN
    RAISE EXCEPTION 'SERVICE_HANDOVER_RECORD: a Service Desk trigger function this migration replaces or calls is missing; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ServiceCompletion_debt_decided' AND conrelid = 'public."ServiceCompletion"'::regclass)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'ServiceHandover_user_same_business' AND tgrelid = 'public."ServiceHandover"'::regclass)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'ServiceHandover_guard' AND tgrelid = 'public."ServiceHandover"'::regclass) THEN
    RAISE EXCEPTION 'SERVICE_HANDOVER_RECORD: M1 (20261127090000) or the handover triggers are not in place; nothing was changed';
  END IF;
  -- the approver = actor rule of the work completion is M1's own (20261127090000, owner decision 2026-11-12); an M1
  -- without it would leave ServiceCompletion behind the rule this migration enforces on the handover
  IF position('SERVICE_APPROVER_NOT_ACTOR' IN (SELECT p.prosrc FROM pg_proc p WHERE p.oid = 'public.service_completion_guard()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'SERVICE_HANDOVER_RECORD: M1 (20261127090000) without the approver = actor rule of service_completion_guard; nothing was changed';
  END IF;
  -- a second application (or a partial hand-made one) is refused before anything moves
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ServiceHandover'
               AND column_name IN ('recordVersion', 'overpaidAgorot', 'debtApprovedByUserId', 'debtApprovedAt', 'loanerApprovedByUserId', 'loanerApprovedAt'))
     OR to_regprocedure('public.service_handover_record_guard()') IS NOT NULL
     OR to_regprocedure('public.service_handover_record_erase_business()') IS NOT NULL THEN
    RAISE EXCEPTION 'SERVICE_HANDOVER_RECORD: already applied (a column or function of this migration exists); nothing was changed';
  END IF;
END
$do$;

SET lock_timeout = '5s';

-- ── 1. ServiceHandover: the new columns ─────────────────────────────────────────────────────────────────────
-- recordVersion: a constant default (no rewrite on PG >= 11) — every existing row reads 1 (legacy shape).
ALTER TABLE "ServiceHandover"
  ADD COLUMN "recordVersion"          SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN "overpaidAgorot"         INTEGER,
  ADD COLUMN "debtApprovedByUserId"   INTEGER,
  ADD COLUMN "debtApprovedAt"         TIMESTAMP(3),
  ADD COLUMN "loanerApprovedByUserId" INTEGER,
  ADD COLUMN "loanerApprovedAt"       TIMESTAMP(3);

-- ── 2. CHECKs (NOT VALID, then validated: SHARE UPDATE EXCLUSIVE, reads and writes continue) ─────────────────
ALTER TABLE "ServiceHandover" ADD CONSTRAINT "ServiceHandover_record_version" CHECK ("recordVersion" IN (1, 2)) NOT VALID;
-- a version-1 row is exactly what it was: none of the new fields
ALTER TABLE "ServiceHandover" ADD CONSTRAINT "ServiceHandover_legacy_shape" CHECK (
  "recordVersion" <> 1 OR ("overpaidAgorot" IS NULL AND "debtApprovedByUserId" IS NULL AND "debtApprovedAt" IS NULL
                           AND "loanerApprovedByUserId" IS NULL AND "loanerApprovedAt" IS NULL)) NOT VALID;
-- version 2: a KNOWN balance — a debt or an overpayment (or neither), never negative, never both; both always stated
ALTER TABLE "ServiceHandover" ADD CONSTRAINT "ServiceHandover_balance" CHECK (
  "recordVersion" <> 2 OR ("overpaidAgorot" IS NOT NULL AND "openBalanceAgorot" >= 0 AND "overpaidAgorot" >= 0
                           AND ("openBalanceAgorot" = 0 OR "overpaidAgorot" = 0))) NOT VALID;
-- version 2: an open debt carries the approval time and the reason (the reason until the erasure); no debt → no reason,
-- no approver, no approval time (= ServiceCompletion_debt_decided)
ALTER TABLE "ServiceHandover" ADD CONSTRAINT "ServiceHandover_debt_decided" CHECK (
  "recordVersion" <> 2 OR (
    CASE WHEN "openBalanceAgorot" > 0
         THEN "debtApprovedAt" IS NOT NULL AND ("debtOverrideReason" IS NOT NULL OR "erasedAt" IS NOT NULL)
         ELSE "debtOverrideReason" IS NULL AND "debtApprovedByUserId" IS NULL AND "debtApprovedAt" IS NULL
    END)) NOT VALID;
-- version 2: the loaner exception (handing over while the temporary item is out) — reason ⇔ approval time; no approval
-- time → no approver; an approval time without its reason only after the erasure
ALTER TABLE "ServiceHandover" ADD CONSTRAINT "ServiceHandover_loaner_decided" CHECK (
  "recordVersion" <> 2 OR (
        ("loanerOverrideReason" IS NULL OR "loanerApprovedAt" IS NOT NULL)
    AND ("loanerApprovedAt" IS NOT NULL OR "loanerApprovedByUserId" IS NULL)
    AND ("loanerApprovedAt" IS NULL OR "loanerOverrideReason" IS NOT NULL OR "erasedAt" IS NOT NULL))) NOT VALID;
ALTER TABLE "ServiceHandover" VALIDATE CONSTRAINT "ServiceHandover_record_version";
ALTER TABLE "ServiceHandover" VALIDATE CONSTRAINT "ServiceHandover_legacy_shape";
ALTER TABLE "ServiceHandover" VALIDATE CONSTRAINT "ServiceHandover_balance";
ALTER TABLE "ServiceHandover" VALIDATE CONSTRAINT "ServiceHandover_debt_decided";
ALTER TABLE "ServiceHandover" VALIDATE CONSTRAINT "ServiceHandover_loaner_decided";

-- ── 3. The approvers: users (a deleted user only nulls the reference), of the same business ─────────────────
ALTER TABLE "ServiceHandover" ADD CONSTRAINT "ServiceHandover_debtApprovedByUserId_fkey"
  FOREIGN KEY ("debtApprovedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ServiceHandover" ADD CONSTRAINT "ServiceHandover_loanerApprovedByUserId_fkey"
  FOREIGN KEY ("loanerApprovedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- the foundation trigger checked the actor only; it now checks the approvers too (same function, wider argument list)
DROP TRIGGER "ServiceHandover_user_same_business" ON "ServiceHandover";
CREATE TRIGGER "ServiceHandover_user_same_business"
  BEFORE INSERT ON "ServiceHandover"
  FOR EACH ROW EXECUTE FUNCTION public.service_user_same_business('actorUserId', 'debtApprovedByUserId', 'loanerApprovedByUserId');

-- ── 4. Guards ───────────────────────────────────────────────────────────────────────────────────────────────
-- 4.1 A new handover is a version-2 record by a named user, never born erased; an open debt / a loaner exception names
-- its approver, and today the approver IS the actor (no independent approver verification exists yet).
CREATE OR REPLACE FUNCTION public.service_handover_record_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF NOT public.service_ui_business_writable(NEW."businessId") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU02', MESSAGE = 'SERVICE_UI_BUSINESS_DELETING: the business is being deleted; nothing was written';
  END IF;
  IF NEW."recordVersion" IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS07', MESSAGE = 'SERVICE_HANDOVER_RECORD_V2: a new handover states the full balance record (recordVersion 2)';
  END IF;
  IF NEW."erasedAt" IS NOT NULL OR NEW."actorUserId" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS07', MESSAGE = 'SERVICE_HANDOVER_NEW: a handover is made by a named user and never born erased';
  END IF;
  IF NEW."openBalanceAgorot" > 0 AND NEW."debtApprovedByUserId" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS07', MESSAGE = 'SERVICE_HANDOVER_DEBT_UNAPPROVED: a handover with an open balance needs the approving user';
  END IF;
  IF NEW."loanerOverrideReason" IS NOT NULL AND NEW."loanerApprovedByUserId" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS07', MESSAGE = 'SERVICE_HANDOVER_LOANER_UNAPPROVED: a handover with the loaner out needs the approving user';
  END IF;
  IF (NEW."debtApprovedByUserId" IS NOT NULL AND NEW."debtApprovedByUserId" <> NEW."actorUserId")
     OR (NEW."loanerApprovedByUserId" IS NOT NULL AND NEW."loanerApprovedByUserId" <> NEW."actorUserId") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS07', MESSAGE = 'SERVICE_APPROVER_NOT_ACTOR: until an independent approver verification exists, the approver is the acting user';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_handover_record_guard() FROM PUBLIC;
CREATE TRIGGER "ServiceHandover_record_guard" BEFORE INSERT ON "ServiceHandover"
  FOR EACH ROW EXECUTE FUNCTION public.service_handover_record_guard();

-- 4.2 ⚠ service_handover_guard — CREATE OR REPLACE. Body = 20261112090000_service_desk_foundation section 9.9 (the only
-- definition), with exactly these changes:
--   a. the foundation erasure (service_erase_business) blanks what it blanked; the two approvers may stay or be NULL,
--      never change to another user (it does not know them);
--   b. the handover-record erasure (service_handover_record_erase_business: its marker + the table owner) sets the two
--      approvers to NULL and nothing else;
--   c. a deleted user's FK action may null the actor or an approver, nothing else.
-- recordVersion, the amounts and the approval times are never erasable.
CREATE OR REPLACE FUNCTION public.service_handover_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  is_owner boolean := current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = TG_RELID);
  in_erasure boolean := current_setting('dubiz.service_erasure', true) = 'on' AND is_owner;
  in_record_erasure boolean := current_setting('dubiz.service_handover_erasure', true) = 'on' AND is_owner;
  erasable constant text[] := ARRAY['receivedByName', 'signatureKey', 'debtOverrideReason', 'loanerOverrideReason', 'actorUserId', 'erasedAt',
                                    'debtApprovedByUserId', 'loanerApprovedByUserId'];
  approvers constant text[] := ARRAY['debtApprovedByUserId', 'loanerApprovedByUserId'];
  user_refs constant text[] := ARRAY['actorUserId', 'debtApprovedByUserId', 'loanerApprovedByUserId'];
  approvers_kept_or_null boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    approvers_kept_or_null :=
          (NEW."debtApprovedByUserId" IS NULL OR NEW."debtApprovedByUserId" = OLD."debtApprovedByUserId")
      AND (NEW."loanerApprovedByUserId" IS NULL OR NEW."loanerApprovedByUserId" = OLD."loanerApprovedByUserId");
    IF in_erasure
       AND (to_jsonb(NEW) - erasable) = (to_jsonb(OLD) - erasable)
       AND NEW."receivedByName" IS NULL AND NEW."signatureKey" IS NULL AND NEW."debtOverrideReason" IS NULL
       AND NEW."loanerOverrideReason" IS NULL AND NEW."actorUserId" IS NULL AND NEW."erasedAt" IS NOT NULL
       AND approvers_kept_or_null THEN
      RETURN NEW;
    END IF;
    IF in_record_erasure
       AND (to_jsonb(NEW) - approvers) = (to_jsonb(OLD) - approvers)
       AND NEW."debtApprovedByUserId" IS NULL AND NEW."loanerApprovedByUserId" IS NULL THEN
      RETURN NEW;
    END IF;
    IF pg_trigger_depth() > 1
       AND (to_jsonb(NEW) - user_refs) = (to_jsonb(OLD) - user_refs)
       AND (NEW."actorUserId" IS NULL OR NEW."actorUserId" = OLD."actorUserId")
       AND approvers_kept_or_null THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = 'DZS07',
    MESSAGE = format('SERVICE_HANDOVER_FIXED: %s on %I is refused; a handover is a permanent record', TG_OP, TG_TABLE_NAME);
END
$fn$;
REVOKE ALL ON FUNCTION public.service_handover_guard() FROM PUBLIC;

-- ── 5. Erasure (account deletion) ───────────────────────────────────────────────────────────────────────────
-- CONTRACT: no arguments; the business is the tenant context. Refuses (DZS08, nothing changed) without a context or when
-- that business is not being deleted. Otherwise sets, for that business only, ServiceHandover.debtApprovedByUserId and
-- loanerApprovedByUserId to NULL (who approved — a person). Kept: recordVersion, the balance, the overpayment and the two
-- approval times (amounts and times, not a person). The receiver, reasons, signature key and actor are blanked by
-- service_erase_business() (foundation), which also stamps erasedAt. Call it in the purge transaction with the other
-- Service Desk erase functions (order-independent). Re-run safe: returns the rows touched (0 the second time).
CREATE OR REPLACE FUNCTION public.service_handover_record_erase_business()
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
    RAISE EXCEPTION USING ERRCODE = 'DZS08', MESSAGE = 'SERVICE_HANDOVER_ERASURE_NO_CONTEXT: no tenant context; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public."Business" b WHERE b."id" = v_business
                   AND (b."deletionRequestedAt" IS NOT NULL OR b."deletedAt" IS NOT NULL)) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS08', MESSAGE = 'SERVICE_HANDOVER_ERASURE_NOT_DELETING: the business is not being deleted; nothing was changed';
  END IF;
  PERFORM set_config('dubiz.service_handover_erasure', 'on', true);

  UPDATE public."ServiceHandover" SET "debtApprovedByUserId" = NULL, "loanerApprovedByUserId" = NULL
   WHERE "businessId" = v_business AND ("debtApprovedByUserId" IS NOT NULL OR "loanerApprovedByUserId" IS NOT NULL);
  GET DIAGNOSTICS v_n = ROW_COUNT;

  PERFORM set_config('dubiz.service_handover_erasure', 'off', true);
  RETURN v_n;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_handover_record_erase_business() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.service_handover_record_erase_business() TO app_runtime;
