"use client";

import { useState } from "react";

type ResultState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; json: unknown }
  | { status: "error"; message: string; json?: unknown };

export default function DebugOcrPage() {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ResultState>({ status: "idle" });

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!file) {
      setResult({ status: "error", message: "בחר קובץ קודם" });
      return;
    }

    setResult({ status: "loading" });

    try {
      const formData = new FormData();
      formData.append("file", file, file.name);

      const res = await fetch("/api/documents/debug-ocr", {
        method: "POST",
        body: formData,
      });

      const json = await res.json().catch(() => null);

      if (!res.ok) {
        setResult({
          status: "error",
          message: `Request failed (${res.status})`,
          json,
        });
        return;
      }

      setResult({ status: "success", json });
    } catch (err) {
      setResult({
        status: "error",
        message: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  return (
    <div style={{ padding: 40, maxWidth: 900 }}>
      <h1>Debug OCR</h1>

      <form onSubmit={onSubmit} style={{ display: "grid", gap: 12 }}>
        <div>
          <label htmlFor="file">File</label>
          <div>
            <input
              id="file"
              name="file"
              type="file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              disabled={result.status === "loading"}
            />
          </div>
        </div>

        <div style={{ display: "flex", gap: 12 }}>
          <button type="submit" disabled={result.status === "loading"}>
            Run OCR
          </button>
          {result.status === "loading" ? <span>Loading...</span> : null}
        </div>
      </form>

      {result.status === "error" ? (
        <div style={{ marginTop: 16, color: "crimson" }}>
          <div>{result.message}</div>
        </div>
      ) : null}

      {result.status === "success" || result.status === "error" ? (
        <pre
          style={{
            marginTop: 16,
            padding: 12,
            border: "1px solid #ddd",
            borderRadius: 8,
            background: "#fafafa",
            overflow: "auto",
            whiteSpace: "pre-wrap",
          }}
        >
          {JSON.stringify(
            result.status === "success" ? result.json : result.json ?? null,
            null,
            2
          )}
        </pre>
      ) : null}
    </div>
  );
}

