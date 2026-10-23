/**
 * i18n area: api (server-produced text). Hebrew (source) + English. Registered in ../he.ts and ../en.ts.
 *
 * The human-readable messages API route handlers return (`error`, `message`, `warning`, …). Machine
 * fields (`code`, `field`, status) never come from here. Hebrew is the product's existing copy, moved
 * verbatim — a Hebrew-interface response is byte-identical to what it was before.
 */
import type { Widen } from "../types";

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
  },
  pricing: {
    profitLow: "נמוך",
    profitOk: "תקין",
    profitHigh: "גבוה",
  },
} as const;

export const apiEn: Widen<typeof apiHe> = {
  common: {
    unauthenticated: "Not signed in",
    noPermission: "Permission denied",
    invalidRequest: "Invalid request",
    invalidRequestDot: "Invalid request.",
    noFileSelected: "No file selected",
    fileTooLarge15: "The file is too large (up to 15MB)",
    fileTooLargeMb: "The file is too large (up to {mb}MB)",
    heicUnsupported: "HEIC format is not supported. Retake the photo or convert it to JPG (in the camera settings: 'Most Compatible').",
    unsupportedFileType: "Unsupported file type (PDF, JPG or PNG required)",
  },
  auth: {
    messages: {
      rateLimited: "Too many attempts. Please wait a few minutes and try again.",
      missingCredentials: "Enter an email and a password",
      invalidCredentials: "The email or password is incorrect",
      invalidBody: "The request was not received. Please refresh the page and try again.",
      serverError: "Something went wrong on our side. Please try again in a moment.",
      serviceUnavailable: "The service is unavailable right now. Please try again later.",
      signupRejected: "We couldn't create the account. Please refresh the page and try again.",
      resetRequested: "If this address is registered with us, we've sent it a link to choose a new password. The link is valid for one hour.",
      resetDone: "Your password was updated. From now on, sign in with the new password.",
      tokenInvalid: "This link is not valid. Please request a new one.",
      tokenExpired: "This link has expired. Please request a new one.",
      tokenUsed: "This link was already used. Request a new one if needed.",
      tokenSuperseded: "A newer link was sent. Please use the latest link you received.",
      emailVerified: "Your email address is verified. Thank you!",
      verificationSent: "We've sent a verification link to your email address.",
      alreadyVerified: "Your email address is already verified.",
      featureUnavailable: "This option is not available yet.",
      loginLastAttemptWarning: "Note: you have one sign-in attempt left before a temporary 15-minute lock.",
    },
    loginLocked: "For security reasons, signing in with this email address is temporarily blocked after several failed attempts. You can try again in {left}.",
    lockOneMinute: "one minute",
    lockMinutes: "{minutes} minutes",
    invalidEmail: "Enter a valid email address",
    weakPassword: "The password must be at least {min} characters long",
    emailAlreadyRegistered: "This email address is already registered",
  },
  business: {
    nameRequired: "Enter a business name",
    nameLength: "The business name must be {min}–{max} characters long",
    productLinkRequired: "When product help is turned on, a full, valid link is required (including https:// or http://)",
    setup: {
      noContactDetails: "No phone, email or link — just what the business does, in your own words.",
      tooLong: "The text is too long — up to 500 characters.",
      saveFailed: "We couldn't save the answer. Please try again.",
      invalidAnswer: "The answer is not valid",
      conflict: "The answer was changed at the same time. Please try again.",
    },
  },
  content: {
    renderBriefRequired: "A detailed enough goal brief is missing — a video can't be built from the business profile alone.",
    videoPlanBriefRequired: "A detailed goal brief is missing. Go back to the setup step and fill in “What are we promoting” and “What stops customers” before creating a video.",
  },
  crm: {
    oneFileAtATime: "You can upload one file at a time",
  },
  dataTransfer: {
    unknownDomain: "This area is not supported for import",
    tokenMissing: "The check approval is missing. Please run the check again.",
    mappingInvalid: "The column mapping is not valid",
    decisionsInvalid: "The choices are not valid",
    analyzeFailed: "Analyzing the file failed. Please try again later.",
    previewFailed: "Checking the file failed. Please try again later.",
    importFailedPartial: "The import failed. If some rows were already created, running the same file again will complete only what is missing.",
    templateFailed: "Creating the template failed. Please try again later.",
    noTemplateForDomain: "There is no template for the requested area",
    exportTooLarge: "There is too much data for a single export. Choose fewer areas and try again.",
    exportFailed: "The export failed. Please try again later.",
    documents: {
      unknownFile: "A choice was made for a file that is not in the batch",
      decisionNotPermitted: "This file can't be imported",
      analyzeFailed: "Checking the files failed. Please try again later.",
      decisionsMissing: "The approved choices are missing",
      executeFailed: "Importing the files failed. Please try again later.",
      invalidRange: "The date range is not valid",
      startAfterEnd: "The start date is after the end date",
      noDocuments: "There are no documents to export in the selected range.",
      exportFailed: "Exporting the documents failed. Please try again later.",
    },
    historical: {
      previewTokenMissing: "The preview approval is missing",
      importFailed: "The import failed. Please try again later.",
      previewFailed: "Building the preview failed. Please try again later.",
      recordFailed: "Loading the document failed. Please try again later.",
      recordsFailed: "Loading the history failed. Please try again later.",
    },
  },
  documents: {
    notFound: "Document not found",
    invalidId: "Invalid document ID",
    loadFailed: "Error loading the document. Please try again later.",
    approve: {
      missingAmount: "A valid amount is required for financial approval",
      missingVendor: "A supplier name is required for financial approval",
      missingDirection: "A direction (income/expense) is required for financial approval",
      financialLocked: "This document was already approved and recorded financially. The record can only be changed through a controlled correction.",
      failed: "Error approving the document. Please try again later.",
    },
    process: {
      sourceMissing: "The source file was not found. Please upload it again.",
      failed: "Error processing the document. Please try again later.",
    },
    inbox: {
      periodFailed: "Error loading the period",
      invalidMonth: "Invalid month (format YYYY-MM)",
      invalidCursor: "Invalid page cursor",
      loadFailed: "Error loading the documents. Please try again later.",
    },
    upload: {
      duplicate: "It looks like this document was already uploaded",
      failed: "Error uploading the document. Please try again later.",
    },
  },
  gmail: {
    invalidConnectionId: "Invalid connectionId",
    accountNotFound: "Account not found",
    attachmentNotInMessage: "The attachment was not found in the message",
    attachmentEmpty: "The attachment is empty",
    reconnectRequired: "The Gmail connection has expired. Reconnect to continue.",
    importFailed: "Error importing the document. Please try again later.",
    syncFailed: "Error scanning emails. Please try again later.",
  },
  inboundEmail: {
    notConfigured: "Receiving documents by email is not set up yet.",
    noActiveAddress: "There is no active address to replace.",
    addressNotFound: "Address not found.",
    emailRequired: "Enter an email address.",
    emailInvalid: "The email address is not valid.",
    senderNotFound: "Sender not found.",
  },
  inbox: {
    attention: {
      waitingForReply: "The customer sent the last message; reply when it suits you.",
      pendingSuggestion: "There is a suggested reply that hasn't been sent or closed yet.",
      recentlyHandled: "The conversation was recently marked as closed.",
    },
  },
  inventory: {
    imageUploadUnavailable: "Product images can't be uploaded right now. Please try again later.",
  },
  payments: {
    currencyNotOffered: "A payment can't be requested in {currency} through the connected payment provider. Available: {allowed}.",
    currencyMustMatchInvoice: "A payment request for an invoice uses the invoice's currency ({currency}).",
    foreignCurrencyCollectionDisabled: "Collecting in {currency} isn't available yet. Payment requests can be made in {allowed} only.",
  },
  pricing: {
    profitLow: "Low",
    profitOk: "OK",
    profitHigh: "High",
  },
};
