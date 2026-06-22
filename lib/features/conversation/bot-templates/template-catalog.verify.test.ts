/**
 * Template Catalog (Stage C) validation. Run with:
 *   npx tsx lib/features/conversation/bot-templates/template-catalog.verify.test.ts
 *
 * Asserts catalog integrity, category->template resolution (incl. generic
 * fallback), the preview-only resolver, and the FinalAction SoT drift guard.
 */
import assert from "node:assert/strict";
import {
  assertTemplateCatalogIntegrity,
  BOT_TEMPLATE_CATALOG,
  getDefaultTemplate,
  getTemplate,
  getTemplateForCategory,
  listTemplates,
  resolveTemplate,
} from "./index";
import { FINAL_ACTIONS } from "../final-action";

// ── 1. Integrity (throws on any violation) ───────────────────────────────────
assertTemplateCatalogIntegrity();

// ── 2. Shape / counts ────────────────────────────────────────────────────────
assert.equal(BOT_TEMPLATE_CATALOG.length, 4, "v1 ships 4 templates");
assert.deepEqual(
  listTemplates().map((t) => t.key).sort(),
  ["beauty_default", "food_default", "generic_default", "home_services_default"]
);

// ── 3. category -> template (incl. fallback) ─────────────────────────────────
assert.equal(getTemplateForCategory("Beauty").key, "beauty_default");
assert.equal(getTemplateForCategory("Food").key, "food_default");
assert.equal(getTemplateForCategory("Home Services").key, "home_services_default");
assert.equal(getTemplateForCategory("Other").key, "generic_default"); // fallback
assert.equal(getTemplateForCategory(null).key, "generic_default");
assert.equal(getTemplateForCategory("nope").key, "generic_default");
assert.equal(getDefaultTemplate().key, "generic_default");

// ── 4. Lookups ───────────────────────────────────────────────────────────────
assert.equal(getTemplate("beauty_default")?.category, "Beauty");
assert.equal(getTemplate("missing"), undefined);

// ── 5. resolveTemplate — join + override, ordered, preview-only ──────────────
const resolved = resolveTemplate(getTemplate("beauty_default")!);
assert.equal(resolved.length, 3);
assert.deepEqual(resolved.map((r) => r.catalogKey), [
  "party_name",
  "service_type",
  "appointment_date",
]);
// questionOverride applied on service_type
const svc = resolved.find((r) => r.catalogKey === "service_type")!;
assert.equal(svc.question, "איזה טיפול מעניין אותך?");
// no override on party_name -> catalog defaultQuestion + catalog type/mapsTo
const name = resolved.find((r) => r.catalogKey === "party_name")!;
assert.equal(name.question, "מה השם שלך?");
assert.equal(name.type, "text");
assert.equal(name.mapsTo, "Customer.name");

// ── 6. partyRole / templateVersion locked ────────────────────────────────────
for (const t of BOT_TEMPLATE_CATALOG) {
  assert.equal(t.partyRole, "CUSTOMER");
  assert.equal(t.templateVersion, 1);
  assert.ok((FINAL_ACTIONS as readonly string[]).includes(t.finalAction));
}

// ── 7. FinalAction SoT drift guard ───────────────────────────────────────────
assert.deepEqual([...FINAL_ACTIONS], [
  "LEAVE_MESSAGE",
  "COLLECT_DETAILS",
  "SEND_LINK",
  "ESCALATE",
]);

console.log("template-catalog.verify: all assertions passed ✓");
