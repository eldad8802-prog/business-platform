/**
 * AES-256-GCM encryption for the inbound address local part at rest.
 *
 * # Why the address is encrypted rather than only hashed
 *
 * Routing needs a hash: a message arrives, we look the address up, we learn the
 * tenant. Hashing alone would be enough for that, and the first cut of this
 * model stored nothing else. But an owner also has to READ their address back —
 * to set up forwarding on a second mailbox, to re-check it after a typo, to
 * hand it to their bookkeeper. With only a hash, "show me my address again" has
 * no answer except "rotate and reconfigure everything", which turns an ordinary
 * question into an outage of the owner's own making.
 *
 * So both: `tokenHash` routes, and the ciphertext here is what lets us show the
 * owner what they already own. The two are independent — the hash is not
 * derivable from the ciphertext without the key, and the ciphertext is not
 * derivable from the hash at all.
 *
 * # This is not a credential store
 *
 * The address authenticates nobody. Encrypting it is defence in depth against
 * database exfiltration, not the security boundary. The boundary is that an
 * inbound message can only ever reach one tenant's review queue and can never
 * become an approved FinancialRecord without a human. Losing every address in
 * this table to an attacker would permit attempted injection and nothing else.
 *
 * # Key separation, stated because it is the point
 *
 *   - NOT `GMAIL_TOKEN_ENCRYPTION_KEY` — that belongs to the frozen Gmail
 *     integration and protects Google user data under a restricted OAuth scope.
 *     Sharing it would couple two unrelated features' blast radius, and would
 *     mean a rotation for one silently re-keyed the other. It is also, by its
 *     own module's admission, a base64 placeholder rather than real crypto.
 *   - NOT `AUTH_TOKEN_SECRET` — that signs transient session envelopes and is
 *     rotated deliberately to invalidate sessions. Rotating it must never make
 *     an owner's inbound address unreadable.
 *   - NOT `PAYMENTS_ENCRYPTION_KEY`, `ADMIN_MFA_ENCRYPTION_KEY` or
 *     `WHATSAPP_TOKEN_ENCRYPTION_KEY` — same reasoning, different domains.
 *   - `INBOUND_EMAIL_ENCRYPTION_KEY` — this material only.
 *
 * # Storage shape
 *
 * The three-column form the rest of this codebase already uses, so operational
 * tooling and key-rotation reasoning stay uniform:
 *
 *   localPartEncrypted = base64(ciphertext)
 *   localPartIv        = base64(12-byte random nonce)
 *   localPartTag       = base64(16-byte GCM auth tag)
 *   encryptionKeyId    = key version label, so a future key can roll forward
 *                        per row without a format change
 *
 * # Additional authenticated data
 *
 * The AAD binds the ciphertext to `businessId:tokenHash` — the exact row it
 * belongs to. Moving a ciphertext to another business's row, or to another
 * address row in the same business, makes it fail authentication rather than
 * decrypt into someone else's address.
 *
 * # Failure posture
 *
 * Encrypt THROWS on a missing or malformed key: minting an address we cannot
 * later read back would be a silent data-loss bug. Decrypt returns `null` on
 * any failure — wrong key, tampering, wrong AAD, malformed input — and never
 * falls back to anything. Both directions fail closed.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm" as const;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

const ENV_KEY_NAME = "INBOUND_EMAIL_ENCRYPTION_KEY";

/** Key version label persisted per row, for rotation without a format change. */
export const INBOUND_EMAIL_ENCRYPTION_KEY_ID = "inbound-email-v1";

export type EncryptedLocalPart = {
  localPartEncrypted: string;
  localPartIv: string;
  localPartTag: string;
  encryptionKeyId: string;
};

export class InboundAddressCryptoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboundAddressCryptoConfigError";
  }
}

function loadEncryptionKey(): Buffer {
  const raw = process.env[ENV_KEY_NAME];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new InboundAddressCryptoConfigError(
      `Missing ${ENV_KEY_NAME}. Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
    );
  }

  const trimmed = raw.trim();
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    key = Buffer.from(trimmed, "hex");
  } else {
    try {
      key = Buffer.from(trimmed, "base64");
    } catch {
      throw new InboundAddressCryptoConfigError(`${ENV_KEY_NAME} is not valid base64`);
    }
  }

  if (key.length !== KEY_BYTES) {
    throw new InboundAddressCryptoConfigError(
      `${ENV_KEY_NAME} must decode to exactly ${KEY_BYTES} bytes (got ${key.length})`
    );
  }

  return key;
}

/** Binds a ciphertext to the exact row it belongs to. */
function localPartAad(businessId: number, tokenHash: string): Buffer {
  return Buffer.from(`${businessId}:${tokenHash}`, "utf8");
}

/**
 * Encrypt a local part for storage.
 *
 * Throws on a missing or malformed key. A caller must treat that as a hard
 * failure and refuse to create the address: a row whose ciphertext was written
 * under no key, or a wrong one, is an address the owner can never read back.
 *
 * Note what is NOT in any error message here: the plaintext. A configuration
 * error is about the key, and including the address in it would put plaintext
 * into every log that catches it.
 */
export function encryptInboundLocalPart(
  localPart: string,
  businessId: number,
  tokenHash: string
): EncryptedLocalPart {
  if (typeof localPart !== "string" || localPart.length === 0) {
    throw new Error("encryptInboundLocalPart: localPart must be non-empty");
  }
  if (!Number.isInteger(businessId) || businessId <= 0) {
    throw new Error("encryptInboundLocalPart: businessId must be positive");
  }
  if (typeof tokenHash !== "string" || tokenHash.length === 0) {
    throw new Error("encryptInboundLocalPart: tokenHash must be non-empty");
  }

  const key = loadEncryptionKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(localPartAad(businessId, tokenHash));

  const ciphertext = Buffer.concat([
    cipher.update(localPart, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  if (tag.length !== TAG_BYTES) {
    throw new Error(`Unexpected GCM tag length: ${tag.length}`);
  }

  return {
    localPartEncrypted: ciphertext.toString("base64"),
    localPartIv: iv.toString("base64"),
    localPartTag: tag.toString("base64"),
    encryptionKeyId: INBOUND_EMAIL_ENCRYPTION_KEY_ID,
  };
}

/**
 * Decrypt a stored local part.
 *
 * Returns `null` on ANY failure: missing key, wrong key, tampered ciphertext,
 * wrong AAD, malformed base64, missing columns. Callers must treat `null` as
 * "this address cannot be shown" and never as "show something else".
 *
 * Deliberately swallows the underlying error rather than rethrowing it. The
 * distinction between "wrong key" and "tampered tag" is not something a caller
 * can act on differently, and surfacing it would leak the shape of the
 * material to whoever reads the log.
 */
export function decryptInboundLocalPart(
  stored: {
    localPartEncrypted: string | null;
    localPartIv: string | null;
    localPartTag: string | null;
  },
  businessId: number,
  tokenHash: string
): string | null {
  if (
    !stored ||
    typeof stored.localPartEncrypted !== "string" ||
    typeof stored.localPartIv !== "string" ||
    typeof stored.localPartTag !== "string" ||
    typeof tokenHash !== "string" ||
    tokenHash.length === 0 ||
    !Number.isInteger(businessId) ||
    businessId <= 0
  ) {
    return null;
  }

  try {
    const key = loadEncryptionKey();
    const iv = Buffer.from(stored.localPartIv, "base64");
    const tag = Buffer.from(stored.localPartTag, "base64");
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(localPartAad(businessId, tokenHash));
    decipher.setAuthTag(tag);

    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(stored.localPartEncrypted, "base64")),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  } catch {
    return null;
  }
}

/**
 * The only form of an inbound address that may appear in a log.
 *
 * Every logging call site should pass through here rather than deciding for
 * itself how much to show. Identifying an address in a support conversation
 * needs a handful of characters; nothing operational needs the rest.
 */
export function redactInboundAddress(value: string | null | undefined): string {
  const raw = String(value ?? "").trim();
  if (raw.length === 0) return "(none)";
  const at = raw.indexOf("@");
  const local = at === -1 ? raw : raw.slice(0, at);
  const domain = at === -1 ? "" : raw.slice(at);
  return `${local.slice(0, 6)}…${domain}`;
}
