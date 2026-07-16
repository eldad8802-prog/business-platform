"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getAttachments,
  uploadAttachment,
  deleteAttachment,
  downloadAttachment,
  ATTACHMENT_ACCEPT,
  type CrmAttachmentDTO,
  type CrmSubjectType,
} from "@/lib/api/crm-attachments";
import { isUnauthorizedError, redirectToLogin } from "@/lib/client-session";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("he-IL", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
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
}: {
  subjectType: CrmSubjectType;
  subjectId: number;
}) {
  const [items, setItems] = useState<CrmAttachmentDTO[]>([]);
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
      setItems(await getAttachments(subjectType, subjectId));
    } catch (err) {
      if (handleAuth(err)) return;
      setError(err instanceof Error ? err.message : "לא הצלחנו לטעון את הקבצים");
    } finally {
      setLoading(false);
    }
  }, [subjectType, subjectId, handleAuth]);

  useEffect(() => {
    void load();
  }, [load]);

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
    } catch (err) {
      if (handleAuth(err)) return;
      setUploadError(err instanceof Error ? err.message : "העלאה נכשלה");
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
      setRowError(err instanceof Error ? err.message : "ההורדה נכשלה");
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
      setConfirmDeleteId(null);
    } catch (err) {
      if (handleAuth(err)) return;
      setRowError(err instanceof Error ? err.message : "המחיקה נכשלה");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="crm-section">
      <div className="crm-section__head">
        <h2 className="crm-section__title">קבצים</h2>
        {!loading && !error ? <span className="crm-section__count">{items.length}</span> : null}
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
          {uploading ? "מעלה קובץ…" : "העלה קובץ"}
        </button>
        {uploading ? (
          <div className="crm-att-progress" role="progressbar" aria-label="התקדמות העלאה">
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
            נסו שוב
          </button>
        </div>
      ) : items.length === 0 ? (
        <p className="crm-note-empty">אין עדיין קבצים. אפשר להעלות את הקובץ הראשון למעלה.</p>
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
                    {formatSize(item.sizeBytes)} · {formatDateTime(item.createdAt)}
                    {item.uploader.name ? ` · ${item.uploader.name}` : ""}
                  </div>
                </div>
                <div className="crm-att-card__actions">
                  {confirmDeleteId === item.id ? (
                    <>
                      <span className="crm-note-card__confirm">למחוק?</span>
                      <button
                        type="button"
                        className="crm-note-linkbtn crm-note-linkbtn--danger"
                        onClick={() => void handleDelete(item.id)}
                        disabled={busy}
                      >
                        {busy ? "מוחק…" : "מחק"}
                      </button>
                      <button
                        type="button"
                        className="crm-note-linkbtn"
                        onClick={() => setConfirmDeleteId(null)}
                        disabled={busy}
                      >
                        ביטול
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
                        {busy ? "…" : "הורדה"}
                      </button>
                      {item.canDelete ? (
                        <button
                          type="button"
                          className="crm-note-linkbtn crm-note-linkbtn--danger"
                          onClick={() => setConfirmDeleteId(item.id)}
                        >
                          מחיקה
                        </button>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
