import React from "react";

type Message = {
  id: number;
  contentText: string | null;
  senderType: string;
  createdAt: string;
};

type Suggestion = {
  id: number;
  text: string;
  status: string;
  createdAt: string;
};

type Conversation = {
  id: number;
  channel: string;
  status: string;
  currentStage: string;
  startedAt: string;
};

type SmartIndicator = {
  label: string;
  emoji: string;
  color: string;
  border: string;
};

export function ConversationView(props: {
  isMobile: boolean;
  viewMode: "OPEN" | "CLOSED";
  activeConversationId: number | null;
  activeConversation: Conversation | null;
  activeIndicator: SmartIndicator;
  getStageLabel: (stage: string | null | undefined) => string;
  messages: Message[];
  suggestions: Suggestion[];
  selectedSuggestionId: number | null;
  input: string;
  onInputChange: (value: string) => void;
  onCloseConversation: () => void;
  onChooseSuggestion: (s: Suggestion) => void;
  onDismissSuggestion: (suggestionId: number) => void;
  onManualReply: () => void;
  onSendBusinessMessage: () => void;
  onSimulateCustomerMessage: () => void;
  styles: {
    softButtonStyle: React.CSSProperties;
    accentButtonStyle: React.CSSProperties;
    warmButtonStyle: React.CSSProperties;
    dangerButtonStyle: React.CSSProperties;
  };
}) {
  const {
    isMobile,
    viewMode,
    activeConversationId,
    activeConversation,
    activeIndicator,
    getStageLabel,
    messages,
    suggestions,
    selectedSuggestionId,
    input,
    onInputChange,
    onCloseConversation,
    onChooseSuggestion,
    onDismissSuggestion,
    onManualReply,
    onSendBusinessMessage,
    onSimulateCustomerMessage,
    styles,
  } = props;

  const trimmedInput = input.trim();
  const hasDraft = trimmedInput.length > 0;
  const hasSelectedSuggestion = selectedSuggestionId != null;
  const isSuggestionDraft = hasSelectedSuggestion;
  const isManualDraft = !hasSelectedSuggestion && hasDraft;
  const isIdleDraft = !hasSelectedSuggestion && !hasDraft;

  const draftLabel = isSuggestionDraft
    ? "טיוטה פעילה (מבוססת על הצעה)"
    : isManualDraft
      ? "טיוטה פעילה (כתיבה עצמאית)"
      : "טיוטה חדשה";

  return (
    <div
      style={{
        flex: "1 1 420px",
        minWidth: 0,
        padding: isMobile ? 14 : 20,
        boxSizing: "border-box",
        width: "100%",
        maxWidth: "100%",
        overflowX: "hidden",
      }}
    >
      {!activeConversationId && !isMobile && (
        <div
          style={{
            background: "#fff",
            border: "1px solid #e5e7eb",
            borderRadius: 20,
            padding: isMobile ? 16 : 24,
            boxShadow: "0 8px 24px rgba(15, 23, 42, 0.05)",
          }}
        >
          <h2
            style={{
              marginTop: 0,
              wordBreak: "break-word",
              color: "#111827",
            }}
          >
            Inbox
          </h2>
          <div
            style={{
              color: "#4b5563",
              lineHeight: 1.8,
              wordBreak: "break-word",
              fontSize: isMobile ? 18 : 16,
            }}
          >
            {viewMode === "OPEN"
              ? 'בחר שיחה פתוחה קיימת או לחץ על "התחל שיחה חדשה"'
              : "בחר שיחה סגורה לצפייה"}
          </div>
        </div>
      )}

      {activeConversationId && (
        <div>
          {/* Context */}
          <div
            style={{
              background: "#ffffff",
              border: "1px solid rgba(15, 23, 42, 0.08)",
              borderRadius: 14,
              padding: isMobile ? 12 : 14,
              marginBottom: 14,
            }}
          >
            <div
              style={{
                marginBottom: 12,
                paddingBottom: 12,
                borderBottom: "1px solid rgba(15, 23, 42, 0.06)",
                background: "transparent",
                width: "100%",
                boxSizing: "border-box",
                boxShadow: "none",
              }}
            >
              <div
                style={{
                  display: "flex",
                  flexDirection: isMobile ? "column" : "row",
                  justifyContent: "space-between",
                  alignItems: isMobile ? "stretch" : "center",
                  gap: 12,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <h2
                    style={{
                      margin: 0,
                      wordBreak: "break-word",
                      color: "#111827",
                      fontSize: 18,
                    }}
                  >
                    שיחה
                  </h2>

                  <div style={{ fontSize: 13, color: "#64748b", marginTop: 6 }}>
                    #{activeConversation?.id} • {activeConversation?.channel} •{" "}
                    {activeConversation?.status} • {getStageLabel(activeConversation?.currentStage)}
                  </div>

                  {activeConversation?.status === "OPEN" && (
                    <div style={{ marginTop: 12 }}>
                      <button
                        type="button"
                        onClick={onCloseConversation}
                        style={styles.dangerButtonStyle}
                      >
                        סגור שיחה
                      </button>
                    </div>
                  )}
                </div>

                <div
                  style={{
                    padding: "8px 12px",
                    borderRadius: 999,
                    border: "1px solid rgba(15, 23, 42, 0.10)",
                    color: "#0f172a",
                    fontWeight: 700,
                    background: "#f8fafc",
                    whiteSpace: "nowrap",
                    maxWidth: "100%",
                    alignSelf: isMobile ? "flex-start" : "center",
                    fontSize: 12,
                  }}
                >
                  {activeIndicator.emoji} {activeIndicator.label}
                </div>
              </div>
            </div>

            <div>
              <h4 style={{ marginTop: 0, marginBottom: 10, color: "#111827" }}>הודעות</h4>

              {messages.length === 0 && (
                <div style={{ color: "#6b7280" }}>אין הודעות בשיחה הזו</div>
              )}

              {messages.map((msg) => (
                <div
                  key={msg.id}
                  style={{
                    padding: "10px 0",
                    marginBottom: 0,
                    borderBottom: "1px solid rgba(15, 23, 42, 0.06)",
                    borderRadius: 0,
                    background: "transparent",
                    width: "100%",
                    boxSizing: "border-box",
                    overflowWrap: "anywhere",
                    wordBreak: "break-word",
                  }}
                >
                  <div style={{ fontSize: 12, color: "#64748b", marginBottom: 4 }}>
                    {msg.senderType}
                  </div>
                  <div style={{ color: "#0f172a", lineHeight: 1.7 }}>{msg.contentText}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Action Dock */}
          <div
            style={{
              background: "rgba(248, 250, 252, 0.9)",
              border: "1px solid rgba(15, 23, 42, 0.10)",
              borderRadius: 14,
              padding: isMobile ? 12 : 14,
            }}
          >
            <div style={{ marginBottom: 16 }}>
              <h4 style={{ marginTop: 0, marginBottom: 10, color: "#111827" }}>פעולות חכמות</h4>

              {isIdleDraft && (
                <div style={{ color: "#6b7280", marginTop: 6, marginBottom: 10 }}>
                  בחר הצעה כדי להתחיל, או כתוב מענה עצמאי למטה.
                </div>
              )}

              {suggestions.length === 0 && (
                <div style={{ color: "#6b7280" }}>אין הצעות כרגע</div>
              )}

              {suggestions.map((s) => {
                const isActive = selectedSuggestionId === s.id;
                const isDimmed = hasSelectedSuggestion && !isActive;

                return (
                  <div
                    key={s.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => onChooseSuggestion(s)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onChooseSuggestion(s);
                      }
                    }}
                    style={{
                      border: "1px solid rgba(15, 23, 42, 0.08)",
                      borderRadius: 12,
                      background: isActive ? "#eef2ff" : "#ffffff",
                      padding: "10px 12px",
                      marginBottom: 8,
                      width: "100%",
                      boxSizing: "border-box",
                      overflowX: "hidden",
                      boxShadow: "none",
                      cursor: "pointer",
                      opacity: isDimmed ? 0.55 : 1,
                    }}
                  >
                    {isActive && (
                      <div
                        style={{
                          display: "inline-block",
                          marginBottom: 8,
                          padding: "4px 8px",
                          borderRadius: 999,
                          background: "#e0e7ff",
                          border: "1px solid rgba(99, 102, 241, 0.35)",
                          color: "#3730a3",
                          fontWeight: 800,
                          fontSize: 12,
                        }}
                      >
                        טיוטה פעילה
                      </div>
                    )}

                    <div
                      style={{
                        marginBottom: 10,
                        overflowWrap: "anywhere",
                        wordBreak: "break-word",
                        color: "#0f172a",
                        lineHeight: 1.6,
                      }}
                    >
                      {s.text}
                    </div>

                    <div
                      style={{
                        display: "flex",
                        gap: 8,
                        flexWrap: "wrap",
                      }}
                    >
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onChooseSuggestion(s);
                        }}
                        style={{
                          ...styles.accentButtonStyle,
                          flex: "1 1 140px",
                          minHeight: 38,
                          padding: "10px 12px",
                          boxShadow: "none",
                        }}
                      >
                        בחר
                      </button>

                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDismissSuggestion(s.id);
                        }}
                        style={{
                          ...styles.softButtonStyle,
                          flex: "1 1 140px",
                          minHeight: 38,
                          padding: "10px 12px",
                          boxShadow: "none",
                        }}
                      >
                        דלג
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            {activeConversation?.status === "OPEN" && (
              <div
                style={{
                  background: "#ffffff",
                  border: "1px solid rgba(15, 23, 42, 0.10)",
                  borderRadius: 14,
                  padding: isMobile ? 12 : 14,
                  boxShadow: "none",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <h4 style={{ marginTop: 0, marginBottom: 8, color: "#111827" }}>
                    {draftLabel}
                  </h4>

                  {(hasDraft || hasSelectedSuggestion) && (
                    <button
                      type="button"
                      onClick={onManualReply}
                      style={{
                        ...styles.softButtonStyle,
                        minHeight: 40,
                        padding: "10px 12px",
                        boxShadow: "none",
                      }}
                    >
                      נקה טיוטה
                    </button>
                  )}
                </div>

                <textarea
                  value={input}
                  onChange={(e) => onInputChange(e.target.value)}
                  style={{
                    width: "100%",
                    maxWidth: "100%",
                    height: hasDraft || hasSelectedSuggestion ? 180 : 90,
                    padding: 12,
                    boxSizing: "border-box",
                    borderRadius: 12,
                    border: "1px solid rgba(15, 23, 42, 0.14)",
                    resize: "vertical",
                    fontFamily: "inherit",
                    fontSize: 16,
                    outline: "none",
                    color: "#111827",
                    background: "#ffffff",
                    WebkitAppearance: "none",
                    appearance: "none",
                    pointerEvents: "auto",
                  }}
                  placeholder={
                    isIdleDraft
                      ? "כתוב כאן מענה... או בחר הצעה כדי להתחיל"
                      : "ערוך את הטיוטה כאן לפני שליחה"
                  }
                />

                <div
                  style={{
                    display: "flex",
                    gap: 10,
                    marginTop: 14,
                    flexWrap: "wrap",
                  }}
                >
                  <button
                    type="button"
                    onClick={onSendBusinessMessage}
                    style={{
                      ...styles.accentButtonStyle,
                      flex: "1 1 180px",
                      boxShadow: "none",
                    }}
                  >
                    שלח כבעל עסק
                  </button>

                  <button
                    type="button"
                    onClick={onManualReply}
                    style={{
                      ...styles.softButtonStyle,
                      flex: "1 1 180px",
                      boxShadow: "none",
                    }}
                  >
                    נקה למענה עצמאי
                  </button>
                </div>

                {process.env.NODE_ENV === "development" && (
                  <div style={{ marginTop: 12 }}>
                    <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 8 }}>
                      כלי בדיקה
                    </div>
                    <button
                      type="button"
                      onClick={onSimulateCustomerMessage}
                      style={{
                        ...styles.softButtonStyle,
                        minHeight: 40,
                        padding: "10px 12px",
                        boxShadow: "none",
                      }}
                    >
                      סימולציה: שלח כלקוח
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

