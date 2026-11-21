/**
 * Service Desk UI 1.3 — the case-opening form, pure model. Owner-approved behaviour (2026-11-19; the visual design is
 * still under review): a smart, gradual opening — first WHAT is opened (only the activity types the business uses,
 * more on request) and FOR WHOM (an existing customer found by name / phone, or a new one), then only the fields of that
 * activity: a repair asks for the item and the fault; a service call asks for the work and where it is done — no item
 * fields. Previous cases of the customer are offered; a recent one of the same item inside the warranty is suggested
 * as a link, and the owner decides. Nothing here decides a requirement: the server snapshots the business profile.
 */

export type Track = "T1" | "T2" | "T3" | "T4" | "T5" | "T6" | "T7";

export type TrackForm = {
  track: Track;
  /** The button label in "what are you opening?" */
  label: string;
  /** תיק / קריאה — the screen title and the submit wording. */
  noun: "תיק" | "קריאה";
  experience: "repair" | "service";
  subject: { kind: "ITEM" | "VEHICLE" | "SYSTEM"; label: string; placeholder: string } | null;
  problemLabel: string;
  problemPlaceholder: string;
  address: "required" | "optional" | null;
  /** After the opening: a held item goes to the short intake step (owner decision), anything else to the case. */
  next: "intake" | "case";
};

export const TRACK_FORMS: Readonly<Record<Track, TrackForm>> = {
  T1: { track: "T1", label: "תיקון במעבדה", noun: "תיק", experience: "repair", subject: { kind: "ITEM", label: "הפריט", placeholder: "למשל iPhone 13" }, problemLabel: "מה התקלה?", problemPlaceholder: "מה הלקוח מתאר", address: null, next: "intake" },
  T2: { track: "T2", label: "תיקון רכב", noun: "תיק", experience: "repair", subject: { kind: "VEHICLE", label: "הרכב", placeholder: "דגם ומספר רישוי" }, problemLabel: "מה התקלה?", problemPlaceholder: "מה הלקוח מתאר", address: null, next: "intake" },
  T3: { track: "T3", label: "תיקון אצל הלקוח", noun: "קריאה", experience: "service", subject: { kind: "SYSTEM", label: "מה מתקנים", placeholder: "למשל מזגן בסלון" }, problemLabel: "מה התקלה?", problemPlaceholder: "מה הלקוח מתאר", address: "required", next: "case" },
  T4: { track: "T4", label: "התקנה", noun: "קריאה", experience: "service", subject: { kind: "SYSTEM", label: "מה מתקינים", placeholder: "למשל מצלמות אבטחה" }, problemLabel: "פרטי ההתקנה", problemPlaceholder: "מה צריך להתקין ואיפה", address: "required", next: "case" },
  T5: { track: "T5", label: "שירות", noun: "קריאה", experience: "service", subject: null, problemLabel: "מה צריך לעשות?", problemPlaceholder: "תיאור העבודה", address: "optional", next: "case" },
  T6: { track: "T6", label: "תמיכה מרחוק", noun: "קריאה", experience: "service", subject: null, problemLabel: "במה צריך לעזור?", problemPlaceholder: "תיאור הבקשה", address: null, next: "case" },
  T7: { track: "T7", label: "החזרה או החלפה", noun: "תיק", experience: "repair", subject: { kind: "ITEM", label: "המוצר", placeholder: "שם המוצר" }, problemLabel: "מה הבעיה?", problemPlaceholder: "למה הלקוח מחזיר", address: null, next: "intake" },
};

const ALL: readonly Track[] = ["T1", "T2", "T3", "T4", "T5", "T6", "T7"];

/** The tracks to offer first (the business's own, default ones first), and the rest behind "עוד סוגים". */
export function offeredTracks(profile: { defaultTracks: string[]; enabledTracks: string[] } | null | undefined): { first: Track[]; more: Track[] } {
  const isTrack = (x: string): x is Track => (ALL as readonly string[]).includes(x);
  const first: Track[] = [];
  for (const t of [...(profile?.defaultTracks ?? []), ...(profile?.enabledTracks ?? [])]) if (isTrack(t) && !first.includes(t)) first.push(t);
  if (first.length === 0) first.push("T1", "T5");
  return { first, more: ALL.filter((t) => !first.includes(t)) };
}

export type CustomerPick = { id: number; name: string; phone: string | null } | null;
export type OpenCaseDraft = {
  track: Track | null;
  customer: CustomerPick;
  subjectName: string;
  problem: string;
  siteAddress: string;
  /** The owner accepted the suggested link to an earlier case (warranty / repeat). */
  parentCaseId: number | null;
};

export const EMPTY_DRAFT: OpenCaseDraft = { track: null, customer: null, subjectName: "", problem: "", siteAddress: "", parentCaseId: null };

/** Something typed or chosen that leaving the form would silently lose (the track alone is not "work"). */
export function draftHasWork(d: OpenCaseDraft, newCustomer: { open: boolean; name: string; phone: string } = { open: false, name: "", phone: "" }): boolean {
  return d.customer !== null || d.subjectName.trim() !== "" || d.problem.trim() !== "" || d.siteAddress.trim() !== ""
    || (newCustomer.open && (newCustomer.name.trim() !== "" || newCustomer.phone.trim() !== ""));
}

/**
 * A phone typed for a new customer (pilot review 2026-11-21): empty is fine (optional); otherwise an Israeli number
 * (05x / 07x mobile or virtual — 10 digits; 02/03/04/08/09 landline — 9 digits; with or without +972 / dashes / spaces)
 * or an international number (+ and 8–15 digits). Anything else is refused on the field, before anything is sent.
 */
export function phoneIssue(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  if (!/^[+\d][\d\s\-()]*$/.test(t)) return "מספר טלפון יכול לכלול רק ספרות, רווחים, מקפים או + בהתחלה.";
  let digits = t.replace(/\D/g, "");
  if (t.startsWith("+") && !digits.startsWith("972")) return digits.length >= 8 && digits.length <= 15 ? null : "מספר בינלאומי צריך להכיל 8 עד 15 ספרות.";
  if (digits.startsWith("972")) digits = "0" + digits.slice(3);
  if (/^0[57]\d{8}$/.test(digits) || /^0[234689]\d{7}$/.test(digits)) return null;
  return "מספר הטלפון לא תקין. למשל 050-1234567 או 03-1234567.";
}

export const PROBLEM_MAX = 4000;
export const SUBJECT_MAX = 120;
export const ADDRESS_MAX = 300;

export type DraftIssue = "track" | "customer" | "subject" | "problem" | "address" | "problemTooLong" | "subjectTooLong" | "addressTooLong";

/** What still blocks the opening, in screen order. Empty = the form can be sent. */
export function draftIssues(d: OpenCaseDraft): DraftIssue[] {
  const out: DraftIssue[] = [];
  if (!d.track) return ["track"];
  const f = TRACK_FORMS[d.track];
  if (!d.customer) out.push("customer");
  if (f.subject && !d.subjectName.trim()) out.push("subject");
  if (f.subject && d.subjectName.trim().length > SUBJECT_MAX) out.push("subjectTooLong");
  if (!d.problem.trim()) out.push("problem");
  if (d.problem.trim().length > PROBLEM_MAX) out.push("problemTooLong");
  if (f.address === "required" && !d.siteAddress.trim()) out.push("address");
  if (d.siteAddress.trim().length > ADDRESS_MAX) out.push("addressTooLong");
  return out;
}

export const ISSUE_TEXT: Readonly<Record<DraftIssue, string>> = {
  track: "בחרו מה פותחים.",
  customer: "בחרו לקוח או הוסיפו לקוח חדש.",
  subject: "חסר הפריט או מה מטפלים בו.",
  problem: "חסר תיאור.",
  address: "חסרה כתובת לביצוע.",
  problemTooLong: "התיאור ארוך מדי.",
  subjectTooLong: "השם ארוך מדי.",
  addressTooLong: "הכתובת ארוכה מדי.",
};

/** The POST /api/service-desk/cases body — the server's contract (it snapshots the profile; nothing here sets a rule). */
export function openCaseBody(d: OpenCaseDraft): Record<string, unknown> {
  if (!d.track || !d.customer) throw new Error("incomplete draft");
  const f = TRACK_FORMS[d.track];
  const body: Record<string, unknown> = { track: d.track, customerId: d.customer.id, problemDescription: d.problem.trim() };
  if (f.subject) body.subject = { kind: f.subject.kind, displayName: d.subjectName.trim() };
  if (f.address && d.siteAddress.trim()) body.siteAddress = d.siteAddress.trim();
  if (d.parentCaseId) body.parentCaseId = d.parentCaseId;
  return body;
}

export type PastCase = { id: number; caseNumber: number; status: string; subjectName?: string | null; problemExcerpt?: string | null; updatedAt: string; customerId?: number };

const DAY = 864e5;

/**
 * The earlier case to suggest linking: the newest case of this customer about the same item (same name, case and
 * spacing ignored) that was handed back or closed within the warranty period. Null when there is none, or no warranty
 * is configured. A suggestion only — the owner decides; the server keeps the link rules.
 */
export function warrantySuggestion(cases: readonly PastCase[], subjectName: string, warranty: { value: number; unit: "DAYS" | "MONTHS" } | null, now: Date):
  { caseId: number; caseNumber: number; daysAgo: number; warrantyDays: number } | null {
  if (!warranty) return null;
  const norm = (s: string | null | undefined) => (s ?? "").normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
  const want = norm(subjectName);
  if (!want) return null;
  const warrantyDays = warranty.unit === "DAYS" ? warranty.value : warranty.value * 30;
  const done = new Set(["DELIVERED", "CLOSED", "WORK_DONE"]);
  const hits = cases
    .filter((c) => done.has(c.status) && norm(c.subjectName) === want)
    .map((c) => ({ c, daysAgo: Math.floor((now.getTime() - Date.parse(c.updatedAt)) / DAY) }))
    .filter((x) => Number.isFinite(x.daysAgo) && x.daysAgo >= 0 && x.daysAgo <= warrantyDays)
    .sort((a, b) => a.daysAgo - b.daysAgo);
  const top = hits[0];
  return top ? { caseId: top.c.id, caseNumber: top.c.caseNumber, daysAgo: top.daysAgo, warrantyDays } : null;
}
