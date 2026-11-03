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
 * Owner decisions (approved directions 2026-11-03, docs "Owner decisions"): the business day and the register are
 * what the REPORT prints — when it prints none, the owner is asked (D-10, D-11), never defaulted; a settlement file is
 * accepted only as a batch / deposit SUMMARY (D-5); a rounding tolerance exists only as a parser's PROVEN format
 * precision (D-8, default 0). Every rule here is proven on synthetic data only — that proves the rule, not any real
 * export format.
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
  /**
   * YYYY-MM-DD — the business day the Z closes, AS PRINTED in the report (D-10). null when the report prints none:
   * the owner is then asked to choose the day (core.ts resolveZDrafts). A parser never derives it from a printed time
   * or from the period (no cut-off hour, ever).
   */
  businessDay: string | null;
  /**
   * The register's identity in its own system, as a token ^[A-Za-z0-9:_.-]{1,64}$ (e.g. "1", "pos-2"), AS PRINTED
   * (D-11). null when the report prints none: the business's single DEFINED register would be used — no such
   * definition exists yet — otherwise the owner is asked. Never invented ("1" is not a default).
   */
  registerKey: string | null;
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
  /**
   * D-8: the rounding this export's format is PROVEN to carry (minor units, a non-negative integer), e.g. tender lines
   * printed to whole shekels — declared only from a real sample's verification, never as a blanket tolerance.
   * Default 0: any difference between lines and totals is a warning. A difference within it is still shown and kept
   * as a code on the row, never hidden.
   */
  roundingToleranceMinor?: number;
  /** 0 = not mine … 1 = certainly mine. Cheap: it must not parse the whole file. Never throws. */
  detect(file: ReportFile): number;
};

export type ZReportParser = ParserBase & {
  kind: "z";
  parse(file: ReportFile): { drafts: ZReportDraft[]; errors: ParseRowError[] };
};

/**
 * What one settlement file lists (D-5). Stage one records only SUMMARY files — one row per batch or per deposit, with
 * gross / fee / net as the acquirer credited it. A TRANSACTION_LIST (one row per card transaction) or an
 * INSTALLMENT_LIST (one row per installment / payment) is refused as a whole: its rows are not credits.
 */
export type SettlementFileShape = "BATCH_SUMMARY" | "DEPOSIT_SUMMARY" | "TRANSACTION_LIST" | "INSTALLMENT_LIST";
export const SUPPORTED_SETTLEMENT_SHAPES: readonly SettlementFileShape[] = ["BATCH_SUMMARY", "DEPOSIT_SUMMARY"];

export type SettlementParser = ParserBase & {
  kind: "settlement";
  /** ACQUIRER (a card company) or PAYMENT_PROVIDER (a clearing / payment service) — the table allows only these. */
  sourceKind: "ACQUIRER" | "PAYMENT_PROVIDER";
  /** `shape` is what the parser recognised the file as; anything but a summary is refused before any row is kept. */
  parse(file: ReportFile): { shape: SettlementFileShape; drafts: SettlementDraft[]; errors: ParseRowError[] };
};

export type ReportParser = ZReportParser | SettlementParser;
export type ParserOf<K extends ReportKind> = K extends "z" ? ZReportParser : SettlementParser;
export type DraftOf<K extends ReportKind> = K extends "z" ? ZReportDraft : SettlementDraft;
