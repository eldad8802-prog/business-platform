/**
 * Template Materialization (Stage D) validation. Run with:
 *   npx tsx lib/features/conversation/bot-templates/materialize-template.verify.test.ts
 *
 * Asserts the pure materialization helpers: template -> BotField[], the v2
 * config shape with a derived legacyItems projection, round-trip stability
 * through the existing normalizer, and determinism across all templates.
 */
import assert from "node:assert/strict";
import {
  BOT_TEMPLATE_CATALOG,
  getTemplate,
  materializeTemplateConfig,
  templateToBotFields,
} from "./index";
import { botFieldsToLegacyItems, normalizeBotFields } from "../bot-fields";

// ── 1. templateToBotFields — ordered, catalog-typed, overrides applied ───────
const beauty = getTemplate("beauty_default")!;
const fields = templateToBotFields(beauty);
assert.deepEqual(
  fields.map((f) => f.catalogKey),
  ["party_name", "service_type", "appointment_date"]
);
// every materialized field carries its catalogKey as id/key
for (const f of fields) {
  assert.equal(f.id, f.catalogKey);
  assert.equal(f.key, f.catalogKey);
}
const name = fields.find((f) => f.catalogKey === "party_name")!;
assert.equal(name.type, "text");
assert.equal(name.mapsTo, "Customer.name");
assert.equal(name.question, "מה השם שלך?"); // catalog default (no override)
const svc = fields.find((f) => f.catalogKey === "service_type")!;
assert.equal(svc.question, "איזה טיפול מעניין אותך?"); // override applied
assert.equal(svc.required, true);

// options carried from catalog (food template, select with ranges)
const foodFields = templateToBotFields(getTemplate("food_default")!);
const seats = foodFields.find((f) => f.catalogKey === "subject_seats_count")!;
assert.ok(seats.options && seats.options.length === 3);

// ── 2. materializeTemplateConfig — v2 SoT + derived projection ────────────────
const config = materializeTemplateConfig(beauty);
assert.equal(config.questions.version, 2);
assert.equal(config.questions.fields.length, 3);
assert.equal(config.welcomeMessage, beauty.welcomeMessage);
assert.equal(config.finalAction, beauty.finalAction);
assert.deepEqual(config.provenance, {
  sourceTemplateKey: "beauty_default",
  sourceTemplateVersion: 1,
});

// legacyItems is DERIVED from fields, not authored
assert.deepEqual(config.legacyItems, botFieldsToLegacyItems(config.questions.fields));
assert.deepEqual(
  config.legacyItems,
  config.questions.fields.map((f) => f.question)
);

// ── 3. Round-trip: v2 is readable + stable through the existing normalizer ───
assert.deepEqual(normalizeBotFields(config.questions), config.questions.fields);

// ── 4. Determinism + purity across every template (no throw) ─────────────────
for (const t of BOT_TEMPLATE_CATALOG) {
  const a = materializeTemplateConfig(t);
  const b = materializeTemplateConfig(t);
  assert.deepEqual(a, b, `materialize must be deterministic for ${t.key}`);
  assert.equal(a.questions.version, 2);
  assert.equal(a.questions.fields.length, t.fieldRefs.length);
}

console.log("materialize-template.verify: all assertions passed ✓");
