"use client";

/**
 * Product detail — owner-approved redesign mockup "פרטי מוצר" (2026-11-03).
 * Rendered by app/(shell)/inventory/items/[id]/page.tsx. Editing lives on its own
 * route (/inventory/items/[id]/edit); stock changes open the movement sheet
 * (also from ?move=IN|OUT|ADJUSTMENT). Data: the item and its movements, exactly
 * as before; "טופל" resolves an open alert and reloads.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  getInventoryItemById,
  getInventoryMovementsByItemId,
  resolveInventoryAlert,
  type InventoryItemDTO,
  type InventoryMovementDTO,
} from "@/lib/api/inventory";
import MovementSheet, { type MovementKind } from "@/components/inventory/movement-sheet";
import { getStockTone } from "@/components/inventory/inventory-design";
import { getAlertTypeLabel, getMovementReasonLabel, getMovementTypeLabel } from "@/lib/inventory/inventory-labels";
import { qtyWithUnit, unitWord } from "@/lib/inventory/unit-words";
import { useI18n } from "@/components/i18n/I18nProvider";
import {
  I2,
  InvButton,
  InvError,
  InvLoading,
  InvNote,
  InvPage,
  InvState,
  InvStatus,
  ProductThumb,
  formatMoney,
  formatQty,
} from "@/components/inventory/v2/kit";

const HISTORY_STEP = 10;
/** What the movements endpoint returns by default (take: 50). */
const SERVER_MOVEMENT_LIMIT = 50;

function getErrorMessage(err: unknown, fallback: string) {
  return err instanceof Error ? err.message : fallback;
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}
/** "d.m.yyyy" */
function shortDate(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;
}
/** "HH:mm, d.m.yyyy" */
function dateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}, ${shortDate(iso)}`;
}

function parseMove(v: string | null): MovementKind | null {
  return v === "IN" || v === "OUT" || v === "ADJUSTMENT" ? v : null;
}

type LoadError = { kind: "not-found" } | { kind: "other"; message: string };

export default function ProductDetailView({ itemId }: { itemId: number }) {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [item, setItem] = useState<InventoryItemDTO | null>(null);
  const [movements, setMovements] = useState<InventoryMovementDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<LoadError | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [resolvingAlertId, setResolvingAlertId] = useState<number | null>(null);
  const [movementKind, setMovementKind] = useState<MovementKind | null>(() => parseMove(searchParams.get("move")));
  const [shown, setShown] = useState(HISTORY_STEP);
  const [moreOpen, setMoreOpen] = useState(false);

  const loadItemData = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!itemId || Number.isNaN(itemId)) {
        setLoadError({ kind: "not-found" });
        setLoading(false);
        return;
      }
      try {
        if (!options?.silent) setLoading(true);
        setLoadError(null);
        const [itemData, movementsData] = await Promise.all([getInventoryItemById(itemId), getInventoryMovementsByItemId(itemId)]);
        setItem(itemData);
        setMovements(Array.isArray(movementsData) ? movementsData : []);
      } catch (err: unknown) {
        const message = getErrorMessage(err, t("customers.inventoryKit.product.loadError"));
        if (message === "NOT_FOUND") setLoadError({ kind: "not-found" });
        else if (message === "UNAUTHORIZED") setLoadError({ kind: "other", message: t("customers.inventoryKit.product.unauthorized") });
        else setLoadError({ kind: "other", message });
      } finally {
        setLoading(false);
      }
    },
    [itemId, t]
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void loadItemData(), 0);
    return () => window.clearTimeout(timer);
  }, [loadItemData]);

  function closeMovement() {
    setMovementKind(null);
    // A deep link (?move=…) opened the sheet: drop it so a refresh does not reopen it.
    if (searchParams.get("move")) router.replace(pathname || `/inventory/items/${itemId}`, { scroll: false });
  }

  async function handleResolveAlert(alertId: number) {
    if (resolvingAlertId) return;
    try {
      setResolvingAlertId(alertId);
      setActionError(null);
      await resolveInventoryAlert(alertId);
      await loadItemData({ silent: true });
    } catch (err: unknown) {
      setActionError(getErrorMessage(err, t("customers.inventoryKit.product.resolveError")));
    } finally {
      setResolvingAlertId(null);
    }
  }

  let content: ReactNode;
  if (loading) {
    content = <InvLoading rows={4} />;
  } else if (loadError?.kind === "not-found") {
    content = (
      <InvState
        title="המוצר לא נמצא"
        body="ייתכן שהמוצר הוסר או שהקישור שגוי."
        action={
          <InvButton kind="secondary" href="/inventory/items">
            לרשימת המוצרים
          </InvButton>
        }
      />
    );
  } else if (loadError || !item) {
    content = <InvError message={loadError?.kind === "other" ? loadError.message : undefined} onRetry={() => void loadItemData()} />;
  } else {
    const tone = getStockTone(item);
    const unitOne = unitWord(item.unitType, 1);
    const meta = [item.supplierName, unitOne].filter(Boolean).join(" · ");
    const lastPurchaseDate = shortDate(item.lastPurchaseCostAt);
    const alerts = item.alerts ?? [];

    const kvRows: Array<[string, string]> = [
      [`עלות ל${unitOne}`, formatMoney(item.costPerUnit)],
      ["מחיר מכירה", formatMoney(item.sellPricePerUnit)],
      ["סף מינימום", qtyWithUnit(item.minimumQuantity, item.unitType)],
      ["נקודת הזמנה", item.reorderPoint != null ? qtyWithUnit(item.reorderPoint, item.unitType) : "—"],
      ["עלות רכש אחרונה", item.lastPurchaseCost != null ? `${formatMoney(item.lastPurchaseCost)}${lastPurchaseDate ? ` · ${lastPurchaseDate}` : ""}` : "—"],
      ["ברקוד", item.barcode || "—"],
      ["מק״ט", item.sku || "—"],
      ["קטגוריה", item.category?.name || "—"],
      ["ספק", item.supplierName || "—"],
    ];
    const kv = (
      <dl className="i2-kv">
        {kvRows.map(([k, v]) => (
          <div className="i2-kv__r" key={k}>
            <dt>{k}</dt>
            <dd>
              <bdi>{v}</bdi>
            </dd>
          </div>
        ))}
      </dl>
    );

    const alertsBlock =
      alerts.length > 0 ? (
        <section aria-label="התראות פתוחות">
          <h2 className="i2-h3">התראות פתוחות</h2>
          <ul className="i2-list">
            {alerts.map((alert) => (
              <li key={alert.id} className="i2-row" style={{ minHeight: 60 }}>
                <span className="i2-row__text">
                  <span className="i2-row__title" style={{ fontSize: 15.5 }}>
                    <span>{getAlertTypeLabel(alert.type, t)}</span>
                  </span>
                  {alert.message ? <span className="i2-row__sub">{alert.message}</span> : null}
                </span>
                <InvButton kind="secondary" small disabled={resolvingAlertId !== null} onClick={() => void handleResolveAlert(alert.id)}>
                  {resolvingAlertId === alert.id ? t("customers.inventoryKit.product.closing") : "טופל"}
                </InvButton>
              </li>
            ))}
          </ul>
        </section>
      ) : null;

    const visible = movements.slice(0, shown);
    const history = (
      <section aria-label="תנועות אחרונות">
        <h2 className="i2-h2">תנועות אחרונות</h2>
        {movements.length === 0 ? (
          <p className="i2-muted" style={{ margin: 0 }}>
            {t("customers.inventoryKit.product.noMovements")}
          </p>
        ) : (
          <>
            <ul className="i2-list">
              {visible.map((mv) => {
                const up = mv.quantityDelta >= 0;
                const amount = formatQty(Math.abs(mv.quantityDelta));
                return (
                  <li key={mv.id} className="i2-row" style={{ minHeight: 60 }}>
                    <span className="i2-row__text">
                      <span className="i2-row__title" style={{ fontSize: 15.5 }}>
                        <span>
                          {getMovementReasonLabel(mv.reason, t)} – {getMovementTypeLabel(mv.movementType, t)}
                        </span>
                      </span>
                      <span className="i2-row__sub i2-line">
                        <bdi>{dateTime(mv.createdAt)}</bdi>
                      </span>
                      {mv.note ? <span className="i2-row__sub i2-line">{mv.note}</span> : null}
                    </span>
                    <span className={`i2-delta ${up ? "i2-delta--up" : "i2-delta--down"}`} aria-label={`${up ? "נוספו" : "הופחתו"} ${amount}`}>
                      {up ? "+" : "-"}
                      {amount}
                    </span>
                  </li>
                );
              })}
            </ul>
            {movements.length > shown ? (
              <div style={{ marginTop: 10 }}>
                <InvButton kind="secondary" block onClick={() => setShown((n) => n + HISTORY_STEP)}>
                  הצגת עוד
                </InvButton>
              </div>
            ) : null}
            {movements.length >= SERVER_MOVEMENT_LIMIT ? <p className="i2-foot">מוצגות {movements.length} התנועות האחרונות</p> : null}
          </>
        )}
      </section>
    );

    const created = shortDate(item.createdAt);
    const more = (
      <div style={{ marginTop: 12 }}>
        <button
          type="button"
          className="i2-underline"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen((o) => !o)}
          style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 4 }}
        >
          פרטים נוספים {moreOpen ? I2.chevronUp(18) : I2.chevronEnd(18)}
        </button>
        {moreOpen ? (
          <dl className="i2-kv">
            <div className="i2-kv__r">
              <dt>תיאור</dt>
              <dd style={{ whiteSpace: "pre-wrap" }}>{item.description?.trim() || "—"}</dd>
            </div>
            <div className="i2-kv__r">
              <dt>מוצר מובלט</dt>
              <dd>{item.featuredByOwner ? "כן" : "לא"}</dd>
            </div>
            <div className="i2-kv__r">
              <dt>נוצר בתאריך</dt>
              <dd>
                <bdi>{created ?? "—"}</bdi>
              </dd>
            </div>
          </dl>
        ) : null}
      </div>
    );

    content = (
      <>
        {actionError ? <InvNote tone="danger">{actionError}</InvNote> : null}
        <div className="i2-desk">
          <div>
            <div className="i2-hero">
              <ProductThumb src={item.imageUrl} name={item.name} size={96} />
              <div className="i2-hero__text">
                <h2 className="i2-hero__name" style={{ paddingInlineEnd: 80 }}>
                  {item.name}
                </h2>
                {meta ? <p className="i2-hero__meta">{meta}</p> : null}
                <div className="i2-hero__chips">
                  <InvStatus tone={tone === "ok" ? "ok" : undefined}>
                    <bdi>{qtyWithUnit(item.currentQuantity, item.unitType)}</bdi>&nbsp;במלאי
                  </InvStatus>
                  {tone === "critical" ? (
                    <InvStatus tone="danger">
                      מלאי קריטי · סף מינימום&nbsp;<bdi>{formatQty(item.minimumQuantity)}</bdi>
                    </InvStatus>
                  ) : tone === "low" ? (
                    <InvStatus tone="warn">
                      מלאי נמוך · נקודת הזמנה&nbsp;<bdi>{formatQty(item.reorderPoint)}</bdi>
                    </InvStatus>
                  ) : null}
                </div>
              </div>
              <Link
                href={`/inventory/items/${item.id}/edit`}
                className="i2-link"
                style={{ position: "absolute", top: 0, insetInlineEnd: 0 }}
                aria-label={`עריכת ${item.name}`}
              >
                עריכה {I2.edit(16)}
              </Link>
            </div>

            <div style={{ marginTop: 14 }}>
              <InvButton block href={`/inventory/supplier-purchases/new?item=${item.id}`}>
                {I2.truck(22)}
                הזמנה מספק
              </InvButton>
            </div>
            <div className="i2-tiles i2-tiles--3" style={{ marginTop: 10 }}>
              <button type="button" className="i2-tile i2-tile--stack" onClick={() => setMovementKind("IN")}>
                {I2.plus(24)}
                <span>הוספה</span>
              </button>
              <button type="button" className="i2-tile i2-tile--stack" onClick={() => setMovementKind("OUT")}>
                {I2.minus(24)}
                <span>הפחתה</span>
              </button>
              <button type="button" className="i2-tile i2-tile--stack" onClick={() => setMovementKind("ADJUSTMENT")}>
                {I2.list(24)}
                <span>תיקון ספירה</span>
              </button>
            </div>

            <div className="i2-mob-only">
              <h2 className="i2-h3">פרטי המוצר</h2>
              {kv}
              {alertsBlock}
            </div>

            {history}
            {more}
          </div>
          <aside className="i2-desk__side i2-desk-only">
            <h2 className="i2-h3" style={{ marginTop: 6 }}>
              פרטי המוצר
            </h2>
            {kv}
            {alertsBlock}
          </aside>
        </div>

        {movementKind ? (
          <MovementSheet
            itemId={item.id}
            itemName={item.name}
            imageUrl={item.imageUrl}
            currentQuantity={item.currentQuantity}
            unitType={item.unitType}
            initialType={movementKind}
            onClose={closeMovement}
            onSuccess={() => loadItemData({ silent: true })}
          />
        ) : null}
      </>
    );
  }

  return (
    <InvPage title="פרטי מוצר" backFallback="/inventory/items" wide>
      {content}
    </InvPage>
  );
}
