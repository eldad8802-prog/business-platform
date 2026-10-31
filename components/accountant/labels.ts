/**
 * Hebrew wording of the accountant-pack screen. D5: every delivery state says exactly what Dubiz knows —
 * "accepted by the email provider" is not "delivered", and a download is never "read".
 */

import type { DeliveryView, PeriodView } from "@/lib/accountant/view.service";

export const ERROR_HE: Record<string, string> = {
  PACKAGE_OUTDATED: "הנתונים של החודש השתנו מאז שהחבילה הוכנה. הכנו אותה מחדש — עברו עליה שוב לפני השליחה.",
  RECIPIENT_CHANGED: "פרטי רואה החשבון השתנו. בדקו את הכתובת ואשרו שוב.",
  RECIPIENT_MISSING: "צריך להגדיר את רואה החשבון לפני השליחה.",
  INCOMPLETE_NOT_ACKNOWLEDGED: "החבילה אינה שלמה — כדי לשלוח צריך לאשר זאת במפורש.",
  SEND_IN_PROGRESS: "שליחה של החודש הזה כבר בדרך.",
  DELIVERY_DISABLED: "השליחה מתוך Dubiz עדיין לא הופעלה.",
  EMAIL_NOT_CONFIGURED: "שירות המייל אינו זמין כרגע. אפשר להוריד את החבילה ולשלוח בעצמכם.",
  RECIPIENT_CHANGED_ELSEWHERE: "פרטי רואה החשבון עודכנו במקום אחר. רעננו את המסך.",
  INVALID_EMAIL: "כתובת המייל אינה תקינה.",
  INVALID_NAME: "צריך למלא שם.",
  PERIOD_NOT_CLOSED: "החודש עדיין לא הסתיים.",
  PREPARATION_IN_PROGRESS: "החבילה בהכנה כרגע. נסו שוב בעוד רגע.",
  NOT_CANCELABLE: "השליחה כבר התחילה ואי אפשר לבטל אותה.",
  rate_limited: "יותר מדי ניסיונות. נסו שוב מאוחר יותר.",
  PACKAGE_INTEGRITY: "הקובץ השמור של החבילה אינו תואם לחבילה שנחתמה, ולכן לא הורד דבר. בדקו שוב והכינו מחדש.",
  REPORT_NOT_IN_PACKAGE: "בחבילה הזו אין דוח Excel. אפשר להוריד את החבילה המלאה (ZIP).",
  INVALID_FORMAT: "סוג ההורדה אינו מוכר.",
  PDF_RENDER_FAILED: "לא הצלחנו להפיק את דוח ה־PDF כרגע. אפשר להוריד את דוח ה־Excel או את החבילה המלאה.",
};

export function errorHe(code: string): string {
  return ERROR_HE[code] ?? "משהו השתבש. נסו שוב.";
}

type Blocker = NonNullable<PeriodView["readiness"]>["blockers"][number];
type Warning = NonNullable<PeriodView["readiness"]>["warnings"][number];

export function blockerHe(b: Blocker): string {
  if (b.kind === "DOCUMENTS_PENDING_REVIEW") return `${b.count} מסמכים עדיין ממתינים לבדיקה ולא נכנסו לדוח`;
  if (b.kind === "ISSUED_PDF_UNAVAILABLE") return `${b.count} מסמכים שהופקו — הקובץ הסופי שלהם עדיין אינו זמין`;
  if (b.kind === "ORIGINAL_FILE_MISMATCH") return `${b.count} קבצי מקור אינם תואמים לקובץ שנקלט — לא צורפו`;
  return `${b.count} קבצי מקור לא נמצאו באחסון`;
}

export function blockerHref(b: Blocker, periodKey: string): { href: string; label: string } | null {
  if (b.kind === "DOCUMENTS_PENDING_REVIEW") return { href: `/documents/inbox?month=${periodKey}`, label: "לבדיקת המסמכים" };
  if (b.kind === "ISSUED_PDF_UNAVAILABLE") return { href: "/billing", label: "לחשבוניות" };
  return null;
}

export function warningHe(w: Warning): string {
  if (w.kind === "DATE_FROM_UPLOAD_TIME") return `${w.count} רשומות שהתאריך שלהן נלקח ממועד ההעלאה — כדאי לוודא`;
  if (w.kind === "ORIGINAL_NOT_VERIFIED") return `${w.count} קבצי מקור צורפו בלי אפשרות לאמת אותם (נקלטו לפני שנשמרה חתימת קובץ) — מסומנים בדוח`;
  return `${w.count} הכנסות סרוקות שייתכן שהן כפולות למסמך שהופק בדוביז — מסומנות בדוח`;
}

export function deliveryStatusHe(d: DeliveryView): string {
  switch (d.status) {
    case "APPROVED":
      if (d.retryAfterNoAnswer) return "ספק המייל לא ענה — ננסה שוב (בלי לשלוח פעמיים)";
      return d.failureCode ? "ממתין לניסיון שליחה נוסף" : "אושר — ממתין לשליחה";
    case "SENDING":
      return "בשליחה";
    case "ACCEPTED":
      return "התקבל אצל ספק המייל";
    case "DELIVERED":
      return "נמסר לתיבת הדואר (לפי ספק המייל)";
    case "FAILED":
      return d.outcomeUncertain ? "לא ודאי שנשלח — ספק המייל לא ענה" : "השליחה נכשלה";
    case "BOUNCED":
      return "המייל חזר — לא נמסר";
    case "CANCELED":
      return d.failureCode === "recipient_changed" ? "בוטל — פרטי רואה החשבון השתנו" : "בוטל";
  }
}

export function deliveryTone(d: DeliveryView): "success" | "attention" | "urgent" | "info" {
  if (d.outcomeUncertain) return "attention";
  if (d.status === "DELIVERED" || d.status === "ACCEPTED") return "success";
  if (d.status === "FAILED" || d.status === "BOUNCED") return "urgent";
  if (d.status === "CANCELED") return "info";
  return "attention";
}

/**
 * What the accountant did with the link — said exactly: an opened portal is "opened", a file is
 * "downloaded / viewed", never "read" or "checked".
 */
export function deliveryAccessHe(d: DeliveryView): string[] {
  const out: string[] = [];
  if (d.portal.views > 0) {
    out.push(`רואה החשבון פתח את החבילה ${d.portal.views === 1 ? "פעם אחת" : `${d.portal.views} פעמים`} (לאחרונה ${formatDateTimeHe(d.portal.lastViewedAt)})`);
  } else if (d.linkState === "live") {
    out.push("רואה החשבון עוד לא פתח את החבילה");
  }
  if (d.portal.fileDownloads > 0) {
    out.push(`נפתחו או הורדו ${d.portal.fileDownloads === 1 ? "קובץ אחד" : `${d.portal.fileDownloads} קבצים`} (לאחרונה ${formatDateTimeHe(d.portal.lastFileDownloadAt)})`);
  }
  if (d.downloadCount > 0) {
    out.push(`החבילה המלאה (ZIP) הורדה ${d.downloadCount === 1 ? "פעם אחת" : `${d.downloadCount} פעמים`}`);
  }
  if (d.linkState === "live") out.push(`הקישור בתוקף עד ${formatDateHe(d.linkExpiresAt)}`);
  if (d.linkState === "expired") out.push(`תוקף הקישור הסתיים ב־${formatDateHe(d.linkExpiresAt)}`);
  if (d.linkState === "revoked") out.push("הקישור בוטל");
  return out;
}

/** The recipient marked the email as spam (Resend `email.complained`): what it means for the owner, said plainly. */
export function complaintHe(d: DeliveryView): string | null {
  if (!d.complainedAt) return null;
  return `רואה החשבון סימן את המייל הזה כספאם (${formatDateTimeHe(d.complainedAt)}). הקובץ נשלח, אבל ייתכן שמיילים מ־Dubiz יגיעו אצלו לתיקיית הספאם — כדאי לוודא איתו שהקובץ התקבל ולבקש שיסמן את הכתובת כבטוחה.`;
}

export function formatDateTimeHe(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function formatDateHe(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("he-IL", { timeZone: "Asia/Jerusalem" });
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}
