-- P3-A · Identity enum values for Trust + Conversion intelligence (migration only)
--
-- SEPARATE FROM 20261008090100_p3a_trust_claims, ON PURPOSE.
--
-- `ALTER TYPE ... ADD VALUE` adds a label that cannot be USED inside the transaction that added
-- it, and the next migration names these labels in CHECK constraints. Prisma applies each
-- migration file as its own transaction, so splitting removes the question instead of answering
-- it (same reasoning, same shape as 20260924090000_m5_identity_enum_expansion).
--
-- Purely additive: two existing P2 enums gain one value each, at the end. Nothing is renamed, nothing is
-- dropped, no row is touched, every existing value keeps its meaning and its ordinal. No code on
-- main reads or writes these labels; until the P3-A application ships they are inert.

-- Publication authority over the official WhatsApp Business number. The canonical value stays in
-- WhatsAppConnection.displayPhoneNumber; P2's fact-authority row will hold only a sha256 of the
-- number the owner approved, so a changed number lapses the approval by itself.
-- Connection existence ≠ public authority.
ALTER TYPE "BusinessIdentityFact" ADD VALUE IF NOT EXISTS 'PUBLIC_WHATSAPP';

-- Deliberately NO public shop / external-commerce link fact. No canonical, publication-grade URL
-- store exists (the bot's product link is bot configuration, not identity), so P3-A reports
-- "BUY via EXTERNAL_LINK" as missing its canonical source rather than borrowing one.

-- A CODED owner dimension: what the business declares it fulfils (accepts visits, takes bookings
-- by message, gives quotes on request, WhatsApp on the public phone, sells in an external shop).
-- A declaration of fulfilment capability, never a preference and never derived.
ALTER TYPE "BusinessIdentityDimension" ADD VALUE IF NOT EXISTS 'CONVERSION_DECLARATION';
