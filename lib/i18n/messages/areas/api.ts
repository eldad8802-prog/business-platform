/**
 * i18n area: api (server-produced text). Hebrew (source; English in ./api.en.ts). Registered in ../he.ts and ../en.ts.
 *
 * The human-readable messages API route handlers return (`error`, `message`, `warning`, …). Machine
 * fields (`code`, `field`, status) never come from here. Hebrew is the product's existing copy, moved
 * verbatim — a Hebrew-interface response is byte-identical to what it was before.
 */

export const apiHe = {
  common: {
    unauthenticated: "לא מחובר",
    noPermission: "אין הרשאה",
    invalidRequest: "בקשה לא תקינה",
    invalidRequestDot: "בקשה לא תקינה.",
    noFileSelected: "לא נבחר קובץ",
    fileTooLarge15: "הקובץ גדול מדי (עד 15MB)",
    fileTooLargeMb: "הקובץ גדול מדי (עד {mb}MB)",
    heicUnsupported: "פורמט HEIC לא נתמך. צלם מחדש או המר את התמונה ל-JPG (בהגדרות המצלמה: 'תאימות מרבית').",
    unsupportedFileType: "סוג קובץ לא נתמך (נדרש PDF, JPG או PNG)",
  },
  auth: {
    messages: {
      rateLimited: "יותר מדי ניסיונות. כדאי לחכות כמה דקות ולנסות שוב.",
      missingCredentials: "יש להזין אימייל וסיסמה",
      invalidCredentials: "האימייל או הסיסמה שגויים",
      invalidBody: "הבקשה לא התקבלה. כדאי לרענן את הדף ולנסות שוב.",
      serverError: "משהו השתבש אצלנו. כדאי לנסות שוב בעוד רגע.",
      serviceUnavailable: "השירות לא זמין כרגע. כדאי לנסות שוב מאוחר יותר.",
      signupRejected: "לא הצלחנו לפתוח את החשבון. כדאי לרענן את הדף ולנסות שוב.",
      /** The one answer to every forgot-password request, whether or not the address has an account. */
      resetRequested: "אם הכתובת רשומה אצלנו, שלחנו אליה קישור לבחירת סיסמה חדשה. הקישור בתוקף לשעה.",
      resetDone: "הסיסמה עודכנה. מעכשיו נכנסים עם הסיסמה החדשה.",
      tokenInvalid: "הקישור לא תקין. כדאי לבקש קישור חדש.",
      tokenExpired: "תוקף הקישור פג. כדאי לבקש קישור חדש.",
      tokenUsed: "כבר השתמשו בקישור הזה. כדאי לבקש קישור חדש אם צריך.",
      tokenSuperseded: "נשלח קישור חדש יותר. כדאי להשתמש בקישור האחרון שקיבלתם.",
      emailVerified: "כתובת האימייל אומתה. תודה!",
      verificationSent: "שלחנו קישור אימות לכתובת האימייל שלכם.",
      alreadyVerified: "כתובת האימייל כבר מאומתת.",
      featureUnavailable: "האפשרות הזו עדיין לא זמינה.",
      /** After the third failed sign-in for an address — the owner-approved wording, verbatim. */
      loginLastAttemptWarning: "שים לב, נותר לך ניסיון התחברות אחד לפני חסימה זמנית ל־15 דקות.",
    },
    /** The temporary sign-in lock; {left} is lockOneMinute or lockMinutes. */
    loginLocked: "מטעמי אבטחה, הכניסה עם כתובת האימייל הזו נחסמה זמנית אחרי כמה ניסיונות שגויים. אפשר לנסות שוב בעוד {left}.",
    lockOneMinute: "דקה אחת",
    lockMinutes: "{minutes} דקות",
    invalidEmail: "יש להזין כתובת אימייל תקינה",
    weakPassword: "הסיסמה חייבת להכיל לפחות {min} תווים",
    emailAlreadyRegistered: "כתובת האימייל הזו כבר רשומה במערכת",
  },
  business: {
    nameRequired: "יש להזין שם עסק",
    nameLength: "שם העסק צריך להכיל {min}–{max} תווים",
    productLinkRequired: "כשמפעילים עזרה עם מוצרים, נדרש קישור מלא ותקין (כולל https:// או http://)",
    setup: {
      noContactDetails: "בלי טלפון, אימייל או קישור — כאן רק מה שהעסק עושה, במילים שלכם.",
      tooLong: "הטקסט ארוך מדי — עד 500 תווים.",
      saveFailed: "לא הצלחנו לשמור את התשובה. אפשר לנסות שוב.",
      invalidAnswer: "התשובה לא תקינה",
      conflict: "התשובה השתנתה במקביל. אפשר לנסות שוב.",
    },
  },
  content: {
    renderBriefRequired: "חסר בריף יעד מספיק מפורט — לא ניתן להרכיב סרטון מהפרופיל העסקי בלבד.",
    videoPlanBriefRequired: "חסר בריף יעד מפורט. חזרו לשלב ההגדרה והשלימו «מה מקדמים» ו«מה עוצר לקוחות» לפני יצירת סרטון.",
  },
  crm: {
    oneFileAtATime: "ניתן להעלות קובץ אחד בכל פעם",
  },
  dataTransfer: {
    unknownDomain: "תחום לא נתמך לייבוא",
    tokenMissing: "חסר אישור בדיקה. יש להריץ בדיקה מחדש.",
    mappingInvalid: "התאמת העמודות אינה תקינה",
    decisionsInvalid: "הבחירות אינן תקינות",
    analyzeFailed: "ניתוח הקובץ נכשל. נסו שוב מאוחר יותר.",
    previewFailed: "בדיקת הקובץ נכשלה. נסו שוב מאוחר יותר.",
    importFailedPartial: "הייבוא נכשל. אם חלק מהשורות כבר נוצרו, הרצה חוזרת של אותו קובץ תשלים רק את מה שחסר.",
    templateFailed: "יצירת התבנית נכשלה. נסו שוב מאוחר יותר.",
    noTemplateForDomain: "אין תבנית לתחום המבוקש",
    exportTooLarge: "כמות הנתונים גדולה מדי לייצוא אחד. בחר פחות תחומים ונסה שוב.",
    exportFailed: "הייצוא נכשל. נסה שוב מאוחר יותר.",
    documents: {
      unknownFile: "בחירה עבור קובץ שאינו בקבוצה",
      decisionNotPermitted: "לא ניתן לקלוט את הקובץ הזה",
      analyzeFailed: "בדיקת הקבצים נכשלה. נסו שוב מאוחר יותר.",
      decisionsMissing: "חסרות הבחירות שאושרו",
      executeFailed: "קליטת הקבצים נכשלה. נסו שוב מאוחר יותר.",
      invalidRange: "טווח התאריכים אינו תקין",
      startAfterEnd: "תאריך ההתחלה מאוחר מתאריך הסיום",
      noDocuments: "אין מסמכים לייצוא בטווח שנבחר.",
      exportFailed: "ייצוא המסמכים נכשל. נסו שוב מאוחר יותר.",
    },
    historical: {
      previewTokenMissing: "חסר אישור התצוגה המקדימה",
      importFailed: "הייבוא נכשל. נסו שוב מאוחר יותר.",
      previewFailed: "בניית התצוגה המקדימה נכשלה. נסו שוב מאוחר יותר.",
      recordFailed: "טעינת המסמך נכשלה. נסו שוב מאוחר יותר.",
      recordsFailed: "טעינת ההיסטוריה נכשלה. נסו שוב מאוחר יותר.",
    },
  },
  documents: {
    notFound: "המסמך לא נמצא",
    invalidId: "מזהה מסמך לא תקין",
    loadFailed: "שגיאה בטעינת המסמך. נסה שוב מאוחר יותר.",
    approve: {
      missingAmount: "חסר סכום תקין לאישור כספי",
      missingVendor: "חסר שם ספק לאישור כספי",
      missingDirection: "חסר כיוון (הכנסה/הוצאה) לאישור כספי",
      financialLocked: "המסמך כבר אושר ונרשם כספית. שינוי הרישום יתאפשר רק דרך תיקון מבוקר.",
      failed: "שגיאה באישור המסמך. נסה שוב מאוחר יותר.",
    },
    process: {
      sourceMissing: "קובץ המקור לא נמצא. יש להעלות מחדש.",
      failed: "שגיאה בעיבוד המסמך. נסה שוב מאוחר יותר.",
    },
    inbox: {
      periodFailed: "שגיאה בטעינת התקופה",
      invalidMonth: "חודש לא תקין (פורמט YYYY-MM)",
      invalidCursor: "סמן עמוד לא תקין",
      loadFailed: "שגיאה בטעינת המסמכים. נסה שוב מאוחר יותר.",
    },
    upload: {
      duplicate: "נראה שהמסמך הזה כבר הועלה",
      failed: "שגיאה בהעלאת המסמך. נסה שוב מאוחר יותר.",
    },
  },
  gmail: {
    invalidConnectionId: "connectionId לא תקין",
    accountNotFound: "החשבון לא נמצא",
    attachmentNotInMessage: "הקובץ המצורף לא נמצא בהודעה",
    attachmentEmpty: "הקובץ המצורף ריק",
    reconnectRequired: "החיבור ל-Gmail פג. יש לחבר מחדש כדי להמשיך.",
    importFailed: "שגיאה בייבוא המסמך. נסה שוב מאוחר יותר.",
    syncFailed: "שגיאה בסריקת המיילים. נסה שוב מאוחר יותר.",
  },
  inboundEmail: {
    notConfigured: "שירות קבלת המסמכים במייל עדיין לא הוגדר.",
    noActiveAddress: "אין כתובת פעילה להחלפה.",
    addressNotFound: "הכתובת לא נמצאה.",
    emailRequired: "יש להזין כתובת מייל.",
    emailInvalid: "כתובת המייל אינה תקינה.",
    senderNotFound: "השולח לא נמצא.",
  },
  inbox: {
    attention: {
      waitingForReply: "הלקוח שלח הודעה אחרונה; כדאי להשיב כשמתאים.",
      pendingSuggestion: "יש הצעת תשובה שעדיין לא נשלחה או נסגרה.",
      recentlyHandled: "השיחה סומנה לאחרונה כסגורה.",
    },
  },
  inventory: {
    imageUploadUnavailable: "לא ניתן להעלות תמונת מוצר כרגע. נסה שוב מאוחר יותר.",
  },
  payments: {
    /** A payment request in a currency the Dubiz set or the connected provider does not allow. */
    currencyNotOffered: "אי אפשר לבקש תשלום ב-{currency} דרך ספק הסליקה המחובר. אפשר לבקש ב: {allowed}.",
    /** An invoice-backed request sent in a currency other than the invoice's. */
    currencyMustMatchInvoice: "בקשת תשלום על חשבונית נשלחת במטבע של החשבונית ({currency}).",
    /** Foreign-currency collection is switched off (DUBIZ_FX_COLLECTION_ENABLED): ILS only. */
    foreignCurrencyCollectionDisabled: "גבייה ב-{currency} עדיין לא פתוחה. אפשר לבקש תשלום ב-{allowed} בלבד.",
    /** Switch on, but the collector is not CardCom issuing the documents (PROVIDER_ISSUES): ILS only. */
    foreignCurrencyRequiresProviderDocuments: "גבייה ב-{currency} אפשרית רק דרך CardCom, כשהמסמכים מופקים ב-CardCom (בהגדרות חיבור CardCom). אפשר לבקש תשלום ב-{allowed} בלבד.",
  },
  pricing: {
    profitLow: "נמוך",
    profitOk: "תקין",
    profitHigh: "גבוה",
  },
} as const;
