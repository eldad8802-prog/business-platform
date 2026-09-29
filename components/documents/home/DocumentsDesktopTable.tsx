"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { InboxListItem } from "@/lib/documents/inbox-types";
import { CATEGORY_MAP } from "@/lib/constants/categories";
import { formatMoney } from "./home-format";

function formatShortDate(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("he-IL", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function kindLabel(item: InboxListItem): string {
  if (item.preview.kind === "pdf") return "PDF";
  if (item.preview.kind === "image") return "תמונה";
  return "קובץ";
}

function statusLabel(status: string): { text: string; ok: boolean } {
  if (status === "needs_review") return { text: "ממתין", ok: false };
  if (status === "approved" || status === "verified") return { text: "אושר", ok: true };
  return { text: status || "—", ok: false };
}

/**
 * Dense document list for the desktop workspace. Hidden below 1200px by
 * `.dz-docs-table { display: none }` — mobile keeps the station/card flow.
 */
export default function DocumentsDesktopTable({
  items,
  loading,
  error,
  onRetry,
}: {
  items: InboxListItem[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selected = items.find((item) => item.documentId === selectedId) ?? null;

  return (
    <div className="dz-docs-work">
    <section className="dz-docs-table" aria-label="רשימת מסמכים">
      {loading ? <p className="dz-docs-empty">טוען מסמכים…</p> : null}
      {!loading && error ? (
        <div className="dz-docs-empty">
          <p>{error}</p>
          <button type="button" onClick={onRetry}>
            נסה שוב
          </button>
        </div>
      ) : null}
      {!loading && !error && items.length === 0 ? (
        <p className="dz-docs-empty">אין מסמכים להצגה בחודש הזה.</p>
      ) : null}
      {!loading && !error && items.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>מסמך</th>
              <th>סוג</th>
              <th>ספק / לקוח</th>
              <th>תאריך</th>
              <th>סכום</th>
              <th>סטטוס</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const vendor =
                item.financial?.vendorName ?? item.extracted?.vendorName ?? "לא צוין";
              const amountRaw = item.financial?.amount ?? item.extracted?.amount ?? null;
              const dateIso = item.financial?.date ?? item.extracted?.date ?? item.createdAt;
              const status = statusLabel(item.status);
              return (
                <tr
                  key={item.documentId}
                  className={item.documentId === selectedId ? "is-selected" : undefined}
                  onClick={() => setSelectedId(item.documentId)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelectedId(item.documentId);
                    }
                  }}
                  tabIndex={0}
                >
                  <td>{vendor}</td>
                  <td>{kindLabel(item)}</td>
                  <td>{vendor}</td>
                  <td className="num">{formatShortDate(dateIso)}</td>
                  <td className="num">
                    {amountRaw != null && Number.isFinite(amountRaw) ? formatMoney(amountRaw) : "—"}
                  </td>
                  <td>
                    <span className={status.ok ? "dz-docs-pill dz-docs-pill--ok" : "dz-docs-pill"}>
                      {status.text}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
    </section>
    <aside className="dz-docs-inspector" aria-label="המסמך שנבחר">
      {selected ? (
        <HubInspector item={selected} onOpen={() => router.push(`/documents/review/${selected.documentId}`)} />
      ) : (
        <p>
          {items.length === 0
            ? "כשייכנסו מסמכים הם יופיעו ברשימה, ואפשר לבחור אחד בלי לצאת מהמרכז."
            : "בחרו מסמך מהרשימה כדי לראות ספק, סכום וסטטוס, ואז לפתוח אותו לאימות."}
        </p>
      )}
    </aside>
    </div>
  );
}

function HubInspector({ item, onOpen }: { item: InboxListItem; onOpen: () => void }) {
  const vendor = item.financial?.vendorName ?? item.extracted?.vendorName ?? "לא צוין";
  const amountRaw = item.financial?.amount ?? item.extracted?.amount ?? null;
  const dateIso = item.financial?.date ?? item.extracted?.date ?? item.createdAt;
  const categoryRaw = item.financial?.category ?? item.extracted?.category ?? "";
  const category = categoryRaw ? CATEGORY_MAP[categoryRaw] ?? categoryRaw : "כללי";
  const status = statusLabel(item.status);
  return (
    <>
      <h2>{vendor}</h2>
      <dl>
        <dt>תאריך</dt>
        <dd>{formatShortDate(dateIso)}</dd>
        <dt>קטגוריה</dt>
        <dd>{category}</dd>
        <dt>סכום</dt>
        <dd>{amountRaw != null && Number.isFinite(amountRaw) ? formatMoney(amountRaw) : "—"}</dd>
        <dt>סטטוס</dt>
        <dd>{status.text}</dd>
        <dt>מקור</dt>
        <dd>{item.source || "—"}</dd>
      </dl>
      <button type="button" onClick={onOpen}>
        פתח לאימות
      </button>
    </>
  );
}
