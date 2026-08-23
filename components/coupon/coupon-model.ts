/**
 * Coupon continuity model — the single object that threads through the whole
 * experience (business creation → published) and the consumer journey
 * (marketplace → public page → personal coupon). Design layer, no backend.
 * Encodes the 6 locked continuity decisions.
 */

import type { CouponThema } from "@/lib/design/coupon-consumer";
import { SCOPE_WHOLE_BUSINESS } from "@/lib/revenue/coupon-benefit";

export { SCOPE_WHOLE_BUSINESS };

export type Direction = "discount" | "gift" | "more" | "price" | "punchcard" | "opening";
export type CatKey = "coffee" | "pizza" | "gem" | "spark" | "glass" | "activity" | "wrench";

/** Benefit types and their validation live server-side too — one shared authority. */
import type { BenefitType } from "@/lib/revenue/coupon-benefit";
export type { BenefitType };

/**
 * A business as shown on a coupon. Every text field is nullable because the
 * card must show real data or nothing at all (COUPON-04) — there is no longer a
 * "העסק שלך" / "תל אביב" fallback that could reach a customer.
 */
export type Business = {
  name: string | null;
  city: string | null;
  address: string | null;
  hours: string | null;
  logo: string;
  thema: CouponThema;
  phone?: string | null;
};

export type CatFamily = "food" | "beauty" | "health" | "other";

/**
 * The one object the owner builds — threaded through every creation step.
 *
 * Shape changed in v1 to hold only what the system can actually honour:
 *   • `scope` is owner-typed text (or "כל העסק"), not a picked id — there are no
 *     product/category selectors behind it (COUPON-05).
 *   • `conditions: string[]` became two concrete terms, one of which now carries
 *     a required amount (COUPON-06).
 *   • `validity: "שבועיים"` became a real `validUntilDate` (COUPON-08); the old
 *     presets survive as shortcuts that write into it.
 *   • `business` is loaded from the API and may be null while loading.
 */
export type CouponDraft = {
  business: Business | null;
  goal: string | null;
  direction: Direction | null;
  benefitType: BenefitType;
  value: string;
  /** `SCOPE_WHOLE_BUSINESS` or a product/service name the owner typed. */
  scope: string;
  titleEdited: boolean;
  title: string;
  description: string;
  minPurchaseEnabled: boolean;
  minPurchase: string;
  newCustomersOnly: boolean;
  /** `YYYY-MM-DD`, interpreted as end-of-day Israel time. */
  validUntilDate: string;
};

/** Normalized shape the single public-coupon view renders (creation + consumer). */
export type CouponView = {
  business: Business;
  benefit: string;
  description: string;
  valid: string;
  remaining?: { left: number; total: number };
  terms: string;
};

/** A discoverable coupon in the consumer world. */
export type PublicCoupon = {
  id: string;
  business: Business;
  category: CatKey;
  benefit: string;
  description: string;
  valid: string;
  /** Human display distance (e.g. "1.2 ק״מ") — present only when a real user point + business geo exist. */
  distance?: string;
  /** Raw distance (km) — for "near you" ordering; present only with real geo. */
  distanceKm?: number;
  remaining?: { left: number; total: number };
  ribbon?: string;
  catFamily?: CatFamily;
  /** Raw expiry (ISO) — for the "ending soon" ordering. */
  expiresAt?: string;
  /** Derived demand signal — for the "most wanted" ordering. */
  popularity?: number;
};

/* ------------------------------------------------------------- goals ----- */

export const GOALS = [
  { key: "new", label: "להביא לקוחות חדשים" },
  { key: "return", label: "להחזיר לקוחות שלא חזרו" },
  { key: "basket", label: "להגדיל את הרכישה / סל הקנייה" },
  { key: "promote", label: "לקדם מוצר או שירות שלא נמכר מספיק" },
  { key: "reward", label: "לתגמל או לפנק לקוחות" },
];

export const GOAL_ECHO: Record<string, string> = {
  new: "כדי שיגיעו לקוחות חדשים",
  return: "כדי שלקוחות יחזרו אליך",
  basket: "כדי שיקנו קצת יותר",
  promote: "כדי לקדם משהו מסוים",
  reward: "כדי לפנק את הלקוחות שלך",
};

/* --------------------------------------------------------- directions ---- */

export const DIRECTION_LABEL: Record<Direction, string> = {
  discount: "הנחה",
  gift: "מתנה",
  more: "יותר תמורה",
  price: "מחיר מיוחד",
  punchcard: "כרטיסייה",
  opening: "הטבת פתיחה",
};

/**
 * The 6 universal directions shown on the direction screen — 3 main (always) +
 * 3 extra (revealed by "הראה עוד דרכים"). Fixed "why" lines, no numbers, nothing
 * pre-selected. UI-only guidance — NOT saved to the DB (like the goal).
 */
export const DIRECTIONS_6: { key: Direction; label: string; why: string; extra?: boolean }[] = [
  { key: "discount", label: "הנחה", why: "מורידה את המחסום לנסות אותך בפעם הראשונה." },
  { key: "gift", label: "מתנה", why: "נותנת סיבה להיכנס, בלי להוזיל את מה שאתה מוכר." },
  { key: "more", label: "יותר תמורה", why: "אותו כסף, קצת יותר — מרגיש נדיב." },
  { key: "price", label: "מחיר מיוחד", why: "מחיר קבוע ומזמין, קל לזכור.", extra: true },
  { key: "punchcard", label: "כרטיסייה", why: "מתגמל חזרה — סיבה לבוא שוב ושוב.", extra: true },
  { key: "opening", label: "הטבת פתיחה", why: "הטבה חד-פעמית שמזמינה להיכרות ראשונה.", extra: true },
];

/** goal → directions ordered by fit, each with "why it fits" (Decision Map matrix). */
export const GOAL_DIRECTIONS: Record<string, { key: Direction; why: string }[]> = {
  new: [
    { key: "discount", why: "מורידה את המחסום לנסות אותך בפעם הראשונה." },
    { key: "gift", why: "נותנת סיבה להיכנס, בלי להוזיל את מה שאתה מוכר." },
    { key: "more", why: "אפשרי, אבל פחות טבעי ללקוח חדש." },
  ],
  return: [
    { key: "gift", why: "אומרת 'מתגעגעים אליך' — אישית." },
    { key: "discount", why: "מורידה את המחסום לחזור." },
    { key: "more", why: "אפשרי, פחות מרכזי כאן." },
  ],
  basket: [
    { key: "more", why: "1+1 או חבילה מגדילים את הסל." },
    { key: "gift", why: "מתנה מעל סכום מתגמלת קנייה גדולה." },
    { key: "discount", why: "שים לב — הנחה דווקא מקטינה את הסל." },
  ],
  promote: [
    { key: "discount", why: "מזיזה את מה שתקוע." },
    { key: "more", why: "מצמידה את האיטי למוצר מבוקש." },
    { key: "gift", why: "נותנת ללקוח להתנסות בשירות חדש." },
  ],
  reward: [
    { key: "gift", why: "מרגישה כמו תודה, לא כמו מכירה." },
    { key: "more", why: "תוספת קטנה שמפנקת." },
    { key: "discount", why: "פחות מרגישה כמו פינוק." },
  ],
};

export function directionsFor(goal: string | null) {
  return (goal && GOAL_DIRECTIONS[goal]) || GOAL_DIRECTIONS.new;
}

/* ------------------------------------------------------- benefit types --- */

export const BENEFIT_TYPES: { key: BenefitType; label: string; dir: Direction | null }[] = [
  { key: "pct", label: "אחוז הנחה", dir: "discount" },
  { key: "amt", label: "סכום הנחה", dir: "discount" },
  { key: "price", label: "מחיר מיוחד", dir: "discount" },
  { key: "giftProduct", label: "מוצר במתנה", dir: "gift" },
  { key: "giftService", label: "שירות במתנה", dir: "gift" },
  { key: "more", label: "יותר תמורה", dir: "more" },
  { key: "other", label: "אחר", dir: null },
];

/** Direction guides the starting point: matching types first (not locked). */
/** Which benefit-types a direction surfaces first in the Builder (guides, not locks). */
const DIR_TYPES: Record<Direction, BenefitType[]> = {
  discount: ["pct", "amt", "price"],
  gift: ["giftProduct", "giftService"],
  more: ["more"],
  price: ["price"],
  punchcard: ["more"],
  opening: ["pct", "giftProduct"],
};

export function orderedTypesFor(direction: Direction | null) {
  if (!direction) return BENEFIT_TYPES;
  const front = DIR_TYPES[direction] ?? [];
  const match = BENEFIT_TYPES.filter((t) => front.includes(t.key));
  const rest = BENEFIT_TYPES.filter((t) => !front.includes(t.key));
  return [...match, ...rest];
}

export function directionDefault(direction: Direction): { type: BenefitType; value: string } {
  switch (direction) {
    case "discount": return { type: "pct", value: "20" };
    case "gift": return { type: "giftProduct", value: "" };
    case "more": return { type: "more", value: "1+1" };
    case "price": return { type: "price", value: "" };
    case "punchcard": return { type: "more", value: "כרטיסייה" };
    case "opening": return { type: "pct", value: "" };
  }
}

export const MORE_OPTS = ["1+1", "כרטיסייה", "חבילה", "שדרוג"];

/**
 * Validity shortcuts. These are convenience buttons that write a real date into
 * `validUntilDate` — they are no longer the stored value themselves, so the
 * owner can always pick an exact end date instead (COUPON-08).
 */
export const VALIDITY_PRESETS: { label: string; days: number }[] = [
  { label: "שבוע", days: 7 },
  { label: "שבועיים", days: 14 },
  { label: "חודש", days: 30 },
];

/** `YYYY-MM-DD` for "today + n days", in the viewer's local (Israeli) calendar. */
export function dateInDays(days: number, from: Date = new Date()): string {
  const d = new Date(from.getTime());
  d.setDate(d.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/* ------------------------------------------------------- derivations ------ */

/**
 * Preview text for a partially-built draft.
 *
 * Distinct from the server's `composeBenefitSentence`, which only ever runs on
 * validated input: this one is allowed to show a "—" placeholder because it is
 * a live preview of something still being typed. The placeholder can never be
 * persisted — the server composes the stored sentence itself from validated
 * parts, so the audit's "50₪ על קטגוריה" cannot be written (COUPON-12).
 */
export function segmentText(type: BenefitType, value: string): string {
  const v = (value ?? "").trim();
  switch (type) {
    case "pct": return `${v || "—"}% הנחה`;
    case "amt": return `${v || "—"}₪ הנחה`;
    case "price": return `במחיר ${v || "—"}₪`;
    case "giftProduct":
    case "giftService": return v ? `${v} מתנה` : "מתנה";
    case "more": return v || "יותר תמורה";
    case "other": return v || "הטבה";
  }
}

export function benefitSentence(d: CouponDraft): string {
  const segment = segmentText(d.benefitType, d.value);
  const scope = (d.scope ?? "").trim();
  return scope ? `${segment} על ${scope}` : segment;
}

/**
 * The EFFECTIVE title — what the coupon is actually called. Falls back to the
 * composed sentence so a preview is never blank.
 */
export function couponTitle(d: CouponDraft): string {
  return d.titleEdited && d.title.trim() ? d.title.trim() : benefitSentence(d);
}

/**
 * What the title INPUT shows — deliberately different from `couponTitle`.
 *
 * Auto-copy follows the draft until the owner types; from then on the field is
 * theirs. Clearing it must leave it cleared: routing the input through
 * `couponTitle` made a deleted title snap straight back to the generated
 * sentence, so the owner could not empty the field at all. Publishing an empty
 * title simply lets the server compose the canonical sentence.
 */
export function titleInputValue(d: CouponDraft): string {
  return d.titleEdited ? d.title : benefitSentence(d);
}

/** The terms line, built from the two terms v1 can actually state. */
export function draftTermsText(d: CouponDraft): string {
  const parts: string[] = [];
  const amount = d.minPurchase.trim();
  if (d.minPurchaseEnabled && amount) parts.push(`בקנייה מעל ${amount}₪`);
  if (d.newCustomersOnly) parts.push("ללקוחות חדשים בלבד");
  return parts.join(" · ");
}

function formatValidUntil(isoDate: string): string {
  if (!isoDate) return "";
  const d = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(d.getTime())) return "";
  return `תקף עד ${d.toLocaleDateString("he-IL", { day: "numeric", month: "numeric" })}`;
}

export function draftToView(d: CouponDraft): CouponView {
  const terms = draftTermsText(d);
  return {
    business: d.business ?? EMPTY_BUSINESS,
    benefit: couponTitle(d),
    description: d.description,
    valid: formatValidUntil(d.validUntilDate),
    terms: terms ? `תנאי שימוש: ${terms}` : "",
  };
}

export function publicToView(c: PublicCoupon): CouponView {
  return {
    business: c.business,
    benefit: c.benefit,
    description: c.description,
    valid: c.valid,
    remaining: c.remaining,
    // Terms come from the coupon's own description or not at all. This used to
    // print a fixed "קופון אחד ללקוח · בתיאום מראש · לא ניתן לכפל עם מבצעים
    // אחרים" onto every real consumer coupon — terms no business had agreed to
    // and the system does not enforce.
    terms: "",
  };
}

/* ------------------------------------------------------- demo content ----- */

function biz(name: string, thema: CouponThema, logo: string, address: string): Business {
  return { name, city: "תל אביב", address, hours: "א׳–ה׳ 8:00–18:00", logo, thema };
}

/**
 * Placeholder identity used ONLY while the real business is still loading, and
 * by the `/coupon-design` gallery. It is deliberately empty rather than
 * plausible: the previous `MY_BUSINESS = biz("העסק שלך", …, "הכתובת שלך")` with
 * city "תל אביב" and fixed opening hours looked like production data on a real
 * coupon preview (COUPON-04).
 */
export const EMPTY_BUSINESS: Business = {
  name: null,
  city: null,
  address: null,
  hours: null,
  logo: "·",
  thema: "teal",
  phone: null,
};

/** Map the real business identity from the API onto the coupon's business card. */
export function businessFromIdentity(identity: {
  name: string | null;
  city: string | null;
  address: string | null;
  openingHours: string | null;
  phone: string | null;
  category: string | null;
  subCategory: string | null;
  businessModel: string | null;
}): Business {
  const fam = categoryFamily(identity.category, identity.subCategory, identity.businessModel);
  return {
    name: identity.name,
    city: identity.city,
    address: identity.address,
    hours: identity.openingHours,
    phone: identity.phone,
    logo: (identity.name ?? "·").trim().charAt(0) || "·",
    thema: THEMA_BY_FAMILY[fam],
  };
}

const THEMA_BY_FAMILY: Record<CatFamily, CouponThema> = {
  food: "orange",
  beauty: "pink",
  health: "teal",
  other: "purple",
};

/** Business category → coupon visual family. Shared with the marketplace mapper. */
export function categoryFamily(cat?: string | null, sub?: string | null, model?: string | null): CatFamily {
  const s = `${cat || ""} ${sub || ""} ${model || ""}`.toLowerCase();
  if (/food|restaurant|cafe|coffee|bakery|pizza|sushi|מסעד|קפה|אוכל|מאפ|פיצה|סושי|\bבר\b/.test(s)) return "food";
  if (/beaut|hair|cosmet|nails|barber|spa|ספר|תספורת|יופי|קוסמט|טיפוח|ציפור/.test(s)) return "beauty";
  if (/clinic|medical|health|fitness|gym|dental|physio|רפוא|קליניק|בריאות|כושר|טיפול|שיניים|פיזיו/.test(s)) return "health";
  return "other";
}

export function initialDraft(): CouponDraft {
  return {
    business: null,
    goal: null,
    direction: null,
    benefitType: "pct",
    value: "20",
    scope: SCOPE_WHOLE_BUSINESS,
    titleEdited: false,
    title: "",
    description: "",
    minPurchaseEnabled: false,
    minPurchase: "",
    newCustomersOnly: false,
    validUntilDate: dateInDays(14),
  };
}

const B = {
  nechama: biz("קפה נחמה", "teal", "נ", "דיזנגוף 120, תל אביב"),
  roma: biz("פיצה רומא", "orange", "ר", "אבן גבירול 45, תל אביב"),
  yoko: biz("סושי יוקו", "purple", "י", "רוטשילד 22, תל אביב"),
  dana: biz("מספרת דנה", "pink", "ד", "שינקין 8, תל אביב"),
  louis: biz("בר לואי", "teal", "ל", "פלורנטין 30, תל אביב"),
  flowers: biz("חנות הפרחים", "pink", "פ", "בזל 12, תל אביב"),
  fit: biz("חדר כושר פיט", "teal", "פ", "יגאל אלון 100, תל אביב"),
  avi: biz("מוסך אבי", "orange", "א", "המסגר 55, תל אביב"),
  ria: biz("קליניקת ריאה", "purple", "ק", "ויצמן 14, תל אביב"),
};

const D = "קנה אצלנו ותהנה מההטבה — בלי כפל מבצעים, פשוט להציג בבית העסק.";

export const ROW_NEAR: PublicCoupon[] = [
  { id: "n1", business: B.nechama, category: "coffee", benefit: "קפה + מאפה מתנה", description: D, valid: "תקף עד 20.7", distance: "0.4 ק״מ", remaining: { left: 12, total: 50 } },
  { id: "n2", business: B.roma, category: "pizza", benefit: "1+1 על משפחתית", description: D, valid: "תקף עד 15.7", distance: "0.8 ק״מ", remaining: { left: 30, total: 60 } },
  { id: "n3", business: B.yoko, category: "gem", benefit: "רול מתנה בהזמנה", description: D, valid: "תקף שבוע", distance: "0.9 ק״מ" },
  { id: "n4", business: B.dana, category: "spark", benefit: "20% על תספורת", description: D, valid: "תקף שבועיים", distance: "1.1 ק״מ" },
  { id: "n5", business: B.louis, category: "glass", benefit: "כוס יין ראשונה עלינו", description: D, valid: "תקף שבועיים", distance: "1.3 ק״מ" },
];
export const ROW_POPULAR: PublicCoupon[] = [
  { id: "p1", business: B.roma, category: "pizza", benefit: "1+1 על משפחתית", description: D, valid: "תקף עד 15.7", distance: "0.8 ק״מ", remaining: { left: 30, total: 60 } },
  { id: "p2", business: B.nechama, category: "coffee", benefit: "קפה + מאפה מתנה", description: D, valid: "תקף עד 20.7", distance: "0.4 ק״מ", remaining: { left: 12, total: 50 } },
  { id: "p3", business: B.flowers, category: "glass", benefit: "זר קטן מתנה בקנייה", description: D, valid: "תקף שבוע", distance: "1.5 ק״מ" },
  { id: "p4", business: B.fit, category: "activity", benefit: "שבוע ניסיון חינם", description: D, valid: "תקף חודש", distance: "2.0 ק״מ" },
];
export const ROW_SOON: PublicCoupon[] = [
  { id: "s1", business: B.avi, category: "wrench", benefit: "בדיקת חורף חינם", description: D, valid: "תקף עד 12.7", distance: "3.0 ק״מ", ribbon: "אוזל", remaining: { left: 3, total: 40 } },
  { id: "s2", business: B.ria, category: "activity", benefit: "ייעוץ ראשון חינם", description: D, valid: "תקף עד 13.7", distance: "2.3 ק״מ", ribbon: "אוזל", remaining: { left: 2, total: 30 } },
  { id: "s3", business: B.dana, category: "spark", benefit: "20% על תספורת", description: D, valid: "תקף עד 14.7", distance: "1.1 ק״מ", ribbon: "אוזל" },
  { id: "s4", business: B.louis, category: "glass", benefit: "כוס יין ראשונה עלינו", description: D, valid: "תקף עד 15.7", distance: "1.3 ק״מ" },
];

/* -------------------------------------- owner world (Marketing Center) ---- */

/** A benefit as the OWNER sees it in his marketing center (state + pulse). */
export type OwnerCoupon = {
  id: string;
  benefit: string;
  status: "active" | "ended";
  validityText: string;
  metric: string;
  thema: import("@/lib/design/coupon-consumer").CouponThema;
};

export const MY_ACTIVE: OwnerCoupon[] = [
  { id: "a1", benefit: "20% הנחה על כל העסק", status: "active", validityText: "נגמר בעוד 5 ימים", metric: "38 מתוך 50 נותרו", thema: EMPTY_BUSINESS.thema },
  { id: "a2", benefit: "קפה + מאפה מתנה", status: "active", validityText: "נגמר מחר", metric: "12 מתוך 50 נותרו", thema: EMPTY_BUSINESS.thema },
];
export const MY_ENDED: OwnerCoupon[] = [
  { id: "e1", benefit: "1+1 על קינוחים", status: "ended", validityText: "הסתיים ב-28.6", metric: "מומש 31 פעמים", thema: EMPTY_BUSINESS.thema },
  { id: "e2", benefit: "טיפול ראשון ב-50%", status: "ended", validityText: "הסתיים ב-15.6", metric: "מומש 18 פעמים", thema: EMPTY_BUSINESS.thema },
];

let _ownerSeq = 100;
/** Convert a just-created draft into an active owner coupon (closes the loop). */
export function draftToOwnerCoupon(d: CouponDraft): OwnerCoupon {
  _ownerSeq += 1;
  return {
    id: `new-${_ownerSeq}`,
    benefit: couponTitle(d),
    status: "active",
    validityText: formatValidUntil(d.validUntilDate),
    metric: "חדש · טרם מומש",
    thema: (d.business ?? EMPTY_BUSINESS).thema,
  };
}
