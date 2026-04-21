import type { BusinessContentProfile } from "@/lib/services/business-content-profile.service";

export type OptimizerVideoPlan = {
  videoType: "SHORT" | "MID" | "FULL";
  durationSeconds: number;
  pace: "fast" | "medium" | "slow";
  structure: string[];
  hookStyle:
    | "pattern_break"
    | "pain_first"
    | "result_first"
    | "trust_first"
    | "offer_first";
  ctaStyle: "message_now" | "book_now" | "buy_now" | "follow" | "learn_more";
  platform: string;
  goal: string;
  contentAngle?: string;
};

export type OptimizerShot = {
  visual: string;
  voice: string;
};

export type OptimizeScriptInput = {
  hook: string;
  scriptText: string;
  caption: string;
  shots: OptimizerShot[];
  businessProfile: BusinessContentProfile;
  videoPlan: OptimizerVideoPlan;
};

export type OptimizeScriptResult = {
  hook: string;
  scriptText: string;
  caption: string;
  shots: OptimizerShot[];
  optimizationNotes: string[];
};

const FLUFF_PATTERNS = [
  /באמת מאוד מאוד/gi,
  /פשוט מאוד מאוד/gi,
  /ממש ממש/gi,
  /לגמרי לגמרי/gi,
  /כזה שיכול/gi,
  /מה שחשוב להבין זה ש/gi,
  /אפשר להגיד ש/gi,
  /בסופו של דבר/gi,
  /בצורה כזאת ש/gi,
];

const WEAK_HOOK_PREFIXES = [
  "אני רוצה לדבר",
  "בואו נדבר",
  "היום נדבר",
  "רציתי לספר",
  "אני אסביר",
  "יש לי משהו להגיד",
];

const TOO_GENERIC_CTA = [
  "דברו איתנו",
  "פנו אלינו",
  "למידע נוסף",
];

function normalizeSpaces(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function splitSentences(text: string) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((line) => normalizeSpaces(line))
    .filter(Boolean);
}

function trimSentenceLength(
  sentence: string,
  videoType: OptimizerVideoPlan["videoType"]
) {
  const maxLength =
    videoType === "SHORT" ? 75 : videoType === "MID" ? 110 : 150;

  if (sentence.length <= maxLength) {
    return sentence;
  }

  const sliced = sentence.slice(0, maxLength).trim();
  const lastSpace = sliced.lastIndexOf(" ");

  if (lastSpace < 35) {
    return `${sliced}...`;
  }

  return `${sliced.slice(0, lastSpace)}...`;
}

function removeFluff(text: string) {
  let result = text;

  FLUFF_PATTERNS.forEach((pattern) => {
    result = result.replace(pattern, "");
  });

  result = result
    .replace(/\s+,/g, ",")
    .replace(/\s+\./g, ".")
    .replace(/\s{2,}/g, " ");

  return normalizeSpaces(result);
}

function isWeakHook(hook: string) {
  const normalized = hook.trim().toLowerCase();
  return WEAK_HOOK_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function buildStrongerHook(
  hook: string,
  businessProfile: BusinessContentProfile,
  videoPlan: OptimizerVideoPlan
) {
  const cleaned = removeFluff(hook);

  if (!isWeakHook(cleaned) && cleaned.length <= 90) {
    return cleaned;
  }

  switch (businessProfile.hookPriority) {
    case "pain_first":
      return "אם זה עדיין לא עובד כמו שצריך — כנראה שאתם מפספסים את הדבר הזה.";
    case "result_first":
      return `ככה נראה תוכן שיודע להביא ${getGoalLabel(videoPlan.goal)}.`;
    case "trust_first":
      return "לפני שאתם בוחרים — יש משהו חשוב שכדאי לראות.";
    case "offer_first":
      return "אם חיפשתם דרך טובה יותר להתקדם — זה בשבילכם.";
    case "pattern_break":
    default:
      return "רגע לפני שאתם ממשיכים לגלול — זה בדיוק מה שצריך להבין.";
  }
}

function getGoalLabel(goal?: string) {
  switch (goal) {
    case "leads":
      return "יותר פניות";
    case "trust":
      return "יותר אמון";
    case "exposure":
      return "יותר חשיפה";
    case "sales":
      return "יותר מכירות";
    default:
      return "תוצאה טובה יותר";
  }
}

function getStrongCTA(
  ctaStyle: OptimizerVideoPlan["ctaStyle"],
  businessProfile: BusinessContentProfile
) {
  switch (ctaStyle) {
    case "message_now":
      return "אם זה רלוונטי לכם — שלחו הודעה עכשיו.";
    case "book_now":
      return "אם אתם רוצים להתקדם — זה הזמן לקבוע.";
    case "buy_now":
      return "אם זה מתאים לכם — אפשר לעבור עכשיו לשלב הבא.";
    case "follow":
      return "אם זה נתן לכם ערך — תעקבו לעוד תוכן כזה.";
    case "learn_more":
      return businessProfile.trustLevel === "high"
        ? "אם אתם רוצים להבין איך זה יכול להתאים גם לכם — שווה לבדוק עוד פרטים."
        : "אם אתם רוצים לשמוע עוד — אפשר להמשיך מכאן.";
    default:
      return "אם זה מדבר אליכם — זה הזמן לפעול.";
  }
}

function enforceSingleCTA(
  shots: OptimizerShot[],
  videoPlan: OptimizerVideoPlan,
  businessProfile: BusinessContentProfile
) {
  const strongCTA = getStrongCTA(videoPlan.ctaStyle, businessProfile);

  return shots.map((shot, index) => {
    const isLast = index === shots.length - 1;

    if (!isLast) {
      const cleanedVoice = TOO_GENERIC_CTA.reduce(
        (acc, phrase) => acc.replace(new RegExp(phrase, "gi"), ""),
        shot.voice
      );

      return {
        ...shot,
        voice: normalizeSpaces(cleanedVoice),
      };
    }

    return {
      ...shot,
      voice: strongCTA,
    };
  });
}

function tightenShots(
  shots: OptimizerShot[],
  videoPlan: OptimizerVideoPlan
): OptimizerShot[] {
  return shots.map((shot, index) => {
    let optimizedVoice = removeFluff(shot.voice);
    optimizedVoice = trimSentenceLength(optimizedVoice, videoPlan.videoType);

    if (index === 0) {
      optimizedVoice = trimSentenceLength(optimizedVoice, "SHORT");
    }

    return {
      visual: normalizeSpaces(shot.visual),
      voice: optimizedVoice,
    };
  });
}

function rebuildScriptText(hook: string, shots: OptimizerShot[]) {
  const lines: string[] = [];
  lines.push(hook);

  shots.forEach((shot, index) => {
    if (index === 0) return;
    if (!shot.voice) return;
    lines.push(shot.voice);
  });

  return `${lines.map((line) => normalizeSpaces(line)).filter(Boolean).join(". ")}.`;
}

function optimizeCaption(
  caption: string,
  videoPlan: OptimizerVideoPlan,
  businessProfile: BusinessContentProfile
) {
  let result = removeFluff(caption);

  const hasStrongAction = /(שלחו הודעה|תקבעו|תעקבו|לחצו|בדקו|התקדמו)/.test(result);

  if (!hasStrongAction) {
    result = getStrongCTA(videoPlan.ctaStyle, businessProfile);
  }

  if (videoPlan.videoType === "SHORT" && result.length > 75) {
    result = trimSentenceLength(result, "SHORT");
  }

  return normalizeSpaces(result);
}

function enforceIsraeliDirectness(
  shots: OptimizerShot[],
  businessProfile: BusinessContentProfile
) {
  return shots.map((shot) => {
    let voice = shot.voice;

    if (businessProfile.brandPersona === "professional") {
      voice = voice
        .replace(/זה משהו שיכול לעזור/gi, "זה יכול לעזור")
        .replace(/כדאי לכם אולי/gi, "כדאי לכם");
    } else {
      voice = voice
        .replace(/בצורה מקצועית ואמינה/gi, "בצורה ברורה ואמינה")
        .replace(/להתקדם לכיוון/gi, "להתקדם");
    }

    return {
      ...shot,
      voice: normalizeSpaces(voice),
    };
  });
}

function enforceHookInFirstShot(
  shots: OptimizerShot[],
  hook: string
): OptimizerShot[] {
  if (!shots.length) return shots;

  const first = shots[0];

  return [
    {
      ...first,
      voice: hook,
    },
    ...shots.slice(1),
  ];
}

export function optimizeScript(
  input: OptimizeScriptInput
): OptimizeScriptResult {
  const notes: string[] = [];

  const strongerHook = buildStrongerHook(
    input.hook,
    input.businessProfile,
    input.videoPlan
  );

  if (strongerHook !== input.hook) {
    notes.push("Hook strengthened");
  }

  let optimizedShots = tightenShots(input.shots, input.videoPlan);
  notes.push("Shot voice tightened");

  optimizedShots = enforceIsraeliDirectness(
    optimizedShots,
    input.businessProfile
  );
  notes.push("Israeli directness applied");

  optimizedShots = enforceSingleCTA(
    optimizedShots,
    input.videoPlan,
    input.businessProfile
  );
  notes.push("Single CTA enforced");

  optimizedShots = enforceHookInFirstShot(optimizedShots, strongerHook);

  const optimizedScriptText = rebuildScriptText(strongerHook, optimizedShots);
  const optimizedCaption = optimizeCaption(
    input.caption,
    input.videoPlan,
    input.businessProfile
  );

  return {
    hook: strongerHook,
    scriptText: optimizedScriptText,
    caption: optimizedCaption,
    shots: optimizedShots,
    optimizationNotes: notes,
  };
}