"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  getNotesPage,
  createNote,
  updateNote,
  deleteNote,
  type CrmNoteDTO,
  type CrmSubjectType,
} from "@/lib/api/crm-notes";
import { isUnauthorizedError, redirectToLogin } from "@/lib/client-session";
import { useI18n } from "@/components/i18n/I18nProvider";

const BODY_MAX = 5000;

function formatDateTime(iso: string, formatDateTimeValue: (date: Date) => string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return formatDateTimeValue(d);
}

export function NotesThread({
  subjectType,
  subjectId,
  icon,
  intro,
}: {
  subjectType: CrmSubjectType;
  subjectId: number;
  /** Optional decorative glyph before the section title (the customer file uses one per section). */
  icon?: ReactNode;
  /** Optional content shown right under the section head, before the section body. */
  intro?: ReactNode;
}) {
  const { t, formatDate } = useI18n();
  const [notes, setNotes] = useState<CrmNoteDTO[]>([]);
  // The thread's real size and whether older notes exist beyond the loaded pages —
  // the header used to print the length of a capped page (at most 100) as the count.
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const [rowBusy, setRowBusy] = useState<number | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

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
      const page = await getNotesPage(subjectType, subjectId);
      setNotes(page.notes);
      setHasMore(page.hasMore);
      setTotal(page.total);
    } catch (err) {
      if (handleAuth(err)) return;
      setError(err instanceof Error ? err.message : t("inbox.crm.notes.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [subjectType, subjectId, handleAuth, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Older notes, appended after the last one shown. A failure keeps every note
  // already on screen and offers a retry from the same point.
  const loadMore = useCallback(async () => {
    const last = notes.at(-1);
    if (loadingMore || !hasMore || !last) return;
    try {
      setLoadingMore(true);
      setMoreError(null);
      const page = await getNotesPage(subjectType, subjectId, last.id);
      setNotes((prev) => {
        const seen = new Set(prev.map((n) => n.id));
        return prev.concat(page.notes.filter((n) => !seen.has(n.id)));
      });
      setHasMore(page.hasMore);
      setTotal(page.total);
    } catch (err) {
      if (handleAuth(err)) return;
      setMoreError(t("inbox.crm.notes.loadMoreFailed"));
    } finally {
      setLoadingMore(false);
    }
  }, [notes, loadingMore, hasMore, subjectType, subjectId, handleAuth, t]);

  async function handleAdd() {
    const body = draft.trim();
    if (!body) {
      setComposerError(t("inbox.crm.notes.empty"));
      return;
    }
    try {
      setSaving(true);
      setComposerError(null);
      const created = await createNote(subjectType, subjectId, body);
      setNotes((prev) => [created, ...prev]);
      setTotal((n) => n + 1);
      setDraft("");
    } catch (err) {
      if (handleAuth(err)) return;
      setComposerError(err instanceof Error ? err.message : t("inbox.crm.notes.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  function startEdit(note: CrmNoteDTO) {
    setEditingId(note.id);
    setEditText(note.body);
    setConfirmDeleteId(null);
  }

  async function handleSaveEdit(noteId: number) {
    const body = editText.trim();
    if (!body) return;
    try {
      setRowBusy(noteId);
      const updated = await updateNote(noteId, body);
      setNotes((prev) => prev.map((n) => (n.id === noteId ? updated : n)));
      setEditingId(null);
    } catch (err) {
      if (handleAuth(err)) return;
      setError(err instanceof Error ? err.message : t("inbox.crm.notes.updateFailed"));
    } finally {
      setRowBusy(null);
    }
  }

  async function handleDelete(noteId: number) {
    try {
      setRowBusy(noteId);
      await deleteNote(noteId);
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
      setTotal((n) => Math.max(0, n - 1));
      setConfirmDeleteId(null);
    } catch (err) {
      if (handleAuth(err)) return;
      setError(err instanceof Error ? err.message : t("inbox.crm.notes.deleteFailed"));
    } finally {
      setRowBusy(null);
    }
  }

  return (
    <div className="crm-section">
      <div className="crm-section__head">
        <h2 className="crm-section__title">
          {icon ? <span className="crm-section__icon" aria-hidden>{icon}</span> : null}
          {t("inbox.crm.notes.title")}
        </h2>
        {!loading && !error ? (
          <span className="crm-section__count">{total}</span>
        ) : null}
      </div>

      {intro}

      {/* Composer */}
      <div className="crm-note-composer">
        <textarea
          className="crm-note-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t("inbox.crm.notes.placeholder")}
          maxLength={BODY_MAX}
          rows={2}
        />
        <div className="crm-note-composer__foot">
          {composerError ? (
            <span className="crm-note-err">{composerError}</span>
          ) : (
            <span />
          )}
          <button
            type="button"
            className="crm-btn crm-btn--primary"
            onClick={() => void handleAdd()}
            disabled={saving || !draft.trim()}
          >
            {saving ? t("inbox.crm.notes.saving") : t("inbox.crm.notes.add")}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="crm-skel" style={{ height: 56 }} />
      ) : error ? (
        <div className="crm-panel crm-panel--error">
          <p className="crm-panel__body">{error}</p>
          <button type="button" className="crm-btn crm-btn--ghost" onClick={() => void load()}>
            {t("inbox.crm.retry")}
          </button>
        </div>
      ) : notes.length === 0 ? (
        <p className="crm-note-empty">{t("inbox.crm.notes.none")}</p>
      ) : (
        <div className="crm-note-list">
          {notes.map((note) => {
            const isEditing = editingId === note.id;
            const busy = rowBusy === note.id;
            return (
              <div className="crm-note-card" key={note.id}>
                <div className="crm-note-card__meta">
                  <span className="crm-note-card__author">{note.author.name || t("inbox.crm.notes.unknownAuthor")}</span>
                  <span className="crm-note-card__time">{formatDateTime(note.createdAt, (date) => formatDate(date, "dateTime"))}</span>
                </div>

                {isEditing ? (
                  <>
                    <textarea
                      className="crm-note-input"
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      maxLength={BODY_MAX}
                      rows={2}
                    />
                    <div className="crm-note-card__actions">
                      <button
                        type="button"
                        className="crm-btn crm-btn--primary"
                        onClick={() => void handleSaveEdit(note.id)}
                        disabled={busy || !editText.trim()}
                      >
                        {busy ? t("inbox.crm.notes.saving") : t("inbox.crm.notes.save")}
                      </button>
                      <button
                        type="button"
                        className="crm-btn crm-btn--ghost"
                        onClick={() => setEditingId(null)}
                        disabled={busy}
                      >
                        {t("inbox.crm.cancel")}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="crm-note-card__body">{note.body}</div>
                    {note.canEdit || note.canDelete ? (
                      <div className="crm-note-card__actions">
                        {confirmDeleteId === note.id ? (
                          <>
                            <span className="crm-note-card__confirm">{t("inbox.crm.confirmDelete")}</span>
                            <button
                              type="button"
                              className="crm-note-linkbtn crm-note-linkbtn--danger"
                              onClick={() => void handleDelete(note.id)}
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
                            {note.canEdit ? (
                              <button
                                type="button"
                                className="crm-note-linkbtn"
                                onClick={() => startEdit(note)}
                              >
                                {t("inbox.crm.notes.edit")}
                              </button>
                            ) : null}
                            {note.canDelete ? (
                              <button
                                type="button"
                                className="crm-note-linkbtn crm-note-linkbtn--danger"
                                onClick={() => setConfirmDeleteId(note.id)}
                              >
                                {t("inbox.crm.deleteAction")}
                              </button>
                            ) : null}
                          </>
                        )}
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            );
          })}
          {hasMore || moreError ? (
            <div className="crm-list-more" aria-live="polite">
              <p className="crm-list-more__note">{t("inbox.crm.shownOfTotal", { shown: notes.length, total })}</p>
              {moreError ? <p className="crm-list-more__error" role="alert">{moreError}</p> : null}
              <button
                type="button"
                className="crm-btn crm-btn--ghost crm-btn--full"
                onClick={() => void loadMore()}
                disabled={loadingMore}
              >
                {loadingMore ? t("inbox.crm.loading") : moreError ? t("inbox.crm.retry") : t("inbox.crm.notes.loadMore")}
              </button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
