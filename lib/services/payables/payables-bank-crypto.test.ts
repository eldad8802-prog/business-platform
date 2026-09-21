/**
 * Payables Phase 3 — bank coordinate crypto. Run:
 *   npx tsx lib/services/payables/payables-bank-crypto.test.ts
 *
 * Pure: no database, synthetic keys generated per run. Each property here is a
 * frozen contract from the Phase 3 handover, not an implementation detail.
 */
import { createHash, randomBytes } from "node:crypto";

const ENC = "PAYABLES_BANK_ENCRYPTION_KEY";
const FP = "PAYABLES_BANK_FINGERPRINT_KEY";
const encKeyA = randomBytes(32).toString("base64");
const encKeyB = randomBytes(32).toString("base64");
const fpKeyA = randomBytes(32).toString("base64");
const fpKeyB = randomBytes(32).toString("hex");
process.env[ENC] = encKeyA;
process.env[FP] = fpKeyA;

import {
  BankCoordinatesInvalidError,
  PAYABLES_BANK_ENCRYPTION_KEY_ID,
  PayablesBankCryptoConfigError,
  canonicalizeBankCoordinates,
  fingerprintBankCoordinates,
  isBankCryptoConfigured,
  maskAccount,
  openBankCoordinates,
  sealBankCoordinates,
} from "./payables-bank-crypto";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, extra = ""): void {
  total += 1;
  if (!cond) failures += 1;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
}
function throws(name: string, fn: () => unknown, klass?: new (...a: never[]) => Error): void {
  total += 1;
  try {
    fn();
    failures += 1;
    console.log(`  [FAIL] ${name} — expected a throw, none happened`);
  } catch (err) {
    const ok = !klass || err instanceof klass;
    if (!ok) failures += 1;
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${ok ? "" : ` — wrong error: ${String(err)}`}`);
  }
}
function withEnv(patch: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(patch)) {
    saved[k] = process.env[k];
    if (patch[k] === undefined) delete process.env[k];
    else process.env[k] = patch[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const ACCOUNT = { bankCode: "12", branchCode: "034", accountNumber: "0012345678" };
const BIZ = 101;
const OTHER_BIZ = 202;

/* ── A. round trip and stored shape ─────────────────────────────────────── */
console.log("\n[A] round trip and stored shape");
{
  const sealed = sealBankCoordinates(ACCOUNT, BIZ, "BUSINESS_BANK_ACCOUNT");
  const opened = openBankCoordinates(sealed, BIZ, "BUSINESS_BANK_ACCOUNT");
  check("seal → open returns the same coordinates", JSON.stringify(opened) === JSON.stringify(ACCOUNT));
  check("encryptionKeyId is recorded for rotation", sealed.encryptionKeyId === PAYABLES_BANK_ENCRYPTION_KEY_ID);
  check("last4 is the last four account digits", sealed.accountLast4 === "5678");
  check("fingerprint is a 64-hex HMAC", /^[0-9a-f]{64}$/.test(sealed.fingerprint));

  const stored = JSON.stringify(sealed);
  check("no stored column contains the account number", !stored.includes("0012345678") && !stored.includes("12345678"));
  // Short fragments like "034" would appear by chance in 64 hex digits, so the
  // shape is asserted instead: exactly these columns, and nothing else.
  check(
    "the stored shape is exactly ciphertext/iv/tag/keyId/last4/fingerprint",
    JSON.stringify(Object.keys(sealed).sort()) ===
      JSON.stringify(["accountLast4", "coordinatesEncrypted", "coordinatesIv", "coordinatesTag", "encryptionKeyId", "fingerprint"]),
  );
  check("no stored column contains bank+branch+account", !stored.includes("120340012345678"));

  const again = sealBankCoordinates(ACCOUNT, BIZ, "BUSINESS_BANK_ACCOUNT");
  check("a fresh IV each time: ciphertexts differ", again.coordinatesEncrypted !== sealed.coordinatesEncrypted);
  check("…while the fingerprint is deterministic", again.fingerprint === sealed.fingerprint);
  check("mask shows only last4", maskAccount(sealed.accountLast4) === "••••5678");
}

/* ── B. AAD binding: tenant, purpose, row identity, tamper ─────────────── */
console.log("\n[B] what the ciphertext is bound to");
{
  const sealed = sealBankCoordinates(ACCOUNT, BIZ, "BUSINESS_BANK_ACCOUNT");
  check("wrong tenant does NOT decrypt", openBankCoordinates(sealed, OTHER_BIZ, "BUSINESS_BANK_ACCOUNT") === null);
  check("wrong purpose does NOT decrypt", openBankCoordinates(sealed, BIZ, "PAYMENT_DESTINATION") === null);

  const otherRow = sealBankCoordinates({ ...ACCOUNT, accountNumber: "99887766" }, BIZ, "BUSINESS_BANK_ACCOUNT");
  check(
    "a ciphertext moved onto another row's fingerprint does NOT decrypt",
    openBankCoordinates({ ...sealed, fingerprint: otherRow.fingerprint }, BIZ, "BUSINESS_BANK_ACCOUNT") === null,
  );

  const tag = Buffer.from(sealed.coordinatesTag, "base64");
  tag[0] ^= 0x01;
  check(
    "a tampered auth tag is rejected",
    openBankCoordinates({ ...sealed, coordinatesTag: tag.toString("base64") }, BIZ, "BUSINESS_BANK_ACCOUNT") === null,
  );
  const ct = Buffer.from(sealed.coordinatesEncrypted, "base64");
  ct[0] ^= 0x01;
  check(
    "a tampered ciphertext is rejected",
    openBankCoordinates({ ...sealed, coordinatesEncrypted: ct.toString("base64") }, BIZ, "BUSINESS_BANK_ACCOUNT") === null,
  );
  check(
    "an unknown encryptionKeyId is not decrypted under the current key",
    openBankCoordinates({ ...sealed, encryptionKeyId: "payables-bank-v0" }, BIZ, "BUSINESS_BANK_ACCOUNT") === null,
  );
  withEnv({ [ENC]: encKeyB }, () => {
    check("a different encryption key does NOT decrypt", openBankCoordinates(sealed, BIZ, "BUSINESS_BANK_ACCOUNT") === null);
  });
}

/* ── C. fail closed on keys ───────────────────────────────────────────── */
console.log("\n[C] missing or malformed keys fail closed");
{
  const sealed = sealBankCoordinates(ACCOUNT, BIZ, "BUSINESS_BANK_ACCOUNT");
  withEnv({ [ENC]: undefined }, () => {
    throws("missing encryption key: seal THROWS", () => sealBankCoordinates(ACCOUNT, BIZ, "BUSINESS_BANK_ACCOUNT"), PayablesBankCryptoConfigError);
    check("missing encryption key: open returns null, no fallback", openBankCoordinates(sealed, BIZ, "BUSINESS_BANK_ACCOUNT") === null);
    check("isBankCryptoConfigured() is false", isBankCryptoConfigured() === false);
  });
  withEnv({ [FP]: undefined }, () => {
    throws("missing fingerprint key: fingerprint THROWS", () => fingerprintBankCoordinates(ACCOUNT, BIZ, "BUSINESS_BANK_ACCOUNT"), PayablesBankCryptoConfigError);
    throws("missing fingerprint key: seal THROWS", () => sealBankCoordinates(ACCOUNT, BIZ, "BUSINESS_BANK_ACCOUNT"), PayablesBankCryptoConfigError);
  });
  withEnv({ [ENC]: randomBytes(16).toString("base64") }, () => {
    throws("a 16-byte encryption key is refused", () => sealBankCoordinates(ACCOUNT, BIZ, "BUSINESS_BANK_ACCOUNT"), PayablesBankCryptoConfigError);
  });
  withEnv({ [FP]: randomBytes(8).toString("base64") }, () => {
    throws("a short HMAC key is refused", () => fingerprintBankCoordinates(ACCOUNT, BIZ, "BUSINESS_BANK_ACCOUNT"), PayablesBankCryptoConfigError);
  });
  withEnv({ [ENC]: "not a key!!" }, () => {
    throws("a garbage key is refused", () => sealBankCoordinates(ACCOUNT, BIZ, "BUSINESS_BANK_ACCOUNT"), PayablesBankCryptoConfigError);
  });
  check("isBankCryptoConfigured() is true with both keys", isBankCryptoConfigured() === true);

  let leaked = false;
  withEnv({ [ENC]: undefined }, () => {
    try {
      sealBankCoordinates(ACCOUNT, BIZ, "BUSINESS_BANK_ACCOUNT");
    } catch (err) {
      leaked = String(err).includes("0012345678") || String(err).includes("034");
    }
  });
  check("the config error message carries no coordinate material", !leaked);
}

/* ── D. fingerprint: keyed, tenant-bound, purpose-bound ──────────────── */
console.log("\n[D] fingerprint");
{
  const a = fingerprintBankCoordinates(ACCOUNT, BIZ, "BUSINESS_BANK_ACCOUNT");
  check("same account, other tenant → different fingerprint", a !== fingerprintBankCoordinates(ACCOUNT, OTHER_BIZ, "BUSINESS_BANK_ACCOUNT"));
  check("same account, other purpose → different fingerprint", a !== fingerprintBankCoordinates(ACCOUNT, BIZ, "PAYMENT_DESTINATION"));
  withEnv({ [FP]: fpKeyB }, () => {
    check("changing the HMAC key changes the fingerprint", a !== fingerprintBankCoordinates(ACCOUNT, BIZ, "BUSINESS_BANK_ACCOUNT"));
  });
  const unkeyed = createHash("sha256").update("12034" + "0012345678").digest("hex");
  check("it is not an unkeyed SHA-256 of the coordinates", a !== unkeyed);
  check(
    "separators do not change identity (12-034-0012345678)",
    a === fingerprintBankCoordinates({ bankCode: "12", branchCode: "034", accountNumber: "00-1234 5678" }, BIZ, "BUSINESS_BANK_ACCOUNT"),
  );
}

/* ── E. canonical form: leading zeros survive, nothing is guessed ─────── */
console.log("\n[E] canonical form");
{
  const withZero = fingerprintBankCoordinates({ ...ACCOUNT, accountNumber: "0012345678" }, BIZ, "BUSINESS_BANK_ACCOUNT");
  const withoutZero = fingerprintBankCoordinates({ ...ACCOUNT, accountNumber: "12345678" }, BIZ, "BUSINESS_BANK_ACCOUNT");
  check("leading zeros are preserved: 0012345678 ≠ 12345678", withZero !== withoutZero);
  check("branch 034 stays 034", canonicalizeBankCoordinates(ACCOUNT).branchCode === "034");
  throws("a numeric account (zeros already lost) is refused", () =>
    canonicalizeBankCoordinates({ ...ACCOUNT, accountNumber: 12345678 as unknown as string }), BankCoordinatesInvalidError);
  throws("bank code '9' is refused, not padded", () => canonicalizeBankCoordinates({ ...ACCOUNT, bankCode: "9" }), BankCoordinatesInvalidError);
  throws("branch '34' is refused, not padded", () => canonicalizeBankCoordinates({ ...ACCOUNT, branchCode: "34" }), BankCoordinatesInvalidError);
  throws("a letter in the account is refused, not stripped", () => canonicalizeBankCoordinates({ ...ACCOUNT, accountNumber: "12345A78" }), BankCoordinatesInvalidError);
  throws("a 3-digit account is refused (no last4 to show)", () => canonicalizeBankCoordinates({ ...ACCOUNT, accountNumber: "123" }), BankCoordinatesInvalidError);
  throws("a 14-digit account is refused", () => canonicalizeBankCoordinates({ ...ACCOUNT, accountNumber: "12345678901234" }), BankCoordinatesInvalidError);

  let leaked = false;
  try {
    canonicalizeBankCoordinates({ ...ACCOUNT, accountNumber: "99887766X" });
  } catch (err) {
    leaked = String(err).includes("99887766");
  }
  check("a validation error names the field, never the value", !leaked);
  throws("businessId 0 is refused", () => sealBankCoordinates(ACCOUNT, 0, "BUSINESS_BANK_ACCOUNT"), BankCoordinatesInvalidError);
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${total - failures}/${total} checks passed\n`);
if (failures > 0) process.exit(1);
