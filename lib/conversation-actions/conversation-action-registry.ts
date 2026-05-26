/**
 * Conversation Action Registry v1 — static metadata only.
 * No executor, no runtime wiring, no side effects.
 */

export type ConversationActionDomain =
  | "commerce"
  | "crm"
  | "documents"
  | "billing"
  | "inventory"
  | "scheduling"
  | "conversation";

/** Policy hint for a future execution layer; registry does not enforce. */
export type ConversationActionSafetyTier =
  | "observe"
  | "suggest"
  | "requires_approval"
  | "automated_allowed";

/** Business capability flags — metadata only; not read from DB here. */
export type ConversationActionCapability =
  | "inventory_enabled"
  | "billing_enabled"
  | "documents_enabled"
  | "appointments_enabled"
  | "product_catalog_enabled";

/** Channel hints for future gating; empty array = no restriction in v1 metadata. */
export type ConversationActionChannel = "whatsapp" | "email" | "phone" | "other";

export type ConversationActionId =
  | "SHOW_PRODUCT_LINK"
  | "CREATE_FOLLOW_UP"
  | "HANDOFF_TO_OWNER"
  | "SAVE_DOCUMENT_FROM_CHAT"
  | "CREATE_LEAD"
  | "MARK_QUOTE_SENT"
  | "CREATE_INVOICE_DRAFT"
  | "CHECK_PRODUCT_AVAILABILITY"
  | "BOOK_APPOINTMENT";

export type ConversationActionDefinition = {
  id: ConversationActionId;
  /** Short human-readable title for catalogs / tools (not inbox UI v1). */
  label: string;
  domain: ConversationActionDomain;
  safetyTier: ConversationActionSafetyTier;
  requiredCapabilities: readonly ConversationActionCapability[];
  channelConstraints: readonly ConversationActionChannel[];
  /** Optional free-form hints for future mappers (e.g. outcome / stage families). */
  triggerHints?: readonly string[];
  /** Internal documentation for engineers. */
  developerDescription: string;
};

const DEFINITIONS: readonly ConversationActionDefinition[] = [
  {
    id: "SHOW_PRODUCT_LINK",
    label: "Show product link",
    domain: "commerce",
    safetyTier: "suggest",
    requiredCapabilities: ["product_catalog_enabled"],
    channelConstraints: [],
    triggerHints: ["commerce_context"],
    developerDescription:
      "Surface a canonical product or landing URL from catalog; no purchase side effects.",
  },
  {
    id: "CREATE_FOLLOW_UP",
    label: "Create follow-up",
    domain: "conversation",
    safetyTier: "requires_approval",
    requiredCapabilities: [],
    channelConstraints: [],
    triggerHints: ["follow_up_outcome", "nba_follow_up_family"],
    developerDescription:
      "Schedule or record a follow-up task tied to the conversation; human confirmation expected.",
  },
  {
    id: "HANDOFF_TO_OWNER",
    label: "Hand off to owner",
    domain: "conversation",
    safetyTier: "suggest",
    requiredCapabilities: [],
    channelConstraints: [],
    triggerHints: ["bot_handoff", "nba_agent_handoff"],
    developerDescription:
      "Escalate thread visibility or ownership to a human; metadata only.",
  },
  {
    id: "SAVE_DOCUMENT_FROM_CHAT",
    label: "Save document from chat",
    domain: "documents",
    safetyTier: "requires_approval",
    requiredCapabilities: ["documents_enabled"],
    channelConstraints: [],
    triggerHints: ["attachment_or_shared_file"],
    developerDescription:
      "Attach inbound file or extracted artifact to documents domain; approval before commit.",
  },
  {
    id: "CREATE_LEAD",
    label: "Create lead",
    domain: "crm",
    safetyTier: "requires_approval",
    requiredCapabilities: [],
    channelConstraints: [],
    triggerHints: ["new_contact", "intent_qualification"],
    developerDescription:
      "Create or enrich CRM lead from conversation context; avoid duplicate auto-create without policy.",
  },
  {
    id: "MARK_QUOTE_SENT",
    label: "Mark quote sent",
    domain: "crm",
    safetyTier: "suggest",
    requiredCapabilities: [],
    channelConstraints: [],
    triggerHints: ["stage_quoted", "stalled_quote_signal"],
    developerDescription:
      "Record that a quote was sent for pipeline analytics; does not send a quote by itself.",
  },
  {
    id: "CREATE_INVOICE_DRAFT",
    label: "Create invoice draft",
    domain: "billing",
    safetyTier: "requires_approval",
    requiredCapabilities: ["billing_enabled"],
    channelConstraints: [],
    triggerHints: ["post_deal_or_explicit_billing_intent"],
    developerDescription:
      "Open a billing document draft linked to the customer; no issuance without approval.",
  },
  {
    id: "CHECK_PRODUCT_AVAILABILITY",
    label: "Check product availability",
    domain: "inventory",
    safetyTier: "observe",
    requiredCapabilities: ["inventory_enabled", "product_catalog_enabled"],
    channelConstraints: [],
    triggerHints: ["stock_question"],
    developerDescription:
      "Read-only stock / SKU lookup for assistant copy; no reservation.",
  },
  {
    id: "BOOK_APPOINTMENT",
    label: "Book appointment",
    domain: "scheduling",
    safetyTier: "requires_approval",
    requiredCapabilities: ["appointments_enabled"],
    channelConstraints: [],
    triggerHints: ["scheduling_intent"],
    developerDescription:
      "Create or propose a calendar hold; typically needs human or explicit customer confirmation.",
  },
] as const;

/** Stable ordered list — single source of truth for v1 action metadata. */
export const CONVERSATION_ACTION_REGISTRY: readonly ConversationActionDefinition[] = DEFINITIONS;

const BY_ID: ReadonlyMap<ConversationActionId, ConversationActionDefinition> = new Map(
  DEFINITIONS.map((d) => [d.id, d])
);

export function getConversationActionDefinition(
  id: string
): ConversationActionDefinition | undefined {
  return BY_ID.get(id as ConversationActionId);
}
