import { apiHe } from "./areas/api";
import { insightsHe } from "./areas/insights";
import { systemHe } from "./areas/system";
import { homeHe } from "./areas/home";
import { inboxHe } from "./areas/inbox";
import { documentsHe } from "./areas/documents";
import { billingHe } from "./areas/billing";
import { moneyHe } from "./areas/money";
import { customersHe } from "./areas/customers";
import { tasksHe } from "./areas/tasks";
import { accountHe } from "./areas/account";
import { contentHe } from "./areas/content";

/**
 * Hebrew — the SOURCE dictionary. Every other language must provide exactly these keys
 * (enforced by the `Messages` type). Text here is the product's existing Hebrew copy, moved
 * verbatim — moving a string into this file must never change what a Hebrew user sees.
 *
 * Namespaces mirror product areas. User-entered content, issued documents, tax-authority formats
 * and LLM prompts are NOT interface strings and never belong here.
 */
export const he = {
  meta: {
    titles: {
      home: "בית",
      documents: "מסמכים",
      inventory: "מלאי",
      suppliers: "ספקים",
      billing: "חשבוניות",
      settings: "הגדרות",
      login: "התחברות",
      register: "הרשמה",
      forgotPassword: "שכחתי סיסמה",
      resetPassword: "בחירת סיסמה חדשה",
      verifyEmail: "אימות כתובת האימייל",
      collectionThread: "תיק גבייה",
      collectionNew: "גבייה חדשה",
      collection: "גבייה",
      profile: "פרופיל",
      identity: "הנוכחות הדיגיטלית של העסק",
    },
  },
  common: {
    loading: "טוען…",
    save: "שמירה",
    saving: "שומר…",
    saved: "נשמר",
    cancel: "ביטול",
    close: "סגירה",
    back: "חזרה",
    retry: "לנסות שוב",
    errorGeneric: "משהו השתבש. אפשר לנסות שוב.",
    emptyValue: "—",
  },
  nav: {
    groups: {
      money: "כסף",
      customers: "לקוחות ומכירות",
      business: "ניהול העסק",
    },
    home: "בית",
    chats: "שיחות",
    docs: "מסמכים",
    notifications: "התראות",
    payments: "גבייה",
    billing: "חשבוניות",
    customers: "לקוחות",
    leads: "לידים",
    tasks: "משימות",
    secretary: "המזכירה שלי",
    payables: "התחייבויות",
    inventory: "מלאי",
    settings: "הגדרות",
    a11y: {
      mainNav: "ניווט ראשי",
      bottomNav: "ניווט תחתון",
      homeLink: "Dubiz — בית",
      newAction: "פעולה חדשה",
      search: "חיפוש",
      accessibility: "נגישות",
      unreadNotifications: "יש התראות שלא נקראו",
      needsAttention: "יש משהו שדורש טיפול",
      pendingCount: "{count} ממתינים",
      businessProfile: "פרופיל העסק — {name}",
    },
  },
  currency: {
    ILS: "שקל ישראלי",
    USD: "דולר אמריקאי",
    EUR: "אירו",
    approximatePrefix: "≈",
    convertedNote: "סכום מומר לתצוגה בלבד, לפי שער {rateDate}",
    mixedCurrencies: "כולל סכומים בכמה מטבעות",
    rateMissing: "אין שער חליפין מאומת להמרה",
  },
  settingsLocale: {
    categoryTitle: "שפה, אזור ומטבע",
    categoryDescription: "שפת המערכת, אזור זמן, מטבע בסיס ומטבע תצוגה",
    title: "שפה, אזור ומטבע",
    languageSection: "שפת מערכת",
    languageHelp: "משנה את שפת הממשק ואת כיוון התצוגה. אינה משנה נתונים, סכומים או מסמכים שהופקו.",
    regionSection: "אזור ואזור זמן",
    regionLabel: "אזור",
    regionValueIL: "ישראל",
    timeZoneLabel: "אזור זמן",
    regionHelp: "אזור הזמן לא משתנה כשמחליפים שפה.",
    baseCurrencySection: "מטבע בסיס",
    baseCurrencyHelp: "המטבע שבו העסק מנהל את הדיווח הפנימי שלו. סכומים מקוריים נשמרים תמיד במטבע שבו נרשמו.",
    baseCurrencyLocked: "שינוי מטבע בסיס לעסק עם פעילות פיננסית מחייב תהליך מבוקר נפרד, ואינו זמין עדיין.",
    displayCurrencySection: "מטבע תצוגה",
    displayCurrencyHelp: "המטבע שבו מוצגים סיכומים והמרות. בחירה כאן אינה משנה אף נתון — סכומים מומרים מסומנים.",
    displayFollowsBase: "לפי מטבע הבסיס",
    comingSoon: "בקרוב",
    languageSaved: "השפה עודכנה",
  },
  home: homeHe,
  inbox: inboxHe,
  documents: documentsHe,
  billing: billingHe,
  money: moneyHe,
  customers: customersHe,
  tasks: tasksHe,
  account: accountHe,
  content: contentHe,
  api: apiHe,
  insights: insightsHe,
  system: systemHe,
} as const;
