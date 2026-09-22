#!/usr/bin/env node
/**
 * Proves the credential the QA tenant is provisioned with is the credential
 * Production login accepts.
 *
 * The risk this closes is narrow and unforgiving: the tenant is written by SQL,
 * not by the signup service, so nothing in the normal code path validates the
 * hash. A hash at the wrong cost, from the wrong library, or truncated by a
 * shell would insert successfully and only reveal itself as "wrong password"
 * against an account that cannot be repaired without another Production write.
 *
 * So this test does the real thing: hashes with the same library and cost
 * lib/auth/signup.ts uses, verifies with the same call app/api/auth/login uses,
 * and checks that the shape the workflow enforces accepts exactly that.
 *
 * Run: node scripts/ci/collection-qa-tenant-hash-compat.test.mjs
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { BCRYPT_COST_10_SHAPE } from "./collection-qa-tenant-hash-shape.mjs";

const require = createRequire(import.meta.url);
const bcrypt = require("bcrypt");

let failures = 0;
let passed = 0;

function ok(label, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// --- What Production actually does, read from Production's own source. -------

const signupSource = readFileSync("lib/auth/signup.ts", "utf8");
const loginSource = readFileSync("app/api/auth/login/route.ts", "utf8");

ok(
  "signup hashes at cost 10",
  /export const BCRYPT_ROUNDS = 10;/.test(signupSource),
  "lib/auth/signup.ts no longer declares cost 10"
);
ok(
  "signup hashes with bcrypt",
  /bcrypt\.hash\(plain, BCRYPT_ROUNDS\)/.test(signupSource)
);
ok(
  "login verifies with bcrypt.compare against the stored column",
  /bcrypt\.compare\(password, user\.password\)/.test(loginSource)
);
ok(
  "login resolves the account by the folded address",
  /normalizeEmail\(email\)/.test(loginSource)
);
ok(
  "login mints a token at the row's own generation",
  /signAuthToken\(user\.id, user\.tokenVersion, session\.sessionId\)/.test(loginSource)
);

// --- The credential itself. --------------------------------------------------

const sample = "qa-collection-sandbox-sample-password";
const hash = await bcrypt.hash(sample, 10);

ok("a cost-10 hash matches the shape the workflow enforces", BCRYPT_COST_10_SHAPE.test(hash));
ok("the correct password verifies", await bcrypt.compare(sample, hash));
ok("a wrong password does not verify", !(await bcrypt.compare(`${sample}x`, hash)));
ok(
  "the hash is 60 characters, as the column will hold",
  hash.length === 60,
  `got ${hash.length}`
);

// A hash at any other cost is a hash registration would never have produced.
const wrongCost = await bcrypt.hash(sample, 12);
ok(
  "a hash at another cost is refused by the shape",
  !BCRYPT_COST_10_SHAPE.test(wrongCost)
);
ok(
  "...even though bcrypt itself would still verify it",
  await bcrypt.compare(sample, wrongCost),
  "the shape is what pins the cost, not bcrypt"
);

// The failure modes a shell can introduce between the secret and the database.
for (const [label, broken] of [
  ["an empty secret", ""],
  ["a truncated hash", hash.slice(0, 40)],
  ["a hash with a trailing newline", `${hash}\n`],
  ["a hash with surrounding whitespace", ` ${hash} `],
  ["a plaintext password mistakenly stored as the hash", sample],
]) {
  ok(`refused: ${label}`, !BCRYPT_COST_10_SHAPE.test(broken));
}

console.log(
  `\n${passed} passed, ${failures} failed — ${failures === 0 ? "HASH COMPATIBILITY: PASS" : "HASH COMPATIBILITY: FAIL"}`
);
process.exit(failures === 0 ? 0 : 1);
