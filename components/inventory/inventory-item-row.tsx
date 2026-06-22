"use client";

import { useRouter } from "next/navigation";
import {
  IconBox,
  StockBar,
  getStockRatio,
  getStockTone,
} from "@/components/inventory/inventory-design";
import type { InventoryItemDTO } from "@/lib/api/inventory";

type InventoryItemDisplayDTO = InventoryItemDTO & {
  sellPricePerUnit?: number | null;
};

function IconTrendUp() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M6 14l5-5 4 4 5-7"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M15 6h5v5"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconTrendDown() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M6 10l5 5 4-4 5 7"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M15 18h5v-5"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function isValidInventoryImageUrl(imageUrl?: string | null) {
  if (!imageUrl) return false;
  if (imageUrl.includes("example.com")) return false;
  return true;
}

export function itemStockStatusLabel(tone: "ok" | "low" | "critical") {
  if (tone === "ok") return "תקין";
  if (tone === "low") return "מלאי נמוך";
  return "מלאי קריטי";
}

function formatListPrice(value: number) {
  return value.toLocaleString("he-IL", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

function listActiveSellPrice(value: number | null | undefined): number | null {
  if (value != null && Number.isFinite(value) && value > 0) {
    return value;
  }
  return null;
}

export type InventoryItemRowClassPrefix = "inv-quick-view" | "inv-items-list";

export function InventoryItemRow({
  item,
  classPrefix,
}: {
  item: InventoryItemDisplayDTO;
  classPrefix: InventoryItemRowClassPrefix;
}) {
  const router = useRouter();
  const tone = getStockTone(item);
  const imageOk = isValidInventoryImageUrl(item.imageUrl);
  const minPoint =
    item.minimumQuantity > 0 ? item.minimumQuantity : item.reorderPoint;
  const hasBar = minPoint != null && minPoint > 0;
  const trendUp = tone === "ok";
  const p = classPrefix;
  const sellPrice = listActiveSellPrice(item.sellPricePerUnit);

  if (classPrefix === "inv-quick-view") {
    return (
      <button
        type="button"
        className={`${p}__row`}
        data-tone={tone}
        onClick={() => router.push(`/inventory/items/${item.id}`)}
      >
        {imageOk ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.imageUrl || ""} alt="" className={`${p}__thumb`} />
        ) : (
          <span className={`${p}__thumb ${p}__thumb--ph`}>
            <IconBox />
          </span>
        )}

        <span className={`${p}__main`}>
          <span className={`${p}__name`}>{item.name}</span>
          <span className={`${p}__status-line`}>
            <span className={`inv-status-badge inv-status-badge--${tone}`}>
              {itemStockStatusLabel(tone)}
            </span>
          </span>
          <span className={`${p}__quantity-line`}>
            במלאי <span className={`${p}__qty`}>{item.currentQuantity}</span>
            {minPoint != null && minPoint > 0 ? (
              <span className={`${p}__meta`}> · מינימום {minPoint}</span>
            ) : null}
          </span>
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      className={`${p}__row`}
      data-tone={tone}
      onClick={() => router.push(`/inventory/items/${item.id}`)}
    >
      {imageOk ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={item.imageUrl || ""} alt="" className={`${p}__thumb`} />
      ) : (
        <span className={`${p}__thumb ${p}__thumb--ph`}>
          <IconBox />
        </span>
      )}

      <span className={`${p}__main`}>
        <span className={`${p}__name`}>{item.name}</span>
        {minPoint != null && minPoint > 0 ? (
          <span className={`${p}__meta`}>
            מינימום {minPoint} · במלאי {item.currentQuantity}
          </span>
        ) : (
          <span className={`${p}__meta`}>במלאי {item.currentQuantity}</span>
        )}
      </span>

      <span className={`${p}__bar`}>
        {hasBar ? <StockBar ratio={getStockRatio(item)} tone={tone} /> : null}
      </span>

      <span
        className={`${p}__price${sellPrice == null ? ` ${p}__price--missing` : ""}`}
      >
        {sellPrice != null ? `₪${formatListPrice(sellPrice)}` : "ללא מחיר"}
      </span>

      <span className={`${p}__badge-cell`}>
        <span className={`inv-status-badge inv-status-badge--${tone}`}>
          {itemStockStatusLabel(tone)}
        </span>
      </span>

      <span
        className={`inv-trend inv-trend--${trendUp ? "up" : "down"}`}
        aria-hidden
      >
        {trendUp ? <IconTrendUp /> : <IconTrendDown />}
      </span>

      <span className={`${p}__qty`}>{item.currentQuantity}</span>
    </button>
  );
}
