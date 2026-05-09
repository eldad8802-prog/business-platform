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
      loadMore,
    ]
  );
}
