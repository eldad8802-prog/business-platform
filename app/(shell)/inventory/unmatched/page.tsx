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
  InventorySearch,
  type ConfidenceLevel,
} from "@/components/inventory/inventory-design";
import {
  getInventoryItems,
  getPendingMatches,
  resolvePendingMatch,
  type InventoryItemDTO,
  type InventoryPendingMatchDTO,
} from "@/lib/api/inventory";

type Match = { item: InventoryItemDTO | null; level: ConfidenceLevel; label: string };

function getErrorMessage(err: unknown, fallback: string) {
  return err instanceof Error ? err.message : fallback;
}

/** Best match + confidence band, mirroring the previous scoring logic. */
function bestMatch(pending: InventoryPendingMatchDTO, items: InventoryItemDTO[]): Match {
  const meta = pending.metadata;
  let best: InventoryItemDTO | null = null;
  let score = 0;

  for (const item of items) {
    let s = 0;
    if (meta.barcode && item.barcode === meta.barcode) s += 100;
    if (meta.sku && (item as InventoryItemDTO & { sku?: string | null }).sku === meta.sku) s += 80;
    if (meta.name && item.name) {
      const n = meta.name.toLowerCase();
      const i = item.name.toLowerCase();
      if (i.includes(n) || n.includes(i)) s += 50;
    }
    if (s > score) {
      score = s;
      best = item;
    }
  }

  if (score >= 80) return { item: best, level: "high", label: "התאמה גבוהה" };
  if (score >= 50) return { item: best, level: "mid", label: "התאמה בינונית" };
  return { item: null, level: "low", label: "ללא התאמה" };
}

const THUMB_BG: Record<ConfidenceLevel, string> = {
  high: "var(--inv-success-bg)",
  mid: "var(--inv-warning-bg)",
  low: "var(--inv-danger-bg)",
};

function formatWhen(value?: string) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("he-IL", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function InventoryUnmatchedPage() {
  const [pendingMatches, setPendingMatches] = useState<InventoryPendingMatchDTO[]>([]);
  const [items, setItems] = useState<InventoryItemDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [linkFor, setLinkFor] = useState<InventoryPendingMatchDTO | null>(null);
  const [linkQuery, setLinkQuery] = useState("");

  async function loadData() {
    try {
      setLoading(true);
      setError(null);
      const [pendingData, itemsData] = await Promise.all([getPendingMatches(), getInventoryItems()]);
      setPendingMatches(Array.isArray(pendingData) ? pendingData : []);
      setItems(Array.isArray(itemsData) ? itemsData : []);
    } catch (err: unknown) {
      const message = getErrorMessage(err, "שגיאה בטעינת המכירות שלא זוהו");
      setError(message === "UNAUTHORIZED" ? "אין הרשאה. צריך להתחבר מחדש." : message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void loadData(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const activeItems = useMemo(() => items.filter((item) => item.id && item.name), [items]);

  async function linkExisting(pending: InventoryPendingMatchDTO, itemId: number) {
    if (busyId) return;
    try {
      setBusyId(pending.id);
      setError(null);
      await resolvePendingMatch(pending.id, { action: "LINK_EXISTING", itemId });
      setLinkFor(null);
      setLinkQuery("");
      await loadData();
    } catch (err) {
      setError(getErrorMessage(err, "שגיאה בשיוך המכירה"));
    } finally {
      setBusyId(null);
    }
  }

  async function createNew(pending: InventoryPendingMatchDTO) {
    if (busyId) return;
    const meta = pending.metadata;
    try {
      setBusyId(pending.id);
      setError(null);
      await resolvePendingMatch(pending.id, {
        action: "CREATE_NEW",
        itemData: {
          name: meta.name || meta.sku || meta.barcode || "מוצר חדש מהקופה",
          unitType: "UNIT",
          minimumQuantity: 0,
          reorderPoint: null,
          costPerUnit: 0,
          sellPricePerUnit: 0,
          sku: meta.sku,
          barcode: meta.barcode,
        },
      });
      await loadData();
    } catch (err) {
      setError(getErrorMessage(err, "שגיאה ביצירת המוצר"));
    } finally {
      setBusyId(null);
    }
  }

  async function reject(pending: InventoryPendingMatchDTO) {
    if (busyId) return;
    try {
      setBusyId(pending.id);
      setError(null);
      await resolvePendingMatch(pending.id, { action: "REJECT" });
      await loadData();
    } catch (err) {
      setError(getErrorMessage(err, "שגיאה בדחיית האירוע"));
    } finally {
      setBusyId(null);
    }
  }

  const linkItems = useMemo(() => {
    const q = linkQuery.trim().toLowerCase();
    if (!q) return activeItems;
    return activeItems.filter((item) =>
      [item.name, item.sku, item.barcode].filter(Boolean).some((f) => String(f).toLowerCase().includes(q))
    );
  }, [activeItems, linkQuery]);

  return (
    <InventorySubPage
      title="מכירות לא מזוהות"
      variant="hub"
      sub={
        !loading && !error
          ? `${pendingMatches.length} מכירות מה-POS לא נמצא להן מוצר תואם`
          : undefined
      }
      bottomNav="home"
    >
      {error ? (
        <div className="inv-page-content" style={{ padding: "0 clamp(16px,3.5vw,28px)" }}>
          <InventoryStatePanel
            tone="error"
            title="משהו השתבש"
            action={
              <button type="button" className="inv-btn-primary inv-btn-primary--full" onClick={() => void loadData()}>
                נסה שוב
              </button>
            }
          >
            {error}
          </InventoryStatePanel>
        </div>
      ) : loading ? (
        <div className="inv-rows">
          <InventorySkeletonBlock height={150} rows={2} />
        </div>
      ) : pendingMatches.length === 0 ? (
        <div className="inv-page-content" style={{ padding: "0 clamp(16px,3.5vw,28px)" }}>
          <InventoryStatePanel title="אין מכירות שממתינות להתאמה">
            כל המכירות שנקלטו מהקופה זוהו או טופלו.
          </InventoryStatePanel>
        </div>
      ) : (
        <div className="inv-rows">
          {pendingMatches.map((pending) => {
            const meta = pending.metadata;
            const match = bestMatch(pending, activeItems);
            const busy = busyId === pending.id;
            const rawName = meta.name || meta.sku || meta.barcode || "מכירה לא מזוהה";
            return (
              <DecisionCard key={pending.id}>
                <div className="inv-dcard__top">
                  <span
                    className="inv-row__thumb"
                    style={{ background: THUMB_BG[match.level], width: 46, height: 46, fontSize: 20 }}
                    aria-hidden
                  >
                    🧾
                  </span>
                  <div className="inv-row__mid">
                    <div className="inv-row__nm">&quot;{rawName}&quot;</div>
                    <div className="inv-row__meta">
                      <bdi>{meta.source || "POS"}</bdi> · נמכרו <bdi>{meta.quantity}</bdi>
                      {formatWhen(pending.createdAt) ? <> · <bdi>{formatWhen(pending.createdAt)}</bdi></> : null}
                    </div>
                  </div>
                  <ConfidencePill level={match.level} label={match.label} />
                </div>

                <div className="inv-row__meta" style={{ marginTop: 10 }}>
                  {match.item ? (
                    <>התאמה מוצעת: <b style={{ color: "var(--inv-text)" }}>{match.item.name}</b></>
                  ) : (
                    "לא נמצא מוצר דומה במלאי"
                  )}
                </div>

                <DecisionChips
                  choices={[
                    {
                      label: "קשר לקיים",
                      primary: Boolean(match.item),
                      disabled: busy,
                      onClick: () =>
                        match.item ? void linkExisting(pending, match.item.id) : setLinkFor(pending),
                    },
                    {
                      label: "מוצר חדש",
                      primary: !match.item,
                      disabled: busy,
                      onClick: () => void createNew(pending),
                    },
                    { label: "דחה", disabled: busy, onClick: () => void reject(pending) },
                  ]}
                />
              </DecisionCard>
            );
          })}
        </div>
      )}

      {linkFor ? (
        <BottomSheet
          title="קישור מכירה למוצר"
          who={`"${linkFor.metadata.name || linkFor.metadata.sku || "מכירה"}"`}
          onClose={() => {
            setLinkFor(null);
            setLinkQuery("");
          }}
        >
          <InventorySearch value={linkQuery} onChange={setLinkQuery} placeholder="חיפוש מוצר במלאי" />
          <div style={{ marginTop: 12, maxHeight: 360, overflowY: "auto" }}>
            {linkItems.map((item) => (
              <button
                key={item.id}
                type="button"
                className="inv-row"
                style={{ marginBottom: 8 }}
                onClick={() => void linkExisting(linkFor, item.id)}
              >
                <span className="inv-row__mid">
                  <span className="inv-row__nm">{item.name}</span>
                  <span className="inv-row__meta">כמות נוכחית: {item.currentQuantity}</span>
                </span>
              </button>
            ))}
            {linkItems.length === 0 ? (
              <div className="inv-row__meta" style={{ textAlign: "center", padding: 16 }}>
                לא נמצאו מוצרים
              </div>
            ) : null}
          </div>
        </BottomSheet>
      ) : null}
    </InventorySubPage>
  );
}
