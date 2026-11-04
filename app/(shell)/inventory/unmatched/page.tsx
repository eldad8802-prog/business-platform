"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { inventoryToast } from "@/components/inventory/inventory-toast";
import {
  getInventoryItems,
  getPendingMatches,
  resolvePendingMatch,
  type InventoryItemDTO,
  type InventoryPendingMatchDTO,
} from "@/lib/api/inventory";
import { isUnauthorizedError, redirectToLogin } from "@/lib/client-session";
import { formatPosWhen, posSaleName, suggestPosMatches } from "@/lib/inventory/pos-match";
import { qtyWithUnit } from "@/lib/inventory/unit-words";
import {
  InvButton,
  InvConfirm,
  InvError,
  InvLoading,
  InvMenu,
  InvNote,
  InvPage,
  InvPill,
  InvRow,
  InvSearch,
  InvState,
  ProductThumb,
  formatQty,
  useInvSubViewBack,
} from "@/components/inventory/v2/kit";

const PAGE = 50;
const LIST = "/inventory/unmatched";

/**
 * POS sale matching (שיוך מכירה למוצר) — redesign, owner-approved mockup.
 * List of POS sale lines that did not match a product; the detail (?match=ID)
 * links one to an existing product (LINK_EXISTING), creates a product from it
 * (CREATE_NEW) or rejects it (REJECT) — the same POST
 * /api/inventory/unmatched/:id/resolve payloads as before. Nothing links on a
 * single tap: a product is selected, then confirmed.
 */
function UnmatchedScreen() {
  const router = useRouter();
  const backFromDetail = useInvSubViewBack(LIST);
  const params = useSearchParams();
  const matchParam = Number(params.get("match"));
  const openId = Number.isFinite(matchParam) && matchParam > 0 ? matchParam : null;

  const [pendingMatches, setPendingMatches] = useState<InventoryPendingMatchDTO[]>([]);
  const [items, setItems] = useState<InventoryItemDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null);
  const [confirmReject, setConfirmReject] = useState(false);
  const [listLimit, setListLimit] = useState(PAGE);
  const [searchLimit, setSearchLimit] = useState(PAGE);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      setError(false);
      const [pendingData, itemsData] = await Promise.all([getPendingMatches(), getInventoryItems()]);
      setPendingMatches(Array.isArray(pendingData) ? pendingData : []);
      setItems(Array.isArray(itemsData) ? itemsData : []);
    } catch (err: unknown) {
      if (isUnauthorizedError(err)) {
        redirectToLogin();
        return;
      }
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadData(), 0);
    return () => window.clearTimeout(timer);
  }, [loadData]);

  // A new detail starts clean.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery("");
      setSelectedItemId(null);
      setActionError(null);
      setSearchLimit(PAGE);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [openId]);

  const activeItems = useMemo(() => items.filter((item) => item.id && item.name), [items]);
  const pending = openId != null ? pendingMatches.find((p) => p.id === openId) ?? null : null;

  const suggestions = useMemo(() => (pending ? suggestPosMatches(pending, activeItems, 5).map((m) => m.item) : []), [pending, activeItems]);
  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return activeItems.filter((item) => [item.name, item.sku, item.barcode].filter(Boolean).some((f) => String(f).toLowerCase().includes(q)));
  }, [activeItems, query]);
  const searching = query.trim() !== "";
  const options = searching ? searchResults.slice(0, searchLimit) : suggestions;
  const selectedItem = selectedItemId != null ? activeItems.find((i) => i.id === selectedItemId) ?? null : null;

  function backToList(message: string) {
    inventoryToast.success(message);
    router.replace(LIST);
    void loadData();
  }

  async function linkExisting() {
    if (busy || !pending || !selectedItem) return;
    try {
      setBusy(true);
      setActionError(null);
      await resolvePendingMatch(pending.id, { action: "LINK_EXISTING", itemId: selectedItem.id });
      backToList(`המכירה שויכה ל־${selectedItem.name}`);
    } catch (err) {
      if (isUnauthorizedError(err)) return redirectToLogin();
      setActionError("לא הצלחנו לשייך את המכירה. נסו שוב.");
    } finally {
      setBusy(false);
    }
  }

  async function createNew() {
    if (busy || !pending) return;
    const meta = pending.metadata;
    try {
      setBusy(true);
      setActionError(null);
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
      backToList("נוצר מוצר חדש מהמכירה");
    } catch (err) {
      if (isUnauthorizedError(err)) return redirectToLogin();
      setActionError("לא ניתן ליצור מוצר חדש ממכירה זו. אפשר לשייך למוצר קיים.");
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    if (busy || !pending) return;
    try {
      setBusy(true);
      setActionError(null);
      await resolvePendingMatch(pending.id, { action: "REJECT" });
      setConfirmReject(false);
      backToList("המכירה נדחתה");
    } catch (err) {
      if (isUnauthorizedError(err)) return redirectToLogin();
      setConfirmReject(false);
      setActionError("לא הצלחנו לדחות את המכירה. נסו שוב.");
    } finally {
      setBusy(false);
    }
  }

  /* -------------------------------------------------------------- detail -- */
  if (openId != null) {
    const meta = pending?.metadata;
    const name = pending ? posSaleName(pending) : "";
    const when = formatPosWhen(pending?.createdAt);
    return (
      <InvPage
        title="שיוך מכירה למוצר"
        backFallback={LIST}
        onBack={backFromDetail}
        end={pending ? <InvMenu label="פעולות נוספות" items={[{ label: "דחיית המכירה", onClick: () => setConfirmReject(true) }]} /> : undefined}
        footer={
          pending && !loading && !error ? (
            <>
              {actionError ? <InvNote tone="danger">{actionError}</InvNote> : null}
              <InvButton block onClick={() => void linkExisting()} disabled={busy || !selectedItem}>
                {busy ? "שומר…" : "אישור שיוך"}
              </InvButton>
              <p className="i2-footer__note">השיוך יאפשר להשלים את עדכון המלאי</p>
              <div style={{ marginTop: 8 }}>
                <InvButton kind="secondary" block onClick={() => void createNew()} disabled={busy}>
                  יצירת מוצר חדש
                </InvButton>
              </div>
            </>
          ) : null
        }
      >
        {loading ? (
          <InvLoading rows={3} />
        ) : error ? (
          <InvError onRetry={() => void loadData()} />
        ) : !pending || !meta ? (
          <InvState
            title="המכירה הזו כבר טופלה או לא נמצאה"
            body="ייתכן שהיא שויכה או נדחתה כבר."
            action={<InvButton kind="secondary" onClick={() => router.replace(LIST)}>לרשימת המכירות לשיוך</InvButton>}
          />
        ) : (
          <>
            <div className="i2-box" style={{ marginTop: 12 }}>
              <div style={{ fontWeight: 600 }}>מכירה מקופה · פריט לא מזוהה</div>
              {when ? <div className="i2-muted" style={{ fontSize: 14, marginTop: 2 }}>{when}</div> : null}
            </div>
            <dl className="i2-kv">
              <div className="i2-kv__r">
                <dt>שם שזוהה</dt>
                <dd>{name}</dd>
              </div>
              <div className="i2-kv__r">
                <dt>כמות</dt>
                <dd className="i2-num">{formatQty(meta.quantity)}</dd>
              </div>
              <div className="i2-kv__r">
                <dt>ברקוד</dt>
                <dd className="i2-num">
                  <bdi>{meta.barcode || "—"}</bdi>
                </dd>
              </div>
              {meta.sku ? (
                <div className="i2-kv__r">
                  <dt>מק״ט</dt>
                  <dd>
                    <bdi>{meta.sku}</bdi>
                  </dd>
                </div>
              ) : null}
            </dl>

            <h2 className="i2-h3">חיפוש מוצר קיים</h2>
            <InvSearch
              value={query}
              onChange={(v) => {
                setQuery(v);
                setSearchLimit(PAGE);
              }}
              placeholder="חיפוש לפי שם, מק״ט או ברקוד"
            />

            <h2 className="i2-h3">{searching ? "תוצאות חיפוש" : "הצעות לשיוך"}</h2>
            {options.length === 0 ? (
              <p className="i2-muted" style={{ margin: "4px 0 0" }}>
                {searching
                  ? "לא נמצאו מוצרים מתאימים לחיפוש."
                  : activeItems.length === 0
                    ? "אין עדיין מוצרים במלאי. אפשר ליצור מוצר חדש מהמכירה."
                    : "לא נמצא מוצר דומה. חפשו מוצר קיים או צרו מוצר חדש."}
              </p>
            ) : (
              <div role="radiogroup" aria-label={searching ? "תוצאות חיפוש" : "הצעות לשיוך"}>
                {options.map((item) => (
                  <label key={item.id} className="i2-radio">
                    <input
                      type="radio"
                      name="pos-link"
                      checked={selectedItemId === item.id}
                      onChange={() => setSelectedItemId(item.id)}
                    />
                    <ProductThumb src={item.imageUrl} name={item.name} size={48} />
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span className="i2-clamp2" style={{ fontWeight: 600 }}>
                        {item.name}
                      </span>
                      <span className="i2-row__sub" style={{ display: "block" }}>
                        {qtyWithUnit(item.currentQuantity, item.unitType)} במלאי
                      </span>
                    </span>
                  </label>
                ))}
                {searching && searchResults.length > searchLimit ? (
                  <div style={{ textAlign: "center", marginTop: 8 }}>
                    <InvButton kind="soft" small onClick={() => setSearchLimit((n) => n + PAGE)}>
                      הצגת עוד
                    </InvButton>
                  </div>
                ) : null}
              </div>
            )}
            {!selectedItem && options.length > 0 ? (
              <p className="i2-muted" style={{ fontSize: 14, marginTop: 6 }}>
                בחרו מוצר ואז אשרו את השיוך.
              </p>
            ) : null}
          </>
        )}

        {confirmReject && pending ? (
          <InvConfirm
            title="לדחות את המכירה?"
            body="המכירה תוסר מהרשימה ולא תשויך למוצר. המלאי לא יתעדכן לפיה."
            confirmLabel={busy ? "דוחה…" : "דחיית המכירה"}
            danger
            busy={busy}
            onConfirm={() => void reject()}
            onCancel={() => setConfirmReject(false)}
          />
        ) : null}
      </InvPage>
    );
  }

  /* ---------------------------------------------------------------- list -- */
  return (
    <InvPage title="מכירות לשיוך" backFallback="/inventory/sales" wide>
      {loading ? (
        <InvLoading rows={4} />
      ) : error ? (
        <InvError onRetry={() => void loadData()} />
      ) : pendingMatches.length === 0 ? (
        <InvState
          title="אין מכירות שממתינות לשיוך"
          body="כל פריט שנמכר בקופה ולא זוהה כמוצר יופיע כאן לשיוך."
          action={<InvButton kind="secondary" href="/inventory">חזרה למלאי</InvButton>}
        />
      ) : (
        <>
          <p className="i2-muted" style={{ margin: "12px 0 0" }}>
            {pendingMatches.length === 1 ? "מכירה אחת ממתינה לשיוך" : `${pendingMatches.length.toLocaleString("he-IL")} מכירות ממתינות לשיוך`}
          </p>
          <ul className="i2-list">
            {pendingMatches.slice(0, listLimit).map((p) => {
              const name = posSaleName(p);
              const when = formatPosWhen(p.createdAt);
              const href = `${LIST}?match=${p.id}`;
              return (
                <InvRow
                  key={p.id}
                  href={href}
                  thumb={<ProductThumb name={name} />}
                  kicker="קופה"
                  title={name}
                  sub={`כמות ${formatQty(p.metadata?.quantity)}${when ? ` · ${when}` : ""}`}
                  trail={<InvPill href={href} ariaLabel={`שיוך ${name} למוצר`}>שיוך</InvPill>}
                />
              );
            })}
          </ul>
          {pendingMatches.length > listLimit ? (
            <div style={{ textAlign: "center", marginTop: 8 }}>
              <InvButton kind="soft" small onClick={() => setListLimit((n) => n + PAGE)}>
                הצגת עוד
              </InvButton>
            </div>
          ) : null}
        </>
      )}
    </InvPage>
  );
}

// useSearchParams() requires a Suspense boundary for static prerender (Next).
export default function InventoryUnmatchedPage() {
  return (
    <Suspense fallback={null}>
      <UnmatchedScreen />
    </Suspense>
  );
}
