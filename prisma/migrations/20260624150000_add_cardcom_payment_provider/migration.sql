-- I1: CardCom provider identity.
-- Additive only — adds the CARDCOM value to the PaymentProvider enum. No table,
-- column, or data changes. No behavior change: CardCom is a registered identity
-- whose adapter stub fails clearly if invoked.
--
-- NOT applied to Production by this change. Apply via the normal migrate flow
-- against dev/preview first.

-- AlterEnum
ALTER TYPE "PaymentProvider" ADD VALUE 'CARDCOM';
