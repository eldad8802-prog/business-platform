-- Legal entity kind for invoice identity (עוסק פטור / עוסק מורשה / חברה בע״מ)
ALTER TABLE "BusinessProfile" ADD COLUMN IF NOT EXISTS "billingBusinessKind" TEXT;
