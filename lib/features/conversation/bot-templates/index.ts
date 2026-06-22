/**
 * Bot Templates — Stage C public surface.
 *
 * Read-only template catalog (Ordered Form / L1) + lookups + a preview-only
 * resolver. No materialization, no persistence, no conversation-flow coupling.
 */

export {
  TEMPLATE_VERSION,
  GENERIC_TEMPLATE_CATEGORY,
  type BotTemplate,
  type TemplateFieldRef,
  type PartyRole,
  type TemplateCategory,
  type ResolvedTemplateField,
} from "./bot-template.types";

export { BOT_TEMPLATE_CATALOG } from "./template-catalog";

export {
  getTemplate,
  getTemplateForCategory,
  getDefaultTemplate,
  listTemplates,
  resolveTemplate,
  assertTemplateCatalogIntegrity,
} from "./template-catalog.helpers";
