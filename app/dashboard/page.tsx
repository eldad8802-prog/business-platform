"use client";

import { useEffect, useState } from "react";
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

  const fetchData = async () => {
    const params = new URLSearchParams();

    if (direction) params.append("direction", direction);
    if (from) params.append("from", from);
    if (to) params.append("to", to);

    const res = await fetch(`/api/reports/summary?${params.toString()}`);
    const result = await res.json();

    setData(result);
  };

  useEffect(() => {
    fetchData();
  }, []);

  if (!data) return <div>Loading...</div>;

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
    <div style={{ maxWidth: 500, margin: "0 auto", padding: 20 }}>
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
      <a href="/api/reports/export">
        <button style={{ width: "100%", padding: 10, marginBottom: 20 }}>
          📤 Export CSV
        </button>
      </a>

      {/* Summary */}
      <h2>💰 Profit: {data.profit}</h2>
      <p>Income: {data.totalIncome}</p>
      <p>Expense: {data.totalExpense}</p>
      <p>Records: {data.count}</p>

      {/* Pie Chart */}
      <h3>Categories</h3>
      <PieChart width={300} height={300}>
        <Pie data={categoryData} dataKey="value" outerRadius={100}>
          {categoryData.map((_, i) => (
            <Cell key={i} />
          ))}
        </Pie>
        <Tooltip />
      </PieChart>

      {/* Bar Chart */}
      <h3>Income vs Expense</h3>
      <BarChart width={300} height={250} data={barData}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="name" />
        <YAxis />
        <Tooltip />
        <Bar dataKey="value" />
      </BarChart>

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