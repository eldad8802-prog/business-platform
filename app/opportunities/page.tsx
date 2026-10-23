"use client";
import { PageContainer } from "@/components/ui/page-container";

import { useEffect, useMemo, useState } from "react";
import { TOKEN } from "@/lib/design/tokens";
import BackButton from "@/components/ui/back-button";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/translate";
import { DEALS_ERROR, resolveDealsOutcome, type DealsCall } from "./deals-fetch-contract";

// The contract's Hebrew messages stay the stored/tested values; the screen shows them in the active language.
const DEALS_ERROR_KEYS: Record<DealsCall, MessageKey> = {
  fetch: "content.pricing.opportunities.errors.fetch",
  generate: "content.pricing.opportunities.errors.generate",
  update: "content.pricing.opportunities.errors.update",
};

type DealStatus = "NEW" | "ACCEPTED" | "DISMISSED";
type DealActionType = "SEND_LEAD" | "COUPON" | "REFERRAL";

type CollaborationDeal = {
  id: string;
  businessId: number;
  title: string;
  description: string;
  partnerType: string;
  actionType: DealActionType;
  estimatedValue: number;
  matchScore: number | null;
  reasonText: string | null;
  priority: number | null;
  sourceType: string | null;
  status: DealStatus;
  createdAt: string;
  updatedAt: string;
};

export default function OpportunitiesPage() {
  const { t } = useI18n();
  const [deals, setDeals] = useState<CollaborationDeal[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  // Fail-safe generation state (F-25 · 4B): when the server cannot tailor
  // recommendations it returns a structured status instead of fabricating deals.
  const [generationNotice, setGenerationNotice] = useState<
    "no_profile" | "incomplete_profile" | "no_matches" | null
  >(null);

  // Auth: this feature calls tenant-scoped APIs that authenticate via the
  // stateless Bearer token (see lib/auth.ts). Read it the same way every other
  // authenticated screen does, and fail closed to /login when it's missing or
  // rejected — never surface a raw server "Unauthorized" as business data.
  const readToken = (): string | null => {
    try {
      return typeof window !== "undefined"
        ? localStorage.getItem("token")
        : null;
    } catch {
      return null;
    }
  };

  const redirectToLogin = () => {
    if (typeof window !== "undefined") {
      window.location.replace(`${window.location.origin}/login`);
    }
  };

  const sortedDeals = useMemo(() => {
    return [...deals].sort((a, b) => {
      const aPriority = a.priority ?? 999999;
      const bPriority = b.priority ?? 999999;

      if (aPriority !== bPriority) {
        return aPriority - bPriority;
      }

      return (
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
    });
  }, [deals]);

  const activeDeals = useMemo(
    () => sortedDeals.filter((deal) => deal.status === "NEW"),
    [sortedDeals]
  );

  const completedDeals = useMemo(
    () => sortedDeals.filter((deal) => deal.status !== "NEW"),
    [sortedDeals]
  );

  const fetchDeals = async () => {
    try {
      setError("");

      const token = readToken();
      if (!token) {
        redirectToLogin();
        return [];
      }

      const res = await fetch("/api/deals", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
        cache: "no-store",
      });

      const outcome = resolveDealsOutcome("fetch", res);
      if (outcome.kind === "unauthorized") {
        redirectToLogin();
        return [];
      }
      if (outcome.kind === "error") {
        throw new Error(outcome.message);
      }

      const data = await res.json();
      const normalizedDeals = Array.isArray(data) ? data : [];
      setDeals(normalizedDeals);
      return normalizedDeals;
    } catch (err) {
      setError(err instanceof Error ? err.message : DEALS_ERROR.fetch);
      return [];
    }
  };

  const generateDeals = async () => {
    try {
      setGenerating(true);
      setError("");
      setGenerationNotice(null);

      const token = readToken();
      if (!token) {
        redirectToLogin();
        return;
      }

      // Business identity (category/subCategory) is derived server-side from the
      // authenticated tenant's BusinessProfile. The client sends NO identity and
      // cannot influence which recommendations are generated (F-25 · 4A).
      const res = await fetch("/api/deals/generate", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      const outcome = resolveDealsOutcome("generate", res);
      if (outcome.kind === "unauthorized") {
        redirectToLogin();
        return;
      }
      if (outcome.kind === "error") {
        throw new Error(outcome.message);
      }

      const data = await res.json();
      if (data?.status === "ok") {
        setDeals(Array.isArray(data.deals) ? data.deals : []);
      } else {
        // Fail-safe: no tailored matches → no fabricated deals, a clear notice.
        setDeals([]);
        setGenerationNotice(
          data?.status === "no_profile" ||
            data?.status === "incomplete_profile"
            ? data.status
            : "no_matches"
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : DEALS_ERROR.generate);
    } finally {
      setGenerating(false);
    }
  };

  const handleAction = async (
    dealId: string,
    action: "ACCEPT" | "DISMISS"
  ) => {
    try {
      setActionLoadingId(dealId);
      setError("");

      const token = readToken();
      if (!token) {
        redirectToLogin();
        return;
      }

      const res = await fetch(`/api/deals/${dealId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ action }),
      });

      const outcome = resolveDealsOutcome("update", res);
      if (outcome.kind === "unauthorized") {
        redirectToLogin();
        return;
      }
      if (outcome.kind === "error") {
        throw new Error(outcome.message);
      }

      const data = await res.json();
      setDeals((prev) =>
        prev.map((deal) => (deal.id === dealId ? data : deal))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : DEALS_ERROR.update);
    } finally {
      setActionLoadingId(null);
    }
  };

  useEffect(() => {
    const run = async () => {
      setLoading(true);
      // Load existing opportunities only. We intentionally do NOT auto-generate
      // on an empty list: generation currently seeds from a hardcoded category
      // (see generateDeals), so auto-running it would surface fabricated matches
      // as real business data. The empty state offers an explicit generate
      // action instead.
      await fetchDeals();
      setLoading(false);
    };

    run();
  }, []);

  // The App Shell owns the page height and the bottom-bar clearance, so this
  // screen no longer forces 100vh on top of it (that guarantees a scroll on a
  // page that fits). Vertical rhythm only — the horizontal gutters now come
  // from PageContainer.
  const pageStyle: React.CSSProperties = {
    background:
      "linear-gradient(180deg, var(--dz-surface-muted) 0%, var(--dz-surface-muted) 50%, var(--dz-surface-muted) 100%)",
    paddingBlock: "20px 40px",
  };

  const headerCardStyle: React.CSSProperties = {
    background: "var(--dz-surface)",
    borderRadius: 24,
    padding: 20,
    boxShadow: "0 10px 30px rgba(52, 60, 50, 0.08)",
    border: "1px solid var(--dz-border)",
    marginBottom: 16,
  };

  const titleStyle: React.CSSProperties = {
    margin: 0,
    fontSize: 28,
    lineHeight: 1.15,
    fontWeight: 800,
    color: "var(--dz-text-primary)",
  };

  const subtitleStyle: React.CSSProperties = {
    margin: "10px 0 0",
    fontSize: 15,
    lineHeight: 1.6,
    color: "var(--dz-text-secondary)",
  };

  const summaryRowStyle: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
    gap: 12,
    marginTop: 18,
  };

  const statCardStyle: React.CSSProperties = {
    background: "var(--dz-surface-muted)",
    border: "1px solid var(--dz-border)",
    borderRadius: 18,
    padding: "14px 12px",
  };

  const statLabelStyle: React.CSSProperties = {
    fontSize: 12,
    color: "var(--dz-text-muted)",
    marginBottom: 6,
    fontWeight: 700,
  };

  const statValueStyle: React.CSSProperties = {
    fontSize: 22,
    color: "var(--dz-text-primary)",
    fontWeight: 800,
  };

  const sectionTitleStyle: React.CSSProperties = {
    margin: "18px 0 12px",
    fontSize: 18,
    fontWeight: 800,
    color: "var(--dz-text-primary)",
  };

  const listStyle: React.CSSProperties = {
    display: "grid",
    gap: 14,
  };

  const cardStyle: React.CSSProperties = {
    background: "var(--dz-surface)",
    borderRadius: 22,
    padding: 18,
    border: "1px solid var(--dz-border)",
    boxShadow: "0 8px 24px rgba(52, 60, 50, 0.06)",
  };

  const topRowStyle: React.CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 12,
    marginBottom: 10,
  };

  const cardTitleStyle: React.CSSProperties = {
    margin: 0,
    fontSize: 18,
    fontWeight: 800,
    lineHeight: 1.3,
    color: "var(--dz-text-primary)",
  };

  const badgeStyle = (status: DealStatus): React.CSSProperties => ({
    padding: "8px 10px",
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 800,
    whiteSpace: "nowrap",
    background:
      status === "NEW"
        ? "var(--dz-info-bg-soft)"
        : status === "ACCEPTED"
        ? "var(--dz-success-bg-soft)"
        : "var(--dz-surface-muted)",
    color:
      status === "NEW"
        ? "var(--dz-brand)"
        : status === "ACCEPTED"
        ? "var(--dz-success)"
        : "var(--dz-text-secondary)",
    border:
      status === "NEW"
        ? "1px solid var(--dz-info-border)"
        : status === "ACCEPTED"
        ? "1px solid var(--dz-success-border)"
        : "1px solid var(--dz-border-strong)",
  });

  const scoreBadgeStyle = (score: number | null): React.CSSProperties => {
    const resolvedScore = score ?? 0;

    if (resolvedScore >= 85) {
      return {
        padding: "7px 10px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 800,
        background: "var(--dz-success-bg-soft)",
        color: "var(--dz-success)",
        border: "1px solid var(--dz-success-border)",
      };
    }

    if (resolvedScore >= 70) {
      return {
        padding: "7px 10px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 800,
        background: "var(--dz-info-bg-soft)",
        color: "var(--dz-info)",
        border: "1px solid var(--dz-info-border)",
      };
    }

    if (score !== null) {
      return {
        padding: "7px 10px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 800,
        background: "var(--dz-warning-bg-soft)",
        color: "var(--dz-danger)",
        border: "1px solid var(--dz-warning-border)",
      };
    }

    return {
      padding: "7px 10px",
      borderRadius: 999,
      fontSize: 12,
      fontWeight: 800,
      background: "var(--dz-surface-muted)",
      color: "var(--dz-text-muted)",
      border: "1px solid var(--dz-border-strong)",
    };
  };

  const descriptionStyle: React.CSSProperties = {
    margin: "0 0 14px",
    fontSize: 14,
    lineHeight: 1.7,
    color: "var(--dz-text-secondary)",
  };

  const metaGridStyle: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
    gap: 10,
    marginBottom: 14,
  };

  const metaCardStyle: React.CSSProperties = {
    background: "var(--dz-surface-muted)",
    border: "1px solid var(--dz-border)",
    borderRadius: 16,
    padding: "12px 10px",
  };

  const metaLabelStyle: React.CSSProperties = {
    fontSize: 11,
    color: "var(--dz-text-muted)",
    fontWeight: 700,
    marginBottom: 5,
  };

  const metaValueStyle: React.CSSProperties = {
    fontSize: 14,
    color: "var(--dz-text-primary)",
    fontWeight: 800,
  };

  const reasonBoxStyle: React.CSSProperties = {
    background: "var(--dz-success-bg-soft)",
    border: "1px solid var(--dz-success-border)",
    color: "var(--dz-success)",
    borderRadius: 16,
    padding: "12px 14px",
    fontSize: 13,
    lineHeight: 1.6,
    marginBottom: 14,
  };

  const legacyInfoBoxStyle: React.CSSProperties = {
    background: "var(--dz-surface-muted)",
    border: "1px solid var(--dz-border-strong)",
    color: "var(--dz-text-secondary)",
    borderRadius: 16,
    padding: "12px 14px",
    fontSize: 13,
    lineHeight: 1.6,
    marginBottom: 14,
  };

  const actionsRowStyle: React.CSSProperties = {
    display: "flex",
    gap: 10,
    flexWrap: "wrap",
  };

  const primaryButtonStyle: React.CSSProperties = {
    border: "none",
    background: TOKEN.action.primary.background,
    color: "var(--dz-text-on-brand)",
    borderRadius: 14,
    padding: "12px 16px",
    fontSize: 14,
    fontWeight: 800,
    cursor: "pointer",
    minWidth: 132,
  };

  const secondaryButtonStyle: React.CSSProperties = {
    border: "1px solid var(--dz-border-strong)",
    background: "var(--dz-surface)",
    color: "var(--dz-text-secondary)",
    borderRadius: 14,
    padding: "12px 16px",
    fontSize: 14,
    fontWeight: 800,
    cursor: "pointer",
    minWidth: 100,
  };

  const emptyStyle: React.CSSProperties = {
    background: "var(--dz-surface)",
    borderRadius: 22,
    padding: 24,
    border: "1px dashed var(--dz-border-strong)",
    textAlign: "center",
    color: "var(--dz-text-secondary)",
  };

  const errorStyle: React.CSSProperties = {
    background: "var(--dz-danger-bg-soft)",
    color: "var(--dz-danger)",
    border: "1px solid var(--dz-danger-border)",
    borderRadius: 16,
    padding: "12px 14px",
    marginBottom: 14,
    fontSize: 14,
    fontWeight: 700,
  };

  const totalEstimatedValue = activeDeals.reduce(
    (sum, deal) => sum + deal.estimatedValue,
    0
  );

  const matchedDealsCount = deals.filter(
    (deal) => deal.sourceType === "RULE_BASED_MATCH"
  ).length;

  // A contract message (Hebrew, see deals-fetch-contract) renders in the active language; any other text as-is.
  const errorText = (message: string) => {
    const call = (Object.keys(DEALS_ERROR) as DealsCall[]).find((c) => DEALS_ERROR[c] === message);
    return call ? t(DEALS_ERROR_KEYS[call]) : message;
  };

  const renderReasonText = (deal: CollaborationDeal) => {
    if (deal.reasonText) {
      return (
        <div style={reasonBoxStyle}>
          <strong>{t("content.pricing.opportunities.whyFits")}</strong>
          <div style={{ marginTop: 6 }}>{deal.reasonText}</div>
        </div>
      );
    }

    return (
      <div style={legacyInfoBoxStyle}>
        {t("content.pricing.opportunities.legacyInfo")}
      </div>
    );
  };

  const renderScoreLabel = (score: number | null) => {
    if (score === null) {
      return t("content.pricing.opportunities.score.none");
    }

    if (score >= 85) {
      return t("content.pricing.opportunities.score.high", { score });
    }

    if (score >= 70) {
      return t("content.pricing.opportunities.score.good", { score });
    }

    return t("content.pricing.opportunities.score.possible", { score });
  };

  return (
    <div style={pageStyle}>
      <style>{`
        @media (min-width: 1200px) {
          .opp-frame { max-width: none !important; padding-inline: 8px; }
          .opp-deals { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; align-items: start; }
        }
      `}</style>
      <PageContainer intent="data" className="opp-frame">
        <div style={headerCardStyle}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <div>
              <h1 style={titleStyle}>{t("content.pricing.opportunities.title")}</h1>
              <p style={subtitleStyle}>
                {t("content.pricing.opportunities.subtitle")}
              </p>
            </div>

            <BackButton />
          </div>

          <div style={summaryRowStyle}>
            <div style={statCardStyle}>
              <div style={statLabelStyle}>{t("content.pricing.opportunities.stats.active")}</div>
              <div style={statValueStyle}>{activeDeals.length}</div>
            </div>

            <div style={statCardStyle}>
              <div style={statLabelStyle}>{t("content.pricing.opportunities.stats.done")}</div>
              <div style={statValueStyle}>{completedDeals.length}</div>
            </div>

            <div style={statCardStyle}>
              <div style={statLabelStyle}>{t("content.pricing.opportunities.stats.potential")}</div>
              <div style={statValueStyle}>₪{totalEstimatedValue}</div>
            </div>

            <div style={statCardStyle}>
              <div style={statLabelStyle}>{t("content.pricing.opportunities.stats.ranked")}</div>
              <div style={statValueStyle}>{matchedDealsCount}</div>
            </div>
          </div>
        </div>

        {error ? <div style={errorStyle}>{errorText(error)}</div> : null}

        {loading ? (
          <div style={emptyStyle}>{t("content.pricing.opportunities.loading")}</div>
        ) : (
          <>
            <h2 style={sectionTitleStyle}>{t("content.pricing.opportunities.rankedActions")}</h2>

            {activeDeals.length === 0 ? (
              <div style={emptyStyle}>
                {generationNotice === "no_profile" ? (
                  <>
                    {t("content.pricing.opportunities.noProfile")}
                    <div style={{ marginTop: 12 }}>
                      <button
                        type="button"
                        onClick={() => {
                          window.location.href = "/onboarding";
                        }}
                        style={primaryButtonStyle}
                      >
                        {t("content.pricing.opportunities.completeProfile")}
                      </button>
                    </div>
                  </>
                ) : generationNotice === "incomplete_profile" ? (
                  <>
                    {t("content.pricing.opportunities.incompleteProfile")}
                    <div style={{ marginTop: 12 }}>
                      <button
                        type="button"
                        onClick={() => {
                          window.location.href = "/onboarding";
                        }}
                        style={primaryButtonStyle}
                      >
                        {t("content.pricing.opportunities.updateProfile")}
                      </button>
                    </div>
                  </>
                ) : generationNotice === "no_matches" ? (
                  <>{t("content.pricing.opportunities.noMatches")}</>
                ) : (
                  <>
                    {t("content.pricing.opportunities.noActions")}
                    <div style={{ marginTop: 12 }}>
                      <button
                        type="button"
                        onClick={generateDeals}
                        disabled={generating}
                        style={{
                          ...primaryButtonStyle,
                          opacity: generating ? 0.7 : 1,
                        }}
                      >
                        {generating ? t("content.pricing.opportunities.generating") : t("content.pricing.opportunities.generate")}
                      </button>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div className="opp-deals" style={listStyle}>
                {activeDeals.map((deal) => (
                  <div key={deal.id} style={cardStyle}>
                    <div style={topRowStyle}>
                      <div style={{ display: "grid", gap: 8 }}>
                        <h3 style={cardTitleStyle}>{deal.title}</h3>
                        <div style={scoreBadgeStyle(deal.matchScore)}>
                          {renderScoreLabel(deal.matchScore)}
                        </div>
                      </div>

                      <div style={badgeStyle(deal.status)}>
                        {deal.status === "NEW" ? t("content.pricing.opportunities.statusNew") : deal.status}
                      </div>
                    </div>

                    <p style={descriptionStyle}>{deal.description}</p>

                    {renderReasonText(deal)}

                    <div style={metaGridStyle}>
                      <div style={metaCardStyle}>
                        <div style={metaLabelStyle}>{t("content.pricing.opportunities.meta.partnerType")}</div>
                        <div style={metaValueStyle}>{deal.partnerType}</div>
                      </div>

                      <div style={metaCardStyle}>
                        <div style={metaLabelStyle}>{t("content.pricing.opportunities.meta.actionType")}</div>
                        <div style={metaValueStyle}>{deal.actionType}</div>
                      </div>

                      <div style={metaCardStyle}>
                        <div style={metaLabelStyle}>{t("content.pricing.opportunities.meta.estimatedValue")}</div>
                        <div style={metaValueStyle}>₪{deal.estimatedValue}</div>
                      </div>

                      <div style={metaCardStyle}>
                        <div style={metaLabelStyle}>{t("content.pricing.opportunities.meta.feedPriority")}</div>
                        <div style={metaValueStyle}>
                          {deal.priority ?? "—"}
                        </div>
                      </div>
                    </div>

                    <div style={actionsRowStyle}>
                      <button
                        type="button"
                        onClick={() => handleAction(deal.id, "ACCEPT")}
                        disabled={actionLoadingId === deal.id}
                        style={{
                          ...primaryButtonStyle,
                          opacity: actionLoadingId === deal.id ? 0.7 : 1,
                        }}
                      >
                        {actionLoadingId === deal.id
                          ? t("content.pricing.opportunities.updating")
                          : t("content.pricing.opportunities.act")}
                      </button>

                      <button
                        type="button"
                        onClick={() => handleAction(deal.id, "DISMISS")}
                        disabled={actionLoadingId === deal.id}
                        style={{
                          ...secondaryButtonStyle,
                          opacity: actionLoadingId === deal.id ? 0.7 : 1,
                        }}
                      >
                        {t("content.pricing.opportunities.dismiss")}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <h2 style={sectionTitleStyle}>{t("content.pricing.opportunities.handledActions")}</h2>

            {completedDeals.length === 0 ? (
              <div style={emptyStyle}>{t("content.pricing.opportunities.noHistory")}</div>
            ) : (
              <div className="opp-deals" style={listStyle}>
                {completedDeals.map((deal) => (
                  <div key={deal.id} style={cardStyle}>
                    <div style={topRowStyle}>
                      <div style={{ display: "grid", gap: 8 }}>
                        <h3 style={cardTitleStyle}>{deal.title}</h3>
                        <div style={scoreBadgeStyle(deal.matchScore)}>
                          {renderScoreLabel(deal.matchScore)}
                        </div>
                      </div>

                      <div style={badgeStyle(deal.status)}>
                        {deal.status === "ACCEPTED" ? t("content.pricing.opportunities.statusAccepted") : t("content.pricing.opportunities.statusDismissed")}
                      </div>
                    </div>

                    <p style={descriptionStyle}>{deal.description}</p>

                    {renderReasonText(deal)}

                    <div style={metaGridStyle}>
                      <div style={metaCardStyle}>
                        <div style={metaLabelStyle}>{t("content.pricing.opportunities.meta.partnerType")}</div>
                        <div style={metaValueStyle}>{deal.partnerType}</div>
                      </div>

                      <div style={metaCardStyle}>
                        <div style={metaLabelStyle}>{t("content.pricing.opportunities.meta.actionType")}</div>
                        <div style={metaValueStyle}>{deal.actionType}</div>
                      </div>

                      <div style={metaCardStyle}>
                        <div style={metaLabelStyle}>{t("content.pricing.opportunities.meta.estimatedValue")}</div>
                        <div style={metaValueStyle}>₪{deal.estimatedValue}</div>
                      </div>

                      <div style={metaCardStyle}>
                        <div style={metaLabelStyle}>{t("content.pricing.opportunities.meta.feedPriority")}</div>
                        <div style={metaValueStyle}>
                          {deal.priority ?? "—"}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </PageContainer>
    </div>
  );
}
