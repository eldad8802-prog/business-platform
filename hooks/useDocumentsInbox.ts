"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchDocumentsInbox } from "@/lib/documents/fetch-inbox";
import type {
  InboxFinancialPulse,
  InboxListItem,
  InboxPagination,
  InboxScope,
} from "@/lib/documents/inbox-types";

export type UseDocumentsInboxResult = {
  scope: InboxScope | null;
  financialPulse: InboxFinancialPulse | null;
  items: InboxListItem[];
  pagination: InboxPagination | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  refetch: () => void;
  /**
   * Re-fetch the first page WITHOUT toggling `loading` (no skeleton flash).
   * Used for background polling while documents are still `processing`.
   */
  refetchQuiet: () => Promise<void>;
  loadMore: () => void;
};

export function useDocumentsInbox(authToken: string | null): UseDocumentsInboxResult {
  const [scope, setScope] = useState<InboxScope | null>(null);
  const [financialPulse, setFinancialPulse] =
    useState<InboxFinancialPulse | null>(null);
  const [items, setItems] = useState<InboxListItem[]>([]);
  const [pagination, setPagination] = useState<InboxPagination | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runInitial = useCallback(async () => {
    if (!authToken) {
      setLoading(false);
      setError("לא מחובר");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const snap = await fetchDocumentsInbox(authToken);
      setScope(snap.scope);
      setFinancialPulse(snap.financialPulse);
      setItems(snap.items);
      setPagination(snap.pagination);
    } catch (e) {
      setError(e instanceof Error ? e.message : "שגיאת טעינה");
      setItems([]);
      setPagination(null);
      setFinancialPulse(null);
      setScope(null);
    } finally {
      setLoading(false);
    }
  }, [authToken]);

  const loadMore = useCallback(async () => {
    if (
      !authToken ||
      !scope?.month ||
      !pagination?.hasMore ||
      !pagination.nextCursor
    ) {
      return;
    }
    setLoadingMore(true);
    setError(null);
    try {
      const snap = await fetchDocumentsInbox(authToken, {
        month: scope.month,
        cursor: pagination.nextCursor,
        limit: pagination.limit,
      });
      setScope(snap.scope);
      setFinancialPulse(snap.financialPulse);
      setItems((prev) => [...prev, ...snap.items]);
      setPagination(snap.pagination);
    } catch (e) {
      setError(e instanceof Error ? e.message : "שגיאת טעינה");
    } finally {
      setLoadingMore(false);
    }
  }, [authToken, pagination, scope?.month]);

  // Silent refresh of the first page — keeps `loading` false so background
  // polling never flashes the skeleton over an already-rendered list.
  const refetchQuiet = useCallback(async () => {
    if (!authToken) return;
    try {
      const snap = await fetchDocumentsInbox(authToken);
      setScope(snap.scope);
      setFinancialPulse(snap.financialPulse);
      setItems(snap.items);
      setPagination(snap.pagination);
      setError(null);
    } catch {
      // Poll failures are transient — keep showing the current list.
    }
  }, [authToken]);

  useEffect(() => {
    runInitial();
  }, [runInitial]);

  const refetch = useCallback(() => {
    runInitial();
  }, [runInitial]);

  return useMemo(
    () => ({
      scope,
      financialPulse,
      items,
      pagination,
      loading,
      loadingMore,
      error,
      refetch,
      refetchQuiet,
      loadMore,
    }),
    [
      scope,
      financialPulse,
      items,
      pagination,
      loading,
      loadingMore,
      error,
      refetch,
      refetchQuiet,
      loadMore,
    ]
  );
}
