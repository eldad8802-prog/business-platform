"use client";

import { useEffect, useState } from "react";
import {
  header,
  subheader,
  card,
  primaryBtn,
  emptyState,
} from "../ui";
import { CATEGORY_MAP } from "@/lib/constants/categories";

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
    return <div style={emptyState}>טוען דוח...</div>;
  }

  if (error) {
    return <div style={emptyState}>{error}</div>;
  }

  if (!data) {
    return <div style={emptyState}>אין נתונים להצגה</div>;
  }

  return (
    <div>
      <h1 style={header}>מצב פיננסי</h1>
      <p style={subheader}>כאן רואים הכנסות, הוצאות ורווח לפי חודש</p>

      <div style={card}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>📅 דוח חודשי</div>
        <input
          type="month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          style={{
            width: "100%",
            padding: 12,
            borderRadius: 10,
            border: "1px solid #ddd",
            fontSize: 16,
            boxSizing: "border-box",
          }}
        />

        <button style={primaryBtn} onClick={() => fetchData(month)}>
          הצג דוח
        </button>
      </div>

      <div style={card}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>💰 רווח</div>
        <div style={{ fontSize: 28, fontWeight: 700 }}>{data.profit}</div>
      </div>

      <div style={card}>
        <div style={{ marginBottom: 8 }}>📈 הכנסות: {data.totalIncome}</div>
        <div style={{ marginBottom: 8 }}>📉 הוצאות: {data.totalExpense}</div>
        <div>🧾 רשומות: {data.count}</div>
      </div>

      <div style={card}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>📂 קטגוריות</div>

        {Object.keys(data.categories).length === 0 ? (
          <div style={{ color: "#666" }}>אין קטגוריות להצגה</div>
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
    </div>
  );
}