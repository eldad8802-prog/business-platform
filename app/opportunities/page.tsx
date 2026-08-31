"use client";
import { PageContainer } from "@/components/ui/page-container";

import { useEffect, useMemo, useState } from "react";
import { TOKEN } from "@/lib/design/tokens";
import BackButton from "@/components/ui/back-button";
import { DEALS_ERROR, resolveDealsOutcome } from "./deals-fetch-contract";

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

  const renderReasonText = (deal: CollaborationDeal) => {
    if (deal.reasonText) {
      return (
        <div style={reasonBoxStyle}>
          <strong>למה זה מתאים:</strong>
          <div style={{ marginTop: 6 }}>{deal.reasonText}</div>
        </div>
      );
    }

    return (
      <div style={legacyInfoBoxStyle}>
        הזדמנות זו נוצרה לפני שכבת ההתאמה החדשה, ולכן עדיין אין לה ציון התאמה
        או הסבר מפורט.
      </div>
    );
  };

  const renderScoreLabel = (score: number | null) => {
    if (score === null) {
      return "ללא ציון";
    }

    if (score >= 85) {
      return `התאמה גבוהה • ${score}`;
    }

    if (score >= 70) {
      return `התאמה טובה • ${score}`;
    }

    return `התאמה אפשרית • ${score}`;
  };

  return (
    <div style={pageStyle}>
      <PageContainer intent="data">
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
              <h1 style={titleStyle}>שיתופי פעולה</h1>
              <p style={subtitleStyle}>
                הזדמנויות לפעולה — פעולות עסקיות שהמערכת זיהתה עבורך,
                שיכולות לייצר לך הכנסה נוספת בצורה פשוטה ומהירה.
              </p>
            </div>

            <BackButton href="/app" label="חזרה לבית" />
          </div>

          <div style={summaryRowStyle}>
            <div style={statCardStyle}>
              <div style={statLabelStyle}>הזדמנויות לפעולה</div>
              <div style={statValueStyle}>{activeDeals.length}</div>
            </div>

            <div style={statCardStyle}>
              <div style={statLabelStyle}>פעולות שבוצעו</div>
              <div style={statValueStyle}>{completedDeals.length}</div>
            </div>

            <div style={statCardStyle}>
              <div style={statLabelStyle}>פוטנציאל הכנסה</div>
              <div style={statValueStyle}>₪{totalEstimatedValue}</div>
            </div>

            <div style={statCardStyle}>
              <div style={statLabelStyle}>התאמות מדורגות</div>
              <div style={statValueStyle}>{matchedDealsCount}</div>
            </div>
          </div>
        </div>

        {error ? <div style={errorStyle}>{error}</div> : null}

        {loading ? (
          <div style={emptyStyle}>טוען שיתופי פעולה...</div>
        ) : (
          <>
            <h2 style={sectionTitleStyle}>פעולות מדורגות</h2>

            {activeDeals.length === 0 ? (
              <div style={emptyStyle}>
                {generationNotice === "no_profile" ? (
                  <>
                    כדי לקבל התאמות מותאמות לעסק שלך, יש להשלים תחילה את פרטי
                    העסק.
                    <div style={{ marginTop: 12 }}>
                      <button
                        type="button"
                        onClick={() => {
                          window.location.href = "/onboarding";
                        }}
                        style={primaryButtonStyle}
                      >
                        השלמת פרטי העסק
                      </button>
                    </div>
                  </>
                ) : generationNotice === "incomplete_profile" ? (
                  <>
                    יש להשלים את תחום העסק ותת-התחום בפרטי העסק כדי לקבל התאמות
                    מתאימות.
                    <div style={{ marginTop: 12 }}>
                      <button
                        type="button"
                        onClick={() => {
                          window.location.href = "/onboarding";
                        }}
                        style={primaryButtonStyle}
                      >
                        עדכון פרטי העסק
                      </button>
                    </div>
                  </>
                ) : generationNotice === "no_matches" ? (
                  <>עדיין אין התאמות מתאימות לעסק שלך. נעדכן אותך כשיהיו.</>
                ) : (
                  <>
                    אין כרגע פעולות זמינות.
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
                        {generating ? "מייצר פעולות..." : "צור פעולות חדשות"}
                      </button>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div style={listStyle}>
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
                        {deal.status === "NEW" ? "חדש" : deal.status}
                      </div>
                    </div>

                    <p style={descriptionStyle}>{deal.description}</p>

                    {renderReasonText(deal)}

                    <div style={metaGridStyle}>
                      <div style={metaCardStyle}>
                        <div style={metaLabelStyle}>סוג שותף</div>
                        <div style={metaValueStyle}>{deal.partnerType}</div>
                      </div>

                      <div style={metaCardStyle}>
                        <div style={metaLabelStyle}>סוג פעולה</div>
                        <div style={metaValueStyle}>{deal.actionType}</div>
                      </div>

                      <div style={metaCardStyle}>
                        <div style={metaLabelStyle}>ערך מוערך</div>
                        <div style={metaValueStyle}>₪{deal.estimatedValue}</div>
                      </div>

                      <div style={metaCardStyle}>
                        <div style={metaLabelStyle}>עדיפות בפיד</div>
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
                          ? "מעדכן..."
                          : "בצע פעולה"}
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
                        דחה
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <h2 style={sectionTitleStyle}>פעולות שטופלו</h2>

            {completedDeals.length === 0 ? (
              <div style={emptyStyle}>עדיין אין היסטוריית פעולות.</div>
            ) : (
              <div style={listStyle}>
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
                        {deal.status === "ACCEPTED" ? "התקבל" : "נדחה"}
                      </div>
                    </div>

                    <p style={descriptionStyle}>{deal.description}</p>

                    {renderReasonText(deal)}

                    <div style={metaGridStyle}>
                      <div style={metaCardStyle}>
                        <div style={metaLabelStyle}>סוג שותף</div>
                        <div style={metaValueStyle}>{deal.partnerType}</div>
                      </div>

                      <div style={metaCardStyle}>
                        <div style={metaLabelStyle}>סוג פעולה</div>
                        <div style={metaValueStyle}>{deal.actionType}</div>
                      </div>

                      <div style={metaCardStyle}>
                        <div style={metaLabelStyle}>ערך מוערך</div>
                        <div style={metaValueStyle}>₪{deal.estimatedValue}</div>
                      </div>

                      <div style={metaCardStyle}>
                        <div style={metaLabelStyle}>עדיפות בפיד</div>
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
