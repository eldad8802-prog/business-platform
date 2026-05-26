"use client";

import { useRef, useState, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import PageHeader from "@/components/ui/page-header";

type ImportCsvResponse = {
  success?: boolean;
  error?: string;
  draftsCreated?: Array<{
    draftId: number;
    externalOrderId: string | null;
    supplierName: string | null;
  }>;
  skippedOrders?: Array<{
    externalOrderId: string | null;
    supplierName: string | null;
    draftId: number;
  }>;
  invalidOrders?: Array<{
    orderId: string;
    reason: string;
  }>;
  warnings?: string[];
  previewSummary?: {
    ordersParsed: number;
    draftsCreated: number;
    skippedOrders: number;
    invalidOrders: number;
  };
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
    result?.success === true &&
    !error &&
    (draftsCreated.length > 0 || skippedOrders.length > 0);

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const next = event.target.files?.[0];
    setError(null);
    setResult(null);
    if (!next) {
      setFile(null);
      return;
    }
    const name = next.name.toLowerCase();
    if (!name.endsWith(".csv")) {
      setFile(null);
      setError("נא לבחור קובץ בסיומת .csv");
      event.target.value = "";
      return;
    }
    setFile(next);
  }

  function openFilePicker() {
    fileInputRef.current?.click();
  }

  function clearFile() {
    setFile(null);
    setResult(null);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function submitImport() {
    if (!file || loading) return;

    const token =
      typeof window !== "undefined" ? localStorage.getItem("token") : null;

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

      const response = await fetch(
        "/api/inventory/supplier-purchases/import/csv",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token.trim()}`,
          },
          body: formData,
        }
      );

      const data = (await response.json().catch(() => null)) as
        | ImportCsvResponse
        | null;

      if (!response.ok) {
        const message =
          (data && typeof data.error === "string" && data.error) ||
          (response.status === 401
            ? "אין הרשאה לבצע ייבוא (401)"
            : response.status === 400
              ? "הבקשה נדחתה (400)"
              : `שגיאת שרת (${response.status})`);
        setError(message);
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
    <div dir="rtl" style={{ minHeight: "100vh", background: "#f8fafc" }}>
      <PageHeader title="ייבוא CSV" />

      <main
        style={{
          maxWidth: 980,
          margin: "0 auto",
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        {error && (
          <div
            style={{
              border: "1px solid #fecaca",
              background: "#fef2f2",
              color: "#991b1b",
              borderRadius: 18,
              padding: 14,
              fontSize: 14,
              fontWeight: 800,
              lineHeight: 1.5,
            }}
          >
            {error}
          </div>
        )}

        <section
          style={{
            borderRadius: 30,
            padding: 22,
            background:
              "linear-gradient(135deg, #111827 0%, #1f2937 50%, #0f766e 100%)",
            color: "#ffffff",
            boxShadow: "0 18px 44px rgba(15, 23, 42, 0.22)",
            display: "flex",
            flexDirection: "column",
            gap: 18,
          }}
        >
          <div>
            <div
              style={{
                display: "inline-flex",
                padding: "7px 11px",
                borderRadius: 999,
                background: "rgba(255,255,255,0.12)",
                border: "1px solid rgba(255,255,255,0.18)",
                fontSize: 12,
                fontWeight: 900,
                marginBottom: 12,
              }}
            >
              קליטת נתונים מספק
            </div>

            <h1
              style={{
                margin: 0,
                fontSize: 26,
                lineHeight: 1.25,
                fontWeight: 950,
              }}
            >
              ייבוא קובץ CSV
            </h1>

            <p
              style={{
                margin: "10px 0 0",
                color: "rgba(255,255,255,0.78)",
                fontSize: 14,
                lineHeight: 1.7,
              }}
            >
              העלה קובץ CSV מספק כדי ליצור טיוטות להזמנות לבדיקה לפני קליטת
              מלאי.
            </p>
          </div>
        </section>

        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          style={{ display: "none" }}
          onChange={onFileChange}
        />

        <button
          type="button"
          onClick={openFilePicker}
          style={{
            border: "1px dashed #cbd5e1",
            borderRadius: 22,
            background: "#ffffff",
            padding: 22,
            textAlign: "center",
            color: "#64748b",
            fontSize: 14,
            lineHeight: 1.6,
            cursor: "pointer",
            width: "100%",
          }}
        >
          {file ? (
            <>
              <div style={{ fontWeight: 950, color: "#111827" }}>
                {file.name}
              </div>
              <div style={{ marginTop: 8, fontSize: 13 }}>
                לחצו לבחירת קובץ אחר
              </div>
            </>
          ) : (
            <>לחצו לבחירת קובץ CSV</>
          )}
        </button>

        {file && (
          <button
            type="button"
            onClick={clearFile}
            disabled={loading}
            style={{
              alignSelf: "flex-start",
              border: "none",
              background: "transparent",
              color: "#6b7280",
              fontSize: 13,
              fontWeight: 800,
              cursor: loading ? "not-allowed" : "pointer",
              padding: 0,
            }}
          >
            הסרת קובץ
          </button>
        )}

        <button
          type="button"
          onClick={submitImport}
          disabled={!file || loading}
          style={{
            minHeight: 52,
            borderRadius: 18,
            border: "none",
            background:
              !file || loading ? "rgba(15, 23, 42, 0.12)" : "#059669",
            color: !file || loading ? "#9ca3af" : "#ffffff",
            fontSize: 15,
            fontWeight: 950,
            cursor: !file || loading ? "not-allowed" : "pointer",
            boxShadow:
              !file || loading
                ? "none"
                : "0 10px 22px rgba(5, 150, 105, 0.16)",
          }}
        >
          {loading ? "מייבא…" : "ייבוא קובץ"}
        </button>

        {result?.success === true && !error && (
          <>
            <div
              style={{
                border: "1px solid #bbf7d0",
                background: "#f0fdf4",
                color: "#166534",
                borderRadius: 18,
                padding: 14,
                fontSize: 14,
                fontWeight: 800,
                lineHeight: 1.5,
              }}
            >
              הייבוא הושלם בהצלחה
              {preview != null ? (
                <div
                  style={{
                    marginTop: 8,
                    fontWeight: 700,
                    fontSize: 13,
                    opacity: 0.95,
                  }}
                >
                  נפרסו {preview.ordersParsed} הזמנות מהקובץ · נוצרו{" "}
                  {draftsCreated.length} טיוטות · דולגו {skippedOrders.length} ·
                  לא תקינות {invalidOrders.length}
                </div>
              ) : (
                <div
                  style={{
                    marginTop: 8,
                    fontWeight: 700,
                    fontSize: 13,
                    opacity: 0.95,
                  }}
                >
                  נוצרו {draftsCreated.length} טיוטות · דולגו{" "}
                  {skippedOrders.length} · לא תקינות {invalidOrders.length}
                </div>
              )}
            </div>

            {warnings.length > 0 && (
              <div
                style={{
                  border: "1px solid #fde68a",
                  background: "#fffbeb",
                  color: "#92400e",
                  borderRadius: 18,
                  padding: 14,
                  fontSize: 14,
                  fontWeight: 800,
                  lineHeight: 1.5,
                }}
              >
                <div style={{ marginBottom: 8 }}>אזהרות</div>
                <ul
                  style={{
                    margin: 0,
                    paddingRight: 20,
                    fontWeight: 700,
                    fontSize: 13,
                  }}
                >
                  {warnings.map((w, i) => (
                    <li key={i} style={{ marginBottom: 4 }}>
                      {w}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <section
              style={{
                border: "1px solid #e5e7eb",
                borderRadius: 22,
                background: "#ffffff",
                padding: 16,
                boxShadow: "0 8px 24px rgba(15, 23, 42, 0.06)",
              }}
            >
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 950,
                  color: "#111827",
                  marginBottom: 8,
                }}
              >
                הזמנות שדולגו ({skippedOrders.length})
              </div>
              {skippedOrders.length === 0 ? (
                <div
                  style={{ fontSize: 13, color: "#6b7280", lineHeight: 1.5 }}
                >
                  אין
                </div>
              ) : (
                <ul
                  style={{
                    margin: 0,
                    paddingRight: 20,
                    fontSize: 13,
                    color: "#374151",
                    lineHeight: 1.5,
                  }}
                >
                  {skippedOrders.map((row, i) => (
                    <li key={i}>
                      {row.externalOrderId ?? "—"} · טיוטה קיימת #
                      {row.draftId}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section
              style={{
                border: "1px solid #e5e7eb",
                borderRadius: 22,
                background: "#ffffff",
                padding: 16,
                boxShadow: "0 8px 24px rgba(15, 23, 42, 0.06)",
              }}
            >
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 950,
                  color: "#111827",
                  marginBottom: 8,
                }}
              >
                שורות לא תקינות ({invalidOrders.length})
              </div>
              {invalidOrders.length === 0 ? (
                <div
                  style={{ fontSize: 13, color: "#6b7280", lineHeight: 1.5 }}
                >
                  אין
                </div>
              ) : (
                <ul
                  style={{
                    margin: 0,
                    paddingRight: 20,
                    fontSize: 13,
                    color: "#374151",
                    lineHeight: 1.5,
                  }}
                >
                  {invalidOrders.map((row, i) => (
                    <li key={i}>
                      {row.orderId}: {row.reason}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}

        <button
          type="button"
          onClick={() =>
            router.push("/inventory/supplier-purchases/pending")
          }
          disabled={!hasSuccessfulImport}
          style={{
            minHeight: 48,
            borderRadius: 16,
            border: "1px solid #d1d5db",
            background: hasSuccessfulImport ? "#ffffff" : "#f9fafb",
            color: hasSuccessfulImport ? "#111827" : "#9ca3af",
            fontSize: 14,
            fontWeight: 950,
            cursor: hasSuccessfulImport ? "pointer" : "not-allowed",
          }}
        >
          עבור להזמנות ממתינות
        </button>
      </main>
    </div>
  );
}
