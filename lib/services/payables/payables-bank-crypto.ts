/**
 * Bank coordinates at rest — Accounts Payable Phase 3.
 *
 * An Israeli bank account is a 2-digit bank, a 3-digit branch and an account
 * number. That is small, structured input, which decides everything below.
 *
 * # Two keys, two jobs
 *
 *   PAYABLES_BANK_ENCRYPTION_KEY    AES-256-GCM. Recoverable: the owner has to be
 *                                   able to see their own account again, and a
 *                                   later phase has to be able to prepare a
 *                                   payment from it.
 *   PAYABLES_BANK_FINGERPRINT_KEY   HMAC-SHA-256. One-way, for "is this the same
 *                                   account I already have?".
 *
 * They are separate so that neither secret, leaked alone, gives the other's
 * capability — and neither is shared with any other domain (payments
 * credentials, inbound email, Gmail, MFA). A rotation of one feature's key must
 * never silently re-key another's.
 *
 * # Why the fingerprint is KEYED
 *
 * A plain SHA-256 over bank+branch+account is not a fingerprint, it is the
 * account numbers: the input space is small enough to enumerate on a laptop. A
 * keyed HMAC is inert without a secret that lives outside the database.
 *
 * Its input begins with the purpose and the businessId, so the same account in
 * two businesses produces two unrelated values. "Who else banks here" is not a
 * question this column can answer, and uniqueness over it is per-tenant by
 * construction (the Production proof also showed the index is per-tenant even
 * for byte-identical values).
 *
 * # What the ciphertext is bound to (AAD)
 *
 *   payables-bank:v1:<purpose>:<businessId>:<fingerprint>
 *
 *   purpose      a BUSINESS_BANK_ACCOUNT ciphertext does not decrypt as a
 *                PAYMENT_DESTINATION, or the reverse
 *   businessId   a row lifted into another tenant fails authentication instead
 *                of yielding someone else's account
 *   fingerprint  binds the ciphertext to the identity it was stored under, so
 *                two rows of the same tenant cannot swap ciphertexts unnoticed
 *
 * # Canonical form — and why leading zeros survive
 *
 * Coordinates are digit STRINGS, never numbers. `012` and `12` are different
 * branches as far as a bank is concerned, and a `Number()` anywhere on this path
 * would silently merge them. Separators people naturally type (space, dash, dot,
 * slash) are removed; anything else that is not a digit is refused rather than
 * stripped, because guessing what a stray letter meant is inventing a number.
 *
 * # Failure posture — fail closed, in both directions
 *
 *   encrypt / fingerprint   THROW on a missing or malformed key. Storing a row we
 *                           cannot read back, or a fingerprint computed under no
 *                           key, is silent data loss.
 *   decrypt                 returns null on ANY failure — wrong key, wrong tenant,
 *                           wrong purpose, tampered tag, malformed material. There
 *                           is no plaintext fallback anywhere in this module.
 *
 * No error message in this module contains coordinate material. A configuration
 * error is about a key, and echoing the account into it would put plaintext into
 * every log that catches it.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm" as const;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MIN_HMAC_KEY_BYTES = 32;

const ENCRYPTION_ENV = "PAYABLES_BANK_ENCRYPTION_KEY";
const FINGERPRINT_ENV = "PAYABLES_BANK_FINGERPRINT_KEY";

/** Persisted per row as `encryptionKeyId`, so a rotation can roll forward row by row. */
export const PAYABLES_BANK_ENCRYPTION_KEY_ID = "payables-bank-v1";

/**
 * What an encrypted coordinate set is FOR. Part of both the AAD and the
 * fingerprint input, so the two purposes are cryptographically disjoint.
 */
export type BankCoordinatePurpose = "BUSINESS_BANK_ACCOUNT" | "PAYMENT_DESTINATION";

export type BankCoordinates = {
  bankCode: string;
  branchCode: string;
  accountNumber: string;
};

export type EncryptedBankCoordinates = {
  coordinatesEncrypted: string;
  coordinatesIv: string;
  coordinatesTag: string;
  encryptionKeyId: string;
  accountLast4: string;
  fingerprint: string;
};

export class PayablesBankCryptoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayablesBankCryptoConfigError";
  }
}

/** Refused input. The message names the FIELD, never its value. */
export class BankCoordinatesInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BankCoordinatesInvalidError";
  }
}

/* ─────────────────────────────── keys ─────────────────────────────── */

function decodeKey(envName: string): Buffer {
  const raw = process.env[envName];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new PayablesBankCryptoConfigError(
      `Missing ${envName}. Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64,}$/.test(trimmed) && trimmed.length % 2 === 0) {
    return Buffer.from(trimmed, "hex");
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    throw new PayablesBankCryptoConfigError(`${envName} is neither hex nor base64`);
  }
  return Buffer.from(trimmed, "base64");
}

function loadEncryptionKey(): Buffer {
  const key = decodeKey(ENCRYPTION_ENV);
  if (key.length !== KEY_BYTES) {
    throw new PayablesBankCryptoConfigError(
      `${ENCRYPTION_ENV} must decode to exactly ${KEY_BYTES} bytes (got ${key.length})`,
    );
  }
  return key;
}

function loadFingerprintKey(): Buffer {
  const key = decodeKey(FINGERPRINT_ENV);
  if (key.length < MIN_HMAC_KEY_BYTES) {
    throw new PayablesBankCryptoConfigError(
      `${FINGERPRINT_ENV} must decode to at least ${MIN_HMAC_KEY_BYTES} bytes (got ${key.length})`,
    );
  }
  return key;
}

/**
 * True when BOTH keys are present and well-formed. Lets a screen say "bank
 * accounts are not configured yet" instead of failing on the first submit. It
 * is a convenience only — every write path still loads and checks the keys.
 */
export function isBankCryptoConfigured(): boolean {
  try {
    loadEncryptionKey();
    loadFingerprintKey();
    return true;
  } catch {
    return false;
  }
}

/* ─────────────────────────── canonical form ─────────────────────────── */

const SEPARATORS = /[\s\-./]/g;

function canonicalDigits(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string") {
    // A number has already lost its leading zeros; refusing it is the only way
    // to make sure nobody hands us one.
    throw new BankCoordinatesInvalidError(`${field} must be given as text`);
  }
  const stripped = value.replace(SEPARATORS, "");
  if (!/^[0-9]+$/.test(stripped)) {
    throw new BankCoordinatesInvalidError(`${field} must contain digits only`);
  }
  if (stripped.length < min || stripped.length > max) {
    throw new BankCoordinatesInvalidError(
      min === max
        ? `${field} must be exactly ${min} digits`
        : `${field} must be ${min}–${max} digits`,
    );
  }
  return stripped;
}

/**
 * The one canonical form every other function here uses. Lengths are fixed for
 * bank (2) and branch (3) — padding "9" to "09" would be guessing — and the
 * account number is 4–13 digits, enough for every Israeli bank's format while
 * guaranteeing four digits exist to show.
 */
export function canonicalizeBankCoordinates(input: {
  bankCode: unknown;
  branchCode: unknown;
  accountNumber: unknown;
}): BankCoordinates {
  return {
    bankCode: canonicalDigits(input.bankCode, "bankCode", 2, 2),
    branchCode: canonicalDigits(input.branchCode, "branchCode", 3, 3),
    accountNumber: canonicalDigits(input.accountNumber, "accountNumber", 4, 13),
  };
}

/** The only part of an account that is ever shown or returned. */
export function accountLast4(coords: BankCoordinates): string {
  return coords.accountNumber.slice(-4);
}

/** `••••1234` — the display form. Built from last4 alone, so it cannot leak more. */
export function maskAccount(last4: string): string {
  return `••••${last4}`;
}

/* ───────────────────────────── fingerprint ───────────────────────────── */

function assertTenant(businessId: number): void {
  if (!Number.isInteger(businessId) || businessId <= 0) {
    throw new BankCoordinatesInvalidError("businessId must be a positive integer");
  }
}

/**
 * Keyed, tenant-bound, purpose-bound identity of one account. Deterministic for
 * a given key, so the same account entered twice collides; different under a
 * different key, tenant or purpose.
 */
export function fingerprintBankCoordinates(
  coords: BankCoordinates,
  businessId: number,
  purpose: BankCoordinatePurpose,
): string {
  assertTenant(businessId);
  const canonical = canonicalizeBankCoordinates(coords);
  const key = loadFingerprintKey();
  // Newline-separated with fixed field order. The fields are digit-only, so a
  // newline cannot occur inside one and two different tuples cannot serialise
  // to the same input.
  const input = [
    "payables-bank-fp:v1",
    purpose,
    String(businessId),
    canonical.bankCode,
    canonical.branchCode,
    canonical.accountNumber,
  ].join("\n");
  return createHmac("sha256", key).update(input, "utf8").digest("hex");
}

/* ───────────────────────────── encryption ───────────────────────────── */

function coordinatesAad(
  businessId: number,
  purpose: BankCoordinatePurpose,
  fingerprint: string,
): Buffer {
  return Buffer.from(`payables-bank:v1:${purpose}:${businessId}:${fingerprint}`, "utf8");
}

/**
 * Canonicalise, fingerprint and encrypt in one step, returning exactly the
 * columns a row stores. Throws on a missing or malformed key, or invalid input.
 */
export function sealBankCoordinates(
  input: { bankCode: unknown; branchCode: unknown; accountNumber: unknown },
  businessId: number,
  purpose: BankCoordinatePurpose,
): EncryptedBankCoordinates {
  assertTenant(businessId);
  const coords = canonicalizeBankCoordinates(input);
  const fingerprint = fingerprintBankCoordinates(coords, businessId, purpose);

  const key = loadEncryptionKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(coordinatesAad(businessId, purpose, fingerprint));

  const plaintext = JSON.stringify({
    v: 1,
    b: coords.bankCode,
    br: coords.branchCode,
    a: coords.accountNumber,
  });
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (tag.length !== TAG_BYTES) {
    throw new Error(`Unexpected GCM tag length: ${tag.length}`);
  }

  return {
    coordinatesEncrypted: ciphertext.toString("base64"),
    coordinatesIv: iv.toString("base64"),
    coordinatesTag: tag.toString("base64"),
    encryptionKeyId: PAYABLES_BANK_ENCRYPTION_KEY_ID,
    accountLast4: accountLast4(coords),
    fingerprint,
  };
}

/**
 * Recover the coordinates of a stored row, or null. Null on ANY failure: the
 * caller must treat it as "cannot be shown", never as "show something else".
 *
 * The underlying error is swallowed on purpose. "Wrong key" and "tampered tag"
 * are not distinctions a caller can act on, and surfacing them would describe
 * the material to whoever reads the log.
 */
export function openBankCoordinates(
  stored: {
    coordinatesEncrypted: string | null;
    coordinatesIv: string | null;
    coordinatesTag: string | null;
    encryptionKeyId: string | null;
    fingerprint: string | null;
  },
  businessId: number,
  purpose: BankCoordinatePurpose,
): BankCoordinates | null {
  if (
    !stored ||
    typeof stored.coordinatesEncrypted !== "string" ||
    typeof stored.coordinatesIv !== "string" ||
    typeof stored.coordinatesTag !== "string" ||
    typeof stored.fingerprint !== "string" ||
    stored.encryptionKeyId !== PAYABLES_BANK_ENCRYPTION_KEY_ID ||
    !Number.isInteger(businessId) ||
    businessId <= 0
  ) {
    return null;
  }

  let key: Buffer;
  try {
    key = loadEncryptionKey();
  } catch {
    return null;
  }

  try {
    const iv = Buffer.from(stored.coordinatesIv, "base64");
    const tag = Buffer.from(stored.coordinatesTag, "base64");
    const ciphertext = Buffer.from(stored.coordinatesEncrypted, "base64");
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(coordinatesAad(businessId, purpose, stored.fingerprint));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      "utf8",
    );

    const parsed = JSON.parse(plaintext) as { v?: unknown; b?: unknown; br?: unknown; a?: unknown };
    if (parsed.v !== 1) return null;
    return canonicalizeBankCoordinates({
      bankCode: parsed.b,
      branchCode: parsed.br,
      accountNumber: parsed.a,
    });
  } catch {
    return null;
  }
}
