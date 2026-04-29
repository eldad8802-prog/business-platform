"use client";

import { useEffect, useMemo, useState } from "react";
import PageHeader from "@/components/ui/page-header";
import {
  getInventoryItems,
  getPendingMatches,
  resolvePendingMatch,
  type InventoryItemDTO,
  type InventoryPendingMatchDTO,
} from "@/lib/api/inventory";

type ResolveMode = "LINK_EXISTING" | "CREATE_NEW";

function findBestMatch(
  pending: InventoryPendingMatchDTO,
  items: InventoryItemDTO[]
) {
  const meta = pending.metadata;

  let best: InventoryItemDTO | null = null;
  let score = 0;

  for (const item of items) {
    let currentScore = 0;

    if (meta.barcode && item.barcode === meta.barcode) {
      currentScore += 100;
    }

    if (meta.sku && (item as any).sku === meta.sku) {
      currentScore += 80;
    }

    if (meta.name && item.name) {
      const name = meta.name.toLowerCase();
      const itemName = item.name.toLowerCase();

      if (itemName.includes(name) || name.includes(itemName)) {
        currentScore += 50;
      }
    }

    if (currentScore > score) {
      score = currentScore;
      best = item;
    }
  }

  if (score < 50) return null;

  return best;
}

export default function InventoryUnmatchedPage() {
  const [pendingMatches, setPendingMatches] = useState<InventoryPendingMatchDTO[]>([]);
  const [items, setItems] = useState<InventoryItemDTO[]>([]);
  const [selectedItemByPendingId, setSelectedItemByPendingId] = useState<Record<number, number | "">>({});
  const [modeByPendingId, setModeByPendingId] = useState<Record<number, ResolveMode>>({});
  const [loading, setLoading] = useState(true);
  const [resolvingId, setResolvingId] = useState<number | null>(null);
  const [confirmRejectId, setConfirmRejectId] = useState<number | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadData() {
    try {
      setLoading(true);
      setError(null);

      const [pendingData, itemsData] = await Promise.all([
        getPendingMatches(),
        getInventoryItems(),
      ]);

      setPendingMatches(Array.isArray(pendingData) ? pendingData : []);
      setItems(Array.isArray(itemsData) ? itemsData : []);
    } catch (err: any) {
      setError(
        err?.message === "UNAUTHORIZED"
          ? "אין הרשאה לצפות במוצרים שלא זוהו. צריך להתחבר מחדש."
          : err?.message || "שגיאה בטעינת המוצרים שלא זוהו"
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  const activeItems = useMemo(() => {
    return items.filter((item) => item.id && item.name);
  }, [items]);

  function getMode(pendingId: number): ResolveMode {
    return modeByPendingId[pendingId] || "LINK_EXISTING";
  }

  async function handleResolve(pending: InventoryPendingMatchDTO) {
    if (resolvingId) return;

    const mode = getMode(pending.id);

    try {
      setResolvingId(pending.id);
      setError(null);
      setSuccessMessage(null);

      if (mode === "LINK_EXISTING") {
        const itemId = selectedItemByPendingId[pending.id];

        if (!itemId) {
          throw new Error("צריך לבחור מוצר קיים לפני שיוך.");
        }

        await resolvePendingMatch(pending.id, {
          action: "LINK_EXISTING",
          itemId: Number(itemId),
        });

        setSuccessMessage("האירוע שויך למוצר קיים והמלאי עודכן.");
      }

      if (mode === "CREATE_NEW") {
        await resolvePendingMatch(pending.id, {
          action: "CREATE_NEW",
          itemData: {
            name:
              pending.metadata.name ||
              pending.metadata.sku ||
              pending.metadata.barcode ||
              "מוצר חדש מהקופה",
            unitType: "UNIT",
            minimumQuantity: 0,
            reorderPoint: null,
            costPerUnit: 0,
            sellPricePerUnit: 0,
            sku: pending.metadata.sku,
            barcode: pending.metadata.barcode,
          },
        });

        setSuccessMessage("נוצר מוצר חדש, האירוע טופל והמלאי עודכן.");
      }

      await loadData();
    } catch (err: any) {
      setError(err?.message || "שגיאה בטיפול במוצר שלא זוהה");
    } finally {
      setResolvingId(null);
    }
  }

  async function handleReject(pending: InventoryPendingMatchDTO) {
    if (resolvingId) return;

    if (confirmRejectId !== pending.id) {
      setConfirmRejectId(pending.id);
      setError(null);
      setSuccessMessage(null);
      return;
    }

    try {
      setResolvingId(pending.id);
      setError(null);
      setSuccessMessage(null);

      await resolvePendingMatch(pending.id, { action: "REJECT" });

      setConfirmRejectId(null);
      setSuccessMessage("האירוע נסגר ללא שינוי במלאי.");
      await loadData();
    } catch (err: any) {
      setError(err?.message || "שגיאה בסגירת האירוע");
    } finally {
      setResolvingId(null);
    }
  }

  return (
    <div dir="rtl" style={{ minHeight: "100vh", background: "#f8fafc" }}>
      <PageHeader title="מוצרים שלא זוהו" />

      <main style={styles.main}>
        <section style={styles.heroCard}>
          <div style={styles.heroTop}>
            <div>
              <h1 style={styles.title}>טיפול במוצרים שלא זוהו מהקופה</h1>
              <p style={styles.description}>
                כאן מופיעות מכירות שהגיעו מהקופה אך לא נמצאה להן התאמה מלאה
                במלאי. אפשר לשייך למוצר קיים, ליצור מוצר חדש, או להתעלם מאירוע
                שלא צריך להשפיע על המלאי.
              </p>
            </div>

            <div style={styles.counterBox}>
              <div style={styles.counterNumber}>{pendingMatches.length}</div>
              <div style={styles.counterLabel}>ממתינים לטיפול</div>
            </div>
          </div>
        </section>

        {successMessage && <SuccessCard text={successMessage} />}

        {loading ? (
          <StateCard text="טוען מוצרים שלא זוהו..." />
        ) : error ? (
          <ErrorCard text={error} onRetry={loadData} />
        ) : pendingMatches.length === 0 ? (
          <EmptyCard />
        ) : (
          <section style={styles.list}>
            {pendingMatches.map((pending) => {
              const isResolving = resolvingId === pending.id;
              const mode = getMode(pending.id);
              const metadata = pending.metadata;
              const unmatchedItems = metadata.unmatchedItems || [];
              const allItems = metadata.allItems || [];
              const isRejectConfirming = confirmRejectId === pending.id;
              const suggestedItem = findBestMatch(pending, activeItems);

              return (
                <article key={pending.id} style={styles.card}>
                  <div style={styles.cardHeader}>
                    <div>
                      <div style={styles.badge}>
                        <span>⚠️</span>
                        <span>מכירה ממתינה להתאמה</span>
                      </div>

                      <h2 style={styles.itemTitle}>
                        {metadata.name ||
                          metadata.sku ||
                          metadata.barcode ||
                          "מוצר לא מזוהה"}
                      </h2>
                    </div>

                    <div style={styles.saleId}>#{pending.externalSaleId}</div>
                  </div>

                  <div style={styles.infoGrid}>
                    <InfoBox label="SKU" value={metadata.sku || "-"} />
                    <InfoBox label="ברקוד" value={metadata.barcode || "-"} />
                    <InfoBox label="כמות שלא זוהתה" value={String(metadata.quantity)} />
                    <InfoBox label="מקור" value={metadata.source || "POS"} />
                  </div>

                  {unmatchedItems.length > 0 && (
                    <ItemsPanel title="פריטים שלא זוהו באירוע" items={unmatchedItems} />
                  )}

                  {allItems.length > unmatchedItems.length && (
                    <ItemsPanel title="כל פריטי המכירה מהקופה" items={allItems} muted />
                  )}

                  {pending.createdAt && (
                    <div style={styles.dateText}>
                      נוצר בתאריך{" "}
                      {new Date(pending.createdAt).toLocaleString("he-IL")}
                    </div>
                  )}

                  <section style={styles.actionPanel}>
                    <div style={styles.actionIntro}>
                      <strong>איך לטפל באירוע?</strong>
                      <span>
                        פעולה של שיוך או יצירה תיצור תנועת SALE ותעדכן את המלאי.
                        התעלמות תסגור את האירוע בלי לשנות מלאי.
                      </span>
                    </div>

                    <div style={styles.modeRow}>
                      <button
                        type="button"
                        onClick={() =>
                          setModeByPendingId((prev) => ({
                            ...prev,
                            [pending.id]: "LINK_EXISTING",
                          }))
                        }
                        disabled={isResolving}
                        style={modeButtonStyle(mode === "LINK_EXISTING")}
                      >
                        שייך למוצר קיים
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          setModeByPendingId((prev) => ({
                            ...prev,
                            [pending.id]: "CREATE_NEW",
                          }))
                        }
                        disabled={isResolving}
                        style={modeButtonStyle(mode === "CREATE_NEW")}
                      >
                        צור מוצר חדש
                      </button>
                    </div>

                    {mode === "LINK_EXISTING" ? (
                      <>
                        {suggestedItem && (
                          <div style={styles.suggestionBox}>
                            <div style={styles.suggestionText}>
                              <span style={styles.suggestionLabel}>הצעה מהמערכת</span>
                              <span>
                                אולי מדובר ב־<strong>{suggestedItem.name}</strong>
                              </span>
                            </div>

                            <button
                              type="button"
                              disabled={isResolving}
                              onClick={() =>
                                setSelectedItemByPendingId((prev) => ({
                                  ...prev,
                                  [pending.id]: suggestedItem.id,
                                }))
                              }
                              style={styles.suggestionButton}
                            >
                              בחר הצעה
                            </button>
                          </div>
                        )}

                        <select
                          value={selectedItemByPendingId[pending.id] || ""}
                          onChange={(event) =>
                            setSelectedItemByPendingId((prev) => ({
                              ...prev,
                              [pending.id]: Number(event.target.value),
                            }))
                          }
                          disabled={isResolving}
                          style={styles.select}
                        >
                          <option value="">בחירת מוצר מהמלאי</option>
                          {activeItems.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.name} — כמות נוכחית: {item.currentQuantity}
                            </option>
                          ))}
                        </select>
                      </>
                    ) : (
                      <div style={styles.createPreview}>
                        ייווצר מוצר חדש בשם{" "}
                        <strong>
                          {metadata.name ||
                            metadata.sku ||
                            metadata.barcode ||
                            "מוצר חדש מהקופה"}
                        </strong>
                        , עם SKU וברקוד מתוך נתוני הקופה אם קיימים.
                      </div>
                    )}

                    {isRejectConfirming && (
                      <div style={styles.rejectWarning}>
                        לחיצה נוספת על “אשר התעלמות” תסגור את האירוע ללא שינוי
                        במלאי וללא יצירת מכירה חיצונית.
                      </div>
                    )}

                    <div style={styles.buttonRow}>
                      <button
                        type="button"
                        onClick={() => handleResolve(pending)}
                        disabled={Boolean(resolvingId)}
                        style={styles.primaryButton(resolvingId)}
                      >
                        {isResolving
                          ? "מטפל באירוע..."
                          : mode === "LINK_EXISTING"
                          ? "שייך וצור תנועת מכירה"
                          : "צור מוצר וצור תנועת מכירה"}
                      </button>

                      <button
                        type="button"
                        onClick={() => handleReject(pending)}
                        disabled={Boolean(resolvingId)}
                        style={styles.secondaryButton(resolvingId, isRejectConfirming)}
                      >
                        {isResolving
                          ? "סוגר..."
                          : isRejectConfirming
                          ? "אשר התעלמות"
                          : "התעלם מהאירוע"}
                      </button>
                    </div>
                  </section>
                </article>
              );
            })}
          </section>
        )}
      </main>
    </div>
  );
}

function InfoBox({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.infoBox}>
      <div style={styles.infoLabel}>{label}</div>
      <div style={styles.infoValue}>{value}</div>
    </div>
  );
}

function ItemsPanel({
  title,
  items,
  muted,
}: {
  title: string;
  items: Array<{
    sku: string | null;
    barcode: string | null;
    name: string | null;
    quantity: number;
  }>;
  muted?: boolean;
}) {
  return (
    <div style={muted ? styles.itemsPanelMuted : styles.itemsPanel}>
      <div style={styles.itemsPanelTitle}>{title}</div>

      {items.map((item, index) => (
        <div key={index} style={styles.itemRow}>
          <span>שם: {item.name || "-"}</span>
          <span>SKU: {item.sku || "-"}</span>
          <span>ברקוד: {item.barcode || "-"}</span>
          <span>כמות: {item.quantity}</span>
        </div>
      ))}
    </div>
  );
}

function SuccessCard({ text }: { text: string }) {
  return <section style={styles.successCard}>{text}</section>;
}

function ErrorCard({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <section style={styles.errorCard}>
      <div style={{ fontWeight: 800, marginBottom: "8px" }}>משהו השתבש</div>
      <div style={{ fontSize: "14px", marginBottom: "14px" }}>{text}</div>
      <button type="button" onClick={onRetry} style={styles.errorButton}>
        נסה שוב
      </button>
    </section>
  );
}

function EmptyCard() {
  return (
    <section style={styles.emptyCard}>
      <div style={{ fontSize: "30px", marginBottom: "8px" }}>✅</div>
      <div style={{ fontWeight: 800, color: "#111827", marginBottom: "6px" }}>
        אין מוצרים שממתינים להתאמה
      </div>
      <div style={{ fontSize: "14px", lineHeight: 1.6 }}>
        כל המכירות שנקלטו מהקופה נמצאו או טופלו.
      </div>
    </section>
  );
}

function StateCard({ text }: { text: string }) {
  return <section style={styles.stateCard}>{text}</section>;
}

function modeButtonStyle(active: boolean): React.CSSProperties {
  return {
    minHeight: "40px",
    padding: "9px 13px",
    borderRadius: "12px",
    border: active ? "1px solid #111827" : "1px solid #d1d5db",
    background: active ? "#111827" : "#ffffff",
    color: active ? "#ffffff" : "#111827",
    cursor: "pointer",
    fontWeight: 800,
  };
}

const styles: Record<string, any> = {
  main: {
    maxWidth: "980px",
    margin: "0 auto",
    padding: "16px",
    display: "flex",
    flexDirection: "column",
    gap: "16px",
  },
  heroCard: {
    border: "1px solid #e5e7eb",
    borderRadius: "22px",
    background: "#ffffff",
    padding: "18px",
    boxShadow: "0 4px 14px rgba(15, 23, 42, 0.04)",
  },
  heroTop: {
    display: "flex",
    justifyContent: "space-between",
    gap: "16px",
    alignItems: "center",
    flexWrap: "wrap",
  },
  title: {
    margin: 0,
    marginBottom: "6px",
    fontSize: "20px",
    fontWeight: 800,
    color: "#111827",
  },
  description: {
    margin: 0,
    fontSize: "14px",
    lineHeight: 1.6,
    color: "#6b7280",
    maxWidth: "680px",
  },
  counterBox: {
    minWidth: "128px",
    border: "1px solid #e5e7eb",
    borderRadius: "16px",
    padding: "12px",
    textAlign: "center",
    background: "#f9fafb",
  },
  counterNumber: {
    fontSize: "24px",
    fontWeight: 900,
    color: "#111827",
  },
  counterLabel: {
    fontSize: "12px",
    color: "#6b7280",
    fontWeight: 700,
  },
  successCard: {
    border: "1px solid #bbf7d0",
    borderRadius: "16px",
    background: "#f0fdf4",
    padding: "14px",
    color: "#166534",
    fontSize: "14px",
    fontWeight: 800,
  },
  errorCard: {
    border: "1px solid #fecaca",
    borderRadius: "18px",
    background: "#fef2f2",
    padding: "22px",
    textAlign: "center",
    color: "#991b1b",
  },
  errorButton: {
    minHeight: "42px",
    padding: "10px 16px",
    borderRadius: "12px",
    border: "none",
    background: "#991b1b",
    color: "#ffffff",
    cursor: "pointer",
    fontWeight: 700,
  },
  emptyCard: {
    border: "1px solid #e5e7eb",
    borderRadius: "18px",
    background: "#ffffff",
    padding: "28px",
    textAlign: "center",
    color: "#6b7280",
  },
  stateCard: {
    border: "1px solid #e5e7eb",
    borderRadius: "18px",
    background: "#ffffff",
    padding: "28px",
    textAlign: "center",
    color: "#6b7280",
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  },
  card: {
    border: "1px solid #fde68a",
    borderRadius: "20px",
    background: "#ffffff",
    padding: "16px",
    boxShadow: "0 4px 14px rgba(15, 23, 42, 0.04)",
    display: "flex",
    flexDirection: "column",
    gap: "14px",
  },
  cardHeader: {
    display: "flex",
    justifyContent: "space-between",
    gap: "12px",
    flexWrap: "wrap",
  },
  badge: {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    padding: "6px 10px",
    borderRadius: "999px",
    background: "#fffbeb",
    color: "#92400e",
    border: "1px solid #fde68a",
    fontSize: "12px",
    fontWeight: 800,
    marginBottom: "10px",
  },
  itemTitle: {
    margin: 0,
    fontSize: "17px",
    fontWeight: 900,
    color: "#111827",
  },
  saleId: {
    fontSize: "12px",
    color: "#6b7280",
    background: "#f9fafb",
    border: "1px solid #e5e7eb",
    borderRadius: "999px",
    padding: "6px 10px",
    height: "fit-content",
  },
  infoGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
    gap: "8px",
  },
  infoBox: {
    border: "1px solid #e5e7eb",
    borderRadius: "12px",
    background: "#f9fafb",
    padding: "10px",
  },
  infoLabel: {
    fontSize: "11px",
    color: "#6b7280",
    marginBottom: "4px",
  },
  infoValue: {
    fontSize: "13px",
    color: "#111827",
    fontWeight: 800,
    wordBreak: "break-word",
  },
  itemsPanel: {
    border: "1px solid #f3f4f6",
    borderRadius: "14px",
    overflow: "hidden",
  },
  itemsPanelMuted: {
    border: "1px solid #e5e7eb",
    borderRadius: "14px",
    overflow: "hidden",
    opacity: 0.85,
  },
  itemsPanelTitle: {
    padding: "10px 12px",
    background: "#f9fafb",
    fontSize: "13px",
    fontWeight: 800,
    color: "#374151",
  },
  itemRow: {
    padding: "10px 12px",
    borderTop: "1px solid #f3f4f6",
    fontSize: "13px",
    color: "#374151",
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
    gap: "6px",
  },
  dateText: {
    fontSize: "12px",
    color: "#6b7280",
  },
  actionPanel: {
    borderTop: "1px solid #f3f4f6",
    paddingTop: "14px",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
  },
  actionIntro: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    fontSize: "13px",
    color: "#4b5563",
    lineHeight: 1.5,
  },
  modeRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: "8px",
  },
  suggestionBox: {
    border: "1px solid #dbeafe",
    borderRadius: "14px",
    background: "#eff6ff",
    padding: "12px",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "10px",
    flexWrap: "wrap",
  },
  suggestionText: {
    display: "flex",
    flexDirection: "column",
    gap: "3px",
    fontSize: "13px",
    color: "#1e40af",
    lineHeight: 1.5,
  },
  suggestionLabel: {
    fontSize: "11px",
    fontWeight: 900,
    color: "#1d4ed8",
  },
  suggestionButton: {
    minHeight: "36px",
    padding: "7px 12px",
    borderRadius: "10px",
    border: "none",
    background: "#1d4ed8",
    color: "#ffffff",
    cursor: "pointer",
    fontWeight: 800,
  },
  select: {
    minHeight: "44px",
    borderRadius: "12px",
    border: "1px solid #d1d5db",
    padding: "0 12px",
    background: "#ffffff",
    color: "#111827",
    fontWeight: 700,
  },
  createPreview: {
    border: "1px solid #dbeafe",
    borderRadius: "14px",
    background: "#eff6ff",
    padding: "12px",
    fontSize: "13px",
    lineHeight: 1.6,
    color: "#1e40af",
  },
  rejectWarning: {
    border: "1px solid #fed7aa",
    borderRadius: "14px",
    background: "#fff7ed",
    padding: "12px",
    fontSize: "13px",
    lineHeight: 1.6,
    color: "#9a3412",
    fontWeight: 700,
  },
  buttonRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: "8px",
  },
  primaryButton: (disabled: boolean) => ({
    flex: "1 1 220px",
    minHeight: "44px",
    padding: "10px 14px",
    borderRadius: "12px",
    border: "none",
    background: "#111827",
    color: "#ffffff",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.65 : 1,
    fontWeight: 900,
  }),
  secondaryButton: (disabled: boolean, confirming: boolean) => ({
    flex: "1 1 160px",
    minHeight: "44px",
    padding: "10px 14px",
    borderRadius: "12px",
    border: confirming ? "1px solid #fb923c" : "1px solid #e5e7eb",
    background: confirming ? "#fff7ed" : "#f9fafb",
    color: confirming ? "#9a3412" : "#374151",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.65 : 1,
    fontWeight: 800,
  }),
};