"use client";

import { useEffect, useMemo, useState } from "react";
import { InventorySubPage } from "@/components/inventory/inventory-shell";
import {
  DecisionCard,
  DecisionChips,
  ConfidencePill,
  InventoryStatePanel,
  InventorySkeletonBlock,
  BottomSheet,
  SegmentedControl,
  SheetActions,
  type ConfidenceLevel,
} from "@/components/inventory/inventory-design";
import { getProductEmoji } from "@/lib/inventory/product-emoji";

type DraftMatch = { itemId: number; itemName: string; matchScore: number; reason: string };

type Draft = {
  id: number;
  detectedName?: string | null;
  detectedCategory?: string | null;
  detectedBarcode?: string | null;
  detectedUnitType?: string | null;
  imageUrl?: string | null;
  confidenceScore?: number | null;
  status: string;
  matches?: DraftMatch[];
};

type ApproveForm = {
  name: string;
  unitType: string;
  barcode: string;
  initialQuantity: string;
  minimumQuantity: string;
  reorderPoint: string;
};

const UNIT_OPTIONS = [
  { value: "UNIT", label: "יחידה" },
  { value: "KG", label: "ק״ג" },
  { value: "GRAM", label: "גרם" },
  { value: "LITER", label: "ליטר" },
  { value: "ML", label: "מ״ל" },
  { value: "BOX", label: "מארז" },
];

const THUMB_BG: Record<ConfidenceLevel, string> = { high: "var(--inv-success-bg)", mid: "var(--inv-warning-bg)", low: "var(--inv-danger-bg)" };

function safeImage(imageUrl?: string | null) {
  return imageUrl && !imageUrl.includes("example.com") ? imageUrl : null;
}

function confLevel(score?: number | null): { level: ConfidenceLevel; label: string } {
  if (score == null) return { level: "mid", label: "לבדיקה" };
  if (score >= 0.85) return { level: "high", label: "ודאות גבוהה" };
  if (score >= 0.6) return { level: "mid", label: "ודאות בינונית" };
  return { level: "low", label: "ודאות נמוכה" };
}

function buildHeaders() {
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;
  return { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

function emptyForm(draft: Draft): ApproveForm {
  return {
    name: draft.detectedName || "",
    unitType: draft.detectedUnitType || "UNIT",
    barcode: draft.detectedBarcode || "",
    initialQuantity: "0",
    minimumQuantity: "0",
    reorderPoint: "",
  };
}

export default function InventoryDraftsPage() {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [approveFor, setApproveFor] = useState<Draft | null>(null);
  const [form, setForm] = useState<ApproveForm | null>(null);
  const [mergeFor, setMergeFor] = useState<Draft | null>(null);

  async function loadDrafts() {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch("/api/inventory/drafts", { headers: buildHeaders() });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "אירעה שגיאה בטעינת הטיוטות");
      setDrafts(Array.isArray(data.drafts) ? data.drafts : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "אירעה שגיאה בטעינת הטיוטות");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void loadDrafts(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const pending = useMemo(() => drafts.filter((d) => d.status === "PENDING_REVIEW"), [drafts]);

  function parseNumber(value: string): number | undefined {
    if (value.trim() === "") return undefined;
    const n = Number(value);
    if (Number.isNaN(n) || !Number.isFinite(n) || n < 0) throw new Error("נדרש מספר תקין (≥0)");
    return n;
  }

  async function submitApprove() {
    if (!approveFor || !form || busyId) return;
    try {
      if (!form.name.trim()) throw new Error("נדרש להזין שם מוצר");
      setBusyId(approveFor.id);
      setError(null);
      const response = await fetch(`/api/inventory/drafts/${approveFor.id}/approve`, {
        method: "POST",
        headers: buildHeaders(),
        body: JSON.stringify({
          name: form.name.trim(),
          unitType: form.unitType.trim(),
          barcode: form.barcode.trim() || undefined,
          initialQuantity: parseNumber(form.initialQuantity),
          minimumQuantity: parseNumber(form.minimumQuantity),
          reorderPoint: parseNumber(form.reorderPoint),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "אירעה שגיאה באישור הטיוטה");
      setApproveFor(null);
      setForm(null);
      await loadDrafts();
    } catch (err) {
      setError(err instanceof Error ? err.message : "אירעה שגיאה באישור הטיוטה");
    } finally {
      setBusyId(null);
    }
  }

  async function merge(draftId: number, targetItemId: number) {
    if (busyId) return;
    try {
      setBusyId(draftId);
      setError(null);
      const response = await fetch(`/api/inventory/drafts/${draftId}/merge`, {
        method: "POST",
        headers: buildHeaders(),
        body: JSON.stringify({ targetItemId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "אירעה שגיאה במיזוג הטיוטה");
      setMergeFor(null);
      await loadDrafts();
    } catch (err) {
      setError(err instanceof Error ? err.message : "אירעה שגיאה במיזוג הטיוטה");
    } finally {
      setBusyId(null);
    }
  }

  async function reject(draftId: number) {
    if (busyId) return;
    try {
      setBusyId(draftId);
      setError(null);
      const response = await fetch(`/api/inventory/drafts/${draftId}/reject`, {
        method: "POST",
        headers: buildHeaders(),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "אירעה שגיאה בדחיית הטיוטה");
      await loadDrafts();
    } catch (err) {
      setError(err instanceof Error ? err.message : "אירעה שגיאה בדחיית הטיוטה");
    } finally {
      setBusyId(null);
    }
  }

  function updateForm(field: keyof ApproveForm, value: string) {
    setForm((f) => (f ? { ...f, [field]: value } : f));
  }

  return (
    <InventorySubPage intent="data"
      title="טיוטות מוצר"
      variant="hub"
      sub={!loading && !error ? "זוהו אוטומטית — ממתינות לאישור לפני כניסה למלאי" : undefined}
      bottomNav="home"
    >
      {error ? (
        <div className="inv-page-content" style={{ padding: "0 clamp(16px,3.5vw,28px)" }}>
          <InventoryStatePanel
            tone="error"
            title="משהו השתבש"
            action={
              <button type="button" className="inv-btn-primary inv-btn-primary--full" onClick={() => void loadDrafts()}>
                נסה שוב
              </button>
            }
          >
            {error}
          </InventoryStatePanel>
        </div>
      ) : loading ? (
        <div className="inv-rows">
          <InventorySkeletonBlock height={130} rows={2} />
        </div>
      ) : pending.length === 0 ? (
        <div className="inv-page-content" style={{ padding: "0 clamp(16px,3.5vw,28px)" }}>
          <InventoryStatePanel title="אין טיוטות לאישור">כל הפריטים שזוהו אושרו או נדחו.</InventoryStatePanel>
        </div>
      ) : (
        <div className="inv-rows">
          {pending.map((draft) => {
            const conf = confLevel(draft.confidenceScore);
            const busy = busyId === draft.id;
            const name = draft.detectedName || "פריט לא מזוהה";
            const metaParts = [
              draft.detectedCategory ? `קטגוריה: ${draft.detectedCategory}` : null,
              draft.detectedBarcode ? "ברקוד זוהה" : null,
            ].filter(Boolean);
            return (
              <DecisionCard key={draft.id}>
                <div className="inv-dcard__top">
                  <span
                    className="inv-row__thumb"
                    style={{ background: THUMB_BG[conf.level] }}
                    aria-hidden
                  >
                    {safeImage(draft.imageUrl) ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={safeImage(draft.imageUrl) || ""} alt="" />
                    ) : (
                      getProductEmoji(draft.detectedName, draft.detectedCategory)
                    )}
                  </span>
                  <div className="inv-row__mid">
                    <div className="inv-row__nm">{name}</div>
                    {metaParts.length ? <div className="inv-row__meta">{metaParts.join(" · ")}</div> : null}
                  </div>
                  <ConfidencePill level={conf.level} label={conf.label} />
                </div>

                <DecisionChips
                  choices={[
                    {
                      label: "אשר מוצר",
                      primary: true,
                      disabled: busy,
                      onClick: () => {
                        setForm(emptyForm(draft));
                        setApproveFor(draft);
                      },
                    },
                    {
                      label: "מזג לקיים",
                      disabled: busy,
                      onClick: () => setMergeFor(draft),
                    },
                    { label: "דחה", disabled: busy, onClick: () => void reject(draft.id) },
                  ]}
                />
              </DecisionCard>
            );
          })}
        </div>
      )}

      {approveFor && form ? (
        <BottomSheet
          title="אישור מוצר"
          who={approveFor.detectedName || "פריט חדש"}
          onClose={() => {
            setApproveFor(null);
            setForm(null);
          }}
          footer={
            <SheetActions
              confirmLabel={busyId === approveFor.id ? "מאשר…" : "אישור והוספה למלאי"}
              onCancel={() => {
                setApproveFor(null);
                setForm(null);
              }}
              onConfirm={() => void submitApprove()}
              confirmDisabled={busyId === approveFor.id || !form.name.trim()}
            />
          }
        >
          <div className="inv-field">
            <div className="inv-field__lab">שם המוצר <span>*</span></div>
            <input className="inv-input" value={form.name} onChange={(e) => updateForm("name", e.target.value)} />
          </div>
          <div className="inv-field">
            <div className="inv-field__lab">יחידת מידה</div>
            <SegmentedControl
              value={form.unitType}
              onChange={(v) => updateForm("unitType", v)}
              options={UNIT_OPTIONS}
            />
          </div>
          <div className="inv-two">
            <div className="inv-field">
              <div className="inv-field__lab">כמות התחלתית</div>
              <input className="inv-input" inputMode="numeric" value={form.initialQuantity} onChange={(e) => updateForm("initialQuantity", e.target.value)} />
            </div>
            <div className="inv-field">
              <div className="inv-field__lab">סף מינימום</div>
              <input className="inv-input" inputMode="numeric" value={form.minimumQuantity} onChange={(e) => updateForm("minimumQuantity", e.target.value)} />
            </div>
          </div>
          <div className="inv-field">
            <div className="inv-field__lab">סף הזמנה מחדש</div>
            <input className="inv-input" inputMode="numeric" placeholder="אופציונלי" value={form.reorderPoint} onChange={(e) => updateForm("reorderPoint", e.target.value)} />
          </div>
          <div className="inv-field">
            <div className="inv-field__lab">ברקוד</div>
            <input className="inv-input" value={form.barcode} onChange={(e) => updateForm("barcode", e.target.value)} />
          </div>
        </BottomSheet>
      ) : null}

      {mergeFor ? (
        <BottomSheet
          title="מיזוג למוצר קיים"
          who={mergeFor.detectedName || "טיוטה"}
          onClose={() => setMergeFor(null)}
        >
          {(mergeFor.matches ?? []).length === 0 ? (
            <div className="inv-row__meta" style={{ textAlign: "center", padding: 16 }}>
              אין התאמות מוצעות לטיוטה זו.
            </div>
          ) : (
            <div style={{ maxHeight: 360, overflowY: "auto" }}>
              {(mergeFor.matches ?? []).map((m) => (
                <button
                  key={m.itemId}
                  type="button"
                  className="inv-row"
                  style={{ marginBottom: 8 }}
                  onClick={() => void merge(mergeFor.id, m.itemId)}
                >
                  <span className="inv-row__mid">
                    <span className="inv-row__nm">{m.itemName}</span>
                    <span className="inv-row__meta">התאמה {Math.round((m.matchScore ?? 0) * 100)}%</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </BottomSheet>
      ) : null}
    </InventorySubPage>
  );
}
