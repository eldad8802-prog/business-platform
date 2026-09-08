"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";

import { SettingsSection } from "@/components/settings/SettingsSection";
import {
  ACTION_BUTTON,
  ACTION_HELP,
  ACTION_LABEL,
  BLOCKING_REASON_TEXT,
  DATABASE_DUPLICATE_TEXT,
  DUPLICATE_ERROR_TEXT,
  DUPLICATE_WARNING_TEXT,
  EXTERNAL_ORIGIN_EXPLANATION,
  FACT_LABEL,
  IN_FILE_DUPLICATE_TEXT,
  MAPPING_BLOCKER_TEXT,
  MAPPING_STATUS_LABEL,
  NOT_READY_TEXT,
  REVERSAL_TARGET_TEXT,
  REVERSAL_TEXT,
  ROW_ERROR_TEXT,
  ROW_RESULT_TEXT,
  ROW_STATE_LABEL,
  ROW_WARNING_TEXT,
  documentTypeLabel,
  failureText,
} from "@/lib/data-transfer/historical/historical-owner-language";

/**
 * הגדרות → ייבוא וייצוא → היסטוריה ממערכת קודמת.
 *
 * The owner-facing surface over the historical fiscal engine that I-8B.1
 * through I-8B.5 built. It adds no fiscal reasoning of its own: every state it
 * renders — which rows collide, which decisions are permitted, whether the file
 * may run at all — is the server's answer, displayed.
 *
 * # Where the authority lives
 *
 * The server decides. This screen never computes a duplicate, never resolves a
 * reversal, never invents an action, and never enables the confirm button on
 * its own reasoning: it enables it when the preview says `readyForExecute`.
 * `allowedDecisions` is rendered as the set of choices, so a row the server
 * would refuse has no control to press, and a row the server blocked has no
 * choice at all.
 *
 * # The two-call confirm
 *
 * Confirming re-runs the preview WITH the owner's choices first, so the server
 * re-derives every row from the same bytes, re-checks that each choice is one
 * it would actually offer, and signs an approval bound to those choices. Only
 * then does execute run. It can therefore never be handed a decision the owner
 * never saw, nor the owner's decisions against a different file.
 *
 * # Why the file is re-sent every time
 *
 * Nothing is stored between calls. No upload session, no server-side draft,
 * nothing to expire or leak — the cost is re-sending the bytes, and the benefit
 * is that abandoning this screen leaves nothing behind anywhere.
 *
 * # What this screen must never say
 *
 * That Dubiz issued anything. These documents came from a previous system; the
 * import records them and nothing else. No number is drawn, no PDF is produced,
 * nothing is reported. The wording that carries that lives in
 * `historical-owner-language.ts` and is asserted by the verifier.
 */

/* ------------------------------------------------------------ contracts -- */

type Requirement = "required" | "optional" | "conditional";

export type HistoricalFieldOption = {
  field: string;
  requirement: Requirement;
  help: string | null;
};

/** target -> owner-facing header, so the client never hardcodes Hebrew keys. */
export type HistoricalHeaderMap = {
  documentTypeCode: string;
  originalDocumentNumber: string;
  originalIssueDate: string;
  totalAmount: string;
  currency: string;
  customerNameSnapshot: string;
  sourceSystemCode: string;
  reversesOriginalNumberRaw: string;
};

type DateFormat = "DMY" | "MDY" | null;

type FieldValue = { field: string; original: string; normalized: string | null };

type Issue = { field: string; code: string; reason: string };

type DuplicateAnalysis = {
  database: {
    state: "NONE" | "EXACT" | "STRONG_CANDIDATE" | "AMBIGUOUS";
    matchCount: number;
    comparison: { field: string; agrees: boolean }[] | null;
    differingFields: string[];
  };
  inFile: {
    state: "NONE" | "EXACT_DUPLICATE" | "CONFLICTING_DUPLICATE";
    firstOccurrenceRow: number | null;
    laterRows: number[];
  };
};

type ReversalAnalysis = {
  state: keyof typeof REVERSAL_TEXT;
  rawNumber: string | null;
  targetSourceRow: number | null;
  targetSummary: { documentTypeCode: string; originalIssueDate: string | null } | null;
  candidateCount: number;
};

type AnalyzedRow = {
  sourceRowNumber: number;
  state: "READY" | "WARNING" | "ERROR";
  errors: Issue[];
  warnings: Issue[];
  values: FieldValue[];
  duplicate: DuplicateAnalysis;
  reversal: ReversalAnalysis;
};

type MappingEntry = {
  field: string;
  requirement: Requirement;
  sourceHeader: string | null;
  sourceIndex: number | null;
  status: "EXACT" | "SUGGESTED" | "AMBIGUOUS" | "UNMAPPED";
  candidates: string[];
};

type Analysis = {
  file: {
    filename: string;
    sheetName: string | null;
    availableSheets: string[];
    headers: string[];
    rowCount: number;
  };
  mapping: {
    entries: MappingEntry[];
    unmappedSourceHeaders: string[];
    blockers: { code: string; field: string; reason: string }[];
  };
  dateInterpretation: {
    suppliedFormat: DateFormat;
    deterministic: boolean;
    requirement: "DATE_FORMAT_REQUIRED" | null;
  };
  summary: {
    totalRows: number;
    ready: number;
    warning: number;
    error: number;
    stoppedAtMapping: boolean;
  };
  rows: AnalyzedRow[];
  duplicateEvidence: { fingerprint: string };
};

type Action = "CREATE" | "SKIP" | "CREATE_ANYWAY";

type PreviewRow = AnalyzedRow & {
  reversalTarget: keyof typeof REVERSAL_TARGET_TEXT;
  defaultDecision: Action;
  allowedDecisions: Action[];
  selectedDecision: Action;
  ownerDecisionRequired: boolean;
  blocked: boolean;
  blockingReasons: string[];
};

type Preview = {
  summary: {
    totalRows: number;
    willCreate: number;
    willSkip: number;
    createAnyway: number;
    ownerDecisionRequired: number;
    blocked: number;
    withWarnings: number;
    exactDatabaseDuplicates: number;
    strongDuplicateCandidates: number;
    inFileCollisions: number;
    unresolvedReversals: number;
  };
  rows: PreviewRow[];
  rowsTruncated: boolean;
  decisions: Record<number, Action>;
  awaitingDecision: number[];
  readyForExecute: boolean;
  notReadyReasons: string[];
  evidenceFingerprint: string;
  previewToken: string | null;
  expiresAt: string | null;
};

type ExecuteResult = {
  status: "COMPLETED" | "PARTIAL" | "FAILED";
  replayed: boolean;
  totals: {
    totalRows: number;
    created: number;
    skipped: number;
    failed: number;
    alreadyExecuted: number;
  };
  rows: { sourceRowNumber: number; result: keyof typeof ROW_RESULT_TEXT }[];
};

type Busy = null | "template" | "analyzing" | "previewing" | "importing";

type Failure = { code: string | null; message: string } | null;

type Props = {
  fields: readonly HistoricalFieldOption[];
  headers: HistoricalHeaderMap;
  recordsHref: string;
};

/* -------------------------------------------------------------- helpers -- */

const DONT_IMPORT = "__skip__";

/** How many rows this screen will draw. The summary always covers them all. */
const ROW_WINDOW = 100;

const ISSUE_RANK = { ERROR: 0, WARNING: 1, READY: 2 } as const;

function authHeader(): Record<string, string> | null {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;
  return token?.trim() ? { Authorization: `Bearer ${token.trim()}` } : null;
}

function count(value: number): string {
  return value.toLocaleString("he-IL");
}

/** Owner-facing text for one issue, falling back to the server's own reason. */
function issueText(issue: Issue): string {
  return (
    (ROW_ERROR_TEXT as Record<string, string>)[issue.code] ??
    (DUPLICATE_ERROR_TEXT as Record<string, string>)[issue.code] ??
    (ROW_WARNING_TEXT as Record<string, string>)[issue.code] ??
    (DUPLICATE_WARNING_TEXT as Record<string, string>)[issue.code] ??
    issue.reason
  );
}

function filenameFromDisposition(header: string | null, fallback: string) {
  if (!header) return fallback;
  return /filename="([^"]+)"/.exec(header)?.[1] ?? fallback;
}

/* ------------------------------------------------------------ the screen -- */

export function HistoricalImportScreen({ fields, headers, recordsHref }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  const [sheetChoices, setSheetChoices] = useState<string[]>([]);
  const [dateFormat, setDateFormat] = useState<DateFormat>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [mapping, setMapping] = useState<Record<number, string>>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  // The owner's overrides ONLY. Every other row keeps the server's default, so
  // a row nobody touched cannot drift when the file is re-derived.
  const [overrides, setOverrides] = useState<Record<number, Action>>({});
  const [result, setResult] = useState<ExecuteResult | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [failure, setFailure] = useState<Failure>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [issuesOnly, setIssuesOnly] = useState(true);
  /**
   * Whether the column list is expanded.
   *
   * Eleven columns, each with a picker, is most of a phone screen — and when
   * every one of them was recognised there is nothing in it for the owner to
   * do. So it collapses to a single line they can open. It is FORCED open
   * whenever the server reported a mapping blocker, because then the list is
   * the only place the problem can be fixed.
   */
  const [columnsOpen, setColumnsOpen] = useState(false);

  /* ------------------------------------------------------------ actions -- */

  function clearFromFile() {
    setAnalysis(null);
    setPreview(null);
    setResult(null);
    setMapping({});
    setOverrides({});
    setFailure(null);
  }

  async function downloadTemplate() {
    const auth = authHeader();
    if (!auth) {
      setFailure({ code: null, message: "צריך להתחבר מחדש כדי להמשיך." });
      return;
    }
    setBusy("template");
    setFailure(null);
    setNotice(null);
    try {
      const response = await fetch("/api/data-transfer/import/historical/template", {
        headers: auth,
      });
      if (!response.ok) {
        setFailure({
          code: null,
          message:
            response.status === 401
              ? "אין הרשאה. התחברו מחדש ונסו שוב."
              : "הורדת התבנית נכשלה. נסו שוב מאוחר יותר.",
        });
        return;
      }
      const blob = await response.blob();
      const filename = filenameFromDisposition(
        response.headers.get("Content-Disposition"),
        "dubiz-historical-documents-template.xlsx"
      );
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setNotice(`התבנית ירדה: ${filename}`);
    } catch {
      setFailure({ code: null, message: "שגיאת רשת — בדקו את החיבור ונסו שוב." });
    } finally {
      setBusy(null);
    }
  }

  /**
   * Read the file and say what is in it. ZERO writes behind this call.
   *
   * The sheet, the mapping and the date format are all passed EXPLICITLY when
   * known, because they are part of the analysis identity: the same file read
   * under a different date format is a different analysis, and the approval the
   * owner eventually signs is bound to that identity.
   */
  async function runAnalyze(next?: {
    file?: File | null;
    sheet?: string | null;
    dateFormat?: DateFormat;
    mapping?: Record<number, string> | null;
  }) {
    const targetFile = next?.file !== undefined ? next.file : file;
    if (!targetFile) return;

    const targetSheet = next?.sheet !== undefined ? next.sheet : sheet;
    const targetFormat = next?.dateFormat !== undefined ? next.dateFormat : dateFormat;
    const targetMapping = next?.mapping !== undefined ? next.mapping : mapping;

    const auth = authHeader();
    if (!auth) {
      setFailure({ code: null, message: "צריך להתחבר מחדש כדי להמשיך." });
      return;
    }

    setBusy("analyzing");
    setFailure(null);
    setNotice(null);
    setPreview(null);
    setResult(null);

    try {
      const body = new FormData();
      body.append("file", targetFile);
      if (targetSheet) body.append("sheet", targetSheet);
      if (targetFormat) body.append("dateFormat", targetFormat);
      if (targetMapping && Object.keys(targetMapping).length > 0) {
        body.append("mapping", JSON.stringify(targetMapping));
      }

      const response = await fetch("/api/data-transfer/import/historical/analyze", {
        method: "POST",
        headers: auth,
        body,
      });
      const data = await response.json().catch(() => null);

      if (!response.ok || !data?.ok) {
        if (data?.code === "SHEET_CHOICE_REQUIRED") {
          setSheetChoices(data.availableSheets ?? []);
          setAnalysis(null);
          setFailure({ code: data.code, message: failureText(data.code, data.message) });
          return;
        }
        setAnalysis(null);
        setFailure({
          code: data?.code ?? null,
          message: failureText(data?.code, data?.message ?? data?.error),
        });
        return;
      }

      const fresh = data as Analysis;
      setAnalysis(fresh);
      setSheet(fresh.file.sheetName);
      setSheetChoices(fresh.file.availableSheets ?? []);
      setOverrides({});

      // Seed the mapping from what the server matched, so every later call
      // carries the SAME mapping the owner is looking at. Only columns the
      // server actually resolved are seeded; an AMBIGUOUS header stays unset
      // and the owner has to choose it.
      const seeded: Record<number, string> = {};
      for (const entry of fresh.mapping.entries) {
        if (entry.sourceIndex !== null) seeded[entry.sourceIndex] = entry.field;
      }
      setMapping(seeded);
    } catch {
      setFailure({ code: null, message: "שגיאת רשת — בדקו את החיבור ונסו שוב." });
    } finally {
      setBusy(null);
    }
  }

  /**
   * What confirming would actually do.
   *
   * `expectedEvidence` is the fingerprint Analyze reported. If the history has
   * moved since — a record inserted between the two calls turns a "not held"
   * into "already held" without a byte of the file changing — the server
   * refuses with ANALYSIS_STALE rather than quietly building a different
   * preview under the owner's feet.
   */
  async function runPreview(decisions?: Record<number, Action> | null) {
    if (!file || !analysis) return;
    const auth = authHeader();
    if (!auth) {
      setFailure({ code: null, message: "צריך להתחבר מחדש כדי להמשיך." });
      return null;
    }

    setBusy("previewing");
    setFailure(null);
    setNotice(null);

    try {
      const body = new FormData();
      body.append("file", file);
      if (sheet) body.append("sheet", sheet);
      if (dateFormat) body.append("dateFormat", dateFormat);
      body.append("mapping", JSON.stringify(mapping));
      body.append("expectedEvidence", analysis.duplicateEvidence.fingerprint);
      if (decisions) body.append("decisions", JSON.stringify(decisions));

      const response = await fetch("/api/data-transfer/import/historical/preview", {
        method: "POST",
        headers: auth,
        body,
      });
      const data = await response.json().catch(() => null);

      if (!response.ok || !data?.ok) {
        setFailure({
          code: data?.code ?? null,
          message: failureText(data?.code, data?.message ?? data?.error),
        });
        return null;
      }

      setPreview(data as Preview);
      setResult(null);
      return data as Preview;
    } catch {
      setFailure({ code: null, message: "שגיאת רשת — בדקו את החיבור ונסו שוב." });
      return null;
    } finally {
      setBusy(null);
    }
  }

  /**
   * Confirm and import.
   *
   * The preview is re-run with the owner's choices so the server re-derives
   * everything and signs an approval bound to them, and only the token from
   * THAT call is executed. A token from an earlier preview would attest to a
   * different set of decisions.
   */
  async function runImport() {
    if (!file || !preview) return;
    const auth = authHeader();
    if (!auth) {
      setFailure({ code: null, message: "צריך להתחבר מחדש כדי להמשיך." });
      return;
    }

    setBusy("importing");
    setFailure(null);
    setNotice(null);

    const decisions = { ...preview.decisions, ...overrides };

    try {
      const bound = new FormData();
      bound.append("file", file);
      if (sheet) bound.append("sheet", sheet);
      if (dateFormat) bound.append("dateFormat", dateFormat);
      bound.append("mapping", JSON.stringify(mapping));
      bound.append("decisions", JSON.stringify(decisions));
      if (analysis) {
        bound.append("expectedEvidence", analysis.duplicateEvidence.fingerprint);
      }

      const previewResponse = await fetch(
        "/api/data-transfer/import/historical/preview",
        { method: "POST", headers: auth, body: bound }
      );
      const previewData = await previewResponse.json().catch(() => null);

      if (!previewResponse.ok || !previewData?.ok) {
        setFailure({
          code: previewData?.code ?? null,
          message: failureText(previewData?.code, previewData?.message ?? previewData?.error),
        });
        return;
      }

      const confirmed = previewData as Preview;
      setPreview(confirmed);

      if (!confirmed.readyForExecute || !confirmed.previewToken) {
        setFailure({
          code: "NOT_READY",
          message: failureText("NOT_READY"),
        });
        return;
      }

      const body = new FormData();
      body.append("file", file);
      if (sheet) body.append("sheet", sheet);
      if (dateFormat) body.append("dateFormat", dateFormat);
      body.append("mapping", JSON.stringify(mapping));
      body.append("decisions", JSON.stringify(confirmed.decisions));
      body.append("previewToken", confirmed.previewToken);

      const response = await fetch("/api/data-transfer/import/historical/execute", {
        method: "POST",
        headers: auth,
        body,
      });
      const data = await response.json().catch(() => null);

      if (!response.ok || !data?.ok) {
        setFailure({
          code: data?.code ?? null,
          message: failureText(data?.code, data?.message ?? data?.error),
        });
        return;
      }

      setResult(data as ExecuteResult);
    } catch {
      // A network failure here is genuinely ambiguous: the import may have run.
      // Say so, and say what to do — the same file re-run completes only what
      // is missing, because the run is identified by the approval itself.
      setFailure({
        code: null,
        message:
          "החיבור נקטע. ייתכן שהקליטה הושלמה — הריצו את אותו קובץ שוב, ודוביז תשלים רק את מה שחסר.",
      });
    } finally {
      setBusy(null);
    }
  }

  /* ------------------------------------------------------------ derived -- */

  const blockers = analysis?.mapping.blockers ?? [];
  const mappedCount = Object.keys(mapping).length;
  const dateChoiceRequired =
    analysis?.dateInterpretation.requirement === "DATE_FORMAT_REQUIRED";

  const analysisRows = useMemo(() => {
    if (!analysis) return [];
    const sorted = [...analysis.rows].sort(
      (a, b) =>
        ISSUE_RANK[a.state] - ISSUE_RANK[b.state] ||
        a.sourceRowNumber - b.sourceRowNumber
    );
    const filtered = issuesOnly ? sorted.filter((r) => r.state !== "READY") : sorted;
    return filtered.slice(0, ROW_WINDOW);
  }, [analysis, issuesOnly]);

  const analysisRowsTruncated =
    !!analysis &&
    (issuesOnly
      ? analysis.rows.filter((r) => r.state !== "READY").length
      : analysis.rows.length) > analysisRows.length;

  /** The owner's choice for a row, falling back to the server's resolution. */
  function decisionFor(row: PreviewRow): Action {
    return overrides[row.sourceRowNumber] ?? row.selectedDecision;
  }

  // Counted over the FULL decision set rather than the displayed window, so the
  // number on the button is the number of records that will actually be written.
  const effectiveDecisions: Record<number, Action> = preview
    ? { ...preview.decisions, ...overrides }
    : {};
  const willCreate = Object.values(effectiveDecisions).filter(
    (a) => a === "CREATE" || a === "CREATE_ANYWAY"
  ).length;
  const willSkip = Object.values(effectiveDecisions).filter((a) => a === "SKIP").length;

  /** Rows the owner still has to answer, and whether they are all on screen. */
  const awaiting = preview
    ? preview.awaitingDecision.filter((n) => overrides[n] === undefined)
    : [];
  const awaitingOffscreen = preview
    ? awaiting.filter((n) => !preview.rows.some((r) => r.sourceRowNumber === n)).length
    : 0;

  /**
   * The preview reflects the owner's current choices only when they have been
   * sent. Overrides made since the last preview call mean the summary and the
   * readiness verdict on screen are one step behind, so the confirm button asks
   * for a fresh preview instead of executing a stale one.
   */
  const decisionsPending = Object.keys(overrides).length > 0;

  const decisionRows = preview
    ? preview.rows.filter(
        (r) => r.ownerDecisionRequired || r.blocked || r.allowedDecisions.length > 1
      )
    : [];

  /* -------------------------------------------------------------- render -- */

  return (
    <>
      {/* What this is, before anything else. */}
      <SettingsSection>
        <p className="text-sm font-bold text-[var(--dz-text-primary)]">
          מסמכים שהפקתם במערכת אחרת, לפני דוביז.
        </p>
        <p className="mt-2 text-xs leading-5 text-[var(--dz-text-muted)]">
          {EXTERNAL_ORIGIN_EXPLANATION}
        </p>
        <p className="mt-2 text-xs leading-5 text-[var(--dz-text-muted)]">
          שום דבר לא נשמר עד שתאשרו. תמיד תראו קודם מה ייכנס, מה כבר קיים ומה
          דורש החלטה שלכם.
        </p>
        <Link
          href={recordsHref}
          className="mt-3 inline-flex min-h-[44px] items-center rounded-2xl border border-[var(--dz-border-subtle)] px-4 text-xs font-semibold text-[var(--dz-text-primary)] transition hover:bg-[var(--dz-surface-muted)]"
        >
          למסמכים ההיסטוריים שכבר נקלטו
        </Link>
      </SettingsSection>

      {/* 1 — the template */}
      <div className="mt-4">
        <SettingsSection
          title="התבנית"
          description="גיליון למילוי וגיליון הוראות, עם כל העמודות שדוביז יודעת לקרוא."
        >
          <button
            type="button"
            onClick={downloadTemplate}
            disabled={busy !== null}
            className="min-h-[44px] w-full rounded-2xl border border-[var(--dz-border-subtle)] px-4 text-sm font-semibold text-[var(--dz-text-primary)] transition hover:bg-[var(--dz-surface-muted)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy === "template" ? "מכין את התבנית…" : "הורדת התבנית"}
          </button>
          <p className="mt-2 text-xs leading-5 text-[var(--dz-text-muted)]">
            אפשר גם להעלות קובץ שיצא מהמערכת הקודמת כמו שהוא — נתאים את העמודות
            יחד בשלב הבא.
          </p>
        </SettingsSection>
      </div>

      {/* 2 — the file */}
      <div className="mt-4">
        <SettingsSection
          title="העלו את הקובץ"
          description="קובץ אקסל או קובץ טבלה, עד 10MB ועד 10,000 שורות."
        >
          <input
            ref={fileInput}
            type="file"
            accept=".xlsx,.csv"
            className="sr-only"
            onChange={(e) => {
              const next = e.target.files?.[0] ?? null;
              clearFromFile();
              setSheet(null);
              setSheetChoices([]);
              setDateFormat(null);
              setFile(next);
              if (next) void runAnalyze({ file: next, sheet: null, dateFormat: null, mapping: null });
            }}
          />
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={busy !== null}
            className="w-full break-words rounded-2xl border border-dashed border-[var(--dz-border-subtle)] px-4 py-6 text-sm font-semibold text-[var(--dz-text-primary)] transition hover:bg-[var(--dz-surface-muted)] disabled:opacity-60"
          >
            {file ? file.name : "בחרו קובץ"}
          </button>

          {busy === "analyzing" ? (
            <p className="mt-3 text-xs text-[var(--dz-text-muted)]">קורא את הקובץ…</p>
          ) : null}

          {sheetChoices.length > 1 ? (
            <div className="mt-4">
              <p className="text-xs font-semibold text-[var(--dz-text-primary)]">
                בקובץ יש כמה גיליונות. איזה מהם לקלוט?
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {sheetChoices.map((name) => (
                  <button
                    key={name}
                    type="button"
                    disabled={busy !== null}
                    onClick={() => {
                      setSheet(name);
                      void runAnalyze({ sheet: name, mapping: null });
                    }}
                    className={`min-h-[44px] rounded-full border px-4 text-xs font-semibold transition disabled:opacity-60 ${
                      sheet === name
                        ? "border-[var(--dz-accent)] text-[var(--dz-accent)]"
                        : "border-[var(--dz-border-subtle)] text-[var(--dz-text-primary)] hover:bg-[var(--dz-surface-muted)]"
                    }`}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </SettingsSection>
      </div>

      {/* 3 — how to read dates */}
      {analysis ? (
        <div className="mt-4">
          <SettingsSection
            title="איך לקרוא תאריכים"
            description={
              dateChoiceRequired
                ? "בקובץ יש תאריכים שאפשר לקרוא בשתי דרכים. בלי בחירה שלכם לא ננחש."
                : "אפשר לקבוע במפורש איך לקרוא תאריכים בקובץ הזה."
            }
          >
            {dateChoiceRequired ? (
              <p className="mb-3 rounded-2xl bg-[var(--dz-background)] px-4 py-3 text-xs leading-5 text-[var(--dz-text-primary)]">
                לדוגמה, 03/04/2025 יכול להיות ה־3 באפריל או ה־4 במרץ. הבחירה
                קובעת לאיזה חודש המסמך שייך, ולכן אנחנו שואלים במקום להניח.
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ["DMY", "יום/חודש/שנה", "03/04/2025 הוא ה־3 באפריל"],
                  ["MDY", "חודש/יום/שנה", "03/04/2025 הוא ה־4 במרץ"],
                ] as const
              ).map(([value, label, example]) => (
                <button
                  key={value}
                  type="button"
                  disabled={busy !== null}
                  onClick={() => {
                    setDateFormat(value);
                    void runAnalyze({ dateFormat: value });
                  }}
                  className={`min-h-[44px] flex-1 rounded-2xl border px-4 py-2 text-right text-xs font-semibold transition disabled:opacity-60 ${
                    dateFormat === value
                      ? "border-[var(--dz-accent)] text-[var(--dz-accent)]"
                      : "border-[var(--dz-border-subtle)] text-[var(--dz-text-primary)] hover:bg-[var(--dz-surface-muted)]"
                  }`}
                >
                  <span className="block">{label}</span>
                  <span className="mt-0.5 block font-normal text-[var(--dz-text-muted)]">
                    {example}
                  </span>
                </button>
              ))}
            </div>
            {dateFormat && !dateChoiceRequired ? (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => {
                  setDateFormat(null);
                  void runAnalyze({ dateFormat: null });
                }}
                className="mt-3 min-h-[44px] rounded-full border border-[var(--dz-border-subtle)] px-4 text-xs font-semibold text-[var(--dz-text-muted)] transition hover:bg-[var(--dz-surface-muted)]"
              >
                לבטל את הבחירה
              </button>
            ) : null}
          </SettingsSection>
        </div>
      ) : null}

      {/* 4 — columns */}
      {analysis ? (
        <div className="mt-4">
          <SettingsSection
            title="התאמת עמודות"
            description={`נמצאו ${count(analysis.file.rowCount)} שורות בקובץ. בדקו שכל עמודה הובנה נכון.`}
          >
            {blockers.length > 0 ? (
              <ul className="mb-3 flex flex-col gap-2">
                {blockers.map((blocker, i) => (
                  <li
                    key={`${blocker.code}-${blocker.field}-${i}`}
                    className="rounded-2xl bg-[var(--dz-background)] px-4 py-3"
                  >
                    <p className="break-words text-xs font-bold text-[var(--dz-danger,#b3261e)]">
                      {blocker.field}
                    </p>
                    <p className="mt-1 text-xs leading-5 text-[var(--dz-text-muted)]">
                      {(MAPPING_BLOCKER_TEXT as Record<string, string>)[blocker.code] ??
                        blocker.reason}
                    </p>
                  </li>
                ))}
              </ul>
            ) : null}

            {blockers.length === 0 ? (
              <button
                type="button"
                onClick={() => setColumnsOpen((v) => !v)}
                aria-expanded={columnsOpen}
                className="mb-3 flex min-h-[44px] w-full items-center justify-between gap-2 rounded-2xl bg-[var(--dz-background)] px-4 text-right text-xs font-semibold text-[var(--dz-text-primary)] transition hover:bg-[var(--dz-surface-muted)]"
              >
                <span>
                  {mappedCount === analysis.file.headers.length
                    ? `כל ${count(analysis.file.headers.length)} העמודות בקובץ זוהו`
                    : `${count(mappedCount)} מתוך ${count(analysis.file.headers.length)} העמודות בקובץ זוהו`}
                </span>
                <span className="shrink-0 text-[var(--dz-text-muted)]">
                  {columnsOpen ? "סגרו" : "בדקו"}
                </span>
              </button>
            ) : null}

            <ul
              hidden={blockers.length === 0 && !columnsOpen}
              className="flex flex-col divide-y divide-[var(--dz-border-subtle)]"
            >
              {analysis.file.headers.map((header, index) => {
                const entry = analysis.mapping.entries.find(
                  (e) => e.sourceIndex === index
                );
                return (
                  <li key={`${header}-${index}`} className="py-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="min-w-0 break-words text-sm font-bold text-[var(--dz-text-primary)]">
                        {header || "(עמודה ללא שם)"}
                      </span>
                      <span className="shrink-0 rounded-full bg-[var(--dz-surface-muted)] px-2 py-0.5 text-[11px] font-semibold text-[var(--dz-text-muted)]">
                        {MAPPING_STATUS_LABEL[entry?.status ?? "UNMAPPED"]}
                      </span>
                    </div>
                    <select
                      value={mapping[index] ?? DONT_IMPORT}
                      disabled={busy !== null}
                      onChange={(e) => {
                        const next = { ...mapping };
                        if (e.target.value === DONT_IMPORT) delete next[index];
                        else next[index] = e.target.value;
                        setMapping(next);
                        setPreview(null);
                        setOverrides({});
                        void runAnalyze({ mapping: next });
                      }}
                      className="mt-2 min-h-[44px] w-full rounded-xl border border-[var(--dz-border-subtle)] bg-[var(--dz-background)] px-3 text-sm text-[var(--dz-text-primary)]"
                    >
                      <option value={DONT_IMPORT}>אל תקלטו עמודה זו</option>
                      {fields.map((f) => (
                        <option key={f.field} value={f.field}>
                          {f.field}
                          {f.requirement === "required" ? " (חובה)" : ""}
                        </option>
                      ))}
                    </select>
                  </li>
                );
              })}
            </ul>
          </SettingsSection>
        </div>
      ) : null}

      {/* 5 — what is in the file */}
      {analysis && !analysis.summary.stoppedAtMapping ? (
        <div className="mt-4">
          <SettingsSection title="מה מצאנו בקובץ">
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {(
                [
                  ["סה״כ שורות", analysis.summary.totalRows],
                  [ROW_STATE_LABEL.READY, analysis.summary.ready],
                  [ROW_STATE_LABEL.WARNING, analysis.summary.warning],
                  [ROW_STATE_LABEL.ERROR, analysis.summary.error],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="rounded-2xl bg-[var(--dz-background)] px-3 py-2">
                  <dt className="text-[11px] text-[var(--dz-text-muted)]">{label}</dt>
                  <dd className="text-lg font-bold text-[var(--dz-text-primary)]">
                    {count(value)}
                  </dd>
                </div>
              ))}
            </dl>

            <p className="mt-3 text-xs leading-5 text-[var(--dz-text-muted)]">
              שורה עם התראה עדיין ניתנת לקליטה. שורה שסומנה
              {` "${ROW_STATE_LABEL.ERROR}" `}
              לא תיקלט עד שהקובץ יתוקן.
            </p>

            <div className="mt-4 flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-[var(--dz-text-primary)]">
                {issuesOnly ? "מוצגות שורות שדורשות תשומת לב" : "מוצגות כל השורות"}
              </span>
              <button
                type="button"
                onClick={() => setIssuesOnly((v) => !v)}
                className="min-h-[44px] shrink-0 rounded-full border border-[var(--dz-border-subtle)] px-4 text-xs font-semibold text-[var(--dz-text-primary)] transition hover:bg-[var(--dz-surface-muted)]"
              >
                {issuesOnly ? "הצג הכול" : "רק מה שדורש תשומת לב"}
              </button>
            </div>

            {analysisRows.length === 0 ? (
              <p className="mt-3 rounded-2xl bg-[var(--dz-background)] px-4 py-3 text-xs leading-5 text-[var(--dz-text-primary)]">
                אין שורות שדורשות תשומת לב.
              </p>
            ) : (
              <ul className="mt-2 flex flex-col divide-y divide-[var(--dz-border-subtle)]">
                {analysisRows.map((row) => (
                  <RowCard key={row.sourceRowNumber} row={row} headers={headers} />
                ))}
              </ul>
            )}

            {analysisRowsTruncated ? (
              <p className="mt-3 text-xs text-[var(--dz-text-muted)]">
                מוצגות השורות הראשונות. המספרים למעלה מתייחסים לכל הקובץ.
              </p>
            ) : null}

            <button
              type="button"
              onClick={() => void runPreview(null)}
              disabled={busy !== null || blockers.length > 0}
              className="mt-4 min-h-[44px] w-full rounded-2xl bg-[var(--dz-accent)] px-4 text-sm font-bold text-white transition disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === "previewing" ? "מכין תצוגה מקדימה…" : "המשיכו לתצוגה מקדימה"}
            </button>
          </SettingsSection>
        </div>
      ) : null}

      {/* 6 — decisions and the final preview */}
      {preview && !result ? (
        <div className="mt-4">
          <SettingsSection
            title="מה ייכנס להיסטוריה"
            description="דוביז בחרה ברירת מחדל לכל שורה. איפה שצריך החלטה — היא שלכם."
          >
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {(
                [
                  ["ייקלטו", willCreate],
                  ["ידולגו", willSkip],
                  ["ממתין להחלטה", awaiting.length],
                  ["לא ניתן לקלוט", preview.summary.blocked],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="rounded-2xl bg-[var(--dz-background)] px-3 py-2">
                  <dt className="text-[11px] text-[var(--dz-text-muted)]">{label}</dt>
                  <dd className="text-lg font-bold text-[var(--dz-text-primary)]">
                    {count(value)}
                  </dd>
                </div>
              ))}
            </dl>

            {preview.summary.exactDatabaseDuplicates > 0 ||
            preview.summary.strongDuplicateCandidates > 0 ||
            preview.summary.inFileCollisions > 0 ? (
              <ul className="mt-3 flex flex-col gap-1 text-xs leading-5 text-[var(--dz-text-muted)]">
                {preview.summary.exactDatabaseDuplicates > 0 ? (
                  <li>
                    {count(preview.summary.exactDatabaseDuplicates)} שורות כבר קיימות
                    בהיסטוריה שלכם, וידולגו.
                  </li>
                ) : null}
                {preview.summary.strongDuplicateCandidates > 0 ? (
                  <li>
                    {count(preview.summary.strongDuplicateCandidates)} שורות נושאות
                    מספר שכבר קיים אבל עם פרטים שונים, וממתינות להחלטה שלכם.
                  </li>
                ) : null}
                {preview.summary.inFileCollisions > 0 ? (
                  <li>
                    {count(preview.summary.inFileCollisions)} שורות מתנגשות עם שורה
                    אחרת באותו קובץ.
                  </li>
                ) : null}
              </ul>
            ) : null}

            {decisionRows.length > 0 ? (
              <ul className="mt-4 flex flex-col divide-y divide-[var(--dz-border-subtle)]">
                {decisionRows.map((row) => {
                  const chosen = decisionFor(row);
                  return (
                    <li key={row.sourceRowNumber} className="py-3">
                      <RowHeading row={row} headers={headers} badge={ACTION_LABEL[chosen]} />

                      {/* Why the row is where it is. */}
                      {row.duplicate.database.state !== "NONE" ? (
                        <p className="mt-1 text-xs leading-5 text-[var(--dz-text-muted)]">
                          {DATABASE_DUPLICATE_TEXT[row.duplicate.database.state]}
                        </p>
                      ) : null}
                      {row.duplicate.database.differingFields.length > 0 ? (
                        <p className="mt-1 text-xs leading-5 text-[var(--dz-text-muted)]">
                          שונה ב:{" "}
                          {row.duplicate.database.differingFields
                            .map(
                              (f) =>
                                (FACT_LABEL as Record<string, string>)[f] ?? f
                            )
                            .join(" · ")}
                        </p>
                      ) : null}
                      {row.duplicate.inFile.state !== "NONE" ? (
                        <p className="mt-1 text-xs leading-5 text-[var(--dz-text-muted)]">
                          {IN_FILE_DUPLICATE_TEXT[row.duplicate.inFile.state]}
                          {row.duplicate.inFile.firstOccurrenceRow !== null
                            ? ` — שורה ${row.sourceRowNumber} מתנגשת עם שורה ${row.duplicate.inFile.firstOccurrenceRow}, והראשונה קודמת`
                            : ""}
                        </p>
                      ) : null}
                      {row.reversal.state !== "NOT_APPLICABLE" ? (
                        <p className="mt-1 text-xs leading-5 text-[var(--dz-text-muted)]">
                          {REVERSAL_TEXT[row.reversal.state]}
                          {REVERSAL_TARGET_TEXT[row.reversalTarget]
                            ? ` — ${REVERSAL_TARGET_TEXT[row.reversalTarget]}`
                            : ""}
                        </p>
                      ) : null}
                      {row.blocked ? (
                        <ul className="mt-1 flex flex-col gap-1">
                          {row.blockingReasons.map((reason) => (
                            <li
                              key={reason}
                              className="text-xs leading-5 text-[var(--dz-danger,#b3261e)]"
                            >
                              {(BLOCKING_REASON_TEXT as Record<string, string>)[reason] ??
                                reason}
                            </li>
                          ))}
                        </ul>
                      ) : null}

                      {/* The choices the SERVER permits. Nothing else exists. */}
                      {row.blocked ? (
                        <p className="mt-2 text-xs font-semibold text-[var(--dz-text-muted)]">
                          השורה תדולג. אי אפשר לקלוט אותה עד שהקובץ יתוקן.
                        </p>
                      ) : (
                        <>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {row.allowedDecisions.map((action) => (
                              <button
                                key={action}
                                type="button"
                                disabled={busy !== null}
                                onClick={() =>
                                  setOverrides((prev) => ({
                                    ...prev,
                                    [row.sourceRowNumber]: action,
                                  }))
                                }
                                className={`min-h-[44px] rounded-full border px-4 text-xs font-semibold transition disabled:opacity-60 ${
                                  chosen === action
                                    ? "border-[var(--dz-accent)] text-[var(--dz-accent)]"
                                    : "border-[var(--dz-border-subtle)] text-[var(--dz-text-primary)] hover:bg-[var(--dz-surface-muted)]"
                                }`}
                              >
                                {ACTION_BUTTON[action]}
                              </button>
                            ))}
                          </div>
                          <p className="mt-2 text-xs leading-5 text-[var(--dz-text-muted)]">
                            {ACTION_HELP[chosen]}
                          </p>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : null}

            {preview.rowsTruncated || awaitingOffscreen > 0 ? (
              <p className="mt-3 text-xs leading-5 text-[var(--dz-text-muted)]">
                מוצגות השורות הראשונות שדורשות תשומת לב. המספרים למעלה מתייחסים
                לכל הקובץ.
              </p>
            ) : null}

            {/* Why it cannot run yet — always the server's reasons, never ours. */}
            {!preview.readyForExecute ? (
              <ul className="mt-4 flex flex-col gap-1 rounded-2xl bg-[var(--dz-background)] px-4 py-3">
                {preview.notReadyReasons.map((reason) => (
                  <li
                    key={reason}
                    className="text-xs leading-5 text-[var(--dz-text-primary)]"
                  >
                    {NOT_READY_TEXT[reason] ?? reason}
                  </li>
                ))}
              </ul>
            ) : null}

            {decisionsPending ? (
              <button
                type="button"
                onClick={() =>
                  void runPreview({ ...preview.decisions, ...overrides })
                }
                disabled={busy !== null}
                className="mt-4 min-h-[44px] w-full rounded-2xl border border-[var(--dz-accent)] px-4 text-sm font-bold text-[var(--dz-accent)] transition disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy === "previewing"
                  ? "מעדכן תצוגה מקדימה…"
                  : "עדכנו את התצוגה המקדימה לפי הבחירות"}
              </button>
            ) : null}

            <button
              type="button"
              onClick={runImport}
              disabled={
                busy !== null ||
                decisionsPending ||
                !preview.readyForExecute ||
                willCreate === 0
              }
              className="mt-3 min-h-[44px] w-full rounded-2xl bg-[var(--dz-accent)] px-4 text-sm font-bold text-white transition disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === "importing"
                ? "קולט…"
                : willCreate === 0
                  ? "אין שורות לקליטה"
                  : `אשרו וקלטו ${count(willCreate)} מסמכים היסטוריים`}
            </button>
            <p className="mt-2 text-center text-[11px] leading-4 text-[var(--dz-text-muted)]">
              הקליטה שומרת את המסמכים כהיסטוריה בלבד. לא יופק מסמך חדש, לא יוקצה
              מספר ולא ידווח דבר.
            </p>
          </SettingsSection>
        </div>
      ) : null}

      {/* 7 — what actually happened */}
      {result ? (
        <div className="mt-4">
          <SettingsSection title="הקליטה הסתיימה">
            <dl className="grid grid-cols-3 gap-2">
              {(
                [
                  ["נשמרו", result.totals.created],
                  ["דולגו", result.totals.skipped],
                  ["נכשלו", result.totals.failed],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="rounded-2xl bg-[var(--dz-background)] px-3 py-2">
                  <dt className="text-[11px] text-[var(--dz-text-muted)]">{label}</dt>
                  <dd className="text-lg font-bold text-[var(--dz-text-primary)]">
                    {count(value)}
                  </dd>
                </div>
              ))}
            </dl>

            {result.replayed ? (
              <p className="mt-3 text-xs leading-5 text-[var(--dz-text-muted)]">
                הקובץ הזה כבר נקלט קודם עם אותן בחירות, ולכן שום דבר לא נשמר
                פעם שנייה. אלה התוצאות מאותה קליטה.
              </p>
            ) : null}

            {result.totals.alreadyExecuted > 0 && !result.replayed ? (
              <p className="mt-3 text-xs leading-5 text-[var(--dz-text-muted)]">
                {count(result.totals.alreadyExecuted)} שורות כבר היו שמורות
                מהרצה קודמת של אותו קובץ, ולא נשמרו שוב.
              </p>
            ) : null}

            {result.status === "PARTIAL" ? (
              <p className="mt-3 text-xs leading-5 text-[var(--dz-text-primary)]">
                חלק מהשורות לא הספיקו לרוץ. הריצו את אותו קובץ שוב כדי להשלים
                אותן — מה שכבר נשמר לא יישמר פעם שנייה.
              </p>
            ) : null}

            {result.rows.filter((r) => r.result === "ROW_PERSISTENCE_FAILED" || r.result === "DUPLICATE_CHANGED" || r.result === "REVERSAL_CHANGED").length > 0 ? (
              <ul className="mt-3 flex flex-col divide-y divide-[var(--dz-border-subtle)]">
                {result.rows
                  .filter(
                    (r) =>
                      r.result === "ROW_PERSISTENCE_FAILED" ||
                      r.result === "DUPLICATE_CHANGED" ||
                      r.result === "REVERSAL_CHANGED"
                  )
                  .slice(0, ROW_WINDOW)
                  .map((r) => (
                    <li key={r.sourceRowNumber} className="py-2">
                      <span className="text-xs font-bold text-[var(--dz-text-primary)]">
                        שורה {r.sourceRowNumber}
                      </span>
                      <span className="mr-2 text-xs text-[var(--dz-text-muted)]">
                        {ROW_RESULT_TEXT[r.result]}
                      </span>
                    </li>
                  ))}
              </ul>
            ) : null}

            <Link
              href={recordsHref}
              className="mt-4 flex min-h-[44px] w-full items-center justify-center rounded-2xl bg-[var(--dz-accent)] px-4 text-sm font-bold text-white transition"
            >
              לצפייה במסמכים ההיסטוריים
            </Link>
          </SettingsSection>
        </div>
      ) : null}

      {/* Recovery. A meaningful server condition never becomes "אירעה שגיאה". */}
      <div aria-live="polite" className="mt-3 min-h-[1.25rem]">
        {notice ? (
          <p className="text-xs font-semibold text-[var(--dz-text-primary)]">{notice}</p>
        ) : null}
        {failure ? (
          <div className="rounded-2xl bg-[var(--dz-background)] px-4 py-3">
            <p className="text-xs font-semibold leading-5 text-[var(--dz-danger,#b3261e)]">
              {failure.message}
            </p>
            {failure.code === "TOKEN_EXPIRED" ||
            failure.code === "ANALYSIS_STALE" ||
            failure.code === "PREVIEW_STALE" ||
            failure.code === "DECISION_CHANGED" ||
            failure.code === "TOKEN_MISMATCH" ||
            failure.code === "TOKEN_INVALID" ? (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => {
                  setPreview(null);
                  setOverrides({});
                  void runAnalyze({ mapping });
                }}
                className="mt-2 min-h-[44px] rounded-full border border-[var(--dz-border-subtle)] px-4 text-xs font-semibold text-[var(--dz-text-primary)] transition hover:bg-[var(--dz-surface-muted)] disabled:opacity-60"
              >
                בדקו את הקובץ מחדש
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  );
}

/* ------------------------------------------------------------ row cards -- */

function valueOf(row: AnalyzedRow, field: string): string | null {
  const found = row.values.find((v) => v.field === field);
  return found?.normalized ?? (found?.original || null);
}

/** The line that identifies a row: what it is, its number, its date and total. */
function RowHeading({
  row,
  headers,
  badge,
}: {
  row: AnalyzedRow;
  headers: HistoricalHeaderMap;
  badge: string;
}) {
  const type = valueOf(row, headers.documentTypeCode);
  const number = valueOf(row, headers.originalDocumentNumber);
  const date = valueOf(row, headers.originalIssueDate);
  const total = valueOf(row, headers.totalAmount);

  return (
    <>
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 break-words text-sm font-bold text-[var(--dz-text-primary)]">
          שורה {row.sourceRowNumber}
          {type ? ` · ${documentTypeLabel(type)}` : ""}
        </span>
        <span className="shrink-0 rounded-full bg-[var(--dz-surface-muted)] px-2 py-0.5 text-[11px] font-semibold text-[var(--dz-text-muted)]">
          {badge}
        </span>
      </div>
      {number || date || total ? (
        <p className="mt-1 break-words text-xs text-[var(--dz-text-muted)]">
          {[number, date, total].filter(Boolean).join(" · ")}
        </p>
      ) : null}
    </>
  );
}

function RowCard({
  row,
  headers,
}: {
  row: AnalyzedRow;
  headers: HistoricalHeaderMap;
}) {
  return (
    <li className="py-3">
      <RowHeading row={row} headers={headers} badge={ROW_STATE_LABEL[row.state]} />

      {row.errors.map((issue, i) => (
        <p
          key={`e${i}`}
          className="mt-1 break-words text-xs leading-5 text-[var(--dz-danger,#b3261e)]"
        >
          {issue.field}: {issueText(issue)}
        </p>
      ))}
      {row.warnings.map((issue, i) => (
        <p
          key={`w${i}`}
          className="mt-1 break-words text-xs leading-5 text-[var(--dz-text-muted)]"
        >
          {issue.field}: {issueText(issue)}
        </p>
      ))}
      {/* A resolved credit raises neither an error nor a warning, so without
          this line the owner would never learn that the link WAS made. Every
          unresolved state already appears above as its own issue. */}
      {row.reversal.state === "RESOLVED_EXISTING" ||
      row.reversal.state === "RESOLVED_IN_FILE" ? (
        <p className="mt-1 text-xs leading-5 text-[var(--dz-text-muted)]">
          {REVERSAL_TEXT[row.reversal.state]}
          {row.reversal.state === "RESOLVED_IN_FILE" &&
          row.reversal.targetSourceRow !== null
            ? ` (שורה ${row.reversal.targetSourceRow})`
            : ""}
        </p>
      ) : null}
    </li>
  );
}
