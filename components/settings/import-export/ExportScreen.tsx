"use client";

import { useState } from "react";
import { SettingsSection } from "@/components/settings/SettingsSection";

/**
 * הגדרות → ייבוא וייצוא → ייצוא.
 *
 * Two questions, in the order the owner can answer them: WHAT do you want, and
 * HOW do you want it. Format comes second and defaults to Excel, because
 * someone who has not thought about file formats should be able to ignore the
 * question entirely and still get the right file.
 *
 * The domain list arrives as a prop from the server page rather than being
 * imported here: the export registry pulls in Prisma and the tenant transaction
 * layer, which have no business in a browser bundle.
 *
 * State is deliberately small — selection, format, and one request status. No
 * progress bar: the request either returns a file or an error, and a fake
 * percentage would be a lie about work we cannot observe.
 */

export type ExportDomainOption = {
  id: string;
  title: string;
  description: string;
  icon: string;
};

type Props = { domains: readonly ExportDomainOption[] };

type Status =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "done"; filename: string }
  | { kind: "error"; message: string };

const FORMATS = [
  { value: "xlsx", label: "Excel", hint: "מומלץ — נפתח ישירות באקסל" },
  { value: "csv", label: "CSV", hint: "לקובץ פשוט או למערכת אחרת" },
] as const;

/** Pull the download name the server chose, so the file is never renamed here. */
function filenameFromDisposition(header: string | null, fallback: string) {
  if (!header) return fallback;
  const match = /filename="([^"]+)"/.exec(header);
  return match?.[1] ?? fallback;
}

export function ExportScreen({ domains }: Props) {
  const [selected, setSelected] = useState<string[]>([]);
  const [format, setFormat] = useState<"xlsx" | "csv">("xlsx");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const allSelected = selected.length === domains.length && domains.length > 0;
  const working = status.kind === "working";

  function toggle(id: string) {
    setStatus({ kind: "idle" });
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  function toggleAll() {
    setStatus({ kind: "idle" });
    setSelected(allSelected ? [] : domains.map((d) => d.id));
  }

  async function runExport() {
    if (selected.length === 0 || working) return;

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
      const response = await fetch("/api/data-transfer/export", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token.trim()}`,
        },
        // Only the selection travels. No businessId — the server derives the
        // tenant from the session.
        body: JSON.stringify({ domains: selected, format }),
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

      const blob = await response.blob();
      const filename = filenameFromDisposition(
        response.headers.get("Content-Disposition"),
        format === "csv" ? "dubiz-export.csv" : "dubiz-export.xlsx"
      );

      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);

      setStatus({ kind: "done", filename });
    } catch {
      setStatus({
        kind: "error",
        message: "שגיאת רשת — בדקו את החיבור ונסו שוב.",
      });
    }
  }

  return (
    <>
      <SettingsSection
        title="מה לייצא"
        description="בחרו תחום אחד, כמה תחומים או הכול."
      >
        <div className="mb-3 flex justify-start">
          <button
            type="button"
            onClick={toggleAll}
            className="rounded-full border border-[var(--dz-border-subtle)] px-3 py-1.5 text-xs font-semibold text-[var(--dz-text-primary)] transition hover:bg-[var(--dz-surface-muted)]"
          >
            {allSelected ? "נקה בחירה" : "בחר הכול"}
          </button>
        </div>

        <ul className="flex flex-col divide-y divide-[var(--dz-border-subtle)]">
          {domains.map((domain) => {
            const checked = selected.includes(domain.id);
            return (
              <li key={domain.id}>
                <label className="flex w-full cursor-pointer items-start gap-3 rounded-2xl px-2 py-3 text-right transition hover:bg-[var(--dz-surface-muted)]">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(domain.id)}
                    className="mt-1.5 h-5 w-5 shrink-0 accent-[var(--dz-accent)]"
                  />
                  <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[var(--dz-background)] text-lg">
                    {domain.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-bold text-[var(--dz-text-primary)]">
                      {domain.title}
                    </span>
                    <span className="mt-1 block text-xs leading-5 text-[var(--dz-text-muted)]">
                      {domain.description}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </SettingsSection>

      <div className="mt-4">
        <SettingsSection title="באיזה פורמט">
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">פורמט הקובץ</legend>
            {FORMATS.map((option) => (
              <label
                key={option.value}
                className="flex cursor-pointer items-start gap-3 rounded-2xl px-2 py-2.5 text-right transition hover:bg-[var(--dz-surface-muted)]"
              >
                <input
                  type="radio"
                  name="export-format"
                  value={option.value}
                  checked={format === option.value}
                  onChange={() => setFormat(option.value)}
                  className="mt-1 h-5 w-5 shrink-0 accent-[var(--dz-accent)]"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-bold text-[var(--dz-text-primary)]">
                    {option.label}
                  </span>
                  <span className="mt-0.5 block text-xs text-[var(--dz-text-muted)]">
                    {option.hint}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
        </SettingsSection>
      </div>

      <div className="mt-4">
        <SettingsSection>
          <button
            type="button"
            onClick={runExport}
            disabled={selected.length === 0 || working}
            className="w-full rounded-2xl bg-[var(--dz-accent)] px-4 py-3 text-sm font-bold text-white transition disabled:cursor-not-allowed disabled:opacity-50"
          >
            {working ? "מכין את הקובץ…" : "הורד קובץ"}
          </button>

          {/* One live region for every outcome, so a screen reader announces
              the result without the user hunting for it. */}
          <div aria-live="polite" className="mt-3 min-h-[1.25rem]">
            {selected.length === 0 && status.kind === "idle" ? (
              <p className="text-xs text-[var(--dz-text-muted)]">
                בחרו לפחות תחום אחד כדי להוריד.
              </p>
            ) : null}
            {status.kind === "done" ? (
              <p className="text-xs font-semibold text-[var(--dz-text-primary)]">
                הקובץ ירד: {status.filename}
              </p>
            ) : null}
            {status.kind === "error" ? (
              <p className="text-xs font-semibold text-[var(--dz-danger,#b3261e)]">
                {status.message}
              </p>
            ) : null}
          </div>
        </SettingsSection>
      </div>
    </>
  );
}
