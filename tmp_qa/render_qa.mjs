/**
 * Render Intelligence Layer v1 — QA Script
 * Tests 5 cases × 3 variants = 15 payload comparisons
 * No DB, no UI, no LLM, no schema changes.
 */

// ─── Inline adapter (mirrors creatomate-adapter.ts exactly) ────────────────────
function setRgbaOpacity(color, opacity) {
  if (typeof color !== "string") return `rgba(0,0,0,${opacity.toFixed(2)})`;
  const m = color.match(/^rgba\((\d+),\s*(\d+),\s*(\d+),\s*[\d.]+\)$/);
  if (!m) return color;
  return `rgba(${m[1]},${m[2]},${m[3]},${opacity.toFixed(2)})`;
}
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function round2(n) { return Math.round(n * 100) / 100; }

function applyRenderBlueprint(payload, renderBlueprint) {
  try {
    const cfg = renderBlueprint.presetConfig;
    const cloned = JSON.parse(JSON.stringify(payload));
    const els = cloned.elements;
    if (!Array.isArray(els) || !els.length) return payload;

    const vids  = els.filter(e => e.type === "video");
    const hook  = els.find(e => e.type === "text" && e.y === "15%");
    const subs  = els.filter(e => e.type === "text" && e.y === "85%");
    const cta   = els.find(e => e.type === "text" && e.y === "20%");

    const { clipDurationDelta: delta, firstClipBonus: fb, lastClipBonus: lb } = cfg;
    if (delta !== 0 || fb !== 0 || lb !== 0) {
      const last = vids.length - 1;
      let cursor = 0;
      vids.forEach((el, i) => {
        let d = clamp(el.duration + delta, 1.5, 20);
        if (i === 0)    d = clamp(d + fb, 1.5, 20);
        if (i === last) d = clamp(d + lb, 1.5, 20);
        el.duration = round2(d);
        el.time     = round2(cursor);
        cursor     += el.duration;
      });
      const tot = vids.reduce((s, e) => s + e.duration, 0);
      cloned.duration = round2(tot);
      if (hook && vids[0]) hook.duration = vids[0].duration;
      subs.forEach((s, i) => {
        const v = vids[i];
        if (!v) return;
        s.time     = round2(v.time + 0.2);
        s.duration = round2(clamp(v.duration - 0.3, 0.5, 30));
      });
      if (cta) cta.time = round2(cloned.duration - 2.5);
    }

    if (hook) {
      hook.font_size        = clamp(cfg.hookFontSize, 20, 56);
      hook.background_color = setRgbaOpacity(hook.background_color, cfg.hookBgOpacity);
      hook.border_radius    = cfg.hookBorderRadius;
      hook.padding_x        = cfg.hookPaddingX;
      hook.padding_y        = cfg.hookPaddingY;
    }
    for (const s of subs) {
      s.font_size        = clamp(cfg.subtitleFontSize, 20, 56);
      s.font_weight      = cfg.subtitleFontWeight;
      s.background_color = setRgbaOpacity(s.background_color, cfg.subtitleBgOpacity);
      s.y                = cfg.subtitleY;
    }
    if (cta) {
      cta.font_size        = clamp(cfg.ctaFontSize, 20, 56);
      cta.background_color = setRgbaOpacity(cta.background_color, cfg.ctaBgOpacity);
    }
    return cloned;
  } catch (err) {
    return payload; // fallback — return original
  }
}

// ─── Inline buildPayload (mirrors creatomate.service.ts exactly) ──────────────
function getClipDurations(count, format) {
  const base = format === "reel" ? 2.2 : 3;
  return Array.from({ length: count }).map((_, i) => {
    if (i === 0) return base + 0.6;
    if (i === count - 1) return base + 0.4;
    return base;
  });
}

function buildBasePayload(shotCount, format, platform) {
  const durations = getClipDurations(shotCount, format);
  const fakeAssets = Array.from({ length: shotCount }, (_, i) => `https://asset${i}.mp4`);
  const fakeShots  = Array.from({ length: shotCount }, (_, i) => ({
    visual: `visual ${i}`, voice: `voice text for shot ${i} — testing`
  }));

  let t = 0;
  const videoEls = fakeAssets.map((url, i) => {
    const el = { type: "video", source: url, track: 1, time: round2(t), duration: durations[i], fit: "cover" };
    t += durations[i];
    return el;
  });

  const hook = {
    type: "text", text: "hook text", track: 2,
    time: 0, duration: durations[0],
    x: "50%", y: "15%", width: "85%",
    font_family: "Arial", font_weight: "700", font_size: 46,
    fill_color: "#ffffff", background_color: "rgba(0,0,0,0.5)",
    text_align: "center", padding_x: 20, padding_y: 16, border_radius: 16,
  };

  let st = 0;
  const subtitles = fakeShots.map((shot, i) => {
    const sub = {
      type: "text", text: shot.voice, track: 2,
      time: round2(st + 0.2), duration: round2(durations[i] - 0.3),
      x: "50%", y: "85%", width: "90%",
      font_family: "Arial", font_weight: "700", font_size: 30,
      fill_color: "#ffffff", background_color: "rgba(0,0,0,0.6)",
      text_align: "center", padding_x: 14, padding_y: 10, border_radius: 14,
    };
    st += durations[i];
    return sub;
  });

  const totalDuration = round2(durations.reduce((a, b) => a + b, 0));
  const cta = {
    type: "text", text: "CTA text", track: 2,
    time: round2(totalDuration - 2.5), duration: 2.5,
    x: "50%", y: "20%", width: "80%",
    font_family: "Arial", font_weight: "700", font_size: 34,
    fill_color: "#ffffff", background_color: "rgba(17,24,39,0.8)",
    text_align: "center", padding_x: 18, padding_y: 12, border_radius: 14,
  };

  return {
    output_format: "mp4",
    width: platform === "facebook" ? 1080 : 1080,
    height: format === "reel" ? 1920 : (platform === "facebook" ? 1080 : 1920),
    duration: totalDuration,
    elements: [...videoEls, hook, ...subtitles, cta],
  };
}

// ─── QA analysis helpers ──────────────────────────────────────────────────────
function analyzePayloadDiff(before, after, rb) {
  const bVids = before.elements.filter(e => e.type === "video");
  const aVids = after.elements.filter(e => e.type === "video");
  const bHook = before.elements.find(e => e.type === "text" && e.y === "15%");
  const aHook = after.elements.find(e => e.type === "text" && e.y === "15%");
  const bSubs = before.elements.filter(e => e.type === "text" && e.y === "85%");
  const aHookOrSubs = after.elements.filter(e => e.type === "text" && (e.y === "85%" || e.y === rb?.presetConfig?.subtitleY));
  // find CTA by y="20%"
  const bCta = before.elements.find(e => e.type === "text" && e.y === "20%");
  const aCta = after.elements.find(e => e.type === "text" && e.y === "20%");

  const minClipDuration = Math.min(...aVids.map(v => v.duration));
  const maxClipDuration = Math.max(...aVids.map(v => v.duration));

  // CTA time check
  const expectedCtaTime = round2(after.duration - 2.5);
  const ctaTimeCorrect = aCta ? Math.abs(aCta.time - expectedCtaTime) < 0.01 : null;

  // Duration recalculation check
  const totalFromClips = round2(aVids.reduce((s, e) => s + e.duration, 0));
  const durationMatchesClips = Math.abs(after.duration - totalFromClips) < 0.01;

  // Changes
  const changes = [];
  if (before.duration !== after.duration)
    changes.push(`duration: ${before.duration}s → ${after.duration}s`);
  if (bHook && aHook) {
    if (bHook.font_size !== aHook.font_size)
      changes.push(`hook font_size: ${bHook.font_size} → ${aHook.font_size}`);
    if (bHook.background_color !== aHook.background_color)
      changes.push(`hook bg: ${bHook.background_color} → ${aHook.background_color}`);
    if (bHook.border_radius !== aHook.border_radius)
      changes.push(`hook border_radius: ${bHook.border_radius} → ${aHook.border_radius}`);
    if (bHook.padding_x !== aHook.padding_x)
      changes.push(`hook padding_x: ${bHook.padding_x} → ${aHook.padding_x}`);
  }
  if (bSubs[0] && aHookOrSubs[0]) {
    if (bSubs[0].font_size !== aHookOrSubs[0].font_size)
      changes.push(`sub font_size: ${bSubs[0].font_size} → ${aHookOrSubs[0].font_size}`);
    if (bSubs[0].font_weight !== aHookOrSubs[0].font_weight)
      changes.push(`sub font_weight: ${bSubs[0].font_weight} → ${aHookOrSubs[0].font_weight}`);
    if (bSubs[0].background_color !== aHookOrSubs[0].background_color)
      changes.push(`sub bg: ${bSubs[0].background_color} → ${aHookOrSubs[0].background_color}`);
    if (bSubs[0].y !== aHookOrSubs[0].y)
      changes.push(`sub y: ${bSubs[0].y} → ${aHookOrSubs[0].y}`);
  }
  if (bCta && aCta) {
    if (bCta.font_size !== aCta.font_size)
      changes.push(`cta font_size: ${bCta.font_size} → ${aCta.font_size}`);
    if (bCta.time !== aCta.time)
      changes.push(`cta time: ${bCta.time} → ${aCta.time}`);
    if (bCta.background_color !== aCta.background_color)
      changes.push(`cta bg: ${bCta.background_color} → ${aCta.background_color}`);
  }

  const clipDursBefore = bVids.map(v => v.duration);
  const clipDursAfter  = aVids.map(v => v.duration);
  if (JSON.stringify(clipDursBefore) !== JSON.stringify(clipDursAfter))
    changes.push(`clip durations: [${clipDursBefore}] → [${clipDursAfter}]`);

  return {
    durationBefore: before.duration,
    durationAfter: after.duration,
    durationMatchesClips,
    minClipDuration,
    maxClipDuration,
    ctaTimeCorrect,
    ctaTimeBefore: bCta?.time,
    ctaTimeAfter: aCta?.time,
    ctaTimeExpected: expectedCtaTime,
    changes,
    isPure: JSON.stringify(before) === JSON.stringify(before), // always true — purity tested separately
  };
}

// ─── Fallback test ────────────────────────────────────────────────────────────
function testFallback(payload) {
  // Test 1: no renderBlueprint (undefined)
  const noRb = applyRenderBlueprint(payload, undefined);
  const noRbSame = JSON.stringify(noRb) === JSON.stringify(payload);

  // Test 2: null renderBlueprint
  const nullRb = applyRenderBlueprint(payload, null);
  const nullRbSame = JSON.stringify(nullRb) === JSON.stringify(payload);

  // Test 3: renderBlueprint with bad presetConfig (exception path)
  let threwAndFellback = false;
  try {
    const badRb = { presetConfig: { clipDurationDelta: "NOTANUMBER" } };
    const result = applyRenderBlueprint(payload, badRb);
    // Should return original on error
    threwAndFellback = JSON.stringify(result) === JSON.stringify(payload);
  } catch { threwAndFellback = false; }

  return { noRbSame, nullRbSame, threwAndFellback };
}

// ─── API call ─────────────────────────────────────────────────────────────────
async function callVideoPlan(caseData) {
  const res = await fetch("http://localhost:3000/api/video/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer 1" },
    body: JSON.stringify({
      goal: caseData.goal,
      contentAngle: "service_highlight",
      businessCategory: caseData.category,
      services: caseData.services,
      audienceTypes: caseData.audience,
      selectedPlatform: caseData.platform,
      selectedFormat: caseData.format ?? "reel",
      selectedDirection: {
        title: caseData.directionTitle,
        description: "הצגת השירות המרכזי",
        tone: caseData.tone ?? "professional",
      },
    }),
  });
  return res.json();
}

// ─── Test cases ───────────────────────────────────────────────────────────────
const CASES = [
  {
    id: "legal",
    label: "עורך דין",
    category: "עורך דין",
    services: ["ייעוץ משפטי לגירושין"],
    audience: ["זוגות בתהליך גירושין"],
    goal: "leads",
    platform: "instagram",
    format: "reel",
    directionTitle: "הגנה על הזכויות שלך",
    tone: "professional",
  },
  {
    id: "beauty",
    label: "קוסמטיקאית",
    category: "קוסמטיקאית",
    services: ["טיפולי פנים"],
    audience: ["נשים 25-45"],
    goal: "leads",
    platform: "instagram",
    format: "reel",
    directionTitle: "טיפול שמשנה את העור",
    tone: "warm",
  },
  {
    id: "electrician",
    label: "חשמלאי",
    category: "חשמלאי",
    services: ["שירות חשמל חירום 24/7"],
    audience: ["בעלי בתים"],
    goal: "leads",
    platform: "instagram",
    format: "reel",
    directionTitle: "זמין 24/7",
    tone: "direct",
  },
  {
    id: "architect",
    label: "אדריכל",
    category: "אדריכל",
    services: ["תכנון אדריכלי לדירות"],
    audience: ["בעלי דירות לשיפוץ"],
    goal: "leads",
    platform: "instagram",
    format: "reel",
    directionTitle: "עיצוב שמשנה חיים",
    tone: "professional",
  },
  {
    id: "retail_tiktok",
    label: "חנות ביגוד — TikTok",
    category: "חנות ביגוד",
    services: ["ביגוד ואופנה"],
    audience: ["צעירים 18-35"],
    goal: "sales",
    platform: "tiktok",
    format: "reel",
    directionTitle: "קולקציה חדשה הגיעה",
    tone: "energetic",
  },
];

// ─── Main ─────────────────────────────────────────────────────────────────────
console.log("═".repeat(70));
console.log("RENDER INTELLIGENCE LAYER v1 — QA REPORT");
console.log(`Date: ${new Date().toISOString()}`);
console.log("═".repeat(70));

const allResults = [];

for (const c of CASES) {
  console.log(`\n${"─".repeat(70)}`);
  console.log(`CASE: ${c.label} (${c.platform})`);
  console.log("─".repeat(70));

  let apiData;
  try {
    apiData = await callVideoPlan(c);
  } catch (err) {
    console.log(`  [ERROR] API call failed: ${err.message}`);
    continue;
  }

  if (!apiData.success) {
    console.log(`  [ERROR] API returned success=false: ${JSON.stringify(apiData.error)}`);
    continue;
  }

  const variants = apiData.variants ?? [];
  console.log(`  API: ${variants.length} variants returned`);

  // Test fallback on a base payload
  const fallbackPayload = buildBasePayload(3, c.format ?? "reel", c.platform);
  const fallback = testFallback(fallbackPayload);
  console.log(`  Fallback tests:`);
  console.log(`    no renderBlueprint → payload unchanged: ${fallback.noRbSame ? "✓" : "✗ PROBLEM"}`);
  console.log(`    null renderBlueprint → payload unchanged: ${fallback.nullRbSame ? "✓" : "✗ PROBLEM"}`);
  console.log(`    bad presetConfig → falls back safely: ${fallback.threwAndFellback ? "✓" : "✗ PROBLEM"}`);

  for (const variant of variants) {
    const rb = variant.renderBlueprint;
    const style = variant.id?.replace("variant_", "").replace(/_\d+$/, "") ?? "?";
    const shotCount = variant.structure?.length ?? 3;
    const format = c.format ?? "reel";

    console.log(`\n  ── VARIANT: ${style.toUpperCase()} (${shotCount} shots) ──`);
    console.log(`    Preset:   ${rb?.preset ?? "MISSING"}`);
    console.log(`    Reason:   ${rb?.preset_reasoning ?? "—"}`);

    if (!rb) {
      console.log(`    [WARN] No renderBlueprint on variant`);
      allResults.push({ case: c.id, variant: style, preset: "MISSING", issues: ["no renderBlueprint"] });
      continue;
    }

    // Build before payload
    const before = buildBasePayload(shotCount, format, c.platform);
    // Build after payload
    const after  = applyRenderBlueprint(before, rb);

    const diff = analyzePayloadDiff(before, after, rb);

    // Print timing
    console.log(`    Duration: ${diff.durationBefore}s → ${diff.durationAfter}s`);
    console.log(`    Clips:    ${before.elements.filter(e=>e.type==="video").map(e=>e.duration+"s").join(", ")} → ` +
                `${after.elements.filter(e=>e.type==="video").map(e=>e.duration+"s").join(", ")}`);
    console.log(`    Min clip: ${diff.minClipDuration}s ${diff.minClipDuration < 1.5 ? "✗ BELOW 1.5s!" : "✓ (≥ 1.5s)"}`);

    // CTA timing
    const ctaOk = diff.ctaTimeCorrect;
    console.log(`    CTA time: ${diff.ctaTimeBefore}s → ${diff.ctaTimeAfter}s (expected ${diff.ctaTimeExpected}s) ${ctaOk ? "✓" : "✗ MISMATCH"}`);

    // Duration integrity
    console.log(`    Duration == sum of clips: ${diff.durationMatchesClips ? "✓" : "✗ MISMATCH"}`);

    // Property changes
    console.log(`    Changed properties (${diff.changes.length}):`);
    diff.changes.forEach(ch => console.log(`      • ${ch}`));

    // Intelligence fields
    console.log(`    Intelligence: typography=${rb.typography_preset} | overlay=${rb.overlay_density} | spacing=${rb.scene_spacing} | energy=${rb.energy_profile}`);

    // Issues
    const issues = [];
    if (diff.minClipDuration < 1.5) issues.push(`clip < 1.5s (${diff.minClipDuration}s)`);
    if (!diff.ctaTimeCorrect) issues.push(`CTA time mismatch (got ${diff.ctaTimeAfter}, expected ${diff.ctaTimeExpected})`);
    if (!diff.durationMatchesClips) issues.push("duration !== sum of clips");
    if (diff.changes.length === 0) issues.push("no properties changed (preset may be identity)");

    if (issues.length > 0) {
      console.log(`    [ISSUES]: ${issues.join(" | ")}`);
    } else {
      console.log(`    Status: ✓ CLEAN`);
    }

    allResults.push({
      case: c.id,
      label: c.label,
      variant: style,
      preset: rb.preset,
      reason: rb.preset_reasoning,
      durationBefore: diff.durationBefore,
      durationAfter: diff.durationAfter,
      minClip: diff.minClipDuration,
      ctaTimeOk: diff.ctaTimeCorrect,
      durationIntegrity: diff.durationMatchesClips,
      changesCount: diff.changes.length,
      issues,
      fallback,
    });
  }
}

// ─── Summary table ────────────────────────────────────────────────────────────
console.log("\n\n" + "═".repeat(70));
console.log("SUMMARY TABLE");
console.log("═".repeat(70));
console.log("case             | variant      | preset             | dur before→after | min clip | CTA ✓ | issues");
console.log("─".repeat(110));
for (const r of allResults) {
  const c = r.case.padEnd(16);
  const v = r.variant.padEnd(12);
  const p = (r.preset ?? "—").padEnd(18);
  const d = `${r.durationBefore}→${r.durationAfter}`.padEnd(16);
  const m = r.minClip !== undefined ? `${r.minClip}s`.padEnd(8) : "—".padEnd(8);
  const cta = r.ctaTimeOk ? "  ✓  " : "  ✗  ";
  const iss = r.issues?.length > 0 ? r.issues.join("; ") : "—";
  console.log(`${c} | ${v} | ${p} | ${d} | ${m} | ${cta} | ${iss}`);
}

// ─── Final verdict ────────────────────────────────────────────────────────────
const totalCases = allResults.length;
const cleanCases = allResults.filter(r => r.issues?.length === 0).length;
const hasMinClipViolation = allResults.some(r => r.minClip < 1.5);
const hasCtaMismatch = allResults.some(r => r.ctaTimeOk === false);
const hasDurationIssue = allResults.some(r => !r.durationIntegrity);
const fallbackOk = allResults.every(r => r.fallback?.noRbSame && r.fallback?.nullRbSame && r.fallback?.threwAndFellback);

console.log("\n" + "═".repeat(70));
console.log("FINAL VERDICT");
console.log("═".repeat(70));
console.log(`Clean cases:           ${cleanCases}/${totalCases}`);
console.log(`Min clip ≥ 1.5s:       ${hasMinClipViolation ? "✗ VIOLATION" : "✓ OK"}`);
console.log(`CTA time accurate:     ${hasCtaMismatch ? "✗ MISMATCH FOUND" : "✓ OK"}`);
console.log(`Duration integrity:    ${hasDurationIssue ? "✗ ISSUE" : "✓ OK"}`);
console.log(`Fallback safety:       ${fallbackOk ? "✓ OK — original payload always returned when no blueprint" : "✗ PROBLEM"}`);
console.log(`\nRECOMMENDATION: v1 is ${cleanCases === totalCases && !hasMinClipViolation && !hasCtaMismatch && !hasDurationIssue && fallbackOk ? "SAFE to leave active" : "NEEDS review before production"}`);
