/**
 * WP2.5/2.6/2.7 — Mapping (projection → field values), file builders
 * (INI.TXT + BKMVDATA.TXT), and OPENFRMT path (spec 1.31).
 *
 * Scope (BD-1): invoice-issuance software → produces A000, INI summaries, A100,
 * C100, D110, D120, Z900. No B100/B110/M100. Config (software identity) comes
 * from `UniformSoftwareConfig` — never hardcoded here.
 */

import { randomInt } from "node:crypto";
import type {
  UniformCustomer,
  UniformDocumentRecord,
  UniformExportProjection,
  UniformLineRecord,
  UniformPaymentRecord,
} from "@/lib/services/billing/uniform/uniform-export.types";
import type { UniformSoftwareConfig } from "@/lib/services/billing/uniform/uniform-config";
import { encodeIso8859_8i } from "@/lib/services/billing/uniform/uniform-encoding";
import {
  A000_LAYOUT,
  A100_LAYOUT,
  B110_LAYOUT,
  C100_LAYOUT,
  D110_LAYOUT,
  D120_LAYOUT,
  INI_SUMMARY_LAYOUT,
  Z900_LAYOUT,
} from "@/lib/services/billing/uniform/uniform-layout-1_31";
import {
  serializeRecordLine,
  type FieldValues,
} from "@/lib/services/billing/uniform/uniform-serializer";

// ---- code mappings (spec appendix 1 + §4.5); deterministic, not invented ----

/** Dubiz BillingDocumentType → appendix-1 document code. QUOTE excluded (no code). */
const DOCUMENT_TYPE_CODE: Record<string, string> = {
  TAX_INVOICE: "305", // חשבונית מס
  TAX_INVOICE_RECEIPT: "320", // חשבונית מס / קבלה
  RECEIPT: "400", // קבלה
  CREDIT_NOTE: "330", // חשבונית מס זיכוי
};

/** Dubiz PaymentMethod → D120.1306 code (§4.5 field 1306). */
const PAYMENT_METHOD_CODE: Record<string, string> = {
  CASH: "1",
  CHECK: "2",
  CREDIT_CARD: "3",
  BANK_TRANSFER: "4",
  BIT: "9", // no dedicated code → אחר
  PAYBOX: "9",
  OTHER: "9",
};

export function documentTypeToCode(documentType: string): string {
  const code = DOCUMENT_TYPE_CODE[documentType];
  if (!code) {
    throw new Error(`No מבנה-אחיד document code for type "${documentType}" (spec appendix 1)`);
  }
  return code;
}

function paymentMethodToCode(method: string): string {
  return PAYMENT_METHOD_CODE[method] ?? "9";
}

// ---- helpers ----

function digitsOnly(v: string | null | undefined): string {
  return String(v ?? "").replace(/\D/g, "");
}
/** עוסק מורשה field = 9 digits. */
function vat9(v: string | null | undefined): string {
  return digitsOnly(v).slice(0, 9);
}
/** Path uses the first 8 digits (number without check digit). */
function vat8ForPath(v: string | null | undefined): string {
  return digitsOnly(v).slice(0, 8).padStart(8, "0");
}
function docNumber(rec: { documentNumberFormatted: string | null; documentNumber: number | null }): string {
  return (rec.documentNumberFormatted ?? "").trim() || String(rec.documentNumber ?? "");
}

export type BuildOptions = {
  /** 15-digit primary id (§2.4.א). Injected for deterministic tests. */
  primaryId?: string;
  /** ISO timestamp of production (fields 1026/1027 + path). Injected for tests. */
  generatedAt?: string;
};

/** Random 15-digit primary id (unique per production run, §2.4.א). */
export function generatePrimaryId(): string {
  let s = "";
  for (let i = 0; i < 15; i++) s += String(randomInt(0, 10));
  return s;
}

// ---- record value maps ----

function a000Values(args: {
  proj: UniformExportProjection;
  config: UniformSoftwareConfig;
  primaryId: string;
  generatedAt: string;
  totalBkmvRecords: number;
  dirPath: string;
}): FieldValues {
  const b = args.proj.business;
  const isLtd = b.billingBusinessKind === "LTD_COMPANY";
  return {
    1001: "",
    1002: String(args.totalBkmvRecords),
    1003: vat9(b.billingTaxId),
    1004: args.primaryId,
    1006: digitsOnly(args.config.softwareRegistrationNumber),
    1007: args.config.softwareName,
    1008: args.config.softwareVersion,
    1009: vat9(args.config.vendorVatNumber),
    1010: args.config.vendorName,
    1011: String(args.config.softwareType),
    1012: args.dirPath,
    1013: String(args.config.accountingType),
    1014: "0",
    1015: isLtd ? vat9(b.billingTaxId) : "",
    1016: "",
    1017: "",
    1018: (b.billingLegalName ?? b.name ?? "").trim(),
    1019: b.billingAddress ?? "",
    1020: "",
    1021: "",
    1022: "",
    1023: "", // multi-year → tax year not used (zeros)
    1024: args.proj.period.start,
    1025: args.proj.period.end,
    1026: args.generatedAt,
    1027: args.generatedAt,
    1028: String(args.config.languageCode),
    1029: String(args.config.charset),
    1030: args.config.compressionSoftwareName,
    1032: args.config.leadingCurrency,
    1034: "0", // single business, no branches
    1035: "",
  };
}

function c100Values(rec: UniformDocumentRecord, business: { billingTaxId: string | null }, recordNumber: number): FieldValues {
  const cust = rec.customer;
  return {
    1201: String(recordNumber),
    1202: vat9(business.billingTaxId),
    1203: documentTypeToCode(rec.documentType),
    1204: docNumber(rec),
    1205: rec.issuedAt,
    1206: rec.issuedAt,
    1207: cust?.name ?? "",
    1208: "",
    1209: "",
    1210: cust?.city ?? "",
    1211: "",
    1212: "",
    1213: "",
    1214: cust?.phone ?? "",
    1215: vat9(cust?.taxId),
    1216: rec.issuedAt,
    1217: "0",
    1218: "",
    1219: rec.subtotal,
    1220: "0", // no document-level discount
    1221: rec.subtotal,
    1222: rec.vat,
    1223: rec.total,
    1224: "0", // no withholding
    1225: cust?.id != null ? String(cust.id) : "",
    1226: "",
    1228: "", // not cancelled
    1230: rec.issuedAt,
    1231: "",
    1233: "",
    1234: String(rec.documentId),
    1235: "",
  };
}

function d110Values(line: UniformLineRecord, docType: string, docNum: string, docDateIso: string | null, business: { billingTaxId: string | null }, recordNumber: number): FieldValues {
  return {
    1251: String(recordNumber),
    1252: vat9(business.billingTaxId),
    1253: documentTypeToCode(docType),
    1254: docNum,
    1255: String(line.lineIndex + 1),
    1256: "",
    1257: "",
    1258: "0",
    1259: "",
    1260: line.description,
    1261: "",
    1262: "",
    1263: "יחידה",
    1264: line.quantity,
    1265: line.unitPrice,
    1266: "0", // no line discount
    1267: line.lineSubtotal, // §4.5: line amount BEFORE VAT (qty*unitPrice - discount); reconciles to C100.1219 — NOT incl VAT
    1268: line.vatRatePercent,
    1270: "",
    1272: docDateIso,
    1273: String(line.documentId),
    1274: "",
    1275: "",
  };
}

function d120Values(pay: UniformPaymentRecord, docType: string, docNum: string, docDateIso: string | null, business: { billingTaxId: string | null }, recordNumber: number): FieldValues {
  const isCheck = pay.method === "CHECK";
  const isCard = pay.method === "CREDIT_CARD";
  return {
    1301: String(recordNumber),
    1302: vat9(business.billingTaxId),
    1303: documentTypeToCode(docType),
    1304: docNum,
    1305: String(pay.lineIndex + 1),
    1306: paymentMethodToCode(pay.method),
    1307: isCheck ? digitsOnly(pay.bankName) : "",
    1308: isCheck ? digitsOnly(pay.bankBranch) : "",
    1309: isCheck ? digitsOnly(pay.bankAccountNumber) : "",
    1310: isCheck ? digitsOnly(pay.checkNumber) : "",
    1311: pay.checkDueDate,
    1312: pay.amount,
    1313: "0",
    1314: pay.cardBrand ?? "",
    1315: isCard ? "1" : "0",
    1320: "",
    1322: pay.paymentDate ?? docDateIso,
    1323: String(pay.documentId),
    1324: "",
  };
}

/**
 * B110 — account card for a customer (§ B110, len 376). BD-1 scope: a MINIMUM
 * account, not double-entry bookkeeping — all balances (1414/1415/1416/1422) = 0.
 * 1403 (account key) mirrors C100.1225 so the simulator can reconcile them.
 */
function b110Values(cust: UniformCustomer, business: { billingTaxId: string | null }, recordNumber: number): FieldValues {
  const ZERO = "0"; // AMOUNT kind → "+00000000000000"
  return {
    1401: String(recordNumber),
    1402: vat9(business.billingTaxId),
    1403: cust.id != null ? String(cust.id) : "", // == C100.1225
    1404: cust.name ?? "",
    1405: "CUSTOMERS", // stable trial-balance code
    1406: "לקוחות",
    1407: "", // street (ח/ר)
    1408: "", // house no (ח/ר)
    1409: cust.city ?? "", // city (ח/ר)
    1410: "", // zip (ח/ר)
    1411: "", // country (ח/ר)
    1412: "", // country code (ח/ר)
    1413: "", // central account (ח/ר)
    1414: ZERO, // opening balance
    1415: ZERO, // total debit
    1416: ZERO, // total credit
    1417: "", // accounting-classification code (ח/ר) → zero-filled
    1419: vat9(cust.taxId), // customer VAT/ID when present, else zeros
    1421: "", // branch id — conditional on 1034=1 (not set)
    1422: ZERO, // opening balance (foreign currency)
    1423: "", // foreign-currency code (ח/ר)
    1424: "", // future-data area → spaces
  };
}

// ---- builders ----

export type UniformBuildResult = {
  iniText: string;
  iniBuffer: Buffer;
  bkmvdataText: string;
  bkmvdataBuffer: Buffer;
  meta: {
    primaryId: string;
    generatedAt: string;
    totalBkmvRecords: number;
    counts: { B110: number; C100: number; D110: number; D120: number };
    dirPath: string;
    vatNumber: string;
  };
};

/** OPENFRMT-relative path: OPENFRMT/<8-digit עוסק>.<YY>/<MMDDhhmm> (§2.2). */
export function computeOpenfrmtPath(vatNumber: string | null, generatedAtIso: string): string {
  const vat8 = vat8ForPath(vatNumber);
  const d = new Date(generatedAtIso);
  const yy = String(d.getUTCFullYear()).slice(-2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `OPENFRMT/${vat8}.${yy}/${mm}${dd}${hh}${mi}`;
}

export function buildUniformExportFiles(
  proj: UniformExportProjection,
  config: UniformSoftwareConfig,
  opts: BuildOptions = {}
): UniformBuildResult {
  const primaryId = opts.primaryId ?? generatePrimaryId();
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const business = proj.business;
  const dirPath = computeOpenfrmtPath(business.billingTaxId, generatedAt);

  // group lines/payments by document (deterministic — projection already sorted)
  const linesByDoc = new Map<number, UniformLineRecord[]>();
  for (const l of proj.lineRecords) {
    const arr = linesByDoc.get(l.documentId) ?? [];
    arr.push(l);
    linesByDoc.set(l.documentId, arr);
  }
  const paymentsByDoc = new Map<number, UniformPaymentRecord[]>();
  for (const p of proj.paymentRecords) {
    const arr = paymentsByDoc.get(p.documentId) ?? [];
    arr.push(p);
    paymentsByDoc.set(p.documentId, arr);
  }

  // ---- BKMVDATA.TXT ----
  let recNo = 0;
  let bkmv = "";
  recNo += 1; // A100 = record #1
  bkmv += serializeRecordLine(A100_LAYOUT, {
    1101: String(recNo),
    1102: vat9(business.billingTaxId),
    1103: primaryId,
    1105: "",
  });

  // B110 account cards — one per unique customer on a document, placed AFTER
  // A100 and BEFORE C100 (required record ordering). Deduped by account key
  // (== C100.1225). BD-1 minimum: basic accounts only, no double-entry.
  const b110Customers: UniformCustomer[] = [];
  const seenAccountKeys = new Set<string>();
  for (const doc of proj.documentRecords) {
    const cust = doc.customer;
    if (!cust || cust.id == null) continue;
    const key = String(cust.id);
    if (seenAccountKeys.has(key)) continue;
    seenAccountKeys.add(key);
    b110Customers.push(cust);
  }
  for (const cust of b110Customers) {
    recNo += 1;
    bkmv += serializeRecordLine(B110_LAYOUT, b110Values(cust, business, recNo));
  }

  for (const doc of proj.documentRecords) {
    recNo += 1;
    bkmv += serializeRecordLine(C100_LAYOUT, c100Values(doc, business, recNo));
    const dNum = docNumber(doc);
    for (const line of linesByDoc.get(doc.documentId) ?? []) {
      recNo += 1;
      bkmv += serializeRecordLine(
        D110_LAYOUT,
        d110Values(line, doc.documentType, dNum, doc.issuedAt, business, recNo)
      );
    }
    for (const pay of paymentsByDoc.get(doc.documentId) ?? []) {
      recNo += 1;
      bkmv += serializeRecordLine(
        D120_LAYOUT,
        d120Values(pay, doc.documentType, dNum, doc.issuedAt, business, recNo)
      );
    }
  }

  recNo += 1; // Z900
  const totalBkmvRecords = recNo;
  bkmv += serializeRecordLine(Z900_LAYOUT, {
    1151: String(recNo),
    1152: vat9(business.billingTaxId),
    1153: primaryId,
    1155: String(totalBkmvRecords),
    1156: "",
  });

  // ---- INI.TXT ----
  const counts = {
    B110: b110Customers.length,
    C100: proj.documentRecords.length,
    D110: proj.lineRecords.length,
    D120: proj.paymentRecords.length,
  };
  let ini = serializeRecordLine(
    A000_LAYOUT,
    a000Values({ proj, config, primaryId, generatedAt, totalBkmvRecords, dirPath })
  );
  // one summary record per data record-type that exists (§2.5.ה order)
  for (const [code, count] of [
    ["B110", counts.B110],
    ["C100", counts.C100],
    ["D110", counts.D110],
    ["D120", counts.D120],
  ] as const) {
    if (count > 0) {
      ini += serializeRecordLine(INI_SUMMARY_LAYOUT, { 1050: code, 1051: String(count) });
    }
  }

  return {
    iniText: ini,
    iniBuffer: encodeIso8859_8i(ini),
    bkmvdataText: bkmv,
    bkmvdataBuffer: encodeIso8859_8i(bkmv),
    meta: {
      primaryId,
      generatedAt,
      totalBkmvRecords,
      counts,
      dirPath,
      vatNumber: vat9(business.billingTaxId),
    },
  };
}
