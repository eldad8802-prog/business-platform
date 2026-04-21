"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  header,
  subheader,
  card,
  input,
  primaryBtn,
  emptyState,
} from "../ui";
import { CATEGORY_MAP } from "@/lib/constants/categories";

type SearchResult = {
  id: number;
  documentId: number;
  vendorName: string;
  category: string;
  amount: number;
};

export default function SearchPage() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState("");

  const handleSearch = async () => {
    if (!query.trim()) return;

    try {
      setLoading(true);
      setError("");
      setSearched(true);

      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data?.error || "Search failed");
      }

      setResults(data.results || []);
    } catch (e: any) {
      setError(e?.message || "שגיאה בחיפוש");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <h1 style={header}>חיפוש מסמכים</h1>
      <p style={subheader}>חפש לפי ספק או קטגוריה</p>

      <div style={card}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="לדוגמה: פז / דלק"
          style={input}
        />

        <button style={primaryBtn} onClick={handleSearch}>
          {loading ? "מחפש..." : "חפש"}
        </button>
      </div>

      {error ? <div style={emptyState}>{error}</div> : null}

      {searched && !loading && results.length === 0 && !error ? (
        <div style={emptyState}>לא נמצאו תוצאות</div>
      ) : null}

      {results.map((r) => (
        <button
          key={r.id}
          onClick={() => router.push(`/documents/review/${r.documentId}`)}
          style={{
            ...card,
            width: "100%",
            textAlign: "right",
            background: "#fff",
            cursor: "pointer",
            border: "1px solid #eee",
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 6 }}>🏪 {r.vendorName}</div>
          <div style={{ color: "#666", fontSize: 14, marginBottom: 6 }}>
            📂 {CATEGORY_MAP[r.category] || r.category}
          </div>
          <div>💰 ₪{r.amount}</div>
        </button>
      ))}
    </div>
  );
}