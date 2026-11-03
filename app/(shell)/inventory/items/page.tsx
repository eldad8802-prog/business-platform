"use client";

/**
 * Products list — owner-approved redesign mockup "המוצרים שלי" (2026-11-03).
 * Same data as before (getInventoryItems), same search fields (name, barcode,
 * sku, supplier, category), same tone rule and default order (critical → low →
 * ok, then name), same barcode-scan behaviour (one match opens it, none says
 * so, several filter the list). Deep links: ?q=, ?status=low (→ "דורש טיפול"),
 * ?status=missing-data.
 */

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEntryState } from "@/hooks/useEntryState";
import { useI18n } from "@/components/i18n/I18nProvider";
import BarcodeScanner from "@/components/inventory/barcode-scanner";
import { inventoryToast } from "@/components/inventory/inventory-toast";
import { getStockTone } from "@/components/inventory/inventory-design";
import { getInventoryItems, type InventoryItemDTO } from "@/lib/api/inventory";
import { getClientAuthToken, isUnauthorizedError, redirectToLogin } from "@/lib/client-session";
import { loadPendingProductDrafts } from "@/lib/inventory/overview-sources";
import { stockLine, TONE_WORD } from "@/lib/inventory/stock-line";
import { formatQtyNumber, qtyWithUnit, unitWord } from "@/lib/inventory/unit-words";
import {
  I2,
  InvButton,
  InvChips,
  InvError,
  InvLoading,
  InvMenu,
  InvNote,
  InvPage,
  InvRow,
  InvSearch,
  InvSegmented,
  InvSheet,
  InvState,
  InvStatus,
  ProductThumb,
  formatMoney,
} from "@/components/inventory/v2/kit";

type StockTone = ReturnType<typeof getStockTone>;
type StatusFilter = "all" | "attention" | "critical" | "low" | "ok" | "missing";
type SortKey = "status" | "name";

const PAGE_SIZE = 50;

const STATUS_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "הכל" },
  { value: "critical", label: "מלאי קריטי" },
  { value: "low", label: "מלאי נמוך" },
  { value: "ok", label: "תקין" },
  { value: "missing", label: "חסרי עלות או מחיר" },
];

function statusFromParam(param: string | null): StatusFilter {
  if (param === "low") return "attention";
  if (param === "missing-data") return "missing";
  return "all";
}

/** Today's "missing data" rule: no cost (own or last purchase) or no sale price. */
function isMissingData(item: InventoryItemDTO): boolean {
  const hasCost = item.costPerUnit != null || item.lastPurchaseCost != null;
  return !(hasCost && item.sellPricePerUnit != null);
}

const TONE_STATUS: Record<StockTone, "danger" | "warn" | "ok"> = { critical: "danger", low: "warn", ok: "ok" };

function InventoryItemsListPageContent() {
  const router = useRouter();
  const { t } = useI18n();
  const searchParams = useSearchParams();
  const statusParam = searchParams.get("status");
  const [items, setItems] = useState<InventoryItemDTO[]>([]);
  const [draftCount, setDraftCount] = useState(0);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [query, setQuery] = useEntryState("query", () => searchParams.get("q") || "");
  const [status, setStatus] = useEntryState<StatusFilter>("status", () => statusFromParam(statusParam));
  const [category, setCategory] = useEntryState("category", "");
  const [supplier, setSupplier] = useEntryState("supplier", "");
  const [sort, setSort] = useEntryState<SortKey>("sort", "status");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // A deep link arriving while the list is already open (?status=…) applies it.
  const lastParam = useRef(statusParam);
  useEffect(() => {
    if (lastParam.current === statusParam) return;
    lastParam.current = statusParam;
    if (statusParam) setStatus(statusFromParam(statusParam));
  }, [statusParam, setStatus]);

  function changeStatus(next: StatusFilter) {
    setStatus(next);
    // Drop a stale ?status= so a refresh shows what is on screen.
    if (statusParam) {
      const q = searchParams.get("q");
      lastParam.current = null;
      router.replace(q ? `/inventory/items?q=${encodeURIComponent(q)}` : "/inventory/items", { scroll: false });
    }
  }

  async function loadItems() {
    const token = getClientAuthToken();
    if (!token) {
      setLoading(false);
      redirectToLogin();
      return;
    }
    try {
      setLoading(true);
      setError(null);
      const itemsData = await getInventoryItems();
      setItems(Array.isArray(itemsData) ? itemsData : []);
    } catch (err: unknown) {
      if (isUnauthorizedError(err)) {
        redirectToLogin();
        return;
      }
      // Server/network text is not shown to the owner; a Hebrew message with retry is.
      console.error("[inventory/items] load failed", err);
      setError(t("customers.inventory.common.loadItemsFailed"));
    } finally {
      setLoading(false);
    }
    void loadPendingProductDrafts()
      .then((d) => setDraftCount(d.length))
      .catch(() => setDraftCount(0));
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void loadItems(), 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-time load
  }, []);

  const categoryOptions = useMemo(
    () => Array.from(new Set(items.map((i) => i.category?.name?.trim()).filter((v): v is string => Boolean(v)))).sort((a, b) => a.localeCompare(b, "he")),
    [items]
  );
  const supplierOptions = useMemo(
    () => Array.from(new Set(items.map((i) => i.supplierName?.trim()).filter((v): v is string => Boolean(v)))).sort((a, b) => a.localeCompare(b, "he")),
    [items]
  );

  const sortedItems = useMemo(() => {
    const toneOrder: Record<StockTone, number> = { critical: 0, low: 1, ok: 2 };
    return [...items].sort((a, b) => {
      if (sort === "status") {
        const ta = toneOrder[getStockTone(a)];
        const tb = toneOrder[getStockTone(b)];
        if (ta !== tb) return ta - tb;
      }
      return a.name.localeCompare(b.name, "he");
    });
  }, [items, sort]);

  const attentionCount = useMemo(() => items.filter((i) => getStockTone(i) !== "ok").length, [items]);

  const filteredItems = useMemo(() => {
    const value = query.trim().toLowerCase();
    return sortedItems.filter((item) => {
      const tone = getStockTone(item);
      if (status === "missing") {
        if (!isMissingData(item)) return false;
      } else if (status === "attention") {
        if (tone === "ok") return false;
      } else if (status !== "all" && tone !== status) {
        return false;
      }
      if (category && (item.category?.name?.trim() || "") !== category) return false;
      if (supplier && (item.supplierName?.trim() || "") !== supplier) return false;
      if (!value) return true;
      return [item.name, item.barcode, item.sku, item.supplierName, item.category?.name]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(value));
    });
  }, [category, query, sortedItems, status, supplier]);

  // Client-side paging; any change of search/filter/sort starts again at the first page.
  const signature = JSON.stringify([query, status, category, supplier, sort]);
  const [page, setPage] = useState({ signature, count: PAGE_SIZE });
  const visibleCount = page.signature === signature ? page.count : PAGE_SIZE;
  const visibleItems = filteredItems.slice(0, visibleCount);

  const sheetFilterCount =
    (status === "critical" || status === "low" || status === "ok" || status === "missing" ? 1 : 0) + (category ? 1 : 0) + (supplier ? 1 : 0);

  function clearAll() {
    setQuery("");
    changeStatus("all");
    setCategory("");
    setSupplier("");
  }

  function handleScanDetected(code: string) {
    const scanned = code.trim();
    setScannerOpen(false);
    if (!scanned) return;
    const matches = items.filter((it) => (it.barcode || "").trim() === scanned);
    if (matches.length === 1) {
      router.push(`/inventory/items/${matches[0].id}`);
      return;
    }
    if (matches.length === 0) {
      // Keep the existing text search untouched; just report no match.
      inventoryToast.error(t("customers.inventory.items.barcodeNotFound"));
      return;
    }
    // More than one match (rare) — fall back to filtering the list by the code.
    setQuery(scanned);
  }

  const headerEnd = (
    <>
      <Link className="i2-hdlink" href="/settings/import-export">
        ייבוא וייצוא
      </Link>
      <InvMenu
        label="פעולות"
        items={[
          { label: "ייבוא וייצוא", href: "/settings/import-export" },
          { label: `טיוטות מוצר ממתינות (${draftCount})`, href: "/inventory/drafts" },
          { label: "מוצרים חסרי עלות או מחיר", onClick: () => changeStatus("missing") },
        ]}
      />
    </>
  );

  const chipValue: "all" | "attention" | "other" = status === "all" || status === "attention" ? status : "other";

  return (
    <InvPage
      title="המוצרים שלי"
      tabs="items"
      backFallback="/inventory"
      end={headerEnd}
      wide
      footer={
        <InvButton block href="/inventory/items/create">
          {I2.plus(22)}
          מוצר חדש
        </InvButton>
      }
    >
      <InvSearch value={query} onChange={setQuery} placeholder="חיפוש שם, מק״ט או ברקוד" onScan={() => setScannerOpen(true)} scanLabel="סריקת ברקוד" />

      <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
        <InvChips<"all" | "attention" | "other">
          value={chipValue}
          onChange={(v) => {
            if (v !== "other") changeStatus(v);
          }}
          label="סינון לפי מצב"
          options={[
            { value: "all", label: "הכל" },
            { value: "attention", label: "דורש טיפול", count: loading ? undefined : attentionCount },
          ]}
        />
        <button
          type="button"
          className="i2-chip"
          aria-pressed={sheetFilterCount > 0}
          aria-haspopup="dialog"
          onClick={() => setFilterOpen(true)}
          aria-label={sheetFilterCount > 0 ? `סינון ומיון · ${sheetFilterCount} פעילים` : "סינון ומיון"}
        >
          {I2.filter(18)}
          סינון
          {sheetFilterCount > 0 ? <span className="i2-chip__n">{sheetFilterCount}</span> : null}
        </button>
      </div>

      {status === "missing" ? <InvNote>{t("customers.inventory.items.missingData")}</InvNote> : null}

      {!loading && !error && draftCount > 0 ? (
        <InvNote>
          <span style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span>
              <bdi>{draftCount}</bdi> טיוטות מוצר ממתינות לבדיקה
            </span>
            <Link href="/inventory/drafts" className="i2-link" style={{ minHeight: 32, fontWeight: 600, color: "var(--i2-green-ink)" }}>
              לבדיקה {I2.chevronEnd(16)}
            </Link>
          </span>
        </InvNote>
      ) : null}

      <BarcodeScanner
        open={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onDetected={handleScanDetected}
        mode="single"
        title={t("customers.inventory.common.scanBarcode")}
        hint={t("customers.inventory.common.scanHint")}
      />

      {error ? (
        <InvError message={error} onRetry={() => void loadItems()} />
      ) : loading ? (
        <InvLoading rows={6} />
      ) : items.length === 0 ? (
        <InvState
          title="עוד אין מוצרים"
          body="הוסיפו מוצר ראשון, או ייבאו רשימת מוצרים מקובץ."
          action={
            <div className="i2-actions" style={{ maxWidth: 420, margin: "0 auto" }}>
              <InvButton href="/inventory/items/create">הוספת מוצר</InvButton>
              <InvButton kind="secondary" href="/settings/import-export">
                ייבוא מקובץ
              </InvButton>
            </div>
          }
        />
      ) : filteredItems.length === 0 ? (
        <InvState
          title="לא נמצאו מוצרים התואמים לחיפוש"
          action={
            <InvButton kind="secondary" onClick={clearAll}>
              ניקוי החיפוש
            </InvButton>
          }
        />
      ) : (
        <>
          {/* phone + tablet */}
          <ul className="i2-list i2-mob-only" aria-label="המוצרים">
            {visibleItems.map((item) => {
              const line = stockLine(item);
              const line1 = item.category?.name || item.supplierName || null;
              return (
                <InvRow
                  key={item.id}
                  href={`/inventory/items/${item.id}`}
                  thumb={<ProductThumb src={item.imageUrl} name={item.name} />}
                  title={item.name}
                  dot={line.tone === "critical" ? "danger" : line.tone === "low" ? "warn" : null}
                  ariaLabel={`${item.name} · ${TONE_WORD[line.tone]} · ${qtyWithUnit(item.currentQuantity, item.unitType)}`}
                  sub={
                    line1 || line.tone !== "ok" ? (
                      <>
                        {line1 ? <span className="i2-line">{line1}</span> : null}
                        {line.tone !== "ok" ? <span className={`i2-line${line.tone === "critical" ? " i2-line--danger" : ""}`}>{line.text}</span> : null}
                      </>
                    ) : undefined
                  }
                  trail={
                    <>
                      <span className="i2-row__qty">
                        <b className="i2-num">{formatQtyNumber(item.currentQuantity)}</b>
                        <span>{unitWord(item.unitType, item.currentQuantity)}</span>
                      </span>
                      <InvMenu
                        label={`פעולות · ${item.name}`}
                        items={[
                          { label: "פתיחת המוצר", href: `/inventory/items/${item.id}` },
                          { label: "עדכון מלאי", href: `/inventory/items/${item.id}?move=IN` },
                          { label: "הזמנה מספק", href: `/inventory/supplier-purchases/new?item=${item.id}` },
                        ]}
                      />
                    </>
                  }
                />
              );
            })}
          </ul>

          {/* desktop ≥1200 */}
          <div className="i2-desk-only">
            <table className="i2-table" aria-label="המוצרים">
              <thead>
                <tr>
                  <th>מוצר</th>
                  <th>קטגוריה</th>
                  <th>ספק</th>
                  <th>כמות</th>
                  <th>מינימום</th>
                  <th>נקודת הזמנה</th>
                  <th>עלות</th>
                  <th>מחיר</th>
                  <th>מצב</th>
                </tr>
              </thead>
              <tbody>
                {visibleItems.map((item) => {
                  const tone = getStockTone(item);
                  const href = `/inventory/items/${item.id}`;
                  return (
                    <tr key={item.id} data-href={href} onClick={() => router.push(href)}>
                      <td>
                        <span className="i2-cellprod">
                          <ProductThumb src={item.imageUrl} name={item.name} size={40} />
                          <Link href={href} onClick={(e) => e.stopPropagation()} style={{ color: "inherit", fontWeight: 600, textDecoration: "none", overflowWrap: "anywhere" }}>
                            {item.name}
                          </Link>
                        </span>
                      </td>
                      <td>{item.category?.name || "—"}</td>
                      <td>{item.supplierName || "—"}</td>
                      <td className="i2-num">
                        <bdi>{qtyWithUnit(item.currentQuantity, item.unitType)}</bdi>
                      </td>
                      <td className="i2-num">{formatQtyNumber(item.minimumQuantity)}</td>
                      <td className="i2-num">{item.reorderPoint != null ? formatQtyNumber(item.reorderPoint) : "—"}</td>
                      <td className="i2-num">{formatMoney(item.costPerUnit)}</td>
                      <td className="i2-num">{formatMoney(item.sellPricePerUnit)}</td>
                      <td>
                        <InvStatus tone={TONE_STATUS[tone]}>{TONE_WORD[tone]}</InvStatus>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {filteredItems.length > visibleCount ? (
            <div style={{ marginTop: 12 }}>
              <InvButton kind="secondary" block onClick={() => setPage({ signature, count: visibleCount + PAGE_SIZE })}>
                הצגת עוד
              </InvButton>
            </div>
          ) : null}
          <p className="i2-foot">
            מוצגים <bdi>{Math.min(visibleCount, filteredItems.length)}</bdi> מתוך <bdi>{filteredItems.length}</bdi> מוצרים
          </p>
        </>
      )}

      {filterOpen ? (
        <InvSheet
          title="סינון ומיון"
          onClose={() => setFilterOpen(false)}
          footer={
            <div className="i2-actions">
              <InvButton onClick={() => setFilterOpen(false)}>הצגת {filteredItems.length} מוצרים</InvButton>
              <InvButton
                kind="secondary"
                onClick={() => {
                  changeStatus("all");
                  setCategory("");
                  setSupplier("");
                  setSort("status");
                }}
              >
                ניקוי
              </InvButton>
            </div>
          }
        >
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="i2-h3" style={{ margin: "0 0 4px" }}>
              מצב
            </legend>
            {STATUS_OPTIONS.map((o) => (
              <label key={o.value} className="i2-radio i2-radio--plain">
                <input
                  type="radio"
                  name="inv-status"
                  checked={status === o.value}
                  onChange={() => changeStatus(o.value)}
                />
                <span>{o.label}</span>
              </label>
            ))}
          </fieldset>

          <div className="i2-field i2-field--stack">
            <label className="i2-field__lab" htmlFor="inv-filter-category">
              קטגוריה
            </label>
            <select id="inv-filter-category" className="i2-select" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">כל הקטגוריות</option>
              {categoryOptions.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div className="i2-field i2-field--stack">
            <label className="i2-field__lab" htmlFor="inv-filter-supplier">
              ספק
            </label>
            <select id="inv-filter-supplier" className="i2-select" value={supplier} onChange={(e) => setSupplier(e.target.value)}>
              <option value="">כל הספקים</option>
              {supplierOptions.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div className="i2-field i2-field--stack">
            <span className="i2-field__lab">מיון</span>
            <InvSegmented<SortKey>
              value={sort}
              onChange={setSort}
              label="מיון"
              options={[
                { value: "status", label: "לפי מצב" },
                { value: "name", label: "לפי שם" },
              ]}
            />
          </div>
        </InvSheet>
      ) : null}
    </InvPage>
  );
}

// useSearchParams() requires a Suspense boundary for static prerender (Next).
export default function InventoryItemsListPage() {
  return (
    <Suspense fallback={null}>
      <InventoryItemsListPageContent />
    </Suspense>
  );
}
