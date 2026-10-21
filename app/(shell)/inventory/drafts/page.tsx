"use client";

import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { MessageKey, Translator } from "@/lib/i18n/translate";
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

const UNIT_OPTIONS: ReadonlyArray<{ value: string; labelKey: MessageKey }> = [
  { value: "UNIT", labelKey: "customers.inventory.units.long.UNIT" },
  { value: "KG", labelKey: "customers.inventory.units.long.KG" },
  { value: "GRAM", labelKey: "customers.inventory.units.long.GRAM" },
  { value: "LITER", labelKey: "customers.inventory.units.long.LITER" },
  { value: "ML", labelKey: "customers.inventory.units.long.ML" },
  { value: "BOX", labelKey: "customers.inventory.units.long.BOX" },
];

const THUMB_BG: Record<ConfidenceLevel, string> = { high: "var(--inv-success-bg)", mid: "var(--inv-warning-bg)", low: "var(--inv-danger-bg)" };

function safeImage(imageUrl?: string | null) {
  return imageUrl && !imageUrl.includes("example.com") ? imageUrl : null;
}

function confLevel(score: number | null | undefined, t: Translator): { level: ConfidenceLevel; label: string } {
  if (score == null) return { level: "mid", label: t("customers.inventory.drafts.confidence.review") };
  if (score >= 0.85) return { level: "high", label: t("customers.inventory.drafts.confidence.high") };
  if (score >= 0.6) return { level: "mid", label: t("customers.inventory.drafts.confidence.mid") };
  return { level: "low", label: t("customers.inventory.drafts.confidence.low") };
}

function buildHeaders() {
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;
  return { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

function DraftInspector({
  draft,
  busy,
  onApprove,
  onMerge,
  onReject,
}: {
  draft: Draft | null;
  busy: boolean;
  onApprove: (draft: Draft) => void;
  onMerge: (draft: Draft) => void;
  onReject: (id: number) => void;
}) {
  const { t } = useI18n();
  if (!draft) {
    return (
      <aside className="inv-ops__side">
        <h2>{t("customers.inventory.drafts.draft")}</h2>
        <p>{t("customers.inventory.drafts.selectHint")}</p>
      </aside>
    );
  }
  const conf = confLevel(draft.confidenceScore, t);
  return (
    <aside className="inv-ops__side">
      <h2>{draft.detectedName || t("customers.inventory.drafts.unrecognizedItem")}</h2>
      <p>{conf.label}{draft.detectedCategory ? ` · ${draft.detectedCategory}` : ""}</p>
      <p>{draft.detectedBarcode ? t("customers.inventory.drafts.barcodeValue", { barcode: draft.detectedBarcode }) : t("customers.inventory.drafts.noBarcode")} · {draft.detectedUnitType || t("customers.inventory.units.long.UNIT")}</p>
      {draft.matches && draft.matches.length > 0 ? (
        <p>{t("customers.inventory.drafts.possibleMatch", { name: draft.matches[0].itemName })}</p>
      ) : (
        <p>{t("customers.inventory.drafts.noMatch")}</p>
      )}
      <button type="button" className="inv-btn-primary" disabled={busy} onClick={() => onApprove(draft)}>{t("customers.inventory.drafts.approve")}</button>
      <button type="button" className="inv-btn-secondary" disabled={busy} onClick={() => onMerge(draft)}>{t("customers.inventory.drafts.merge")}</button>
      <button type="button" className="inv-btn-secondary" disabled={busy} onClick={() => onReject(draft.id)}>{t("customers.inventory.common.reject")}</button>
    </aside>
  );
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
  const { t } = useI18n();
  const unitOptions = UNIT_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) }));
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [approveFor, setApproveFor] = useState<Draft | null>(null);
  const [form, setForm] = useState<ApproveForm | null>(null);
  const [mergeFor, setMergeFor] = useState<Draft | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  async function loadDrafts() {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch("/api/inventory/drafts", { headers: buildHeaders() });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t("customers.inventory.drafts.loadFailed"));
      setDrafts(Array.isArray(data.drafts) ? data.drafts : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("customers.inventory.drafts.loadFailed"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void loadDrafts(), 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-time load, unchanged by i18n (the loader now reads `t` for its messages)
  }, []);

  const pending = useMemo(() => drafts.filter((d) => d.status === "PENDING_REVIEW"), [drafts]);

  function parseNumber(value: string): number | undefined {
    if (value.trim() === "") return undefined;
    const n = Number(value);
    if (Number.isNaN(n) || !Number.isFinite(n) || n < 0) throw new Error(t("customers.inventory.drafts.invalidNumber"));
    return n;
  }

  async function submitApprove() {
    if (!approveFor || !form || busyId) return;
    try {
      if (!form.name.trim()) throw new Error(t("customers.inventory.drafts.nameRequired"));
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
      if (!response.ok) throw new Error(data.error || t("customers.inventory.drafts.approveFailed"));
      setApproveFor(null);
      setForm(null);
      await loadDrafts();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("customers.inventory.drafts.approveFailed"));
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
      if (!response.ok) throw new Error(data.error || t("customers.inventory.drafts.mergeFailed"));
      setMergeFor(null);
      await loadDrafts();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("customers.inventory.drafts.mergeFailed"));
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
      if (!response.ok) throw new Error(data.error || t("customers.inventory.drafts.rejectFailed"));
      await loadDrafts();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("customers.inventory.drafts.rejectFailed"));
    } finally {
      setBusyId(null);
    }
  }

  function updateForm(field: keyof ApproveForm, value: string) {
    setForm((f) => (f ? { ...f, [field]: value } : f));
  }

  return (
    <InventorySubPage intent="data"
      title={t("customers.inventory.drafts.title")}
      variant="hub"
      hubBack
      sub={!loading && !error ? t("customers.inventory.drafts.sub") : undefined}
      bottomNav="home"
    >
      {error ? (
        <div className="inv-page-content" style={{ padding: "0 clamp(16px,3.5vw,28px)" }}>
          <InventoryStatePanel
            tone="error"
            title={t("customers.inventory.common.somethingWrong")}
            action={
              <button type="button" className="inv-btn-primary inv-btn-primary--full" onClick={() => void loadDrafts()}>
                {t("customers.inventory.common.retry")}
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
          <InventoryStatePanel title={t("customers.inventory.drafts.emptyTitle")}>{t("customers.inventory.drafts.emptyBody")}</InventoryStatePanel>
        </div>
      ) : (
        <>
        <div className="inv-ops">
          <div className="inv-desk-table" aria-label={t("customers.inventory.drafts.tableAria")}>
            <table>
              <thead>
                <tr>
                  <th>{t("customers.inventory.drafts.table.detected")}</th>
                  <th>{t("customers.inventory.drafts.table.category")}</th>
                  <th>{t("customers.inventory.drafts.table.barcode")}</th>
                  <th>{t("customers.inventory.drafts.table.confidence")}</th>
                </tr>
              </thead>
              <tbody>
                {pending.map((draft) => {
                  const conf = confLevel(draft.confidenceScore, t);
                  return (
                    <tr
                      key={draft.id}
                      className={draft.id === selectedId ? "is-selected" : undefined}
                      onClick={() => setSelectedId(draft.id)}
                    >
                      <td>{draft.detectedName || t("customers.inventory.drafts.unrecognizedItem")}</td>
                      <td>{draft.detectedCategory || "—"}</td>
                      <td>{draft.detectedBarcode || "—"}</td>
                      <td>{conf.label}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <DraftInspector
            draft={pending.find((draft) => draft.id === selectedId) ?? null}
            busy={busyId === selectedId}
            onApprove={(draft) => {
              setForm(emptyForm(draft));
              setApproveFor(draft);
            }}
            onMerge={setMergeFor}
            onReject={(id) => void reject(id)}
          />
        </div>
        <div className="inv-rows inv-decision-mobile">
          {pending.map((draft) => {
            const conf = confLevel(draft.confidenceScore, t);
            const busy = busyId === draft.id;
            const name = draft.detectedName || t("customers.inventory.drafts.unrecognizedItem");
            const metaParts = [
              draft.detectedCategory ? t("customers.inventory.drafts.categoryMeta", { category: draft.detectedCategory }) : null,
              draft.detectedBarcode ? t("customers.inventory.drafts.barcodeDetected") : null,
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
                      label: t("customers.inventory.drafts.approve"),
                      primary: true,
                      disabled: busy,
                      onClick: () => {
                        setForm(emptyForm(draft));
                        setApproveFor(draft);
                      },
                    },
                    {
                      label: t("customers.inventory.drafts.merge"),
                      disabled: busy,
                      onClick: () => setMergeFor(draft),
                    },
                    { label: t("customers.inventory.common.reject"), disabled: busy, onClick: () => void reject(draft.id) },
                  ]}
                />
              </DecisionCard>
            );
          })}
        </div>
        </>
      )}

      {approveFor && form ? (
        <BottomSheet
          title={t("customers.inventory.drafts.approveSheetTitle")}
          who={approveFor.detectedName || t("customers.inventory.drafts.newItem")}
          onClose={() => {
            setApproveFor(null);
            setForm(null);
          }}
          footer={
            <SheetActions
              confirmLabel={busyId === approveFor.id ? t("customers.inventory.drafts.approving") : t("customers.inventory.drafts.approveConfirm")}
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
            <div className="inv-field__lab">{t("customers.inventory.common.productName")} <span>*</span></div>
            <input className="inv-input" value={form.name} onChange={(e) => updateForm("name", e.target.value)} />
          </div>
          <div className="inv-field">
            <div className="inv-field__lab">{t("customers.inventory.common.unitOfMeasure")}</div>
            <SegmentedControl
              value={form.unitType}
              onChange={(v) => updateForm("unitType", v)}
              options={unitOptions}
            />
          </div>
          <div className="inv-two">
            <div className="inv-field">
              <div className="inv-field__lab">{t("customers.inventory.common.initialQuantity")}</div>
              <input className="inv-input" inputMode="numeric" value={form.initialQuantity} onChange={(e) => updateForm("initialQuantity", e.target.value)} />
            </div>
            <div className="inv-field">
              <div className="inv-field__lab">{t("customers.inventory.common.minThreshold")}</div>
              <input className="inv-input" inputMode="numeric" value={form.minimumQuantity} onChange={(e) => updateForm("minimumQuantity", e.target.value)} />
            </div>
          </div>
          <div className="inv-field">
            <div className="inv-field__lab">{t("customers.inventory.common.reorderThreshold")}</div>
            <input className="inv-input" inputMode="numeric" placeholder={t("customers.inventory.common.optional")} value={form.reorderPoint} onChange={(e) => updateForm("reorderPoint", e.target.value)} />
          </div>
          <div className="inv-field">
            <div className="inv-field__lab">{t("customers.inventory.common.barcode")}</div>
            <input className="inv-input" value={form.barcode} onChange={(e) => updateForm("barcode", e.target.value)} />
          </div>
        </BottomSheet>
      ) : null}

      {mergeFor ? (
        <BottomSheet
          title={t("customers.inventory.drafts.mergeSheetTitle")}
          who={mergeFor.detectedName || t("customers.inventory.drafts.draft")}
          onClose={() => setMergeFor(null)}
        >
          {(mergeFor.matches ?? []).length === 0 ? (
            <div className="inv-row__meta" style={{ textAlign: "center", padding: 16 }}>
              {t("customers.inventory.drafts.noSuggestedMatches")}
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
                    <span className="inv-row__meta">{t("customers.inventory.drafts.matchPercent", { percent: Math.round((m.matchScore ?? 0) * 100) })}</span>
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
