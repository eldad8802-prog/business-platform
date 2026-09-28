/**
 * Single source of truth for every user-facing string in the WhatsApp
 * connection experience (invitation, connecting, error, connected states,
 * settings card, reconnect banner, disconnect dialog).
 *
 * Copy lives here — never inline inside components or hooks — so Copy can be
 * changed without touching logic or layout. Text matches the approved UX
 * document ("שלושה רגעים") verbatim.
 */
export const WA_COPY = {
  /** Moment 1 — invitation (shared by Inbox first-connect and Settings). */
  invitation: {
    heading: "כל השיחות עם הלקוחות, במקום אחד",
    body: "כשלקוח כותב לך ב-WhatsApp, ההודעה מגיעה לכאן — ואתה עונה ישר מ-Dubiz.",
    trust: "החיבור מתבצע ישירות מול Meta. Dubiz לא מקבלת את פרטי ההתחברות שלך ל-Meta.",
    cta: "חיבור WhatsApp Business",
    /** Shown on the CTA while Meta's popup is open. */
    connecting: "פותחים חלון מאובטח…",
    helper: "לוקח פחות מדקה.",
    /** Shown under the CTA while Meta's popup is open — the owner's way out. */
    popupHint:
      "לא רואים את החלון של Meta? ייתכן שהוא נפתח מאחורי החלון הזה, או שהדפדפן חסם חלונות קופצים.",
    cancelLaunch: "ביטול",
  },

  /** Moment 2 — after the popup closes, while the backend finishes. */
  connecting: {
    title: "מחברים…",
    body: "קיבלנו את האישור — מסדרים את הכל בשבילך.",
  },

  /** Connect failed (generic, non-retryable-safe). */
  error: {
    badge: "לא הושלם",
    heading: "לא הצלחנו להשלים את החיבור",
    body: "זה בדרך כלל זמני. אפשר לנסות שוב.",
    retry: "נסה שוב",
    /**
     * Specific reason lines, keyed by the connect flow's error codes. Anything
     * not listed falls back to `body`.
     */
    reasons: {
      timeout: "החלון של Meta נשאר פתוח זמן רב מדי ולא הושלם. אפשר לנסות שוב.",
      popup_blocked:
        "הדפדפן חסם את החלון של Meta. יש לאפשר חלונות קופצים לאתר הזה (בסמל החלון החסום בשורת הכתובת, או בהגדרות האתר בדפדפן), לכבות תוספים שחוסמים את Facebook, ולנסות שוב.",
      sdk_unavailable: "לא הצלחנו לטעון את החיבור של Meta. בדקו את החיבור לאינטרנט ונסו שוב.",
      config_missing: "חיבור WhatsApp אינו זמין כרגע בסביבה הזו.",
      meta_error: "Meta דיווחה על שגיאה בתהליך החיבור. אפשר לנסות שוב.",
      missing_code: "Meta לא החזירה אישור לחיבור. אפשר לנסות שוב.",
      missing_ids: "Meta לא החזירה את פרטי המספר. אפשר לנסות שוב.",
      no_phone_number: "התהליך ב-Meta הסתיים בלי לבחור מספר טלפון. יש לבחור מספר ולנסות שוב.",
      number_taken: "המספר הזה כבר מחובר לחשבון אחר ב-Dubiz.",
      unauthorized: "פג תוקף ההתחברות ל-Dubiz. התחברו מחדש ונסו שוב.",
      forbidden: "אין לך הרשאה לחבר WhatsApp לעסק הזה.",
      meta_failed: "Meta לא אישרה את השלמת החיבור. אפשר לנסות שוב.",
      server_error: "אירעה תקלה אצלנו בהשלמת החיבור. אפשר לנסות שוב.",
      network: "החיבור לאינטרנט נקטע באמצע. בודקים אם החיבור הושלם…",
    } as Record<string, string>,
  },

  /** The connection status itself could not be read — never shown as "not connected". */
  loadError: {
    badge: "שגיאה",
    heading: "לא הצלחנו לבדוק את מצב החיבור ל-WhatsApp",
    body: "זה לא אומר שהחיבור נותק — רק שלא הצלחנו לקרוא אותו כרגע.",
    retry: "נסה שוב",
  },

  /** A row exists and still receives messages, but it is not healthy. */
  attention: {
    badge: "דורש תשומת לב",
    REVOKED_BY_META:
      "הודעות מלקוחות עדיין מגיעות, אבל Meta ביטלה את ההרשאה לשלוח תשובות. יש להתחבר מחדש.",
    ERROR: "נרשמה תקלה בחיבור. הודעות מלקוחות עדיין מגיעות; מומלץ להתחבר מחדש.",
  } as { badge: string } & Record<string, string>,

  /** A row exists but the number no longer receives messages in Dubiz. */
  disconnectedNotice: {
    DISCONNECTED: "המספר נותק מ-Dubiz והודעות חדשות לא מתקבלות. אפשר לחבר אותו מחדש.",
    REVOKED: "ההרשאה למספר בוטלה והודעות חדשות לא מתקבלות. אפשר לחבר אותו מחדש.",
    numberLabel: "המספר הקודם",
  } as Record<string, string>,

  /** Moment 3 — the Inbox's own empty state once connected, no messages yet. */
  inboxConnected: {
    badge: "מחובר",
    heading: "WhatsApp Business מחובר",
    body: "כשלקוח יכתוב לך ב-WhatsApp, ההודעה תופיע כאן — ותוכל לענות ישר מכאן.",
  },

  /** Settings — connected status card + owner actions. */
  settingsCard: {
    badge: "מחובר",
    numberLabel: "המספר המחובר",
    actions: {
      reconnect: { title: "התחברות מחדש", subtitle: "רענון החיבור" },
      switch: { title: "החלפת חשבון", subtitle: "חיבור מספר אחר" },
      disconnect: { title: "ניתוק חשבון", subtitle: "הפסקת קבלת הודעות" },
    },
  },

  /** Inbox — banner when a prior connection broke. */
  banner: {
    title: "החיבור ל-WhatsApp נותק",
    subtitle: "הודעות חדשות לא מתקבלות כרגע.",
    button: "חיבור מחדש",
    connecting: "מתחברים…",
    footnote: "השיחות הישנות נשמרות כאן.",
    failedTitle: "לא הצלחנו לחדש את החיבור",
    failedSubtitle: "אפשר לנסות שוב.",
    retry: "נסה שוב",
  },

  /** Disconnect confirmation — framed around what happens inside Dubiz. */
  disconnect: {
    title: "להפסיק לקבל הודעות ב-Dubiz?",
    body: "הניתוק מפסיק את קבלת הודעות ה-WhatsApp ב-Dubiz. השיחות הקיימות יישארו שמורות, ותמיד אפשר לחבר מחדש.",
    confirm: "כן, להפסיק",
    confirmBusy: "מנתקים…",
    cancel: "ביטול",
    error: "לא הצלחנו לנתק כרגע. אפשר לנסות שוב.",
  },

  /** Outbound send — friendly notices shown when a reply couldn't be delivered. */
  outbound: {
    windowExpired:
      "לא ניתן לשלוח כרגע הודעת טקסט רגילה — עברו יותר מ-24 שעות מאז ההודעה האחרונה של הלקוח. בשלב הבא תתאפשר שליחה עם תבנית מאושרת (Template).",
    revoked: "החיבור ל-WhatsApp נותק. יש להתחבר מחדש כדי לשלוח הודעות.",
    notConnected: "WhatsApp אינו מחובר. חברו את החשבון כדי לשלוח הודעות.",
    failed: "ההודעה לא נשלחה ללקוח. אפשר לנסות שוב.",
  },

  /** Transient loader while the connection status resolves. */
  loader: "רגע, טוענים את השיחות שלך…",
} as const;

/** The owner-facing reason for a failed connect attempt (falls back to the generic line). */
export function waConnectErrorText(code: string | null | undefined): string {
  return (code && WA_COPY.error.reasons[code]) || WA_COPY.error.body;
}
