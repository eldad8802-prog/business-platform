/**
 * Structured Fields Foundation — Stage A validation. Run with:
 *   npx tsx lib/features/conversation/bot-fields/bot-fields.verify.test.ts
 *
 * Asserts the normalizer's backward-compatibility contract: legacy
 * `{ items }` keeps working, v2 validates, garbage degrades to `[]` without
 * throwing.
 */
import assert from "node:assert/strict";
import {
  botFieldsToLegacyItems,
  isLegacyQuestions,
  normalizeBotFields,
  parseBotField,
} from "./index";

// ── 1. Legacy { items: string[] } → text fields ──────────────────────────────
const legacy = normalizeBotFields({ items: ["מה השם שלך?", "מתי נוח לך?"] });
assert.equal(legacy.length, 2);
assert.deepEqual(legacy[0], {
  id: "legacy_0",
  key: "legacy_0",
  label: "מה השם שלך?",
  question: "מה השם שלך?",
  type: "text",
  required: false,
  mapsTo: null,
});
assert.equal(legacy[1].key, "legacy_1");
assert.ok(isLegacyQuestions({ items: [] }));

// ── 2. Legacy with non-string / empty items skipped (no throw) ───────────────
const dirty = normalizeBotFields({ items: ["ok", 42, null, "  ", "second"] });
assert.deepEqual(
  dirty.map((f) => f.question),
  ["ok", "second"]
);

// ── 3. v2 valid fields (incl. select options + allowed mapsTo) ───────────────
const v2 = normalizeBotFields({
  version: 2,
  fields: [
    {
      id: "f_phone",
      key: "phone",
      label: "טלפון",
      question: "מה הטלפון שלך?",
      type: "phone",
      required: true,
      mapsTo: "Customer.phone",
    },
    {
      id: "f_slot",
      key: "slot",
      label: "מועד",
      question: "מתי נוח לך?",
      type: "select",
      required: false,
      options: [
        { value: "morning", label: "בוקר" },
        { value: "evening", label: "ערב" },
      ],
    },
  ],
});
assert.equal(v2.length, 2);
assert.equal(v2[0].type, "phone");
assert.equal(v2[0].mapsTo, "Customer.phone");
assert.equal(v2[1].options?.length, 2);

// ── 4. Invalid type → field dropped ──────────────────────────────────────────
const badType = normalizeBotFields({
  version: 2,
  fields: [
    { id: "a", key: "a", question: "Q", type: "not_a_type", required: false },
    { id: "b", key: "b", question: "Q2", type: "text", required: false },
  ],
});
assert.equal(badType.length, 1);
assert.equal(badType[0].key, "b");

// ── 5. Invalid mapsTo → kept but nulled (conservative allow-list) ────────────
const badTarget = parseBotField({
  id: "c",
  key: "c",
  question: "Q",
  type: "text",
  required: false,
  mapsTo: "Customer.secretField",
});
assert.ok(badTarget);
assert.equal(badTarget?.mapsTo, null);

// ── 6. Malformed / unknown shapes → [] (never throws) ────────────────────────
for (const garbage of [null, undefined, 5, "x", [], {}, { version: 2 }, { foo: 1 }]) {
  assert.deepEqual(normalizeBotFields(garbage), [], `garbage: ${JSON.stringify(garbage)}`);
}

// ── 7. Legacy round-trip bridge ──────────────────────────────────────────────
assert.deepEqual(botFieldsToLegacyItems(legacy), ["מה השם שלך?", "מתי נוח לך?"]);

console.log("bot-fields.verify: all assertions passed ✓");
