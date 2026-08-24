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
  /** The month the UI is showing (resolved from the server, else the request). */
  selectedMonth: string | null;
  /** Distinct Jerusalem months that hold pending docs, newest first. */
  pendingMonths: string[];
  financialPulse: InboxFinancialPulse | null;
  items: InboxListItem[];
  pagination: InboxPagination | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  refetch: () => void;
  /** Switch the viewed month (null = server default = current Jerusalem month). */
  setMonth: (month: string | null) => void;
  /**
   * Re-fetch the first page WITHOUT toggling `loading` (no skeleton flash).
   * Used for background polling while documents are still `processing`.
   */
  refetchQuiet: () => Promise<void>;
  loadMore: () => void;
};

export function useDocumentsInbox(
  authToken: string | null,
  options?: { initialMonth?: string | null }
): UseDocumentsInboxResult {
  const [month, setMonthState] = useState<string | null>(
    options?.initialMonth ?? null
  );
  const [scope, setScope] = useState<InboxScope | null>(null);
  const [pendingMonths, setPendingMonths] = useState<string[]>([]);
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
      const snap = await fetchDocumentsInbox(
        authToken,
        month ? { month } : undefined
      );
      setScope(snap.scope);
      setPendingMonths(snap.pendingMonths);
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
  }, [authToken, month]);

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
      const snap = await fetchDocumentsInbox(
        authToken,
        month ? { month } : undefined
      );
      setScope(snap.scope);
      setPendingMonths(snap.pendingMonths);
      setFinancialPulse(snap.financialPulse);
      setItems(snap.items);
      setPagination(snap.pagination);
      setError(null);
    } catch {
      // Poll failures are transient — keep showing the current list.
    }
  }, [authToken, month]);

  useEffect(() => {
    runInitial();
  }, [runInitial]);

  const refetch = useCallback(() => {
    runInitial();
  }, [runInitial]);

  const setMonth = useCallback((next: string | null) => {
    setMonthState(next);
  }, []);

  const selectedMonth = scope?.month ?? month ?? null;

  return useMemo(
    () => ({
      scope,
      selectedMonth,
      pendingMonths,
      financialPulse,
      items,
      pagination,
      loading,
      loadingMore,
      error,
      refetch,
      setMonth,
      refetchQuiet,
      loadMore,
    }),
    [
      scope,
      selectedMonth,
      pendingMonths,
      financialPulse,
      items,
      pagination,
      loading,
      loadingMore,
      error,
      refetch,
      setMonth,
      refetchQuiet,
      loadMore,
    ]
  );
}
