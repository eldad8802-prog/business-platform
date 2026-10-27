/**
 * העלאת דוחות וקבצים (/money/uploads, S1-B M3) — the pure read model. No database, no network, no clock:
 * `now` is passed in, so every rule here is unit-tested (uploads-overview.verify.test.ts).
 *
 * The screen is an ENTRY POINT, not an upload mechanism. It routes to the screens that already upload
 * (bank statement, documents, import), lists what was brought in lately, and derives what needs a look.
 * Nothing here writes, decides or changes a status.
 *
 * # What the output deliberately does NOT carry
 *
 * No amount, no transaction description, no counterparty, no reference, no bank coordinates — this screen
 * says THAT something was brought in, not what money it describes. A bank account appears only as the
 * owner's own label and the last four digits, exactly as the payables screens already show it.
 *
 * # Honesty about the source file
 *
 * No upload path stores the file itself today (the old bank upload keeps the parsed lines, bank file import
 * keeps only a hash of the bytes, the import ledger the same). Every entry says `sourceFileStored: false`
 * so the screen can say so plainly instead of implying the file can be opened again.
 */

/** bankFileImportState (lib/services/bank-file-import/http.ts) — ON / OFF / UNKNOWN, fail-closed. */
export type BankFileImportState = "ON" | "OFF" | "UNKNOWN";

/**
 * Where the bank card sends the owner — the server's decision only:
 *   legacy   bank file import is OFF → the old statement upload on /payables/bank
 *   b1       bank file import is ON  → /payables/bank/import (the old upload refuses with 409)
 *   unknown  the flag could not be resolved → no link (the old upload refuses with 503 too)
 */
export type BankMode = "legacy" | "b1" | "unknown";

export function bankModeOf(state: BankFileImportState): BankMode {
  if (state === "ON") return "b1";
  if (state === "OFF") return "legacy";
  return "unknown";
}

/** One ImportRun row, as `listRecentImportRuns` returns it (ids, enums, counts, timestamps only). */
export type ImportRunInput = {
  id: number;
  domain: string;
  status: "EXECUTING" | "COMPLETED" | "PARTIAL" | "FAILED";
  totalRows: number;
  createdCount: number | null;
  skippedCount: number | null;
  failedCount: number | null;
  startedAt: Date;
  completedAt: Date | null;
};

/** One old-path bank upload: the ExternalTransaction rows sharing an `upl-…` importBatchId, aggregated. */
export type LegacyBatchInput = {
  importBatchId: string;
  /** Lines this upload ADDED. A line already known from an earlier upload keeps its first batch id. */
  lineCount: number;
  firstBookedAt: Date | null;
  lastBookedAt: Date | null;
  createdAt: Date;
  account: { label: string; last4: string } | null;
};

export type HistoryStatus = "COMPLETED" | "PARTIAL" | "FAILED" | "EXECUTING" | "RECORDED";

export type HistoryEntry = {
  /** Stable React key: "run-<id>" or the legacy batch id. */
  id: string;
  source: "import_run" | "legacy_bank_upload";
  /** ImportRun.domain, or "bank_statement" for an old-path bank upload. */
  domain: string;
  typeLabel: string;
  status: HistoryStatus;
  statusLabel: string;
  /** When it was brought in (ISO). */
  at: string;
  completedAt: string | null;
  counts: { total: number | null; created: number | null; skipped: number | null; failed: number | null };
  /** Old bank uploads only: the first and last transaction DATE of the lines it added (YYYY-MM-DD). */
  period: { from: string; to: string } | null;
  account: { label: string; last4: string } | null;
  /** True for an upload made through the old bank statement path (read-only here). */
  legacyPath: boolean;
  /** Nothing stores source files today — always false, stated so the screen can say it. */
  sourceFileStored: false;
};

export type AttentionItem = {
  id: string;
  /** "action": a real, existing screen fixes it. "info": worth knowing, nothing to press. */
  kind: "action" | "info";
  title: string;
  detail: string;
  action?: { label: string; href: string };
};

export type UploadsOverview = {
  bank: { mode: BankMode };
  history: HistoryEntry[];
  attention: AttentionItem[];
};

export const HISTORY_LIMIT = 20;
/** A run still EXECUTING this long after it started has stopped, not slowed down. */
export const STUCK_AFTER_MS = 60 * 60 * 1000;
/** Attention looks back this far; an older failure is history, not a to-do. */
export const ATTENTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** The tabular import screen — where a corrected file is uploaded again. */
export const TABULAR_IMPORT_HREF = "/settings/import-export/import";

/**
 * The four tabular domains. For these, fixing a failed row means fixing the file: a corrected file has a new
 * content hash and therefore opens a NEW run, and rows the first run already created are shown as existing
 * records by the preview's duplicate check (execution-semantics.ts, import-run-store.ts). Re-uploading the
 * IDENTICAL file does not repair anything — it replays the finished run's result — so the action says
 * "correct the file", never "try again".
 */
const TABULAR_DOMAINS = new Set(["customers", "suppliers", "leads", "inventory"]);

const DOMAIN_LABELS: Record<string, string> = {
  bank_statement: "דף חשבון בנק",
  customers: "ייבוא לקוחות",
  suppliers: "ייבוא ספקים",
  leads: "ייבוא לידים",
  inventory: "ייבוא מלאי",
  documents: "ייבוא מסמכים",
  "issued-documents": "ייבוא מסמכים שהופקו",
  "historical-documents": "היסטוריה ממערכת קודמת",
};

export function domainLabel(domain: string): string {
  return DOMAIN_LABELS[domain] ?? "קליטת קובץ";
}

const STATUS_LABELS: Record<HistoryStatus, string> = {
  COMPLETED: "הושלם",
  PARTIAL: "הושלם חלקית",
  FAILED: "נכשל",
  EXECUTING: "בתהליך",
  RECORDED: "נקלט",
};

export function statusLabel(status: HistoryStatus): string {
  return STATUS_LABELS[status];
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

export function runToEntry(run: ImportRunInput): HistoryEntry {
  return {
    id: `run-${run.id}`,
    source: "import_run",
    domain: run.domain,
    typeLabel: domainLabel(run.domain),
    status: run.status,
    statusLabel: statusLabel(run.status),
    at: run.startedAt.toISOString(),
    completedAt: run.completedAt ? run.completedAt.toISOString() : null,
    counts: {
      total: run.totalRows,
      created: run.createdCount,
      skipped: run.skippedCount,
      failed: run.failedCount,
    },
    period: null,
    account: null,
    legacyPath: false,
    sourceFileStored: false,
  };
}

export function legacyBatchToEntry(batch: LegacyBatchInput): HistoryEntry {
  return {
    id: batch.importBatchId,
    source: "legacy_bank_upload",
    domain: "bank_statement",
    typeLabel: domainLabel("bank_statement"),
    // The old path has no run and no outcome record — only the lines it added. "נקלט", never "הושלם".
    status: "RECORDED",
    statusLabel: statusLabel("RECORDED"),
    at: batch.createdAt.toISOString(),
    completedAt: null,
    counts: { total: null, created: batch.lineCount, skipped: null, failed: null },
    period:
      batch.firstBookedAt && batch.lastBookedAt
        ? { from: isoDate(batch.firstBookedAt), to: isoDate(batch.lastBookedAt) }
        : null,
    account: batch.account ? { label: batch.account.label, last4: batch.account.last4.slice(-4) } : null,
    legacyPath: true,
    sourceFileStored: false,
  };
}

/** Both sources, newest first, at most `limit`. Ties keep a deterministic order (by id). */
export function mergeHistory(
  runs: readonly ImportRunInput[],
  batches: readonly LegacyBatchInput[],
  limit: number = HISTORY_LIMIT
): HistoryEntry[] {
  const all = [...runs.map(runToEntry), ...batches.map(legacyBatchToEntry)];
  all.sort((a, b) => (a.at === b.at ? (a.id < b.id ? 1 : -1) : a.at < b.at ? 1 : -1));
  return all.slice(0, Math.max(0, limit));
}

/**
 * What needs a look, derived from the runs alone (no new table, no stored state):
 *   FAILED, or PARTIAL with failed rows  → tabular domain: "action" (correct the file, upload it again)
 *                                          any other domain: "info"
 *   EXECUTING for longer than an hour    → "info"
 * Only runs from the last 30 days count. `importAvailable` is false when the import screen is not released,
 * and then no item links to it.
 */
export function deriveAttention(
  runs: readonly ImportRunInput[],
  now: Date,
  opts: { importAvailable: boolean }
): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const run of runs) {
    const age = now.getTime() - run.startedAt.getTime();
    if (age > ATTENTION_WINDOW_MS) continue;
    const label = domainLabel(run.domain);
    const failed = run.failedCount ?? 0;

    if (run.status === "FAILED" || (run.status === "PARTIAL" && failed > 0)) {
      const title =
        run.status === "FAILED"
          ? `${label}: הקליטה נכשלה`
          : `${label}: ${failed === 1 ? "שורה אחת לא נקלטה" : `${failed} שורות לא נקלטו`}`;
      if (TABULAR_DOMAINS.has(run.domain) && opts.importAvailable) {
        items.push({
          id: `run-${run.id}-failed`,
          kind: "action",
          title,
          detail: "אפשר לתקן בקובץ את מה שלא נקלט ולהעלות קובץ מתוקן. לפני הקליטה תוצג בדיקה של הקובץ.",
          action: { label: "לייבוא נתונים", href: TABULAR_IMPORT_HREF },
        });
      } else {
        items.push({
          id: `run-${run.id}-failed`,
          kind: "info",
          title,
          detail: "מה שנקלט נשמר. השורות שלא נקלטו לא נוספו לעסק.",
        });
      }
      continue;
    }

    if (run.status === "EXECUTING" && age > STUCK_AFTER_MS) {
      items.push({
        id: `run-${run.id}-stuck`,
        kind: "info",
        title: `${label}: הקליטה לא הסתיימה`,
        detail: "הקליטה התחילה לפני יותר משעה ועדיין לא הסתיימה. מה שכבר נקלט נשמר.",
      });
    }
  }
  // Actions first, then information — the owner sees what to do before what to know.
  return [...items.filter((i) => i.kind === "action"), ...items.filter((i) => i.kind === "info")];
}

export function buildUploadsOverview(input: {
  bankState: BankFileImportState;
  runs: readonly ImportRunInput[];
  legacyBatches: readonly LegacyBatchInput[];
  now: Date;
  importAvailable: boolean;
}): UploadsOverview {
  return {
    bank: { mode: bankModeOf(input.bankState) },
    history: mergeHistory(input.runs, input.legacyBatches, HISTORY_LIMIT),
    attention: deriveAttention(input.runs, input.now, { importAvailable: input.importAvailable }),
  };
}
