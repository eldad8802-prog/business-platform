"use client";

import { useEffect, useState } from "react";
import {
  card,
  primaryBtn,
  pageMain,
  hero,
  heroKicker,
  heroTitle,
  heroSubText,
  alertError,
  emptyState,
} from "../ui";
import { CATEGORY_MAP } from "@/lib/constants/categories";
import PageHeader from "@/components/ui/page-header";

type Report = {
  totalIncome: number;
  totalExpense: number;
  profit: number;
  categories: Record<string, number>;
  count: number;
};

export default function Dashboard() {
  const [data, setData] = useState<Report | null>(null);
  const [month, setMonth] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchData = async (selectedMonth?: string) => {
    try {
      setLoading(true);
      setError("");

      const url = selectedMonth
        ? `/api/reports/summary?month=${selectedMonth}`
        : `/api/reports/summary`;

      const res = await fetch(url);
      const result = await res.json();

      if (!res.ok) {
        throw new Error(result?.error || "Failed to load report");
      }

      setData(result);
    } catch (e: any) {
      setError(e?.message || "שגיאה בטעינת הדוח");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  if (loading) {
    return (
      <div dir="rtl">
        <PageHeader title="דוחות" />
        <main style={pageMain}>
          <section style={hero}>
            <div style={heroKicker}>דוחות</div>
            <h1 style={heroTitle}>תמונת מצב</h1>
            <p style={heroSubText}>רגע לפני החלטות — הנה המספרים.</p>
          </section>
          <div style={emptyState}>טוען דוח...</div>
        </main>
      </div>
    );
  }

  if (error) {
    return (
      <div dir="rtl">
        <PageHeader title="דוחות" />
        <main style={pageMain}>
          <section style={hero}>
            <div style={heroKicker}>דוחות</div>
            <h1 style={heroTitle}>תמונת מצב</h1>
            <p style={heroSubText}>אפשר לנסות שוב בעוד רגע.</p>
          </section>
          <div style={alertError}>{error}</div>
        </main>
      </div>
    );
  }

  if (!data) {
    return (
      <div dir="rtl">
        <PageHeader title="דוחות" />
        <main style={pageMain}>
          <section style={hero}>
            <div style={heroKicker}>דוחות</div>
            <h1 style={heroTitle}>תמונת מצב</h1>
            <p style={heroSubText}>אין נתונים להצגה כרגע.</p>
          </section>
          <div style={emptyState}>אין נתונים להצגה</div>
        </main>
      </div>
    );
  }

  return (
    <div dir="rtl">
      <PageHeader title="דוחות" />

      <main style={pageMain}>
        <section style={hero}>
          <div style={heroKicker}>דוחות</div>
          <h1 style={heroTitle}>מצב פיננסי</h1>
          <p style={heroSubText}>הכנסות, הוצאות ורווח — לפי חודש.</p>
        </section>

        <div style={card}>
          <div style={{ fontWeight: 950, marginBottom: 10, color: "#111827" }}>
            דוח חודשי
          </div>
        <input
          type="month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          style={{
            width: "100%",
            padding: 12,
            borderRadius: 14,
            border: "1px solid #d1d5db",
            fontSize: 16,
            boxSizing: "border-box",
          }}
        />

        <button style={primaryBtn} onClick={() => fetchData(month)}>
          הצג דוח
        </button>
      </div>

      <div style={card}>
        <div style={{ fontWeight: 950, marginBottom: 10, color: "#111827" }}>
          רווח
        </div>
        <div style={{ fontSize: 30, fontWeight: 950, color: "#111827" }}>
          {data.profit}
        </div>
      </div>

      <div style={card}>
        <div style={{ display: "grid", gap: 8, color: "#111827", fontWeight: 800 }}>
          <div>הכנסות: {data.totalIncome}</div>
          <div>הוצאות: {data.totalExpense}</div>
          <div>רשומות: {data.count}</div>
        </div>
      </div>

      <div style={card}>
        <div style={{ fontWeight: 950, marginBottom: 10, color: "#111827" }}>
          קטגוריות
        </div>

        {Object.keys(data.categories).length === 0 ? (
          <div style={{ color: "#6b7280" }}>אין קטגוריות להצגה</div>
        ) : (
          <ul style={{ margin: 0, paddingInlineStart: 18 }}>
            {Object.entries(data.categories).map(([cat, val]) => (
              <li key={cat} style={{ marginBottom: 6 }}>
                {CATEGORY_MAP[cat] || cat}: {val}
              </li>
            ))}
          </ul>
        )}
      </div>
      </main>
    </div>
  );
}