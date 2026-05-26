/**
 * Product façade: content archetypes → engine fields (goal + contentAngle).
 * Medium is derived from `creationEntryMode` on `/content`. No API / engine change.
 */

export type EngineGoal = "leads" | "trust" | "exposure" | "sales";

export type EngineContentAngle =
  | "show_result"
  | "explain"
  | "show_difference"
  | "attention"
  | "trust"
  | "cta";

/** Matches `CreationEntryMode` on `/content` (string to avoid circular imports). */
export type CreationEntryModeId =
  | "ai_full_video"
  | "reel_from_assets"
  | "talking_head"
  | "post_or_carousel"
  | "system_recommended";

export type ArchetypeMedium = "video" | "post" | "image";

export type ArchetypeCard = {
  id: string;
  title: string;
  subtitle: string;
};

export function getArchetypeMediumFromCreationEntry(
  creationEntryMode?: string
): ArchetypeMedium {
  if (creationEntryMode === "post_or_carousel") return "post";
  // Future image entry: e.g. `creationEntryMode === "image_single"` → "image"
  return "video";
}

export function archetypeIdMatchesMedium(
  id: string | undefined,
  medium: ArchetypeMedium
): boolean {
  if (!id) return false;
  if (medium === "video") return id.startsWith("video.");
  if (medium === "post") return id.startsWith("post.");
  if (medium === "image") return id.startsWith("image.");
  return false;
}

/** Video set: `ai_full_video` | `reel_from_assets` | `talking_head` | `system_recommended` */
export const VIDEO_ARCHETYPE_CARDS: ArchetypeCard[] = [
  {
    id: "video.stop_scroll",
    title: "סרטון שעוצר אנשים",
    subtitle: "עוצר גלילה בשנייה ומכניס לסיפור בלי יומרנות",
  },
  {
    id: "video.trust",
    title: "סרטון שבונה אמון",
    subtitle: "רגוע, ברור, מרגיש אמיתי — כמו שיחה קצרה מול המצלמה",
  },
  {
    id: "video.opinion",
    title: "סרטון עם דעה",
    subtitle: "עמדה חדה שמזיזה שיח בלי להרגיש כמו מודעה",
  },
  {
    id: "video.creator",
    title: "סרטון בסגנון יוצר תוכן",
    subtitle: "קרוב, חי, בלי תחושת פרסומת",
  },
  {
    id: "video.explain",
    title: "סרטון שמסביר משהו",
    subtitle: "מסדרים בראש של הצופה בלי להעמיס",
  },
  {
    id: "video.leads",
    title: "סרטון שמנסה להביא פניות",
    subtitle: "צעד הבא ברור — בלי לחץ מלאכותי ובלי \"קנה עכשיו\" צועק",
  },
];

export const POST_ARCHETYPE_CARDS: ArchetypeCard[] = [
  {
    id: "post.value",
    title: "פוסט שנותן ערך",
    subtitle: "משהו ששווה לשמור או לשתף — לא סתם עוד שורה בפיד",
  },
  {
    id: "post.opinion",
    title: "פוסט עם דעה",
    subtitle: "נוקב, אנושי, מתאים לשיחה ברשתות",
  },
  {
    id: "post.trust",
    title: "פוסט שבונה אמון",
    subtitle: "שקיפות, ניסיון, תחושה בטוחה לפני החלטה",
  },
  {
    id: "post.story",
    title: "פוסט שמספר סיפור קצר",
    subtitle: "רגע אחד, סיטואציה, טוויסט קטן — מחזיקים עד הסוף",
  },
  {
    id: "post.offer",
    title: "פוסט שמציג הצעה",
    subtitle: "מסגרים הצעה בצורה נעימה וברורה בלי תחושת קטלוג",
  },
  {
    id: "post.carousel_explainer",
    title: "קרוסלה שמסבירה שלב־שלב",
    subtitle: "שקופה אחת אחת — מובילים את העין בלי לבלבל",
  },
];

/** Reserved for a future image entry branch; mapping is live for safe IDs in storage. */
export const IMAGE_ARCHETYPE_CARDS: ArchetypeCard[] = [
  {
    id: "image.product",
    title: "תמונה שמציגה מוצר",
    subtitle: "נקי, חד, מסר אחד מרכזי",
  },
  {
    id: "image.before_after",
    title: "תמונת לפני/אחרי",
    subtitle: "הוכחה ויזואלית שמרגישה אמינה",
  },
  {
    id: "image.short_caption",
    title: "תמונה עם מסר קצר",
    subtitle: "משפט אחד חזק על גבי ויזואל",
  },
  {
    id: "image.premium",
    title: "תמונה premium",
    subtitle: "תחושת מותג יוקרתי ומדויק",
  },
  {
    id: "image.authentic",
    title: "תמונה אותנטית מהעסק",
    subtitle: "מאחורי הקלעים, אנשים, מקום — לא סטוק גנרי",
  },
];

export function getArchetypeCardsForMedium(medium: ArchetypeMedium): ArchetypeCard[] {
  switch (medium) {
    case "post":
      return POST_ARCHETYPE_CARDS;
    case "image":
      return IMAGE_ARCHETYPE_CARDS;
    default:
      return VIDEO_ARCHETYPE_CARDS;
  }
}

export function mapContentArchetypeToGoalAngle(
  id: string | undefined
): { goal: EngineGoal; contentAngle: EngineContentAngle } | null {
  switch (id) {
    case "video.stop_scroll":
      return { goal: "exposure", contentAngle: "attention" };
    case "video.trust":
      return { goal: "trust", contentAngle: "trust" };
    case "video.opinion":
      return { goal: "exposure", contentAngle: "show_difference" };
    case "video.creator":
      return { goal: "trust", contentAngle: "explain" };
    case "video.explain":
      return { goal: "trust", contentAngle: "explain" };
    case "video.leads":
      return { goal: "leads", contentAngle: "cta" };

    case "post.value":
      return { goal: "trust", contentAngle: "explain" };
    case "post.opinion":
      return { goal: "exposure", contentAngle: "show_difference" };
    case "post.trust":
      return { goal: "trust", contentAngle: "trust" };
    case "post.story":
      return { goal: "trust", contentAngle: "explain" };
    case "post.offer":
      return { goal: "leads", contentAngle: "cta" };
    case "post.carousel_explainer":
      return { goal: "trust", contentAngle: "explain" };

    case "image.product":
      return { goal: "sales", contentAngle: "show_result" };
    case "image.before_after":
      return { goal: "trust", contentAngle: "show_result" };
    case "image.short_caption":
      return { goal: "exposure", contentAngle: "attention" };
    case "image.premium":
      return { goal: "trust", contentAngle: "trust" };
    case "image.authentic":
      return { goal: "trust", contentAngle: "explain" };

    default:
      return null;
  }
}
