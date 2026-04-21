"use client";

import { useEffect, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import {
  header,
  subheader,
  card,
  input,
  primaryBtn,
  emptyState,
} from "../../ui";
import { CATEGORIES } from "@/lib/constants/categories";

type Extracted = {
  amount: number;
  vendorName: string;
  category: string;
  amountConfidence?: "high" | "medium" | "low";
  vendorConfidence?: "high" | "medium" | "low";
  categoryConfidence?: "high" | "medium" | "low";
};

function getConfidenceLabel(level?: string) {
  if (level === "high") return { text: "🟢 בטוח", color: "#15803d" };
  if (level === "low") return { text: "🔴 לא בטוח", color: "#b91c1c" };
  return { text: "🟡 בינוני", color: "#a16207" };
}

export default function ReviewPage() {
  const router = useRouter();
  const params = useParams();
  const id = params?.id as string;

  const [loading, setLoading] = useState(false);
  const [pageLoading, setPageLoading] = useState(true);
  const [error, setError] = useState("");
  const [data, setData] = useState<Extracted | null>(null);
  const [fileUrl, setFileUrl] = useState<string | null>(null);

  const [amount, setAmount] = useState(0);
  const [vendor, setVendor] = useState("");
  const [category, setCategory] = useState("general");

  useEffect(() => {
    if (!id) return;

    const loadDocument = async () => {
      try {
        setPageLoading(true);
        setError("");

        const res = await fetch(`/api/documents/${id}`);
        const json = await res.json();

        if (!res.ok) {
          throw new Error(json?.error || "Failed to load document");
        }

        const extracted = json.extracted;
        const document = json.document;

        if (!extracted) {
          throw new Error("לא נמצאו נתונים למסמך");
        }

        setData(extracted);
        setAmount(extracted.amount || 0);
        setVendor(extracted.vendorName || "");
        setCategory(extracted.category || "general");
        setFileUrl(document?.fileUrl || null);
      } catch (e: any) {
        setError(e?.message || "שגיאה בטעינת המסמך");
      } finally {
        setPageLoading(false);
      }
    };

    loadDocument();
  }, [id]);

  const handleApprove = async () => {
    setLoading(true);
    setError("");

    try {
      const res = await fetch(`/api/documents/${id}/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amount,
          vendorName: vendor,
          category,
        }),
      });

      const result = await res.json();

      if (!res.ok || !result.success) {
        throw new Error(result?.error || "שגיאה באישור");
      }

      router.push("/documents/dashboard");
    } catch (e: any) {
      setError(e?.message || "שגיאה באישור");
    } finally {
      setLoading(false);
    }
  };

  if (pageLoading) {
    return <div style={emptyState}>טוען מסמך...</div>;
  }

  if (error && !data) {
    return <div style={emptyState}>{error}</div>;
  }

  if (!data) {
    return <div style={emptyState}>לא נמצאו נתונים למסמך</div>;
  }

  const amountConf = getConfidenceLabel(data.amountConfidence);
  const vendorConf = getConfidenceLabel(data.vendorConfidence);
  const categoryConf = getConfidenceLabel(data.categoryConfidence);

  return (
    <div>
      <h1 style={header}>בדיקת מסמך</h1>
      <p style={subheader}>בדוק וערוך לפני שמירה</p>

      {fileUrl && (
        <div style={card}>
          <div style={{ marginBottom: 10, fontWeight: 600 }}>📄 תצוגת מסמך</div>

          {fileUrl.endsWith(".pdf") ? (
            <iframe
              src={fileUrl}
              style={{
                width: "100%",
                height: 320,
                borderRadius: 8,
                border: "none",
              }}
            />
          ) : (
            <img
              src={fileUrl}
              alt="document"
              style={{
                width: "100%",
                borderRadius: 8,
                display: "block",
              }}
            />
          )}
        </div>
      )}

      {/* Amount */}
      <div style={card}>
        <div style={{ fontWeight: 600 }}>💰 סכום</div>
        <input
          type="number"
          value={amount}
          onChange={(e) => setAmount(Number(e.target.value))}
          style={input}
        />
        <div style={{ marginTop: 6, fontSize: 13, color: amountConf.color }}>
          {amountConf.text}
        </div>
      </div>

      {/* Vendor */}
      <div style={card}>
        <div style={{ fontWeight: 600 }}>🏪 ספק</div>
        <input
          value={vendor}
          onChange={(e) => setVendor(e.target.value)}
          style={input}
        />
        <div style={{ marginTop: 6, fontSize: 13, color: vendorConf.color }}>
          {vendorConf.text}
        </div>
      </div>

      {/* Category */}
      <div style={card}>
        <div style={{ fontWeight: 600 }}>📂 קטגוריה</div>

        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          style={input}
        >
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>

        <div style={{ marginTop: 6, fontSize: 13, color: categoryConf.color }}>
          {categoryConf.text}
        </div>
      </div>

      {error ? <div style={emptyState}>{error}</div> : null}

      <button onClick={handleApprove} disabled={loading} style={primaryBtn}>
        {loading ? "שומר..." : "אישור ושמירה"}
      </button>
    </div>
  );
}