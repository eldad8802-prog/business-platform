"use client";

import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/components/i18n/I18nProvider";
import { intlTag, type Locale } from "@/lib/i18n/config";
import type { Translator } from "@/lib/i18n/translate";
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
function bestMatch(pending: InventoryPendingMatchDTO, items: InventoryItemDTO[], t: Translator): Match {
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

  if (score >= 80) return { item: best, level: "high", label: t("customers.inventory.unmatched.match.high") };
  if (score >= 50) return { item: best, level: "mid", label: t("customers.inventory.unmatched.match.mid") };
  return { item: null, level: "low", label: t("customers.inventory.unmatched.match.none") };
}

const THUMB_BG: Record<ConfidenceLevel, string> = {
  high: "var(--inv-success-bg)",
  mid: "var(--inv-warning-bg)",
  low: "var(--inv-danger-bg)",
};

function formatWhen(value: string | undefined, locale: Locale) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(intlTag(locale), { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });
}

function UnmatchedInspector({
  pending,
  items,
  busy,
  onLinkSuggested,
  onSearch,
  onCreate,
  onReject,
}: {
  pending: InventoryPendingMatchDTO | null;
  items: InventoryItemDTO[];
  busy: boolean;
  onLinkSuggested: (pending: InventoryPendingMatchDTO, itemId: number) => void;
  onSearch: (pending: InventoryPendingMatchDTO) => void;
  onCreate: (pending: InventoryPendingMatchDTO) => void;
  onReject: (pending: InventoryPendingMatchDTO) => void;
}) {
  const { t } = useI18n();
  if (!pending) {
    return (
      <aside className="inv-ops__side">
        <h2>{t("customers.inventory.common.sale")}</h2>
        <p>{t("customers.inventory.unmatched.selectHint")}</p>
      </aside>
    );
  }
  const match = bestMatch(pending, items, t);
  const name = pending.metadata.name || pending.metadata.sku || pending.externalSaleId;
  return (
    <aside className="inv-ops__side">
      <h2>{name}</h2>
      <p>{pending.metadata.source || "POS"} · {t("customers.inventory.unmatched.soldQty", { quantity: pending.metadata.quantity })}</p>
      <p>{match.item ? t("customers.inventory.unmatched.suggestedMatch", { name: match.item.name }) : t("customers.inventory.unmatched.noSimilar")}</p>
      <p>{match.label}</p>
      <button
        type="button"
        className="inv-btn-primary"
        disabled={busy}
        onClick={() => (match.item ? onLinkSuggested(pending, match.item.id) : onSearch(pending))}
      >
        {t("customers.inventory.common.linkExisting")}
      </button>
      <button type="button" className="inv-btn-secondary" disabled={busy} onClick={() => onCreate(pending)}>{t("customers.inventory.common.newProduct")}</button>
      <button type="button" className="inv-btn-secondary" disabled={busy} onClick={() => onReject(pending)}>{t("customers.inventory.common.reject")}</button>
    </aside>
  );
}

export default function InventoryUnmatchedPage() {
  const { t, locale } = useI18n();
  const [pendingMatches, setPendingMatches] = useState<InventoryPendingMatchDTO[]>([]);
  const [items, setItems] = useState<InventoryItemDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [linkFor, setLinkFor] = useState<InventoryPendingMatchDTO | null>(null);
  const [linkQuery, setLinkQuery] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);

  async function loadData() {
    try {
      setLoading(true);
      setError(null);
      const [pendingData, itemsData] = await Promise.all([getPendingMatches(), getInventoryItems()]);
      setPendingMatches(Array.isArray(pendingData) ? pendingData : []);
      setItems(Array.isArray(itemsData) ? itemsData : []);
    } catch (err: unknown) {
      const message = getErrorMessage(err, t("customers.inventory.unmatched.loadFailed"));
      setError(message === "UNAUTHORIZED" ? t("customers.inventory.common.noAuth") : message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void loadData(), 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-time load, unchanged by i18n (the loader now reads `t` for its messages)
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
      setError(getErrorMessage(err, t("customers.inventory.unmatched.linkFailed")));
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
          // Stored product name (data sent to the API) — intentionally not localized.
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
      setError(getErrorMessage(err, t("customers.inventory.common.createItemFailed")));
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
      setError(getErrorMessage(err, t("customers.inventory.unmatched.rejectFailed")));
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
    <InventorySubPage intent="data"
      title={t("customers.inventory.unmatched.title")}
      variant="hub"
      hubBack
      sub={
        !loading && !error
          ? t(pendingMatches.length === 1 ? "customers.inventory.unmatched.subOne" : "customers.inventory.unmatched.subMany", { count: pendingMatches.length })
          : undefined
      }
      bottomNav="home"
    >
      {error ? (
        <div className="inv-page-content" style={{ padding: "0 clamp(16px,3.5vw,28px)" }}>
          <InventoryStatePanel
            tone="error"
            title={t("customers.inventory.common.somethingWrong")}
            action={
              <button type="button" className="inv-btn-primary inv-btn-primary--full" onClick={() => void loadData()}>
                {t("customers.inventory.common.retry")}
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
          <InventoryStatePanel title={t("customers.inventory.unmatched.emptyTitle")}>
            {t("customers.inventory.unmatched.emptyBody")}
          </InventoryStatePanel>
        </div>
      ) : (
        <>
        <div className="inv-ops">
          <div className="inv-desk-table" aria-label={t("customers.inventory.common.unmatchedSalesAria")}>
            <table>
              <thead>
                <tr>
                  <th>{t("customers.inventory.unmatched.table.sale")}</th>
                  <th>{t("customers.inventory.unmatched.table.source")}</th>
                  <th>{t("customers.inventory.unmatched.table.quantity")}</th>
                  <th>{t("customers.inventory.unmatched.table.match")}</th>
                </tr>
              </thead>
              <tbody>
                {pendingMatches.map((pending) => {
                  const match = bestMatch(pending, activeItems, t);
                  return (
                    <tr
                      key={pending.id}
                      className={pending.id === selectedId ? "is-selected" : undefined}
                      onClick={() => setSelectedId(pending.id)}
                    >
                      <td>{pending.metadata.name || pending.metadata.sku || pending.externalSaleId}</td>
                      <td>{pending.metadata.source || "POS"}</td>
                      <td className="num">{pending.metadata.quantity}</td>
                      <td>{match.item ? match.item.name : match.label}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <UnmatchedInspector
            pending={pendingMatches.find((pending) => pending.id === selectedId) ?? null}
            items={activeItems}
            busy={busyId === selectedId}
            onLinkSuggested={(pending, itemId) => void linkExisting(pending, itemId)}
            onSearch={setLinkFor}
            onCreate={(pending) => void createNew(pending)}
            onReject={(pending) => void reject(pending)}
          />
        </div>
        <div className="inv-rows inv-decision-mobile">
          {pendingMatches.map((pending) => {
            const meta = pending.metadata;
            const match = bestMatch(pending, activeItems, t);
            const busy = busyId === pending.id;
            const rawName = meta.name || meta.sku || meta.barcode || t("customers.inventory.unmatched.unrecognizedSale");
            const when = formatWhen(pending.createdAt, locale);
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
                      <bdi>{meta.source || "POS"}</bdi> · {t("customers.inventory.unmatched.sold")} <bdi>{meta.quantity}</bdi>
                      {when ? <> · <bdi>{when}</bdi></> : null}
                    </div>
                  </div>
                  <ConfidencePill level={match.level} label={match.label} />
                </div>

                <div className="inv-row__meta" style={{ marginTop: 10 }}>
                  {match.item ? (
                    <>{t("customers.inventory.unmatched.suggestedMatchLabel")} <b style={{ color: "var(--inv-text)" }}>{match.item.name}</b></>
                  ) : (
                    t("customers.inventory.unmatched.noSimilar")
                  )}
                </div>

                <DecisionChips
                  choices={[
                    {
                      label: t("customers.inventory.common.linkExisting"),
                      primary: Boolean(match.item),
                      disabled: busy,
                      onClick: () =>
                        match.item ? void linkExisting(pending, match.item.id) : setLinkFor(pending),
                    },
                    {
                      label: t("customers.inventory.common.newProduct"),
                      primary: !match.item,
                      disabled: busy,
                      onClick: () => void createNew(pending),
                    },
                    { label: t("customers.inventory.common.reject"), disabled: busy, onClick: () => void reject(pending) },
                  ]}
                />
              </DecisionCard>
            );
          })}
        </div>
        </>
      )}

      {linkFor ? (
        <BottomSheet
          title={t("customers.inventory.unmatched.linkSheetTitle")}
          who={`"${linkFor.metadata.name || linkFor.metadata.sku || t("customers.inventory.common.sale")}"`}
          onClose={() => {
            setLinkFor(null);
            setLinkQuery("");
          }}
        >
          <InventorySearch value={linkQuery} onChange={setLinkQuery} placeholder={t("customers.inventory.unmatched.searchPlaceholder")} />
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
                  <span className="inv-row__meta">{t("customers.inventory.unmatched.currentQty", { quantity: item.currentQuantity })}</span>
                </span>
              </button>
            ))}
            {linkItems.length === 0 ? (
              <div className="inv-row__meta" style={{ textAlign: "center", padding: 16 }}>
                {t("customers.inventory.common.noProductsFound")}
              </div>
            ) : null}
          </div>
        </BottomSheet>
      ) : null}
    </InventorySubPage>
  );
}
