"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useEntryState } from "@/hooks/useEntryState";
import { inventoryToast } from "@/components/inventory/inventory-toast";
import { getInventoryAlerts, getInventoryItems, resolveInventoryAlert, type InventoryItemDTO } from "@/lib/api/inventory";
import { getClientAuthToken, isUnauthorizedError, redirectToLogin } from "@/lib/client-session";
import { stockLine, TONE_WORD } from "@/lib/inventory/stock-line";
import {
  loadPendingOrderDrafts,
  loadPendingProductDrafts,
  loadPendingSales,
  type PendingOrderDraft,
  type PendingProductDraft,
  type PendingSale,
} from "@/lib/inventory/overview-sources";
import { I2, InvButton, InvError, InvLoading, InvMenu, InvNote, InvPage, InvPill, InvRow, InvState, InvTabs, ProductThumb, formatQty } from "@/components/inventory/v2/kit";

type AlertItem = {
  id: number;
  name: string;
  currentQuantity: number;
  imageUrl?: string | null;
} | null;

type Alert = {
  id: number;
  type: string;
  message?: string | null;
  isResolved?: boolean;
  createdAt?: string;
  item?: AlertItem;
};

type Tab = "all" | "stock" | "drafts" | "sales";
const TABS: Tab[] = ["all", "stock", "drafts", "sales"];
const PAGE = 50;

type Entry = { key: string; tab: Exclude<Tab, "all"> | "other"; node: ReactNode };

/**
 * "דורש טיפול" — redesign, owner-approved mockup. One list of what needs a
 * decision: open stock alerts (GET /api/inventory/alerts?isResolved=false,
 * CRITICAL_STOCK / LOW_STOCK, joined to the products for image and quantity),
 * product drafts awaiting review, POS sales awaiting a product, and — under
 * "הכול" — supplier orders awaiting receipt. A stock alert is marked handled
 * with resolveInventoryAlert (PATCH /inventory/alerts/:id/resolve, #926).
 */
export default function InventoryAlertsPage() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [items, setItems] = useState<InventoryItemDTO[]>([]);
  const [drafts, setDrafts] = useState<PendingProductDraft[]>([]);
  const [sales, setSales] = useState<PendingSale[]>([]);
  const [orders, setOrders] = useState<PendingOrderDraft[]>([]);
  const [partial, setPartial] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [storedTab, setTab] = useEntryState<string>("category", "all");
  const tab: Tab = (TABS as string[]).includes(storedTab) ? (storedTab as Tab) : "all";
  const [limit, setLimit] = useState(PAGE);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    setPartial(false);
    const side = Promise.allSettled([loadPendingProductDrafts(), loadPendingSales(), loadPendingOrderDrafts()]);
    try {
      const [alertData, itemData] = await Promise.all([getInventoryAlerts({ isResolved: false }), getInventoryItems().catch(() => null)]);
      setAlerts(Array.isArray(alertData) ? alertData : []);
      setItems(Array.isArray(itemData) ? itemData : []);
      if (itemData == null) setPartial(true);
    } catch (err) {
      if (isUnauthorizedError(err)) {
        redirectToLogin();
        return;
      }
      setError(true);
    }
    const [d, s, o] = await side;
    setDrafts(d.status === "fulfilled" ? d.value : []);
    setSales(s.status === "fulfilled" ? s.value : []);
    setOrders(o.status === "fulfilled" ? o.value : []);
    if (d.status === "rejected" || s.status === "rejected" || o.status === "rejected") setPartial(true);
    setLoading(false);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!getClientAuthToken()) redirectToLogin();
      else void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function resolve(alert: Alert, label: string) {
    if (busyId) return;
    try {
      setBusyId(alert.id);
      setActionError(null);
      await resolveInventoryAlert(alert.id);
      inventoryToast.success(`${label} · סומן כטופל`);
      await load();
    } catch (err) {
      if (isUnauthorizedError(err)) return redirectToLogin();
      setActionError("לא הצלחנו לסמן כטופל. נסו שוב.");
    } finally {
      setBusyId(null);
    }
  }

  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  const entries: Entry[] = (() => {
    const out: Entry[] = [];
    for (const a of alerts) {
      if (a.type !== "CRITICAL_STOCK" && a.type !== "LOW_STOCK") continue;
      const item = a.item ? itemById.get(a.item.id) : undefined;
      const name = item?.name ?? a.item?.name ?? "מוצר";
      const line = item ? stockLine(item) : null;
      const critical = line ? line.tone === "critical" : a.type === "CRITICAL_STOCK";
      const subText = line?.text ?? (a.item ? `${formatQty(a.item.currentQuantity)} במלאי` : a.message || TONE_WORD[critical ? "critical" : "low"]);
      const itemId = item?.id ?? a.item?.id;
      out.push({
        key: `a${a.id}`,
        tab: "stock",
        node: (
          <InvRow
            key={`a${a.id}`}
            thumb={<ProductThumb src={item?.imageUrl ?? a.item?.imageUrl} name={name} />}
            kicker="מלאי"
            title={name}
            dot={critical ? "danger" : "warn"}
            sub={
              <>
                <span className={critical ? "i2-row__sub--danger" : undefined}>
                  {TONE_WORD[critical ? "critical" : "low"]} · {subText}
                </span>
                {itemId ? (
                  <>
                    <br />
                    <Link className="i2-link" href={`/inventory/items/${itemId}`} style={{ minHeight: 36, padding: 0 }}>
                      למוצר {I2.chevronEnd(14)}
                    </Link>
                  </>
                ) : null}
              </>
            }
            trail={
              <>
                {itemId ? (
                  <InvPill href={`/inventory/supplier-purchases/new?item=${itemId}`} ariaLabel={`הזמנה מספק · ${name}`}>
                    הזמן
                  </InvPill>
                ) : null}
                <InvMenu label={`פעולות · ${name}`} items={[{ label: busyId === a.id ? "מסמן…" : "סימון כטופל", onClick: () => void resolve(a, name) }]} />
              </>
            }
          />
        ),
      });
    }
    for (const d of drafts) {
      const href = `/inventory/drafts?id=${d.id}`;
      out.push({
        key: `d${d.id}`,
        tab: "drafts",
        node: (
          <InvRow
            key={`d${d.id}`}
            href={href}
            thumb={<ProductThumb src={d.imageUrl} name={d.name} />}
            kicker="טיוטת מוצר"
            title={d.name}
            sub="טיוטה לבדיקה ואישור"
            trail={<InvPill href={href} ariaLabel={`בדיקת הטיוטה ${d.name}`}>בדיקה</InvPill>}
          />
        ),
      });
    }
    for (const s of sales) {
      const href = `/inventory/unmatched?match=${s.id}`;
      out.push({
        key: `s${s.id}`,
        tab: "sales",
        node: (
          <InvRow
            key={`s${s.id}`}
            href={href}
            thumb={<ProductThumb name={s.name} />}
            kicker="שיוך מכירה"
            title={s.name}
            sub={`פריט במכירה ללא מוצר${s.quantity != null ? ` · כמות ${formatQty(s.quantity)}` : ""}`}
            trail={<InvPill href={href} ariaLabel={`שיוך ${s.name} למוצר`}>שייך מוצר</InvPill>}
          />
        ),
      });
    }
    for (const o of orders) {
      const href = `/inventory/supplier-purchases/${o.id}/send`;
      const title = o.supplierName ? `הזמנה מ${o.supplierName}` : "הזמנה ללא ספק";
      out.push({
        key: `o${o.id}`,
        tab: "other",
        node: (
          <InvRow
            key={`o${o.id}`}
            href={href}
            thumb={<ProductThumb name="ה" />}
            kicker="הזמנה מספק"
            title={title}
            sub={`הזמנה ממתינה לקליטה · ${o.lineCount.toLocaleString("he-IL")} ${o.lineCount === 1 ? "מוצר" : "מוצרים"}`}
            trail={<InvPill href={href} ariaLabel={`קליטת ${title}`}>לקליטה</InvPill>}
          />
        ),
      });
    }
    // Other open alert types (e.g. a suspicious correction) — shown under "הכול",
    // can be marked handled. Unmatched-POS alerts are represented by the sales rows.
    for (const a of alerts) {
      if (a.type === "CRITICAL_STOCK" || a.type === "LOW_STOCK" || a.type === "UNMATCHED_POS_PRODUCT") continue;
      const title = a.type === "SUSPICIOUS_CORRECTION" ? "תיקון מלאי חריג" : "התראת מלאי";
      const name = a.item?.name;
      out.push({
        key: `x${a.id}`,
        tab: "other",
        node: (
          <InvRow
            key={`x${a.id}`}
            thumb={<ProductThumb src={a.item?.imageUrl} name={name || title} />}
            kicker="לבדיקה"
            title={name ? `${title} · ${name}` : title}
            sub={a.message || "כדאי לבדוק את התנועה האחרונה של המוצר"}
            trail={<InvMenu label={`פעולות · ${title}`} items={[{ label: "סימון כטופל", onClick: () => void resolve(a, title) }]} />}
          />
        ),
      });
    }
    return out;
  })();

  const visible = tab === "all" ? entries : entries.filter((e) => e.tab === tab);
  const count = (t: Exclude<Tab, "all">) => entries.filter((e) => e.tab === t).length;

  return (
    <InvPage
      title="דורש טיפול"
      backFallback="/inventory"
      wide
      end={<InvMenu label="פעולות" items={[{ label: "רענון", onClick: () => void load() }]} />}
    >
      <InvTabs<Tab>
        label="סוג הטיפול"
        value={tab}
        onChange={(v) => {
          setTab(v);
          setLimit(PAGE);
        }}
        options={[
          { value: "all", label: "הכול" },
          { value: "stock", label: `מלאי${!loading && count("stock") ? ` (${count("stock")})` : ""}` },
          { value: "drafts", label: `טיוטות${!loading && count("drafts") ? ` (${count("drafts")})` : ""}` },
          { value: "sales", label: `שיוכים${!loading && count("sales") ? ` (${count("sales")})` : ""}` },
        ]}
      />
      {loading ? (
        <InvLoading rows={5} />
      ) : error ? (
        <InvError onRetry={() => void load()} />
      ) : (
        <>
          {actionError ? <InvNote tone="danger">{actionError}</InvNote> : null}
          {partial ? (
            <InvNote tone="warn">
              חלק מהרשימה לא נטען, ולכן ייתכן שחסרים פריטים.{" "}
              <button type="button" className="i2-underline" onClick={() => void load()}>
                טעינה מחדש
              </button>
            </InvNote>
          ) : null}
          {visible.length === 0 ? (
            <InvState
              title="אין כרגע מה לטפל בו בקטגוריה הזו"
              action={
                <InvButton kind="secondary" href="/inventory">
                  חזרה למלאי
                </InvButton>
              }
            />
          ) : (
            <>
              <ul className="i2-list">{visible.slice(0, limit).map((e) => e.node)}</ul>
              {visible.length > limit ? (
                <div style={{ textAlign: "center", marginTop: 8 }}>
                  <InvButton kind="soft" small onClick={() => setLimit((n) => n + PAGE)}>
                    הצגת עוד
                  </InvButton>
                </div>
              ) : null}
            </>
          )}
        </>
      )}
    </InvPage>
  );
}
