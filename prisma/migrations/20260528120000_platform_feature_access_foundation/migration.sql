-- CreateEnum
CREATE TYPE "BusinessFeatureAccessState" AS ENUM ('ENABLED', 'DISABLED', 'INHERIT');

-- CreateTable
CREATE TABLE "PlatformFeatureDefinition" (
    "key" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "defaultEnabled" BOOLEAN NOT NULL DEFAULT true,
    "mutable" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformFeatureDefinition_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "PlatformFeaturePolicy" (
    "featureKey" TEXT NOT NULL,
    "globalEnabled" BOOLEAN NOT NULL DEFAULT true,
    "emergencyDisabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedByUserId" INTEGER,

    CONSTRAINT "PlatformFeaturePolicy_pkey" PRIMARY KEY ("featureKey")
);

-- CreateTable
CREATE TABLE "BusinessFeatureAccess" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "featureKey" TEXT NOT NULL,
    "state" "BusinessFeatureAccessState" NOT NULL,
    "reason" TEXT,
    "updatedByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessFeatureAccess_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BusinessFeatureAccess_businessId_idx" ON "BusinessFeatureAccess"("businessId");

-- CreateIndex
CREATE INDEX "BusinessFeatureAccess_featureKey_idx" ON "BusinessFeatureAccess"("featureKey");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessFeatureAccess_businessId_featureKey_key" ON "BusinessFeatureAccess"("businessId", "featureKey");

-- AddForeignKey
ALTER TABLE "PlatformFeaturePolicy" ADD CONSTRAINT "PlatformFeaturePolicy_featureKey_fkey" FOREIGN KEY ("featureKey") REFERENCES "PlatformFeatureDefinition"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessFeatureAccess" ADD CONSTRAINT "BusinessFeatureAccess_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessFeatureAccess" ADD CONSTRAINT "BusinessFeatureAccess_featureKey_fkey" FOREIGN KEY ("featureKey") REFERENCES "PlatformFeatureDefinition"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed: definitions + policies (all enabled, no emergency disable)
INSERT INTO "PlatformFeatureDefinition" ("key", "displayName", "category", "description", "defaultEnabled", "mutable", "createdAt") VALUES
  ('documents', 'מסמכים', 'documents', 'העלאה, תיבה ובדיקת מסמכים', true, true, CURRENT_TIMESTAMP),
  ('billing', 'חשבוניות', 'billing', 'יצירה, הפקה וניהול מסמכי חיוב', true, true, CURRENT_TIMESTAMP),
  ('inbox', 'שיחות / תיבה', 'inbox', 'ניהול שיחות עם לקוחות', true, true, CURRENT_TIMESTAMP),
  ('inventory', 'מלאי', 'inventory', 'פריטים, תנועות והזמנות מספק', true, true, CURRENT_TIMESTAMP),
  ('content', 'תוכן', 'content', 'יצירת תוכן ו-AI', true, true, CURRENT_TIMESTAMP),
  ('pricing', 'תמחור', 'pricing', 'מחשבון תמחור ופרופילי מחיר', true, true, CURRENT_TIMESTAMP),
  ('revenue', 'הכנסות / קופונים', 'revenue', 'קופונים, מימוש והכנסות', true, true, CURRENT_TIMESTAMP),
  ('gmail_import', 'ייבוא Gmail', 'integrations', 'חיבור וייבוא מצרופות מייל', true, true, CURRENT_TIMESTAMP),
  ('whatsapp', 'WhatsApp', 'integrations', 'ייבוא מצרופות WhatsApp', true, true, CURRENT_TIMESTAMP),
  ('starter_bot', 'בוט פתיחה', 'bot', 'בוט שיחה אוטומטי לעסק', true, true, CURRENT_TIMESTAMP),
  ('reports', 'דוחות', 'reports', 'ייצוא וסיכומי דוחות', true, true, CURRENT_TIMESTAMP);

INSERT INTO "PlatformFeaturePolicy" ("featureKey", "globalEnabled", "emergencyDisabled", "updatedAt") VALUES
  ('documents', true, false, CURRENT_TIMESTAMP),
  ('billing', true, false, CURRENT_TIMESTAMP),
  ('inbox', true, false, CURRENT_TIMESTAMP),
  ('inventory', true, false, CURRENT_TIMESTAMP),
  ('content', true, false, CURRENT_TIMESTAMP),
  ('pricing', true, false, CURRENT_TIMESTAMP),
  ('revenue', true, false, CURRENT_TIMESTAMP),
  ('gmail_import', true, false, CURRENT_TIMESTAMP),
  ('whatsapp', true, false, CURRENT_TIMESTAMP),
  ('starter_bot', true, false, CURRENT_TIMESTAMP),
  ('reports', true, false, CURRENT_TIMESTAMP);
