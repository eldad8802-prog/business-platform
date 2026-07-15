"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getNotes,
  createNote,
  updateNote,
  deleteNote,
  type CrmNoteDTO,
  type CrmSubjectType,
} from "@/lib/api/crm-notes";
import { isUnauthorizedError, redirectToLogin } from "@/lib/client-session";

const BODY_MAX = 5000;

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

export function NotesThread({
  subjectType,
  subjectId,
}: {
  subjectType: CrmSubjectType;
  subjectId: number;
}) {
  const [notes, setNotes] = useState<CrmNoteDTO[]>([]);
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
      const data = await getNotes(subjectType, subjectId);
      setNotes(data);
    } catch (err) {
      if (handleAuth(err)) return;
      setError(err instanceof Error ? err.message : "לא הצלחנו לטעון את ההערות");
    } finally {
      setLoading(false);
    }
  }, [subjectType, subjectId, handleAuth]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleAdd() {
    const body = draft.trim();
    if (!body) {
      setComposerError("לא ניתן לשמור הערה ריקה");
      return;
    }
    try {
      setSaving(true);
      setComposerError(null);
      const created = await createNote(subjectType, subjectId, body);
      setNotes((prev) => [created, ...prev]);
      setDraft("");
    } catch (err) {
      if (handleAuth(err)) return;
      setComposerError(err instanceof Error ? err.message : "לא הצלחנו לשמור");
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
      setError(err instanceof Error ? err.message : "לא הצלחנו לעדכן");
    } finally {
      setRowBusy(null);
    }
  }

  async function handleDelete(noteId: number) {
    try {
      setRowBusy(noteId);
      await deleteNote(noteId);
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
      setConfirmDeleteId(null);
    } catch (err) {
      if (handleAuth(err)) return;
      setError(err instanceof Error ? err.message : "לא הצלחנו למחוק");
    } finally {
      setRowBusy(null);
    }
  }

  return (
    <div className="crm-section">
      <div className="crm-section__head">
        <h2 className="crm-section__title">הערות</h2>
        {!loading && !error ? (
          <span className="crm-section__count">{notes.length}</span>
        ) : null}
      </div>

      {/* Composer */}
      <div className="crm-note-composer">
        <textarea
          className="crm-note-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="הוסף הערה…"
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
            {saving ? "שומר…" : "הוסף הערה"}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="crm-skel" style={{ height: 56 }} />
      ) : error ? (
        <div className="crm-panel crm-panel--error">
          <p className="crm-panel__body">{error}</p>
          <button type="button" className="crm-btn crm-btn--ghost" onClick={() => void load()}>
            נסו שוב
          </button>
        </div>
      ) : notes.length === 0 ? (
        <p className="crm-note-empty">אין עדיין הערות. אפשר להוסיף את ההערה הראשונה למעלה.</p>
      ) : (
        <div className="crm-note-list">
          {notes.map((note) => {
            const isEditing = editingId === note.id;
            const busy = rowBusy === note.id;
            return (
              <div className="crm-note-card" key={note.id}>
                <div className="crm-note-card__meta">
                  <span className="crm-note-card__author">{note.author.name || "משתמש"}</span>
                  <span className="crm-note-card__time">{formatDateTime(note.createdAt)}</span>
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
                        {busy ? "שומר…" : "שמירה"}
                      </button>
                      <button
                        type="button"
                        className="crm-btn crm-btn--ghost"
                        onClick={() => setEditingId(null)}
                        disabled={busy}
                      >
                        ביטול
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
                            <span className="crm-note-card__confirm">למחוק?</span>
                            <button
                              type="button"
                              className="crm-note-linkbtn crm-note-linkbtn--danger"
                              onClick={() => void handleDelete(note.id)}
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
                            {note.canEdit ? (
                              <button
                                type="button"
                                className="crm-note-linkbtn"
                                onClick={() => startEdit(note)}
                              >
                                עריכה
                              </button>
                            ) : null}
                            {note.canDelete ? (
                              <button
                                type="button"
                                className="crm-note-linkbtn crm-note-linkbtn--danger"
                                onClick={() => setConfirmDeleteId(note.id)}
                              >
                                מחיקה
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
        </div>
      )}
    </div>
  );
}
