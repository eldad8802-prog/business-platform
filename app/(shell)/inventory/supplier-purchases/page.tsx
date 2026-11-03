"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { buildClientAuthHeaders, redirectToLogin } from "@/lib/client-session";
import {
  InvButton,
  InvChips,
  InvError,
  InvLoading,
  InvMenu,
  InvPage,
  InvPill,
  InvRow,
  InvSearch,
  InvState,
  InvStatus,
} from "@/components/inventory/v2/kit";
import {
  buildHubRows,
  formatOrderDate,
  matchesHubSearch,
  productsWord,
  type HubDraft,
  type HubPo,
  type HubRow,
  type HubTab,
} from "@/lib/inventory/purchase-order-view";

/** The purchase-orders endpoint returns the latest 50 (its own default cap, unchanged). */
const PO_CAP = 50;
const PAGE = 50;
const TABS: HubTab[] = ["receive", "open", "history"];

function readTabParam(): HubTab | null {
  if (typeof window === "undefined") return null;
  const v = new URLSearchParams(window.location.search).get("tab");
  return v && (TABS as string[]).includes(v) ? (v as HubTab) : null;
}

async function getJson(url: string) {
  const res = await fetch(url, { headers: buildClientAuthHeaders(), cache: "no-store" });
  if (res.status === 401) {
    redirectToLogin();
    throw new Error("UNAUTHORIZED");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || "load failed");
  return data;
}

/**
 * Orders hub (redesign, owner-approved mockup "הזמנות מספקים").
 * Two models in one list, the difference always visible by the kicker:
 *   "טיוטת הזמנה" — supplier-purchase draft (wizard / CSV), full receipt on /pending.
 *   "הזמנת רכש"   — PurchaseOrder, partial receipt on /[id]/receive.
 * Both lists come from their existing endpoints, unchanged.
 */
export default function SupplierPurchasesHubPage() {
  const [drafts, setDrafts] = useState<HubDraft[]>([]);
  const [orders, setOrders] = useState<HubPo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [tab, setTab] = useState<HubTab | null>(null);
  const [urlTab, setUrlTab] = useState<HubTab | null>(null);
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(PAGE);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const [poData, draftData] = await Promise.all([
        getJson("/api/inventory/purchase-orders"),
        getJson("/api/inventory/supplier-purchases"),
      ]);
      setOrders(Array.isArray(poData?.purchaseOrders) ? poData.purchaseOrders : []);
      setDrafts(Array.isArray(draftData?.drafts) ? draftData.drafts : []);
    } catch (err) {
      if (err instanceof Error && err.message === "UNAUTHORIZED") return;
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setUrlTab(readTabParam());
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const rows = useMemo(() => buildHubRows(drafts, orders), [drafts, orders]);
  const counts = useMemo(() => {
    const c: Record<HubTab, number> = { receive: 0, open: 0, history: 0 };
    for (const r of rows) c[r.tab] += 1;
    return c;
  }, [rows]);

  // Default chip: ?tab=, else what needs receiving, else what is open, else history.
  const activeTab: HubTab = tab ?? urlTab ?? (counts.receive > 0 ? "receive" : counts.open > 0 ? "open" : "history");

  const chooseTab = (next: HubTab) => {
    setTab(next);
    setShown(PAGE);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", next);
      window.history.replaceState(window.history.state, "", url.toString());
    } catch {
      /* the chip still changes */
    }
  };

  const visible = useMemo(() => rows.filter((r) => r.tab === activeTab && matchesHubSearch(r, q)), [rows, activeTab, q]);

  const footer = (
    <div className="i2-footer__row">
      <InvButton href="/inventory/supplier-purchases/new">+ הזמנה חדשה</InvButton>
      <InvButton kind="secondary" href="/inventory/supplier-purchases/import">
        ייבוא מקובץ CSV
      </InvButton>
      <InvMenu
        up
        label="אפשרויות נוספות"
        items={[
          { label: "ייבוא מקובץ CSV", href: "/inventory/supplier-purchases/import" },
          { label: "אינטגרציות", href: "/inventory/supplier-purchases/integrations" },
          { label: "כרטיסי ספקים", href: "/suppliers" },
          { label: "היסטוריה", onClick: () => chooseTab("history") },
        ]}
      />
    </div>
  );

  return (
    <InvPage title="הזמנות מספקים" tabs="orders" backFallback="/inventory" wide footer={footer}>
      <InvSearch
        value={q}
        onChange={(v) => {
          setQ(v);
          setShown(PAGE);
        }}
        placeholder="חיפוש הזמנה או ספק"
      />
      <InvChips<HubTab>
        label="סינון הזמנות"
        value={activeTab}
        onChange={chooseTab}
        options={[
          { value: "receive", label: "לקליטה", count: loading ? undefined : counts.receive },
          { value: "open", label: "פתוחות", count: loading ? undefined : counts.open },
          { value: "history", label: "היסטוריה", count: loading ? undefined : counts.history },
        ]}
      />

      {loading ? (
        <InvLoading rows={5} />
      ) : error ? (
        <InvError onRetry={() => void load()} />
      ) : visible.length === 0 ? (
        q.trim() ? (
          <InvState
            title="לא נמצאו הזמנות"
            body={`אין הזמנה או ספק שתואמים ל״${q.trim()}״ בלשונית הזו.`}
            action={
              <InvButton kind="secondary" onClick={() => setQ("")}>
                ניקוי החיפוש
              </InvButton>
            }
          />
        ) : (
          <EmptyForTab tab={activeTab} onHistory={() => chooseTab("history")} />
        )
      ) : (
        <>
          <ul className="i2-list i2-only-mob">
            {visible.slice(0, shown).map((r) => (
              <HubListRow key={r.key} row={r} />
            ))}
          </ul>
          <div className="i2-only-desk">
            <HubTable rows={visible.slice(0, shown)} />
          </div>
          {visible.length > shown ? (
            <div style={{ textAlign: "center", marginTop: 12 }}>
              <InvButton kind="secondary" onClick={() => setShown((n) => n + PAGE)}>
                הצגת עוד
              </InvButton>
            </div>
          ) : null}
          {orders.length >= PO_CAP && activeTab !== "receive" ? <p className="i2-foot">מוצגות 50 ההזמנות האחרונות</p> : null}
        </>
      )}
    </InvPage>
  );
}

function orderNo(r: HubRow): string {
  return r.externalOrderId ? `#${r.externalOrderId}` : String(r.id);
}

function subLine(r: HubRow): string {
  const date = formatOrderDate(r.date);
  return [`הזמנה ${orderNo(r)}`, productsWord(r.lineCount), date].filter(Boolean).join(" · ");
}

function HubListRow({ row }: { row: HubRow }) {
  return (
    <InvRow
      href={row.action.href}
      kicker={row.kicker}
      title={row.supplier}
      sub={
        <>
          <bdi style={{ display: "block" }}>{subLine(row)}</bdi>
          <span style={{ display: "inline-block", marginTop: 4 }}>
            <InvStatus tone={row.status.tone}>{row.status.label}</InvStatus>
          </span>
        </>
      }
      ariaLabel={`${row.kicker} · ${row.supplier} · ${row.status.label}`}
      trail={
        <InvPill outline href={row.action.href} ariaLabel={`${row.action.label} · ${row.kicker} ${orderNo(row)}`}>
          {row.action.label}
        </InvPill>
      }
    />
  );
}

function HubTable({ rows }: { rows: HubRow[] }) {
  return (
    <table className="i2-table" aria-label="הזמנות מספקים">
      <thead>
        <tr>
          <th>סוג</th>
          <th>ספק</th>
          <th>הזמנה</th>
          <th>מוצרים</th>
          <th>תאריך</th>
          <th>סטטוס</th>
          <th>
            <span className="i2-sr">פעולה</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td className="i2-muted">{r.kicker}</td>
            <td>
              {r.supplierId != null ? (
                <Link href={`/suppliers/${r.supplierId}`} style={{ color: "inherit" }}>
                  <bdi>{r.supplier}</bdi>
                </Link>
              ) : (
                <bdi>{r.supplier}</bdi>
              )}
            </td>
            <td className="i2-num">
              <bdi>{orderNo(r)}</bdi>
            </td>
            <td className="i2-num">{r.lineCount.toLocaleString("he-IL")}</td>
            <td className="i2-num">{formatOrderDate(r.date) || "—"}</td>
            <td>
              <InvStatus tone={r.status.tone}>{r.status.label}</InvStatus>
            </td>
            <td style={{ textAlign: "end" }}>
              <InvPill outline href={r.action.href}>
                {r.action.label}
              </InvPill>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function EmptyForTab({ tab, onHistory }: { tab: HubTab; onHistory: () => void }) {
  if (tab === "receive") {
    return (
      <InvState
        title="אין הזמנות שממתינות לקליטה"
        body="הזמנה חדשה שתיצרו, או הזמנות שייובאו מקובץ, יופיעו כאן עד לקליטה במלאי."
        action={<InvButton href="/inventory/supplier-purchases/new">+ הזמנה חדשה</InvButton>}
      />
    );
  }
  if (tab === "open") {
    return (
      <InvState
        title="אין הזמנות רכש פתוחות"
        body="הזמנות רכש שעוד לא התקבלו במלואן יופיעו כאן."
        action={
          <InvButton kind="secondary" onClick={onHistory}>
            להיסטוריית ההזמנות
          </InvButton>
        }
      />
    );
  }
  return (
    <InvState
      title="עוד אין היסטוריית הזמנות"
      body="הזמנות שנקלטו במלאי או בוטלו יופיעו כאן."
      action={<InvButton href="/inventory/supplier-purchases/new">+ הזמנה חדשה</InvButton>}
    />
  );
}
