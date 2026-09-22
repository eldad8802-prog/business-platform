#!/usr/bin/env node
/**
 * Hash the QA tenant password — and refuse to hash something that is not one.
 *
 * WHY THIS EXISTS
 *
 * The first attempt hashed a file that contained a UTF-8 byte-order mark and
 * nothing else. Every check anyone would think to run passed: the file existed,
 * its size was greater than zero, the hash was a valid bcrypt cost-10 string,
 * and the production workflow's credential gate accepted it. The account was
 * created with a password of U+FEFF, which the login FORM can never submit,
 * and the product has no way to change a password. One invisible character
 * cost a production run and a second gated write.
 *
 * So the check is not "is there a file". The rejections below are each a way
 * that a password can be technically present and practically useless:
 *
 *   empty                     nothing was ever written
 *   whitespace-only           a stray newline, a space, a tab
 *   byte-order mark           the failure that actually happened
 *   trims to nothing          any combination of the above
 *   padded with whitespace    the owner would type the visible characters and
 *                             be refused, because the stored secret has more
 *   control characters        cannot be typed back reliably
 *   shorter than signup's minimum
 *
 * It then proves the hash it produced actually verifies the password, because a
 * hash that does not round-trip is the same failure wearing a valid shape.
 *
 * Usage:
 *   node scripts/ops/qa-password-hash.mjs <password-file> <hash-output-file>
 *
 * Neither the password nor the hash is ever printed.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

import { BCRYPT_COST_10_SHAPE } from "../ci/collection-qa-tenant-hash-shape.mjs";

const require = createRequire(import.meta.url);
const bcrypt = require("bcrypt");

/** Matches lib/auth/signup-identity.ts#MIN_PASSWORD_LENGTH. */
const MIN_PASSWORD_LENGTH = 6;
const BOM = "\uFEFF";

export function describePasswordProblem(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    return "the file is empty — nothing was written to it";
  }
  if (raw.includes(BOM)) {
    return (
      "the file contains a byte-order mark (U+FEFF). PowerShell's " +
      "`Set-Content -Encoding utf8` writes one even for an empty string, which " +
      "is exactly how the previous credential became a single invisible character"
    );
  }
  if (raw.trim().length === 0) {
    return "the file is whitespace only";
  }
  if (raw !== raw.trim()) {
    return (
      "the password has leading or trailing whitespace. The owner would type " +
      "the visible characters at /login and be refused, because the stored " +
      "secret has more than that"
    );
  }
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    return "the password contains a control character and cannot be typed back reliably";
  }
  if (raw.length < MIN_PASSWORD_LENGTH) {
    return `the password is shorter than the ${MIN_PASSWORD_LENGTH} characters signup requires`;
  }
  return null;
}

async function main() {
  const [passwordFile, hashFile] = process.argv.slice(2);
  if (!passwordFile || !hashFile) {
    console.error("usage: node scripts/ops/qa-password-hash.mjs <password-file> <hash-output-file>");
    process.exit(2);
  }

  let raw;
  try {
    raw = readFileSync(passwordFile, "utf8");
  } catch (error) {
    console.error(`REFUSED: cannot read ${passwordFile} — ${error.message}`);
    process.exit(1);
  }

  const problem = describePasswordProblem(raw);
  if (problem) {
    console.error(`REFUSED: ${problem}.`);
    console.error("Nothing was hashed. Write the password again and re-run.");
    process.exit(1);
  }

  const hash = await bcrypt.hash(raw, 10);

  if (!BCRYPT_COST_10_SHAPE.test(hash)) {
    console.error("REFUSED: the generated hash is not bcrypt cost 10. Nothing was written.");
    process.exit(1);
  }
  if (!(await bcrypt.compare(raw, hash))) {
    console.error("REFUSED: the generated hash does not verify its own password. Nothing was written.");
    process.exit(1);
  }

  writeFileSync(hashFile, hash, { encoding: "utf8" });

  console.log("OK — password accepted and hashed.");
  console.log(`  password length: ${raw.length} characters (the password itself is never printed)`);
  console.log("  hash: bcrypt cost 10, 60 characters, verified against the password");
  console.log(`  written to: ${hashFile}`);
}

main().catch((error) => {
  console.error(`REFUSED: ${error.message}`);
  process.exit(1);
});
