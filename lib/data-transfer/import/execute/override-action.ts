/**
 * The identity of ONE deliberate override, and the rule that keeps it honest.
 *
 * # Why this exists
 *
 * F-01 narrowed the retry identity of an import to (business, file bytes,
 * mapping) — the three things a retry cannot change. That is correct for an
 * ordinary import and wrong for one case: the owner looking at a duplicate and
 * saying "I know, add it ANYWAY". There the file, the mapping and even the set
 * of rows are identical, and the owner still means a NEW record. Narrowing the
 * key swallowed that, and a ratified behaviour quietly stopped working.
 *
 * The decisions cannot come back into the key to fix it. Ordinary CREATE/SKIP
 * decisions are DERIVED FROM THE DATABASE the import itself changes, which is
 * precisely the defect F-01 named.
 *
 * So the owner's ACTION gets an identity of its own, separate from the file's.
 *
 *   importIdentity   businessId + contentHash + mappingHash
 *   actionIdentity   + the id of one deliberate override action
 *
 * A retry of that action carries the same id and resolves to the same run. A
 * later, separate decision to override again carries a new id and is allowed
 * to add another record.
 *
 * # Why a client-supplied id is not a licence
 *
 * The id says WHICH action. It never says the action was ALLOWED. A client
 * could otherwise attach an id to an ordinary import and turn every replay
 * into a fresh write, which is F-01 with extra steps.
 *
 * The rule, enforced server-side at PREVIEW time and attested in the signed
 * preview token:
 *
 *   an override action id counts for identity ONLY IF the submitted decisions
 *   contain at least one row the server itself judges a genuine override,
 *   under the duplicate policy it already enforces.
 *
 * No genuine override, no component — the identity stays the plain three-input
 * key and normal idempotency is untouched. The token is signed, so execute
 * reads the verdict from the server's own attestation rather than from the
 * request body, and a caller cannot assert its own eligibility.
 *
 * Eligibility itself is NOT loosened anywhere by any of this: a decision the
 * duplicate policy refuses is still refused, id or no id.
 *
 * # Why the token carries a HASH and not the id
 *
 * A signed envelope is signed, not encrypted, and anyone holding one can read
 * the payload. A client-supplied string must therefore never be written into
 * it verbatim. The hash is all identity needs.
 */

import { createHash } from "node:crypto";

/**
 * Accepted shape of a client-generated override action id.
 *
 * Deliberately narrow: a bounded, opaque token of URL-safe characters. It is
 * never parsed, compared to anything, or shown to anyone — only hashed — so
 * there is no reason to accept arbitrary text, and every reason not to.
 */
const OVERRIDE_ACTION_ID = /^[A-Za-z0-9_-]{16,128}$/;

export function isWellFormedOverrideActionId(value: unknown): value is string {
  return typeof value === "string" && OVERRIDE_ACTION_ID.test(value);
}

/** Hex sha256 of a well-formed id. Returns null for anything else. */
export function overrideActionHashOf(value: unknown): string | null {
  if (!isWellFormedOverrideActionId(value)) return null;
  return createHash("sha256")
    .update(`import-override-action:v1\n${value}`)
    .digest("hex");
}

/**
 * The attested override component, or null.
 *
 * `hasGenuineOverride` is the server's own verdict, never the caller's claim.
 * Both halves must hold: a well-formed id AND a real override to attach it to.
 */
export function attestedOverrideActionHash(input: {
  overrideActionId: unknown;
  hasGenuineOverride: boolean;
}): string | null {
  if (!input.hasGenuineOverride) return null;
  return overrideActionHashOf(input.overrideActionId);
}
