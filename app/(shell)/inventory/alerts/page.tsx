"use client";

import { useEffect, useMemo, useState } from "react";
import { InventorySubPage } from "@/components/inventory/inventory-shell";
import {
  FilterChipRow,
  InventoryRow,
  InventoryBadge,
  InventoryStatePanel,
  InventorySkeletonBlock,
  type BadgeTone,
} from "@/components/inventory/inventory-design";
import {
  getInventoryAlerts,
  resolveInventoryAlert,
} from "@/lib/api/inventory";
import { isUnauthorizedError, redirectToLogin } from "@/lib/client-session";

type AlertType =
  | "CRITICAL_STOCK"
  | "LOW_STOCK"
  | "UNMATCHED_POS_PRODUCT"
  | "SUSPICIOUS_CORRECTION";

type AlertItem = {
  id: number;
  name: string;
  currentQuantity: number;
  imageUrl?: string | null;
} | null;

type Alert = {
  id: number;
  type: AlertType | string;
  message?: string | null;
  isResolved?: boolean;
  createdAt?: string;
  item?: AlertItem;
};

type Category = "all" | "stock" | "anomaly" | "pos";

const TYPE_META: Record<AlertType, { title: string; emoji: string; thumbBg: string; badge: string; tone: BadgeTone; category: Exclude<Category, "all"> }> = {
  CRITICAL_STOCK: { title: "מלאי קריטי", emoji: "⚠️", thumbBg: "var(--inv-danger-bg)", badge: "קריטי", tone: "critical", category: "stock" },
  LOW_STOCK: { title: "מלאי נמוך", emoji: "📉", thumbBg: "var(--inv-warning-bg)", badge: "נמוך", tone: "low", category: "stock" },
  SUSPICIOUS_CORRECTION: { title: "תיקון ספירה חריג", emoji: "🔍", thumbBg: "var(--inv-success-bg)", badge: "לבדיקה", tone: "purple", category: "anomaly" },
  UNMATCHED_POS_PRODUCT: { title: "מכירת POS לא מזוהה", emoji: "🧾", thumbBg: "var(--inv-info-bg)", badge: "POS", tone: "info", category: "pos" },
};

const FALLBACK_META = { title: "התראה", emoji: "🔔", thumbBg: "var(--inv-surface)", badge: "התראה", tone: "neutral" as BadgeTone, category: "stock" as const };

function metaForType(type: string) {
  return TYPE_META[type as AlertType] ?? FALLBACK_META;
}

function relativeTime(value?: string): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const diffMs = Date.now() - d.getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "כעת";
  if (mins < 60) return `לפני ${mins} דק׳`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `לפני ${hours} שע׳`;
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.getDate() === yesterday.getDate() && d.getMonth() === yesterday.getMonth() && d.getFullYear() === yesterday.getFullYear()) return "אתמול";
  return d.toLocaleDateString("he-IL", { day: "numeric", month: "numeric" });
}

function detailFor(alert: Alert): string {
  if (alert.message && alert.message.trim()) return alert.message.trim();
  const type = alert.type;
  if ((type === "CRITICAL_STOCK" || type === "LOW_STOCK") && alert.item) {
    return `נשארו ${alert.item.currentQuantity}`;
  }
  return "";
}

function ResolveButton({ onClick, busy }: { onClick: () => void; busy: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-label="סמן כטופל"
      style={{
        width: 34, height: 34, borderRadius: "50%", border: 0, flexShrink: 0,
        background: "var(--inv-success-bg)", color: "var(--inv-success)", cursor: busy ? "default" : "pointer",
        display: "inline-flex", alignItems: "center", justifyContent: "center", opacity: busy ? 0.5 : 1,
      }}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

export default function InventoryAlertsPage() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cat, setCat] = useState<Category>("all");
  const [busyId, setBusyId] = useState<number | null>(null);

  async function load() {
    try {
      setLoading(true);
      setError(null);
      const data = await getInventoryAlerts({ isResolved: false });
      setAlerts(Array.isArray(data) ? data : []);
    } catch (err) {
      if (isUnauthorizedError(err)) {
        redirectToLogin();
        return;
      }
      setError(err instanceof Error ? err.message : "לא הצלחנו לטעון את ההתראות");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function resolve(id: number) {
    if (busyId) return;
    try {
      setBusyId(id);
      await resolveInventoryAlert(id);
      setAlerts((prev) => prev.filter((a) => a.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "שגיאה בסימון ההתראה");
    } finally {
      setBusyId(null);
    }
  }

  const visible = useMemo(
    () => (cat === "all" ? alerts : alerts.filter((a) => metaForType(a.type).category === cat)),
    [alerts, cat],
  );

  return (
    <InventorySubPage
      title="התראות"
      variant="hub"
      sub={!loading && !error ? `${alerts.length} פתוחות · נוצרות אוטומטית מתנועות המלאי` : undefined}
      bottomNav="home"
    >
      <FilterChipRow<Category>
        value={cat}
        onChange={setCat}
        options={[
          { value: "all", label: "הכל" },
          { value: "stock", label: "מלאי" },
          { value: "anomaly", label: "חריגות" },
          { value: "pos", label: "POS" },
        ]}
      />

      {error ? (
        <div className="inv-page-content" style={{ padding: "0 clamp(16px,3.5vw,28px)" }}>
          <InventoryStatePanel
            tone="error"
            title="משהו השתבש"
            action={<button type="button" className="inv-btn-primary inv-btn-primary--full" onClick={() => void load()}>נסה שוב</button>}
          >
            {error}
          </InventoryStatePanel>
        </div>
      ) : loading ? (
        <div className="inv-rows">
          <InventorySkeletonBlock height={72} rows={4} />
        </div>
      ) : visible.length === 0 ? (
        <div className="inv-page-content" style={{ padding: "0 clamp(16px,3.5vw,28px)" }}>
          <InventoryStatePanel title={alerts.length === 0 ? "אין התראות פתוחות" : "אין התראות בקטגוריה זו"}>
            התראות נוצרות אוטומטית כשמלאי יורד מתחת לסף, כשמתבצע תיקון חריג, או כשמכירת קופה לא מזוהה.
          </InventoryStatePanel>
        </div>
      ) : (
        <div className="inv-rows">
          {visible.map((alert) => {
            const m = metaForType(alert.type);
            const detail = detailFor(alert);
            const when = relativeTime(alert.createdAt);
            const metaParts = [alert.item?.name, detail].filter(Boolean).join(" — ");
            return (
              <InventoryRow
                key={alert.id}
                thumb={<span style={{ fontSize: 20 }}>{m.emoji}</span>}
                thumbBg={m.thumbBg}
                title={m.title}
                meta={
                  <>
                    {metaParts ? <bdi>{metaParts}</bdi> : null}
                    {metaParts && when ? " · " : null}
                    {when ? <bdi>{when}</bdi> : null}
                  </>
                }
                trail={
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <InventoryBadge tone={m.tone}>{m.badge}</InventoryBadge>
                    <ResolveButton busy={busyId === alert.id} onClick={() => void resolve(alert.id)} />
                  </span>
                }
              />
            );
          })}
        </div>
      )}
    </InventorySubPage>
  );
}
