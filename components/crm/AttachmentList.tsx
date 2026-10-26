"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  getAttachmentsPage,
  uploadAttachment,
  deleteAttachment,
  downloadAttachment,
  ATTACHMENT_ACCEPT,
  type CrmAttachmentDTO,
  type CrmSubjectType,
} from "@/lib/api/crm-attachments";
import { isUnauthorizedError, redirectToLogin } from "@/lib/client-session";
import { useI18n } from "@/components/i18n/I18nProvider";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDateTime(iso: string, formatDateTimeValue: (date: Date) => string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return formatDateTimeValue(d);
}

function fileGlyph(mime: string): string {
  if (mime === "application/pdf") return "📄";
  if (mime.startsWith("image/")) return "🖼️";
  if (mime.includes("wordprocessingml")) return "📝";
  if (mime.includes("spreadsheetml") || mime === "text/csv") return "📊";
  if (mime.includes("presentationml")) return "📽️";
  if (mime === "text/plain") return "📃";
  return "📎";
}

export function AttachmentList({
  subjectType,
  subjectId,
  icon,
}: {
  subjectType: CrmSubjectType;
  subjectId: number;
  /** Optional decorative glyph before the section title (the customer file uses one per section). */
  icon?: ReactNode;
}) {
  const { t, formatDate } = useI18n();
  const [items, setItems] = useState<CrmAttachmentDTO[]>([]);
  // The subject's real file count and whether older files exist beyond the loaded
  // pages — the header used to print the length of a capped page (at most 100).
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [busyId, setBusyId] = useState<number | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleAuth = useCallback((err: unknown): boolean => {
    if (isUnauthorizedError(err)) {
      redirectToLogin();
      return true;
    }
    return false;
  }, []);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      setMoreError(null);
      const page = await getAttachmentsPage(subjectType, subjectId);
      setItems(page.attachments);
      setHasMore(page.hasMore);
      setTotal(page.total);
    } catch (err) {
      if (handleAuth(err)) return;
      setError(err instanceof Error ? err.message : t("inbox.crm.attachments.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [subjectType, subjectId, handleAuth, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Older files, appended after the last one shown. A failure keeps every file
  // already on screen and offers a retry from the same point.
  const loadMore = useCallback(async () => {
    const last = items.at(-1);
    if (loadingMore || !hasMore || !last) return;
    try {
      setLoadingMore(true);
      setMoreError(null);
      const page = await getAttachmentsPage(subjectType, subjectId, last.id);
      setItems((prev) => {
        const seen = new Set(prev.map((a) => a.id));
        return prev.concat(page.attachments.filter((a) => !seen.has(a.id)));
      });
      setHasMore(page.hasMore);
      setTotal(page.total);
    } catch (err) {
      if (handleAuth(err)) return;
      setMoreError(t("inbox.crm.attachments.loadMoreFailed"));
    } finally {
      setLoadingMore(false);
    }
  }, [items, loadingMore, hasMore, subjectType, subjectId, handleAuth, t]);

  async function handleFileChosen(file: File | undefined) {
    if (!file) return;
    try {
      setUploading(true);
      setUploadError(null);
      setUploadPct(null);
      const created = await uploadAttachment(subjectType, subjectId, file, (pct) =>
        setUploadPct(pct)
      );
      setItems((prev) => [created, ...prev]);
      setTotal((n) => n + 1);
    } catch (err) {
      if (handleAuth(err)) return;
      setUploadError(err instanceof Error ? err.message : t("inbox.crm.attachments.uploadFailed"));
    } finally {
      setUploading(false);
      setUploadPct(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleDownload(item: CrmAttachmentDTO) {
    try {
      setBusyId(item.id);
      setRowError(null);
      await downloadAttachment(item.id, item.originalFileName);
    } catch (err) {
      if (handleAuth(err)) return;
      setRowError(err instanceof Error ? err.message : t("inbox.crm.attachments.downloadFailed"));
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(id: number) {
    try {
      setBusyId(id);
      setRowError(null);
      await deleteAttachment(id);
      setItems((prev) => prev.filter((a) => a.id !== id));
      setTotal((n) => Math.max(0, n - 1));
      setConfirmDeleteId(null);
    } catch (err) {
      if (handleAuth(err)) return;
      setRowError(err instanceof Error ? err.message : t("inbox.crm.attachments.deleteFailed"));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="crm-section">
      <div className="crm-section__head">
        <h2 className="crm-section__title">
          {icon ? <span className="crm-section__icon" aria-hidden>{icon}</span> : null}
          {t("inbox.crm.attachments.title")}
        </h2>
        {!loading && !error ? <span className="crm-section__count">{total}</span> : null}
      </div>

      {/* Uploader */}
      <div className="crm-att-upload">
        <input
          ref={fileInputRef}
          type="file"
          accept={ATTACHMENT_ACCEPT}
          style={{ display: "none" }}
          onChange={(e) => void handleFileChosen(e.target.files?.[0])}
        />
        <button
          type="button"
          className="crm-btn crm-btn--primary"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
        >
          {uploading ? t("inbox.crm.attachments.uploading") : t("inbox.crm.attachments.upload")}
        </button>
        {uploading ? (
          <div className="crm-att-progress" role="progressbar" aria-label={t("inbox.crm.attachments.progress")}>
            <div
              className={`crm-att-progress__bar${uploadPct === null ? " crm-att-progress__bar--indeterminate" : ""}`}
              style={uploadPct !== null ? { width: `${uploadPct}%` } : undefined}
            />
          </div>
        ) : null}
        {uploadError ? <div className="crm-note-err">{uploadError}</div> : null}
      </div>

      {loading ? (
        <div className="crm-skel" style={{ height: 52 }} />
      ) : error ? (
        <div className="crm-panel crm-panel--error">
          <p className="crm-panel__body">{error}</p>
          <button type="button" className="crm-btn crm-btn--ghost" onClick={() => void load()}>
            {t("inbox.crm.retry")}
          </button>
        </div>
      ) : items.length === 0 ? (
        <p className="crm-note-empty">{t("inbox.crm.attachments.none")}</p>
      ) : (
        <div className="crm-att-list">
          {rowError ? <div className="crm-note-err">{rowError}</div> : null}
          {items.map((item) => {
            const busy = busyId === item.id;
            return (
              <div className="crm-att-card" key={item.id}>
                <span className="crm-att-card__glyph" aria-hidden>
                  {fileGlyph(item.mimeType)}
                </span>
                <div className="crm-att-card__main">
                  <div className="crm-att-card__name" title={item.originalFileName}>
                    {item.originalFileName}
                  </div>
                  <div className="crm-att-card__meta">
                    {formatSize(item.sizeBytes)} · {formatDateTime(item.createdAt, (date) => formatDate(date, "dateTime"))}
                    {item.uploader.name ? ` · ${item.uploader.name}` : ""}
                  </div>
                </div>
                <div className="crm-att-card__actions">
                  {confirmDeleteId === item.id ? (
                    <>
                      <span className="crm-note-card__confirm">{t("inbox.crm.confirmDelete")}</span>
                      <button
                        type="button"
                        className="crm-note-linkbtn crm-note-linkbtn--danger"
                        onClick={() => void handleDelete(item.id)}
                        disabled={busy}
                      >
                        {busy ? t("inbox.crm.deleting") : t("inbox.crm.delete")}
                      </button>
                      <button
                        type="button"
                        className="crm-note-linkbtn"
                        onClick={() => setConfirmDeleteId(null)}
                        disabled={busy}
                      >
                        {t("inbox.crm.cancel")}
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="crm-note-linkbtn"
                        onClick={() => void handleDownload(item)}
                        disabled={busy}
                      >
                        {busy ? "…" : t("inbox.crm.attachments.download")}
                      </button>
                      {item.canDelete ? (
                        <button
                          type="button"
                          className="crm-note-linkbtn crm-note-linkbtn--danger"
                          onClick={() => setConfirmDeleteId(item.id)}
                        >
                          {t("inbox.crm.deleteAction")}
                        </button>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
            );
          })}
          {hasMore || moreError ? (
            <div className="crm-list-more" aria-live="polite">
              <p className="crm-list-more__note">{t("inbox.crm.shownOfTotal", { shown: items.length, total })}</p>
              {moreError ? <p className="crm-list-more__error" role="alert">{moreError}</p> : null}
              <button
                type="button"
                className="crm-btn crm-btn--ghost crm-btn--full"
                onClick={() => void loadMore()}
                disabled={loadingMore}
              >
                {loadingMore ? t("inbox.crm.loading") : moreError ? t("inbox.crm.retry") : t("inbox.crm.attachments.loadMore")}
              </button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
