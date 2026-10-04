-- P3-A rollback — 20261008090100_p3a_trust_claims (and the inert remainder of 20261008090000).
--
-- OWNER-RUN ONLY, never by the app, never by a workflow without a separate owner decision.
-- Proven in the lab (p3a-trust-conversion-lab.yml).
--
-- SAFE ONLY WHILE NOTHING USES IT: refuses if any trust claim exists, any owner objective names a
-- channel, any conversion declaration exists, or any authority was given for PUBLIC_WHATSAPP.
-- A rollback never erases an owner's decisions.
--
-- WHAT IT RESTORES: everything 20261008090100 did — the table, its five types, the statement
-- channel column and its CHECK, and P2's two CHECKs exactly as 20261004090000 wrote them.
--
-- WHAT IT CANNOT RESTORE: PostgreSQL has no way to remove a label from an enum, so the two labels
-- 20261008090000 added (PUBLIC_WHATSAPP, CONVERSION_DECLARATION) stay, and that migration stays recorded (the ledger keeps telling the truth).
-- They are inert: P2's restored CHECKs admit neither CONVERSION_DECLARATION (not a coded or text
-- dimension) nor PUBLIC_WHATSAPP (no source field), so no row can carry them.
-- Re-applying afterwards is `prisma migrate deploy`, which then applies 20261008090100 only.
BEGIN;
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM "BusinessTrustClaim") THEN
    RAISE EXCEPTION 'P3-A rollback refused: trust claims exist — inspect before rolling back';
  END IF;
  IF EXISTS (SELECT 1 FROM "BusinessIdentityStatement" WHERE "channel" IS NOT NULL OR "dimension"::text = 'CONVERSION_DECLARATION') THEN
    RAISE EXCEPTION 'P3-A rollback refused: owner objectives with a channel or conversion declarations exist';
  END IF;
  IF EXISTS (SELECT 1 FROM "BusinessIdentityFactAuthority" WHERE "fact"::text = 'PUBLIC_WHATSAPP') THEN
    RAISE EXCEPTION 'P3-A rollback refused: authority exists for PUBLIC_WHATSAPP';
  END IF;
END
$guard$;

DROP TABLE "BusinessTrustClaim";
DROP TYPE "TrustClaimKind";
DROP TYPE "TrustClaimClass";
DROP TYPE "TrustClaimStatus";
DROP TYPE "TrustVerificationMethod";

ALTER TABLE "BusinessIdentityStatement"
  DROP CONSTRAINT "BusinessIdentityStatement_channel_shape",
  DROP CONSTRAINT "BusinessIdentityStatement_value_shape",
  ADD CONSTRAINT "BusinessIdentityStatement_value_shape" CHECK (
    (
      "dimension" IN ('TARGET_AUDIENCE', 'PRIMARY_OBJECTIVE', 'SECONDARY_OBJECTIVE', 'TONE', 'POSITIONING')
      AND "code" IS NOT NULL AND "text" IS NULL
      AND "code" ~ '^[A-Z][A-Z_]{1,39}$'
    )
    OR (
      "dimension" IN ('DESCRIPTION', 'SPECIALIZATION', 'DIFFERENTIATOR', 'SERVICE_AREA')
      AND "text" IS NOT NULL AND "code" IS NULL
      AND char_length(btrim("text")) BETWEEN 1 AND 500
    )
  ),
  DROP COLUMN "channel";
DROP TYPE "ConversionChannel";

ALTER TABLE "BusinessIdentityFactAuthority"
  DROP CONSTRAINT "BusinessIdentityFactAuthority_source_field",
  ADD CONSTRAINT "BusinessIdentityFactAuthority_source_field" CHECK (
    ("fact" = 'BUSINESS_NAME'  AND "sourceField" = 'Business.name')
    OR ("fact" = 'CITY'           AND "sourceField" = 'BusinessProfile.city')
    OR ("fact" = 'OPENING_HOURS'  AND "sourceField" = 'BusinessProfile.openingHours')
    OR ("fact" = 'PUBLIC_PHONE'   AND "sourceField" = 'BusinessProfile.billingPhone')
    OR ("fact" = 'PUBLIC_EMAIL'   AND "sourceField" = 'BusinessProfile.billingEmail')
    OR ("fact" = 'PUBLIC_ADDRESS' AND "sourceField" = 'BusinessProfile.billingAddress')
  );

DELETE FROM "_prisma_migrations" WHERE migration_name = '20261008090100_p3a_trust_claims';
COMMIT;
