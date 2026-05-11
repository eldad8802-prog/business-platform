-- Invoice issuer identity on BusinessProfile (TAX_INVOICE PDF snapshot source)

ALTER TABLE "BusinessProfile" ADD COLUMN IF NOT EXISTS "billingLegalName" TEXT;
ALTER TABLE "BusinessProfile" ADD COLUMN IF NOT EXISTS "billingTaxId" TEXT;
ALTER TABLE "BusinessProfile" ADD COLUMN IF NOT EXISTS "billingVatNumber" TEXT;
ALTER TABLE "BusinessProfile" ADD COLUMN IF NOT EXISTS "billingPhone" TEXT;
ALTER TABLE "BusinessProfile" ADD COLUMN IF NOT EXISTS "billingEmail" TEXT;
ALTER TABLE "BusinessProfile" ADD COLUMN IF NOT EXISTS "billingAddress" TEXT;
ALTER TABLE "BusinessProfile" ADD COLUMN IF NOT EXISTS "billingPaymentNote" TEXT;
ALTER TABLE "BusinessProfile" ADD COLUMN IF NOT EXISTS "billingFooterNote" TEXT;
ALTER TABLE "BusinessProfile" ADD COLUMN IF NOT EXISTS "billingLogoDataUrl" TEXT;
