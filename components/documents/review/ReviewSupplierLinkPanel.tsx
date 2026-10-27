"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  changeDocumentSupplierLink,
  getDocumentSupplierLink,
  newIdempotencyKey,
  SupplierLinkHttpError,
  type DocumentSupplierLinkState,
  type SuggestionNote,
  type SupplierSuggestion,
} from "@/lib/api/document-supplier-link";
import { getSuppliers, type SupplierListRow } from "@/lib/api/suppliers";
import { isUnauthorizedError, redirectToLogin } from "@/lib/client-session";
import { TOKEN } from "@/lib/design/documents-theme";
import { reviewCard, reviewInput } from "./review-ui";

/**
 * "ספק" on the document review screen (flag `document_supplier_linking`; OFF ⇒ not rendered).
 *
 * The owner decides which supplier the document belongs to: accept a suggestion, pick a supplier, change it
 * or remove it. Suggestions are only suggestions — a same name is marked as one that needs checking, and
 * "לא הספק הזה" removes a suggestion for this document for good. Nothing here creates a supplier, an
 * expense or a payment, and the document's approval is untouched. Hebrew-only (new screen).
 */

const NOTE_TEXT: Record<SuggestionNote, string | null> = {
  NO_READING: "אין עדיין נתונים שחולצו מהמסמך — אפשר לבחור ספק ידנית.",
  INCOME_DOCUMENT: "המסמך סומן כהכנסה, לכן לא מוצעים ספקים. אפשר לבחור ספק ידנית אם צריך.",
  OWN_BUSINESS_NAME: "השם שזוהה במסמך הוא שם העסק שלך, ולכן לא הוצע ספק לפיו.",
  SEVERAL_SUPPLIERS_SHARE_TAX_ID: "כמה ספקים בתיק רשומים עם אותו מספר עוסק — כדאי לבדוק אם יש כפילות.",
  TAX_ID_INVALID: "מספר העוסק שזוהה במסמך אינו תקין (ספרת ביקורת), ולכן לא הוצע ספק לפיו.",
  CONFLICTING_TAX_IDS: "במסמך מופיעים כמה מספרי עוסק שונים — יש לבחור את הספק ידנית.",
};

const REASON_TEXT = {
  TAX_ID: "מספר העוסק במסמך זהה למספר בתיק הספק",
  NAME: "שם זהה בלבד — יש לוודא שזה הספק",
} as const;

const small: CSSProperties = { fontSize: TOKEN.font.meta, color: TOKEN.ink.secondary, margin: 0 };
const row: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  flexWrap: "wrap",
  padding: "10px 12px",
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.card,
  background: TOKEN.surface.inset,
};
const btn: CSSProperties = {
  minHeight: 40,
  padding: "0 14px",
  borderRadius: TOKEN.radius.button,
  border: `1px solid ${TOKEN.border.hover}`,
  background: TOKEN.surface.card,
  color: TOKEN.ink.primary,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.semibold,
  cursor: "pointer",
};
const btnPrimary: CSSProperties = {
  ...btn,
  border: 0,
  background: TOKEN.action.primary.background,
  color: TOKEN.action.primary.color,
};
const pill = (tone: "attention" | "success" | "info"): CSSProperties => ({
  display: "inline-block",
  marginInlineStart: 8,
  padding: "2px 8px",
  borderRadius: TOKEN.radius.pill,
  fontSize: TOKEN.font.caption,
  fontWeight: TOKEN.weight.semibold,
  background: TOKEN.semantic[tone].bgSoft,
  color: TOKEN.semantic[tone].ink,
});

export default function ReviewSupplierLinkPanel({ documentId }: { documentId: number }) {
  const [state, setState] = useState<DocumentSupplierLinkState | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "error" | "info"; text: string } | null>(null);
  const [picking, setPicking] = useState(false);
  // Bumped to re-read the current state (after a concurrent change); every setState below runs after an await.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const s = await getDocumentSupplierLink(documentId);
        if (!active) return;
        if (!s) {
          setEnabled(false);
          return;
        }
        setState(s);
      } catch (e) {
        if (!active) return;
        if (isUnauthorizedError(e)) {
          redirectToLogin();
          return;
        }
        setMessage({ tone: "error", text: "לא הצלחנו לטעון את פרטי הספק של המסמך." });
      }
    })();
    return () => {
      active = false;
    };
  }, [documentId, reloadKey]);

  const run = useCallback(
    async (body: Parameters<typeof changeDocumentSupplierLink>[1], done?: string) => {
      setBusy(true);
      setMessage(null);
      try {
        const next = await changeDocumentSupplierLink(documentId, body);
        setState(next);
        setPicking(false);
        if (done) setMessage({ tone: "info", text: done });
      } catch (e) {
        if (isUnauthorizedError(e)) {
          redirectToLogin();
          return;
        }
        const code = e instanceof SupplierLinkHttpError ? e.code : "";
        if (code === "STALE_VERSION" || code === "SUGGESTION_STALE" || code === "NOT_LINKED") {
          setReloadKey((k) => k + 1);
          setMessage({ tone: "info", text: "השיוך השתנה בינתיים — מוצג המצב העדכני. אפשר לבחור שוב." });
        } else {
          setMessage({ tone: "error", text: "הפעולה לא נשמרה. נסו שוב." });
        }
      } finally {
        setBusy(false);
      }
    },
    [documentId]
  );

  if (!enabled) return null;

  const link = state?.link ?? null;
  const version = state?.version ?? 0;

  const accept = (s: SupplierSuggestion) =>
    run(
      {
        action: "link",
        supplierId: s.supplierId,
        method: "SUGGESTION_ACCEPTED",
        suggestionReason: s.reason,
        expectedVersion: version,
        idempotencyKey: newIdempotencyKey(),
      },
      `המסמך שויך ל־${s.name}.`
    );
  const dismiss = (s: SupplierSuggestion) =>
    run({ action: "dismiss", supplierId: s.supplierId, idempotencyKey: newIdempotencyKey() });
  const pick = (s: SupplierListRow) =>
    run(
      {
        action: "link",
        supplierId: s.id,
        method: "MANUAL_PICK",
        expectedVersion: version,
        idempotencyKey: newIdempotencyKey(),
      },
      `המסמך שויך ל־${s.name}.`
    );
  const unlink = () =>
    run({ action: "unlink", expectedVersion: version, idempotencyKey: newIdempotencyKey() }, "השיוך הוסר. המסמך עצמו לא השתנה.");

  return (
    <section style={{ ...reviewCard, display: "flex", flexDirection: "column", gap: 12 }} data-testid="review-supplier-link">
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: TOKEN.font.title, fontWeight: TOKEN.weight.semibold }}>ספק</h2>
      </div>

      {state ? (
        state.reading?.vendorIdentified && state.reading.vendorName ? (
          <p style={small}>זוהה במסמך: {state.reading.vendorName}</p>
        ) : (
          <p style={small} data-testid="vendor-uncertain">לא זוהה ספק בוודאות — אפשר לבחור ספק ידנית</p>
        )
      ) : null}

      {state?.reading?.ownBusinessExcluded ? (
        <p style={small}>פרטי העסק שלך הופיעו במסמך (כנמען) ולא נבחרו כספק.</p>
      ) : null}

      {!state ? (
        <p style={small}>טוען…</p>
      ) : link ? (
        <div style={row}>
          <div style={{ minWidth: 0 }}>
            <Link href={`/suppliers/${link.supplierId}`} style={{ fontWeight: TOKEN.weight.semibold, color: TOKEN.brand.mid }}>
              {link.supplierName}
            </Link>
            {!link.supplierActive ? <span style={pill("attention")}>ספק לא פעיל</span> : null}
            <p style={small}>
              {link.method === "SUGGESTION_ACCEPTED" ? "שויך מהצעה" : "שויך ידנית"} · המסמך מופיע בתיק הספק
            </p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" style={btn} disabled={busy} onClick={() => setPicking((v) => !v)}>
              החלפת ספק
            </button>
            <button type="button" style={btn} disabled={busy} onClick={() => void unlink()}>
              הסרת השיוך
            </button>
          </div>
        </div>
      ) : (
        <>
          {state.suggestions.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <p style={small}>הצעות שיוך — שום דבר לא משויך בלי אישורך:</p>
              {state.suggestions.map((s) => (
                <div key={s.supplierId} style={row} data-testid="supplier-suggestion">
                  <div style={{ minWidth: 0 }}>
                    <span style={{ fontWeight: TOKEN.weight.semibold }}>{s.name}</span>
                    <span style={pill(s.strength === "STRONG" ? "success" : "attention")}>
                      {s.strength === "STRONG" ? "התאמה לפי מספר עוסק" : "התאמה לפי שם"}
                    </span>
                    {!s.isActive ? <span style={pill("attention")}>ספק לא פעיל</span> : null}
                    <p style={small}>{REASON_TEXT[s.reason]}</p>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button type="button" style={btnPrimary} disabled={busy} onClick={() => void accept(s)}>
                      שיוך לספק הזה
                    </button>
                    <button type="button" style={btn} disabled={busy} onClick={() => void dismiss(s)}>
                      לא הספק הזה
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p style={small}>לא נמצאה הצעת שיוך. אפשר לבחור ספק מהרשימה.</p>
          )}
          <div>
            <button type="button" style={btn} disabled={busy} onClick={() => setPicking((v) => !v)}>
              {state.suggestions.length > 0 ? "בחירת ספק אחר" : "בחירת ספק"}
            </button>
          </div>
        </>
      )}

      {state?.notes.map((n) =>
        NOTE_TEXT[n] ? (
          <p key={n} style={small}>
            {NOTE_TEXT[n]}
          </p>
        ) : null
      )}

      {picking ? <SupplierPicker busy={busy} excludeId={link?.supplierId ?? null} onPick={(s) => void pick(s)} /> : null}

      {message ? (
        <p
          role={message.tone === "error" ? "alert" : "status"}
          style={{ ...small, color: message.tone === "error" ? TOKEN.semantic.urgent.ink : TOKEN.ink.primary }}
        >
          {message.text}
        </p>
      ) : null}
    </section>
  );
}

function SupplierPicker({
  busy,
  excludeId,
  onPick,
}: {
  busy: boolean;
  excludeId: number | null;
  onPick: (s: SupplierListRow) => void;
}) {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<SupplierListRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    const handle = setTimeout(async () => {
      try {
        const found = await getSuppliers({ query, status: "all" });
        if (mine !== seq.current) return;
        setFailed(false);
        setRows(found.filter((s) => s.id !== excludeId));
      } catch (e) {
        if (mine !== seq.current) return;
        if (isUnauthorizedError(e)) {
          redirectToLogin();
          return;
        }
        setFailed(true);
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [query, excludeId]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }} data-testid="supplier-picker">
      <input
        style={{ ...reviewInput, minHeight: 44, fontSize: TOKEN.font.body }}
        placeholder="חיפוש ספק לפי שם, טלפון או מספר עוסק"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
      />
      {failed ? (
        <p style={{ ...small, color: TOKEN.semantic.urgent.ink }}>החיפוש נכשל. נסו שוב.</p>
      ) : rows === null ? (
        <p style={small}>מחפש…</p>
      ) : rows.length === 0 ? (
        <p style={small}>לא נמצא ספק. ספק חדש נוצר במסך הספקים — המסמך לא יוצר ספק לבד.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 280, overflowY: "auto" }}>
          {rows.map((s) => (
            <button
              key={s.id}
              type="button"
              disabled={busy}
              onClick={() => onPick(s)}
              style={{ ...row, cursor: "pointer", textAlign: "start", font: "inherit", color: TOKEN.ink.primary }}
            >
              <span style={{ fontWeight: TOKEN.weight.semibold }}>
                {s.name}
                {!s.isActive ? <span style={pill("attention")}>לא פעיל</span> : null}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
