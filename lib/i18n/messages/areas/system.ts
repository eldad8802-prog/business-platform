/**
 * i18n area: system (server-produced text). Hebrew (source; English in ./system.en.ts). Registered in ../he.ts and ../en.ts.
 *
 * Text Dubiz builds for the business OWNER at read time:
 *   - tasks      the agenda (lib/services/tasks: bucket titles, tags, queue rows, the adapters' fixed
 *                templates, series cadences, source names) and the task client's error text;
 *   - secretary  the secretary client's transport fallback;
 *   - email      the owner's transactional emails (WELCOME, EMAIL_VERIFY, PASSWORD_RESET).
 * NOT here: anything a customer receives (collection / payment-request messages, coupons), text that is
 * already stored (Notification.title / summary, InventoryAlert.message), and user content.
 */

export const systemHe = {
  tasks: {
    buckets: { overdue: "באיחור", today: "היום", noDate: "ללא תאריך", upcoming: "בהמשך השבוע" },
    sources: {
      supplier_payment: "תשלומים לספקים",
      customer_debt: "גבייה מלקוחות",
      invoice_review: "חשבוניות לבדיקה",
      lead: "לידים",
      conversation: "שיחות שמחכות לתשובה",
      documents_queue: "מסמכים לבדיקה",
      stock: "מלאי",
    },
    queue: {
      conversation: "{n} שיחות מחכות לתשובה",
      stock: "{n} פריטים במלאי נמוך",
      invoice_review: "{n} חשבוניות ממתינות לבדיקה",
      customer_debt: "{n} לקוחות לגבייה",
      documents_queue: "{n} מסמכים מחכים לבדיקה",
      lead: "{n} לידים",
      supplier_payment: "{n} תשלומים לספקים",
      factOldest: "הוותיק מחכה מ־{date} · פתח לרשימה",
      fact: "פתח לרשימה",
      open: "פתח",
    },
    overdue: { oneDay: "באיחור יום", twoDays: "באיחור יומיים", days: "באיחור {n} ימים" },
    tags: {
      pinned: "חשוב",
      updating: "מתעדכנת…",
      newCount: "חדשים: {n}",
      postponed: "התזכורת נדחתה {when} · עדיין לא שולם",
      postponedTomorrow: "למחר",
      postponedOn: "ל־{date}",
    },
    cadence: {
      daily: "כל יום",
      weekday: "כל יום {day}",
      weekdays: "בימים {days}",
      monthEnd: "בסוף כל חודש",
      monthDay: "כל {day} בחודש",
      everyNDays: "כל {n} ימים",
      listSeparator: ", ",
      full: { sun: "ראשון", mon: "שני", tue: "שלישי", wed: "רביעי", thu: "חמישי", fri: "שישי", sat: "שבת" },
      short: { sun: "א׳", mon: "ב׳", tue: "ג׳", wed: "ד׳", thu: "ה׳", fri: "ו׳", sat: "ש׳" },
    },
    relative: {
      justNow: "ממש עכשיו",
      minutes: "לפני {n} דקות",
      hour: "לפני שעה",
      hours: "לפני {n} שעות",
      yesterday: "מאתמול",
      since: "מ־{date}",
    },
    supplier: {
      wasDue: "היה אמור לצאת ב־{date}",
      notPaid: "עדיין לא שולם",
      dueToday: "לתשלום היום",
      dueOn: "לתשלום ב־{date}",
      remaining: "נותרו {amount}",
      action: "לתשלום",
    },
    debt: {
      title: "גבייה: {name}",
      customerFallback: "לקוח",
      oneInvoice: "חשבונית פתוחה אחת",
      invoices: "{n} חשבוניות פתוחות",
      oneDay: "יום אחד",
      days: "{n} יום",
      afterDue: "{days} אחרי המועד",
      action: "לתזכורת",
    },
    invoiceReview: { title: "חשבונית {number} ממתינה לבדיקה", created: "נוצרה {date}", action: "לחשבונית" },
    lead: {
      unnamed: "ליד ללא שם",
      newMessage: "הודעה חדשה מ{name}",
      followUp: "מעקב: {name}",
      newLead: "ליד חדש: {name}",
      lastMessage: "הודעה אחרונה {when}",
      plannedFor: "מעקב מתוכנן ל־{date}",
      entered: "נכנס {when}",
      toConversation: "לשיחה",
      toLead: "לליד",
    },
    conversation: {
      waiting: "{name} מחכה לתשובה",
      customerFallback: "לקוח",
      channel: { email: "מייל", phone: "טלפון", other: "שיחה" },
      fact: "{channel} · הודעה אחרונה {when}",
      action: "לשיחה",
    },
    documents: {
      one: "מסמך אחד מחכה לבדיקה",
      many: "{n} מסמכים מחכים לבדיקה",
      oldestToday: "הוותיק הגיע היום",
      oldestYesterday: "הוותיק הגיע אתמול",
      oldestDays: "הוותיק הגיע לפני {n} ימים",
      action: "לתור",
    },
    stock: {
      title: "{name} — {level}",
      itemFallback: "פריט",
      critical: "מלאי קריטי",
      low: "מלאי נמוך",
      belowCritical: "המלאי מתחת לסף הקריטי",
      belowReorder: "המלאי מתחת לסף ההזמנה",
      action: "להזמנה",
    },
    links: { leadFallback: "ליד", document: "מסמך {id}" },
    errors: {
      conflict: "המשימה השתנתה בינתיים. רעננו את הרשימה — נסה שוב.",
      notFound: "הפריט כבר לא ברשימה.",
      invalidInput: "חסר פרט או שהוא לא תקין.",
      invalidState: "אי אפשר לבצע את הפעולה הזו כרגע.",
      seriesEnded: "הסדרה הסתיימה.",
      linkNotFound: "הקישור לא נמצא בעסק.",
      linkLeadOpen: "לליד הזה כבר יש מעקב פתוח — עדכן אותו בליד עצמו.",
      keyStale: "הבקשה ישנה מדי. נסה שוב.",
      saveFailed: "לא הצלחנו לשמור. נסה שוב.",
    },
  },
  secretary: { serverError: "שגיאת שרת ({status})" },
  email: {
    greeting: "היי {name},",
    greetingAnon: "היי,",
    signature: "צוות Dubiz",
    welcome: {
      subject: "ברוכים הבאים ל־Dubiz 👋",
      cta: "כניסה ל־Dubiz",
      thanks: "כיף שהצטרפת ל־Dubiz.",
      value: "מעכשיו יש לך מקום אחד לנהל את העסק — הכנסות והוצאות, לקוחות, מסמכים, גבייה ועוד.",
      noSetup:
        "אין צורך להגדיר הכול מראש. פשוט מתחילים לעבוד, ו־Dubiz ילמד את העסק תוך כדי ויעזור לך לראות מה חשוב ומה דורש תשומת לב.",
      reason: "קיבלת את המייל הזה כי נפתח חשבון Dubiz עם הכתובת הזו.",
    },
    verify: {
      subject: "אימות כתובת האימייל שלך ב־Dubiz",
      preheader: "לחיצה אחת כדי לאשר שזו הכתובת שלך.",
      line: "כדי לוודא שהכתובת הזו שייכת לך, נשאר רק ללחוץ על הכפתור.",
      cta: "אימות הכתובת",
      after: "הקישור בתוקף ל־24 שעות ואפשר להשתמש בו פעם אחת.",
      reason: "קיבלת את המייל הזה כי נפתח חשבון Dubiz עם הכתובת הזו. אם לא ביקשת לפתוח חשבון — אפשר להתעלם ממנו.",
    },
    reset: {
      subject: "בחירת סיסמה חדשה ל־Dubiz",
      preheader: "הקישור לבחירת סיסמה חדשה בתוקף לשעה.",
      line: "קיבלנו בקשה לבחור סיסמה חדשה לחשבון שלך.",
      cta: "בחירת סיסמה חדשה",
      after: "הקישור בתוקף לשעה אחת ואפשר להשתמש בו פעם אחת. אחרי שינוי הסיסמה ננתק את כל המכשירים המחוברים לחשבון.",
      reason: "אם לא ביקשת לשנות סיסמה — אפשר להתעלם מהמייל. הסיסמה הנוכחית נשארת כמו שהיא.",
    },
  },
} as const;
