-- D2 / P7 Wave 2 — least-privilege grants (PER-ENVIRONMENT artifact).
--
-- :ROLE = the environment's tenant runtime role (Preview: app_runtime_preview_p4b).
-- Admin grants target the env-neutral app_admin group. Every verb below is
-- code-observed (Wave-2 route/service inventory):
--
--   * ContentEvent, ContentRender, LearningSignal, FinancialDocument, Party,
--     PartyResolutionClaim, RiaCanonicalReferent, RiaPolicyLineage,
--     DerivedClaimProjection, DerivedClaimCandidate, DerivedClaimEvidenceLink,
--     Recommendation, RecommendationOutcome: RLS-protected but UNGRANTED —
--     zero wired runtime consumers (Party* = backfill-only; DerivedClaim* and
--     the business-memory read path are env-flag-gated and fail-open by
--     design; Recommendation* have no live writer).
--   * LearningEvent runtime grant (SELECT, INSERT + sequence) already exists
--     from Wave 1 — not repeated here.
--   * BusinessBot / BusinessBotSettings keep app-level-only protection until
--     the webhook wave, but the bot-builder routes REQUIRE write access now.

-- Content (video/plan persistence)
GRANT SELECT, INSERT ON "ContentRun" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "ContentRun_id_seq" TO :ROLE;
GRANT SELECT, INSERT ON "ContentVariant" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "ContentVariant_id_seq" TO :ROLE;
-- ContentRender: proof-driven minimal (the depth-2 adversarial proof is the
-- only current consumer — renders are provider-side today; expands when a
-- real persistence path lands).
GRANT SELECT, INSERT ON "ContentRender" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "ContentRender_id_seq" TO :ROLE;

-- Usage quota counters (content/render)
GRANT SELECT, INSERT, UPDATE ON "Usage" TO :ROLE;

-- Bot builder parents (RLS deferred to the webhook wave; grants required now)
GRANT SELECT, INSERT, UPDATE ON "BusinessBot" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "BusinessBot_id_seq" TO :ROLE;
GRANT SELECT, INSERT, UPDATE ON "BusinessBotSettings" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "BusinessBotSettings_id_seq" TO :ROLE;

-- Bot builder children (RLS'd via parent-join)
GRANT SELECT, INSERT, UPDATE ON "BusinessBotProfile" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "BusinessBotProfile_id_seq" TO :ROLE;
GRANT SELECT, INSERT, DELETE ON "BotGoalSelection" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "BotGoalSelection_id_seq" TO :ROLE;
GRANT SELECT, INSERT, UPDATE, DELETE ON "BusinessBotSetupDraft" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "BusinessBotSetupDraft_id_seq" TO :ROLE;
GRANT SELECT, INSERT, UPDATE ON "BusinessBotKnowledge" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "BusinessBotKnowledge_id_seq" TO :ROLE;
GRANT SELECT, INSERT, UPDATE ON "BusinessBotRecommendation" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "BusinessBotRecommendation_id_seq" TO :ROLE;
GRANT SELECT, INSERT, UPDATE ON "BusinessBotMemoryPolicy" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "BusinessBotMemoryPolicy_id_seq" TO :ROLE;
-- Suggestions are seeded by tools/tests; routes only list + status-flip.
GRANT SELECT, UPDATE ON "BusinessBotLearningSuggestion" TO :ROLE;

-- Admin (platform-overview migration): SELECT-only additions to the group.
-- Conversation/BillingDocument/User/Business/PlatformAuditEvent are already
-- granted by the W2-GATE starter artifact.
GRANT SELECT ON "ContentRun" TO app_admin;
GRANT SELECT ON "Document" TO app_admin;
GRANT SELECT ON "EmailConnection" TO app_admin;
GRANT SELECT ON "WhatsAppAttachmentImport" TO app_admin;
