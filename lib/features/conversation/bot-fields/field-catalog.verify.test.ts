/**
 * Field Catalog (Stage B) validation. Run with:
 *   npx tsx lib/features/conversation/bot-fields/field-catalog.verify.test.ts
 *
 * Asserts catalog integrity, helper lookups, the Bot Builder v1 surface, and
 * that the normalizer preserves a valid catalogKey but drops an unknown one.
 */
import assert from "node:assert/strict";
import {
  assertCatalogIntegrity,
  BOT_FIELD_CATALOG,
  getBuilderV1Fields,
  getCatalogField,
  isCatalogKey,
  listCatalogFields,
  normalizeBotFields,
} from "./index";

// ── 1. Catalog integrity (throws on any violation) ───────────────────────────
assertCatalogIntegrity();

// ── 2. Shape / counts match Field Catalog v1 ─────────────────────────────────
assert.equal(BOT_FIELD_CATALOG.length, 20, "catalog should have 20 entries");
assert.equal(listCatalogFields({ namespace: "party" }).length, 6);
assert.equal(listCatalogFields({ namespace: "appointment" }).length, 3);
assert.equal(listCatalogFields({ namespace: "subject" }).length, 6);
assert.equal(listCatalogFields({ namespace: "conversation" }).length, 5);

// ── 3. Bot Builder v1 surface = exactly the 9 shown keys ─────────────────────
const shownKeys = getBuilderV1Fields()
  .map((f) => f.key)
  .sort();
assert.deepEqual(shownKeys, [
  "anything_else",
  "appointment_date",
  "notes",
  "party_city",
  "party_email",
  "party_name",
  "party_phone",
  "preferred_contact_time",
  "service_type",
]);

// ── 4. Lookups ───────────────────────────────────────────────────────────────
assert.equal(getCatalogField("party_name")?.mapsTo, "Customer.name");
assert.equal(getCatalogField("notes")?.mapsTo, null);
assert.equal(getCatalogField("nope_not_real"), undefined);
assert.ok(isCatalogKey("appointment_date"));
assert.ok(!isCatalogKey("appointment_unknown"));
assert.ok(!isCatalogKey(42));

// ── 5. Reserved targets stay unmapped (locked decision) ──────────────────────
for (const k of ["party_legal_name", "party_tax_id", "appointment_duration", "service_type"]) {
  assert.equal(getCatalogField(k)?.mapsTo, null, `${k} must be mapsTo:null`);
}

// ── 6. Normalizer preserves a valid catalogKey, drops an unknown one ─────────
const withValid = normalizeBotFields({
  version: 2,
  fields: [
    {
      id: "f1",
      key: "phone",
      question: "מה הטלפון?",
      type: "phone",
      required: true,
      catalogKey: "party_phone",
    },
  ],
});
assert.equal(withValid[0].catalogKey, "party_phone");

const withUnknown = normalizeBotFields({
  version: 2,
  fields: [
    {
      id: "f2",
      key: "x",
      question: "Q",
      type: "text",
      required: false,
      catalogKey: "totally_made_up",
    },
  ],
});
assert.equal(withUnknown[0].catalogKey, undefined);

// ── 7. Legacy fields never carry a catalogKey ────────────────────────────────
const legacy = normalizeBotFields({ items: ["שאלה"] });
assert.equal(legacy[0].catalogKey, undefined);

console.log("field-catalog.verify: all assertions passed ✓");
