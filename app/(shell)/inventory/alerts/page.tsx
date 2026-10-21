"use client";

import { useEffect, useMemo, useState } from "react";
import { useEntryState } from "@/hooks/useEntryState";
import { useI18n } from "@/components/i18n/I18nProvider";
import { intlTag, type Locale } from "@/lib/i18n/config";
import type { MessageKey, Translator } from "@/lib/i18n/translate";
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

type TypeMeta = { titleKey: MessageKey; emoji: string; thumbBg: string; badgeKey: MessageKey; tone: BadgeTone; category: Exclude<Category, "all"> };

const TYPE_META: Record<AlertType, TypeMeta> = {
  CRITICAL_STOCK: { titleKey: "customers.inventory.alerts.types.critical.title", emoji: "⚠️", thumbBg: "var(--inv-danger-bg)", badgeKey: "customers.inventory.alerts.types.critical.badge", tone: "critical", category: "stock" },
  LOW_STOCK: { titleKey: "customers.inventory.alerts.types.low.title", emoji: "📉", thumbBg: "var(--inv-warning-bg)", badgeKey: "customers.inventory.alerts.types.low.badge", tone: "low", category: "stock" },
  SUSPICIOUS_CORRECTION: { titleKey: "customers.inventory.alerts.types.suspicious.title", emoji: "🔍", thumbBg: "var(--inv-success-bg)", badgeKey: "customers.inventory.alerts.types.suspicious.badge", tone: "purple", category: "anomaly" },
  UNMATCHED_POS_PRODUCT: { titleKey: "customers.inventory.alerts.types.unmatchedPos.title", emoji: "🧾", thumbBg: "var(--inv-info-bg)", badgeKey: "customers.inventory.alerts.types.unmatchedPos.badge", tone: "info", category: "pos" },
};

const FALLBACK_META: TypeMeta = { titleKey: "customers.inventory.alerts.types.fallback.title", emoji: "🔔", thumbBg: "var(--inv-surface)", badgeKey: "customers.inventory.alerts.types.fallback.badge", tone: "neutral", category: "stock" };

function metaForType(type: string, t: Translator) {
  const meta = TYPE_META[type as AlertType] ?? FALLBACK_META;
  return { ...meta, title: t(meta.titleKey), badge: t(meta.badgeKey) };
}

function relativeTime(value: string | undefined, t: Translator, locale: Locale): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const diffMs = Date.now() - d.getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return t("customers.inventory.alerts.time.now");
  if (mins < 60) return t("customers.inventory.alerts.time.minutesAgo", { count: mins });
  const hours = Math.round(mins / 60);
  if (hours < 24) return t("customers.inventory.alerts.time.hoursAgo", { count: hours });
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.getDate() === yesterday.getDate() && d.getMonth() === yesterday.getMonth() && d.getFullYear() === yesterday.getFullYear()) return t("customers.inventory.alerts.time.yesterday");
  return d.toLocaleDateString(intlTag(locale), { day: "numeric", month: "numeric" });
}

function detailFor(alert: Alert, t: Translator): string {
  if (alert.message && alert.message.trim()) return alert.message.trim();
  const type = alert.type;
  if ((type === "CRITICAL_STOCK" || type === "LOW_STOCK") && alert.item) {
    return t("customers.inventory.alerts.remaining", { quantity: alert.item.currentQuantity });
  }
  return "";
}

function AlertInspector({
  alert,
  busy,
  onResolve,
}: {
  alert: Alert | null;
  busy: boolean;
  onResolve: (id: number) => void;
}) {
  const { t, locale } = useI18n();
  if (!alert) {
    return (
      <aside className="inv-ops__side">
        <h2>{t("customers.inventory.alerts.alert")}</h2>
        <p>{t("customers.inventory.alerts.selectHint")}</p>
      </aside>
    );
  }
  const m = metaForType(alert.type, t);
  return (
    <aside className="inv-ops__side">
      <h2>{m.title}</h2>
      <p>{alert.item?.name || t("customers.inventory.alerts.noItem")}</p>
      <p>{detailFor(alert, t) || m.badge}</p>
      <p>{relativeTime(alert.createdAt, t, locale) || t("customers.inventory.alerts.unknownTime")}</p>
      <button type="button" className="inv-btn-primary" disabled={busy} onClick={() => onResolve(alert.id)}>
        {busy ? t("customers.inventory.alerts.closing") : t("customers.inventory.alerts.resolved")}
      </button>
    </aside>
  );
}

function ResolveButton({ onClick, busy }: { onClick: () => void; busy: boolean }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-label={t("customers.inventory.alerts.markResolved")}
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
  const { t, locale } = useI18n();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cat, setCat] = useEntryState<Category>("category", "all");
  const [busyId, setBusyId] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);

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
      setError(err instanceof Error ? err.message : t("customers.inventory.alerts.loadFailed"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-time load, unchanged by i18n (the loader now reads `t` for its messages)
  }, []);

  async function resolve(id: number) {
    if (busyId) return;
    try {
      setBusyId(id);
      await resolveInventoryAlert(id);
      setAlerts((prev) => prev.filter((a) => a.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("customers.inventory.alerts.resolveFailed"));
    } finally {
      setBusyId(null);
    }
  }

  const visible = useMemo(
    () => (cat === "all" ? alerts : alerts.filter((a) => (TYPE_META[a.type as AlertType] ?? FALLBACK_META).category === cat)),
    [alerts, cat],
  );

  return (
    <InventorySubPage intent="data"
      title={t("customers.inventory.alerts.title")}
      variant="hub"
      hubBack
      sub={!loading && !error ? t("customers.inventory.alerts.sub", { count: alerts.length }) : undefined}
      bottomNav="home"
    >
      <FilterChipRow<Category>
        value={cat}
        onChange={setCat}
        options={[
          { value: "all", label: t("customers.inventory.common.all") },
          { value: "stock", label: t("customers.inventory.alerts.filters.stock") },
          { value: "anomaly", label: t("customers.inventory.alerts.filters.anomaly") },
          { value: "pos", label: t("customers.inventory.alerts.filters.pos") },
        ]}
      />

      {error ? (
        <div className="inv-page-content" style={{ padding: "0 clamp(16px,3.5vw,28px)" }}>
          <InventoryStatePanel
            tone="error"
            title={t("customers.inventory.common.somethingWrong")}
            action={<button type="button" className="inv-btn-primary inv-btn-primary--full" onClick={() => void load()}>{t("customers.inventory.common.retry")}</button>}
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
          <InventoryStatePanel title={alerts.length === 0 ? t("customers.inventory.alerts.emptyNone") : t("customers.inventory.alerts.emptyCategory")}>
            {t("customers.inventory.alerts.emptyBody")}
          </InventoryStatePanel>
        </div>
      ) : (
        <>
        <div className="inv-ops">
        <div className="inv-desk-table" aria-label={t("customers.inventory.alerts.tableAria")}>
          <table>
            <thead>
              <tr>
                <th>{t("customers.inventory.alerts.table.alert")}</th>
                <th>{t("customers.inventory.alerts.table.item")}</th>
                <th>{t("customers.inventory.alerts.table.when")}</th>
                <th>{t("customers.inventory.alerts.table.status")}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((alert) => {
                const m = metaForType(alert.type, t);
                return (
                  <tr
                    key={alert.id}
                    className={alert.id === selectedId ? "is-selected" : undefined}
                    onClick={() => setSelectedId(alert.id)}
                  >
                    <td>{m.title}</td>
                    <td>{alert.item?.name || detailFor(alert, t) || "—"}</td>
                    <td>{relativeTime(alert.createdAt, t, locale) || "—"}</td>
                    <td>{m.badge}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <AlertInspector
          alert={visible.find((alert) => alert.id === selectedId) ?? null}
          busy={busyId === selectedId}
          onResolve={(id) => void resolve(id)}
        />
        </div>
        <div className="inv-rows inv-cards">
          {visible.map((alert) => {
            const m = metaForType(alert.type, t);
            const detail = detailFor(alert, t);
            const when = relativeTime(alert.createdAt, t, locale);
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
        </>
      )}
    </InventorySubPage>
  );
}
