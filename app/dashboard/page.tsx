"use client";

import { useEffect, useState } from "react";
import BackButton from "@/components/ui/back-button";
import { buildClientAuthHeaders } from "@/lib/client-session";
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";

type Report = {
  totalIncome: number;
  totalExpense: number;
  profit: number;
  categories: Record<string, number>;
  count: number;
};

export default function Dashboard() {
  const [data, setData] = useState<Report | null>(null);

  const [direction, setDirection] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const [loadFailed, setLoadFailed] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportFailed, setExportFailed] = useState(false);

  // Both calls carry the session's Bearer token. A plain link (<a href="/api/reports/export">) is a page
  // navigation, which never sends it — the server answered 401 (fix series issue 5).
  const fetchData = async () => {
    const params = new URLSearchParams();

    if (direction) params.append("direction", direction);
    if (from) params.append("from", from);
    if (to) params.append("to", to);

    try {
      const res = await fetch(`/api/reports/summary?${params.toString()}`, { headers: buildClientAuthHeaders() });
      if (!res.ok) {
        setLoadFailed(true);
        return;
      }
      const result = await res.json();
      setLoadFailed(false);
      setData(result);
    } catch {
      setLoadFailed(true);
    }
  };

  const exportCsv = async () => {
    setExporting(true);
    setExportFailed(false);
    try {
      const res = await fetch("/api/reports/export", { headers: buildClientAuthHeaders() });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "financial-records.csv";
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setExportFailed(true);
    } finally {
      setExporting(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  if (!data) return <div>{loadFailed ? "Could not load the report." : "Loading..."}</div>;

  const categoryData = Object.entries(data.categories).map(
    ([name, value]) => ({
      name,
      value,
    })
  );

  const barData = [
    { name: "Income", value: data.totalIncome },
    { name: "Expense", value: data.totalExpense },
  ];

  return (
    <div className="dash-frame" style={{ maxWidth: 500, margin: "0 auto", padding: 20 }}>
      <style>{`
        @media (min-width: 1200px) {
          .dash-frame { max-width: 1100px !important; }
          .dash-charts { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; align-items: start; }
        }
      `}</style>
      <div style={{ marginBottom: 16 }}>
        <BackButton />
      </div>
      <h1>📊 Dashboard</h1>

      {/* Filters */}
      <div style={{ marginBottom: 20 }}>
        <select onChange={(e) => setDirection(e.target.value)}>
          <option value="">All</option>
          <option value="expense">Expenses</option>
          <option value="income">Income</option>
        </select>

        <input type="date" onChange={(e) => setFrom(e.target.value)} />
        <input type="date" onChange={(e) => setTo(e.target.value)} />

        <button
          style={{ width: "100%", padding: 10, marginTop: 10 }}
          onClick={fetchData}
        >
          Filter
        </button>
      </div>

      {/* Export */}
      <button
        type="button"
        style={{ width: "100%", padding: 10, marginBottom: exportFailed ? 8 : 20 }}
        onClick={exportCsv}
        disabled={exporting}
      >
        📤 Export CSV
      </button>
      {exportFailed && <p style={{ marginTop: 0, marginBottom: 20 }}>Export failed. Try again.</p>}

      {/* Summary */}
      <h2>💰 Profit: {data.profit}</h2>
      <p>Income: {data.totalIncome}</p>
      <p>Expense: {data.totalExpense}</p>
      <p>Records: {data.count}</p>

      <div className="dash-charts">
      {/* Pie Chart */}
      <div>
      <h3>Categories</h3>
      <PieChart width={300} height={300}>
        <Pie data={categoryData} dataKey="value" outerRadius={100}>
          {categoryData.map((_, i) => (
            <Cell key={i} />
          ))}
        </Pie>
        <Tooltip />
      </PieChart>
      </div>

      {/* Bar Chart */}
      <div>
      <h3>Income vs Expense</h3>
      <BarChart width={300} height={250} data={barData}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="name" />
        <YAxis />
        <Tooltip />
        <Bar dataKey="value" />
      </BarChart>
      </div>
      </div>

      {/* List */}
      <h3>Categories List</h3>
      <ul>
        {categoryData.map((item) => (
          <li key={item.name}>
            {item.name}: {item.value}
          </li>
        ))}
      </ul>
    </div>
  );
}