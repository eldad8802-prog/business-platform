-- D2 / P7-W4E-B-2 — least-privilege grants (PER-ENVIRONMENT artifact).
--
-- :ROLE = the tenant runtime role (Preview: app_runtime_preview_p4b).
--
-- Every verb is code-observed from the live Billing graph. Unlike prior waves
-- this one DOES need DELETE — on exactly three tables, and for one reason:
-- draft documents replace their children wholesale (set-the-lines, set-the-
-- payments, set-the-allocations) rather than diffing them. That is existing
-- product semantics, not something this wave introduces, and it is confined to
-- draft state. The other five tables get no DELETE at all: an issued document's
-- number, its audit trail, and an authority submission are append-only records.

-- Authority connection: findUnique + update/updateMany/upsert (connect,
-- callback, refresh, validation, revoke). No create-only path, no delete.
GRANT SELECT, INSERT, UPDATE ON "BillingAuthorityConnection" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "BillingAuthorityConnection_id_seq" TO :ROLE;

-- Authority submission: create + read + update (status/retry). Append-only
-- history — no runtime path deletes a submission.
GRANT SELECT, INSERT, UPDATE ON "BillingAuthoritySubmission" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "BillingAuthoritySubmission_id_seq" TO :ROLE;

-- Payment allocation: createMany/deleteMany (receipt allocations are REPLACED
-- as a set while the receipt is a draft) + findMany/aggregate for settlement
-- state. DELETE is required by that replace semantics.
GRANT SELECT, INSERT, DELETE ON "BillingPaymentAllocation" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "BillingPaymentAllocation_id_seq" TO :ROLE;

-- Number sequence: findUnique + upsert only. UPDATE is what `increment` needs;
-- INSERT is the first allocation for a (business, documentType). Deliberately
-- NO DELETE — a legal numbering sequence is never removed at runtime.
GRANT SELECT, INSERT, UPDATE ON "BillingDocumentNumberSequence" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "BillingDocumentNumberSequence_id_seq" TO :ROLE;

-- Billing audit: append + read. Never updated, never deleted.
GRANT SELECT, INSERT ON "BillingAuditEvent" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "BillingAuditEvent_id_seq" TO :ROLE;

-- BusinessBot: findUnique + upsert.
GRANT SELECT, INSERT, UPDATE ON "BusinessBot" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "BusinessBot_id_seq" TO :ROLE;

-- Document children — draft replace semantics (create/createMany + deleteMany).
GRANT SELECT, INSERT, DELETE ON "BillingDocumentLine" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "BillingDocumentLine_id_seq" TO :ROLE;
GRANT SELECT, INSERT, DELETE ON "BillingReceiptPayment" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "BillingReceiptPayment_id_seq" TO :ROLE;

-- BillingDocument itself already carries the P4-B pilot SELECT grant. The
-- Billing module cannot function under the least-privilege role without the
-- writes its own routes perform, so W4E-B-2 adds them here (and the rollback
-- revokes ONLY what this wave added, preserving the pilot lineage).
GRANT SELECT, INSERT, UPDATE ON "BillingDocument" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "BillingDocument_id_seq" TO :ROLE;

-- ============================================================
-- No admin grants in W4E-B-2 — no admin-client consumer reads any of these
-- tables. In particular app_admin gets NO access to authority token metadata
-- and NO write anywhere: the read-only admin doctrine is unchanged, which is
-- exactly why BusinessFeatureAccess stayed out of this wave.
-- ============================================================
