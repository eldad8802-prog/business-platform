"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { InventorySubPage } from "@/components/inventory/inventory-shell";
import {
  FilterChipRow,
  DecisionCard,
  InventoryBadge,
  InventoryStatePanel,
  InventorySkeletonBlock,
} from "@/components/inventory/inventory-design";

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

type StatusFilter = "ALL" | "APPROVED" | "REJECTED";

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
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
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
      sub={
        !loading && !error
          ? summary.total > 0
            ? `${summary.approved} נקלטו · ${summary.rejected} בוטלו`
            : "אין עדיין הזמנות קודמות"
          : undefined
      }
      bottomNav="orders"
    >
      <FilterChipRow<StatusFilter>
        value={statusFilter}
        onChange={(value) => {
          setStatusFilter(value);
          setVisibleCount(5);
        }}
        options={[
          { value: "ALL", label: "הכול" },
          { value: "APPROVED", label: "נקלטו" },
          { value: "REJECTED", label: "בוטלו" },
        ]}
      />

      {error ? (
        <div className="inv-page-content" style={{ padding: "0 clamp(16px,3.5vw,28px)" }}>
          <InventoryStatePanel
            tone="error"
            title="שגיאת שרת"
            action={
              <button type="button" className="inv-btn-primary inv-btn-primary--full" onClick={() => void load()}>
                נסה שוב
              </button>
            }
          >
            {error}
          </InventoryStatePanel>
        </div>
      ) : loading ? (
        <div className="inv-rows">
          <InventorySkeletonBlock height={84} rows={4} />
        </div>
      ) : visible.length === 0 ? (
        <div className="inv-page-content" style={{ padding: "0 clamp(16px,3.5vw,28px)" }}>
          <InventoryStatePanel
            title="אין הזמנות להצגה"
            action={
              <Link href="/inventory/supplier-purchases/new" className="inv-btn-primary inv-btn-primary--full">
                יצירת הזמנה
              </Link>
            }
          >
            אפשר לשנות סינון או ליצור הזמנה חדשה לספק. כל הזמנה שנקלטה או בוטלה נשמרת כאן.
          </InventoryStatePanel>
        </div>
      ) : (
        <div className="inv-rows">
          {visible.map((draft) => {
            const isOpen = openId === draft.id;
            const totalUnits = draft.lines.reduce((s, l) => s + l.quantity, 0);
            const approved = draft.status === "APPROVED";
            return (
              <DecisionCard key={draft.id}>
                <div className="inv-dcard__top">
                  <span
                    className="inv-row__thumb"
                    style={{ background: "var(--inv-surface, #f5f7f9)", width: 46, height: 46, fontSize: 22 }}
                    aria-hidden
                  >
                    🚚
                  </span>
                  <div className="inv-row__mid">
                    <div className="inv-row__nm" dir="auto">{draft.supplierName || "הזמנה ללא ספק"}</div>
                    <div className="inv-row__meta">
                      <bdi>#{draft.id}</bdi> · <bdi>{formatDate(draft.createdAt)}</bdi> · <bdi>{draft.lines.length}</bdi> מוצרים · <bdi>{totalUnits}</bdi> יחידות
                    </div>
                  </div>
                  <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 7 }}>
                    <InventoryBadge tone={approved ? "ok" : "neutral"}>{statusLabel(draft.status)}</InventoryBadge>
                    <button type="button" className="inv-row__action" onClick={() => setOpenId(isOpen ? null : draft.id)}>
                      {isOpen ? "הסתר" : "פרטים ›"}
                    </button>
                  </span>
                </div>

                {isOpen ? (
                  <div className="inv-olines" style={{ marginTop: 12 }}>
                    {draft.lines.map((line) => (
                      <div key={line.id} className="inv-oline">
                        <div className="inv-oline__mid">
                          <div className="inv-oline__nm" dir="auto">{line.rawName || "מוצר ללא שם"}</div>
                        </div>
                        <span className="inv-oline__price"><bdi>{line.quantity}</bdi> יחידות</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </DecisionCard>
            );
          })}

          {filtered.length > visibleCount ? (
            <button
              type="button"
              onClick={() => setVisibleCount((p) => p + 5)}
              className="inv-btn-secondary"
              style={{ width: "100%", marginTop: 4 }}
            >
              הצג עוד הזמנות
            </button>
          ) : null}
        </div>
      )}
    </InventorySubPage>
  );
}
