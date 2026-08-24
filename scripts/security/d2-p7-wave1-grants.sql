-- D2 / P7 Wave 1 — least-privilege runtime grants (PER-ENVIRONMENT artifact).
--
-- Applied by an owner-privileged operator/workflow to the environment's
-- least-privilege runtime role. Role names are environment-specific and
-- therefore deliberately NOT part of the prisma migration:
--   Preview: app_runtime_preview_p4b   (the P4-B persistent runtime role)
--   Production: the future prod runtime role (separate cutover phase)
-- Replace the :ROLE placeholder (the CI battery does this textually).
--
-- Every verb below is code-observed (D2/P7 Wave 1 route/service inventory) —
-- no GRANT ALL, nothing speculative:
--   * Task / Deal / Lead: RLS-protected but UNGRANTED (zero wired runtime
--     paths; Lead's only consumer is account-deletion, deferred to its wave).
--   * ServiceCostProfile / PricingRecommendation: SELECT+INSERT only — the
--     adversarial parent-join proof is the only current consumer.
--   * LearningEvent / Supplier / BusinessBot / BusinessBotSettings are NOT
--     Wave-1 RLS tables, but Wave-1 routes touch them (deals PATCH + matching
--     engine append LearningEvent; CRM subject resolver reads Supplier;
--     bot/knowledge GET reads BusinessBot+Settings). Minimal observed verbs.
--
-- Preserved denials (already true for the role; never granted here):
--   _prisma_migrations, any DDL / CREATE on schema public, table ownership,
--   role management, BYPASSRLS.

-- Obligations
GRANT SELECT, INSERT, UPDATE ON "BusinessObligation" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "BusinessObligation_id_seq" TO :ROLE;
GRANT SELECT, INSERT, UPDATE ON "BusinessObligationOrientation" TO :ROLE;

-- CRM notes / attachments
GRANT SELECT, INSERT, UPDATE, DELETE ON "CrmNote" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "CrmNote_id_seq" TO :ROLE;
GRANT SELECT, INSERT, DELETE ON "CrmAttachment" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "CrmAttachment_id_seq" TO :ROLE;

-- Pricing
GRANT SELECT, INSERT, UPDATE ON "PricingProfile" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "PricingProfile_id_seq" TO :ROLE;
GRANT SELECT, INSERT ON "PricingCalculation" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "PricingCalculation_id_seq" TO :ROLE;

-- Deals (CollaborationDeal id is a uuid string — no sequence)
GRANT SELECT, INSERT, UPDATE ON "CollaborationDeal" TO :ROLE;

-- BusinessService + indirect children (proof-driven minimal on the children)
GRANT SELECT ON "BusinessService" TO :ROLE;
GRANT SELECT, INSERT ON "ServiceCostProfile" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "ServiceCostProfile_id_seq" TO :ROLE;
GRANT SELECT, INSERT ON "PricingRecommendation" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "PricingRecommendation_id_seq" TO :ROLE;

-- Non-Wave-1 side requirements of Wave-1 routes (no RLS on these yet).
-- LearningEvent needs SELECT alongside INSERT: Prisma `create` runs
-- INSERT ... RETURNING, and RETURNING requires SELECT on the returned columns.
GRANT SELECT, INSERT ON "LearningEvent" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "LearningEvent_id_seq" TO :ROLE;
GRANT SELECT ON "Supplier" TO :ROLE;
GRANT SELECT ON "BusinessBot" TO :ROLE;
GRANT SELECT ON "BusinessBotSettings" TO :ROLE;
