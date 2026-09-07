"use client";

import { useState } from "react";
import { SettingsSection } from "@/components/settings/SettingsSection";

/**
 * הגדרות → ייבוא וייצוא → מסמכים → ייצוא.
 *
 * The other half of the Documents screen. Import brings files in; this takes
 * them back out, as the ORIGINAL files plus a spreadsheet describing them.
 *
 * # What the copy promises, and why it is worded that way
 *
 * "הקבצים המקוריים" is the whole point: not a report, not a rendering, the
 * files the owner gave us. And when the archive turns out to be short a file,
 * the result says so plainly rather than reporting a clean success — a backup
 * that quietly omits a document is worse than one that admits it, because the
 * owner only discovers the gap when they need the file.
 *
 * No archive or storage vocabulary reaches the owner: no "object", no "bucket",
 * no "entry". They are choosing documents and getting a file.
 */

type Status =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "done"; filename: string; missing: number; included: number }
  | { kind: "error"; message: string };

/** Pull the download name the server chose, so the file is never renamed here. */
function filenameFromDisposition(header: string | null, fallback: string) {
  if (!header) return fallback;
  const match = /filename="([^"]+)"/.exec(header);
  return match?.[1] ?? fallback;
}

export function DocumentsExportPanel() {
  const [useRange, setUseRange] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const working = status.kind === "working";

  async function runExport() {
    if (working) return;

    const token =
      typeof window !== "undefined" ? localStorage.getItem("token") : null;
    if (!token?.trim()) {
      setStatus({
        kind: "error",
        message: "חסר אסימון התחברות — התחברו מחדש ונסו שוב.",
      });
      return;
    }

    setStatus({ kind: "working" });
    try {
      const response = await fetch("/api/data-transfer/documents/export", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token.trim()}`,
        },
        // Only the range travels. No businessId — the server derives the tenant
        // from the session.
        body: JSON.stringify(
          useRange ? { from: from || null, to: to || null } : {}
        ),
      });

      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        setStatus({
          kind: "error",
          message:
            detail?.error ??
            (response.status === 401
              ? "אין הרשאה. התחברו מחדש ונסו שוב."
              : `הייצוא נכשל (${response.status}).`),
        });
        return;
      }

      const included = Number(response.headers.get("X-Documents-Included") ?? 0);
      const missing = Number(response.headers.get("X-Documents-Missing") ?? 0);
      const blob = await response.blob();
      const filename = filenameFromDisposition(
        response.headers.get("Content-Disposition"),
        "dubiz-documents.zip"
      );

      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);

      setStatus({ kind: "done", filename, missing, included });
    } catch {
      setStatus({
        kind: "error",
        message: "שגיאת רשת — בדקו את החיבור ונסו שוב.",
      });
    }
  }

  return (
    <div className="mt-6">
      <SettingsSection
        title="ייצוא מסמכים"
        description="קובץ ZIP הכולל את הקבצים המקוריים וקובץ אינדקס Excel."
      >
        <p className="text-xs leading-5 text-[var(--dz-text-muted)]">
          תקבלו את המסמכים עצמם בדיוק כפי שנשמרו, ולצידם טבלה בעברית עם שם
          הקובץ, התאריך, הספק, הסכום והסטטוס. מתאים לגיבוי, למעבר למערכת אחרת
          או להעברה לרואה החשבון.
        </p>

        <label className="mt-4 flex items-center gap-2 text-xs text-[var(--dz-text-primary)]">
          <input
            type="checkbox"
            checked={useRange}
            onChange={(e) => {
              setUseRange(e.target.checked);
              setStatus({ kind: "idle" });
            }}
          />
          ייצוא לפי טווח תאריכים
        </label>

        {useRange ? (
          <div className="mt-3 grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-[11px] text-[var(--dz-text-muted)]">
              מתאריך
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="rounded-xl bg-[var(--dz-background)] px-3 py-2 text-sm text-[var(--dz-text-primary)]"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-[var(--dz-text-muted)]">
              עד תאריך
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="rounded-xl bg-[var(--dz-background)] px-3 py-2 text-sm text-[var(--dz-text-primary)]"
              />
            </label>
            <p className="col-span-2 text-[11px] text-[var(--dz-text-muted)]">
              הטווח מתייחס לתאריך שבו המסמך נקלט בדוביז.
            </p>
          </div>
        ) : (
          <p className="mt-3 text-[11px] text-[var(--dz-text-muted)]">
            ייוצאו כל המסמכים שלכם, בכל סטטוס.
          </p>
        )}

        <button
          type="button"
          onClick={() => void runExport()}
          disabled={working}
          className="mt-4 w-full rounded-2xl bg-[var(--dz-accent)] px-4 py-3 text-sm font-bold text-white transition disabled:cursor-not-allowed disabled:opacity-50"
        >
          {working ? "מכין את הקבצים…" : "ייצאו מסמכים"}
        </button>

        <div aria-live="polite" className="mt-3 min-h-[1.25rem]">
          {status.kind === "working" ? (
            <p className="text-xs text-[var(--dz-text-muted)]">
              אוספים את הקבצים. בארכיון גדול זה יכול לקחת כמה שניות.
            </p>
          ) : null}

          {status.kind === "done" ? (
            <div className="rounded-2xl bg-[var(--dz-background)] px-4 py-3">
              <p className="text-sm font-bold text-[var(--dz-text-primary)]">
                הורדנו {status.included.toLocaleString("he-IL")} מסמכים.
              </p>
              {status.missing > 0 ? (
                <p className="mt-1 text-xs leading-5 text-[var(--dz-text-muted)]">
                  {status.missing.toLocaleString("he-IL")} קבצים לא נמצאו ולכן
                  אינם בארכיון. הם מסומנים בקובץ האינדקס כדי שתדעו בדיוק מה חסר.
                </p>
              ) : (
                <p className="mt-1 text-xs leading-5 text-[var(--dz-text-muted)]">
                  כל הקבצים נכללו.
                </p>
              )}
            </div>
          ) : null}

          {status.kind === "error" ? (
            <p className="text-xs font-semibold text-[var(--dz-danger,#b3261e)]">
              {status.message}
            </p>
          ) : null}
        </div>
      </SettingsSection>
    </div>
  );
}
