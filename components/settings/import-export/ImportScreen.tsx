"use client";

import { useRef, useState } from "react";
import { SettingsSection } from "@/components/settings/SettingsSection";

/**
 * הגדרות → ייבוא וייצוא → ייבוא — the dry run.
 *
 * # The promise this screen makes, and keeps
 *
 * Nothing is saved. It is the first line on the page, it is repeated on the
 * result, and it is true: there is no endpoint behind this screen that writes.
 * The flow ends at "the file was checked" — no confirm button that pretends
 * otherwise, because a button that looks like it imports and does not is worse
 * than no button.
 *
 * # Four steps, one at a time
 *
 *   1  which area
 *   2  which file  (and which sheet, only if the file is ambiguous)
 *   3  which column is what
 *   4  what would happen
 *
 * The file is held in component state and re-sent for the preview call. That is
 * the deliberate consequence of keeping no server-side state between the two
 * requests — nothing stored, nothing to expire, nothing to leak.
 */

export type ImportDomainOption = {
  id: string;
  title: string;
  description: string;
  icon: string;
};

type Proposal = {
  sourceIndex: number;
  sourceHeader: string;
  field: string | null;
  status: "EXACT" | "SUGGESTED" | "AMBIGUOUS" | "UNMAPPED";
  candidates: string[];
  samples: string[];
};

type FieldOption = { field: string; required: boolean; help: string | null };

type Analysis = {
  sheetName: string | null;
  availableSheets: string[];
  headers: string[];
  rowCount: number;
  proposals: Proposal[];
  requiredFields: string[];
  importableFields: FieldOption[];
};

type DuplicateEvidence = {
  scope: "IN_FILE" | "EXISTING";
  field: string;
  strength: "STRONG" | "WEAK";
  value: string;
  otherRows?: number[];
  existingLabel?: string;
  existingNote?: string;
};

type PreviewRow = {
  rowNumber: number;
  status: "READY" | "WARNING" | "ERROR";
  errors: { field: string; reason: string; original: string }[];
  changes: { field: string; original: string; normalized: string }[];
  duplicates: DuplicateEvidence[];
};

type RowAction = "CREATE" | "SKIP";

type Preview = {
  summary: {
    totalRows: number;
    ready: number;
    warning: number;
    error: number;
    withDuplicates: number;
  };
  rows: PreviewRow[];
  rowsTruncated: boolean;
  /** The server's action for EVERY row, defaults included. */
  decisions: Record<number, RowAction>;
  /** Rows the owner may deliberately switch to "import anyway". */
  overridableRows: number[];
  /** Leads only: records other than the leads that confirming will create. */
  sideEffects?: { reusedCustomers: number; newCustomers: number };
  previewToken: string;
};

type ExecuteResult = {
  importRunId: number;
  status: "COMPLETED" | "PARTIAL" | "FAILED" | "EXECUTING";
  alreadyExecuted: boolean;
  unexecutedRows: number;
  counts: {
    totalRows: number;
    createdCount: number;
    skippedCount: number;
    failedCount: number;
  };
  failures: { rowNumber: number; code: string; message: string }[];
};

type Busy = null | "analyzing" | "previewing" | "importing";

const DONT_IMPORT = "__skip__";

/** Owner-facing wording for a mapping outcome. No jargon. */
const STATUS_LABEL: Record<Proposal["status"], string> = {
  EXACT: "זוהה",
  SUGGESTED: "הצעה",
  AMBIGUOUS: "צריך בחירה",
  UNMAPPED: "לא זוהה",
};

const ROW_STATUS_LABEL: Record<PreviewRow["status"], string> = {
  READY: "מוכן",
  WARNING: "לבדיקה",
  ERROR: "שגיאה",
};

function authHeader(): Record<string, string> | null {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;
  return token?.trim() ? { Authorization: `Bearer ${token.trim()}` } : null;
}

export function ImportScreen({ domains }: { domains: readonly ImportDomainOption[] }) {
  const fileInput = useRef<HTMLInputElement>(null);

  const [domainId, setDomainId] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  const [sheetChoices, setSheetChoices] = useState<string[]>([]);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [mapping, setMapping] = useState<Record<number, string>>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [issuesOnly, setIssuesOnly] = useState(true);
  // The owner's overrides ONLY. Everything else keeps the server's default, so
  // a row the owner never touched cannot drift when the file is re-derived.
  const [overrides, setOverrides] = useState<Record<number, RowAction>>({});
  const [result, setResult] = useState<ExecuteResult | null>(null);

  function resetFrom(step: "domain" | "file") {
    setPreview(null);
    setError(null);
    if (step === "domain") {
      setFile(null);
      setSheet(null);
      setSheetChoices([]);
      setAnalysis(null);
      setMapping({});
    }
  }

  async function runAnalyze(chosenSheet: string | null, chosenFile: File | null) {
    const target = chosenFile ?? file;
    if (!domainId || !target) return;
    const auth = authHeader();
    if (!auth) {
      setError("חסר אסימון התחברות — התחברו מחדש ונסו שוב.");
      return;
    }

    setBusy("analyzing");
    setError(null);
    setPreview(null);
    try {
      const body = new FormData();
      body.append("domain", domainId);
      body.append("file", target);
      if (chosenSheet) body.append("sheet", chosenSheet);

      const response = await fetch("/api/data-transfer/import/analyze", {
        method: "POST",
        headers: auth,
        body,
      });
      const data = await response.json().catch(() => null);

      if (!response.ok || !data?.ok) {
        if (data?.code === "SHEET_CHOICE_REQUIRED") {
          setSheetChoices(data.availableSheets ?? []);
          setAnalysis(null);
          setError(data.message ?? "בחרו גיליון");
          return;
        }
        setError(data?.message ?? data?.error ?? `הניתוח נכשל (${response.status}).`);
        setAnalysis(null);
        return;
      }

      setSheetChoices(data.availableSheets ?? []);
      setSheet(data.sheetName ?? null);
      setAnalysis(data as Analysis);

      // Seed the mapping from the proposals. Anything the server was not sure
      // about starts UNSET, so an uncertain guess can never slip through
      // unnoticed — the owner has to choose it.
      const seeded: Record<number, string> = {};
      for (const p of (data as Analysis).proposals) {
        if (p.field && (p.status === "EXACT" || p.status === "SUGGESTED")) {
          seeded[p.sourceIndex] = p.field;
        }
      }
      setMapping(seeded);
    } catch {
      setError("שגיאת רשת — בדקו את החיבור ונסו שוב.");
    } finally {
      setBusy(null);
    }
  }

  async function runPreview() {
    if (!domainId || !file || !analysis) return;
    const auth = authHeader();
    if (!auth) {
      setError("חסר אסימון התחברות — התחברו מחדש ונסו שוב.");
      return;
    }

    setBusy("previewing");
    setError(null);
    try {
      const body = new FormData();
      body.append("domain", domainId);
      body.append("file", file);
      if (sheet) body.append("sheet", sheet);
      body.append("mapping", JSON.stringify(mapping));

      const response = await fetch("/api/data-transfer/import/preview", {
        method: "POST",
        headers: auth,
        body,
      });
      const data = await response.json().catch(() => null);

      if (!response.ok || !data?.ok) {
        setError(data?.message ?? data?.error ?? `הבדיקה נכשלה (${response.status}).`);
        return;
      }
      setPreview(data as Preview);
      setOverrides({});
      setResult(null);
    } catch {
      setError("שגיאת רשת — בדקו את החיבור ונסו שוב.");
    } finally {
      setBusy(null);
    }
  }

  /**
   * Confirm and import.
   *
   * Two calls, deliberately. The preview is run AGAIN with the owner's choices
   * so the server re-derives every row from the same bytes, re-checks that each
   * choice is one it would actually offer, and mints a token bound to those
   * choices. Only then does execute run — so it can never be handed a decision
   * the owner never saw, nor the owner's decisions against a different file.
   */
  async function runImport() {
    if (!domainId || !file || !preview) return;
    const auth = authHeader();
    if (!auth) {
      setError("חסר אסימון התחברות — התחברו מחדש ונסו שוב.");
      return;
    }

    setBusy("importing");
    setError(null);
    try {
      const decisions = { ...preview.decisions, ...overrides };

      const bound = new FormData();
      bound.append("domain", domainId);
      bound.append("file", file);
      if (sheet) bound.append("sheet", sheet);
      bound.append("mapping", JSON.stringify(mapping));
      bound.append("decisions", JSON.stringify(decisions));

      const previewResponse = await fetch("/api/data-transfer/import/preview", {
        method: "POST",
        headers: auth,
        body: bound,
      });
      const previewData = await previewResponse.json().catch(() => null);
      if (!previewResponse.ok || !previewData?.ok) {
        setError(
          previewData?.message ??
            previewData?.error ??
            `הבדיקה נכשלה (${previewResponse.status}).`
        );
        return;
      }
      setPreview(previewData as Preview);

      const body = new FormData();
      body.append("domain", domainId);
      body.append("file", file);
      if (sheet) body.append("sheet", sheet);
      body.append("mapping", JSON.stringify(mapping));
      body.append("decisions", JSON.stringify(previewData.decisions));
      body.append("previewToken", previewData.previewToken);

      const response = await fetch("/api/data-transfer/import/execute", {
        method: "POST",
        headers: auth,
        body,
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) {
        setError(data?.message ?? data?.error ?? `הייבוא נכשל (${response.status}).`);
        return;
      }
      setResult(data as ExecuteResult);
    } catch {
      // A network failure here is genuinely ambiguous: the import may have run.
      // Say so, and say what to do — repeating the same file is safe.
      setError(
        "החיבור נקטע. ייתכן שהייבוא הושלם — הריצו את אותו קובץ שוב, ודוביז תשלים רק את מה שחסר."
      );
    } finally {
      setBusy(null);
    }
  }

  const missingRequired = (analysis?.requiredFields ?? []).filter(
    (f) => !Object.values(mapping).includes(f)
  );
  const duplicateTargets = Object.values(mapping).filter(
    (f, i, all) => all.indexOf(f) !== i
  );
  const canPreview =
    !!analysis && missingRequired.length === 0 && duplicateTargets.length === 0;

  const visibleRows = preview
    ? issuesOnly
      ? preview.rows.filter((r) => r.status !== "READY")
      : preview.rows
    : [];

  /** The owner's choice for a row, falling back to the server's default. */
  function decisionFor(rowNumber: number): RowAction {
    return overrides[rowNumber] ?? preview?.decisions[rowNumber] ?? "SKIP";
  }

  /** Why this row is not being imported, in the owner's words. */
  function reasonFor(row: PreviewRow): string {
    if (row.status === "ERROR") {
      return row.errors[0]
        ? `${row.errors[0].field}: ${row.errors[0].reason}`
        : "השורה אינה תקינה";
    }
    const evidence = row.duplicates[0];
    if (!evidence) return "לא נבחרה לייבוא";
    return evidence.scope === "IN_FILE"
      ? `${evidence.field} חוזר גם בשורות ${(evidence.otherRows ?? []).join(", ")} — תיובא הראשונה בלבד`
      : (evidence.existingNote ?? `${evidence.field} כבר קיים`);
  }

  // Counted over the FULL decision set, not the displayed window, so the number
  // on the button is the number of records that will actually be created.
  const allDecisions = preview
    ? { ...preview.decisions, ...overrides }
    : ({} as Record<number, RowAction>);
  const createCount = Object.values(allDecisions).filter(
    (a) => a === "CREATE"
  ).length;
  const skipCount = Object.values(allDecisions).filter(
    (a) => a === "SKIP"
  ).length;

  // The rows worth showing a control for: the ones being skipped. The preview
  // window is already bounded server-side, so this is bounded too.
  const skippedRows = preview
    ? preview.rows.filter((r) => decisionFor(r.rowNumber) === "SKIP")
    : [];
  const skippedRowsTruncated = !!preview && preview.rowsTruncated && skipCount > skippedRows.length;

  return (
    <>
      {/* The promise, before anything else on the page. */}
      <SettingsSection>
        <p className="text-sm font-bold text-[var(--dz-text-primary)]">
          שום מידע לא נשמר עד שתאשרו.
        </p>
        <p className="mt-2 text-xs leading-5 text-[var(--dz-text-muted)]">
          העלו קובץ ונראה לכם בדיוק מה דוביז הבינה ממנו: אילו עמודות זוהו, מה
          תקין, מה דורש תיקון ומה כבר קיים אצלכם. רק אחרי שתראו את הכול ותאשרו,
          הנתונים ייקלטו.
        </p>
      </SettingsSection>

      {/* 1 — area */}
      <div className="mt-4">
        <SettingsSection title="מה תרצו לייבא">
          <ul className="flex flex-col divide-y divide-[var(--dz-border-subtle)]">
            {domains.map((d) => (
              <li key={d.id}>
                <label className="flex w-full cursor-pointer items-start gap-3 rounded-2xl px-2 py-3 text-right transition hover:bg-[var(--dz-surface-muted)]">
                  <input
                    type="radio"
                    name="import-domain"
                    checked={domainId === d.id}
                    onChange={() => {
                      setDomainId(d.id);
                      resetFrom("domain");
                    }}
                    className="mt-1.5 h-5 w-5 shrink-0 accent-[var(--dz-accent)]"
                  />
                  <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[var(--dz-background)] text-lg">
                    {d.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-bold text-[var(--dz-text-primary)]">
                      {d.title}
                    </span>
                    <span className="mt-1 block text-xs leading-5 text-[var(--dz-text-muted)]">
                      {d.description}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </SettingsSection>
      </div>

      {/* 2 — file */}
      {domainId ? (
        <div className="mt-4">
          <SettingsSection
            title="העלו את הקובץ"
            description="Excel או CSV, עד 10MB ועד 10,000 שורות."
          >
            <input
              ref={fileInput}
              type="file"
              accept=".xlsx,.csv"
              className="sr-only"
              onChange={(e) => {
                const next = e.target.files?.[0] ?? null;
                resetFrom("file");
                setAnalysis(null);
                setMapping({});
                setSheet(null);
                setSheetChoices([]);
                setFile(next);
                if (next) void runAnalyze(null, next);
              }}
            />
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={busy !== null}
              className="w-full rounded-2xl border border-dashed border-[var(--dz-border-subtle)] px-4 py-6 text-sm font-semibold text-[var(--dz-text-primary)] transition hover:bg-[var(--dz-surface-muted)] disabled:opacity-60"
            >
              {file ? file.name : "בחרו קובץ"}
            </button>

            {busy === "analyzing" ? (
              <p className="mt-3 text-xs text-[var(--dz-text-muted)]">
                קורא את הקובץ…
              </p>
            ) : null}

            {sheetChoices.length > 1 ? (
              <div className="mt-4">
                <p className="text-xs font-semibold text-[var(--dz-text-primary)]">
                  בקובץ יש כמה גיליונות. איזה מהם לייבא?
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {sheetChoices.map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => {
                        setSheet(name);
                        void runAnalyze(name, file);
                      }}
                      className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
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
      ) : null}

      {/* 3 — mapping */}
      {analysis ? (
        <div className="mt-4">
          <SettingsSection
            title="התאמת עמודות"
            description={`נמצאו ${analysis.rowCount.toLocaleString("he-IL")} שורות. בדקו שכל עמודה הובנה נכון.`}
          >
            <ul className="flex flex-col divide-y divide-[var(--dz-border-subtle)]">
              {analysis.proposals.map((p) => (
                <li key={p.sourceIndex} className="py-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-bold text-[var(--dz-text-primary)]">
                      {p.sourceHeader || "(עמודה ללא שם)"}
                    </span>
                    <span className="shrink-0 rounded-full bg-[var(--dz-surface-muted)] px-2 py-0.5 text-[11px] font-semibold text-[var(--dz-text-muted)]">
                      {STATUS_LABEL[p.status]}
                    </span>
                  </div>

                  {p.samples.length > 0 ? (
                    <p className="mt-1 truncate text-xs text-[var(--dz-text-muted)]">
                      לדוגמה: {p.samples.join(" · ")}
                    </p>
                  ) : null}

                  <select
                    value={mapping[p.sourceIndex] ?? DONT_IMPORT}
                    onChange={(e) => {
                      const next = { ...mapping };
                      if (e.target.value === DONT_IMPORT) delete next[p.sourceIndex];
                      else next[p.sourceIndex] = e.target.value;
                      setMapping(next);
                      setPreview(null);
                    }}
                    className="mt-2 w-full rounded-xl border border-[var(--dz-border-subtle)] bg-[var(--dz-background)] px-3 py-2 text-sm text-[var(--dz-text-primary)]"
                  >
                    <option value={DONT_IMPORT}>אל תייבא עמודה זו</option>
                    {analysis.importableFields.map((f) => (
                      <option key={f.field} value={f.field}>
                        {f.field}
                        {f.required ? " (חובה)" : ""}
                      </option>
                    ))}
                  </select>
                </li>
              ))}
            </ul>

            {missingRequired.length > 0 ? (
              <p className="mt-3 text-xs font-semibold text-[var(--dz-danger,#b3261e)]">
                חסרות עמודות חובה: {missingRequired.join(", ")}
              </p>
            ) : null}
            {duplicateTargets.length > 0 ? (
              <p className="mt-3 text-xs font-semibold text-[var(--dz-danger,#b3261e)]">
                שתי עמודות הותאמו לאותו שדה: {[...new Set(duplicateTargets)].join(", ")}
              </p>
            ) : null}

            <button
              type="button"
              onClick={runPreview}
              disabled={!canPreview || busy !== null}
              className="mt-4 w-full rounded-2xl bg-[var(--dz-accent)] px-4 py-3 text-sm font-bold text-white transition disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === "previewing" ? "בודק את הקובץ…" : "בדקו את הקובץ"}
            </button>
          </SettingsSection>
        </div>
      ) : null}

      {/* 4 — result */}
      {preview ? (
        <div className="mt-4">
          <SettingsSection title="תוצאות הבדיקה">
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                ["סה״כ שורות", preview.summary.totalRows],
                ["מוכנות", preview.summary.ready],
                ["לבדיקה", preview.summary.warning],
                ["שגיאות", preview.summary.error],
              ].map(([label, value]) => (
                <div
                  key={String(label)}
                  className="rounded-2xl bg-[var(--dz-background)] px-3 py-2"
                >
                  <dt className="text-[11px] text-[var(--dz-text-muted)]">{label}</dt>
                  <dd className="text-lg font-bold text-[var(--dz-text-primary)]">
                    {Number(value).toLocaleString("he-IL")}
                  </dd>
                </div>
              ))}
            </dl>

            {preview.summary.withDuplicates > 0 ? (
              <p className="mt-3 text-xs text-[var(--dz-text-muted)]">
                {preview.summary.withDuplicates.toLocaleString("he-IL")} שורות עשויות
                להיות כפילות.
              </p>
            ) : null}

            <div className="mt-4 flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-[var(--dz-text-primary)]">
                {issuesOnly ? "מוצגות שורות שדורשות תשומת לב" : "מוצגות כל השורות"}
              </span>
              <button
                type="button"
                onClick={() => setIssuesOnly((v) => !v)}
                className="rounded-full border border-[var(--dz-border-subtle)] px-3 py-1.5 text-xs font-semibold text-[var(--dz-text-primary)] transition hover:bg-[var(--dz-surface-muted)]"
              >
                {issuesOnly ? "הצג הכול" : "רק בעיות"}
              </button>
            </div>

            <ul className="mt-2 flex flex-col divide-y divide-[var(--dz-border-subtle)]">
              {visibleRows.map((row) => (
                <li key={row.rowNumber} className="py-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-bold text-[var(--dz-text-primary)]">
                      שורה {row.rowNumber}
                    </span>
                    <span className="shrink-0 rounded-full bg-[var(--dz-surface-muted)] px-2 py-0.5 text-[11px] font-semibold text-[var(--dz-text-muted)]">
                      {ROW_STATUS_LABEL[row.status]}
                    </span>
                  </div>
                  {row.errors.map((e, i) => (
                    <p
                      key={i}
                      className="mt-1 text-xs text-[var(--dz-danger,#b3261e)]"
                    >
                      {e.field}: {e.reason}
                    </p>
                  ))}
                  {row.duplicates.map((d, i) => (
                    <p key={`d${i}`} className="mt-1 text-xs text-[var(--dz-text-muted)]">
                      {d.scope === "IN_FILE"
                        ? `${d.field} חוזר גם בשורות ${(d.otherRows ?? []).join(", ")}`
                        : `${d.existingNote ?? "כבר קיים"}${d.existingLabel ? ` — ${d.existingLabel}` : ""}`}
                    </p>
                  ))}
                  {row.changes.map((c, i) => (
                    <p key={`c${i}`} className="mt-1 text-xs text-[var(--dz-text-muted)]">
                      {c.field}: {c.original} ← ייקלט כ־{c.normalized}
                    </p>
                  ))}
                </li>
              ))}
            </ul>

            {preview.rowsTruncated ? (
              <p className="mt-3 text-xs text-[var(--dz-text-muted)]">
                מוצגות השורות הראשונות. הסיכום למעלה מתייחס לכל הקובץ.
              </p>
            ) : null}

            {result ? null : (
              <div className="mt-4 rounded-2xl bg-[var(--dz-background)] px-4 py-3">
                <p className="text-sm font-bold text-[var(--dz-text-primary)]">
                  בדיקת הקובץ הושלמה.
                </p>
                <p className="mt-1 text-xs leading-5 text-[var(--dz-text-muted)]">
                  עדיין לא נשמר כלום. בחרו למטה מה לייבא ואשרו.
                </p>
              </div>
            )}
          </SettingsSection>
        </div>
      ) : null}

      {/* 5 — decide and confirm */}
      {preview && !result ? (
        <div className="mt-4">
          <SettingsSection
            title="מה לייבא"
            description="דוביז בחרה עבורכם ברירת מחדל לכל שורה. אפשר לשנות."
          >
            <dl className="grid grid-cols-2 gap-2">
              <div className="rounded-2xl bg-[var(--dz-background)] px-3 py-2">
                <dt className="text-[11px] text-[var(--dz-text-muted)]">ייווצרו</dt>
                <dd className="text-lg font-bold text-[var(--dz-text-primary)]">
                  {createCount.toLocaleString("he-IL")}
                </dd>
              </div>
              <div className="rounded-2xl bg-[var(--dz-background)] px-3 py-2">
                <dt className="text-[11px] text-[var(--dz-text-muted)]">ידולגו</dt>
                <dd className="text-lg font-bold text-[var(--dz-text-primary)]">
                  {skipCount.toLocaleString("he-IL")}
                </dd>
              </div>
            </dl>

            {/* Leads create a customer per lead. The owner is approving that
                too, so it is said before the button, not discovered after. */}
            {preview.sideEffects && preview.sideEffects.newCustomers > 0 ? (
              <p className="mt-3 rounded-2xl bg-[var(--dz-background)] px-4 py-3 text-xs leading-5 text-[var(--dz-text-muted)]">
                לכל ליד נוצר גם כרטיס לקוח.{" "}
                {preview.sideEffects.newCustomers.toLocaleString("he-IL")} כרטיסי
                לקוח חדשים ייווצרו
                {preview.sideEffects.reusedCustomers > 0
                  ? ", וחלק מהלידים ישויכו ללקוחות שכבר קיימים אצלכם"
                  : ""}
                .
              </p>
            ) : null}

            {skippedRows.length > 0 ? (
              <ul className="mt-3 flex flex-col divide-y divide-[var(--dz-border-subtle)]">
                {skippedRows.map((row) => {
                  const canImport = preview.overridableRows.includes(row.rowNumber);
                  const action = decisionFor(row.rowNumber);
                  return (
                    <li key={row.rowNumber} className="py-3">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-sm font-bold text-[var(--dz-text-primary)]">
                          שורה {row.rowNumber}
                        </span>
                        <span className="shrink-0 rounded-full bg-[var(--dz-surface-muted)] px-2 py-0.5 text-[11px] font-semibold text-[var(--dz-text-muted)]">
                          {action === "CREATE" ? "ייווצר" : "ידולג"}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-[var(--dz-text-muted)]">
                        {reasonFor(row)}
                      </p>
                      {canImport ? (
                        <button
                          type="button"
                          onClick={() =>
                            setOverrides((prev) => ({
                              ...prev,
                              [row.rowNumber]:
                                action === "CREATE" ? "SKIP" : "CREATE",
                            }))
                          }
                          className="mt-2 rounded-full border border-[var(--dz-border-subtle)] px-3 py-1.5 text-xs font-semibold text-[var(--dz-text-primary)] transition hover:bg-[var(--dz-surface-muted)]"
                        >
                          {action === "CREATE" ? "בכל זאת לדלג" : "לייבא בכל זאת"}
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}

            {skippedRowsTruncated ? (
              <p className="mt-3 text-xs text-[var(--dz-text-muted)]">
                מוצגות השורות הראשונות שידולגו. הסיכום למעלה מתייחס לכל הקובץ.
              </p>
            ) : null}

            <button
              type="button"
              onClick={runImport}
              disabled={busy !== null || createCount === 0}
              className="mt-4 w-full rounded-2xl bg-[var(--dz-accent)] px-4 py-3 text-sm font-bold text-white transition disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === "importing"
                ? "מייבא…"
                : createCount === 0
                  ? "אין שורות לייבוא"
                  : "אשרו וייבאו " + createCount.toLocaleString("he-IL") + " שורות"}
            </button>
            <p className="mt-2 text-center text-[11px] text-[var(--dz-text-muted)]">
              אם הייבוא ייקטע — הריצו את אותו קובץ שוב. דוביז תשלים רק את מה
              שחסר.
            </p>
          </SettingsSection>
        </div>
      ) : null}

      {/* 6 — what actually happened */}
      {result ? (
        <div className="mt-4">
          <SettingsSection title="הייבוא הסתיים">
            <dl className="grid grid-cols-3 gap-2">
              {[
                ["נוצרו", result.counts.createdCount],
                ["דולגו", result.counts.skippedCount],
                ["נכשלו", result.counts.failedCount],
              ].map(([label, value]) => (
                <div
                  key={String(label)}
                  className="rounded-2xl bg-[var(--dz-background)] px-3 py-2"
                >
                  <dt className="text-[11px] text-[var(--dz-text-muted)]">{label}</dt>
                  <dd className="text-lg font-bold text-[var(--dz-text-primary)]">
                    {Number(value).toLocaleString("he-IL")}
                  </dd>
                </div>
              ))}
            </dl>

            {result.alreadyExecuted ? (
              <p className="mt-3 text-xs leading-5 text-[var(--dz-text-muted)]">
                הקובץ הזה כבר יובא קודם עם אותן בחירות, ולכן שום דבר לא נוצר
                שוב. אלה התוצאות מאותה הרצה.
              </p>
            ) : null}

            {result.unexecutedRows > 0 ? (
              <p className="mt-3 text-xs leading-5 text-[var(--dz-text-primary)]">
                {result.unexecutedRows.toLocaleString("he-IL")} שורות לא הספיקו
                לרוץ. הריצו את אותו קובץ שוב כדי להשלים אותן — מה שכבר נוצר לא
                ייווצר שוב.
              </p>
            ) : null}

            {result.failures.length > 0 ? (
              <ul className="mt-3 flex flex-col divide-y divide-[var(--dz-border-subtle)]">
                {result.failures.map((f) => (
                  <li key={f.rowNumber} className="py-2">
                    <span className="text-xs font-bold text-[var(--dz-text-primary)]">
                      שורה {f.rowNumber}
                    </span>
                    <span className="mr-2 text-xs text-[var(--dz-text-muted)]">
                      {f.message}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </SettingsSection>
        </div>
      ) : null}

      <div aria-live="polite" className="mt-3 min-h-[1.25rem]">
        {error ? (
          <p className="text-xs font-semibold text-[var(--dz-danger,#b3261e)]">
            {error}
          </p>
        ) : null}
      </div>
    </>
  );
}
