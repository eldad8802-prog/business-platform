"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  PlatformAdminAttentionResponse,
  PlatformAdminBusinessesResponse,
  PlatformAdminOverviewResponse,
  PlatformAdminSessionResponse,
} from "@/lib/services/platform-admin/types";
import type { PlatformUsageOverviewResponse } from "@/lib/services/platform-admin/platform-usage-overview.service";
import {
  PlatformAdminFetchError,
  fetchPlatformAdminAttention,
  fetchPlatformAdminBusinesses,
  fetchPlatformAdminOverview,
  fetchPlatformAdminUsageOverview,
} from "@/lib/platform-admin/fetch-platform-admin";
import { PlatformAdminHeader } from "./platform-admin-header";
import { PlatformAdminNav } from "./platform-admin-nav";
import { PlatformHealthSection } from "./platform-health-section";
import { PlatformAttentionSection } from "./platform-attention-section";
import { PlatformUsageInsightsSection } from "./platform-usage-insights-section";
import { PlatformBusinessesSection } from "./platform-businesses-section";
import { TaxAuthorityProbeSection } from "./tax-authority-probe-section";
import { PlatformAdminSkeleton } from "./platform-admin-skeleton";
import { PA } from "./platform-admin-styles";

type AdminControlSurfaceProps = {
  session: PlatformAdminSessionResponse;
};

type LoadState = {
  overview: PlatformAdminOverviewResponse | null;
  attention: PlatformAdminAttentionResponse | null;
  usage: PlatformUsageOverviewResponse | null;
  businesses: PlatformAdminBusinessesResponse | null;
  overviewError: string | null;
  attentionError: string | null;
  usageError: string | null;
  businessesError: string | null;
};

const initialLoadState: LoadState = {
  overview: null,
  attention: null,
  usage: null,
  businesses: null,
  overviewError: null,
  attentionError: null,
  usageError: null,
  businessesError: null,
};

export function AdminControlSurface({ session }: AdminControlSurfaceProps) {
  const [loadState, setLoadState] = useState<LoadState>(initialLoadState);
  const [businessPage, setBusinessPage] = useState(1);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [businessesLoading, setBusinessesLoading] = useState(false);
  const [usageLoading, setUsageLoading] = useState(false);

  const loadOverviewAndAttention = useCallback(async () => {
    const [overviewResult, attentionResult] = await Promise.allSettled([
      fetchPlatformAdminOverview(),
      fetchPlatformAdminAttention(),
    ]);

    setLoadState((prev) => {
      const next = { ...prev };
      if (overviewResult.status === "fulfilled") {
        next.overview = overviewResult.value;
        next.overviewError = null;
      } else {
        next.overview = null;
        next.overviewError =
          overviewResult.reason instanceof PlatformAdminFetchError
            ? overviewResult.reason.message
            : "לא ניתן לטעון סקירת מערכת";
      }
      if (attentionResult.status === "fulfilled") {
        next.attention = attentionResult.value;
        next.attentionError = null;
      } else {
        next.attention = null;
        next.attentionError =
          attentionResult.reason instanceof PlatformAdminFetchError
            ? attentionResult.reason.message
            : "לא ניתן לטעון תור תשומת לב";
      }
      return next;
    });
  }, []);

  const loadUsage = useCallback(async () => {
    setUsageLoading(true);
    try {
      const usage = await fetchPlatformAdminUsageOverview();
      setLoadState((prev) => ({
        ...prev,
        usage,
        usageError: null,
      }));
    } catch (error) {
      setLoadState((prev) => ({
        ...prev,
        usage: null,
        usageError:
          error instanceof PlatformAdminFetchError
            ? error.message
            : "לא ניתן לטעון נתוני שימוש",
      }));
    } finally {
      setUsageLoading(false);
    }
  }, []);

  const loadBusinesses = useCallback(async (page: number) => {
    setBusinessesLoading(true);
    try {
      const businesses = await fetchPlatformAdminBusinesses(page);
      setLoadState((prev) => ({
        ...prev,
        businesses,
        businessesError: null,
      }));
    } catch (error) {
      setLoadState((prev) => ({
        ...prev,
        businesses: null,
        businessesError:
          error instanceof PlatformAdminFetchError
            ? error.message
            : "לא ניתן לטעון רשימת עסקים",
      }));
    } finally {
      setBusinessesLoading(false);
    }
  }, []);

  const loadAll = useCallback(
    async (page: number) => {
      await Promise.all([
        loadOverviewAndAttention(),
        loadUsage(),
        loadBusinesses(page),
      ]);
    },
    [loadOverviewAndAttention, loadUsage, loadBusinesses]
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setInitialLoading(true);
      await loadAll(businessPage);
      if (!cancelled) {
        setInitialLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (initialLoading) return;
    void loadBusinesses(businessPage);
  }, [businessPage, initialLoading, loadBusinesses]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadAll(businessPage);
    setRefreshing(false);
  };

  const healthStatus =
    loadState.overviewError &&
    loadState.attentionError &&
    loadState.usageError
      ? "error"
      : loadState.overviewError ||
          loadState.attentionError ||
          loadState.usageError
        ? "partial"
        : loadState.overview
          ? "ok"
          : "unknown";

  const generatedAt =
    loadState.overview?.generatedAt ??
    loadState.attention?.generatedAt ??
    loadState.usage?.generatedAt ??
    null;

  if (initialLoading) {
    return (
      <div style={{ padding: "24px 16px", maxWidth: PA.maxWidth, margin: "0 auto" }}>
        <PlatformAdminSkeleton />
      </div>
    );
  }

  return (
    <div
      style={{
        padding: "20px 16px 40px",
        maxWidth: PA.maxWidth,
        margin: "0 auto",
        display: "flex",
        flexDirection: "column",
        gap: 24,
      }}
    >
      <PlatformAdminNav />

      <PlatformAdminHeader
        session={session}
        generatedAt={generatedAt}
        healthStatus={healthStatus}
        onRefresh={() => void handleRefresh()}
        refreshing={refreshing}
      />

      <PlatformHealthSection
        overview={loadState.overview}
        error={loadState.overviewError}
        onRetry={() => void loadOverviewAndAttention()}
      />

      <PlatformAttentionSection
        attention={loadState.attention}
        error={loadState.attentionError}
        onRetry={() => void loadOverviewAndAttention()}
      />

      <PlatformUsageInsightsSection
        usage={loadState.usage}
        error={loadState.usageError}
        loading={usageLoading || refreshing}
        onRetry={() => void loadUsage()}
      />

      <PlatformBusinessesSection
        data={loadState.businesses}
        error={loadState.businessesError}
        loading={businessesLoading || refreshing}
        onRetry={() => void loadBusinesses(businessPage)}
        onPageChange={setBusinessPage}
      />

      {/* TEMPORARY diagnostic — remove with the token-probe route/service/tests. */}
      <TaxAuthorityProbeSection />
    </div>
  );
}
