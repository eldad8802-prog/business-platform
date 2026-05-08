"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type AttentionItem = {
  conversationId: number;
  customerName: string | null;
  channel: string;
  status: string;
  currentStage: string | null;
  lastRelevantMessageText: string | null;
  reasonCode: string;
  reasonText: string;
  relevantAt: string;
  createdAt: string;
  primaryAction: string;
  hasPendingSuggestion: boolean;
  priorityRank: number;
  priorityType: string;
};

type AttentionResponse = {
  success: boolean;
  generatedAt: string;
  businessId: number;
  waitingForReply: AttentionItem[];
  pendingSmartSuggestion: AttentionItem[];
  recentlyHandled: AttentionItem[];
};

function channelLabel(channel: string): string {
  const map: Record<string, string> = {
    WHATSAPP: "וואטסאפ",
    INSTAGRAM: "אינסטגרם",
    FACEBOOK: "פייסבוק",
    EMAIL: "אימייל",
    PHONE: "טלפון",
    OTHER: "אחר",
  };
  return map[channel] ?? channel;
}

function formatWhen(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
      return "";
    }
    const now = new Date();
    const sameDay =
      d.getDate() === now.getDate() &&
      d.getMonth() === now.getMonth() &&
      d.getFullYear() === now.getFullYear();
    if (sameDay) {
      return d.toLocaleTimeString("he-IL", {
        hour: "2-digit",
        minute: "2-digit",
      });
    }
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
    return "כדי לראות את הרשימה צריך להיות מחובר. נסה לרענן או להתחבר שוב.";
  }
  if (status === 403) {
    return "אין גישה לרשימה הזו.";
  }
  if (status >= 500) {
    return "אירעה תקלה בטעינה. נסה שוב בעוד רגע.";
  }
  return "לא הצלחנו לטעון את הרשימה. נסה שוב בעוד רגע.";
}

function cardSnippet(item: AttentionItem): string {
  const fromMsg = item.lastRelevantMessageText?.trim();
  if (fromMsg) {
    return fromMsg;
  }
  return item.reasonText;
}

function showReasonSubline(item: AttentionItem): boolean {
  return Boolean(item.lastRelevantMessageText?.trim());
}

export default function AttentionPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<AttentionResponse | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const raw = typeof window !== "undefined" ? localStorage.getItem("token") : null;
      if (!raw) {
        setError("יש להתחבר כדי לראות את הרשימה.");
        setLoading(false);
        return;
      }
      const token = raw;

      try {
        const res = await fetch("/api/inbox/attention", {
          cache: "no-store",
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        let json: unknown = null;
        try {
          json = await res.json();
        } catch {
          json = null;
        }

        if (cancelled) {
          return;
        }

        if (!res.ok) {
          setError(friendlyHttpMessage(res.status));
          setData(null);
          return;
        }

        setError(null);
        setData(json as AttentionResponse);
      } catch (e) {
        if (!cancelled) {
          setError(
            "לא הצלחנו להגיע לשרת. בדוק את החיבור ונסה שוב."
          );
          setData(null);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const waiting = data?.waitingForReply ?? [];
  const pending = data?.pendingSmartSuggestion ?? [];
  const handled = data?.recentlyHandled ?? [];
  const allEmpty =
    !loading &&
    !error &&
    waiting.length === 0 &&
    pending.length === 0 &&
    handled.length === 0;

  const cardShell: React.CSSProperties = {
    width: "100%",
    textAlign: "right",
    padding: "18px 18px 16px",
    marginBottom: 12,
    borderRadius: 16,
    border: "1px solid rgba(15, 23, 42, 0.06)",
    background: "#ffffff",
    cursor: "pointer",
    boxSizing: "border-box",
    WebkitTapHighlightColor: "transparent",
    touchAction: "manipulation",
    boxShadow: "0 1px 2px rgba(15, 23, 42, 0.04), 0 1px 6px rgba(15, 23, 42, 0.03)",
  };

  const sectionTitle: React.CSSProperties = {
    margin: "0 0 14px 0",
    fontSize: 15,
    fontWeight: 600,
    color: "#1e293b",
    letterSpacing: "0.02em",
  };

  const reasonSubline: React.CSSProperties = {
    fontSize: 12,
    color: "#94a3b8",
    marginTop: 8,
    lineHeight: 1.5,
  };

  function AttentionCard({ item }: { item: AttentionItem }) {
    const title =
      item.customerName?.trim() || "שיחה ללא שם";
    const snippet = cardSnippet(item);
    const when = formatWhen(item.relevantAt);
    const channel = channelLabel(item.channel);

    return (
      <button
        type="button"
        className="attention-card-btn"
        onClick={() =>
          router.push(`/inbox?conversationId=${item.conversationId}`)
        }
        style={cardShell}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 10,
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              style={{
                fontWeight: 700,
                color: "#0f172a",
                fontSize: 16,
                lineHeight: 1.35,
                wordBreak: "break-word",
              }}
            >
              {title}
            </div>
            {item.hasPendingSuggestion && (
              <span
                style={{
                  display: "inline-block",
                  marginTop: 6,
                  fontSize: 10,
                  fontWeight: 500,
                  color: "#64748b",
                  padding: "3px 8px",
                  borderRadius: 6,
                  border: "1px solid rgba(15, 23, 42, 0.06)",
                  background: "rgba(248, 250, 252, 0.9)",
                }}
              >
                טיוטת הצעה
              </span>
            )}
          </div>
        </div>

        <div
          style={{
            fontSize: 14,
            fontWeight: 400,
            color: "#475569",
            marginTop: 12,
            lineHeight: 1.55,
            wordBreak: "break-word",
          }}
        >
          {snippet}
        </div>

        {showReasonSubline(item) && (
          <div style={{ ...reasonSubline, marginTop: 10 }}>
            <span>{item.reasonText}</span>
          </div>
        )}

        <div
          style={{
            marginTop: 14,
            paddingTop: 12,
            borderTop: "1px solid rgba(15, 23, 42, 0.05)",
            fontSize: 11,
            color: "#94a3b8",
            lineHeight: 1.45,
          }}
        >
          {channel}
          {when ? ` · ${when}` : ""}
        </div>
      </button>
    );
  }

  return (
    <div
      style={{
        direction: "rtl",
        minHeight: "100vh",
        background: "#f1f5f9",
        padding: "12px 0 36px",
        boxSizing: "border-box",
        maxWidth: "100%",
        overflowX: "hidden",
      }}
    >
      <style
        dangerouslySetInnerHTML={{
          __html: `
            button.attention-card-btn:hover {
              box-shadow: 0 2px 8px rgba(15, 23, 42, 0.07);
              border-color: rgba(15, 23, 42, 0.09);
            }
            button.attention-card-btn:focus-visible {
              outline: 2px solid rgba(100, 116, 139, 0.35);
              outline-offset: 2px;
            }
          `,
        }}
      />
      <div
        style={{
          width: "100%",
          maxWidth: 640,
          margin: "0 auto",
          padding: "8px 18px 12px",
          boxSizing: "border-box",
        }}
      >
      <header style={{ marginBottom: 28, paddingTop: 8 }}>
        <h1
          style={{
            margin: "0 0 10px 0",
            fontSize: 21,
            fontWeight: 700,
            color: "#0f172a",
            letterSpacing: "-0.02em",
          }}
        >
          דורש תשומת לב
        </h1>
        <p style={{ margin: 0, fontSize: 14, color: "#64748b", lineHeight: 1.65 }}>
          ריכוז קצר של מה שמחכה לטיפול — אתה בוחר מתי לענות.
        </p>
      </header>

      {loading && (
        <div
          style={{
            padding: "28px 8px",
            textAlign: "center",
            color: "#94a3b8",
            fontSize: 14,
          }}
        >
          טוענים את הרשימה…
        </div>
      )}

      {!loading && error && (
        <div
          style={{
            padding: "18px 18px",
            borderRadius: 16,
            border: "1px solid rgba(180, 83, 9, 0.18)",
            background: "#fffbeb",
            color: "#92400e",
            fontSize: 14,
            lineHeight: 1.65,
            boxShadow: "0 1px 3px rgba(15, 23, 42, 0.04)",
          }}
        >
          {error}
        </div>
      )}

      {!loading && !error && allEmpty && (
        <div
          style={{
            padding: "32px 20px",
            textAlign: "center",
            borderRadius: 16,
            border: "1px solid rgba(15, 23, 42, 0.06)",
            background: "#ffffff",
            color: "#64748b",
            fontSize: 15,
            lineHeight: 1.7,
            boxShadow: "0 1px 3px rgba(15, 23, 42, 0.04)",
          }}
        >
          נראה שאין כרגע משהו דחוף.
          <div style={{ marginTop: 10, fontSize: 13, color: "#94a3b8" }}>
            כשמשהו יצטרך אותך, הוא יופיע כאן.
          </div>
        </div>
      )}

      {!loading && !error && data && !allEmpty && (
        <>
          <section
            style={{
              paddingBottom: 26,
              marginBottom: 26,
              borderBottom: "1px solid rgba(15, 23, 42, 0.06)",
            }}
          >
            <h2 style={sectionTitle}>ממתין לתשובה</h2>
            {waiting.length === 0 ? (
              <div style={{ fontSize: 13, color: "#94a3b8", padding: "4px 0" }}>
                אין כאן כרגע ממתינים לתשובה.
              </div>
            ) : (
              waiting.map((item) => (
                <AttentionCard key={`w-${item.conversationId}`} item={item} />
              ))
            )}
          </section>

          <section
            style={{
              paddingBottom: 26,
              marginBottom: 26,
              borderBottom: "1px solid rgba(15, 23, 42, 0.06)",
            }}
          >
            <h2 style={sectionTitle}>הצעה חכמה ממתינה</h2>
            {pending.length === 0 ? (
              <div style={{ fontSize: 13, color: "#94a3b8", padding: "4px 0" }}>
                אין כאן טיוטות הצעה פתוחות.
              </div>
            ) : (
              pending.map((item) => (
                <AttentionCard key={`p-${item.conversationId}`} item={item} />
              ))
            )}
          </section>

          <section style={{ paddingBottom: 4, marginBottom: 0 }}>
            <h2 style={sectionTitle}>טופל לאחרונה</h2>
            {handled.length === 0 ? (
              <div style={{ fontSize: 13, color: "#94a3b8", padding: "4px 0" }}>
                אין כאן סגירות אחרונות להצגה.
              </div>
            ) : (
              handled.map((item) => (
                <AttentionCard key={`h-${item.conversationId}`} item={item} />
              ))
            )}
          </section>
        </>
      )}
      </div>
    </div>
  );
}
