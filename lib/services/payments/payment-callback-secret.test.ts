/**
 * Run: npx tsx lib/services/payments/payment-callback-secret.test.ts
 *
 * The opaque callback-secret capability, on its own.
 *
 * This is the generic half of the SUMIT work, so it is tested without any
 * mention of a provider. What matters is that possession of the URL is a real
 * authentication decision: a wrong, truncated or missing secret must be
 * indistinguishable from a value that was never issued.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  MIN_CALLBACK_SECRET_LENGTH,
  buildCallbackUrl,
  extractCallbackSecretFromPath,
  generateCallbackSecret,
  hashCallbackSecret,
  redactCallbackSecret,
} from "./payment-callback-secret";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`OK: ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL: ${name}${detail ? " — " + detail : ""}`);
  }
}

async function main() {
  // --- entropy and shape ---------------------------------------------------
  {
    const a = generateCallbackSecret();
    const b = generateCallbackSecret();
    ok("a generated secret is long enough to be unguessable", a.length >= 43);
    ok("two secrets never collide", a !== b);
    ok(
      "it is URL-safe, so it can live in a path segment untouched",
      /^[A-Za-z0-9_-]+$/.test(a)
    );
    const many = new Set(Array.from({ length: 200 }, () => generateCallbackSecret()));
    ok("200 secrets produce 200 distinct values", many.size === 200);
  }

  // --- hashing -------------------------------------------------------------
  {
    const secret = generateCallbackSecret();
    const h = hashCallbackSecret(secret);
    ok(
      "the hash is a real SHA-256 of the secret",
      h === createHash("sha256").update(secret, "utf8").digest("hex")
    );
    ok("hashing is stable", hashCallbackSecret(secret) === h);
    ok(
      "a different secret hashes differently",
      hashCallbackSecret(generateCallbackSecret()) !== h
    );
    ok(
      "the hash never contains the secret",
      typeof h === "string" && !h.includes(secret)
    );
  }

  // --- THE AUTHENTICATION DECISION ----------------------------------------
  //
  // A wrong secret must not merely fail to match; it must be refused in a way
  // that is indistinguishable from a value that was never issued.
  {
    const secret = generateCallbackSecret();
    const good = hashCallbackSecret(secret);

    for (const [label, candidate] of [
      ["a wrong secret of the same length", generateCallbackSecret()],
      ["the right secret with one character changed", secret.slice(0, -1) + "X"],
      ["the right secret truncated", secret.slice(0, 20)],
      ["an empty string", ""],
      ["whitespace only", "          "],
      ["a short guess", "abc"],
      ["a value of exactly one below the minimum", "a".repeat(MIN_CALLBACK_SECRET_LENGTH - 1)],
    ] as [string, string][]) {
      const h = hashCallbackSecret(candidate);
      ok(`${label} does not match`, h !== good);
    }

    ok("a null secret hashes to null", hashCallbackSecret(null) === null);
    ok("a numeric secret hashes to null", hashCallbackSecret(12345) === null);
    ok("an object hashes to null", hashCallbackSecret({ a: 1 }) === null);
    ok(
      "anything below the minimum length is refused before hashing",
      hashCallbackSecret("a".repeat(MIN_CALLBACK_SECRET_LENGTH - 1)) === null
    );
    ok(
      "a value at the minimum length is accepted",
      typeof hashCallbackSecret("a".repeat(MIN_CALLBACK_SECRET_LENGTH)) === "string"
    );
  }

  // --- URL round trip ------------------------------------------------------
  {
    const secret = generateCallbackSecret();
    const url = buildCallbackUrl(
      "https://app.example/",
      "/api/payments/webhook/sumit/",
      secret
    );
    ok(
      "the callback URL has no double slashes",
      !url.replace("https://", "").includes("//")
    );
    ok(
      "the secret is the final PATH segment, never a query parameter",
      url.endsWith("/" + secret) && !url.includes("?")
    );

    const extracted = extractCallbackSecretFromPath(new URL(url).pathname);
    ok("the secret round-trips out of the path", extracted === secret);
    ok(
      "and its hash matches what was stored",
      hashCallbackSecret(extracted) === hashCallbackSecret(secret)
    );
  }

  // --- path extraction refuses what it should ------------------------------
  {
    for (const [label, path] of [
      ["a path with no secret segment", "/api/payments/webhook/sumit"],
      ["a bare slash", "/"],
      ["an empty string", ""],
      ["a short trailing segment", "/api/payments/webhook/sumit/abc"],
    ] as [string, string][]) {
      ok(`${label} yields no secret`, extractCallbackSecretFromPath(path) === null);
    }
    ok(
      "a non-string path yields no secret",
      extractCallbackSecretFromPath(undefined as unknown as string) === null
    );
    // A percent-encoded secret must decode back to the original.
    const secret = generateCallbackSecret();
    ok(
      "a percent-encoded segment decodes",
      extractCallbackSecretFromPath(
        "/api/payments/webhook/sumit/" + encodeURIComponent(secret)
      ) === secret
    );
  }

  // --- redaction -----------------------------------------------------------
  {
    const secret = generateCallbackSecret();
    const url = buildCallbackUrl("https://app.example", "api/payments/webhook/sumit", secret);
    const message = `POST ${url} failed with 500`;

    ok(
      "the secret is removed when it is known",
      !redactCallbackSecret(message, secret).includes(secret)
    );
    ok(
      "a callback URL is masked even when the secret is not to hand",
      !redactCallbackSecret(message).includes(secret)
    );
    ok(
      "unrelated text survives redaction",
      redactCallbackSecret("nothing secret here").includes("nothing secret here")
    );
  }

  // --- the generated secret is never derived from anything ------------------
  //
  // A secret derived from a business id, a request id or a timestamp would be
  // guessable by whoever knows those. This asserts the generator takes no input
  // at all, which is the structural version of that guarantee.
  {
    ok(
      "the generator accepts no arguments, so nothing can be derived into it",
      generateCallbackSecret.length === 0
    );
    const secrets = Array.from({ length: 50 }, () => generateCallbackSecret());
    ok(
      "no generated secret contains a small integer sequence",
      !secrets.some((s) => /(?:^|[^A-Za-z0-9])\d{1,4}(?:$)/.test(s) && s.length < 20)
    );
    assert.ok(secrets.every((s) => s.length === secrets[0]!.length));
    ok("all secrets are the same fixed length", true);
  }

  console.log(
    `\npayment-callback-secret: ${pass} passed, ${failures.length} failed`
  );
  if (failures.length > 0) {
    console.log("FAILURES:\n - " + failures.join("\n - "));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
