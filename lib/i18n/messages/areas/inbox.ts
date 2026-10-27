/**
 * i18n area: inbox. Hebrew (source; English in ./inbox.en.ts) for this product area only — each area owns its own
 * file so areas can be translated independently. Registered in ../he.ts and ../en.ts.
 *
 * Covers the Inbox (conversations list + thread + desktop panels), the WhatsApp connection flow
 * (formerly components/whatsapp/wa-copy.ts — `whatsapp.*` is that copy, verbatim) and the shared
 * CRM notes / attachments sections.
 *
 * NOT here (by design): customer messages, customer names, the quick-reply sentences the owner
 * sends to customers (outbound message content), and labels computed in lib/inbox-view.
 */

export const inboxHe = {
  /** WhatsApp connection experience — the approved UX copy ("שלושה רגעים"), verbatim. */
  whatsapp: {
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
      /** "<heading> — <reason>" on the settings card. */
      withReason: "{heading} — {reason}",
      /** Specific reason lines, keyed by the connect flow's error codes. Anything else → `body`. */
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
      },
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
    },
    /** A row exists but the number no longer receives messages in Dubiz. */
    disconnectedNotice: {
      DISCONNECTED: "המספר נותק מ-Dubiz והודעות חדשות לא מתקבלות. אפשר לחבר אותו מחדש.",
      REVOKED: "ההרשאה למספר בוטלה והודעות חדשות לא מתקבלות. אפשר לחבר אותו מחדש.",
      numberLabel: "המספר הקודם",
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
    /** Inbox entry prompt shown while WhatsApp is not connected. */
    connectCard: {
      title: "המזכירה שלך עדיין לא עובדת",
      body: "חבר את ה-WhatsApp שלך כדי שהמזכירה תוכל לעקוב אחרי לקוחות, להכין תשובות ולהזכיר למי לחזור.",
      cta: "הפעל את המזכירה",
    },
    /** Settings — what Dubiz stores from Meta, and deleting it. */
    privacy: {
      title: "פרטיות ונתונים",
      body: "Dubiz שומרת רק את המידע הדרוש להפעלת החיבור ל-WhatsApp Business.",
      link: "מה נמחק ומה נשמר — מחיקת נתוני חיבור Meta",
      deleteButton: "מחק את נתוני Meta שנשמרו ב-Dubiz",
      deleteError: "לא הצלחנו למחוק את נתוני Meta כרגע. אפשר לנסות שוב.",
      deleted: "נתוני Meta שנשמרו ב-Dubiz נמחקו.",
      dialogTitle: "מחק את נתוני Meta?",
      dialogBody:
        "פעולה זו תמחק את פרטי החיבור שנשמרו ב-Dubiz, כולל מזהי WhatsApp Business, מספר החיבור ואסימוני הגישה.",
      dialogKept: "השיחות, הלקוחות וההודעות הקיימות לא יימחקו.",
      dialogReconnect: "תוכל לחבר את WhatsApp Business מחדש בכל עת.",
      cancel: "ביטול",
      confirm: "מחק נתוני Meta",
      confirmBusy: "מוחקים...",
    },
  },

  /** Inbox page shell (app/(shell)/inbox). */
  page: {
    loginRequired: "יש להתחבר כדי לגשת לתיבת הדואר.",
    listRegion: "רשימת שיחות",
    threadRegion: "שיחה",
    title: "שיחות",
    searchPlaceholder: "חיפוש שיחות...",
    focusAll: "הכל",
    stage: {
      unknown: "לא ידוע",
      early: "התחלה",
      middle: "אמצע",
      closing: "סגירה",
    },
    indicator: {
      needsReply: "דורש תגובה",
      waitingOwner: "ממתין לבעל העסק",
      advanced: "שיחה מתקדמת",
      active: "שיחה פעילה",
      new: "שיחה חדשה",
    },
    summary: {
      waitingLabel: "מחכים לך",
      waitingHelper: "כאן מתחילים, כדי שאף לקוח לא יישאר באוויר",
      quickLabel: "אפשר לסגור מהר",
      quickHelper: "טיוטות שהמערכת כבר הכינה לך",
      calmLabel: "לא צריך לגעת כרגע",
      calmHelper: "טיוטות מוכנות — אתה שולח. {count} שיחות פתוחות",
      calmHelperOne: "טיוטות מוכנות — אתה שולח. {count} שיחות פתוחות",
    },
  },

  /** Work-category names — mirror lib/inbox-view/work-category INBOX_SIDEBAR_CATEGORY_OPTIONS. */
  workCategories: {
    needs_action: "דורש פעולה",
    drafts_ready: "טיוטות מוכנות",
    handoff: "עבר לנציג",
    bot_in_progress: "בוט בתהליך",
    hot_leads: "לידים חמים",
    follow_up: "מעקב",
    completed: "הושלמו",
    active: "פעילות / ללא דחיפות",
    closed: "סגורות",
  },

  /** The phone triage screen's category rows (components/inbox/inbox-ui-tokens). */
  categoryVisuals: {
    needs_action: { label: "דחוף - טיפול נדרש", subtitle: "לקוחות שמחכים לך עכשיו" },
    hot_leads: { label: "חם - הזדמנות", subtitle: "פניות עם סיכוי גבוה לעסקה" },
    active: { label: "ממתין לתשובת לקוח", subtitle: "שלחת — מחכים לתגובה" },
    bot_in_progress: { label: "טיוטות מוכנות", subtitle: "הבוט הכין — אתה שולח ללקוח" },
    follow_up: { label: "חוזר לעדכן", subtitle: "שיחות שלא כדאי לשכוח" },
    handoff: { label: "מחכה לך", subtitle: "הבוט סיים — אתה ממשיך" },
    drafts_ready: { label: "ניסוח תגובות", subtitle: "טיוטות מוכנות לשליחה" },
    closed: { label: "נסגרו", subtitle: "היסטוריה ושיחות שטופלו" },
  },

  /** components/inbox/ConversationList. */
  list: {
    waitingMinutes: "{count} דק׳",
    waitingHours: "{count} שע׳",
    today: "היום",
    conversationsCount: "{count} שיחות",
    conversationsCountOne: "{count} שיחות",
    categoryEmpty: "אין שיחות בקטגוריה",
    allConversations: "כל השיחות",
    allOpenConversations: "כל השיחות הפתוחות",
    open: "פתוחות",
    closed: "נסגרו",
    history: "היסטוריה",
    waitingNone: "אין כרגע שיחות שממתינות לך",
    waitingOne: "יש לך שיחה אחת שממתינה לך",
    waitingMany: "יש לך {count} שיחות שממתינות לך",
    agendaTitle: "סדר היום שלך",
    categoriesNav: "קטגוריות עבודה",
    categoryRowLabel: "{label}, {count} שיחות",
    categoryRowLabelOne: "{label}, {count} שיחות",
    /** Forward chevron on a category row (points to inline-end). */
    chevronForward: "‹",
    botSettings: "הגדרות הבוט",
    backToCategories: "חזרה לקטגוריות",
    nothingHere: "אין כאן משהו לטפל בו",
    newCustomer: "לקוח חדש",
    createConversation: "צור שיחה חדשה",
    badge: {
      waitingForYou: "מחכה לך",
      draftReady: "טיוטה מוכנה",
      goodChance: "סיכוי טוב",
      tracking: "במעקב",
    },
    empty: {
      allOpen: "אין שיחות פתוחות כרגע",
      fallback: "אין שיחות בקטגוריה זו כרגע",
      needs_action: "אין כרגע לקוחות שמחכים לך. אפשר לנשום.",
      drafts_ready: "אין כרגע טיוטות מוכנות לשליחה.",
      handoff: "אין שיחות שמחכות לך אחרי סיום הטיוטות.",
      bot_in_progress: "אין שיחות עם טיוטות פתיחה ממתינות.",
      hot_leads: "אין כרגע לידים חמים שדורשים תשומת לב.",
      follow_up: "אין כרגע מעקבים פתוחים.",
      completed: "אין שיחות שטופלו בקטגוריה הזו.",
      active: "הכול בשליטה בקטגוריה הזו.",
      closed: "אין שיחות סגורות להצגה.",
    },
  },

  /** components/inbox/ConversationView. */
  view: {
    starterDraft: "טיוטת פתיחה",
    suggestion: "הצעה",
    actions: {
      SHOW_PRODUCT_LINK: "שלח קישור למוצר",
      CREATE_FOLLOW_UP: "מעקב קצר",
      HANDOFF_TO_OWNER: "קח טיפול",
      SAVE_DOCUMENT_FROM_CHAT: "שמור קובץ",
      CREATE_LEAD: "ברר צורך",
      MARK_QUOTE_SENT: "שלח הצעת מחיר",
      CREATE_INVOICE_DRAFT: "הכן תשלום",
      CHECK_PRODUCT_AVAILABILITY: "בדוק זמינות",
      BOOK_APPOINTMENT: "תאם זמן",
      fallback: "פעולה מומלצת",
    },
    chips: {
      followUpQuote: "מעקב להצעה",
      askDetails: "בקש עוד פרט",
      productLink: "שלח קישור למוצר",
      followUp: "מעקב קצר",
      markDone: "סיים שיחה",
      createLead: "צור ליד",
    },
    whisper: {
      closed: "השיחה נסגרה",
      takeover: "אתה מטפל מכאן",
      draftReady: "טיוטה מוכנה לשליחה",
      waitingForYou: "מחכה לך",
      starterDone: "סיום פתיחה — מחכה לך",
      awaitingYourReply: "ממתינה לתשובה שלך",
      quoteWaiting: "ממתין לתשובה על ההצעה",
      followUpDue: "כדאי לחזור ללקוח",
      waitingOnCustomer: "ממתין לתשובת הלקוח",
      hotOpportunity: "הזדמנות חמה",
      newLead: "פנייה חדשה",
    },
    createLeadFailed: "לא הצלחנו ליצור ליד מהשיחה",
    pickTitle: "בחר שיחה",
    pickBody: "בחר שיחה מהרשימה כדי להמשיך את השיחה עם הלקוח.",
    backToConversations: "חזרה לשיחות",
    options: "אפשרויות",
    takeOver: "אני מטפל מכאן",
    endConversation: "סיים שיחה",
    takeOverHint: "אפשר לקחת שליטה בכל רגע",
    noMessages: "אין הודעות עדיין",
    attach: "צרף קובץ",
    composerPlaceholder: "הודעה",
    clear: "נקה",
    send: "שלח",
    simulateCustomer: "תצוגה: הודעת לקוח",
  },

  /** components/inbox/InboxDesktopPanels. */
  panels: {
    startTitle: "מה מחכה בשיחות",
    startBody: "הרשימה מסודרת לפי מה שדחוף. אפשר להתחיל מלמעלה, או לבחור שיחה.",
    open: "פתח ←",
    channel: {
      EMAIL: "אימייל",
      PHONE: "טלפון",
      OTHER: "אחר",
    },
    waitingMinutes: "{count} דק׳",
    waitingHourOne: "שעה",
    waitingHours: "{count} שעות",
    waitingDayOne: "יום",
    waitingDays: "{count} ימים",
    contextLabel: "על השיחה",
    rows: {
      channel: "ערוץ",
      phone: "טלפון",
      stage: "שלב",
      situation: "מצב",
      waiting: "מחכה לתשובה",
      bot: "הבוט",
    },
    youHandle: "אתה מטפל בשיחה",
    nextStep: "הצעד הבא",
    customerCard: "כרטיס הלקוח ←",
  },

  /** components/inbox/InboxConnectedEmptyState. */
  emptyState: {
    loadFailedHeading: "לא הצלחנו לטעון את השיחות",
    loadFailedBody: "ייתכן שיש שיחות שלא מוצגות כרגע. אפשר לנסות שוב.",
    title: "שיחות",
    searchPlaceholder: "חיפוש שיחות…",
    retry: "נסה שוב",
  },

  /** components/crm — notes + attachments sections (Customers / Leads / Suppliers). */
  crm: {
    retry: "נסו שוב",
    loading: "טוען…",
    shownOfTotal: "מוצגים {shown} מתוך {total}",
    confirmDelete: "למחוק?",
    deleting: "מוחק…",
    delete: "מחק",
    deleteAction: "מחיקה",
    cancel: "ביטול",
    notes: {
      title: "הערות",
      loadFailed: "לא הצלחנו לטעון את ההערות",
      empty: "לא ניתן לשמור הערה ריקה",
      saveFailed: "לא הצלחנו לשמור",
      updateFailed: "לא הצלחנו לעדכן",
      deleteFailed: "לא הצלחנו למחוק",
      placeholder: "הוסף הערה…",
      saving: "שומר…",
      add: "הוסף הערה",
      none: "אין עדיין הערות. אפשר להוסיף את ההערה הראשונה למעלה.",
      unknownAuthor: "משתמש",
      loadMore: "טען הערות קודמות",
      loadMoreFailed: "לא הצלחנו לטעון הערות קודמות. ההערות שכבר מוצגות נשארו.",
      save: "שמירה",
      edit: "עריכה",
    },
    attachments: {
      title: "קבצים",
      loadFailed: "לא הצלחנו לטעון את הקבצים",
      uploadFailed: "העלאה נכשלה",
      downloadFailed: "ההורדה נכשלה",
      deleteFailed: "המחיקה נכשלה",
      uploading: "מעלה קובץ…",
      upload: "העלה קובץ",
      progress: "התקדמות העלאה",
      none: "אין עדיין קבצים. אפשר להעלות את הקובץ הראשון למעלה.",
      download: "הורדה",
      loadMore: "טען קבצים קודמים",
      loadMoreFailed: "לא הצלחנו לטעון קבצים קודמים. הקבצים שכבר מוצגים נשארו.",
    },
  },
} as const;
