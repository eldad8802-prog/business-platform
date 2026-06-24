/**
 * Bot Builder new-world layer (Stage 1) — public surface.
 *
 * Descriptive identity + profile only. NOT imported by the conversation
 * pipeline or the response-planner.
 */

export {
  PROFILE_VERSION,
  BOT_TONES,
  BOT_VERBOSITIES,
  BOT_SALE_STYLES,
  BOT_INITIATIVE_LEVELS,
  BOT_TRAITS,
  BOT_LANGUAGES,
  BOT_AUDIENCE_TAGS,
  BOT_PRIORITIES,
  MAX_DISPLAY_NAME_CHARS,
  MAX_AVATAR_CHARS,
  MAX_OBJECTIONS,
  MAX_OBJECTION_LABEL_CHARS,
  MAX_OBJECTION_RESPONSE_CHARS,
  validateVoice,
  validatePersonality,
  validateApproach,
  validateProfile,
  validateBotPatch,
  coerceVoice,
  coercePersonality,
  coerceApproach,
  coerceStoredProfile,
  hasVoiceContent,
  hasPersonalityContent,
  hasApproachContent,
  BOT_TONE_OPTIONS,
  BOT_VERBOSITY_OPTIONS,
  BOT_TRAIT_OPTIONS,
  BOT_LANGUAGE_OPTIONS,
  BOT_AUDIENCE_OPTIONS,
  BOT_SALE_STYLE_OPTIONS,
  BOT_INITIATIVE_OPTIONS,
  BOT_PRIORITY_OPTIONS,
  type BotTone,
  type BotVerbosity,
  type BotSaleStyle,
  type BotInitiativeLevel,
  type BotTrait,
  type BotLanguage,
  type BotAudienceTag,
  type BotPriority,
  type BotVoiceConfig,
  type BotPersonalityConfig,
  type BotApproachConfig,
  type BotProfileConfig,
  type BotProfileObjection,
  type BotIdentity,
  type BotIdentityPatch,
  type BotPatch,
  type Validated,
} from "./bot-profile";

export {
  BOT_HUB_AREA_IDS,
  computeBotAreaStates,
  type BotAreaState,
  type BotHubAreaId,
  type BotHubSignals,
  type BotHubAreaStateMap,
} from "./bot-hub-areas";

export {
  GOAL_CATALOG_VERSION,
  GOAL_CATEGORY_KEYS,
  GOAL_CATALOG,
  isGoalKey,
  listGoalKeys,
  getGoalDef,
  assertGoalCatalogIntegrity,
  validateGoalSelection,
  type GoalCategoryKey,
  type GoalDef,
  type GoalCategory,
} from "./bot-goals";

export {
  assembleBase,
  materializeSettingsFromBase,
  validateAssembledBase,
  type AssembledBase,
  type AssembledQuestion,
  type AssembledItem,
  type MaterializedSettings,
} from "./bot-setup-assembly";

export {
  RECOMMENDATION_STATUSES,
  generateGoalChangeRecommendations,
  type RecommendationStatus,
  type RecommendationCandidate,
} from "./bot-recommendations";

export {
  MEMORY_TOGGLE_KEYS,
  MEMORY_POLICY_VERSION,
  MEMORY_TOGGLE_OPTIONS,
  emptyMemoryPolicy,
  validateMemoryPolicy,
  coerceMemoryPolicy,
  hasMemoryPolicyContent,
  type MemoryToggleKey,
  type BotMemoryPolicy,
} from "./bot-memory-policy";

export {
  LEARNING_STATUSES,
  LEARNING_TYPES,
  LEARNING_TYPE_LABELS,
  isLearningType,
  isLearningStatus,
  type LearningStatus,
  type LearningType,
} from "./bot-learning";

export {
  buildBotComposeContext,
  applyVoiceToWelcome,
  type BotComposeContext,
} from "./bot-compose-context";

export {
  SETUP_STATUSES,
  SETUP_MAX_STEP,
  validateSetupPatch,
  coerceSelectedGoalKeys,
  type SetupStatus,
  type SetupDraftPatch,
} from "./bot-setup";

export {
  MAX_FAQ_ITEMS,
  emptyKnowledge,
  validateKnowledge,
  coerceKnowledge,
  hasKnowledgeContent,
  type BotKnowledge,
  type FaqItem,
} from "./bot-knowledge";
