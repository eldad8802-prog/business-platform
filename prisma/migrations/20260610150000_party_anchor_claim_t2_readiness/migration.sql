-- T2 Readiness: anchor claims (signal-less subject ownership) — closes KL-1 / KL-2.
-- Additive / relaxing only, on the new (unreleased) Party domain. Touches no
-- existing table. NOT applied as part of this change.

-- AlterEnum
ALTER TYPE "PartyResolutionMethod" ADD VALUE 'SELF_ANCHOR';

-- AlterTable
ALTER TABLE "PartyResolutionClaim" ALTER COLUMN "signalType" DROP NOT NULL,
ALTER COLUMN "signalValue" DROP NOT NULL;
