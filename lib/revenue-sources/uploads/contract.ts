/**
 * Revenue report uploads — the normalized contract. docs/revenue-report-uploads.md.
 *
 * An owner uploads a Z report (the register's daily close) or a card settlement report (what an acquirer /
 * payment provider credited, with its fees). Every source system exports these in its own format, and Dubiz
 * holds NO real sample yet — so nothing here knows any vendor. A parser (registry.ts) turns one vendor's file
 * into the drafts below; everything after that (validation, classification, the preview token, the commit) is
 * format-independent and shared.
 *
 * The drafts map 1:1 onto the revenue truth tables (migration 20261028090000_revenue_truth_foundation):
 *   ZReportDraft    → "RevenueDailyClose" + "RevenueDailyCloseTender" + "RevenueDailyCloseVat"
 *   SettlementDraft → "RevenueSettlement"
 * and core.ts checks every CHECK constraint of those tables in code, before anything reaches the database.
 *
 * Pure: types only. Money is integer minor units (bigint, agorot / cents) — never a float.
 */

export type ReportKind = "z" | "settlement";

/** Supported currencies, exactly the tables' CHECK ("currency" IN ('ILS', 'USD', 'EUR')). */
export const REPORT_CURRENCIES = ["ILS", "USD", "EUR"] as const;
export type ReportCurrency = (typeof REPORT_CURRENCIES)[number];

export const TENDER_METHODS = ["CASH", "CARD", "CHEQUE", "BANK_TRANSFER", "DIGITAL_WALLET", "VOUCHER", "OTHER"] as const;
export type ReportTenderMethod = (typeof TENDER_METHODS)[number];

export const VAT_CATEGORIES = ["STANDARD", "ZERO_RATED", "EXEMPT"] as const;
export type ReportVatCategory = (typeof VAT_CATEGORIES)[number];

/** One tender line of a Z: the net taken by one method over the day (may be negative: cash paid back). */
export type ZTenderDraft = {
  method: ReportTenderMethod;
  /** "" or a lower-case token (e.g. a card brand: "visa"). Never free text. */
  label?: string;
  amountMinor: bigint;
  count?: number | null;
};

/** One VAT line of a Z. A non-STANDARD line has rate 0 and VAT 0 (table CHECK). */
export type ZVatDraft = {
  category: ReportVatCategory;
  /** 1700 = 17%. 0..10000. */
  rateBasisPoints: number;
  taxableMinor: bigint;
  vatMinor: bigint;
};

/** A Z report as one parser read it. Maps 1:1 onto "RevenueDailyClose". */
export type ZReportDraft = {
  /** YYYY-MM-DD — the business day the Z closes (as the register dated it). */
  businessDay: string;
  /** The register's identity in its own system, as a token ^[A-Za-z0-9:_.-]{1,64}$ (e.g. "1", "pos-2"). */
  registerKey: string;
  /** The Z's running number, when the report shows one. */
  zNumber?: bigint | null;
  currency?: ReportCurrency;
  /** VAT-inclusive sales before discounts. */
  grossMinor: bigint;
  discountMinor?: bigint;
  refundMinor?: bigint;
  voidMinor?: bigint;
  /** MUST equal gross − discount − refund − void (table CHECK). */
  totalMinor: bigint;
  vatMinor: bigint;
  /** The register's cumulative grand total, when printed. */
  grandTotalMinor?: bigint | null;
  transactionCount?: number | null;
  period?: { start: Date | null; end: Date | null } | null;
  tenders: ZTenderDraft[];
  vatLines: ZVatDraft[];
  /** Where in the file this Z came from (1-based), for the owner's preview and row errors. */
  sourceRow?: number | null;
};

/** One credit from an acquirer / payment provider. Maps 1:1 onto "RevenueSettlement". */
export type SettlementDraft = {
  /** The acquirer / provider as a token ^[a-z][a-z0-9_]{0,39}$ (e.g. "isracard"). Set by the parser. */
  acquirer: string;
  /** YYYY-MM-DD — the day the money is credited. */
  valueDate: string;
  /** The settlement's own id in the acquirer's report: unique per parser, never reused. */
  externalId: string;
  currency?: ReportCurrency;
  grossMinor: bigint;
  feeMinor?: bigint;
  otherDeductionsMinor?: bigint;
  /** MUST equal gross − fee − other deductions (table CHECK). */
  netMinor: bigint;
  /** Both or neither; 1 ≤ number ≤ count ≤ 99 (table CHECK). */
  installments?: { number: number; count: number } | null;
  sourceRow?: number | null;
};

/** A row the parser could not turn into a draft. A code, never the row's content. */
export type ParseRowError = { row: number | null; code: string };

/** What a parser is handed. `mime` is client-reported: a hint, never trusted. */
export type ReportFile = { bytes: Buffer; filename: string; mime: string | null };

type ParserBase = {
  /** Lower-case token ^[a-z][a-z0-9_]{0,39}$; becomes part of sourceScope ("upload.z.<key>"). */
  key: string;
  /** Bumped when the parser's reading of a file changes: part of the token and the run identity. */
  version: number;
  /** The source system's name, as the owner knows it (Hebrew UI). */
  label: string;
  /**
   * FILE_STRUCTURED: the numbers were READ from a structured export (CSV / XLSX / XML / JSON).
   * FILE_EXTRACTED:  they were EXTRACTED from a document (PDF, image) — the read model counts such a Z only after
   *                  the owner confirms it (lib/revenue-truth/read-model.ts, CLOSE_AWAITING_CONFIRMATION).
   */
  capture: "FILE_STRUCTURED" | "FILE_EXTRACTED";
  /** 0 = not mine … 1 = certainly mine. Cheap: it must not parse the whole file. Never throws. */
  detect(file: ReportFile): number;
};

export type ZReportParser = ParserBase & {
  kind: "z";
  parse(file: ReportFile): { drafts: ZReportDraft[]; errors: ParseRowError[] };
};

export type SettlementParser = ParserBase & {
  kind: "settlement";
  /** ACQUIRER (a card company) or PAYMENT_PROVIDER (a clearing / payment service) — the table allows only these. */
  sourceKind: "ACQUIRER" | "PAYMENT_PROVIDER";
  parse(file: ReportFile): { drafts: SettlementDraft[]; errors: ParseRowError[] };
};

export type ReportParser = ZReportParser | SettlementParser;
export type ParserOf<K extends ReportKind> = K extends "z" ? ZReportParser : SettlementParser;
export type DraftOf<K extends ReportKind> = K extends "z" ? ZReportDraft : SettlementDraft;
