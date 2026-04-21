type Strategy =
  | "pain"
  | "urgency"
  | "authority"
  | "social_proof"
  | "mistake"
  | "opportunity"
  | "desire"
  | "trust"
  | "comparison"
  | "objection_break"
  | "curiosity"
  | "clarity";

type Tone = "soft" | "balanced" | "aggressive";

type PackagingInput = {
  script: string;
  strategy: Strategy;
  angle: string;
  tone: Tone;
  businessCategory?: string;
  city?: string;
};

type PackagingResult = {
  hookText: string;
  captionLines: string[];
  thumbnailText: string;
  musicType: "calm" | "trendy" | "emotional";
  hashtags: string[];
};

function buildHookText(input: PackagingInput) {
  if (input.strategy === "pain") {
    if (input.angle === "pressure") return "נמאס לך מזה?";
    if (input.angle === "uncertainty") return "לא בטוח מה לעשות?";
    return "זה מה שעוצר אותך";
  }

  if (input.strategy === "urgency") {
    return "אל תחכה עם זה";
  }

  if (input.strategy === "mistake") {
    return "אתה עושה טעות";
  }

  if (input.strategy === "authority") {
    return "מה שלא סיפרו לך";
  }

  if (input.strategy === "social_proof") {
    return "כולם כבר שם";
  }

  if (input.strategy === "opportunity") {
    return "זו ההזדמנות שלך";
  }

  return "תקשיב רגע";
}

function buildCaptions(script: string) {
  return script
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4);
}

function buildThumbnail(input: PackagingInput) {
  if (input.strategy === "pain") return "נמאס לך?";
  if (input.strategy === "urgency") return "עכשיו או מאוחר מדי";
  if (input.strategy === "mistake") return "טעות גדולה";
  if (input.strategy === "authority") return "האמת על זה";
  if (input.strategy === "social_proof") return "כולם כבר שם";
  if (input.strategy === "opportunity") return "הזדמנות אמיתית";

  return "זה בשבילך";
}

function buildMusicType(
  tone: Tone,
  strategy: Strategy
): "calm" | "trendy" | "emotional" {
  if (strategy === "urgency") return "trendy";
  if (strategy === "pain") return "emotional";
  if (tone === "soft") return "calm";
  if (tone === "aggressive") return "trendy";
  return "emotional";
}

function buildHashtags(input: PackagingInput) {
  const base: string[] = ["#עסקים", "#שיווק"];

  if (input.strategy === "pain") base.push("#בלי_לחץ");
  if (input.strategy === "urgency") base.push("#עכשיו");
  if (input.strategy === "authority") base.push("#מקצועיות");
  if (input.strategy === "mistake") base.push("#טעות_נפוצה");
  if (input.strategy === "opportunity") base.push("#הזדמנות");

  if (input.script.includes("צפה")) {
    base.push("#צפיות", "#רילס");
  }

  if (input.script.includes("שלח")) {
    base.push("#לידים", "#שלח_הודעה");
  }

  if (input.script.includes("התקשר")) {
    base.push("#התקשר_עכשיו");
  }

  if (input.businessCategory) {
    base.push(`#${input.businessCategory.replace(/\s+/g, "_")}`);
  }

  if (input.city) {
    base.push(`#${input.city.replace(/\s+/g, "_")}`);
  }

  return Array.from(new Set(base));
}

export function runPackagingEngine(
  input: PackagingInput
): PackagingResult {
  return {
    hookText: buildHookText(input),
    captionLines: buildCaptions(input.script),
    thumbnailText: buildThumbnail(input),
    musicType: buildMusicType(input.tone, input.strategy),
    hashtags: buildHashtags(input),
  };
}