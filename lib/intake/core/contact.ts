/**
 * Business Intake · contact HINTS — normalized, never proven identity.
 *
 * Reuses the repository's canonical normalizers instead of adding another:
 *   phone  → normalizeCustomerPhone (the one Customer / Lead / Party / M2 use;
 *            Customer's (businessId, phone) unique is keyed on its output)
 *   email  → normalizeEmail (signup identity: trim + lower-case) after the
 *            shared plausibility check
 *
 * A malformed hint is DROPPED and recorded as an 'invalid' signal — it never
 * blocks the event, and it is never guessed into something else.
 */

import { normalizeCustomerPhone } from "@/lib/services/integrations/whatsapp/phone";
import { normalizeEmail } from "@/lib/auth/signup-identity";
import { isPlausibleEmail } from "@/lib/services/inventory/supplier-profile";
import type { ContactHints, ContactSignals } from "./contract";

const MAX_TEXT = 120;

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, MAX_TEXT) : null;
}

export function normalizeContactHints(input: {
  phone?: unknown;
  email?: unknown;
  providerUserId?: unknown;
  displayName?: unknown;
  companyName?: unknown;
}): { hints: ContactHints | null; signals: ContactSignals } {
  const hints: ContactHints = {};
  const signals: ContactSignals = {};

  const rawPhone = text(input.phone);
  if (rawPhone !== null) {
    const phone = normalizeCustomerPhone(rawPhone);
    if (phone) {
      hints.phone = phone;
      signals.phone = "valid";
    } else signals.phone = "invalid";
  }

  const rawEmail = text(input.email);
  if (rawEmail !== null) {
    if (isPlausibleEmail(rawEmail)) {
      hints.email = normalizeEmail(rawEmail);
      signals.email = "valid";
    } else signals.email = "invalid";
  }

  for (const key of ["providerUserId", "displayName", "companyName"] as const) {
    const v = text(input[key]);
    if (v !== null) {
      hints[key] = v;
      signals[key] = "valid";
    }
  }

  return { hints: Object.keys(hints).length ? hints : null, signals };
}
