/**
 * "מעבר לעוסק מורשה" — the browser side (owner-approved design, artifact YYDWFcaJCm6HRpqb6bYs4Q, 2026-11-21).
 *
 * Thin calls to /api/business/legal-identity/kind-transition/* plus the pure pieces the screens need (the date
 * state, the saved draft across the Google round-trip, the Google return reason). Nothing here decides anything the
 * server does not decide again: eligibility, the id number match, re-authentication and the transition itself are all
 * server-side; the screen only explains them.
 */

export const KIND_TRANSITION_API = "/api/business/legal-identity/kind-transition";
export const KIND_TRANSITION_PAGE = "/business/legal-identity/kind-transition";

export type KindTransitionAck = { id: string; text: string };
export type KindTransitionInfo = {
  eligibility: { eligible: true } | { eligible: false; block: string; message: string };
  reauthMethod: "PASSWORD" | "GOOGLE";
  identity: { legalName: string | null; taxId: string | null; kind: string | null };
  acknowledgements: KindTransitionAck[];
  effects: string[];
  history: { fromKind: string; toKind: string; statusEffectiveDate: string; confirmedAt: string; reauthMethod: string } | null;
};

export type ApiAnswer<T = Record<string, unknown>> = { status: number; body: T & { code?: string; error?: string; message?: string } };

function token(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem("token") || "";
  } catch {
    return "";
  }
}

async function call<T>(path: string, init?: { method?: "GET" | "POST"; body?: unknown }): Promise<ApiAnswer<T>> {
  const res = await fetch(`${KIND_TRANSITION_API}${path}`, {
    method: init?.method ?? "GET",
    headers: { authorization: `Bearer ${token()}`, ...(init?.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: "same-origin",
    cache: "no-store",
  });
  let body: unknown = {};
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  return { status: res.status, body: (body && typeof body === "object" ? body : {}) as ApiAnswer<T>["body"] };
}

/** null = the feature is off (404) or the call failed: the entry point renders nothing. */
export async function fetchKindTransitionInfo(): Promise<{ status: number; info: KindTransitionInfo | null }> {
  try {
    const r = await call<KindTransitionInfo>("");
    return { status: r.status, info: r.status === 200 ? (r.body as unknown as KindTransitionInfo) : null };
  } catch {
    return { status: 0, info: null };
  }
}

export type TransitionInput = { confirmTaxId: string; vatNumber: string; statusEffectiveDate: string; acknowledged: string[] };

export const previewKindTransition = (input: TransitionInput) =>
  call<{ statementSha256?: string; problems?: { field: string; code: string; message: string }[] }>("/preview", { method: "POST", body: input });
/** Step 2: what was typed so far (id number, VAT number, date), before the confirmations exist. No digest. */
export const checkIdentity = (input: Omit<TransitionInput, "acknowledged">) =>
  call<{ ok?: boolean; problems?: { field: string; code: string; message: string }[] }>("/preview", { method: "POST", body: { ...input, acknowledged: [], stage: "identity" } });
export const reauthWithPassword = (password: string) => call<{ retryAfterSeconds?: number }>("/reauth/password", { method: "POST", body: { password } });
export const startGoogleReauth = () => call<{ url?: string }>("/reauth/google", { method: "POST", body: {} });
export const confirmKindTransition = (input: TransitionInput & { statementSha256: string }) =>
  call<{ reauthMethod?: string }>("", { method: "POST", body: input });

// ── pure helpers (unit-tested) ────────────────────────────────────────────────────────────────────

/** Today in Israel, YYYY-MM-DD (the server and the database use the same zone). */
export function israelTodayClient(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export type DateState = "empty" | "invalid" | "future" | "today" | "early";

export function dateState(ymd: string, today: string): DateState {
  const v = (ymd ?? "").trim();
  if (!v) return "empty";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || v < "2000-01-01") return "invalid";
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) return "invalid";
  if (v > today) return "future";
  return v === today ? "today" : "early";
}

/** dd.mm.yyyy for display. */
export function displayDate(ymd: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd ?? "");
  return m ? `${m[3]}.${m[2]}.${m[1]}` : "";
}

/** An instant (ISO) as its Israel calendar date, dd.mm.yyyy — a confirmation at 01:00 Israel time is that day, not yesterday. */
export function displayInstant(iso: string | null | undefined): string {
  const t = iso ? new Date(iso) : null;
  return t && !Number.isNaN(t.getTime()) ? displayDate(israelTodayClient(t)) : "";
}

/** Was the declared status start earlier than the Israel day of the confirmation? */
export function startedBeforeConfirmation(statusEffectiveDate: string, confirmedAt: string): boolean {
  const t = new Date(confirmedAt);
  return !Number.isNaN(t.getTime()) && statusEffectiveDate < israelTodayClient(t);
}

/** The id number as typed, reduced to digits (the server canonicalises it the same way). */
export const digitsOnly = (v: string) => (v ?? "").replace(/\D/g, "");

/** Does the typed id number match the one on file? A screen hint only — the server decides. */
export function sameTaxId(typed: string, onFile: string | null | undefined): boolean {
  const a = digitsOnly(typed).padStart(9, "0");
  const b = digitsOnly(onFile ?? "").padStart(9, "0");
  return digitsOnly(typed).length >= 8 && a === b;
}

export type GoogleReturn = "ok" | "cancelled" | "error" | "stale" | "other_account" | null;

/** The reason Google's round-trip ended with (?reauth=…), or null when the page was opened normally. */
export function googleReturnOf(search: string): GoogleReturn {
  const v = new URLSearchParams(search).get("reauth");
  return v === "ok" || v === "cancelled" || v === "error" || v === "stale" || v === "other_account" ? v : null;
}

export const GOOGLE_RETURN_MESSAGES: Record<Exclude<GoogleReturn, "ok" | null>, string> = {
  cancelled: "האימות עם Google בוטל. אפשר לנסות שוב.",
  error: "האימות עם Google לא הושלם. אפשר לנסות שוב.",
  stale: "Google לא אישרה התחברות חדשה. נסו שוב והתחברו מחדש במסך של Google.",
  other_account: "חשבון ה-Google שבחרתם לא מחובר לחשבון הזה בדוביז. נסו שוב עם החשבון שאיתו נרשמתם.",
};

/** What survives the Google redirect: only what the owner typed on steps 1–2 (no secret). */
export type SavedDraft = { date: string; taxInput: string; savedAt: number };
export const DRAFT_KEY = "dz.kindTransition.draft";
const DRAFT_TTL_MS = 15 * 60_000;

export function encodeDraft(d: { date: string; taxInput: string }, now = Date.now()): string {
  return JSON.stringify({ date: d.date, taxInput: digitsOnly(d.taxInput).slice(0, 9), savedAt: now });
}

export function decodeDraft(raw: string | null, now = Date.now()): SavedDraft | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<SavedDraft>;
    if (typeof p.date !== "string" || typeof p.taxInput !== "string" || typeof p.savedAt !== "number") return null;
    if (now - p.savedAt > DRAFT_TTL_MS || p.savedAt > now + 60_000) return null;
    return { date: p.date.slice(0, 10), taxInput: digitsOnly(p.taxInput).slice(0, 9), savedAt: p.savedAt };
  } catch {
    return null;
  }
}

/** The message a refused confirmation shows, and where the screen goes next. */
export function confirmOutcome(status: number, code: string | undefined, fallback: string | undefined):
  { kind: "success" } | { kind: "reverify"; message: string } | { kind: "restart"; message: string } | { kind: "error"; message: string } {
  if (status === 200) return { kind: "success" };
  if (status === 401 || code === "REAUTH_REQUIRED") return { kind: "reverify", message: "עבר זמן רב מדי מאז האימות. צריך לאמת שוב — שום דבר לא השתנה." };
  if (code === "STATEMENT_STALE") return { kind: "restart", message: "פרטי העסק השתנו מאז שנפתח המסך. צריך להתחיל מחדש — שום דבר לא השתנה." };
  if (status === 429) return { kind: "error", message: "יותר מדי ניסיונות. אפשר לנסות שוב מאוחר יותר." };
  if (status >= 500 || status === 0) return { kind: "error", message: "המעבר לא בוצע, ושום דבר לא השתנה. אפשר לנסות שוב בעוד רגע." };
  return { kind: "error", message: fallback || "המעבר לא בוצע, ושום דבר לא השתנה." };
}

/** Hebrew label for a kind enum (display only). */
export function kindLabelHe(kind: string | null | undefined): string {
  return kind === "AUTHORIZED_DEALER" ? "עוסק מורשה" : kind === "EXEMPT_DEALER" ? "עוסק פטור" : kind === "LTD_COMPANY" ? "חברה בע״מ" : "";
}
