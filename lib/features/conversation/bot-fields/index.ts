/**
 * Structured Fields Foundation — Stage A public surface.
 *
 * Pure types + a read-only normalizer. No persistence, no conversation-flow
 * coupling, no Customer/Appointment writes. See `bot-field.types` and
 * `normalize-bot-fields` for details.
 */

export {
  BOT_FIELD_TYPES,
  BOT_FIELD_MAP_TARGETS,
  BOT_FIELDS_VERSION,
  type BotField,
  type BotFieldType,
  type BotFieldOption,
  type BotFieldMapTarget,
  type BotFieldsConfigV2,
  type LegacyQuestionsConfig,
} from "./bot-field.types";

export {
  normalizeBotFields,
  parseBotField,
  isLegacyQuestions,
  legacyItemsToBotFields,
  v2ConfigToBotFields,
  botFieldsToLegacyItems,
} from "./normalize-bot-fields";

export {
  FIELD_NAMESPACES,
  FIELD_CLASSES,
  BUILDER_VISIBILITIES,
  type CatalogField,
  type FieldNamespace,
  type FieldClass,
  type BuilderVisibility,
} from "./field-catalog.types";

export { BOT_FIELD_CATALOG } from "./field-catalog";

export {
  getCatalogField,
  isCatalogKey,
  listCatalogFields,
  getBuilderV1Fields,
  assertCatalogIntegrity,
  type ListCatalogFieldsOptions,
} from "./field-catalog.helpers";
