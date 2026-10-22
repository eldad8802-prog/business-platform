"use client";

import { useState } from "react";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { useI18n } from "@/components/i18n/I18nProvider";
import { intlTag } from "@/lib/i18n/config";

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
  const { t, locale } = useI18n();
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
        message: t("account.settings.importExport.common.noToken"),
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
              ? t("account.settings.importExport.common.unauthorized")
              : t("account.settings.importExport.common.exportFailed", { status: response.status })),
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
        message: t("account.settings.importExport.common.network"),
      });
    }
  }

  return (
    <div className="mt-6">
      <SettingsSection
        title={t("account.settings.importExport.documentsExport.title")}
        description={t("account.settings.importExport.documentsExport.description")}
      >
        <p className="text-xs leading-5 text-[var(--dz-text-muted)]">
          {t("account.settings.importExport.documentsExport.body")}
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
          {t("account.settings.importExport.documentsExport.byRange")}
        </label>

        {useRange ? (
          <div className="mt-3 grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-[11px] text-[var(--dz-text-muted)]">
              {t("account.settings.importExport.documentsExport.from")}
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="rounded-xl bg-[var(--dz-background)] px-3 py-2 text-sm text-[var(--dz-text-primary)]"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-[var(--dz-text-muted)]">
              {t("account.settings.importExport.documentsExport.to")}
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="rounded-xl bg-[var(--dz-background)] px-3 py-2 text-sm text-[var(--dz-text-primary)]"
              />
            </label>
            <p className="col-span-2 text-[11px] text-[var(--dz-text-muted)]">
              {t("account.settings.importExport.documentsExport.rangeNote")}
            </p>
          </div>
        ) : (
          <p className="mt-3 text-[11px] text-[var(--dz-text-muted)]">
            {t("account.settings.importExport.documentsExport.allNote")}
          </p>
        )}

        <button
          type="button"
          onClick={() => void runExport()}
          disabled={working}
          className="mt-4 w-full rounded-2xl bg-[var(--dz-action-primary)] px-4 py-3 text-sm font-bold text-[var(--dz-action-primary-text)] transition disabled:cursor-not-allowed disabled:opacity-50"
        >
          {working ? t("account.settings.importExport.documentsExport.preparing") : t("account.settings.importExport.documentsExport.submit")}
        </button>

        <div aria-live="polite" className="mt-3 min-h-[1.25rem]">
          {status.kind === "working" ? (
            <p className="text-xs text-[var(--dz-text-muted)]">
              {t("account.settings.importExport.documentsExport.working")}
            </p>
          ) : null}

          {status.kind === "done" ? (
            <div className="rounded-2xl bg-[var(--dz-background)] px-4 py-3">
              <p className="text-sm font-bold text-[var(--dz-text-primary)]">
                {t(status.included === 1 ? "account.settings.importExport.documentsExport.downloadedOne" : "account.settings.importExport.documentsExport.downloadedMany", { count: status.included.toLocaleString(intlTag(locale)) })}
              </p>
              {status.missing > 0 ? (
                <p className="mt-1 text-xs leading-5 text-[var(--dz-text-muted)]">
                  {t(status.missing === 1 ? "account.settings.importExport.documentsExport.missingOne" : "account.settings.importExport.documentsExport.missingMany", { count: status.missing.toLocaleString(intlTag(locale)) })}
                </p>
              ) : (
                <p className="mt-1 text-xs leading-5 text-[var(--dz-text-muted)]">
                  {t("account.settings.importExport.documentsExport.allIncluded")}
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
