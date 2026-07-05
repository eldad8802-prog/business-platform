-- Expand-only: add PAYPAL to the PaymentProvider enum.
-- Safe/additive — no existing rows or columns change. `ADD VALUE IF NOT EXISTS`
-- is idempotent (Postgres 12+). Enables storing PayPal connections / requests /
-- transactions alongside TRANZILA and CARDCOM.
ALTER TYPE "PaymentProvider" ADD VALUE IF NOT EXISTS 'PAYPAL';
