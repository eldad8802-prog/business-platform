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
  },

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
