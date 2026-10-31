-- EMERGENCY STOP — sending to the accountant, for every business at once (prepared in advance, 2026-11-01; merged and
-- released ONLY on an explicit owner decision to stop all sending).
--
-- Data only: PlatformFeaturePolicy.accountant_delivery.emergencyDisabled → true. The resolver checks the emergency
-- switch before anything else, and every deployment reads it from the database on every request — so, unlike the
-- environment switch ACCOUNTANT_DELIVERY_ENABLED, it also stops a browser pinned to an older deployment (Vercel skew
-- protection keeps one for up to 12 hours). Approvals answer DELIVERY_NOT_PERMITTED; a waiting approval is canceled
-- (never sent) at its next attempt. Preparing packages, the owner's screens, the portal and existing links are not
-- touched. To reopen: a later migration sets it back to false.
-- The statement must touch exactly its one row, or nothing changes.
DO $$
DECLARE
  n integer;
BEGIN
  UPDATE "PlatformFeaturePolicy"
     SET "emergencyDisabled" = true,
         "updatedAt" = CURRENT_TIMESTAMP
   WHERE "featureKey" = 'accountant_delivery';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'accountant_delivery policy: expected 1 row, found %', n;
  END IF;
END $$;
