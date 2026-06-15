"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { InventorySubPage } from "@/components/inventory/inventory-shell";

type DraftLine = {
  id: number;
  rawName: string | null;
  quantity: number;
  decision?: string | null;
};

type Draft = {
  id: number;
  supplierName: string | null;
  status: "APPROVED" | "REJECTED" | string;
  createdAt?: string;
  lines: DraftLine[];
};

function buildHeaders() {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;

  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function statusLabel(status: string) {
  if (status === "APPROVED") return "נקלט למלאי";
  if (status === "REJECTED") return "בוטל";
  return status;
}

function formatDate(value?: string) {
  if (!value) return "ללא תאריך";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "ללא תאריך";
  return date.toLocaleDateString("he-IL", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export default function SupplierHistoryPage() {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] = useState<
    "ALL" | "APPROVED" | "REJECTED"
  >("ALL");
  const [visibleCount, setVisibleCount] = useState(5);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch("/api/inventory/supplier-purchases", {
        headers: buildHeaders(),
        cache: "no-store",
      });

      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error || "לא הצלחנו לטעון היסטוריה");
      }

      const history = (data?.drafts || []).filter(
        (d: Draft) => d.status === "APPROVED" || d.status === "REJECTED"
      );

      setDrafts(history);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "שגיאה בטעינת היסטוריה");
      setDrafts([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    queueMicrotask(() => {
      void load();
    });
  }, []);

  const filtered = useMemo(() => {
    if (statusFilter === "ALL") return drafts;
    return drafts.filter((d) => d.status === statusFilter);
  }, [drafts, statusFilter]);

  const visible = filtered.slice(0, visibleCount);

  const summary = useMemo(() => {
    return {
      total: drafts.length,
      approved: drafts.filter((d) => d.status === "APPROVED").length,
      rejected: drafts.filter((d) => d.status === "REJECTED").length,
    };
  }, [drafts]);

  return (
    <InventorySubPage
      title="היסטוריית הזמנות"
      backHref="/inventory/supplier-purchases"
      backLabel="מרכז הזמנות ספק"
      bottomNav="orders"
    >
      <div className="inv-screen-stack">
        <section className="inv-hero-card inv-hero-card--green">
          <span className="inv-kicker">היסטוריה</span>
          <h1>
            {summary.total > 0
              ? `${summary.total} הזמנות מתועדות`
              : "אין עדיין הזמנות קודמות"}
          </h1>
          <p>כל הזמנה שנקלטה או בוטלה נשמרת כאן לבדיקת רצף ההזמנות.</p>
        </section>

        <section className="inv-surface-card">
          <div className="inv-data-pairs">
            <div>
              <span>נקלטו</span>
              <strong>{summary.approved}</strong>
            </div>
            <div>
              <span>בוטלו</span>
              <strong>{summary.rejected}</strong>
            </div>
          </div>
          <div className="inv-tabs-soft" role="tablist" aria-label="סינון היסטוריה">
            {[
              { key: "ALL", label: "הכול" },
              { key: "APPROVED", label: "נקלטו" },
              { key: "REJECTED", label: "בוטלו" },
            ].map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => {
                  setStatusFilter(f.key as typeof statusFilter);
                  setVisibleCount(5);
                }}
                className={statusFilter === f.key ? "is-active" : ""}
              >
                {f.label}
              </button>
            ))}
          </div>
        </section>

        {loading ? (
          <section className="inv-surface-card inv-center-state" aria-busy="true">
            טוען היסטוריה...
          </section>
        ) : error ? (
          <section className="inv-surface-card inv-center-state">
            <strong>שגיאת שרת</strong>
            <p>{error}</p>
            <button type="button" className="inv-primary-button" onClick={() => void load()}>
              נסה שוב
            </button>
          </section>
        ) : visible.length === 0 ? (
          <section className="inv-surface-card inv-center-state">
            <strong>אין הזמנות להצגה</strong>
            <p>אפשר לשנות סינון או ליצור הזמנה חדשה לספק.</p>
            <Link
              href="/inventory/supplier-purchases/new"
              className="inv-primary-button"
            >
              יצירת הזמנה
            </Link>
          </section>
        ) : (
          <section className="inv-screen-stack" aria-label="רשימת הזמנות">
            {visible.map((draft) => {
              const isOpen = openId === draft.id;
              const totalUnits = draft.lines.reduce(
                (s, l) => s + l.quantity,
                0
              );

              return (
                <article key={draft.id} className="inv-surface-card">
                  <div className="inv-row-card-head">
                    <div>
                      <span className="inv-status-pill">
                        {statusLabel(draft.status)}
                      </span>
                      <h2>{draft.supplierName || "הזמנה ללא ספק"}</h2>
                      <p>
                        #{draft.id} · {formatDate(draft.createdAt)} ·{" "}
                        {draft.lines.length} מוצרים · {totalUnits} יחידות
                      </p>
                    </div>
                    <button
                      type="button"
                      className="inv-secondary-button"
                      onClick={() => setOpenId(isOpen ? null : draft.id)}
                    >
                      {isOpen ? "הסתר" : "פרטים"}
                    </button>
                  </div>

                  {isOpen ? (
                    <ul className="inv-simple-list" role="list">
                      {draft.lines.map((line) => (
                        <li key={line.id}>
                          <span>{line.rawName || "מוצר ללא שם"}</span>
                          <strong>{line.quantity} יחידות</strong>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </article>
              );
            })}
          </section>
        )}

        {filtered.length > visibleCount ? (
          <button
            type="button"
            onClick={() => setVisibleCount((p) => p + 5)}
            className="inv-secondary-button"
          >
            הצג עוד הזמנות
          </button>
        ) : null}
      </div>
    </InventorySubPage>
  );
}
