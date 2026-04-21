export type CreatorInputSource =
  | "self_filming"
  | "existing_video"
  | "existing_images"
  | "voice_recording"
  | "no_assets_yet";

export type CreatorContentFocus =
  | "process"
  | "final_result"
  | "self_talking"
  | "product_showcase"
  | "before_after"
  | "place_or_space";

export type CreatorProductionPreference =
  | "easy_and_fast"
  | "can_talk_to_camera"
  | "prefers_voiceover"
  | "prefers_no_face"
  | "can_shoot_new_content";

export type CreatorContextProfile = {
  inputSource: CreatorInputSource;
  contentFocus: CreatorContentFocus[];
  productionPreference: CreatorProductionPreference[];
  businessEmphasis: string[];
  constraints: string[];
  summaryForEngines: string;
};

function normalizeText(value: string) {
  return value.trim().toLowerCase();
}

function includesAny(text: string, keywords: string[]) {
  return keywords.some((keyword) => text.includes(keyword));
}

function pushUnique<T>(list: T[], value: T) {
  if (!list.includes(value)) {
    list.push(value);
  }
}

function detectInputSource(text: string): CreatorInputSource {
  if (
    includesAny(text, [
      "יש לי סרטון",
      "יש לי וידאו",
      "סרטון קיים",
      "וידאו קיים",
      "כבר צילמתי",
      "כבר יש לי סרטון",
    ])
  ) {
    return "existing_video";
  }

  if (
    includesAny(text, [
      "יש לי תמונות",
      "יש לי תמונה",
      "תמונות קיימות",
      "תמונה קיימת",
      "יש לי צילומים",
    ])
  ) {
    return "existing_images";
  }

  if (
    includesAny(text, [
      "הקלטה",
      "הקלטת קול",
      "קול",
      "קריינות",
      "אודיו",
      "voice",
    ])
  ) {
    return "voice_recording";
  }

  if (
    includesAny(text, [
      "אני אצלם",
      "אני מצלם",
      "אצלם",
      "מצלם",
      "להצטלם",
      "אעלה את עצמי",
      "אני אעלה את עצמי",
      "אני רוצה לצלם",
      "אצלם את עצמי",
      "אני מכין",
      "אני עושה",
    ])
  ) {
    return "self_filming";
  }

  return "no_assets_yet";
}

function detectContentFocus(text: string): CreatorContentFocus[] {
  const result: CreatorContentFocus[] = [];

  if (
    includesAny(text, [
      "תהליך",
      "מכין",
      "הכנה",
      "איך עושים",
      "איך מכינים",
      "מאחורי הקלעים",
      "שלבים",
    ])
  ) {
    pushUnique(result, "process");
  }

  if (
    includesAny(text, [
      "תוצאה",
      "מוכן",
      "סופי",
      "אחרי",
      "לפני ואחרי",
      "לפני אחרי",
      "התוצאה הסופית",
    ])
  ) {
    pushUnique(result, "final_result");
  }

  if (
    includesAny(text, [
      "אני אדבר",
      "אני מסביר",
      "מדבר",
      "מסביר",
      "פונה למצלמה",
      "דיבור למצלמה",
      "מולי מצלמה",
    ])
  ) {
    pushUnique(result, "self_talking");
  }

  if (
    includesAny(text, [
      "מוצר",
      "שירות",
      "מנה",
      "עסק",
      "להראות את המוצר",
      "להראות את השירות",
    ])
  ) {
    pushUnique(result, "product_showcase");
  }

  if (
    includesAny(text, [
      "לפני ואחרי",
      "לפני אחרי",
      "השוואה",
      "תראה שינוי",
      "שינוי",
    ])
  ) {
    pushUnique(result, "before_after");
  }

  if (
    includesAny(text, [
      "מקום",
      "חלל",
      "קליניקה",
      "מסעדה",
      "מטבח",
      "חנות",
      "העסק עצמו",
    ])
  ) {
    pushUnique(result, "place_or_space");
  }

  if (result.length === 0) {
    pushUnique(result, "product_showcase");
  }

  return result;
}

function detectProductionPreference(
  text: string,
  inputSource: CreatorInputSource
): CreatorProductionPreference[] {
  const result: CreatorProductionPreference[] = [];

  if (
    includesAny(text, [
      "קל",
      "פשוט",
      "מהיר",
      "קצר",
      "בלי יותר מדי",
      "לא מסובך",
      "בקלות",
    ])
  ) {
    pushUnique(result, "easy_and_fast");
  }

  if (
    includesAny(text, [
      "אני אדבר",
      "מדבר למצלמה",
      "אני מול המצלמה",
      "אני מסביר",
      "אפשר לדבר",
    ])
  ) {
    pushUnique(result, "can_talk_to_camera");
  }

  if (
    includesAny(text, [
      "קריינות",
      "voiceover",
      "ווייס אובר",
      "רק קול",
      "הקלטת קול",
      "אני רוצה קול",
    ])
  ) {
    pushUnique(result, "prefers_voiceover");
  }

  if (
    includesAny(text, [
      "בלי פנים",
      "לא רוצה להצטלם",
      "לא בא לי להצטלם",
      "לא רוצה פנים",
      "בלי להראות אותי",
      "בלי להראות את עצמי",
    ])
  ) {
    pushUnique(result, "prefers_no_face");
  }

  if (inputSource === "self_filming") {
    pushUnique(result, "can_shoot_new_content");
  }

  return result;
}

function detectBusinessEmphasis(text: string): string[] {
  const result: string[] = [];

  if (includesAny(text, ["זול", "מחיר", "מחירים", "עלות", "משתלם"])) {
    pushUnique(result, "price");
  }

  if (includesAny(text, ["איכות", "איכותי", "איכותית"])) {
    pushUnique(result, "quality");
  }

  if (includesAny(text, ["מהיר", "מהירות", "מהר"])) {
    pushUnique(result, "speed");
  }

  if (includesAny(text, ["מקצועי", "מקצועית", "מקצועיות"])) {
    pushUnique(result, "professionalism");
  }

  if (includesAny(text, ["טעים", "טעימה", "אוכל", "מנה", "שקשוקה"])) {
    pushUnique(result, "taste");
  }

  if (includesAny(text, ["ניסיון", "ותק", "התמחות"])) {
    pushUnique(result, "experience");
  }

  if (includesAny(text, ["תוצאה", "תוצאות", "שינוי"])) {
    pushUnique(result, "results");
  }

  if (includesAny(text, ["אמינות", "אמין", "אמינה", "סומכים", "ביטחון"])) {
    pushUnique(result, "trust");
  }

  return result;
}

function detectConstraints(text: string): string[] {
  const result: string[] = [];

  if (
    includesAny(text, [
      "רק קצר",
      "קצר בלבד",
      "משהו קצר",
      "לא ארוך",
      "קצר",
    ])
  ) {
    pushUnique(result, "short_content_only");
  }

  if (
    includesAny(text, [
      "לא לצלם חדש",
      "לא רוצה לצלם",
      "בלי לצלם חדש",
      "רק ממה שיש",
      "לא אצלם",
    ])
  ) {
    pushUnique(result, "no_new_filming");
  }

  if (
    includesAny(text, [
      "בלי קול",
      "לא רוצה לדבר",
      "בלי לדבר",
      "ללא קול",
    ])
  ) {
    pushUnique(result, "no_voice");
  }

  if (
    includesAny(text, [
      "בלי פנים",
      "לא רוצה להצטלם",
      "בלי להראות אותי",
    ])
  ) {
    pushUnique(result, "no_face");
  }

  return result;
}

function buildSummaryForEngines(profile: {
  inputSource: CreatorInputSource;
  contentFocus: CreatorContentFocus[];
  productionPreference: CreatorProductionPreference[];
  businessEmphasis: string[];
  constraints: string[];
}) {
  const segments: string[] = [];

  segments.push(`Input source: ${profile.inputSource}.`);

  if (profile.contentFocus.length > 0) {
    segments.push(`Focus: ${profile.contentFocus.join(", ")}.`);
  }

  if (profile.productionPreference.length > 0) {
    segments.push(
      `Production preference: ${profile.productionPreference.join(", ")}.`
    );
  }

  if (profile.businessEmphasis.length > 0) {
    segments.push(`Business emphasis: ${profile.businessEmphasis.join(", ")}.`);
  }

  if (profile.constraints.length > 0) {
    segments.push(`Constraints: ${profile.constraints.join(", ")}.`);
  }

  return segments.join(" ");
}

export function interpretCreatorContext(
  raw: string
): CreatorContextProfile {
  const text = normalizeText(raw);

  const inputSource = detectInputSource(text);
  const contentFocus = detectContentFocus(text);
  const productionPreference = detectProductionPreference(text, inputSource);
  const businessEmphasis = detectBusinessEmphasis(text);
  const constraints = detectConstraints(text);

  return {
    inputSource,
    contentFocus,
    productionPreference,
    businessEmphasis,
    constraints,
    summaryForEngines: buildSummaryForEngines({
      inputSource,
      contentFocus,
      productionPreference,
      businessEmphasis,
      constraints,
    }),
  };
}