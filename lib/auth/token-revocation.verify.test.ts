/**
 * Verify — token generations and revocation.
 * Run: npx tsx lib/auth/token-revocation.verify.test.ts
 *
 * Covers the envelope half of revocation: that a token carries the generation it
 * was minted under, that tokens predating the feature read as generation 0, and
 * that the generation is inside the signature so it cannot be edited. The other
 * half — comparing that generation against the user row — lives in
 * `getCurrentUser` (gate 3) and needs a database.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  signAuthToken,
  verifyAuthToken,
  verifyAuthTokenPayload,
} from "@/lib/auth-token";

// The module reads the secret lazily, inside each call, so setting it here —
// after the import is hoisted but before any assertion runs — is sufficient.
const SECRET = "verify-secret-not-a-real-key";
process.env.AUTH_TOKEN_SECRET = SECRET;

let checks = 0;
function ok(label: string, condition: boolean) {
  assert.ok(condition, label);
  checks += 1;
}
function eq<T>(label: string, actual: T, expected: T) {
  assert.deepEqual(actual, expected, `${label} (got ${String(actual)})`);
  checks += 1;
}

/** Mint a token by hand so we can put an arbitrary payload inside the signature. */
function forgePayload(payload: Record<string, unknown>): string {
  const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", SECRET)
    .update(`v1.${b64}`)
    .digest("base64url");
  return `v1.${b64}.${sig}`;
}

const nowSec = () => Math.floor(Date.now() / 1000);

function main() {
  /* ------------------------------------------- the generation round-trips -- */

  eq(
    "a token minted at generation 0 reports 0",
    verifyAuthTokenPayload(signAuthToken(1))?.tokenVersion,
    0
  );

  eq(
    "a token minted at generation 7 reports 7",
    verifyAuthTokenPayload(signAuthToken(1, 7))?.tokenVersion,
    7
  );

  eq(
    "the user id still round-trips",
    verifyAuthTokenPayload(signAuthToken(42, 3))?.userId,
    42
  );

  /* ------------------------------------------------- backwards compatible -- */

  // The exact shape minted before revocation existed: no `tv` at all. These
  // tokens are live in real browsers right now, and deploying must not sign
  // those people out — so they must read as generation 0, which is what every
  // untouched user row holds.
  const legacy = forgePayload({ sub: 5, iat: nowSec(), exp: nowSec() + 3600 });
  eq(
    "a pre-revocation token is still authentic",
    verifyAuthTokenPayload(legacy)?.userId,
    5
  );
  eq(
    "a pre-revocation token reads as generation 0",
    verifyAuthTokenPayload(legacy)?.tokenVersion,
    0
  );

  /* ------------------------------------ a junk generation fails toward 0 --- */

  for (const junk of [null, "3", 1.5, Number.NaN, {}, []] as const) {
    const weird = forgePayload({
      sub: 6,
      iat: nowSec(),
      exp: nowSec() + 3600,
      tv: junk,
    });
    eq(
      `tv=${JSON.stringify(junk)} reads as generation 0`,
      verifyAuthTokenPayload(weird)?.tokenVersion,
      0
    );
  }

  /* ---------------------------------- the generation is signed, not loose -- */

  // Rewriting `tv` without re-signing must not verify. If it did, anyone holding
  // a revoked token could simply increment their way back in.
  const real = signAuthToken(9, 2);
  const [, payloadB64] = real.split(".");
  const decoded = JSON.parse(
    Buffer.from(payloadB64, "base64url").toString("utf8")
  );
  decoded.tv = 99;
  const tamperedB64 = Buffer.from(JSON.stringify(decoded), "utf8").toString(
    "base64url"
  );
  const tampered = `v1.${tamperedB64}.${real.split(".")[2]}`;

  ok(
    "editing the generation breaks the signature",
    verifyAuthTokenPayload(tampered) === null
  );
  ok("the untampered token still verifies", verifyAuthTokenPayload(real) !== null);

  /* --------------------------------------------- signing input validation -- */

  assert.throws(
    () => signAuthToken(1, -1),
    /non-negative/,
    "a negative generation is rejected"
  );
  checks += 1;
  assert.throws(
    () => signAuthToken(1, 1.5),
    /non-negative integer/,
    "a fractional generation is rejected"
  );
  checks += 1;

  /* ---------------------------------------- the legacy helper still works -- */

  eq(
    "verifyAuthToken still returns the user id",
    verifyAuthToken(signAuthToken(11, 4)),
    11
  );
  eq("verifyAuthToken rejects junk", verifyAuthToken("nonsense"), null);

  // The distinction that matters: this helper proves authenticity only. It
  // cannot see a revocation, because revocation lives in the database. A token
  // from an old generation is still a genuine token — gate 3 in getCurrentUser
  // is what refuses it.
  ok(
    "an out-of-date generation is still ENVELOPE-valid",
    verifyAuthToken(signAuthToken(12, 0)) === 12
  );

  console.log(`token-revocation.verify.test.ts: ok (${checks} checks)`);
}

main();
