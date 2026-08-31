"use client";
import { PageContainer } from "@/components/ui/page-container";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import type {
  BusinessStatusItem,
  BusinessStatusSnapshot,
  PaperworkInsightPayload,
  Severity,
} from "@/lib/business-status/types";

function domainLabel(domain: BusinessStatusItem["domain"]): string {
  switch (domain) {
    case "inbox":
      return "תיבה";
    case "documents":
      return "מסמכים";
    case "inventory":
      return "מלאי";
    case "billing":
      return "חשבוניות";
    case "supplier":
      return "רכש ספקים";
    default:
      return domain;
  }
}

function severityBadge(severity: Severity): {
  label: string;
  bg: string;
  color: string;
  border: string;
  weight: number;
} {
  switch (severity) {
    case "CRITICAL":
      return {
        label: "קריטי",
        bg: "var(--dz-danger-bg-soft)",
        color: "var(--dz-danger)",
        border: "rgba(155, 70, 52, 0.22)",
        weight: 700,
      };
    case "HIGH":
      return {
        label: "גבוה",
        bg: "var(--dz-warning-bg-soft)",
        color: "var(--dz-warning)",
        border: "rgba(129, 90, 50, 0.22)",
        weight: 700,
      };
    case "MEDIUM":
      return {
        label: "בינוני",
        bg: "var(--dz-surface-muted)",
        color: "var(--dz-text-secondary)",
        border: "rgba(52, 60, 50, 0.1)",
        weight: 600,
      };
    case "LOW":
      return {
        label: "נמוך",
        bg: "var(--dz-surface-muted)",
        color: "var(--dz-text-muted)",
        border: "rgba(52, 60, 50, 0.06)",
        weight: 500,
      };
    case "INFO":
      return {
        label: "מידע",
        bg: "var(--dz-surface-muted)",
        color: "var(--dz-text-muted)",
        border: "rgba(52, 60, 50, 0.05)",
        weight: 500,
      };
    default:
      return {
        label: severity,
        bg: "var(--dz-surface-muted)",
        color: "var(--dz-text-muted)",
        border: "rgba(52, 60, 50, 0.06)",
        weight: 500,
      };
  }
}

function formatCreated(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString("he-IL", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function friendlyHttpMessage(status: number): string {
  if (status === 401) {
    return "כדי לראות את הרשימה צריך להיות מחובר.";
  }
  if (status === 403) {
    return "אין גישה.";
  }
  if (status >= 500) {
    return "אירעה תקלה בטעינה. נסה שוב בעוד רגע.";
  }
  return "לא הצלחנו לטעון. נסה שוב בעוד רגע.";
}

function formatSnapshotTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString("he-IL", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export default function AttentionPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<BusinessStatusSnapshot | null>(
    null
  );

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const raw =
        typeof window !== "undefined" ? localStorage.getItem("token") : null;
      if (!raw) {
        setError("יש להתחבר כדי לראות את הרשימה.");
        setLoading(false);
        return;
      }

      try {
        const res = await fetch("/api/business-status", {
          cache: "no-store",
          headers: {
            Authorization: `Bearer ${raw}`,
          },
        });

        let json: unknown = null;
        try {
          json = await res.json();
        } catch {
          json = null;
        }

        if (cancelled) return;

        if (!res.ok) {
          setError(friendlyHttpMessage(res.status));
          setSnapshot(null);
          return;
        }

        setError(null);
        setSnapshot(json as BusinessStatusSnapshot);
      } catch {
        if (!cancelled) {
          setError("לא הצלחנו להגיע לשרת. בדוק את החיבור ונסה שוב.");
          setSnapshot(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const items = snapshot?.items ?? [];
  const isEmpty = !loading && !error && items.length === 0;
  const snapshotLabel = snapshot?.generatedAt
    ? formatSnapshotTime(snapshot.generatedAt)
    : "";
  const paperworkInsight: PaperworkInsightPayload | null | undefined =
    snapshot?.paperworkInsight ?? undefined;

  function navigateTo(href: string) {
    router.push(href);
  }

  return (
    <div
      style={{
        direction: "rtl",
        minHeight: "100vh",
        background: "var(--dz-surface-muted)",
        padding: "12px 0 40px",
        boxSizing: "border-box",
        maxWidth: "100%",
        overflowX: "hidden",
      }}
    >
      {/*
        The follow-up queue is a worklist: `data` intent, not a 640 column.
        The outer div keeps the surface background and the overflow guard;
        PageContainer owns the width and the responsive gutters.
      */}
      <PageContainer intent="data" as="div" style={{ paddingBlock: "8px 12px" }}>
        <header style={{ marginBottom: 24, paddingTop: 6 }}>
          <h1
            style={{
              margin: "0 0 8px 0",
              fontSize: 22,
              fontWeight: 700,
              color: "var(--dz-text-primary)",
              letterSpacing: "-0.02em",
              lineHeight: 1.25,
            }}
          >
            דורש תשומת לב
          </h1>
          <p
            style={{
              margin: 0,
              fontSize: 15,
              color: "var(--dz-text-muted)",
              lineHeight: 1.6,
            }}
          >
            דברים שדורשים טיפול או החלטה עכשיו.
          </p>
          {snapshotLabel ? (
            <p
              style={{
                margin: "10px 0 0",
                fontSize: 12,
                color: "var(--dz-text-muted)",
              }}
            >
              עודכן {snapshotLabel}
            </p>
          ) : null}
        </header>

        {!loading &&
          !error &&
          paperworkInsight &&
          paperworkInsight.evidenceLines?.length === 2 && (
            <PaperworkObservation
              insight={paperworkInsight}
              onOpenDocuments={() =>
                navigateTo(paperworkInsight.ctaHref)
              }
            />
          )}

        {loading && (
          <div
            style={{
              padding: "32px 12px",
              textAlign: "center",
              color: "var(--dz-text-muted)",
              fontSize: 15,
            }}
          >
            טוען…
          </div>
        )}

        {!loading && error && (
          <div
            style={{
              padding: "18px 16px",
              borderRadius: 14,
              border: "1px solid rgba(129, 90, 50, 0.2)",
              background: "var(--dz-warning-bg-soft)",
              color: "var(--dz-warning)",
              fontSize: 14,
              lineHeight: 1.65,
            }}
          >
            {error}
          </div>
        )}

        {!loading && !error && isEmpty && (
          <div
            style={{
              padding: "36px 22px",
              textAlign: "center",
              borderRadius: 14,
              border: "1px solid rgba(52, 60, 50, 0.06)",
              background: "var(--dz-surface)",
              color: "var(--dz-text-muted)",
              fontSize: 16,
              lineHeight: 1.65,
              boxShadow: "0 1px 2px rgba(52, 60, 50, 0.04)",
            }}
          >
            כרגע אין דברים שדורשים טיפול.
          </div>
        )}

        {!loading && !error && !isEmpty && (
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
            }}
          >
            {items.map((item) => (
              <li key={item.itemId} style={{ marginBottom: 12 }}>
                <StatusCard
                  item={item}
                  onOpen={() => navigateTo(item.primaryAction.href)}
                />
              </li>
            ))}
          </ul>
        )}
      </PageContainer>
    </div>
  );
}

function PaperworkObservation({
  insight,
  onOpenDocuments,
}: {
  insight: PaperworkInsightPayload;
  onOpenDocuments: () => void;
}) {
  return (
    <section
      aria-label="תצפית מערכת"
      style={{
        marginBottom: 28,
        padding: "20px 18px 18px",
        borderRadius: 16,
        background: "rgba(239, 241, 235, 0.95)",
        boxSizing: "border-box",
      }}
    >
      <p
        style={{
          margin: "0 0 12px 0",
          fontSize: 12,
          fontWeight: 600,
          color: "var(--dz-text-muted)",
        }}
      >
        שמים לב
      </p>
      <h2
        style={{
          margin: "0 0 10px 0",
          fontSize: 17,
          fontWeight: 600,
          color: "var(--dz-text-primary)",
          lineHeight: 1.35,
        }}
      >
        {insight.title}
      </h2>
      <p
        style={{
          margin: "0 0 16px 0",
          fontSize: 14,
          color: "var(--dz-text-muted)",
          lineHeight: 1.65,
        }}
      >
        {insight.explanation}
      </p>
      <ul
        style={{
          margin: "0 0 18px 0",
          padding: "0 18px 0 0",
          fontSize: 14,
          color: "var(--dz-text-secondary)",
          lineHeight: 1.7,
        }}
      >
        <li style={{ marginBottom: 6 }}>{insight.evidenceLines[0]}</li>
        <li>{insight.evidenceLines[1]}</li>
      </ul>
      <button
        type="button"
        onClick={onOpenDocuments}
        style={{
          padding: "12px 16px",
          fontSize: 15,
          fontWeight: 600,
          color: "var(--dz-info)",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          paddingInlineStart: 0,
          WebkitTapHighlightColor: "transparent",
        }}
      >
        {insight.ctaLabel}
      </button>
    </section>
  );
}

function StatusCard({
  item,
  onOpen,
}: {
  item: BusinessStatusItem;
  onOpen: () => void;
}) {
  const badge = severityBadge(item.severity);
  const domain = domainLabel(item.domain);
  const created = formatCreated(item.createdAt);
  const isStrong =
    item.severity === "CRITICAL" || item.severity === "HIGH";

  return (
    <button
      type="button"
      onClick={onOpen}
      style={{
        width: "100%",
        textAlign: "right",
        padding: "16px 16px 14px",
        borderRadius: 14,
        border: isStrong
          ? `1px solid ${badge.border}`
          : "1px solid rgba(52, 60, 50, 0.06)",
        background: "var(--dz-surface)",
        cursor: "pointer",
        boxSizing: "border-box",
        WebkitTapHighlightColor: "transparent",
        touchAction: "manipulation",
        boxShadow: isStrong
          ? "0 1px 4px rgba(52, 60, 50, 0.06)"
          : "0 1px 2px rgba(52, 60, 50, 0.04)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 10,
          marginBottom: 8,
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontWeight: 700,
              fontSize: 16,
              color: "var(--dz-text-primary)",
              lineHeight: 1.35,
              wordBreak: "break-word",
            }}
          >
            {item.title}
          </div>
        </div>
        <span
          style={{
            flexShrink: 0,
            fontSize: 11,
            fontWeight: badge.weight,
            padding: "4px 8px",
            borderRadius: 8,
            background: badge.bg,
            color: badge.color,
            border: `1px solid ${badge.border}`,
          }}
        >
          {badge.label}
        </span>
      </div>

      <div
        style={{
          fontSize: 11,
          color: "var(--dz-text-muted)",
          marginBottom: item.summary ? 10 : 6,
        }}
      >
        {domain}
        {created ? ` · ${created}` : ""}
      </div>

      {item.summary ? (
        <div
          style={{
            fontSize: 14,
            color: "var(--dz-text-secondary)",
            lineHeight: 1.55,
            wordBreak: "break-word",
            marginBottom: 14,
          }}
        >
          {item.summary}
        </div>
      ) : null}

      <div
        style={{
          display: "flex",
          justifyContent: "flex-start",
        }}
      >
        <span
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: "var(--dz-info)",
          }}
        >
          {item.primaryAction.label}
        </span>
      </div>
    </button>
  );
}
