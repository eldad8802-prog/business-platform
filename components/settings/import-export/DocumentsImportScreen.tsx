"use client";

import { useRef, useState } from "react";
import { SettingsSection } from "@/components/settings/SettingsSection";

/**
 * הגדרות → ייבוא וייצוא → ייבוא מסמכים — the batch check.
 *
 * # The promise this screen makes, and keeps
 *
 * Nothing is saved. The owner picks files, sees exactly what would happen to
 * each one, and that is where I-7B stops. There is deliberately no confirm
 * button yet, because a button that looks like it imports and does not is worse
 * than no button.
 *
 * # What it does NOT show, and why that is said out loud
 *
 * It does not show the supplier, amount or date inside a document. Reading a
 * document requires storing it first, so anything shown here before the owner
 * confirms would be a guess. The copy says the identification happens after the
 * files are taken in, and that the owner reviews each one then — which is how
 * the single-upload screen already behaves.
 */

type FileStatus = "NEW" | "DUPLICATE" | "IN_FILE_DUPLICATE" | "UNSUPPORTED";

type AnalyzedFile = {
  index: number;
  filename: string;
  sizeBytes: number;
  mimeType: string;
  status: FileStatus;
  action: "CREATE" | "SKIP";
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
  decisions: Record<number, "CREATE" | "SKIP">;
  limits: { maxFiles: number; maxBatchBytes: number };
  expiresAt: string;
};

/** Owner-facing wording. No file-format jargon, no hashes, no MIME. */
const STATUS_LABEL: Record<FileStatus, string> = {
  NEW: "חדש — יתווסף לאחר אישור",
  DUPLICATE: "כבר קיים בדוביז — ידולג",
  IN_FILE_DUPLICATE: "כפילות בתוך הקבצים שבחרת",
  UNSUPPORTED: "קובץ לא נתמך",
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

export function DocumentsImportScreen() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runAnalyze(chosen: File[]) {
    const auth = authHeader();
    if (!auth) {
      setError("חסר אסימון התחברות — התחברו מחדש ונסו שוב.");
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const body = new FormData();
      for (const f of chosen) body.append("files", f);

      const response = await fetch("/api/data-transfer/documents/analyze", {
        method: "POST",
        headers: auth,
        body,
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) {
        setError(data?.error ?? `בדיקת הקבצים נכשלה (${response.status}).`);
        return;
      }
      setResult(data as AnalyzeResult);
    } catch {
      setError("שגיאת רשת — בדקו את החיבור ונסו שוב.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* The promise, before anything else on the page. */}
      <SettingsSection>
        <p className="text-sm font-bold text-[var(--dz-text-primary)]">
          בדיקה בלבד — שום קובץ לא נשמר בשלב הזה.
        </p>
        <p className="mt-2 text-xs leading-5 text-[var(--dz-text-muted)]">
          בחרו מסמכים ונראה לכם מה יקרה לכל אחד: מה יתווסף, מה כבר קיים אצלכם,
          ומה לא נתמך. את מה שכתוב בתוך המסמכים דוביז תזהה אחרי הקליטה, ותציג
          לאישורכם במסך הבדיקה.
        </p>
      </SettingsSection>

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
              if (chosen.length > 0) void runAnalyze(chosen);
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

      {result ? (
        <div className="mt-4">
          <SettingsSection title="תוצאות הבדיקה">
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                ["סה״כ קבצים", result.summary.total],
                ["יתווספו", result.summary.willCreate],
                ["ידולגו", result.summary.willSkip],
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
                </li>
              ))}
            </ul>

            {/* The end of the road in I-7B. No control that could be mistaken
                for one that saves. */}
            <div className="mt-4 rounded-2xl bg-[var(--dz-background)] px-4 py-3">
              <p className="text-sm font-bold text-[var(--dz-text-primary)]">
                בדיקת הקבצים הושלמה.
              </p>
              <p className="mt-1 text-xs leading-5 text-[var(--dz-text-muted)]">
                שום קובץ לא נשמר בדוביז. הקליטה בפועל תתווסף בשלב הבא.
              </p>
            </div>
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
