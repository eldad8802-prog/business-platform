/**
 * Run: npx tsx lib/services/payments/payment-crypto.test.ts
 *
 * No DB, no network. Verifies the credential crypto round-trips and fails
 * closed on wrong AAD / tampering / missing key.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

process.env.PAYMENTS_ENCRYPTION_KEY = randomBytes(32).toString("base64");

import {
  encryptPaymentCredential,
  decryptPaymentCredential,
  PAYMENTS_ENCRYPTION_KEY_ID,
} from "./payment-crypto.service";

// --- round trip ---
const secret = "terminal-api-secret-12345";
const enc = encryptPaymentCredential(secret, 42, "TRANZILA");
assert.equal(enc.encryptionKeyId, PAYMENTS_ENCRYPTION_KEY_ID);
assert.ok(enc.credentialEncrypted.length > 0);
assert.ok(enc.credentialIv.length > 0);
assert.ok(enc.credentialTag.length > 0);
assert.notEqual(enc.credentialEncrypted, secret);

const decrypted = decryptPaymentCredential(enc, 42, "TRANZILA");
assert.equal(decrypted, secret);

// --- wrong businessId AAD => null ---
assert.equal(decryptPaymentCredential(enc, 99, "TRANZILA"), null);

// --- tampered ciphertext => null ---
const tampered = { ...enc, credentialEncrypted: Buffer.from("zzzz").toString("base64") };
assert.equal(decryptPaymentCredential(tampered, 42, "TRANZILA"), null);

// --- missing material => null ---
assert.equal(
  decryptPaymentCredential(
    { credentialEncrypted: null, credentialIv: null, credentialTag: null },
    42,
    "TRANZILA"
  ),
  null
);

// --- empty plaintext throws ---
assert.throws(() => encryptPaymentCredential("", 42, "TRANZILA"));

console.log("payment-crypto tests: OK");
