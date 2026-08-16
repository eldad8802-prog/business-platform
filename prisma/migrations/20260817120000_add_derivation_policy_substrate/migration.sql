-- Business Memory IMPL-1 · Derivation Policy substrate. Additive + inert + GLOBAL.
-- Creates ONLY the two new tables (DerivationPolicy + DerivationPolicyVersion). No businessId /
-- no Business relation (the derivation ALGORITHM is platform-authored, not tenant data; tenant
-- locality applies to future learned-knowledge Claims, not to the policy). No ALTER/DROP of any
-- existing table, no data migration, no backfill. onDelete RESTRICT so policy history is never
-- cascade-deleted. The (policyId, version) unique index is IDENTITY uniqueness only — not precedence.

-- CreateTable
CREATE TABLE "DerivationPolicy" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DerivationPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DerivationPolicyVersion" (
    "id" SERIAL NOT NULL,
    "policyId" INTEGER NOT NULL,
    "version" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DerivationPolicyVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DerivationPolicyVersion_policyId_idx" ON "DerivationPolicyVersion"("policyId");

-- CreateIndex
CREATE UNIQUE INDEX "DerivationPolicyVersion_policyId_version_key" ON "DerivationPolicyVersion"("policyId", "version");

-- AddForeignKey
ALTER TABLE "DerivationPolicyVersion" ADD CONSTRAINT "DerivationPolicyVersion_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "DerivationPolicy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
