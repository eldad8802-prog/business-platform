"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import MovementModal from "@/components/inventory/movement-modal";
import {
  AttentionCard,
  IconAlert,
  IconArrows,
  IconBox,
  IconCart,
  IconClipboard,
  IconPlusBox,
  IconQuestion,
  IconSale,
  IconTruck,
  InventoryBottomNav,
  QuickActionTile,
  SectionHeader,
  StatusPill,
  StockBar,
  getStockRatio,
  getStockStatusLabel,
  getStockTone,
  inventoryCardStyle,
  inventoryMainStyle,
  inventoryPageStyle,
  inventoryResponsiveCss,
  inventoryTheme,
} from "@/components/inventory/inventory-design";
import {
  getInventoryItems,
  getPendingMatches,
  type InventoryItemDTO,
} from "@/lib/api/inventory";
import {
  buildClientAuthHeaders,
  getClientAuthToken,
  isUnauthorizedError,
  redirectToLogin,
} from "@/lib/client-session";

type DashboardCounts = {
  unmatched: number;
  drafts: number;
  pendingOrders: number;
  criticalStock: number;
  reorderAlerts: number;
};

type MovementPick = {
  itemId: number;
  itemName: string;
  mode: "ADD" | "REMOVE";
} | null;

function isValidImageUrl(imageUrl?: string | null) {
  if (!imageUrl) return false;
  if (imageUrl.includes("example.com")) return false;
  return true;
}

const STOCK_ROW_COLUMNS = "minmax(0, 1.5fr) 100px auto 28px 44px";

export default function InventoryPage() {
  const router = useRouter();
  const [items, setItems] = useState<InventoryItemDTO[]>([]);
  const [counts, setCounts] = useState<DashboardCounts>({
    unmatched: 0,
    drafts: 0,
    pendingOrders: 0,
    criticalStock: 0,
    reorderAlerts: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [showAllItems, setShowAllItems] = useState(false);
  const [movementPick, setMovementPick] = useState<MovementPick>(null);

  const attentionTotal = useMemo(() => {
    return (
      counts.unmatched +
      counts.drafts +
      counts.pendingOrders +
      counts.criticalStock
    );
  }, [counts]);

  const sortedItems = useMemo(() => {
    return [...items].sort((a, b) => {
      const toneOrder = { critical: 0, low: 1, ok: 2 };
      const ta = toneOrder[getStockTone(a)];
      const tb = toneOrder[getStockTone(b)];
      if (ta !== tb) return ta - tb;
      return a.name.localeCompare(b.name, "he");
    });
  }, [items]);

  const visibleItems = showAllItems ? sortedItems : sortedItems.slice(0, 4);

  async function load() {
    const token = getClientAuthToken();
    if (!token) {
      redirectToLogin();
      return;
    }

    try {
      setLoading(true);
      setError(null);

      const [itemsData, pendingMatches, draftsRes, purchasesRes, reorderRes] =
        await Promise.all([
          getInventoryItems(),
          getPendingMatches().catch(() => []),
          fetch("/api/inventory/drafts", {
            headers: buildClientAuthHeaders(),
            cache: "no-store",
          }),
          fetch("/api/inventory/supplier-purchases", {
            headers: buildClientAuthHeaders(),
            cache: "no-store",
          }),
          fetch("/api/inventory/reorder-suggestions", {
            headers: buildClientAuthHeaders(),
            cache: "no-store",
          }),
        ]);

      if (
        draftsRes.status === 401 ||
        purchasesRes.status === 401 ||
        reorderRes.status === 401
      ) {
        redirectToLogin();
        return;
      }

      const normalizedItems = Array.isArray(itemsData) ? itemsData : [];
      setItems(normalizedItems);

      let draftsCount = 0;
      if (draftsRes.ok) {
        const draftsData = await draftsRes.json();
        draftsCount = Array.isArray(draftsData?.drafts)
          ? draftsData.drafts.length
          : 0;
      }

      let pendingOrders = 0;
      if (purchasesRes.ok) {
        const purchasesData = await purchasesRes.json();
        pendingOrders = Array.isArray(purchasesData?.drafts)
          ? purchasesData.drafts.filter(
              (d: { status?: string }) => d.status === "PENDING_REVIEW"
            ).length
          : 0;
      }

      let reorderAlerts = 0;
      if (reorderRes.ok) {
        const reorderData = await reorderRes.json();
        reorderAlerts = Array.isArray(reorderData?.suggestions)
          ? reorderData.suggestions.length
          : 0;
      }

      const criticalStock = normalizedItems.filter(
        (item) => getStockTone(item) === "critical"
      ).length;

      setCounts({
        unmatched: Array.isArray(pendingMatches) ? pendingMatches.length : 0,
        drafts: draftsCount,
        pendingOrders,
        criticalStock,
        reorderAlerts,
      });
    } catch (err: unknown) {
      if (isUnauthorizedError(err)) {
        redirectToLogin();
        return;
      }

      setError(
        err instanceof Error ? err.message : "לא הצלחנו לטעון את המלאי"
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setSessionReady(true);
  }, []);

  useEffect(() => {
    if (!sessionReady) return;

    if (!getClientAuthToken()) {
      setLoading(false);
      redirectToLogin();
      return;
    }

    void load();
  }, [sessionReady]);

  function openMovementForFirstCritical() {
    const target =
      sortedItems.find((item) => getStockTone(item) !== "ok") ?? sortedItems[0];
    if (!target) {
      router.push("/inventory/items/create");
      return;
    }
    setMovementPick({
      itemId: target.id,
      itemName: target.name,
      mode: "ADD",
    });
  }

  return (
    <div style={inventoryPageStyle()}>
      <style>{inventoryResponsiveCss}</style>

      <main className="inv-main-shell" style={inventoryMainStyle()}>
        {error ? (
          <section
            style={{
              ...inventoryCardStyle(),
              borderColor: "#fecaca",
              background: "#fef2f2",
              color: "#991b1b",
            }}
          >
            {error}
            <button
              type="button"
              onClick={() => void load()}
              style={{
                marginTop: 10,
                border: "none",
                background: "#991b1b",
                color: "#fff",
                borderRadius: 10,
                padding: "8px 12px",
                fontWeight: 800,
                cursor: "pointer",
              }}
            >
              נסה שוב
            </button>
          </section>
        ) : null}

        <section style={inventoryCardStyle()}>
          <SectionHeader
            title="מה צריך את תשומת הלב שלי"
            badge={attentionTotal}
            badgeTone="danger"
          />
          <div className="inv-attention-grid" style={{ marginTop: 14 }}>
            <AttentionCard
              label="מלאי קריטי"
              count={counts.criticalStock}
              tone="danger"
              icon={<IconAlert />}
              onClick={() => setShowAllItems(true)}
            />
            <AttentionCard
              label="הזמנות לקליטה"
              count={counts.pendingOrders}
              tone="warning"
              icon={<IconBox />}
              unitLabel="הזמנות"
              onClick={() => router.push("/inventory/supplier-purchases/pending")}
            />
            <AttentionCard
              label="פריטים לבדיקה"
              count={counts.drafts}
              tone="purple"
              icon={<IconClipboard />}
              onClick={() => router.push("/inventory/drafts")}
            />
            <AttentionCard
              label="מוצרים שלא זוהו"
              count={counts.unmatched}
              tone="info"
              icon={<IconQuestion />}
              onClick={() => router.push("/inventory/unmatched")}
            />
          </div>
          {counts.reorderAlerts > 0 ? (
            <div
              style={{
                marginTop: 12,
                padding: "10px 12px",
                borderRadius: 12,
                background: "#ecfdf5",
                border: "1px solid #bbf7d0",
                fontSize: 13,
                fontWeight: 800,
                color: "#047857",
              }}
            >
              {counts.reorderAlerts} פריטים מומלצים להזמנה —{" "}
              <button
                type="button"
                onClick={() => router.push("/inventory/supplier-purchases/new")}
                style={{
                  border: "none",
                  background: "transparent",
                  color: "#047857",
                  fontWeight: 900,
                  cursor: "pointer",
                  textDecoration: "underline",
                }}
              >
                צור הזמנה
              </button>
            </div>
          ) : null}
        </section>

        <section style={inventoryCardStyle()}>
          <SectionHeader title="פעולות מהירות" />
          <div className="inv-actions-grid" style={{ marginTop: 14 }}>
            <QuickActionTile
              label="רישום מכירה"
              tone="success"
              icon={<IconSale />}
              onClick={() => router.push("/inventory/sales/create")}
            />
            <QuickActionTile
              label="הוספת פריט"
              tone="purple"
              icon={<IconPlusBox />}
              onClick={() => router.push("/inventory/items/create")}
            />
            <QuickActionTile
              label="הזמנה מספק"
              tone="warning"
              icon={<IconCart />}
              onClick={() => router.push("/inventory/supplier-purchases/new")}
            />
            <QuickActionTile
              label="קליטת סחורה"
              tone="info"
              icon={<IconTruck />}
              onClick={() => router.push("/inventory/supplier-purchases/pending")}
            />
            <QuickActionTile
              label="תנועת מלאי"
              tone="success"
              icon={<IconArrows />}
              onClick={openMovementForFirstCritical}
              outline
              className="inv-action-span-full"
            />
          </div>
        </section>

        <section style={inventoryCardStyle()}>
          <SectionHeader
            title="מבט מהיר"
            icon={
              <span
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 10,
                  background: "#ecfdf5",
                  color: inventoryTheme.accent,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <IconBox />
              </span>
            }
            action={
              sortedItems.length > 4 ? (
                <button
                  type="button"
                  onClick={() => setShowAllItems((v) => !v)}
                  style={{
                    border: "none",
                    background: "transparent",
                    color: inventoryTheme.accent,
                    fontSize: 13,
                    fontWeight: 900,
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  {showAllItems ? "הצג פחות" : "הצג עוד"} ←
                </button>
              ) : null
            }
          />

          {loading ? (
            <div
              style={{
                marginTop: 16,
                textAlign: "center",
                color: inventoryTheme.textMuted,
                padding: 24,
              }}
            >
              טוען מלאי...
            </div>
          ) : visibleItems.length === 0 ? (
            <div style={{ marginTop: 16, textAlign: "center", padding: 24 }}>
              <div style={{ fontSize: 15, fontWeight: 900, marginBottom: 8 }}>
                עדיין אין פריטים במלאי
              </div>
              <button
                type="button"
                onClick={() => router.push("/inventory/items/create")}
                style={{
                  marginTop: 8,
                  border: "none",
                  background: inventoryTheme.primaryBtn,
                  color: "#fff",
                  borderRadius: 12,
                  padding: "10px 16px",
                  fontWeight: 900,
                  cursor: "pointer",
                }}
              >
                הוספת פריט ראשון
              </button>
            </div>
          ) : (
            <div style={{ marginTop: 12 }}>
              <div
                className="inv-table-head"
                style={{
                  gridTemplateColumns: STOCK_ROW_COLUMNS,
                  gap: 10,
                  padding: "0 12px 8px",
                  fontSize: 11,
                  fontWeight: 800,
                  color: inventoryTheme.textMuted,
                }}
              >
                <span>פריט</span>
                <span className="inv-stock-bar-col">מלאי</span>
                <span>סטטוס</span>
                <span>מגמה</span>
                <span style={{ textAlign: "center" }}>כמות</span>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {visibleItems.map((item) => {
                  const tone = getStockTone(item);
                  const imageOk = isValidImageUrl(item.imageUrl);
                  const trendUp = tone === "ok";

                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => router.push(`/inventory/items/${item.id}`)}
                      style={{
                        border: `1px solid ${inventoryTheme.cardBorder}`,
                        borderRadius: 16,
                        background: inventoryTheme.cardBg,
                        padding: "10px 12px",
                        cursor: "pointer",
                        display: "grid",
                        gridTemplateColumns: STOCK_ROW_COLUMNS,
                        gap: 10,
                        alignItems: "center",
                        textAlign: "right",
                        boxShadow: "0 2px 8px rgba(15,23,42,0.03)",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                        {imageOk ? (
                          <img
                            src={item.imageUrl || ""}
                            alt=""
                            style={{
                              width: 44,
                              height: 44,
                              borderRadius: 12,
                              objectFit: "cover",
                              flexShrink: 0,
                            }}
                          />
                        ) : (
                          <div
                            style={{
                              width: 44,
                              height: 44,
                              borderRadius: 12,
                              background: "#f1f5f9",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              color: inventoryTheme.textMuted,
                              flexShrink: 0,
                            }}
                          >
                            <IconBox />
                          </div>
                        )}
                        <span
                          style={{
                            fontSize: 14,
                            fontWeight: 900,
                            color: inventoryTheme.text,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {item.name}
                        </span>
                      </div>

                      <div className="inv-stock-bar-col">
                        <StockBar ratio={getStockRatio(item)} tone={tone} />
                      </div>

                      <StatusPill label={getStockStatusLabel(tone)} tone={tone} />

                      <span
                        style={{
                          fontSize: 16,
                          fontWeight: 900,
                          color: trendUp ? inventoryTheme.successBtn : inventoryTheme.danger,
                          textAlign: "center",
                        }}
                      >
                        {trendUp ? "↑" : "↓"}
                      </span>

                      <span
                        style={{
                          fontSize: 16,
                          fontWeight: 950,
                          color: inventoryTheme.text,
                          textAlign: "center",
                        }}
                      >
                        {item.currentQuantity}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </section>
      </main>

      <InventoryBottomNav active="home" />

      <MovementModal
        open={movementPick !== null}
        itemId={movementPick?.itemId ?? null}
        itemName={movementPick?.itemName ?? ""}
        mode={movementPick?.mode ?? "ADD"}
        onClose={() => setMovementPick(null)}
        onSuccess={() => {
          setMovementPick(null);
          void load();
        }}
      />
    </div>
  );
}
