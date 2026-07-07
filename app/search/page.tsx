"use client";

import { useState } from "react";
import BackButton from "@/components/ui/back-button";

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<any[]>([]);

  const handleSearch = async () => {
    const token = localStorage.getItem("token");
    if (!token) return;

    const res = await fetch(`/api/search?q=${query}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    setResults(data.results || []);
  };

  return (
    <div style={{ padding: 40 }}>
      <div style={{ marginBottom: 16 }}>
        <BackButton />
      </div>
      <h1>🔍 Search Documents</h1>

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="חפש לפי ספק או קטגוריה"
      />

      <button onClick={handleSearch}>Search</button>

      <ul>
        {results.map((r) => (
          <li key={r.id}>
            {r.vendorName} - {r.category} - ₪{r.amount}
          </li>
        ))}
      </ul>
    </div>
  );
}