"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { header, subheader, card, primaryBtn, emptyState } from "../ui";

export default function UploadPage() {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

  const handleUpload = async () => {
    if (!file) return;

    setLoading(true);
    setError("");

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("businessId", "1");
      formData.append("source", "file");

      const res = await fetch("/api/documents/upload", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();

      if (!res.ok || !data.documentId) {
        throw new Error(data?.error || "Upload failed");
      }

      router.push(`/documents/review/${data.documentId}`);
    } catch (e: any) {
      setError(e?.message || "אירעה שגיאה בהעלאה");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <h1 style={header}>העלאת מסמך</h1>
      <p style={subheader}>צלם או העלה תמונה של חשבונית, קבלה או צילום מסך</p>

      <div style={card}>
        <input
          type="file"
          accept="image/*,application/pdf"
          capture="environment"
          onChange={(e) => setFile(e.target.files?.[0] || null)}
          style={{ width: "100%" }}
        />

        {!file && (
          <div style={{ marginTop: 14, color: "#666", fontSize: 14 }}>
            עדיין לא נבחר קובץ
          </div>
        )}

        {file && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>הקובץ שנבחר</div>
            <div style={{ color: "#666", fontSize: 14 }}>{file.name}</div>
          </div>
        )}
      </div>

      {error ? <div style={emptyState}>{error}</div> : null}

      <button
        onClick={handleUpload}
        disabled={loading || !file}
        style={{
          ...primaryBtn,
          opacity: loading || !file ? 0.6 : 1,
        }}
      >
        {loading ? "מעלה ומנתח..." : "המשך"}
      </button>
    </div>
  );
}