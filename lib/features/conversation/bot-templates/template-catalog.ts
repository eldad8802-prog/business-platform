/**
 * Template Catalog v1 — canonical, read-only.
 *
 * 4 starter templates: a generic fallback + 3 vertical examples. This is the
 * SYSTEM (capable of holding templates), not a final content decision — more
 * templates are added by extending this array. Each template composes only
 * Field Catalog keys; it never defines field shapes.
 *
 * Data only. No materialization, no writer, no live-flow import.
 */

import {
  GENERIC_TEMPLATE_CATEGORY,
  TEMPLATE_VERSION,
  type BotTemplate,
} from "./bot-template.types";

export const BOT_TEMPLATE_CATALOG: readonly BotTemplate[] = [
  {
    templateVersion: TEMPLATE_VERSION,
    key: "generic_default",
    category: GENERIC_TEMPLATE_CATEGORY,
    partyRole: "CUSTOMER",
    label: "כללי",
    welcomeMessage: "היי! תודה שפנית. כמה פרטים קצרים ונחזור אליך.",
    finalAction: "LEAVE_MESSAGE",
    fieldRefs: [
      { catalogKey: "party_name", order: 1, required: true },
      { catalogKey: "party_phone", order: 2, required: true },
      { catalogKey: "anything_else", order: 3, required: false },
    ],
  },
  {
    templateVersion: TEMPLATE_VERSION,
    key: "beauty_default",
    category: "Beauty",
    partyRole: "CUSTOMER",
    label: "יופי וטיפוח",
    welcomeMessage: "היי! נשמח לעזור לקבוע תור. כמה פרטים ונמשיך.",
    finalAction: "COLLECT_DETAILS",
    fieldRefs: [
      { catalogKey: "party_name", order: 1, required: true },
      {
        catalogKey: "service_type",
        order: 2,
        required: true,
        questionOverride: "איזה טיפול מעניין אותך?",
      },
      { catalogKey: "appointment_date", order: 3, required: false },
    ],
  },
  {
    templateVersion: TEMPLATE_VERSION,
    key: "food_default",
    category: "Food",
    partyRole: "CUSTOMER",
    label: "אוכל ומשקאות",
    welcomeMessage: "היי! נשמח לשריין לכם מקום. כמה פרטים ונמשיך.",
    finalAction: "COLLECT_DETAILS",
    fieldRefs: [
      { catalogKey: "party_name", order: 1, required: true },
      { catalogKey: "subject_seats_count", order: 2, required: true },
      { catalogKey: "appointment_date", order: 3, required: false },
    ],
  },
  {
    templateVersion: TEMPLATE_VERSION,
    key: "home_services_default",
    category: "Home Services",
    partyRole: "CUSTOMER",
    label: "שירותי בית",
    welcomeMessage: "היי! נשמח לעזור. כמה פרטים ונחזור אליך בהקדם.",
    finalAction: "LEAVE_MESSAGE",
    fieldRefs: [
      { catalogKey: "party_name", order: 1, required: true },
      { catalogKey: "party_phone", order: 2, required: true },
      { catalogKey: "subject_property_address", order: 3, required: true },
    ],
  },
];
