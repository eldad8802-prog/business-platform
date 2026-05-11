/**
 * bridge_qa.mjs — Business Identity Bridge QA
 *
 * Tests that BusinessProfile.category/subCategory from DB flows through the
 * full chain: resolvedBusinessType → BusinessContentProfile → CreativeBlueprint
 * → RenderBlueprint preset, when body has NO businessType/businessCategory.
 *
 * Modifies BusinessProfile for businessId=1 per test case, then restores original.
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const BASE_URL = "http://localhost:3000";
const AUTH_TOKEN = "1"; // Bearer 1 → userId=1, businessId=1
const BUSINESS_ID = 1;

// ── Minimal valid body — NO businessType, NO businessCategory ─────────────────
// mode: "ai" so visual_strategy is driven by business profile, not camera override
const BASE_BODY = {
  mode: "ai",
  goal: "leads",
  contentAngle: "show_result",
  contentGoalPrompt: "אני רוצה יותר לקוחות מהאיזור שלי",
  selectedDirection: {
    id: "trust",
    title: "בניית אמון",
    description: "תוכן שמציג מקצועיות ומשרה ביטחון",
    tone: "professional",
    recommendedFormat: "reel",
  },
  selectedFormat: "reel",
  selectedPlatform: "instagram",
  audienceTypes: ["new"],
  // intentionally NO businessType, NO businessCategory
};

// ── Test cases ────────────────────────────────────────────────────────────────
const TEST_CASES = [
  {
    label: "Beauty (existing DB value — real-world)",
    category: "Beauty",
    subCategory: "Nails",
    expectedMarket: "beauty",
    expectedPreset: "beauty_aesthetic",
  },
  {
    label: "law_firm",
    category: "law_firm",
    subCategory: null,
    expectedMarket: "legal",
    expectedPreset: "authority_minimal",
  },
  {
    label: "repair (electrician / home services)",
    category: "repair",
    subCategory: null,
    expectedMarket: "home",
    expectedPreset: "documentary_real",
  },
  {
    label: "fashion_store",
    category: "fashion_store",
    subCategory: null,
    expectedMarket: "retail",
    expectedPreset: "beauty_aesthetic", // bright_airy + non-high energy
  },
  {
    label: "dental_clinic",
    category: "dental_clinic",
    subCategory: null,
    expectedMarket: "health",
    expectedPreset: "trust_soft",
  },
  {
    label: "UNKNOWN_TYPE (fallback → other)",
    category: "UNKNOWN_TYPE_XYZ",
    subCategory: null,
    expectedMarket: "other",
    expectedPreset: "premium_modern",
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

async function setDbCategory(category, subCategory) {
  await prisma.businessProfile.upsert({
    where: { businessId: BUSINESS_ID },
    update: { category, subCategory },
    create: { businessId: BUSINESS_ID, category, subCategory },
  });
}

async function callApi() {
  const res = await fetch(`${BASE_URL}/api/video/plan`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${AUTH_TOKEN}`,
    },
    body: JSON.stringify(BASE_BODY),
  });
  return res.json();
}

function fmt(v) {
  return v ?? "(undefined)";
}

function check(label, actual, expected) {
  const ok = actual === expected;
  return `${ok ? "✓" : "✗"} ${label}: ${actual} ${ok ? "" : `(expected ${expected})`}`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Save original state
  const original = await prisma.businessProfile.findUnique({
    where: { businessId: BUSINESS_ID },
    select: { category: true, subCategory: true },
  });

  console.log("══════════════════════════════════════════════════════════════");
  console.log("BUSINESS IDENTITY BRIDGE QA");
  console.log("Body: NO businessType, NO businessCategory");
  console.log(`Original DB state: category=${fmt(original?.category)} subCategory=${fmt(original?.subCategory)}`);
  console.log("══════════════════════════════════════════════════════════════\n");

  const results = [];

  for (const tc of TEST_CASES) {
    console.log(`──────────────────────────────────────────────────────────────`);
    console.log(`CASE: ${tc.label}`);
    console.log(`  DB set: category="${tc.category}" subCategory=${tc.subCategory ?? "null"}`);

    await setDbCategory(tc.category, tc.subCategory);

    let data;
    try {
      data = await callApi();
    } catch (e) {
      console.log(`  ERROR calling API: ${e.message}`);
      results.push({ label: tc.label, error: true });
      continue;
    }

    if (!data.success) {
      console.log(`  API error: ${JSON.stringify(data)}`);
      results.push({ label: tc.label, error: true });
      continue;
    }

    const bp = data.businessProfile;
    const cb = data.blueprint;
    const rb = data.renderBlueprint;

    const isOther = bp?.marketCategory === "other";
    const expectedOther = tc.expectedMarket === "other";

    console.log(`\n  BusinessContentProfile:`);
    console.log(`    marketCategory:      ${fmt(bp?.marketCategory)}`);
    console.log(`    visualStrength:      ${fmt(bp?.visualStrength)}`);
    console.log(`    emotionalDriver:     ${fmt(bp?.emotionalDriver)}`);
    console.log(`    brandPersona:        ${fmt(bp?.brandPersona)}`);
    console.log(`    contentStyle:        ${fmt(bp?.contentStyle)}`);
    console.log(`    trustLevel:          ${fmt(bp?.trustLevel)}`);
    console.log(`    recommendedVideoType:${fmt(bp?.recommendedVideoType)}`);

    console.log(`\n  CreativeBlueprint:`);
    console.log(`    visual_strategy:     ${fmt(cb?.visual_strategy)}`);
    console.log(`    visual_energy:       ${fmt(cb?.visual_energy)}`);
    console.log(`    storytelling_model:  ${fmt(cb?.storytelling_model)}`);
    console.log(`    narration_tone:      ${fmt(cb?.narration_tone)}`);
    console.log(`    cta_psychology:      ${fmt(cb?.cta_psychology)}`);
    console.log(`    pacing_curve:        ${fmt(cb?.pacing_curve)}`);

    console.log(`\n  RenderBlueprint:`);
    console.log(`    preset:              ${fmt(rb?.preset)}`);
    console.log(`    preset_reasoning:    ${fmt(rb?.preset_reasoning)}`);

    console.log(`\n  Checks:`);
    console.log(`    ${check("marketCategory", bp?.marketCategory, tc.expectedMarket)}`);
    console.log(`    ${check("renderPreset", rb?.preset, tc.expectedPreset)}`);
    console.log(`    ${isOther && !expectedOther ? "✗ UNEXPECTED fallback to 'other'" : !isOther && expectedOther ? "✗ Expected 'other' but got different" : isOther && expectedOther ? "✓ Expected 'other' fallback confirmed" : "✓ Not 'other' (correct)"}`);

    results.push({
      label: tc.label,
      marketCategory: bp?.marketCategory,
      preset: rb?.preset,
      visualStrategy: cb?.visual_strategy,
      isOther,
      expectedOther,
      marketOk: bp?.marketCategory === tc.expectedMarket,
      presetOk: rb?.preset === tc.expectedPreset,
    });

    console.log();
  }

  // Restore original state
  await setDbCategory(original?.category ?? null, original?.subCategory ?? null);
  console.log(`\nDB restored: category="${fmt(original?.category)}" subCategory="${fmt(original?.subCategory)}"\n`);

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log("══════════════════════════════════════════════════════════════");
  console.log("SUMMARY");
  console.log("══════════════════════════════════════════════════════════════");
  console.log(
    `${"Case".padEnd(40)} ${"Market".padEnd(12)} ${"Preset".padEnd(20)} ${"M✓".padEnd(4)} ${"P✓".padEnd(4)} Other?`
  );
  console.log("─".repeat(95));
  for (const r of results) {
    if (r.error) {
      console.log(`${r.label.padEnd(40)} ERROR`);
      continue;
    }
    console.log(
      `${r.label.padEnd(40)} ${(r.marketCategory ?? "?").padEnd(12)} ${(r.preset ?? "?").padEnd(20)} ${r.marketOk ? "✓" : "✗"}    ${r.presetOk ? "✓" : "✗"}    ${r.isOther ? "yes" : "no"}`
    );
  }

  const allMarketOk = results.filter((r) => !r.error).every((r) => r.marketOk);
  const allPresetOk = results.filter((r) => !r.error).every((r) => r.presetOk);
  const noUnexpectedOther = results
    .filter((r) => !r.error && !r.expectedOther)
    .every((r) => !r.isOther);
  const unknownFallsToOther = results
    .filter((r) => !r.error && r.expectedOther)
    .every((r) => r.isOther);

  console.log("\n── Verdict ──────────────────────────────────────────────────");
  console.log(`  marketCategory correct:    ${allMarketOk ? "✓ ALL" : "✗ SOME FAILED"}`);
  console.log(`  renderPreset correct:      ${allPresetOk ? "✓ ALL" : "✗ SOME FAILED"}`);
  console.log(`  No unexpected 'other':     ${noUnexpectedOther ? "✓ OK" : "✗ UNEXPECTED FALLBACK"}`);
  console.log(`  Unknown → 'other':         ${unknownFallsToOther ? "✓ OK" : "✗ FAILED"}`);

  const pass = allMarketOk && noUnexpectedOther && unknownFallsToOther;
  console.log(`\n  BRIDGE QA: ${pass ? "✓ PASS" : "✗ FAIL"}`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  // Best-effort restore on crash
  try {
    await setDbCategory("Beauty", "Nails");
    await prisma.$disconnect();
  } catch {}
  process.exit(1);
});
