import type { BusinessIdentityDimension } from "@prisma/client";

/**
 * P2 · The vocabulary of owner identity statements — pure, no database.
 *
 * Two kinds of dimension, kept apart on purpose:
 *   CODED  audience, objectives, tone, positioning. Internal directives for how Dubiz represents
 *          the business. A closed list, so nothing sensitive can be typed into them, and never
 *          approvable for public use (they are strategy, not claims).
 *   TEXT   description, specialization, differentiator, service area. Claim-like: the only
 *          dimensions a landing page could one day quote, so the only ones with public-use authority.
 *
 * The audience list is business-level on purpose. It has no age, family, religion, ethnicity,
 * health, politics or orientation code, and free text is not accepted for it.
 */

export const TARGET_AUDIENCE_CODES = [
  "INDIVIDUALS",
  "BUSINESSES",
  "LOCAL_CUSTOMERS",
  "REMOTE_CUSTOMERS",
  "HOME_SERVICE_CUSTOMERS",
  "APPOINTMENT_CUSTOMERS",
  "WALK_IN_CUSTOMERS",
  "NEW_CUSTOMERS",
  "RETURNING_CUSTOMERS",
  "EVENT_CUSTOMERS",
] as const;

/** Business-level objective. Not the final Conversion Preference (page-level CTA) system. */
export const OBJECTIVE_CODES = [
  "BOOK",
  "BUY",
  "CALL",
  "WHATSAPP",
  "REQUEST_QUOTE",
  "VISIT_STORE",
  "DISCOVER_SERVICES",
  "DISCOVER_PRODUCTS",
  "LEAVE_LEAD",
] as const;

export const TONE_CODES = ["PROFESSIONAL", "WARM", "FRIENDLY_CASUAL", "ENERGETIC", "PREMIUM"] as const;

export const POSITIONING_CODES = [
  "VALUE",
  "PREMIUM",
  "SPEED",
  "AVAILABILITY",
  "EXPERTISE",
  "LOCAL_TRUST",
  "SPECIALIZATION",
  "CONVENIENCE",
  "BREADTH",
  "PERSONAL_SERVICE",
  "INNOVATION",
] as const;

export type DimensionRule =
  | { kind: "CODED"; codes: readonly string[]; single: boolean; maxActive: number; publicUseEligible: false }
  | { kind: "TEXT"; maxLength: number; single: boolean; maxActive: number; publicUseEligible: true };

export const DIMENSION_RULES: Record<BusinessIdentityDimension, DimensionRule> = {
  DESCRIPTION: { kind: "TEXT", maxLength: 500, single: true, maxActive: 1, publicUseEligible: true },
  SPECIALIZATION: { kind: "TEXT", maxLength: 120, single: false, maxActive: 3, publicUseEligible: true },
  DIFFERENTIATOR: { kind: "TEXT", maxLength: 200, single: false, maxActive: 6, publicUseEligible: true },
  SERVICE_AREA: { kind: "TEXT", maxLength: 80, single: false, maxActive: 5, publicUseEligible: true },
  TARGET_AUDIENCE: { kind: "CODED", codes: TARGET_AUDIENCE_CODES, single: false, maxActive: 4, publicUseEligible: false },
  PRIMARY_OBJECTIVE: { kind: "CODED", codes: OBJECTIVE_CODES, single: true, maxActive: 1, publicUseEligible: false },
  SECONDARY_OBJECTIVE: { kind: "CODED", codes: OBJECTIVE_CODES, single: false, maxActive: 2, publicUseEligible: false },
  TONE: { kind: "CODED", codes: TONE_CODES, single: true, maxActive: 1, publicUseEligible: false },
  POSITIONING: { kind: "CODED", codes: POSITIONING_CODES, single: false, maxActive: 3, publicUseEligible: false },
};

export const IDENTITY_DIMENSIONS = Object.keys(DIMENSION_RULES) as BusinessIdentityDimension[];

export class IdentityInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityInputError";
  }
}

export function isIdentityDimension(value: unknown): value is BusinessIdentityDimension {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(DIMENSION_RULES, value);
}

// Contact details are a separate authority question (billing phone ≠ permission to publish), so an
// identity statement refuses anything that looks like one rather than quietly storing it.
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
// Nine or more digits: Israeli numbers are 9–10 digits, while a year range ("2010-2024") is eight.
const PHONE = /(?:\+?\d[\s\-().]*){9,}/;
const URL_LIKE = /(https?:\/\/|www\.)/i;

export type NormalizedStatementValue = { code: string | null; text: string | null };

/** Validate one value for one dimension. Throws IdentityInputError; returns the stored shape. */
export function normalizeStatementValue(
  dimension: BusinessIdentityDimension,
  input: { code?: unknown; text?: unknown },
): NormalizedStatementValue {
  const rule = DIMENSION_RULES[dimension];
  if (rule.kind === "CODED") {
    if (input.text !== undefined && input.text !== null) {
      throw new IdentityInputError(`${dimension} accepts a code, not free text`);
    }
    if (typeof input.code !== "string" || !rule.codes.includes(input.code)) {
      throw new IdentityInputError(`Unknown ${dimension} code`);
    }
    return { code: input.code, text: null };
  }
  if (input.code !== undefined && input.code !== null) {
    throw new IdentityInputError(`${dimension} accepts text, not a code`);
  }
  if (typeof input.text !== "string") throw new IdentityInputError(`${dimension} text is required`);
  const text = input.text.replace(/\s+/g, " ").trim();
  if (!text) throw new IdentityInputError(`${dimension} text is required`);
  if (text.length > rule.maxLength) throw new IdentityInputError(`${dimension} text is too long`);
  if (EMAIL.test(text) || PHONE.test(text) || URL_LIKE.test(text)) {
    throw new IdentityInputError("Contact details and links are not part of an identity statement");
  }
  return { code: null, text };
}
