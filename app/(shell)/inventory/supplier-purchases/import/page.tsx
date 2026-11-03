"use client";

import { useMemo, useRef, useState, type DragEvent } from "react";
import { useI18n } from "@/components/i18n/I18nProvider";
import { parseCsvToRecords } from "@/lib/services/supplier-connectors/csv/csv-parser";
import { I2, InvButton, InvNote, InvPage, InvSheet } from "@/components/inventory/v2/kit";

type ImportCsvResponse = {
  success?: boolean;
  error?: string;
  draftsCreated?: Array<{ draftId: number; externalOrderId: string | null; supplierName: string | null }>;
  skippedOrders?: Array<{ externalOrderId: string | null; supplierName: string | null; draftId: number }>;
  invalidOrders?: Array<{ orderId: string; reason: string }>;
  warnings?: string[];
  previewSummary?: { ordersParsed: number; draftsCreated: number; skippedOrders: number; invalidOrders: number };
};

type Preview = { rows: Array<Record<string, string>>; total: number; duplicateOrderIds: boolean };

const COLUMNS: Array<{ key: string; label: string; required?: boolean }> = [
  { key: "supplierName", label: "שם הספק" },
  { key: "externalOrderId", label: "מזהה הזמנה אצל הספק" },
  { key: "rawName", label: "שם המוצר" },
  { key: "sku", label: "מק״ט" },
  { key: "barcode", label: "ברקוד" },
  { key: "quantity", label: "כמות (מספר גדול מ־0)", required: true },
  { key: "unitType", label: "יחידה (UNIT, BOX, KG, GRAM, LITER, ML)" },
  { key: "notes", label: "הערות" },
];
const SAMPLE = "supplierName,externalOrderId,rawName,sku,barcode,quantity,unitType\nספק לדוגמה,A-100,מוצר לדוגמה,123,7290000000000,5,UNIT";

/**
 * Import supplier orders from a CSV file (redesign, mockup "ייבוא הזמנות").
 * The preview is a client-side read of the file for display only; the import is the
 * same POST as before and the server decides what is created.
 */
export default function SupplierCsvImportPage() {
  const { t } = useI18n();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportCsvResponse | null>(null);
  const [formatOpen, setFormatOpen] = useState(false);

  const draftsCreated = result?.draftsCreated ?? [];
  const skippedOrders = result?.skippedOrders ?? [];
  const invalidOrders = result?.invalidOrders ?? [];
  const warnings = result?.warnings ?? [];
  const hasSuccessfulImport = result?.success === true && !error && (draftsCreated.length > 0 || skippedOrders.length > 0);

  function reset() {
    setFile(null);
    setPreview(null);
    setResult(null);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function acceptFile(next: File | undefined | null) {
    setError(null);
    setResult(null);
    setPreview(null);
    if (!next) {
      setFile(null);
      return;
    }
    if (!next.name.toLowerCase().endsWith(".csv")) {
      setFile(null);
      setError(t("customers.purchases.import.csvOnly"));
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    setFile(next);
    // Display only — the server parses the file itself on import.
    void next
      .text()
      .then((text) => {
        const rows = parseCsvToRecords(text);
        const ids = rows.map((r) => (r.externalOrderId || "").trim()).filter(Boolean);
        setPreview({ rows: rows.slice(0, 20), total: rows.length, duplicateOrderIds: new Set(ids).size < ids.length });
      })
      .catch(() => setPreview({ rows: [], total: 0, duplicateOrderIds: false }));
  }

  function onDrop(e: DragEvent<HTMLButtonElement>) {
    e.preventDefault();
    setDragOver(false);
    acceptFile(e.dataTransfer.files?.[0]);
  }

  async function submitImport() {
    if (!file || loading) return;
    const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;
    if (!token?.trim()) {
      setError(t("customers.purchases.import.noToken"));
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
            (response.status === 401
              ? t("customers.purchases.import.unauthorized")
              : t("customers.purchases.import.serverError", { status: response.status }))
        );
        return;
      }
      if (!data || data.success !== true) {
        setError(t("customers.purchases.import.unexpectedResponse"));
        return;
      }
      setResult(data);
    } catch {
      setError(t("customers.purchases.import.networkError"));
    } finally {
      setLoading(false);
    }
  }

  const previewRows = useMemo(() => preview?.rows ?? [], [preview]);

  return (
    <InvPage
      title="ייבוא הזמנות"
      backFallback="/inventory/supplier-purchases"
      footer={
        !result ? (
          <div className="i2-footer__row">
            <InvButton disabled={!file || loading} onClick={() => void submitImport()}>
              {loading ? "מייבאים…" : "ייבוא לקליטת הזמנות"}
            </InvButton>
          </div>
        ) : (
          <div className="i2-footer__row">
            <InvButton href="/inventory/supplier-purchases?tab=receive" disabled={!hasSuccessfulImport}>
              לקליטת הזמנות
            </InvButton>
            <InvButton kind="secondary" onClick={reset}>
              ייבוא קובץ נוסף
            </InvButton>
          </div>
        )
      }
    >
      <p style={{ margin: "6px 0 12px", lineHeight: 1.55 }}>ייבוא הזמנות מקובץ CSV מאפשר להוסיף במהירות הזמנות מרובות למערכת.</p>

      <input ref={fileInputRef} type="file" accept=".csv,text/csv" className="i2-sr" tabIndex={-1} aria-hidden onChange={(e) => acceptFile(e.target.files?.[0])} />

      {!file ? (
        <button
          type="button"
          className="i2-drop"
          data-over={dragOver ? "true" : undefined}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          {I2.file(34)}
          <b>בחירת קובץ CSV</b>
          <span className="i2-muted">או גרירת קובץ לכאן</span>
        </button>
      ) : (
        <div className="i2-card" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {I2.file(26)}
          <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere", fontWeight: 500 }}>
            <bdi>{file.name}</bdi>
          </span>
          <button type="button" className="i2-iconbtn" onClick={reset} disabled={loading} aria-label="הסרת הקובץ">
            {I2.close(20)}
          </button>
        </div>
      )}

      <div style={{ textAlign: "start" }}>
        <button type="button" className="i2-underline" onClick={() => setFormatOpen(true)}>
          מבנה הקובץ הנדרש
        </button>
      </div>

      {error ? <InvNote tone="danger">{error}</InvNote> : null}

      {file && preview && !result ? (
        <>
          <h3 className="i2-h3">תצוגה מקדימה</h3>
          {preview.total === 0 ? (
            <InvNote tone="warn">לא נמצאו שורות בקובץ. בדקו שהשורה הראשונה היא שורת כותרות ושהערכים מופרדים בפסיקים.</InvNote>
          ) : (
            <>
              <div style={{ overflowX: "auto" }}>
                <table className="i2-table">
                  <thead>
                    <tr>
                      <th>מוצר</th>
                      <th>כמות</th>
                      <th>ספק</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.map((r, i) => (
                      <tr key={i}>
                        <td style={{ overflowWrap: "anywhere" }}>{(r.rawName || "").trim() || r.sku || r.barcode || "—"}</td>
                        <td className="i2-num">{(r.quantity || "").trim() || "—"}</td>
                        <td style={{ overflowWrap: "anywhere" }}>{(r.supplierName || "").trim() || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="i2-foot">
                {preview.total === 1 ? "שורה אחת בקובץ" : `${preview.total.toLocaleString("he-IL")} שורות בקובץ`}
                {preview.total > 20 ? " · מוצגות 20 הראשונות" : ""}
              </p>
              {preview.duplicateOrderIds ? (
                <InvNote>כל שורה בקובץ נקלטת כהזמנה נפרדת, ושורות עם אותו מזהה הזמנה עשויות להידלג.</InvNote>
              ) : null}
            </>
          )}
          <InvNote tone="warn">בדקו את הנתונים לפני הייבוא</InvNote>
        </>
      ) : null}

      {result?.success === true && !error ? (
        <>
          <InvNote tone="ok">
            <div style={{ fontWeight: 600 }}>הייבוא הסתיים</div>
            <div className="i2-num">
              נוצרו {draftsCreated.length.toLocaleString("he-IL")} · דולגו {skippedOrders.length.toLocaleString("he-IL")} · לא תקינות{" "}
              {invalidOrders.length.toLocaleString("he-IL")}
            </div>
          </InvNote>
          {warnings.length > 0 ? (
            <InvNote tone="warn">
              <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                {warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </InvNote>
          ) : null}
          {invalidOrders.length > 0 ? (
            <>
              <h3 className="i2-h3">שורות שלא נקלטו</h3>
              <ul className="i2-list">
                {invalidOrders.map((row, i) => (
                  <li key={i} style={{ padding: "8px 0", borderBottom: "1px solid var(--i2-line)", overflowWrap: "anywhere" }}>
                    <bdi>{row.orderId}</bdi>: {row.reason}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      ) : null}

      {formatOpen ? (
        <InvSheet title="מבנה הקובץ הנדרש" onClose={() => setFormatOpen(false)}>
          <p style={{ marginTop: 0 }}>קובץ CSV מופרד בפסיקים. השורה הראשונה היא שורת הכותרות, בשמות העמודות האלה:</p>
          <dl className="i2-kv">
            {COLUMNS.map((c) => (
              <div key={c.key} className="i2-kv__r">
                <dt>
                  <bdi dir="ltr">{c.key}</bdi>
                </dt>
                <dd>
                  {c.label}
                  {c.required ? " · חובה" : ""}
                </dd>
              </div>
            ))}
          </dl>
          <h3 className="i2-h3">שורה לדוגמה</h3>
          <pre dir="ltr" className="i2-box" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 13, margin: 0 }}>
            {SAMPLE}
          </pre>
          <div style={{ marginTop: 14 }}>
            <InvButton block kind="secondary" onClick={() => setFormatOpen(false)}>
              סגירה
            </InvButton>
          </div>
        </InvSheet>
      ) : null}
    </InvPage>
  );
}
