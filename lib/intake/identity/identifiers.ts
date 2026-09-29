/**
 * Business Intake M4 · identifiers — what an identity claim is made of.
 *
 * An identifier is (kind, scope, normalized value):
 *   phone     scope ''                    normalized by normalizeCustomerPhone
 *   email     scope ''                    normalized by normalizeEmail (+ plausibility)
 *   provider  scope "<sourceKey>:<acct>"  a person's id AT one provider account —
 *                                         strong only inside that scope, never global
 *
 * IdentityLink never stores the value. It stores a DOMAIN-SEPARATED SHA-256 of
 * (version, kind, scope, value): equal inputs match, different kinds / scopes
 * can never collide, and the database holds no second plaintext copy of an
 * email or phone that the Customer row already carries.
 *
 * Placeholder emails ("noreply@…", "test@example.com") and malformed values are
 * never identifiers — "do not merge based on malformed or placeholder email".
 */

import { createHash } from "node:crypto";
import type { ContactHints } from "@/lib/intake/core/contract";

export type IdentifierKind = "phone" | "email" | "provider";

export type Identifier = {
  kind: IdentifierKind;
  scope: string;
  /** Normalized value. Held in memory only; never persisted by M4. */
  value: string;
};

export type HashedIdentifier = { kind: IdentifierKind; scope: string; valueHash: string };

const VERSION = "m4.identity.v1";
const SEP = "\u001f";

export function identifierHash(id: Identifier): string {
  return `sha256:${createHash("sha256").update([VERSION, id.kind, id.scope, id.value].join(SEP), "utf8").digest("hex")}`;
}

export function hashIdentifier(id: Identifier): HashedIdentifier {
  return { kind: id.kind, scope: id.scope, valueHash: identifierHash(id) };
}

/** "<sourceKey>:<account>" — a provider id is only an identity inside this. */
export function providerScope(sourceKey: string, accountRef: string | null): string | null {
  const acct = (accountRef ?? "").trim();
  if (!/^[a-z][a-z0-9_.]*$/.test(sourceKey) || !acct || /\s/.test(acct) || acct.length > 128) return null;
  return `${sourceKey}:${acct}`;
}

const PLACEHOLDER_LOCAL = new Set([
  "noreply",
  "no-reply",
  "donotreply",
  "do-not-reply",
  "null",
  "none",
  "na",
  "n.a",
  "unknown",
  "test",
  "example",
  "email",
  "mail",
]);
const PLACEHOLDER_DOMAIN = new Set(["example.com", "example.org", "example.net", "invalid", "localhost", "test.com"]);

/** A normalized email that must never be treated as identity evidence. */
export function isPlaceholderEmail(normalizedEmail: string): boolean {
  const at = normalizedEmail.lastIndexOf("@");
  if (at <= 0) return true;
  const local = normalizedEmail.slice(0, at);
  const domain = normalizedEmail.slice(at + 1);
  return PLACEHOLDER_LOCAL.has(local) || PLACEHOLDER_DOMAIN.has(domain) || domain.endsWith(".invalid");
}

/**
 * The identifiers an event's normalized contact hints carry. Hints were already
 * normalized by M3 (shared normalizers); M4 adds the placeholder rule and the
 * provider scope. Names / company names are NEVER identifiers.
 */
export function identifiersFromHints(
  hints: ContactHints | null,
  provider: { sourceKey: string; accountRef: string | null }
): Identifier[] {
  if (!hints) return [];
  const out: Identifier[] = [];
  if (hints.phone) out.push({ kind: "phone", scope: "", value: hints.phone });
  if (hints.email && !isPlaceholderEmail(hints.email)) out.push({ kind: "email", scope: "", value: hints.email });
  if (hints.providerUserId) {
    const scope = providerScope(provider.sourceKey, provider.accountRef);
    if (scope) out.push({ kind: "provider", scope, value: hints.providerUserId });
  }
  return out;
}
