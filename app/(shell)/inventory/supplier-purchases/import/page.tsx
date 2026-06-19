"use client";

import { useRef, useState, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import { InventorySubPage } from "@/components/inventory/inventory-shell";
import { InventoryStatePanel, SaveBar } from "@/components/inventory/inventory-design";

type ImportCsvResponse = {
  success?: boolean;
  error?: string;
  draftsCreated?: Array<{ draftId: number; externalOrderId: string | null; supplierName: string | null }>;
  skippedOrders?: Array<{ externalOrderId: string | null; supplierName: string | null; draftId: number }>;
  invalidOrders?: Array<{ orderId: string; reason: string }>;
  warnings?: string[];
  previewSummary?: { ordersParsed: number; draftsCreated: number; skippedOrders: number; invalidOrders: number };
};

export default function SupplierCsvImportPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportCsvResponse | null>(null);

  const draftsCreated = result?.draftsCreated ?? [];
  const skippedOrders = result?.skippedOrders ?? [];
  const invalidOrders = result?.invalidOrders ?? [];
  const warnings = result?.warnings ?? [];
  const preview = result?.previewSummary;
  const hasSuccessfulImport =
    result?.success === true && !error && (draftsCreated.length > 0 || skippedOrders.length > 0);

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const next = event.target.files?.[0];
    setError(null);
    setResult(null);
    if (!next) {
      setFile(null);
      return;
    }
    if (!next.name.toLowerCase().endsWith(".csv")) {
      setFile(null);
      setError("נא לבחור קובץ בסיומת .csv");
      event.target.value = "";
      return;
    }
    setFile(next);
  }

  async function submitImport() {
    if (!file || loading) return;
    const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;
    if (!token?.trim()) {
      setError("חסר אסימון התחברות — התחברו מחדש ונסו שוב.");
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch("/api/inventory/supplier-purchases/import/csv", {
        method: "POST",
        headers: { Authorization: `Bearer ${token.trim()}` },
        body: formData,
      });
      const data = (await response.json().catch(() => null)) as ImportCsvResponse | null;
      if (!response.ok) {
        setError(
          (data && typeof data.error === "string" && data.error) ||
            (response.status === 401 ? "אין הרשאה לבצע ייבוא (401)" : `שגיאת שרת (${response.status})`)
        );
        return;
      }
      if (!data || data.success !== true) {
        setError("תשובה לא צפויה מהשרת");
        return;
      }
      setResult(data);
    } catch {
      setError("שגיאת רשת — בדקו את החיבור ונסו שוב.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <InventorySubPage title="יבוא וזיהוי" backHref="/inventory/supplier-purchases" bottomNav="orders">
      <div className="inv-fwrap">
        <p className="inv-field__help" style={{ marginTop: 8, fontSize: 14, lineHeight: 1.7 }}>
          העלו קובץ CSV מספק כדי ליצור טיוטות הזמנה לבדיקה לפני קליטת מלאי.
        </p>

        <input ref={fileInputRef} type="file" accept=".csv,text/csv" style={{ display: "none" }} onChange={onFileChange} />

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="inv-imgpick"
          style={{
            marginTop: 16,
            width: "100%",
            minHeight: 120,
            border: "1.5px dashed var(--inv-border)",
            borderRadius: "var(--inv-radius-md)",
            background: "var(--inv-surface, #f5f7f9)",
            color: "var(--inv-text-muted)",
            fontFamily: "inherit",
            fontSize: 14,
            fontWeight: 700,
            cursor: "pointer",
            display: "flex",
            flexDirection: "column",
            gap: 6,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {file ? (
            <>
              <span style={{ fontWeight: 900, color: "var(--inv-text)" }}>{file.name}</span>
              <span style={{ fontSize: 13 }}>לחצו לבחירת קובץ אחר</span>
            </>
          ) : (
            <span>לחצו לבחירת קובץ CSV</span>
          )}
        </button>

        {file ? (
          <button
            type="button"
            onClick={() => {
              setFile(null);
              setResult(null);
              setError(null);
              if (fileInputRef.current) fileInputRef.current.value = "";
            }}
            disabled={loading}
            className="inv-btn-link"
            style={{ marginTop: 10 }}
          >
            הסרת קובץ
          </button>
        ) : null}

        {error ? (
          <div className="inv-alert inv-alert--error" style={{ marginTop: 16 }}>
            {error}
          </div>
        ) : null}

        {result?.success === true && !error ? (
          <div style={{ marginTop: 16, display: "grid", gap: 12 }}>
            <div className="inv-alert inv-alert--success">
              הייבוא הושלם בהצלחה
              <div style={{ marginTop: 8, fontWeight: 700, fontSize: 13 }}>
                {preview != null ? <>נפרסו {preview.ordersParsed} הזמנות · </> : null}
                נוצרו {draftsCreated.length} טיוטות · דולגו {skippedOrders.length} · לא תקינות {invalidOrders.length}
              </div>
            </div>

            {warnings.length > 0 ? (
              <div className="inv-alert" style={{ border: "1px solid var(--inv-warning)", background: "#fffbeb", color: "#92400e" }}>
                <div style={{ marginBottom: 8, fontWeight: 900 }}>אזהרות</div>
                <ul style={{ margin: 0, paddingInlineStart: 20, fontWeight: 700, fontSize: 13 }}>
                  {warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {invalidOrders.length > 0 ? (
              <div style={{ background: "var(--inv-card-bg)", border: "1px solid var(--inv-border)", borderRadius: 12, padding: 14, boxShadow: "var(--inv-shadow)" }}>
                <div style={{ fontWeight: 900, marginBottom: 8 }}>שורות לא תקינות ({invalidOrders.length})</div>
                <ul style={{ margin: 0, paddingInlineStart: 20, fontSize: 13, color: "var(--inv-text-muted)", lineHeight: 1.6 }}>
                  {invalidOrders.map((row, i) => (
                    <li key={i}>
                      <bdi>{row.orderId}</bdi>: {row.reason}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <button
              type="button"
              className="inv-btn-secondary"
              disabled={!hasSuccessfulImport}
              onClick={() => router.push("/inventory/supplier-purchases/pending")}
            >
              עבור להזמנות ממתינות
            </button>
          </div>
        ) : null}
      </div>

      {!result ? (
        <SaveBar label={loading ? "מייבא…" : "ייבוא קובץ"} onClick={() => void submitImport()} disabled={!file || loading} />
      ) : null}
    </InventorySubPage>
  );
}
