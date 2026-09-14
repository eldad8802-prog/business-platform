/**
 * Inbound address identity — minting, normalising and hashing.
 *
 * Pure module. No database, no network, no environment beyond the domain the
 * caller passes in. Everything here is deterministic except `mintInboundToken`,
 * which is the one place randomness enters.
 *
 * # What an inbound address is, and what it is not
 *
 * It is a ROUTING CAPABILITY: it decides which business a message belongs to.
 * It is NOT a credential, and nothing downstream may treat possession of it as
 * authentication. A leaked address lets a stranger put a document in front of
 * one business's review queue. It grants no read access, reaches no other
 * tenant, and cannot approve anything — a human still has to.
 *
 * Because the design assumes the address leaks eventually, the interesting
 * properties are not secrecy but revocability and blast radius. Both are
 * handled by the model, not by this file.
 *
 * # Why 160 bits and not 128
 *
 * The requirement is at least 128 bits. Base32 encodes 5 bits per character,
 * so 128 bits is 25.6 characters — not a whole number, which means either
 * padding or a partial character, and both invite off-by-one bugs in the
 * format check. 160 bits is exactly 32 characters with nothing left over. The
 * extra 32 bits are free; the clean boundary is the point.
 *
 * # Why Crockford's alphabet
 *
 * These strings get read aloud, retyped from a phone screen and pasted into a
 * Gmail settings box by people who are not thinking about encodings. Crockford
 * base32 omits `i`, `l`, `o` and `u`, which removes the 1/l/I and 0/O
 * confusions at the source. Lowercase throughout because email local parts are
 * compared case-insensitively in practice and mixed case would invite two
 * spellings of one address.
 */
import crypto from "node:crypto";

/** Bits of entropy in a minted token. Asserted by the verifier. */
export const INBOUND_TOKEN_ENTROPY_BITS = 160;

const TOKEN_BYTES = INBOUND_TOKEN_ENTROPY_BITS / 8; // 20

/**
 * Crockford base32, lowercase. Deliberately excludes i, l, o, u.
 */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/**
 * Fixed prefix on every local part.
 *
 * It makes an address recognisable as ours in a mail log at a glance, and it
 * guarantees the local part never begins with a digit — which some mail
 * tooling still handles badly. It carries no information and adds no entropy.
 */
export const INBOUND_LOCAL_PREFIX = "dz";

/** Number of base32 characters in the random part. 160 bits / 5 bits. */
export const INBOUND_TOKEN_CHARS = 32;

/** `dz` + 32 base32 characters, lowercase, anchored. */
export const INBOUND_LOCAL_PART_PATTERN = new RegExp(
  `^${INBOUND_LOCAL_PREFIX}[${ALPHABET}]{${INBOUND_TOKEN_CHARS}}$`
);

/** Encode exactly 20 bytes as 32 base32 characters. No padding, none needed. */
function encodeBase32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Mint a new local part. The ONLY source of randomness in this feature.
 *
 * `crypto.randomBytes` and not `Math.random`: the latter is not a CSPRNG, and
 * an address minted from it would be predictable from other addresses.
 */
export function mintInboundLocalPart(): string {
  return INBOUND_LOCAL_PREFIX + encodeBase32(crypto.randomBytes(TOKEN_BYTES));
}

/** Is this a syntactically valid local part we could have minted? */
export function isValidInboundLocalPart(localPart: string): boolean {
  return INBOUND_LOCAL_PART_PATTERN.test(localPart);
}

/**
 * Normalise a local part for lookup.
 *
 * Two transformations, each for a stated reason:
 *
 *   - lowercase and trim, because the same address will arrive spelled several
 *     ways and all of them mean one row;
 *   - drop anything from a `+` onward, because a forwarder or an intermediate
 *     may append a tag. The secret is the part before the `+`, so dropping the
 *     tag loses no security and gains resilience.
 *
 * Note what is NOT done: dots are NOT stripped. Dot-insensitivity is a Gmail
 * convention, not an email one, and applying it to our own domain would make
 * distinct tokens collide.
 */
export function normalizeInboundLocalPart(raw: string): string {
  const trimmed = String(raw ?? "").trim().toLowerCase();
  const plus = trimmed.indexOf("+");
  return plus === -1 ? trimmed : trimmed.slice(0, plus);
}

/**
 * The lookup key stored in `InboundEmailAddress.tokenHash`.
 *
 * SHA-256 of the NORMALISED local part, hex, lowercase. Storing the hash means
 * the plaintext address is never at rest in PostgreSQL, while routing still
 * works with a single indexed equality.
 *
 * No salt and no slow KDF, on purpose. A salt would make lookup impossible —
 * we have to find the row FROM the address, so the mapping must be
 * deterministic. A slow KDF would buy nothing against a 160-bit random
 * pre-image, which is not guessable at any work factor.
 */
export function inboundTokenHash(localPart: string): string {
  return crypto
    .createHash("sha256")
    .update(normalizeInboundLocalPart(localPart), "utf8")
    .digest("hex");
}

/**
 * A masked fragment safe to store and display, e.g. `dz7f2q…`.
 *
 * Exists so a list of several addresses is readable by a human. Short enough
 * to be useless on its own: the remaining characters still carry far more than
 * 128 bits.
 */
export function inboundLocalPartPreview(localPart: string): string {
  const normalized = normalizeInboundLocalPart(localPart);
  return normalized.slice(0, INBOUND_LOCAL_PREFIX.length + 4) + "…";
}

/** Compose the address the owner will paste into their mail settings. */
export function buildInboundAddress(localPart: string, domain: string): string {
  return `${normalizeInboundLocalPart(localPart)}@${String(domain).trim().toLowerCase()}`;
}

export type ParsedRecipient =
  | { ok: true; localPart: string; tokenHash: string }
  | { ok: false; reason: "malformed" | "foreign_domain" | "bad_local_part" };

/**
 * Parse an envelope recipient into something we can look up.
 *
 * # Read this before using a `To:` header here
 *
 * The recipient passed in MUST come from the SMTP envelope (`RCPT TO`), not
 * from `To:` or `Cc:`. In a forwarding flow the `To:` header almost always
 * names the ORIGINAL supplier recipient — the owner's own mailbox — and not
 * us. Parsing the header instead of the envelope would fail to resolve a
 * tenant on essentially every real message, and on the messages where it did
 * resolve one, it would be resolving an address the sender chose.
 */
export function parseInboundRecipient(
  recipient: string,
  expectedDomain: string
): ParsedRecipient {
  const raw = String(recipient ?? "").trim().toLowerCase();
  const at = raw.lastIndexOf("@");
  if (at <= 0 || at === raw.length - 1) return { ok: false, reason: "malformed" };

  const domain = raw.slice(at + 1);
  if (domain !== String(expectedDomain).trim().toLowerCase()) {
    return { ok: false, reason: "foreign_domain" };
  }

  const localPart = normalizeInboundLocalPart(raw.slice(0, at));
  if (!isValidInboundLocalPart(localPart)) {
    return { ok: false, reason: "bad_local_part" };
  }

  return { ok: true, localPart, tokenHash: inboundTokenHash(localPart) };
}
