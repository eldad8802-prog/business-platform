"use client";

import { useEffect, useMemo, useState } from "react";
import PageHeader from "@/components/ui/page-header";

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

export default function SupplierHistoryPage() {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);

  const [statusFilter, setStatusFilter] = useState<
    "ALL" | "APPROVED" | "REJECTED"
  >("ALL");

  const [visibleCount, setVisibleCount] = useState(5);
  const [loading, setLoading] = useState(true);

  async function load() {
    const res = await fetch("/api/inventory/supplier-purchases", {
      headers: buildHeaders(),
    });

    const data = await res.json();

    const history = (data?.drafts || []).filter(
      (d: Draft) => d.status === "APPROVED" || d.status === "REJECTED"
    );

    setDrafts(history);
    setLoading(false);
  }

  useEffect(() => {
    load();
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

  function toggle(id: number) {
    setOpenId((p) => (p === id ? null : id));
  }

  function getStatusLabel(status: string) {
    if (status === "APPROVED") return "נקלט למלאי";
    if (status === "REJECTED") return "נדחה";
    return status;
  }

  function getStatusStyle(status: string) {
    if (status === "APPROVED")
      return { background: "#ecfdf5", color: "#065f46" };
    if (status === "REJECTED")
      return { background: "#fef2f2", color: "#7f1d1d" };
    return { background: "#f3f4f6", color: "#374151" };
  }

  if (loading) {
    return (
      <div dir="rtl" style={{ minHeight: "100vh", background: "#f8fafc" }}>
        <PageHeader title="הזמנות קודמות" />
        <main style={{ maxWidth: 980, margin: "0 auto", padding: 16 }}>
          טוען היסטוריה...
        </main>
      </div>
    );
  }

  return (
    <div dir="rtl" style={{ minHeight: "100vh", background: "#f8fafc" }}>
      <PageHeader title="הזמנות קודמות" />

      <main
        style={{
          maxWidth: 980,
          margin: "0 auto",
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 18,
        }}
      >
        {/* HERO */}
        <section
          style={{
            borderRadius: 30,
            padding: 24,
            background:
              "linear-gradient(135deg, #111827 0%, #1f2937 50%, #0f766e 100%)",
            color: "#ffffff",
            boxShadow: "0 18px 44px rgba(15, 23, 42, 0.22)",
          }}
        >
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, opacity: 0.8, fontWeight: 800 }}>
              היסטוריית הזמנות
            </div>

            <h1 style={{ margin: 0, fontSize: 28, fontWeight: 950 }}>
              {summary.total > 0
                ? `יש לך ${summary.total} הזמנות מתועדות`
                : "עדיין אין הזמנות קודמות"}
            </h1>

            <p style={{ marginTop: 6, fontSize: 14, opacity: 0.85 }}>
              כל הזמנה נשמרת — מה נקלט ומה בוטל, כדי לשמור שליטה מלאה.
            </p>
          </div>

          <div style={{ display: "flex", gap: 20 }}>
            <div>
              <div style={{ fontSize: 12 }}>נקלטו</div>
              <div style={{ fontSize: 24, fontWeight: 900 }}>
                {summary.approved}
              </div>
            </div>

            <div>
              <div style={{ fontSize: 12 }}>נדחו</div>
              <div style={{ fontSize: 24, fontWeight: 900 }}>
                {summary.rejected}
              </div>
            </div>
          </div>
        </section>

        {/* FILTER CARD */}
        <section
          style={{
            background: "#fff",
            padding: 12,
            borderRadius: 18,
            display: "flex",
            gap: 8,
          }}
        >
          {[
            { key: "ALL", label: "הכול" },
            { key: "APPROVED", label: "נקלטו" },
            { key: "REJECTED", label: "נדחו" },
          ].map((f) => (
            <button
              key={f.key}
              onClick={() => {
                setStatusFilter(f.key as any);
                setVisibleCount(5);
              }}
              style={{
                flex: 1,
                padding: "10px",
                borderRadius: 12,
                border: "none",
                background:
                  statusFilter === f.key ? "#111827" : "#f3f4f6",
                color:
                  statusFilter === f.key ? "#fff" : "#111827",
                fontWeight: 900,
                cursor: "pointer",
              }}
            >
              {f.label}
            </button>
          ))}
        </section>

        {/* EMPTY */}
        {visible.length === 0 && (
          <section
            style={{
              background: "#fff",
              borderRadius: 22,
              padding: 30,
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: 40 }}>📦</div>
            <div style={{ fontWeight: 900, marginTop: 10 }}>
              אין הזמנות להצגה
            </div>
            <div style={{ fontSize: 14, color: "#6b7280" }}>
              נסה לשנות פילטר או ליצור הזמנה חדשה
            </div>
          </section>
        )}

        {/* LIST */}
        {visible.map((draft) => {
          const isOpen = openId === draft.id;
          const totalUnits = draft.lines.reduce(
            (s, l) => s + l.quantity,
            0
          );

          return (
            <article
              key={draft.id}
              style={{
                background: "#fff",
                borderRadius: 22,
                padding: 18,
                boxShadow: "0 6px 18px rgba(15,23,42,0.05)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <div>
                  <div style={{ fontWeight: 900, fontSize: 16 }}>
                    {draft.supplierName || "ללא ספק"}
                  </div>

                  <div style={{ fontSize: 13, color: "#6b7280" }}>
                    {draft.lines.length} מוצרים · {totalUnits} יחידות
                  </div>
                </div>

                <span
                  style={{
                    borderRadius: 999,
                    padding: "6px 10px",
                    fontSize: 12,
                    fontWeight: 900,
                    ...getStatusStyle(draft.status),
                  }}
                >
                  {getStatusLabel(draft.status)}
                </span>
              </div>

              <button
                onClick={() => toggle(draft.id)}
                style={{
                  marginTop: 12,
                  border: "none",
                  background: "#f3f4f6",
                  borderRadius: 12,
                  padding: "8px 12px",
                  fontWeight: 900,
                  cursor: "pointer",
                }}
              >
                {isOpen ? "הסתר פרטים" : "צפה בפרטים"}
              </button>

              {isOpen && (
                <div style={{ marginTop: 12 }}>
                  {draft.lines.map((l) => (
                    <div
                      key={l.id}
                      style={{
                        border: "1px solid #e5e7eb",
                        borderRadius: 14,
                        padding: 10,
                        marginBottom: 8,
                      }}
                    >
                      <div style={{ fontWeight: 900 }}>
                        {l.rawName}
                      </div>

                      <div style={{ fontSize: 13 }}>
                        כמות: {l.quantity}
                      </div>

                      {l.decision && (
                        <div
                          style={{
                            marginTop: 4,
                            fontSize: 12,
                            color: "#6b7280",
                          }}
                        >
                          {l.decision}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </article>
          );
        })}

        {/* LOAD MORE */}
        {filtered.length > visibleCount && (
          <button
            onClick={() => setVisibleCount((p) => p + 5)}
            style={{
              border: "none",
              background: "#111827",
              color: "#fff",
              borderRadius: 16,
              padding: 14,
              fontWeight: 900,
              cursor: "pointer",
            }}
          >
            הצג עוד הזמנות
          </button>
        )}
      </main>
    </div>
  );
}