"use client";

import { useState } from "react";
import { SettingsSection } from "@/components/settings/SettingsSection";

/**
 * הגדרות → ייבוא וייצוא → תבניות להכנת המידע.
 *
 * # The one thing this screen must not do
 *
 * It must not let the owner believe importing already works. So the state of
 * the world is the FIRST thing on the page, in plain words, before any button:
 * prepare your data now, the import itself is coming. Everything below that is
 * a plain download.
 *
 * One domain per download, deliberately. A combined four-sheet workbook would
 * be a worse artifact to fill in and a worse one to upload later, and nobody
 * migrates all four areas in one sitting.
 *
 * Downloads go through a real fetch rather than a bare `<a href>` because the
 * API is bearer-authenticated; a plain link would send no Authorization header
 * and return 401.
 */

export type TemplateDomainOption = {
  id: string;
  title: string;
  description: string;
  icon: string;
};

type Props = { domains: readonly TemplateDomainOption[] };

type Status =
  | { kind: "idle" }
  | { kind: "working"; id: string }
  | { kind: "done"; filename: string }
  | { kind: "error"; message: string };

function filenameFromDisposition(header: string | null, fallback: string) {
  if (!header) return fallback;
  return /filename="([^"]+)"/.exec(header)?.[1] ?? fallback;
}

export function TemplatesScreen({ domains }: Props) {
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function download(domain: TemplateDomainOption) {
    if (status.kind === "working") return;

    const token =
      typeof window !== "undefined" ? localStorage.getItem("token") : null;
    if (!token?.trim()) {
      setStatus({
        kind: "error",
        message: "חסר אסימון התחברות — התחברו מחדש ונסו שוב.",
      });
      return;
    }

    setStatus({ kind: "working", id: domain.id });
    try {
      const response = await fetch(
        `/api/data-transfer/template?domain=${encodeURIComponent(domain.id)}`,
        { headers: { Authorization: `Bearer ${token.trim()}` } }
      );

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
              : `הורדת התבנית נכשלה (${response.status}).`),
        });
        return;
      }

      const blob = await response.blob();
      const filename = filenameFromDisposition(
        response.headers.get("Content-Disposition"),
        `dubiz-${domain.id}-template.xlsx`
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
      <SettingsSection>
        <p className="text-sm leading-6 text-[var(--dz-text-primary)]">
          הכינו את המידע שלכם מראש.
        </p>
        <p className="mt-2 text-xs leading-5 text-[var(--dz-text-muted)]">
          הורידו תבנית, מלאו אותה במידע מהמערכת הקודמת שלכם, ואז העלו אותה
          במסך הייבוא. תמיד תראו בדיוק מה ייקלט לפני שתאשרו.
        </p>
      </SettingsSection>

      <div className="mt-4">
        <SettingsSection
          title="בחרו תחום"
          description="כל תבנית מכילה גיליון למילוי וגיליון הוראות."
        >
          <ul className="flex flex-col divide-y divide-[var(--dz-border-subtle)]">
            {domains.map((domain) => {
              const busy =
                status.kind === "working" && status.id === domain.id;
              return (
                <li key={domain.id}>
                  <button
                    type="button"
                    onClick={() => download(domain)}
                    disabled={status.kind === "working"}
                    className="flex w-full items-start gap-3 rounded-2xl px-2 py-3 text-right transition hover:bg-[var(--dz-surface-muted)] disabled:cursor-not-allowed disabled:opacity-60"
                  >
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
                    <span
                      className="shrink-0 self-center text-xs font-semibold text-[var(--dz-text-muted)]"
                      aria-hidden
                    >
                      {busy ? "…" : "הורדה"}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          <div aria-live="polite" className="mt-3 min-h-[1.25rem]">
            {status.kind === "done" ? (
              <p className="text-xs font-semibold text-[var(--dz-text-primary)]">
                התבנית ירדה: {status.filename}
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
