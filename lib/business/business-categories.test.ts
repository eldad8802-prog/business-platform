/**
 * Run: npx tsx lib/business/business-categories.test.ts
 *
 * D6 (owner, 2026-11-10) — service categories added to the onboarding map without changing any existing value:
 *   - every category and sub-category value that existed before is still there, unchanged, in the same order;
 *   - the five new categories and the new Retail sub-category exist with unique values;
 *   - every label resolves in Hebrew and in English (never the raw key);
 *   - stored values keep showing: known → label, legacy free text → as stored, "Other · General" → nothing.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { en } from "@/lib/i18n/messages/en";
import { createTranslator } from "@/lib/i18n/translate";
import { BUSINESS_CATEGORY_OPTIONS, businessCategoryLabel, findBusinessCategory } from "./business-categories";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`OK: ${name}`); } else { failures.push(name); console.log(`FAIL: ${name}${detail ? " — " + detail : ""}`); }
}

/** The map as it was on main 5d146aa2, before D6. */
const BEFORE: [string, string[]][] = [
  ["Beauty", ["Nails", "Hair", "Skincare", "Cosmetics", "Lashes", "Makeup"]],
  ["Food", ["Restaurant", "Bakery", "Catering", "Street Food", "Desserts", "Cafe"]],
  ["Fitness", ["Personal Training", "Pilates", "Yoga", "Nutrition", "Studio"]],
  ["Home Services", ["Cleaning", "Moving", "Repairs", "Air Conditioning", "Plumbing", "Electrical"]],
  ["Events", ["Photography", "DJ", "Decor", "Production", "Bar"]],
  ["Retail", ["Fashion", "Gifts", "Accessories", "Home Design", "Online Store"]],
  ["Other", ["General"]],
];
const ADDED: [string, string[]][] = [
  ["Automotive", ["Garage", "Body Shop", "Tires", "Auto Electric"]],
  ["Device Repair", ["Mobile Phones", "Computers", "Electronics"]],
  ["Installations", ["Security Cameras", "Furniture Assembly", "Solar"]],
  ["IT Services", ["Tech Support", "Networks"]],
  ["Professional Services", ["Consulting", "Training"]],
];

for (const [cat, subs] of BEFORE) {
  const o = findBusinessCategory(cat);
  const now = o?.subCategories.map((s) => s.value) ?? [];
  ok(`existing "${cat}": every sub-category kept, same order (new ones only appended)`,
    o !== null && subs.every((s, i) => now[i] === s), JSON.stringify(now));
}
ok("the only appended sub-category on an existing category is Retail · Jewelry",
  BEFORE.every(([cat, subs]) => {
    const extra = (findBusinessCategory(cat)?.subCategories ?? []).slice(subs.length).map((s) => s.value);
    return cat === "Retail" ? JSON.stringify(extra) === JSON.stringify(["Jewelry"]) : extra.length === 0;
  }));
ok("the existing categories keep their order; new categories come before \"Other\", which stays last",
  JSON.stringify(BUSINESS_CATEGORY_OPTIONS.map((c) => c.value))
    === JSON.stringify([...BEFORE.slice(0, 6).map(([c]) => c), ...ADDED.map(([c]) => c), "Other"]));
for (const [cat, subs] of ADDED) {
  const o = findBusinessCategory(cat);
  ok(`new "${cat}" with its sub-categories`, o !== null && JSON.stringify(o.subCategories.map((s) => s.value)) === JSON.stringify(subs));
}
const allValues = BUSINESS_CATEGORY_OPTIONS.flatMap((c) => [c.value, ...c.subCategories.map((s) => `${c.value}/${s.value}`)]);
ok("category values are unique, and sub-category values are unique within each category", new Set(allValues).size === allValues.length
  && BUSINESS_CATEGORY_OPTIONS.every((c) => new Set(c.subCategories.map((s) => s.value)).size === c.subCategories.length));
ok("sub-category values are unique across categories (a stored sub-category is never ambiguous)",
  (() => { const subs = BUSINESS_CATEGORY_OPTIONS.flatMap((c) => c.subCategories.map((s) => s.value)); return new Set(subs).size === subs.length; })());

const EN = createTranslator(en);
const labelled = BUSINESS_CATEGORY_OPTIONS.flatMap((c) => [c, ...c.subCategories]);
ok("every Hebrew label resolves (not the key, contains Hebrew or Latin text)",
  labelled.every((o) => o.label && o.label !== o.labelKey && !o.label.startsWith("insights.")));
ok("every English label resolves (not the key)",
  labelled.every((o) => { const t = EN(o.labelKey); return t && t !== o.labelKey && !t.startsWith("insights."); }));
ok("new labels: Hebrew as decided",
  findBusinessCategory("Automotive")?.label === "רכב" && findBusinessCategory("Device Repair")?.label === "תיקון מכשירים"
    && findBusinessCategory("Retail")?.subCategories.find((s) => s.value === "Jewelry")?.label === "תכשיטים");

ok("businessCategoryLabel: a new sub-category shows its label", businessCategoryLabel("Automotive", "Garage") === "מוסך");
ok("businessCategoryLabel: a new category with no sub-category shows the category", businessCategoryLabel("Installations", null) === "התקנות");
ok("businessCategoryLabel: legacy free text still shows as stored", businessCategoryLabel("Legacy free text", null) === "Legacy free text");
ok("businessCategoryLabel: \"Other · General\" still shows nothing", businessCategoryLabel("Other", "General") === null);
ok("businessCategoryLabel: an existing value is unchanged", businessCategoryLabel("Home Services", "Air Conditioning") === "מיזוג אוויר");

const ROOT = path.resolve(__dirname, "../..");
const onboarding = fs.readFileSync(path.join(ROOT, "app/onboarding/page.tsx"), "utf8");
ok("onboarding still lists the shared map in its category <select> (no layout that assumes a count)",
  onboarding.includes("@/lib/business/business-categories") && /categoryOptions\.map\(/.test(onboarding) && /<select/.test(onboarding));

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
