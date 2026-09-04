/**
 * Customer core — extraction equivalence verifier.
 *
 * `customer-core.ts` was extracted out of `customer.service.ts` so the Import
 * preview can evaluate a row without importing a module that instantiates
 * Prisma. The DB-backed `verify:crm-customer` cannot answer whether the
 * extraction preserved SEMANTICS — it needs a database, and it never exercises
 * the length limits or the exact error messages at all.
 *
 * So this file proves it directly: the pre-extraction implementations are
 * reproduced verbatim below, and both are run over the same input matrix. Any
 * divergence in return value, thrown type, or message text fails the build.
 *
 * Run: npx tsx lib/services/crm/customer-core.verify.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import { ValidationError } from "@/lib/errors";
import {
  CUSTOMER_CITY_MAX,
  CUSTOMER_EMAIL_MAX,
  CUSTOMER_NAME_MAX,
  CUSTOMER_NOTES_MAX,
  normalizeCustomerName,
  normalizeCustomerOptionalText,
} from "@/lib/services/crm/customer-core";

let passed = 0;

function check(label: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

/* ---- the PRE-EXTRACTION implementations, reproduced from git history ---- */

const NAME_MAX = 200;

function legacyNormalizeName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidationError("name is required");
  }
  const trimmed = value.trim();
  if (trimmed.length > NAME_MAX) {
    throw new ValidationError(`name must be at most ${NAME_MAX} characters`);
  }
  return trimmed;
}

function legacyNormalizeOptionalText(
  value: unknown,
  field: string,
  max: number
): string | null {
  if (value == null) return null;
  if (typeof value !== "string") {
    throw new ValidationError(`${field} must be a string or null`);
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) {
    throw new ValidationError(`${field} must be at most ${max} characters`);
  }
  return trimmed;
}

/** Run both and require identical observable behaviour. */
function sameBehaviour<T>(
  label: string,
  legacy: () => T,
  extracted: () => T
): void {
  let legacyOut: { ok: true; value: T } | { ok: false; name: string; msg: string };
  let newOut: typeof legacyOut;

  try {
    legacyOut = { ok: true, value: legacy() };
  } catch (e) {
    legacyOut = {
      ok: false,
      name: (e as Error).constructor.name,
      msg: (e as Error).message,
    };
  }
  try {
    newOut = { ok: true, value: extracted() };
  } catch (e) {
    newOut = {
      ok: false,
      name: (e as Error).constructor.name,
      msg: (e as Error).message,
    };
  }

  assert.deepEqual(newOut, legacyOut, `divergence at: ${label}`);
}

/* ------------------------------------------------------ the matrix ------ */

const NAME_INPUTS: unknown[] = [
  "אבי כהן",
  "  אבי כהן  ",
  "a",
  "",
  "   ",
  "\t\n",
  null,
  undefined,
  42,
  {},
  [],
  true,
  "x".repeat(NAME_MAX),
  "x".repeat(NAME_MAX + 1),
  `  ${"x".repeat(NAME_MAX)}  `,
  `  ${"x".repeat(NAME_MAX + 1)}  `,
  "שם עם \"מרכאות\" ופסיק, ועוד",
  "=HYPERLINK(\"http://evil\")",
];

check("normalizeCustomerName matches the pre-extraction behaviour exactly", () => {
  for (const input of NAME_INPUTS) {
    sameBehaviour(
      `name(${JSON.stringify(input)?.slice(0, 40)})`,
      () => legacyNormalizeName(input),
      () => normalizeCustomerName(input)
    );
  }
});

check("normalizeCustomerOptionalText matches, across every field and limit", () => {
  const fields: Array<[string, number]> = [
    ["email", CUSTOMER_EMAIL_MAX],
    ["city", CUSTOMER_CITY_MAX],
    ["notes", CUSTOMER_NOTES_MAX],
  ];
  const inputs: unknown[] = [
    null,
    undefined,
    "",
    "   ",
    "value",
    "  value  ",
    123,
    {},
    [],
    false,
    "y".repeat(200),
    "y".repeat(201),
    "y".repeat(5000),
    "y".repeat(5001),
  ];
  for (const [field, max] of fields) {
    for (const input of inputs) {
      sameBehaviour(
        `${field}(${JSON.stringify(input)?.slice(0, 30)}, max=${max})`,
        () => legacyNormalizeOptionalText(input, field, max),
        () => normalizeCustomerOptionalText(input, field, max)
      );
    }
  }
});

check("the limits themselves are unchanged", () => {
  assert.equal(CUSTOMER_NAME_MAX, 200);
  assert.equal(CUSTOMER_EMAIL_MAX, 200);
  assert.equal(CUSTOMER_CITY_MAX, 120);
  assert.equal(CUSTOMER_NOTES_MAX, 5000);
});

check("failures are still ValidationError, with the original wording", () => {
  assert.throws(
    () => normalizeCustomerName(""),
    (e: unknown) =>
      e instanceof ValidationError && (e as Error).message === "name is required"
  );
  assert.throws(
    () => normalizeCustomerName("x".repeat(201)),
    (e: unknown) =>
      e instanceof ValidationError &&
      (e as Error).message === "name must be at most 200 characters"
  );
  assert.throws(
    () => normalizeCustomerOptionalText(7, "email", 200),
    (e: unknown) =>
      e instanceof ValidationError &&
      (e as Error).message === "email must be a string or null"
  );
});

check("BOUNDARY: the core module pulls in no Prisma and no DB", () => {
  // This is the whole point of the extraction — if it regresses, the Import
  // preview can no longer evaluate a row without a database.
  const src = fs.readFileSync("lib/services/crm/customer-core.ts", "utf8");
  for (const needle of ["@/lib/prisma", "@prisma/client", "@/lib/tenant/"]) {
    assert.equal(src.includes(needle), false, `customer-core imports ${needle}`);
  }
});

console.log(`\nCUSTOMER-CORE EQUIVALENCE PASS — ${passed} checks green.`);
