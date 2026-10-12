/**
 * The signup form carries one field no person ever sees or reaches: visually hidden, out of the tab
 * order, hidden from assistive technology, autocomplete off. A person leaves it empty; a script that
 * fills every input it finds does not. No CAPTCHA, nothing for a real visitor to do.
 *
 * It is a cheap filter, not a defence on its own — the per-IP limit and the closed checks behind it
 * still apply to everything that passes.
 */

/** Deliberately not a name browsers autofill (no "website", "url", "company", "phone"). */
export const SIGNUP_HONEYPOT_FIELD = "dz_confirm_field";

export function isHoneypotFilled(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const value = (body as Record<string, unknown>)[SIGNUP_HONEYPOT_FIELD];
  return typeof value === "string" ? value.trim().length > 0 : value !== undefined && value !== null && value !== "";
}
