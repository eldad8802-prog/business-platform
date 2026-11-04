"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { inventoryToast } from "@/components/inventory/inventory-toast";
import { UNIT_OPTIONS } from "@/lib/inventory/unit-words";
import {
  I2,
  InvButton,
  InvConfirm,
  InvError,
  InvField,
  InvLoading,
  InvNote,
  InvPage,
  InvPill,
  InvRow,
  InvSheet,
  InvState,
  ProductThumb,
  useInvSubViewBack,
} from "@/components/inventory/v2/kit";

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

type NumberField = "initialQuantity" | "minimumQuantity" | "reorderPoint";

const PAGE = 50;
const LIST = "/inventory/drafts";

function safeImage(imageUrl?: string | null) {
  return imageUrl && !imageUrl.includes("example.com") ? imageUrl : null;
}

/** Confidence in words (thresholds unchanged: ≥0.85 high, ≥0.6 medium). */
function confidenceWords(score: number | null | undefined): string {
  if (score == null) return "ודאות לא ידועה";
  if (score >= 0.85) return "ודאות גבוהה";
  if (score >= 0.6) return "ודאות בינונית";
  return "ודאות נמוכה";
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

/** Same rule as before: blank → not sent; otherwise a finite number ≥ 0. */
function numberError(value: string): string | null {
  if (value.trim() === "") return null;
  const n = Number(value);
  if (Number.isNaN(n) || !Number.isFinite(n) || n < 0) return "יש להזין מספר תקין (0 ומעלה)";
  return null;
}

function parseNumber(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  return Number(value);
}

/**
 * Product drafts (טיוטות מוצר) — redesign, owner-approved mockup "בדיקת טיוטת מוצר".
 * A draft is approved as a new product (POST …/approve with the same body),
 * merged into an existing product (POST …/merge {targetItemId}) or rejected
 * (POST …/reject). Merging links the draft to the product and does not touch stock.
 */
function DraftsScreen() {
  const router = useRouter();
  const backFromDetail = useInvSubViewBack(LIST);
  const params = useSearchParams();
  const idParam = Number(params.get("id"));
  const openId = Number.isFinite(idParam) && idParam > 0 ? idParam : null;

  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [form, setForm] = useState<ApproveForm | null>(null);
  const [formFor, setFormFor] = useState<number | null>(null);
  const [choice, setChoice] = useState<"create" | number>("create");
  const [showErrors, setShowErrors] = useState(false);
  const [zoom, setZoom] = useState(false);
  const [confirmReject, setConfirmReject] = useState(false);
  const [limit, setLimit] = useState(PAGE);

  const loadDrafts = useCallback(async () => {
    try {
      setLoading(true);
      setError(false);
      const response = await fetch("/api/inventory/drafts", { headers: buildHeaders() });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "load failed");
      setDrafts(Array.isArray(data.drafts) ? data.drafts : []);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadDrafts(), 0);
    return () => window.clearTimeout(timer);
  }, [loadDrafts]);

  const pending = useMemo(() => drafts.filter((d) => d.status === "PENDING_REVIEW"), [drafts]);
  const draft = openId != null ? pending.find((d) => d.id === openId) ?? null : null;

  // Start a fresh review form whenever another draft is opened.
  useEffect(() => {
    if (!draft || formFor === draft.id) return;
    const timer = window.setTimeout(() => {
      setForm(emptyForm(draft));
      setFormFor(draft.id);
      setChoice("create");
      setShowErrors(false);
      setActionError(null);
      setZoom(false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [draft, formFor]);

  function updateForm(field: keyof ApproveForm, value: string) {
    setForm((f) => (f ? { ...f, [field]: value } : f));
  }

  function done(message: string) {
    inventoryToast.success(message);
    setFormFor(null);
    router.replace(LIST);
    void loadDrafts();
  }

  const errors = form
    ? {
        name: form.name.trim() ? null : "יש להזין שם מוצר",
        unitType: form.unitType.trim() ? null : "יש לבחור יחידת מידה",
        initialQuantity: numberError(form.initialQuantity),
        minimumQuantity: numberError(form.minimumQuantity),
        reorderPoint: numberError(form.reorderPoint),
      }
    : null;
  const formValid = Boolean(errors && Object.values(errors).every((e) => e == null));

  async function submitApprove() {
    if (!draft || !form || busy) return;
    if (!formValid) {
      setShowErrors(true);
      return;
    }
    try {
      setBusy(true);
      setActionError(null);
      const response = await fetch(`/api/inventory/drafts/${draft.id}/approve`, {
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
      if (!response.ok) throw new Error(data.error || "approve failed");
      done(`הטיוטה אושרה · נוצר המוצר ${form.name.trim()}`);
    } catch {
      setActionError("לא הצלחנו לאשר את הטיוטה. בדקו את הפרטים ונסו שוב.");
    } finally {
      setBusy(false);
    }
  }

  async function merge(targetItemId: number) {
    if (!draft || busy) return;
    const target = draft.matches?.find((m) => m.itemId === targetItemId);
    try {
      setBusy(true);
      setActionError(null);
      const response = await fetch(`/api/inventory/drafts/${draft.id}/merge`, {
        method: "POST",
        headers: buildHeaders(),
        body: JSON.stringify({ targetItemId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "merge failed");
      done(target ? `הטיוטה מוזגה עם ${target.itemName}` : "הטיוטה מוזגה עם המוצר הקיים");
    } catch {
      setActionError("לא הצלחנו למזג את הטיוטה. נסו שוב.");
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    if (!draft || busy) return;
    try {
      setBusy(true);
      setActionError(null);
      const response = await fetch(`/api/inventory/drafts/${draft.id}/reject`, {
        method: "POST",
        headers: buildHeaders(),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "reject failed");
      setConfirmReject(false);
      done("הטיוטה נדחתה");
    } catch {
      setConfirmReject(false);
      setActionError("לא הצלחנו לדחות את הטיוטה. נסו שוב.");
    } finally {
      setBusy(false);
    }
  }

  /* -------------------------------------------------------------- review -- */
  if (openId != null) {
    const image = safeImage(draft?.imageUrl);
    const matches = draft?.matches ?? [];
    const err = (k: keyof NonNullable<typeof errors>) => (showErrors && errors ? errors[k] : null);
    return (
      <InvPage
        title="בדיקת טיוטת מוצר"
        backFallback={LIST}
        onBack={backFromDetail}
        footer={
          draft && form && !loading && !error ? (
            <>
              {actionError ? <InvNote tone="danger">{actionError}</InvNote> : null}
              <InvButton block onClick={() => (choice === "create" ? void submitApprove() : void merge(choice))} disabled={busy}>
                {busy ? "שומר…" : "אישור הטיוטה"}
              </InvButton>
              <div style={{ marginTop: 8 }}>
                <InvButton kind="secondary" block onClick={() => setConfirmReject(true)} disabled={busy}>
                  דחיית הטיוטה
                </InvButton>
              </div>
            </>
          ) : null
        }
      >
        {loading ? (
          <InvLoading rows={3} />
        ) : error ? (
          <InvError onRetry={() => void loadDrafts()} />
        ) : !draft ? (
          <InvState
            title="הטיוטה הזו כבר טופלה או לא נמצאה"
            body="ייתכן שהיא אושרה, מוזגה או נדחתה כבר."
            action={<InvButton kind="secondary" onClick={() => router.replace(LIST)}>לרשימת הטיוטות</InvButton>}
          />
        ) : !form ? (
          <InvLoading rows={2} />
        ) : (
          <>
            {image ? (
              <div className="i2-hero-img">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={image} alt={`תמונת המקור של ${draft.detectedName || "הטיוטה"}`} />
                <button type="button" className="i2-iconbtn" onClick={() => setZoom(true)} aria-label="הגדלת התמונה">
                  {I2.zoom(22)}
                </button>
              </div>
            ) : null}
            <p className="i2-muted" style={{ margin: "8px 0 0", fontSize: 14 }}>
              {confidenceWords(draft.confidenceScore)}
              {draft.detectedCategory ? ` · קטגוריה שזוהתה: ${draft.detectedCategory}` : ""}
            </p>

            <h2 className="i2-h2">פרטים שזוהו — לבדיקה</h2>
            <InvField label="שם המוצר" required htmlFor="draft-name" error={err("name")}>
              <input
                id="draft-name"
                className="i2-input"
                value={form.name}
                aria-invalid={Boolean(err("name")) || undefined}
                onChange={(e) => updateForm("name", e.target.value)}
              />
            </InvField>
            <InvField label="יחידת מידה" required htmlFor="draft-unit" error={err("unitType")}>
              <select id="draft-unit" className="i2-select" value={form.unitType} onChange={(e) => updateForm("unitType", e.target.value)}>
                {UNIT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </InvField>
            {(
              [
                ["initialQuantity", "כמות התחלתית", undefined],
                ["minimumQuantity", "מלאי מינימום", undefined],
                ["reorderPoint", "נקודת הזמנה", "אופציונלי"],
              ] as Array<[NumberField, string, string | undefined]>
            ).map(([key, label, placeholder]) => (
              <InvField key={key} label={label} optional={key === "reorderPoint"} htmlFor={`draft-${key}`} error={err(key)}>
                <input
                  id={`draft-${key}`}
                  className="i2-input i2-num"
                  inputMode="decimal"
                  placeholder={placeholder}
                  value={form[key]}
                  aria-invalid={Boolean(err(key)) || undefined}
                  onChange={(e) => updateForm(key, e.target.value)}
                />
              </InvField>
            ))}
            <InvField label="ברקוד" optional htmlFor="draft-barcode">
              <input id="draft-barcode" className="i2-input i2-num" value={form.barcode} onChange={(e) => updateForm("barcode", e.target.value)} />
            </InvField>

            <h2 className="i2-h2">הצעה למוצר קיים</h2>
            <div role="radiogroup" aria-label="מה לעשות עם הטיוטה">
              {matches.map((m) => (
                <label key={m.itemId} className="i2-radio">
                  <input type="radio" name="draft-choice" checked={choice === m.itemId} onChange={() => setChoice(m.itemId)} />
                  <ProductThumb name={m.itemName} size={48} />
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span className="i2-clamp2" style={{ fontWeight: 600 }}>
                      {m.itemName}
                    </span>
                    <span className="i2-row__sub" style={{ display: "block" }}>
                      מיזוג עם המוצר הזה · התאמה {Math.round((m.matchScore ?? 0) * 100).toLocaleString("he-IL")}%
                    </span>
                  </span>
                </label>
              ))}
              {matches.length === 0 ? (
                <p className="i2-muted" style={{ margin: "0 0 4px" }}>
                  לא נמצא מוצר קיים דומה.
                </p>
              ) : null}
              <label className="i2-radio">
                <input type="radio" name="draft-choice" checked={choice === "create"} onChange={() => setChoice("create")} />
                <span className="i2-thumb" style={{ ["--s" as string]: "48px" }} aria-hidden>
                  {I2.plus(22)}
                </span>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ fontWeight: 600 }}>יצירת מוצר חדש</span>
                  <span className="i2-row__sub" style={{ display: "block" }}>
                    לפי הפרטים שלמעלה
                  </span>
                </span>
              </label>
            </div>
            {matches.length > 0 ? <InvNote>המיזוג מקשר את הטיוטה למוצר הקיים ואינו משנה את המלאי</InvNote> : null}
            {showErrors && !formValid && choice === "create" ? (
              <InvNote tone="danger">יש לתקן את השדות המסומנים לפני האישור.</InvNote>
            ) : null}
          </>
        )}

        {zoom && image ? (
          <InvSheet title="תמונת המקור" onClose={() => setZoom(false)}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={image} alt={`תמונת המקור של ${draft?.detectedName || "הטיוטה"}`} style={{ display: "block", width: "100%", height: "auto", borderRadius: 12 }} />
          </InvSheet>
        ) : null}
        {confirmReject && draft ? (
          <InvConfirm
            title="לדחות את הטיוטה?"
            body="הטיוטה תוסר מהרשימה ולא ייווצר ממנה מוצר."
            confirmLabel={busy ? "דוחה…" : "דחיית הטיוטה"}
            danger
            busy={busy}
            onConfirm={() => void reject()}
            onCancel={() => setConfirmReject(false)}
          />
        ) : null}
      </InvPage>
    );
  }

  /* ---------------------------------------------------------------- list -- */
  return (
    <InvPage title="טיוטות מוצר" backFallback="/inventory/items" wide>
      {loading ? (
        <InvLoading rows={4} />
      ) : error ? (
        <InvError onRetry={() => void loadDrafts()} />
      ) : pending.length === 0 ? (
        <InvState
          title="אין טיוטות שממתינות לבדיקה"
          body="מוצרים שזוהו מתמונה או ממסמך יופיעו כאן לאישור לפני שייכנסו למלאי."
          action={<InvButton kind="secondary" href="/inventory/items">למוצרים</InvButton>}
        />
      ) : (
        <>
          <p className="i2-muted" style={{ margin: "12px 0 0" }}>
            {pending.length === 1 ? "טיוטה אחת ממתינה לבדיקה" : `${pending.length.toLocaleString("he-IL")} טיוטות ממתינות לבדיקה`}
          </p>
          <ul className="i2-list">
            {pending.slice(0, limit).map((d) => {
              const name = d.detectedName || "פריט לא מזוהה";
              const href = `${LIST}?id=${d.id}`;
              return (
                <InvRow
                  key={d.id}
                  href={href}
                  thumb={<ProductThumb src={safeImage(d.imageUrl)} name={name} />}
                  title={name}
                  sub={`${confidenceWords(d.confidenceScore)}${d.detectedCategory ? ` · ${d.detectedCategory}` : ""}`}
                  trail={<InvPill href={href} ariaLabel={`בדיקת הטיוטה ${name}`}>בדיקה</InvPill>}
                />
              );
            })}
          </ul>
          {pending.length > limit ? (
            <div style={{ textAlign: "center", marginTop: 8 }}>
              <InvButton kind="soft" small onClick={() => setLimit((n) => n + PAGE)}>
                הצגת עוד
              </InvButton>
            </div>
          ) : null}
        </>
      )}
    </InvPage>
  );
}

// useSearchParams() requires a Suspense boundary for static prerender (Next).
export default function InventoryDraftsPage() {
  return (
    <Suspense fallback={null}>
      <DraftsScreen />
    </Suspense>
  );
}
