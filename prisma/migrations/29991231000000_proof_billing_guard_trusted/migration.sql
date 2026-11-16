-- PROOF ONLY (never merged): a new read of a protected billing table must be reported as G4 by billing/guard-trusted.
SELECT 1 FROM "BillingDocument" LIMIT 0;
