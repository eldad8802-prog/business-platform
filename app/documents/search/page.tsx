"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  card,
  input,
  primaryBtn,
  emptyState,
  pageMain,
  hero,
  heroKicker,
  heroTitle,
  heroSubText,
  alertError,
} from "../ui";
import { CATEGORY_MAP } from "@/lib/constants/categories";
import PageHeader from "@/components/ui/page-header";

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

    const token = localStorage.getItem("token");
    if (!token) {
      setError("לא מחובר. אנא התחבר מחדש.");
      return;
    }

    try {
      setLoading(true);
      setError("");
      setSearched(true);

      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
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
    <div dir="rtl">
      <PageHeader title="חיפוש" />

      <main style={pageMain}>
        <section style={hero}>
          <div style={heroKicker}>חיפוש מסמכים</div>
          <h1 style={heroTitle}>מצא מסמך</h1>
          <p style={heroSubText}>חפש לפי ספק או קטגוריה, ואז פתח לבדיקה.</p>
        </section>

        <section style={card}>
          <div style={{ fontWeight: 950, marginBottom: 10, color: "#111827" }}>
            חיפוש מהיר
          </div>

          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="לדוגמה: פז / דלק"
            style={input}
          />

          <button style={primaryBtn} onClick={handleSearch} disabled={loading}>
            {loading ? "מחפש..." : "חפש"}
          </button>
        </section>

        {error ? <div style={alertError}>{error}</div> : null}

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
              cursor: "pointer",
              padding: 18,
            }}
          >
            <div style={{ fontWeight: 950, marginBottom: 6, color: "#111827" }}>
              {r.vendorName}
            </div>
            <div style={{ color: "#6b7280", fontSize: 14, marginBottom: 6 }}>
              {CATEGORY_MAP[r.category] || r.category}
            </div>
            <div style={{ fontWeight: 900, color: "#111827" }}>₪{r.amount}</div>
          </button>
        ))}
      </main>
    </div>
  );
}