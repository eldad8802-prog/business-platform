/**
 * WP3 — pure report data models for the 3 registration outputs (spec 1.31
 * §2.6, §5.4/appendix-4, and an internal summary that mirrors the simulator
 * report). ALL numbers/counts/sums/names come from the already-produced
 * `UniformExportProjection` + WP2 `meta` + config — no re-derivation, no dup.
 * Fully deterministic (no Date.now / random).
 */

import type { UniformExportProjection } from "@/lib/services/billing/uniform/uniform-export.types";
import type { UniformBuildResult } from "@/lib/services/billing/uniform/uniform-file-builder";
import { documentTypeToCode } from "@/lib/services/billing/uniform/uniform-file-builder";
import type { UniformSoftwareConfig } from "@/lib/services/billing/uniform/uniform-config";
import { formatMoneyDisplay, sumDecimal2 } from "@/lib/services/billing/uniform/uniform-decimal";

/** Appendix-1 document types (§5.1) — full list, in spec order. */
export const APPENDIX_1_DOCUMENT_TYPES: ReadonlyArray<{ code: string; name: string }> = [
  { code: "100", name: "הזמנה" },
  { code: "200", name: "תעודת משלוח" },
  { code: "205", name: "תעודת משלוח סוכן" },
  { code: "210", name: "תעודת החזרה" },
  { code: "300", name: "חשבונית/חשבונית עסקה" },
  { code: "305", name: "חשבונית מס" },
  { code: "310", name: "חשבונית ריכוז" },
  { code: "320", name: "חשבונית מס / קבלה" },
  { code: "330", name: "חשבונית מס זיכוי" },
  { code: "340", name: "חשבונית שריון" },
  { code: "345", name: "חשבונית סוכן" },
  { code: "400", name: "קבלה" },
  { code: "405", name: "קבלה על תרומות" },
  { code: "410", name: "יציאה מקופה" },
  { code: "420", name: "הפקדת בנק" },
  { code: "500", name: "הזמנת רכש" },
  { code: "600", name: "תעודת משלוח רכש" },
  { code: "610", name: "החזרת רכש" },
  { code: "700", name: "חשבונית מס רכש" },
  { code: "710", name: "זיכוי רכש" },
  { code: "800", name: "יתרת פתיחה" },
  { code: "810", name: "כניסה כללית למלאי" },
  { code: "820", name: "יציאה כללית מהמלאי" },
  { code: "830", name: "העברה בין מחסנים" },
  { code: "840", name: "עדכון בעקבות ספירה" },
  { code: "900", name: "דוח ייצור-כניסה" },
  { code: "910", name: "דוח ייצור-יציאה" },
];

/** BKMVDATA record-type labels (§2.5.ה). */
export const RECORD_TYPE_LABELS: Record<string, string> = {
  A100: "רשומת פתיחה",
  B100: "תנועות בהנהלת חשבונות",
  B110: "חשבון בהנהלת חשבונות",
  C100: "כותרת מסמך",
  D110: "פרטי מסמך",
  D120: "פרטי קבלות",
  M100: "פריטים במלאי",
  Z900: "רשומת סיום",
};

// ---- date/time display (deterministic) ----
export function formatDateDisplay(iso: string | null | undefined): string {
  const m = String(iso ?? "").match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}
export function formatTimeDisplay(iso: string | null | undefined): string {
  const m = String(iso ?? "").match(/[T ](\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : "";
}

function businessDisplayName(proj: UniformExportProjection): string {
  return (proj.business.billingLegalName ?? proj.business.name ?? "").trim();
}

// ---- §2.6 data ----

export type Report26Row = { code: string; name: string; count: number; sumInclVat: string };
export type Report26Data = {
  businessName: string;
  vatNumber: string;
  periodStart: string;
  periodEnd: string;
  rows: Report26Row[];
  totalCount: number;
  totalSum: string;
};

/**
 * §2.6: per document-type count + Σ (field 1223 = total incl VAT). Lists ALL
 * appendix-1 types (0 where absent). Counts/sums derived from the projection's
 * document records — same source WP2 used to build C100.
 */
export function buildReport26Data(proj: UniformExportProjection, meta: UniformBuildResult["meta"]): Report26Data {
  const byCode = new Map<string, { count: number; totals: string[] }>();
  for (const t of APPENDIX_1_DOCUMENT_TYPES) byCode.set(t.code, { count: 0, totals: [] });

  for (const doc of proj.documentRecords) {
    const code = documentTypeToCode(doc.documentType);
    const bucket = byCode.get(code);
    if (!bucket) continue;
    bucket.count += 1;
    bucket.totals.push(doc.total);
  }

  const rows: Report26Row[] = APPENDIX_1_DOCUMENT_TYPES.map((t) => {
    const b = byCode.get(t.code)!;
    return { code: t.code, name: t.name, count: b.count, sumInclVat: sumDecimal2(b.totals) };
  });

  return {
    businessName: businessDisplayName(proj),
    vatNumber: meta.vatNumber,
    periodStart: formatDateDisplay(proj.period.start),
    periodEnd: formatDateDisplay(proj.period.end),
    rows,
    totalCount: proj.documentRecords.length,
    totalSum: sumDecimal2(proj.documentRecords.map((d) => d.total)),
  };
}

/** Money display for a §2.6 sum (thin re-export for the docDefinition layer). */
export function displayMoney(value: string): string {
  return formatMoneyDisplay(value);
}

// ---- §5.4 / appendix-4 data ----

export type RecordTypeRow = { code: string; name: string; count: number };
export type Report54Data = {
  vatNumber: string;
  businessName: string;
  constMessage: string;
  dirPath: string;
  periodStart: string;
  periodEnd: string;
  recordRows: RecordTypeRow[];
  softwareName: string;
  softwareRegistrationNumber: string;
  generatedDate: string;
  generatedTime: string;
};

/** BKMVDATA record-type rows, only types that exist (§5.4: row only if present). */
function bkmvRecordRows(meta: UniformBuildResult["meta"]): RecordTypeRow[] {
  const rows: RecordTypeRow[] = [];
  const push = (code: string, count: number) => {
    if (count > 0) rows.push({ code, name: RECORD_TYPE_LABELS[code], count });
  };
  push("A100", 1);
  push("C100", meta.counts.C100);
  push("D110", meta.counts.D110);
  push("D120", meta.counts.D120);
  push("Z900", 1);
  return rows;
}

export function buildReport54Data(
  proj: UniformExportProjection,
  meta: UniformBuildResult["meta"],
  config: UniformSoftwareConfig
): Report54Data {
  return {
    vatNumber: meta.vatNumber,
    businessName: businessDisplayName(proj),
    constMessage: "ביצוע ממשק פתוח הסתיים בהצלחה.",
    dirPath: meta.dirPath,
    periodStart: formatDateDisplay(proj.period.start),
    periodEnd: formatDateDisplay(proj.period.end),
    recordRows: bkmvRecordRows(meta),
    softwareName: config.softwareName,
    softwareRegistrationNumber: config.softwareRegistrationNumber,
    generatedDate: formatDateDisplay(meta.generatedAt),
    generatedTime: formatTimeDisplay(meta.generatedAt),
  };
}

// ---- internal summary (basis for the post-run simulator report) ----

export type SummaryData = {
  title: string;
  vendorName: string;
  vendorVatNumber: string;
  softwareName: string;
  softwareVersion: string;
  softwareRegistrationNumber: string;
  generatedDate: string;
  generatedTime: string;
  totalRecords: number;
  recordRows: RecordTypeRow[];
  note: string;
};

export function buildSummaryData(
  proj: UniformExportProjection,
  meta: UniformBuildResult["meta"],
  config: UniformSoftwareConfig
): SummaryData {
  return {
    title: "דוח מסכם פנימי — הפקת קבצים במבנה אחיד 1.31",
    vendorName: config.vendorName,
    vendorVatNumber: config.vendorVatNumber,
    softwareName: config.softwareName,
    softwareVersion: config.softwareVersion,
    softwareRegistrationNumber: config.softwareRegistrationNumber,
    generatedDate: formatDateDisplay(meta.generatedAt),
    generatedTime: formatTimeDisplay(meta.generatedAt),
    totalRecords: meta.totalBkmvRecords,
    recordRows: bkmvRecordRows(meta),
    note: "דוח פנימי טרם-סימולטור. תקינות רשמית נקבעת רק ע\"י הסימולטור של רשות המסים.",
  };
}
