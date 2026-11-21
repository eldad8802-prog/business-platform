/**
 * The activity screens' own copy (after signup + Settings → תחומי הפעילות), Hebrew and English.
 *
 * Kept OUT of the global dictionary on purpose: the dictionary ships with every page, while these strings are needed
 * only by the two activity screens — so they load only there (i18n en-chunk proof: Hebrew client JS budget). The
 * English half is a few hundred bytes on those two screens only, never on any other page.
 */
import type { Locale } from "@/lib/i18n/config";

export type ActivityPackCopyKey = "APPOINTMENTS" | "SERVICE" | "SERVICE_OFF" | "INVENTORY" | "LEADS" | "ORDERS";

export type ActivityPickerCopy = {
  stepOf: (n: number) => string;
  categoryTitle: string;
  categoryLead: string;
  subTitle: string;
  next: string;
  skip: string;
  packsTitle: string;
  packsLeadSuggested: string;
  packsLead: string;
  primaryBadge: string;
  makePrimary: string;
  footNote: string;
  start: string;
  save: string;
  saved: string;
  saving: string;
  failed: string;
  loadFailed: string;
  retry: string;
  notAvailable: string;
  settingsTitle: string;
  settingsSubtitle: string;
  pack: Record<ActivityPackCopyKey, { name: string; desc: string }>;
};

const HE: ActivityPickerCopy = {
  stepOf: (n) => `שלב ${n} מתוך 2`,
  categoryTitle: "מה העסק שלך עושה?",
  categoryLead: "כך נסדר את מסך הבית והכלים לפי העבודה שלך. אפשר לשנות בכל רגע.",
  subTitle: "ובאופן מדויק יותר?",
  next: "המשך",
  skip: "דילוג, אבחר אחר כך",
  packsTitle: "במה נתחיל?",
  packsLeadSuggested: "סימנו את מה שמתאים לעסק שלך. אפשר לבחור כמה תחומים, בלי תוספת תשלום.",
  packsLead: "אפשר לבחור כמה תחומים, בלי תוספת תשלום.",
  primaryBadge: "עיקרי",
  makePrimary: "להגדיר כעיקרי",
  footNote: "התחום העיקרי קובע את הכפתור בסרגל. אפשר לשנות בהגדרות.",
  start: "מתחילים",
  save: "שמירה",
  saved: "נשמר. מסך הבית מותאם לבחירה.",
  saving: "שומר…",
  failed: "לא הצלחנו לשמור. אפשר לנסות שוב.",
  loadFailed: "לא הצלחנו לטעון את הבחירה. אפשר לנסות שוב.",
  retry: "נסו שוב",
  notAvailable: "המסך הזה עדיין לא זמין בעסק שלך.",
  settingsTitle: "תחומי הפעילות",
  settingsSubtitle: "התחום העיקרי קובע את הכפתור בסרגל ואת מה שמוצג ראשון. שום כלי לא נחסם ושום נתון לא נמחק.",
  pack: {
    APPOINTMENTS: { name: "תורים", desc: "יומן, שירותים ועובדים. היומן יופיע בסרגל התחתון." },
    SERVICE: { name: "תיקונים ושירות", desc: "קריאות שירות, הצעות ומסירה. קריאות יופיע בסרגל התחתון." },
    SERVICE_OFF: { name: "תיקונים ושירות", desc: "קריאות שירות ייפתחו כשהכלי יופעל לעסק. עד אז: לקוחות, מלאי ויומן." },
    INVENTORY: { name: "מלאי ומכירה", desc: "מוצרים, ספקים והזמנות רכש." },
    LEADS: { name: "לידים ומכירות", desc: "פניות, לקוחות והצעות מחיר." },
    ORDERS: { name: "הזמנות ופרויקטים", desc: "פניות, הצעות מחיר, מקדמות ותאריכים ביומן." },
  },
};

const EN: ActivityPickerCopy = {
  stepOf: (n) => `Step ${n} of 2`,
  categoryTitle: "What does your business do?",
  categoryLead: "We'll arrange the Home and the tools around your work. You can change it any time.",
  subTitle: "More precisely?",
  next: "Continue",
  skip: "Skip, I'll choose later",
  packsTitle: "Where do we start?",
  packsLeadSuggested: "We ticked what fits your business. You can pick several areas at no extra cost.",
  packsLead: "You can pick several areas at no extra cost.",
  primaryBadge: "Main",
  makePrimary: "Make main",
  footNote: "The main area sets the button in the bar. You can change it in Settings.",
  start: "Let's start",
  save: "Save",
  saved: "Saved. The Home follows your choice.",
  saving: "Saving…",
  failed: "We couldn't save. Please try again.",
  loadFailed: "We couldn't load your choice. Please try again.",
  retry: "Try again",
  notAvailable: "This screen isn't available for your business yet.",
  settingsTitle: "Activity areas",
  settingsSubtitle: "The main area sets the button in the bar and what comes first. No tool is blocked and no data is deleted.",
  pack: {
    APPOINTMENTS: { name: "Appointments", desc: "Calendar, services and staff. The calendar goes in the bottom bar." },
    SERVICE: { name: "Repairs and service", desc: "Service cases, quotes and handover. Cases go in the bottom bar." },
    SERVICE_OFF: { name: "Repairs and service", desc: "Service cases open once the tool is turned on for your business. Until then: customers, stock and the calendar." },
    INVENTORY: { name: "Stock and sales", desc: "Products, suppliers and purchase orders." },
    LEADS: { name: "Leads and sales", desc: "Enquiries, customers and quotes." },
    ORDERS: { name: "Orders and projects", desc: "Enquiries, quotes, deposits and dates in the calendar." },
  },
};

export function activityPickerCopy(locale: Locale): ActivityPickerCopy {
  return locale === "en" ? EN : HE;
}
