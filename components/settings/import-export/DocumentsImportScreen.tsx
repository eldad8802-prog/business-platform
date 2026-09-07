"use client";

import { useMemo, useRef, useState } from "react";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { DocumentsExportPanel } from "@/components/settings/import-export/DocumentsExportPanel";

/**
 * הגדרות → ייבוא וייצוא → ייבוא מסמכים.
 *
 * Three states, and the boundary between them is the point of the screen:
 *
 *   check    files are read and triaged. NOTHING is saved.
 *   confirm  the owner is told exactly what is about to happen, and says yes.
 *   result   what actually happened, per file.
 *
 * # Why confirmation is its own step
 *
 * Taking documents in is not reversible from this screen, and one of the
 * choices on offer is "add it even though you already have it". A single button
 * that both reviewed and ingested would make that choice easy to make by
 * accident. So the check screen has no control that writes, and the confirm
 * screen restates the counts and every deliberate override before it offers
 * one.
 *
 * # Double submission
 *
 * The confirm button disables itself while a request is in flight. That is a
 * courtesy, not the protection: the server resolves a repeated request to the
 * same execution run and ingests nothing twice, which is what actually holds
 * when the courtesy fails — a lost response, a refresh, an impatient retry.
 *
 * # What it does NOT show, and why that is said out loud
 *
 * It does not show the supplier, amount or date inside a document. Reading a
 * document requires storing it first, so anything shown before the owner
 * confirms would be a guess. The copy says the identification happens after the
 * files are taken in, which is how the single-upload screen already behaves.
 */

type FileStatus = "NEW" | "DUPLICATE" | "IN_FILE_DUPLICATE" | "UNSUPPORTED";
type FileAction = "CREATE" | "CREATE_ANYWAY" | "SKIP";

type AnalyzedFile = {
  index: number;
  filename: string;
  sizeBytes: number;
  mimeType: string;
  status: FileStatus;
  action: FileAction;
  reason: string;
  overridable: boolean;
};

type AnalyzeResult = {
  summary: {
    total: number;
    willCreate: number;
    willSkip: number;
    unsupported: number;
    duplicates: number;
    inFileDuplicates: number;
    totalBytes: number;
  };
  files: AnalyzedFile[];
  decisions: Record<number, FileAction>;
  limits: { maxFiles: number; maxBatchBytes: number };
  previewToken: string;
  expiresAt: string;
};

type ResultRow = {
  position: number;
  filename: string;
  outcome: "CREATED" | "SKIPPED" | "FAILED";
  message: string;
};

type ExecuteResult = {
  status: "COMPLETED" | "PARTIAL" | "FAILED" | "EXECUTING";
  alreadyExecuted: boolean;
  unexecutedFiles: number;
  counts: {
    totalFiles: number;
    createdCount: number;
    skippedCount: number;
    failedCount: number;
  };
  files: ResultRow[];
};

/** Owner-facing wording. No file-format jargon, no hashes, no MIME. */
const STATUS_LABEL: Record<FileStatus, string> = {
  NEW: "חדש — יתווסף לאחר אישור",
  DUPLICATE: "כבר קיים בדוביז — ידולג",
  IN_FILE_DUPLICATE: "כפילות בתוך הקבצים שבחרת",
  UNSUPPORTED: "קובץ לא נתמך",
};

const OUTCOME_LABEL: Record<ResultRow["outcome"], string> = {
  CREATED: "נקלט",
  SKIPPED: "דולג",
  FAILED: "לא נקלט",
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} בייט`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function authHeader(): Record<string, string> | null {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;
  return token?.trim() ? { Authorization: `Bearer ${token.trim()}` } : null;
}

function isCreate(action: FileAction): boolean {
  return action === "CREATE" || action === "CREATE_ANYWAY";
}

export function DocumentsImportScreen() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [decisions, setDecisions] = useState<Record<number, FileAction>>({});
  const [stage, setStage] = useState<"check" | "confirm" | "done">("check");
  const [executed, setExecuted] = useState<ExecuteResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const overrides = useMemo(
    () =>
      (result?.files ?? []).filter(
        (f) => decisions[f.index] === "CREATE_ANYWAY"
      ),
    [result, decisions]
  );
  const willCreate = useMemo(
    () => Object.values(decisions).filter(isCreate).length,
    [decisions]
  );
  const willSkip = useMemo(
    () => Object.values(decisions).filter((a) => !isCreate(a)).length,
    [decisions]
  );

  function resetToCheck() {
    setStage("check");
    setExecuted(null);
    setError(null);
  }

  async function post(path: string, body: FormData) {
    const auth = authHeader();
    if (!auth) {
      setError("חסר אסימון התחברות — התחברו מחדש ונסו שוב.");
      return null;
    }
    const response = await fetch(path, { method: "POST", headers: auth, body });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) {
      setError(data?.error ?? `הפעולה נכשלה (${response.status}).`);
      return null;
    }
    return data;
  }

  /** Analyze the batch. Passing decisions re-binds the attestation to them. */
  async function runAnalyze(
    chosen: File[],
    withDecisions?: Record<number, FileAction>
  ): Promise<AnalyzeResult | null> {
    const body = new FormData();
    for (const f of chosen) body.append("files", f);
    if (withDecisions) body.append("decisions", JSON.stringify(withDecisions));
    const data = await post("/api/data-transfer/documents/analyze", body);
    if (!data) return null;
    const next = data as AnalyzeResult;
    setResult(next);
    setDecisions(next.decisions);
    return next;
  }

  async function onPick(chosen: File[]) {
    setBusy(true);
    setError(null);
    setResult(null);
    setExecuted(null);
    setStage("check");
    try {
      await runAnalyze(chosen);
    } catch {
      setError("שגיאת רשת — בדקו את החיבור ונסו שוב.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Move to confirmation, re-binding the attestation first if the owner changed
   * anything. The server refuses an attestation that does not match the
   * decisions being submitted, so this is not optional politeness.
   */
  async function onContinue() {
    if (!result) return;
    const changed = result.files.some(
      (f) => decisions[f.index] !== result.decisions[f.index]
    );
    if (!changed) {
      setStage("confirm");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const rebound = await runAnalyze(files, decisions);
      if (rebound) setStage("confirm");
    } catch {
      setError("שגיאת רשת — בדקו את החיבור ונסו שוב.");
    } finally {
      setBusy(false);
    }
  }

  async function onExecute() {
    if (!result || busy) return;
    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      for (const f of files) body.append("files", f);
      body.append("decisions", JSON.stringify(decisions));
      body.append("previewToken", result.previewToken);
      const data = await post("/api/data-transfer/documents/execute", body);
      if (data) {
        setExecuted(data as ExecuteResult);
        setStage("done");
      }
    } catch {
      // The request may well have succeeded. Say so rather than inviting a
      // blind retry — though a retry is safe, and the copy says that too.
      setError(
        "החיבור נקטע לפני שהתקבלה תשובה. אפשר ללחוץ שוב — קובץ שכבר נקלט לא ייקלט פעמיים."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SettingsSection>
        <p className="text-sm font-bold text-[var(--dz-text-primary)]">
          {stage === "check"
            ? "בדיקה בלבד — שום קובץ לא נשמר בשלב הזה."
            : stage === "confirm"
              ? "אישור אחרון לפני הקליטה."
              : "הקליטה הסתיימה."}
        </p>
        <p className="mt-2 text-xs leading-5 text-[var(--dz-text-muted)]">
          בחרו מסמכים ונראה לכם מה יקרה לכל אחד: מה יתווסף, מה כבר קיים אצלכם,
          ומה לא נתמך. את מה שכתוב בתוך המסמכים דוביז תזהה אחרי הקליטה, ותציג
          לאישורכם במסך המסמכים.
        </p>
      </SettingsSection>

      {stage === "check" ? (
        <div className="mt-4">
          <SettingsSection
            title="בחרו מסמכים"
            description="PDF או תמונה (JPG/PNG), עד 20 קבצים ועד 15MB לקובץ."
          >
            <input
              ref={inputRef}
              type="file"
              multiple
              accept="application/pdf,image/jpeg,image/png"
              className="hidden"
              onChange={(e) => {
                const chosen = Array.from(e.target.files ?? []);
                setFiles(chosen);
                if (chosen.length > 0) void onPick(chosen);
              }}
            />
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={busy}
              className="w-full rounded-2xl bg-[var(--dz-accent)] px-4 py-3 text-sm font-bold text-white transition disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "בודק את הקבצים…" : "בחרו קבצים"}
            </button>
            {files.length > 0 && !busy ? (
              <p className="mt-2 text-center text-[11px] text-[var(--dz-text-muted)]">
                נבחרו {files.length.toLocaleString("he-IL")} קבצים
              </p>
            ) : null}
          </SettingsSection>
        </div>
      ) : null}

      {stage === "check" && result ? (
        <div className="mt-4">
          <SettingsSection title="תוצאות הבדיקה">
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                ["סה״כ קבצים", result.summary.total],
                ["יתווספו", willCreate],
                ["ידולגו", willSkip],
                ["לא נתמכים", result.summary.unsupported],
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

            <ul className="mt-4 flex flex-col divide-y divide-[var(--dz-border-subtle)]">
              {result.files.map((f) => (
                <li key={f.index} className="py-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-bold text-[var(--dz-text-primary)]">
                      {f.filename}
                    </span>
                    <span className="shrink-0 text-[11px] text-[var(--dz-text-muted)]">
                      {formatSize(f.sizeBytes)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs font-semibold text-[var(--dz-text-primary)]">
                    {STATUS_LABEL[f.status]}
                  </p>
                  {f.reason ? (
                    <p className="mt-1 text-xs leading-5 text-[var(--dz-text-muted)]">
                      {f.reason}
                    </p>
                  ) : null}
                  {f.overridable ? (
                    <label className="mt-2 flex items-center gap-2 text-xs text-[var(--dz-text-primary)]">
                      <input
                        type="checkbox"
                        checked={decisions[f.index] === "CREATE_ANYWAY"}
                        onChange={(e) =>
                          setDecisions((prev) => ({
                            ...prev,
                            [f.index]: e.target.checked
                              ? "CREATE_ANYWAY"
                              : "SKIP",
                          }))
                        }
                      />
                      הוסיפו בכל זאת עותק נוסף
                    </label>
                  ) : null}
                </li>
              ))}
            </ul>

            <button
              type="button"
              onClick={() => void onContinue()}
              disabled={busy || willCreate === 0}
              className="mt-4 w-full rounded-2xl bg-[var(--dz-accent)] px-4 py-3 text-sm font-bold text-white transition disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "רגע…" : "המשיכו לאישור"}
            </button>
            {willCreate === 0 ? (
              <p className="mt-2 text-center text-[11px] text-[var(--dz-text-muted)]">
                אין קובץ שייקלט. בחרו קבצים אחרים.
              </p>
            ) : null}
          </SettingsSection>
        </div>
      ) : null}

      {stage === "confirm" && result ? (
        <div className="mt-4">
          <SettingsSection title="לאישורכם">
            <p className="text-sm text-[var(--dz-text-primary)]">
              ייקלטו <strong>{willCreate.toLocaleString("he-IL")}</strong> מסמכים,
              ו־<strong>{willSkip.toLocaleString("he-IL")}</strong> ידולגו.
            </p>

            {overrides.length > 0 ? (
              <div className="mt-3 rounded-2xl bg-[var(--dz-background)] px-4 py-3">
                <p className="text-xs font-bold text-[var(--dz-text-primary)]">
                  ביקשתם להוסיף עותק נוסף לקבצים שכבר קיימים אצלכם:
                </p>
                <ul className="mt-1 list-disc pr-4 text-xs leading-5 text-[var(--dz-text-muted)]">
                  {overrides.map((f) => (
                    <li key={f.index}>{f.filename}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <p className="mt-3 text-xs leading-5 text-[var(--dz-text-muted)]">
              אחרי הקליטה דוביז תזהה את תוכן המסמכים, ותציג כל אחד לאישורכם במסך
              המסמכים. שום דבר לא יאושר אוטומטית.
            </p>

            <button
              type="button"
              onClick={() => void onExecute()}
              disabled={busy}
              className="mt-4 w-full rounded-2xl bg-[var(--dz-accent)] px-4 py-3 text-sm font-bold text-white transition disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "קולט את הקבצים…" : "אשרו וקלטו"}
            </button>
            <button
              type="button"
              onClick={resetToCheck}
              disabled={busy}
              className="mt-2 w-full rounded-2xl px-4 py-3 text-sm font-bold text-[var(--dz-text-muted)] transition disabled:opacity-50"
            >
              חזרה
            </button>
          </SettingsSection>
        </div>
      ) : null}

      {stage === "done" && executed ? (
        <div className="mt-4">
          <SettingsSection title="מה נקלט">
            <dl className="grid grid-cols-3 gap-2">
              {[
                ["נקלטו", executed.counts.createdCount],
                ["דולגו", executed.counts.skippedCount],
                ["לא נקלטו", executed.counts.failedCount],
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

            {executed.alreadyExecuted ? (
              <p className="mt-3 text-xs leading-5 text-[var(--dz-text-muted)]">
                הקבצים האלה כבר נקלטו קודם. שום דבר לא נקלט פעם נוספת.
              </p>
            ) : null}

            {executed.unexecutedFiles > 0 ? (
              <div className="mt-3 rounded-2xl bg-[var(--dz-background)] px-4 py-3">
                <p className="text-xs font-bold text-[var(--dz-text-primary)]">
                  {executed.unexecutedFiles.toLocaleString("he-IL")} קבצים לא
                  הספיקו להיקלט.
                </p>
                <p className="mt-1 text-xs leading-5 text-[var(--dz-text-muted)]">
                  אפשר לשלוח את אותם קבצים שוב — מה שכבר נקלט לא ייקלט שוב.
                </p>
              </div>
            ) : null}

            {executed.files.length > 0 ? (
              <ul className="mt-4 flex flex-col divide-y divide-[var(--dz-border-subtle)]">
                {executed.files.map((f) => (
                  <li key={f.position} className="py-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-bold text-[var(--dz-text-primary)]">
                        {f.filename}
                      </span>
                      <span className="shrink-0 text-[11px] font-semibold text-[var(--dz-text-muted)]">
                        {OUTCOME_LABEL[f.outcome]}
                      </span>
                    </div>
                    {f.message ? (
                      <p className="mt-1 text-xs leading-5 text-[var(--dz-text-muted)]">
                        {f.message}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}

            <button
              type="button"
              onClick={() => {
                setFiles([]);
                setResult(null);
                setDecisions({});
                resetToCheck();
              }}
              className="mt-4 w-full rounded-2xl px-4 py-3 text-sm font-bold text-[var(--dz-text-muted)] transition"
            >
              ייבוא נוסף
            </button>
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

      {/* Export is a separate concern with its own outcome, so it gets its own
          panel rather than another control inside the import flow. It stays
          hidden while a confirmation is on screen: two things asking to be
          confirmed at once is how the wrong one gets pressed. */}
      {stage === "check" ? <DocumentsExportPanel /> : null}
    </>
  );
}
