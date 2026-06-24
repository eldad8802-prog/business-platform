/**
 * Bot Builder — new-world descriptive layer (Stage 1).
 *
 * Pure types + validators for the BusinessBotProfile branch (voice / personality
 * / approach) and the thin BusinessBot identity (displayName / avatar).
 *
 * HARD BOUNDARY: nothing here is read by the conversation pipeline or the
 * response-planner. These values are descriptive/advisory only. Persistence is
 * Json columns on BusinessBotProfile, but the shape is constrained here with
 * allow-lists — never free-form JSON.
 *
 * Validation doctrine:
 *   - Structural / size errors are HARD (caller returns 400).
 *   - Unknown enum members are dropped silently (forgiving), so stored data is
 *     always clean even if an older client sends a value we no longer accept.
 */

export const PROFILE_VERSION = 1 as const;

// ── Allow-lists (RECOMMENDATION values; labels live in *_OPTIONS below) ───────
export const BOT_TONES = ["formal", "friendly", "casual"] as const;
export type BotTone = (typeof BOT_TONES)[number];

export const BOT_VERBOSITIES = ["short", "medium", "detailed"] as const;
export type BotVerbosity = (typeof BOT_VERBOSITIES)[number];

export const BOT_SALE_STYLES = ["none", "soft", "opportunistic", "active"] as const;
export type BotSaleStyle = (typeof BOT_SALE_STYLES)[number];

export const BOT_INITIATIVE_LEVELS = [
  "reactive",
  "informative",
  "suggestive",
  "proactive",
] as const;
export type BotInitiativeLevel = (typeof BOT_INITIATIVE_LEVELS)[number];

export const BOT_TRAITS = [
  "professional",
  "friendly",
  "premium",
  "family",
  "funny",
  "direct",
  "patient",
  "energetic",
] as const;
export type BotTrait = (typeof BOT_TRAITS)[number];

export const BOT_LANGUAGES = ["he", "ar", "en", "ru"] as const;
export type BotLanguage = (typeof BOT_LANGUAGES)[number];

export const BOT_AUDIENCE_TAGS = [
  "private",
  "business",
  "parents",
  "young",
  "seniors",
  "new_customers",
  "returning_customers",
] as const;
export type BotAudienceTag = (typeof BOT_AUDIENCE_TAGS)[number];

export const BOT_PRIORITIES = [
  "customer_experience",
  "fast_service",
  "closing_deals",
] as const;
export type BotPriority = (typeof BOT_PRIORITIES)[number];

// ── Block shapes ─────────────────────────────────────────────────────────────
export type BotVoiceConfig = {
  tone?: BotTone;
  languages?: BotLanguage[];
  audienceTags?: BotAudienceTag[];
};

export type BotPersonalityConfig = {
  traits?: BotTrait[];
  verbosity?: BotVerbosity;
};

export type BotProfileObjection = {
  label: string;
  response: string;
};

export type BotApproachConfig = {
  saleStyle?: BotSaleStyle;
  initiativeLevel?: BotInitiativeLevel;
  priorities?: BotPriority[];
  objections?: BotProfileObjection[];
};

export type BotProfileConfig = {
  voice?: BotVoiceConfig;
  personality?: BotPersonalityConfig;
  approach?: BotApproachConfig;
};

export type BotIdentity = {
  displayName: string | null;
  avatar: string | null;
};

// ── Size limits ──────────────────────────────────────────────────────────────
export const MAX_DISPLAY_NAME_CHARS = 80;
export const MAX_AVATAR_CHARS = 16;
export const MAX_OBJECTIONS = 12;
export const MAX_OBJECTION_LABEL_CHARS = 120;
export const MAX_OBJECTION_RESPONSE_CHARS = 600;

// ── Small helpers ────────────────────────────────────────────────────────────
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}

function oneOf<T extends string>(
  value: unknown,
  allow: readonly T[]
): T | undefined {
  return typeof value === "string" && (allow as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/** Filter an array to allow-list members, preserving order, de-duplicated. */
function arrayOf<T extends string>(value: unknown, allow: readonly T[]): T[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of value) {
    const v = oneOf(item, allow);
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

type Ok<T> = { ok: true; value: T };
type Err = { ok: false; error: string };
export type Validated<T> = Ok<T> | Err;

// ── Block validators (forgiving on enums, hard on structure/size) ────────────
export function validateVoice(raw: unknown): Validated<BotVoiceConfig> {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (!isPlainObject(raw)) return { ok: false, error: "voice must be an object" };
  const out: BotVoiceConfig = {};
  const tone = oneOf(raw.tone, BOT_TONES);
  if (tone) out.tone = tone;
  const languages = arrayOf(raw.languages, BOT_LANGUAGES);
  if (languages.length) out.languages = languages;
  const audienceTags = arrayOf(raw.audienceTags, BOT_AUDIENCE_TAGS);
  if (audienceTags.length) out.audienceTags = audienceTags;
  return { ok: true, value: out };
}

export function validatePersonality(
  raw: unknown
): Validated<BotPersonalityConfig> {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (!isPlainObject(raw)) {
    return { ok: false, error: "personality must be an object" };
  }
  const out: BotPersonalityConfig = {};
  const traits = arrayOf(raw.traits, BOT_TRAITS);
  if (traits.length) out.traits = traits;
  const verbosity = oneOf(raw.verbosity, BOT_VERBOSITIES);
  if (verbosity) out.verbosity = verbosity;
  return { ok: true, value: out };
}

export function validateApproach(raw: unknown): Validated<BotApproachConfig> {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (!isPlainObject(raw)) {
    return { ok: false, error: "approach must be an object" };
  }
  const out: BotApproachConfig = {};
  const saleStyle = oneOf(raw.saleStyle, BOT_SALE_STYLES);
  if (saleStyle) out.saleStyle = saleStyle;
  const initiativeLevel = oneOf(raw.initiativeLevel, BOT_INITIATIVE_LEVELS);
  if (initiativeLevel) out.initiativeLevel = initiativeLevel;
  const priorities = arrayOf(raw.priorities, BOT_PRIORITIES);
  if (priorities.length) out.priorities = priorities;

  if (raw.objections !== undefined) {
    if (!Array.isArray(raw.objections)) {
      return { ok: false, error: "approach.objections must be an array" };
    }
    if (raw.objections.length > MAX_OBJECTIONS) {
      return {
        ok: false,
        error: `approach.objections exceeds ${MAX_OBJECTIONS} entries`,
      };
    }
    const objections: BotProfileObjection[] = [];
    for (const entry of raw.objections) {
      if (!isPlainObject(entry)) {
        return { ok: false, error: "each objection must be an object" };
      }
      const label = typeof entry.label === "string" ? entry.label.trim() : "";
      const response =
        typeof entry.response === "string" ? entry.response.trim() : "";
      if (!label) continue; // drop empty rows (forgiving)
      if (label.length > MAX_OBJECTION_LABEL_CHARS) {
        return { ok: false, error: "objection label is too long" };
      }
      if (response.length > MAX_OBJECTION_RESPONSE_CHARS) {
        return { ok: false, error: "objection response is too long" };
      }
      objections.push({ label, response });
    }
    if (objections.length) out.objections = objections;
  }
  return { ok: true, value: out };
}

// ── Full profile validator ───────────────────────────────────────────────────
export function validateProfile(raw: unknown): Validated<BotProfileConfig> {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (!isPlainObject(raw)) {
    return { ok: false, error: "profile must be an object" };
  }
  const value: BotProfileConfig = {};

  const voice = validateVoice(raw.voice);
  if (!voice.ok) return voice;
  if (Object.keys(voice.value).length) value.voice = voice.value;

  const personality = validatePersonality(raw.personality);
  if (!personality.ok) return personality;
  if (Object.keys(personality.value).length) value.personality = personality.value;

  const approach = validateApproach(raw.approach);
  if (!approach.ok) return approach;
  if (Object.keys(approach.value).length) value.approach = approach.value;

  return { ok: true, value };
}

// ── Identity validators ──────────────────────────────────────────────────────
function validateOptionalShortString(
  raw: unknown,
  max: number,
  field: string
): Validated<string | null> {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") {
    return { ok: false, error: `${field} must be a string or null` };
  }
  const trimmed = raw.trim();
  if (trimmed.length > max) {
    return { ok: false, error: `${field} is too long` };
  }
  return { ok: true, value: trimmed === "" ? null : trimmed };
}

export type BotIdentityPatch = {
  displayName?: string | null;
  avatar?: string | null;
};

export type BotPatch = BotIdentityPatch & { profile?: BotProfileConfig };

/**
 * Validate a PATCH /api/business/bot body. Only provided keys are returned, so
 * the API can apply a partial update. Returns a clean, allow-listed value.
 */
export function validateBotPatch(body: unknown): Validated<BotPatch> {
  if (!isPlainObject(body)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const patch: BotPatch = {};

  if (Object.prototype.hasOwnProperty.call(body, "displayName")) {
    const r = validateOptionalShortString(
      body.displayName,
      MAX_DISPLAY_NAME_CHARS,
      "displayName"
    );
    if (!r.ok) return r;
    patch.displayName = r.value;
  }

  if (Object.prototype.hasOwnProperty.call(body, "avatar")) {
    const r = validateOptionalShortString(
      body.avatar,
      MAX_AVATAR_CHARS,
      "avatar"
    );
    if (!r.ok) return r;
    patch.avatar = r.value;
  }

  if (Object.prototype.hasOwnProperty.call(body, "profile")) {
    const r = validateProfile(body.profile);
    if (!r.ok) return r;
    patch.profile = r.value;
  }

  if (
    patch.displayName === undefined &&
    patch.avatar === undefined &&
    patch.profile === undefined
  ) {
    return { ok: false, error: "No valid fields to update" };
  }

  return { ok: true, value: patch };
}

// ── Read-side coercion (forgiving) ───────────────────────────────────────────
/** Sanitize a stored Json block on read; always returns a clean object. */
export function coerceVoice(raw: unknown): BotVoiceConfig {
  const r = validateVoice(raw);
  return r.ok ? r.value : {};
}
export function coercePersonality(raw: unknown): BotPersonalityConfig {
  const r = validatePersonality(raw);
  return r.ok ? r.value : {};
}
export function coerceApproach(raw: unknown): BotApproachConfig {
  const r = validateApproach(raw);
  return r.ok ? r.value : {};
}

export function coerceStoredProfile(row: {
  voice?: unknown;
  personality?: unknown;
  approach?: unknown;
} | null): BotProfileConfig {
  if (!row) return {};
  const out: BotProfileConfig = {};
  const voice = coerceVoice(row.voice);
  if (Object.keys(voice).length) out.voice = voice;
  const personality = coercePersonality(row.personality);
  if (Object.keys(personality).length) out.personality = personality;
  const approach = coerceApproach(row.approach);
  if (Object.keys(approach).length) out.approach = approach;
  return out;
}

// ── Content predicates (used by the hub area-state map) ──────────────────────
export function hasVoiceContent(v: BotVoiceConfig | undefined): boolean {
  return !!v && (!!v.tone || !!v.languages?.length || !!v.audienceTags?.length);
}
export function hasPersonalityContent(
  p: BotPersonalityConfig | undefined
): boolean {
  return !!p && (!!p.traits?.length || !!p.verbosity);
}
export function hasApproachContent(a: BotApproachConfig | undefined): boolean {
  return (
    !!a &&
    (!!a.saleStyle ||
      !!a.initiativeLevel ||
      !!a.priorities?.length ||
      !!a.objections?.length)
  );
}

// ── UI option lists (single source for labels; Hebrew) ───────────────────────
export const BOT_TONE_OPTIONS: ReadonlyArray<{ value: BotTone; label: string }> = [
  { value: "formal", label: "רשמי" },
  { value: "friendly", label: "חברי" },
  { value: "casual", label: "קליל" },
];

export const BOT_VERBOSITY_OPTIONS: ReadonlyArray<{
  value: BotVerbosity;
  label: string;
  hint: string;
}> = [
  { value: "short", label: "תשובות קצרות", hint: "לעניין, בלי עודף מילים" },
  { value: "medium", label: "בינוניות", hint: "מאוזן — מספיק מידע, לא מציף" },
  { value: "detailed", label: "מפורטות", hint: "מסביר לעומק, נותן הקשר" },
];

export const BOT_TRAIT_OPTIONS: ReadonlyArray<{ value: BotTrait; label: string }> = [
  { value: "professional", label: "מקצועי" },
  { value: "friendly", label: "חברי" },
  { value: "premium", label: "יוקרתי" },
  { value: "family", label: "משפחתי" },
  { value: "funny", label: "מצחיק" },
  { value: "direct", label: "ישיר" },
  { value: "patient", label: "סבלני" },
  { value: "energetic", label: "אנרגטי" },
];

export const BOT_LANGUAGE_OPTIONS: ReadonlyArray<{
  value: BotLanguage;
  label: string;
}> = [
  { value: "he", label: "עברית" },
  { value: "ar", label: "ערבית" },
  { value: "en", label: "אנגלית" },
  { value: "ru", label: "רוסית" },
];

export const BOT_AUDIENCE_OPTIONS: ReadonlyArray<{
  value: BotAudienceTag;
  label: string;
}> = [
  { value: "private", label: "פרטיים" },
  { value: "business", label: "עסקים" },
  { value: "parents", label: "הורים" },
  { value: "young", label: "צעירים" },
  { value: "seniors", label: "מבוגרים" },
  { value: "new_customers", label: "לקוחות חדשים" },
  { value: "returning_customers", label: "לקוחות קיימים" },
];

export const BOT_SALE_STYLE_OPTIONS: ReadonlyArray<{
  value: BotSaleStyle;
  label: string;
  hint: string;
}> = [
  { value: "none", label: "לא מוכר בכלל", hint: "רק עונה ומשרת" },
  { value: "soft", label: "מציע בעדינות", hint: "רומז כשמתאים, בלי לחץ" },
  { value: "opportunistic", label: "מציע כשיש התאמה", hint: "מזהה הזדמנות ומציע" },
  { value: "active", label: "אקטיבי במכירה", hint: "דוחף למכירה ביוזמתו" },
];

export const BOT_INITIATIVE_OPTIONS: ReadonlyArray<{
  value: BotInitiativeLevel;
  label: string;
}> = [
  { value: "reactive", label: "מחכה שישאלו" },
  { value: "informative", label: "מציע מידע רלוונטי" },
  { value: "suggestive", label: "מציע שירותים" },
  { value: "proactive", label: "יוזם המשך שיחה" },
];

export const BOT_PRIORITY_OPTIONS: ReadonlyArray<{
  value: BotPriority;
  label: string;
}> = [
  { value: "customer_experience", label: "חוויית לקוח" },
  { value: "fast_service", label: "שירות מהיר" },
  { value: "closing_deals", label: "סגירת עסקאות" },
];
