/**
 * LLM Reliability Experiment — 5 cases × 3 variants
 * Run: node tmp_qa/llm_experiment.mjs
 */
import { readFileSync } from "fs";
import OpenAI from "openai";

// ─── Load .env ────────────────────────────────────────────────────────────────
const envRaw = readFileSync(".env", "utf8");
const env = {};
for (const line of envRaw.split("\n")) {
  const m = line.match(/^([A-Z_]+)="?([^"]+)"?/);
  if (m) env[m[1]] = m[2].trim();
}

const OPENAI_API_KEY = env.OPENAI_API_KEY;
const MODEL = env.CONTENT_LLM_MODEL ?? "gpt-4.1-mini";
const client = new OpenAI({ apiKey: OPENAI_API_KEY });

// ─── Test cases ───────────────────────────────────────────────────────────────
const CASES = [
  {
    id: "legal",
    businessLabel: "עורך דין",
    mainOfferLabel: "ייעוץ משפטי לגירושין",
    audienceLabel: "זוגות בתהליך גירושין",
    differentiatorLabel: "ניסיון של 20 שנה בדיני משפחה",
    goalLabel: "יותר פניות",
    businessCategory: "עורך דין",
  },
  {
    id: "beauty",
    businessLabel: "קוסמטיקאית",
    mainOfferLabel: "טיפולי פנים וקוסמטיקה",
    audienceLabel: "נשים 25-45",
    differentiatorLabel: "טיפולים אישיים עם מוצרי פרמיום",
    goalLabel: "יותר פניות",
    businessCategory: "קוסמטיקאית",
  },
  {
    id: "electrician",
    businessLabel: "חשמלאי",
    mainOfferLabel: "שירות חשמל חירום 24/7",
    audienceLabel: "בעלי בתים",
    differentiatorLabel: "הגעה תוך שעה, 24/7",
    goalLabel: "יותר פניות",
    businessCategory: "חשמלאי",
  },
  {
    id: "architect",
    businessLabel: "אדריכל",
    mainOfferLabel: "תכנון אדריכלי לדירות",
    audienceLabel: "בעלי דירות לשיפוץ",
    differentiatorLabel: "עיצוב שמביא את הפוטנציאל האמיתי של הדירה",
    goalLabel: "יותר פניות",
    businessCategory: "אדריכל",
  },
  {
    id: "retail",
    businessLabel: "חנות ביגוד",
    mainOfferLabel: "ביגוד ואופנה",
    audienceLabel: "צעירים 18-35",
    differentiatorLabel: "מידות מלאות, סטייל שלא מתפשר",
    goalLabel: "יותר מכירות",
    businessCategory: "חנות ביגוד",
  },
];

// ─── Blueprint stub (enough for the prompts) ─────────────────────────────────
const BLUEPRINT = {
  storytelling_model: "transformation",
  attention_strategy: "pain_mirror",
  interruption_style: "contrast_open",
  pacing_curve: "fast_hook_slow_close",
  narration_tone: "conversational_direct",
  narration_strategy: "relatable_struggle",
  visual_strategy: "real_life_footage",
  visual_energy: "medium_energy",
  cta_psychology: "urgency_soft",
  subtitle_behavior: "full_subtitles",
  emotional_arc: [{ phase: "hook", emotion: "curiosity" }, { phase: "cta", emotion: "confidence" }],
  platform_behavior: { hookWindowSeconds: 3, captionStrategy: "value_hook", hashtagCount: 5 },
  blueprint_reasoning: "strong SMB hook with direct CTA",
};

const PLAN = { platform: "instagram", videoType: "SHORT", structure: ["hook", "value", "cta"] };

// ─── Prompt builders (inline, no TS imports) ──────────────────────────────────

const STRUCTURE_LABELS = {
  hook: "פתיחה", pain: "כאב / בעיה", context: "הקשר",
  explanation: "הסבר", solution: "פתרון", proof: "הוכחה",
  result: "תוצאה", offer: "הצעה", trust: "אמון",
  value: "ערך", cta: "קריאה לפעולה",
};

function fmtStructure(parts) {
  return parts.map((p, i) => `  ${i + 1}. ${STRUCTURE_LABELS[p] ?? p}`).join("\n");
}

function buildFullPrompt(blueprint, ctx, plan) {
  const pb = blueprint.platform_behavior;
  const system = `אתה מנהל קריאייטיב AI. תפקידך לבצע CreativeBlueprint מדויק — לא להמציא חופשי, לבצע.\nפלט: JSON בלבד. ללא markdown, ללא הסברים. רק אובייקט JSON תקין.`;

  const parts = [];

  parts.push([
    `# נושא הסרטון`,
    `הסרטון הוא על: ${ctx.mainOfferLabel} של ${ctx.businessLabel}`,
    `קהל היעד של הסרטון: ${ctx.audienceLabel}`,
    `הסרטון פונה אל ${ctx.audienceLabel} — לא אל בעל העסק.`,
  ].join("\n"));

  const arcLine = blueprint.emotional_arc.length
    ? `emotional_arc: ${blueprint.emotional_arc.map(s => s.emotion).join(" → ")}`
    : "";

  parts.push(`# CreativeBlueprint
storytelling_model:  ${blueprint.storytelling_model}
attention_strategy:  ${blueprint.attention_strategy}
interruption_style:  ${blueprint.interruption_style}
pacing_curve:        ${blueprint.pacing_curve}
narration_tone:      ${blueprint.narration_tone}
narration_strategy:  ${blueprint.narration_strategy}
visual_strategy:     ${blueprint.visual_strategy}
visual_energy:       ${blueprint.visual_energy}
cta_psychology:      ${blueprint.cta_psychology}
subtitle_behavior:   ${blueprint.subtitle_behavior}${arcLine ? `\n${arcLine}` : ""}
platform_behavior:   hook=${pb.hookWindowSeconds}s | caption=${pb.captionStrategy} | hashtags=${pb.hashtagCount}
reasoning:           ${blueprint.blueprint_reasoning}`);

  parts.push(`# פרופיל עסקי
עסק:          ${ctx.businessLabel}
הצעת ערך:     ${ctx.mainOfferLabel}
קהל:          ${ctx.audienceLabel}
מטרה:         ${ctx.goalLabel}
יתרון ייחודי: ${ctx.differentiatorLabel}`);

  parts.push(`# משימה
פלטפורמה: ${plan.platform} | סוג סרטון: ${plan.videoType}
מבנה — ${plan.structure.length} שוטים בדיוק:
${fmtStructure(plan.structure)}`);

  parts.push(`# חוקי ביצוע

## עוגן תוכן — חובה
- הסרטון פונה לקהל: ${ctx.audienceLabel}. הוא מדבר אל הלקוחות, לא אל בעל העסק.
- כל hook, shot, voice ו-CTA חייבים להתייחס ישירות ל-${ctx.mainOfferLabel}.
- אסור לייצר תוכן כללי על: שיווק, צמיחה עסקית, הגדלת פניות, גרפי ביצועים, החלטות פיניסיות — אלא אם ${ctx.mainOfferLabel} הוא בפועל תחום פיניסי/שיווקי.
- visual: תאר מה רואים בפועל בתחום ${ctx.mainOfferLabel} — לא גרפים עסקיים כלליים.
- אם העסק הוא B2C (קוסמטיקה, אופנה, מסעדה, עיצוב, טיפולים, שירות מקומי, בנייה, רפואה) — אסור שפת B2B. אסור אנימציות גרפי עסקים, דשבורדים, "להגדיל פניות".

## שפה וסגנון
- הכל בעברית — אסור אנגלית בטקסט
- hook: 1-2 משפטים, חד, לא גנרי — מיישם interruption_style: ${blueprint.interruption_style}
- shots: בדיוק ${plan.structure.length} שוטים לפי המבנה לעיל
- visual: משפט אחד — מה שרואים / מצלמים ב-${ctx.mainOfferLabel}
- voice: 1-2 משפטים — עברית טבעית, לא שיווקית, לא גנרית
- caption: ${pb.captionStrategy} style + ${pb.hashtagCount} האשטגים, עד 130 תווים
- cta: משפט אחד פעיל, מיישם cta_psychology: ${blueprint.cta_psychology}
- אסור: "רוב האנשים", "אם גם אתם", "ככה זה נראה", "יש דרך", "זה ההבדל"
- הטון חייב להתאים ל-narration_tone: ${blueprint.narration_tone}`);

  parts.push(`# פורמט הפלט (JSON בלבד)
{
  "hook": "...",
  "shots": [
    {"visual": "...", "voice": "..."}
  ],
  "caption": "...",
  "cta": "..."
}`);

  return { system, user: parts.join("\n\n") };
}

const FEW_SHOT = {
  legal: `דוגמה:
{"hook":"טעות אחת בהסכם הגירושין עלולה לעלות לך בכל הרכוש.","shots":[{"visual":"עורך דין עם מסמכים מול זוג","voice":"טעות אחת בהסכם הגירושין עלולה לעלות לך בכל הרכוש."},{"visual":"אצבע מצביעת על סעיף בחוזה","voice":"אנחנו בודקים כל סעיף לפני שאתם חותמים."},{"visual":"לחיצת יד, פנים רגועות","voice":"קבעו פגישת ייעוץ ראשונה ללא עלות."}],"caption":"לא חותמים לפני שיודעים. ייעוץ ראשון ללא עלות. #עורךדין #גירושין","cta":"קבעו פגישה עכשיו."}`,
  beauty: `דוגמה:
{"hook":"העור שלך מדבר — אנחנו פשוט יודעים להקשיב.","shots":[{"visual":"לקוחה עם מסיכת פנים, אורות רכים","voice":"העור שלך מדבר — אנחנו פשוט יודעים להקשיב."},{"visual":"ידיים מורחות סרום על פנים","voice":"כל טיפול מותאם אישית — לא מה שאחרות עשו."},{"visual":"לפני ואחרי, עור זוהר","voice":"קבעי עכשיו ותרגישי את ההבדל כבר בטיפול הראשון."}],"caption":"עור שמח מתחיל בטיפול אחד 💆‍♀️ #קוסמטיקאית #טיפולפנים","cta":"קבעי טיפול ראשון עכשיו."}`,
  services: `דוגמה:
{"hook":"תקלת חשמל בלילה? אנחנו מגיעים תוך שעה.","shots":[{"visual":"טכנאי עם כלים מול לוח חשמל בלילה","voice":"תקלת חשמל בלילה? אנחנו מגיעים תוך שעה."},{"visual":"חשמלאי בודק חיווט בצורה מקצועית","voice":"מוסמכים, מבוטחים, ניסיון של מעל 15 שנה."},{"visual":"לקוח מרוצה לוחץ יד עם טכנאי","voice":"חייגו עכשיו לתיקון מהיר במחיר שקוף."}],"caption":"זמינים 24/7, מגיעים תוך שעה ☎️ #חשמלאי #שירותחירום","cta":"חייגו עכשיו — מגיעים תוך שעה."}`,
  design: `דוגמה:
{"hook":"דירה של 70 מטר שנראתה צפופה — עכשיו נראית כמו פנטהאוז.","shots":[{"visual":"לפני: חדר צפוף. אחרי: מרחב פתוח","voice":"דירה של 70 מטר שנראתה צפופה — עכשיו נראית כמו פנטהאוז."},{"visual":"אדריכל עם לקוח, תוכנית קומה על מסך","voice":"אנחנו מעצבים את החיים שאתם רוצים לחיות."},{"visual":"חדר מעוצב, אסתטי, תאורה טבעית","voice":"קבעו שיחת ייעוץ ראשונה ללא עלות."}],"caption":"הפוטנציאל של הדירה שלך ממתין 🏡 #אדריכלות #עיצובפנים","cta":"קבעו שיחת ייעוץ — ללא עלות."}`,
  retail: `דוגמה:
{"hook":"הפריט הזה נגמר פעמיים השבוע — הגענו שוב בשבילך.","shots":[{"visual":"שלט נגמר במלאי, ואז קופסאות חדשות מגיעות","voice":"הפריט הזה נגמר פעמיים השבוע — הגענו שוב בשבילך."},{"visual":"לקוחה מנסה בגד חדש מול מראה","voice":"קולקציה חדשה נחתה — מידות מלאות, סטייל שלא מתפשר."},{"visual":"שקית קניות יוצאת, לקוחה מחייכת","voice":"הגיעו היום — המבצע לא יחכה."}],"caption":"קולקציה חדשה, מחירים שמפתיעים 🛍️ #אופנה #ביגוד","cta":"הגיעו עוד היום — כמויות מוגבלות."}`,
};

function detectBucket(ctx) {
  const h = [ctx.mainOfferLabel, ctx.businessLabel, ctx.businessCategory ?? ""].join(" ").toLowerCase();
  if (/עורך דין|משפטי|גירושין/.test(h)) return "legal";
  if (/קוסמטיק|פנים|עור|יופי|שיער/.test(h)) return "beauty";
  if (/חשמלאי|אינסטלטור|מנעולן|תיקון|חירום/.test(h)) return "services";
  if (/אדריכל|עיצוב פנים|שיפוץ/.test(h)) return "design";
  if (/חנות|ביגוד|אופנה/.test(h)) return "retail";
  return "generic";
}

function buildCompactPrompt(blueprint, ctx, plan, withFewShot) {
  const bucket = detectBucket(ctx);
  const system = `אתה מנהל קריאייטיב AI. כתוב תסריט ל${ctx.businessLabel} על ${ctx.mainOfferLabel} עבור ${ctx.audienceLabel}. פלט JSON בלבד — ללא markdown, ללא הסברים.`;

  const parts = [
    [
      `# נושא הסרטון`,
      `הסרטון הוא על: ${ctx.mainOfferLabel} של ${ctx.businessLabel}`,
      `קהל היעד: ${ctx.audienceLabel}`,
      `הסרטון פונה אל הלקוחות — לא אל בעל העסק.`,
    ].join("\n"),

    [
      `# הוראות קריאייטיב`,
      `storytelling: ${blueprint.storytelling_model} | טון: ${blueprint.narration_tone} | CTA: ${blueprint.cta_psychology} | פתיחה: ${blueprint.interruption_style}`,
    ].join("\n"),

    [
      `# מבנה — ${plan.structure.length} שוטים בדיוק`,
      fmtStructure(plan.structure),
    ].join("\n"),

    [
      `# חוקים`,
      `- כל hook, שוט ו-CTA חייבים להתייחס ישירות ל: ${ctx.mainOfferLabel}`,
      `- פונה לקהל: ${ctx.audienceLabel} — לא לבעל העסק`,
      `- הכל בעברית`,
      `- אסור תוכן גנרי על שיווק/צמיחה עסקית אלא אם זה תחום העסק`,
    ].join("\n"),
  ];

  if (withFewShot && FEW_SHOT[bucket]) {
    parts.push(`# דוגמה לסגנון הפלט הנדרש\n${FEW_SHOT[bucket]}`);
  }

  parts.push(`# פורמט JSON\n{\n  "hook": "...",\n  "shots": [\n    {"visual": "...", "voice": "..."}\n  ],\n  "caption": "...",\n  "cta": "..."\n}`);

  return { system, user: parts.join("\n\n") };
}

// ─── Hebrew check ─────────────────────────────────────────────────────────────
function hasHebrew(text) { return /[א-ת]/.test(text); }

// ─── Domain guard ─────────────────────────────────────────────────────────────
function checkDomain(output, mainOfferLabel) {
  const words = mainOfferLabel.split(/[\s,\/\-]+/).map(w => w.trim()).filter(w => w.length > 2);
  if (!words.length) return true;
  const haystack = [output.hook, output.shots[0]?.visual, output.shots[0]?.voice, output.shots[1]?.voice]
    .join(" ").toLowerCase();
  return words.some(w => haystack.includes(w.toLowerCase()));
}

// ─── Run one case + variant ───────────────────────────────────────────────────
async function runOne(caseData, variant) {
  const ctx = {
    businessLabel: caseData.businessLabel,
    audienceLabel: caseData.audienceLabel,
    mainOfferLabel: caseData.mainOfferLabel,
    differentiatorLabel: caseData.differentiatorLabel,
    goalLabel: caseData.goalLabel,
    businessCategory: caseData.businessCategory,
  };

  let prompt;
  if (variant === "full") prompt = buildFullPrompt(BLUEPRINT, ctx, PLAN);
  else if (variant === "compact") prompt = buildCompactPrompt(BLUEPRINT, ctx, PLAN, false);
  else prompt = buildCompactPrompt(BLUEPRINT, ctx, PLAN, true);

  const t0 = Date.now();
  try {
    const resp = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      temperature: 0.7,
      max_tokens: 1200,
    });
    const elapsed = Date.now() - t0;
    const text = resp.choices[0]?.message?.content ?? "";
    const cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return { ok: false, error: "no JSON block", elapsed };
    const raw = JSON.parse(match[0]);
    const hook = typeof raw.hook === "string" ? raw.hook.trim() : "";
    const shots = Array.isArray(raw.shots) ? raw.shots : [];
    const caption = typeof raw.caption === "string" ? raw.caption.trim() : "";
    const cta = typeof raw.cta === "string" ? raw.cta.trim() : "";
    const hebrewOk = hasHebrew(hook) || shots.some(s => hasHebrew(s.voice ?? ""));
    const domainOk = checkDomain({ hook, shots, caption, cta }, caseData.mainOfferLabel);
    return { ok: true, hook, shots, caption, cta, hebrewOk, domainOk, elapsed };
  } catch (err) {
    return { ok: false, error: String(err), elapsed: Date.now() - t0 };
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────────
const VARIANTS = ["full", "compact", "compact_fewshot"];

console.log("========================================");
console.log("LLM RELIABILITY EXPERIMENT — QA REPORT");
console.log(`Model: ${MODEL}  |  Date: ${new Date().toISOString()}`);
console.log("========================================\n");

const summary = [];

for (const variant of VARIANTS) {
  console.log(`\n${"─".repeat(50)}`);
  console.log(`VARIANT: ${variant.toUpperCase()}`);
  console.log("─".repeat(50));

  for (const c of CASES) {
    process.stdout.write(`  [${c.id}] ... `);
    const r = await runOne(c, variant);
    if (!r.ok) {
      console.log(`FAIL (${r.elapsed}ms) — ${r.error}`);
      summary.push({ variant, id: c.id, ok: false, domainOk: false, hebrewOk: false, elapsed: r.elapsed });
    } else {
      const domainMark = r.domainOk ? "✓" : "✗";
      const hebrewMark = r.hebrewOk ? "✓" : "✗";
      console.log(`OK (${r.elapsed}ms) | domain:${domainMark} hebrew:${hebrewMark}`);
      console.log(`    hook: ${r.hook}`);
      console.log(`    shot1 visual: ${r.shots[0]?.visual}`);
      console.log(`    shot1 voice:  ${r.shots[0]?.voice}`);
      console.log(`    caption: ${r.caption}`);
      console.log(`    cta: ${r.cta}`);
      summary.push({ variant, id: c.id, ok: true, domainOk: r.domainOk, hebrewOk: r.hebrewOk, elapsed: r.elapsed });
    }
  }
}

console.log("\n\n========================================");
console.log("SUMMARY TABLE");
console.log("========================================");
console.log("variant          | case        | ok  | domain | hebrew | ms");
console.log("─────────────────┼─────────────┼─────┼────────┼────────┼──────");
for (const r of summary) {
  const v = r.variant.padEnd(16);
  const id = r.id.padEnd(11);
  const ok = r.ok ? "YES" : "NO ";
  const d = r.domainOk ? "  ✓   " : "  ✗   ";
  const h = r.hebrewOk ? "  ✓   " : "  ✗   ";
  console.log(`${v} | ${id} | ${ok} | ${d}| ${h}| ${r.elapsed}`);
}

// Score per variant
console.log("\nVariant domain pass rates:");
for (const v of VARIANTS) {
  const rows = summary.filter(r => r.variant === v && r.ok);
  const pass = rows.filter(r => r.domainOk).length;
  const total = rows.length;
  const avgMs = total ? Math.round(rows.reduce((a, b) => a + b.elapsed, 0) / total) : 0;
  console.log(`  ${v}: ${pass}/${total} domain OK  (avg ${avgMs}ms)`);
}
