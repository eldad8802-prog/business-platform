import React from "react";
import type { InboxItemViewModel } from "@/lib/inbox-view/inbox-item.types";

type Conversation = {
  id: number;
  channel: string;
  status: string;
  currentStage: string;
  startedAt: string;
};

/** Signals we treat as "no badge" — neutral/empty states should be quiet. */
const QUIET_SIGNALS: ReadonlySet<InboxItemViewModel["primarySignal"]> = new Set([
  "neutral",
  "fresh_lead",
]);

function formatWaitingLine(waitingMinutes: number | null): string | null {
  if (waitingMinutes === null || waitingMinutes <= 0) return null;
  if (waitingMinutes < 60) {
    return `ממתין ${waitingMinutes} דק׳`;
  }
  const hours = Math.floor(waitingMinutes / 60);
  return `ממתין ${hours} שעות`;
}

function resolveTitle(item: InboxItemViewModel): string {
  if (item.customerName && item.customerName.trim().length > 0) {
    return item.customerName.trim();
  }
  if (item.customerPhone && item.customerPhone.trim().length > 0) {
    return item.customerPhone.trim();
  }
  return "לקוח חדש";
}

function shouldShowStage(stageLabel: string, stage: InboxItemViewModel["currentStage"]): boolean {
  if (stage === null || stage === "NEW") return false;
  if (!stageLabel || stageLabel.trim().length === 0) return false;
  if (stageLabel === "חדשה") return false;
  return true;
}

export function ConversationList(props: {
  isMobile: boolean;
  viewMode: "OPEN" | "CLOSED";
  onChangeViewMode: (mode: "OPEN" | "CLOSED") => void;
  onCreateConversation: () => void;
  conversations: Conversation[];
  /** When defined, rows with a matching item use enriched UI; missing per-row match falls back to legacy. */
  items?: InboxItemViewModel[];
  activeConversationId: number | null;
  onSelectConversation: (id: number) => void;
  getStageLabel: (stage: string | null | undefined) => string;
  styles: {
    softButtonStyle: React.CSSProperties;
    accentButtonStyle: React.CSSProperties;
    warmButtonStyle: React.CSSProperties;
  };
}) {
  const {
    isMobile,
    viewMode,
    onChangeViewMode,
    onCreateConversation,
    conversations,
    items,
    activeConversationId,
    onSelectConversation,
    getStageLabel,
    styles,
  } = props;

  return (
    <div
      style={{
        width: isMobile ? "100%" : 320,
        maxWidth: "100%",
        minWidth: 0,
        borderLeft: isMobile ? "none" : "1px solid rgba(15, 23, 42, 0.08)",
        borderBottom: isMobile ? "1px solid rgba(15, 23, 42, 0.08)" : "none",
        padding: isMobile ? 10 : 14,
        boxSizing: "border-box",
        background: "#ffffff",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          paddingBottom: 10,
          marginBottom: 12,
          borderBottom: "1px solid rgba(15, 23, 42, 0.06)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
          <h3 style={{ marginTop: 0, marginBottom: 6, color: "#0f172a" }}>שיחות</h3>
        </div>
        <div style={{ fontSize: 12, color: "#64748b" }}>Inbox עבודה</div>
      </div>

      <div
        style={{
          display: "flex",
          gap: 10,
          marginBottom: 12,
          flexWrap: "wrap",
        }}
      >
        <button
          type="button"
          onClick={() => onChangeViewMode("OPEN")}
          style={{
            ...(viewMode === "OPEN" ? styles.accentButtonStyle : styles.softButtonStyle),
            flex: "1 1 140px",
            minHeight: 42,
            padding: "10px 12px",
            boxShadow: "none",
          }}
        >
          פתוחות
        </button>

        <button
          type="button"
          onClick={() => onChangeViewMode("CLOSED")}
          style={{
            ...(viewMode === "CLOSED" ? styles.warmButtonStyle : styles.softButtonStyle),
            flex: "1 1 140px",
            minHeight: 42,
            padding: "10px 12px",
            boxShadow: "none",
          }}
        >
          סגורות
        </button>
      </div>

      <button
        type="button"
        onClick={onCreateConversation}
        style={{
          ...styles.accentButtonStyle,
          width: "100%",
          marginBottom: 16,
          minHeight: 46,
          fontSize: 16,
          boxShadow: "none",
        }}
      >
        התחל שיחה חדשה
      </button>

      {conversations.length === 0 && (
        <div style={{ color: "#6b7280", padding: "8px 2px" }}>
          {viewMode === "OPEN" ? "אין שיחות פתוחות" : "אין שיחות סגורות"}
        </div>
      )}

      {conversations.map((conversation) => {
        const item =
          items !== undefined
            ? items.find((i) => i.conversationId === conversation.id)
            : undefined;
        const enriched = items !== undefined && item !== undefined;

        return (
          <button
            key={conversation.id}
            type="button"
            onClick={() => onSelectConversation(conversation.id)}
            style={{
              width: "100%",
              display: "block",
              textAlign: "right",
              padding: "10px 12px",
              marginBottom: 6,
              border:
                activeConversationId === conversation.id
                  ? "1px solid rgba(99, 102, 241, 0.35)"
                  : "1px solid rgba(15, 23, 42, 0.06)",
              borderRadius: 12,
              background:
                activeConversationId === conversation.id ? "#eef2ff" : "rgba(248, 250, 252, 0.6)",
              color: "#0f172a",
              cursor: "pointer",
            }}
          >
            {!enriched ? (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                  <div style={{ fontWeight: 700, color: "#0f172a" }}>
                    לקוח חדש
                  </div>
                  <div style={{ fontSize: 11, color: "#94a3b8", whiteSpace: "nowrap" }}>
                    {getStageLabel(conversation.currentStage)}
                  </div>
                </div>

                <div style={{ fontSize: 12, color: "#64748b", marginTop: 4, lineHeight: 1.5 }}>
                  {conversation.channel}
                </div>
              </>
            ) : (
              (() => {
                const title = resolveTitle(item);
                const showStage = shouldShowStage(item.stageLabel, item.currentStage);
                const showSignal = !QUIET_SIGNALS.has(item.primarySignal);
                const showAction = item.suggestedActionLabel.trim().length > 0;
                const waitingLine = formatWaitingLine(item.waitingMinutes);
                const showHotPill = item.temperatureBucket === "hot";
                const snippet = item.lastMessage?.snippet?.trim() ?? "";

                return (
                  <>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                      <div
                        style={{
                          fontWeight: 700,
                          color: "#0f172a",
                          minWidth: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {title}
                      </div>
                      {showStage ? (
                        <div
                          style={{
                            fontSize: 11,
                            color: "#94a3b8",
                            whiteSpace: "nowrap",
                            flexShrink: 0,
                            fontWeight: 500,
                          }}
                        >
                          {item.stageLabel}
                        </div>
                      ) : null}
                    </div>

                    {snippet.length > 0 ? (
                      <div
                        style={{
                          fontSize: 13,
                          color: "#475569",
                          marginTop: 4,
                          lineHeight: 1.45,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {snippet}
                      </div>
                    ) : null}

                    {(showSignal || waitingLine || showHotPill) ? (
                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          gap: 8,
                          alignItems: "center",
                          marginTop: 6,
                          fontSize: 11,
                        }}
                      >
                        {showSignal ? (
                          <span
                            style={{
                              display: "inline-block",
                              padding: "2px 8px",
                              borderRadius: 999,
                              background: "rgba(254, 243, 199, 0.6)",
                              border: "1px solid rgba(245, 158, 11, 0.35)",
                              color: "#92400e",
                              fontWeight: 600,
                            }}
                          >
                            {item.signalLabel}
                          </span>
                        ) : null}
                        {showHotPill ? (
                          <span
                            style={{
                              display: "inline-block",
                              padding: "2px 8px",
                              borderRadius: 999,
                              background: "rgba(254, 226, 226, 0.7)",
                              border: "1px solid rgba(220, 38, 38, 0.35)",
                              color: "#991b1b",
                              fontWeight: 600,
                            }}
                          >
                            חם
                          </span>
                        ) : null}
                        {waitingLine ? (
                          <span
                            style={{
                              color: "#94a3b8",
                              whiteSpace: "nowrap",
                              fontWeight: 500,
                            }}
                          >
                            {waitingLine}
                          </span>
                        ) : null}
                      </div>
                    ) : null}

                    {showAction ? (
                      <div
                        style={{
                          fontSize: 12,
                          color: "#3730a3",
                          marginTop: 6,
                          lineHeight: 1.4,
                          fontWeight: 600,
                        }}
                      >
                        {item.suggestedActionLabel}
                      </div>
                    ) : null}
                  </>
                );
              })()
            )}
          </button>
        );
      })}
    </div>
  );
}
