-- ============================================================================================================
-- 20261125090000_service_desk_handover_owner_confirmed — Service Desk 1.3c: a handover without a customer signature.
--
-- Owner decision 2026-11-11: no customer signature anywhere. The owner (or an authorized user) confirms the handover;
-- the receiver's name is optional on every track. Expand-only: two CHECKs relaxed, nothing else.
--   - ServiceHandover_signed (CHECK "signatureCaptured") is dropped — the column stays as history (old rows true).
--   - ServiceHandover_receiver: the name is optional; when present it is non-blank and at most 200 characters.
-- Unchanged: one handover per case (UNIQUE businessId+caseId), immutability (ServiceHandover_guard), the acting user
-- (actorUserId, same-business trigger), the open-balance rule (debt needs the owner's reason), RLS, grants, the
-- erasure (service_erase_business blanks receivedByName / signatureKey / reasons — no new personal column).
-- Every existing row satisfies the new CHECK; no row is changed. Order: after 20261123090000 (#1061), which only
-- reads ServiceHandover."deliveredAt".
-- ============================================================================================================

DO $do$
BEGIN
  IF to_regclass('public."ServiceHandover"') IS NULL THEN
    RAISE EXCEPTION 'SERVICE_DESK_HANDOVER: the Service Desk foundation (20261112090000) is missing; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ServiceHandover_signed' AND conrelid = 'public."ServiceHandover"'::regclass)
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ServiceHandover_receiver' AND conrelid = 'public."ServiceHandover"'::regclass) THEN
    RAISE EXCEPTION 'SERVICE_DESK_HANDOVER: the expected handover constraints are not in place; nothing was changed';
  END IF;
END
$do$;

SET lock_timeout = '5s';

ALTER TABLE "ServiceHandover" DROP CONSTRAINT "ServiceHandover_signed";
ALTER TABLE "ServiceHandover" DROP CONSTRAINT "ServiceHandover_receiver";
ALTER TABLE "ServiceHandover" ADD CONSTRAINT "ServiceHandover_receiver" CHECK (
  "receivedByName" IS NULL OR (btrim("receivedByName") <> '' AND char_length("receivedByName") <= 200));
