/**
 * Dubiz semantic ENTITY colours.
 *
 * A colour here means WHAT SOMETHING IS, never how urgent it is. Seven roles,
 * drawn from the warm Design System v1 palette — no new hues.
 *
 *   money-in    teal    money that arrived
 *   money-out   ochre   money the business owes
 *   billing     sand    a document the business issues
 *   document    slate   a document that arrived
 *   people      sky     a person: customer, lead, conversation
 *   operations  sage    physical things: stock, suppliers
 *   system      grey    configuration
 *
 * WHY PEOPLE ARE BLUE, AND CORAL IS NOT AN ENTITY
 *   Coral already means "expired", "needs handling", "due tomorrow" across the
 *   product. A colour that means both "a person" and "urgent" means neither,
 *   and in testing a blue lead was recognised faster than a coral one. So
 *   people took sky, incoming documents moved to slate to stay separable from
 *   people, and coral was demoted to what it always read as: the URGENT STATE
 *   accent. It is exported as `URGENT`, and it is never an entity.
 *
 * Colour is never the only signal. Every place these are used also carries a
 * drawn icon and a word.
 */

export type EntityTone = {
  /** Text and outlines on a tinted surface. */
  ink: string;
  /** The tinted surface itself. */
  tint: string;
  /** The dominant fill inside an icon, and rules/markers. */
  solid: string;
  /** What the role means, for anything that has to say it out loud. */
  label: string;
};

export type EntityRole =
  | "money-in"
  | "money-out"
  | "billing"
  | "document"
  | "people"
  | "operations"
  | "system";

export const ENTITY_TONES: Record<EntityRole, EntityTone> = {
  "money-in": { ink: "#1f4a46", tint: "#D6E8E0", solid: "#1f4a46", label: "כסף שנכנס" },
  "money-out": { ink: "#8A6420", tint: "#F7E7C2", solid: "#f1cc76", label: "כסף שיוצא" },
  billing: { ink: "#7A5A33", tint: "#EFE2CC", solid: "#eadcc3", label: "מסמך שהעסק מוציא" },
  document: { ink: "#4A5A63", tint: "#DFE5E7", solid: "#C3D0D4", label: "מסמך שנכנס" },
  people: { ink: "#2F5C82", tint: "#D8E7F4", solid: "#9CC4E4", label: "אנשים" },
  operations: { ink: "#41695A", tint: "#DCE9E0", solid: "#b8d6c7", label: "תפעול" },
  system: { ink: "#55605a", tint: "#E7E5DE", solid: "#c9c4b8", label: "הגדרות" },
};

/** The urgent-state accent. A state, never an entity. */
export const URGENT: EntityTone = {
  ink: "#9A4A36",
  tint: "#F6DED4",
  solid: "#eba58f",
  label: "דורש טיפול",
};

/**
 * Which role an entity belongs to.
 *
 * The Secretary is money-out because what she reminds about is money the
 * business owes; the reminder is not its own kind of thing.
 */
const ENTITY_ROLE: Record<string, EntityRole> = {
  collection: "money-in",
  payment: "money-in",
  "payment-request": "money-in",
  payables: "money-out",
  obligation: "money-out",
  secretary: "money-out",
  invoice: "billing",
  invoices: "billing",
  receipt: "billing",
  document: "document",
  documents: "document",
  "documents-email": "document",
  upload: "document",
  customers: "people",
  lead: "people",
  leads: "people",
  conversations: "people",
  bots: "people",
  coupons: "people",
  marketing: "people",
  content: "people",
  inventory: "operations",
  suppliers: "operations",
  pricing: "operations",
  connections: "system",
  settings: "system",
};

export function roleOfEntity(entity: string): EntityRole {
  return ENTITY_ROLE[entity] ?? "system";
}

export function toneOfEntity(entity: string): EntityTone {
  return ENTITY_TONES[roleOfEntity(entity)];
}
