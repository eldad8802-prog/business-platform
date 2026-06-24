/**
 * Memory Policy (Stage 7). Run with:
 *   npx tsx lib/features/bot/bot-memory-policy.verify.test.ts
 */
import assert from "node:assert/strict";
import {
  validateMemoryPolicy,
  coerceMemoryPolicy,
  emptyMemoryPolicy,
  hasMemoryPolicyContent,
  MEMORY_TOGGLE_KEYS,
} from "./index";

// ── 1. defaults ──────────────────────────────────────────────────────────────
assert.equal(MEMORY_TOGGLE_KEYS.length, 5);
const empty = emptyMemoryPolicy();
assert.equal(hasMemoryPolicyContent(empty), false);
for (const k of MEMORY_TOGGLE_KEYS) assert.equal(empty[k], false);

// ── 2. valid save: known toggles, unknown dropped ────────────────────────────
{
  const r = validateMemoryPolicy({
    newOrReturningCustomer: true,
    preferences: true,
    bogusKey: true, // unknown → dropped
  });
  assert.ok(r.ok);
  assert.equal(r.value.newOrReturningCustomer, true);
  assert.equal(r.value.preferences, true);
  assert.equal(r.value.contactHistory, false); // absent → default false
  assert.equal((r.value as Record<string, unknown>).bogusKey, undefined); // dropped
  assert.equal(hasMemoryPolicyContent(r.value), true);
}

// ── 3. all-off is valid (no content) ─────────────────────────────────────────
{
  const r = validateMemoryPolicy({ preferences: false });
  assert.ok(r.ok);
  assert.equal(hasMemoryPolicyContent(r.value), false);
}

// ── 4. errors: non-object / non-boolean toggle ───────────────────────────────
assert.equal(validateMemoryPolicy(null).ok, false);
assert.equal(validateMemoryPolicy({ preferences: "yes" }).ok, false);
assert.equal(validateMemoryPolicy({ contactHistory: 1 }).ok, false);

// ── 5. coerce (read-side, forgiving) ─────────────────────────────────────────
{
  const p = coerceMemoryPolicy({ preferences: true, contactHistory: "nope", extra: true } as never);
  assert.equal(p.preferences, true);
  assert.equal(p.contactHistory, false); // bad type → false
  assert.deepEqual(coerceMemoryPolicy(null), emptyMemoryPolicy());
}

console.log("bot-memory-policy.verify: all assertions passed ✓");
