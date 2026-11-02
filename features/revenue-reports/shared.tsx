/**
 * Revenue report uploads — what the two screens share: Hebrew labels, money / date formatting and the scoped styles
 * (Mist tokens + the money family tone, like /money/uploads). Hebrew only (owner rule for new screens).
 */
import type { ReportKind } from "@/lib/revenue-report-uploads/client";

export const KIND_TEXT: Record<ReportKind, { name: string; plural: string; upload: string; what: string }> = {
  z: {
    name: "דוח Z",
    plural: "דוחות Z",
    upload: "העלאת דוח Z מהקופה",
    what: "סגירת קופה יומית: מכירות, החזרים, ביטולים, מע״מ ואמצעי תשלום של יום אחד בקופה אחת.",
  },
  settlement: {
    name: "דוח סליקה",
    plural: "דוחות סליקה",
    upload: "העלאת דוח סליקה",
    what: "מה שחברת האשראי זיכתה: ברוטו, עמלות, ניכויים ונטו, לפי תאריך ערך.",
  },
};

export const ROUTES = {
  list: "/money/revenue-reports",
  upload: (kind: ReportKind) => `/money/revenue-reports/${kind}/upload`,
  uploads: "/money/uploads",
};

/** Why a row was not read (core.ts codes). */
export const ROW_CODE_TEXT: Record<string, string> = {
  BUSINESS_DAY_INVALID: "תאריך היום לא תקין",
  REGISTER_KEY_INVALID: "מזהה הקופה לא תקין",
  CURRENCY_INVALID: "מטבע לא נתמך",
  AMOUNT_INVALID: "סכום לא תקין",
  AMOUNT_TOO_LARGE: "סכום גדול מדי",
  TOTAL_MISMATCH: "הסה״כ לא שווה למכירות פחות הנחות, החזרים וביטולים",
  Z_NUMBER_INVALID: "מספר ה-Z לא תקין",
  TRANSACTION_COUNT_INVALID: "מספר העסקאות לא תקין",
  PERIOD_INVALID: "שעות הפתיחה והסגירה לא תקינות",
  LINES_INVALID: "שורות הפירוט לא תקינות",
  TENDER_INVALID: "שורת אמצעי תשלום לא תקינה",
  TENDER_DUPLICATE: "אמצעי תשלום מופיע פעמיים",
  VAT_LINE_INVALID: "שורת מע״מ לא תקינה",
  VAT_LINE_DUPLICATE: "שיעור מע״מ מופיע פעמיים",
  ACQUIRER_INVALID: "חברת הסליקה לא זוהתה",
  VALUE_DATE_INVALID: "תאריך הערך לא תקין",
  EXTERNAL_ID_INVALID: "מזהה הזיכוי לא תקין",
  NET_MISMATCH: "הנטו לא שווה לברוטו פחות עמלות וניכויים",
  INSTALLMENT_INVALID: "פרטי התשלומים לא תקינים",
  CONFLICT_IN_FILE: "מופיע בקובץ פעמיים עם סכומים שונים",
  UNREADABLE_ROW: "השורה לא נקראה",
};

/** Kept on a recorded row as a warning (validationCodes). */
export const WARNING_TEXT: Record<string, string> = {
  TENDERS_TOTAL_MISMATCH: "סכום אמצעי התשלום שונה מהסה״כ",
  VAT_LINES_MISMATCH: "פירוט המע״מ שונה מסה״כ המע״מ",
  VAT_EXCEEDS_TOTAL: "המע״מ גדול מהסה״כ",
  NET_NEGATIVE: "הנטו שלילי",
};

export const TENDER_TEXT: Record<string, string> = {
  CASH: "מזומן",
  CARD: "אשראי",
  CHEQUE: "המחאות",
  BANK_TRANSFER: "העברה בנקאית",
  DIGITAL_WALLET: "ארנק דיגיטלי",
  VOUCHER: "שוברים",
  OTHER: "אחר",
};

export function money(minor: number, currency = "ILS"): string {
  try {
    return new Intl.NumberFormat("he-IL", { style: "currency", currency, minimumFractionDigits: 2 }).format(minor / 100);
  } catch {
    return (minor / 100).toFixed(2);
  }
}

/** "2026-10-01" → "1.10.2026" — a calendar day, no time zone involved. */
export function dayText(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return `${d}.${m}.${y}`;
}

/**
 * Scoped styles. The family tone comes from category-tones.ts; everything else is a Mist token, as on /money/uploads.
 * Mobile first: one column, cards instead of wide tables; wider screens only widen the column.
 */
export const REPORTS_CSS = `
.dzrr{
  min-height:100dvh;color:var(--dz-text-primary);
  font-family:var(--font-heebo),'Heebo','Assistant',system-ui,sans-serif;
  background:var(--dz-background);
  padding:calc(12px + var(--dz-safe-top,0px)) 16px 32px;
  -webkit-font-smoothing:antialiased;
}
.dzrr .rwrap{max-width:640px;margin:0 auto;display:flex;flex-direction:column;gap:18px;min-width:0}
.dzrr a{color:var(--ct-deep);font-weight:600}
.dzrr .rback{display:flex;justify-content:flex-start;margin-bottom:-6px}
.dzrr .rhead h1{margin:0;font-family:var(--font-rubik),'Rubik',sans-serif;font-size:22px;font-weight:700;line-height:1.25}
.dzrr .rhead p{margin:4px 0 0;font-size:13.5px;line-height:1.5;color:var(--dz-text-secondary)}
.dzrr .rsteps{display:flex;flex-wrap:wrap;gap:6px 14px;margin:0;padding:0;list-style:none;font-size:12.5px;color:var(--dz-text-muted)}
.dzrr .rsteps .on{color:var(--dz-text-primary);font-weight:700}
.dzrr .rlabel{margin:0 4px 8px;font-size:13px;font-weight:700;color:var(--dz-text-secondary)}
.dzrr .rcard{display:flex;flex-direction:column;gap:10px;padding:16px;border-radius:18px;min-width:0;
  background:var(--dz-surface);border:1px solid var(--dz-border);box-shadow:var(--dz-shadow-card)}
.dzrr .rnote{padding:12px 14px;border-radius:14px;font-size:13.5px;line-height:1.55;color:var(--dz-text-secondary);
  background:var(--dz-surface-muted);border:1px solid var(--dz-border)}
.dzrr .rnote strong{color:var(--dz-text-primary)}
.dzrr .rwarn{padding:12px 14px;border-radius:14px;font-size:13.5px;line-height:1.55;
  color:var(--dz-text-primary);background:var(--dz-warning-bg-soft);border:1px solid var(--dz-warning-border)}
.dzrr .rerr{padding:12px 14px;border-radius:14px;font-size:14px;font-weight:600;line-height:1.5;
  color:var(--dz-danger);background:var(--dz-danger-bg-soft);border:1px solid var(--dz-danger-border)}
.dzrr .rok{padding:12px 14px;border-radius:14px;font-size:14px;line-height:1.55;
  color:var(--dz-text-primary);background:var(--dz-success-bg-soft);border:1px solid var(--dz-success)}
.dzrr .rfile{display:block;width:100%;font:inherit;font-size:14px;padding:10px;border-radius:12px;
  border:1px dashed var(--dz-border-strong);background:var(--dz-surface)}
.dzrr .ractions{display:flex;flex-wrap:wrap;gap:10px;justify-content:flex-start}
.dzrr .rbtn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 16px;border-radius:12px;
  font:inherit;font-size:14px;font-weight:700;cursor:pointer;text-decoration:none;
  color:var(--dz-action-secondary-text);background:var(--dz-action-secondary-bg);border:1px solid var(--dz-action-secondary-border)}
.dzrr .rbtn:hover{background:var(--dz-action-secondary-hover)}
.dzrr .rbtn-primary{color:var(--dz-action-primary-text);background:var(--dz-action-primary);border-color:transparent}
.dzrr .rbtn-primary:hover{background:var(--dz-action-primary-hover)}
.dzrr .rbtn[disabled]{opacity:.55;cursor:not-allowed}
.dzrr .rbtn:focus-visible{outline:3px solid var(--ct-a);outline-offset:2px}
.dzrr .rfigs{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.dzrr .rfig{display:flex;flex-direction:column;gap:2px;padding:10px 12px;border-radius:14px;background:var(--dz-surface-muted)}
.dzrr .rfig span:first-child{font-size:12px;color:var(--dz-text-secondary)}
.dzrr .rfig span:last-child{font-size:17px;font-weight:700;font-variant-numeric:tabular-nums}
.dzrr .rlist{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.dzrr .rrow{display:flex;flex-direction:column;gap:6px;padding:14px 16px;border-radius:16px;min-width:0;
  background:var(--dz-surface);border:1px solid var(--dz-border)}
.dzrr .rrow-conflict{border-color:var(--dz-warning-border);background:var(--dz-warning-bg-soft)}
.dzrr .rrow-muted{opacity:.7}
.dzrr .rrow-top{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.dzrr .rrow-title{font-size:15px;font-weight:700}
.dzrr .rmeta{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:13px;line-height:1.5;color:var(--dz-text-secondary);font-variant-numeric:tabular-nums}
.dzrr .rmeta b{color:var(--dz-text-primary);font-weight:700}
.dzrr .rpill{flex:0 0 auto;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:700;line-height:1.5}
.dzrr .rpill-new{color:var(--dz-success);background:var(--dz-success-bg-soft)}
.dzrr .rpill-existing{color:var(--dz-text-secondary);background:var(--dz-surface-muted)}
.dzrr .rpill-conflict{color:var(--dz-warning);background:var(--dz-warning-bg-soft)}
.dzrr .rpill-info{color:var(--dz-info);background:var(--dz-info-bg-soft)}
.dzrr .rdecide{display:flex;flex-wrap:wrap;gap:8px 16px;border:0;margin:0;padding:0;font-size:14px}
.dzrr .rdecide label{display:inline-flex;align-items:center;gap:6px;min-height:36px;cursor:pointer}
.dzrr .rsr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.dzrr .rempty{margin:0;padding:18px 16px;border-radius:16px;font-size:14px;line-height:1.5;color:var(--dz-text-secondary);
  background:var(--dz-surface);border:1px dashed var(--dz-border-strong)}
.dzrr .rtabs{display:flex;gap:8px;flex-wrap:wrap}
.dzrr .rtabs button{min-height:40px;padding:0 14px;border-radius:999px;font:inherit;font-size:13.5px;font-weight:700;cursor:pointer;
  color:var(--dz-text-secondary);background:var(--dz-surface);border:1px solid var(--dz-border)}
.dzrr .rtabs button[aria-pressed="true"]{color:var(--dz-action-primary-text);background:var(--dz-action-primary);border-color:transparent}
@media (min-width:768px){
  .dzrr .rwrap{max-width:760px}
  .dzrr .rfigs{grid-template-columns:repeat(4,minmax(0,1fr))}
}
`;
