-- M5 · Identity enum expansion — teaching the existing Party substrate about the spending side.
--
-- SEPARATE FROM THE REST OF M4/M5, ON PURPOSE.
--
-- `ALTER TYPE ... ADD VALUE` has a rule that has caught this kind of change before: a label added
-- inside a transaction cannot be USED inside that same transaction. Nothing in the next migration
-- writes one of these labels, so one combined file would very probably have worked — and "very
-- probably" is not a property worth having in a production migration when the alternative costs a
-- directory. Splitting removes the question instead of answering it.
--
-- Purely additive: three existing enums gain values, nothing is renamed, nothing is dropped, no row
-- is touched. Every existing value keeps its meaning and its ordinal.

-- The three subject kinds on the spending side. CUSTOMER and LEAD were the only roles the identity
-- ledger knew, which is why a supplier and a payee could never be observed to be the same entity.
ALTER TYPE "PartyRoleType" ADD VALUE IF NOT EXISTS 'SUPPLIER';
ALTER TYPE "PartyRoleType" ADD VALUE IF NOT EXISTS 'PAYEE';
ALTER TYPE "PartyRoleType" ADD VALUE IF NOT EXISTS 'DOCUMENT_VENDOR';

-- EMAIL is a moderate signal. NORMALIZED_NAME is a weak one and is deliberately given a name here
-- so that proposals can SAY what matched — it may never, on its own, establish a binding.
ALTER TYPE "PartySignalType" ADD VALUE IF NOT EXISTS 'EMAIL';
ALTER TYPE "PartySignalType" ADD VALUE IF NOT EXISTS 'NORMALIZED_NAME';

-- The only route by which a weak resemblance can ever become a binding: a person said so.
ALTER TYPE "PartyResolutionMethod" ADD VALUE IF NOT EXISTS 'OWNER_CONFIRMED';
