"use client";

import { useCallback, useEffect, useState } from "react";
import { getInventoryItems, getPendingMatches } from "@/lib/api/inventory";
import { getStockTone } from "@/components/inventory/inventory-design";
import {
  buildClientAuthHeaders,
  getClientAuthToken,
  isUnauthorizedError,
  redirectToLogin,
} from "@/lib/client-session";

export type InventoryInboxCounts = {
  unmatched: number;
  drafts: number;
  pendingOrders: number;
  criticalStock: number;
  reorderAlerts: number;
  loading: boolean;
};

const EMPTY: InventoryInboxCounts = {
  unmatched: 0,
  drafts: 0,
  pendingOrders: 0,
  criticalStock: 0,
  reorderAlerts: 0,
  loading: true,
};

export function useInventoryInboxCounts() {
  const [counts, setCounts] = useState<InventoryInboxCounts>(EMPTY);

  const load = useCallback(async () => {
    const token = getClientAuthToken();
    if (!token) {
      setCounts({ ...EMPTY, loading: false });
      return;
    }

    try {
      setCounts((c) => ({ ...c, loading: true }));

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

      const items = Array.isArray(itemsData) ? itemsData : [];

      let drafts = 0;
      if (draftsRes.ok) {
        const data = await draftsRes.json();
        drafts = Array.isArray(data?.drafts) ? data.drafts.length : 0;
      }

      let pendingOrders = 0;
      if (purchasesRes.ok) {
        const data = await purchasesRes.json();
        pendingOrders = Array.isArray(data?.drafts)
          ? data.drafts.filter(
              (d: { status?: string }) => d.status === "PENDING_REVIEW"
            ).length
          : 0;
      }

      let reorderAlerts = 0;
      if (reorderRes.ok) {
        const data = await reorderRes.json();
        reorderAlerts = Array.isArray(data?.suggestions)
          ? data.suggestions.length
          : 0;
      }

      setCounts({
        unmatched: Array.isArray(pendingMatches) ? pendingMatches.length : 0,
        drafts,
        pendingOrders,
        criticalStock: items.filter((item) => getStockTone(item) === "critical")
          .length,
        reorderAlerts,
        loading: false,
      });
    } catch (err) {
      if (isUnauthorizedError(err)) {
        redirectToLogin();
        return;
      }
      setCounts({ ...EMPTY, loading: false });
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void load();
    });
  }, [load]);

  return { counts, reload: load };
}
