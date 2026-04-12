"use client";

import { useEffect, useMemo, useState } from "react";

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

function getStageLabel(stage: string | null | undefined) {
  if (!stage) return "לא ידוע";
  if (stage === "early") return "התחלה";
  if (stage === "middle") return "אמצע";
  if (stage === "closing") return "סגירה";
  return stage;
}

function getSmartIndicator(params: {
  currentStage: string | null | undefined;
  messages?: Message[];
  suggestions?: Suggestion[];
}): SmartIndicator {
  const { currentStage, messages = [], suggestions = [] } = params;

  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;

  const hasPendingSuggestions = suggestions.some(
    (s) => s.status === "GENERATED"
  );

  if (hasPendingSuggestions) {
    return {
      label: "דורש תגובה",
      emoji: "🔥",
      color: "#b45309",
      border: "#f59e0b",
    };
  }

  if (lastMessage?.senderType === "CUSTOMER") {
    return {
      label: "ממתין לבעל העסק",
      emoji: "⏳",
      color: "#1d4ed8",
      border: "#60a5fa",
    };
  }

  if (currentStage === "closing") {
    return {
      label: "שיחה מתקדמת",
      emoji: "⚡",
      color: "#166534",
      border: "#4ade80",
    };
  }

  if (currentStage === "middle") {
    return {
      label: "שיחה פעילה",
      emoji: "💬",
      color: "#7c3aed",
      border: "#a78bfa",
    };
  }

  return {
    label: "שיחה חדשה",
    emoji: "🆕",
    color: "#374151",
    border: "#d1d5db",
  };
}

export default function InboxPage() {
  const token = "1";

  const [viewMode, setViewMode] = useState<"OPEN" | "CLOSED">("OPEN");

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<number | null>(null);

  const [messages, setMessages] = useState<Message[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);

  const [input, setInput] = useState("");
  const [selectedSuggestionId, setSelectedSuggestionId] = useState<number | null>(null);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    function handleResize() {
      setIsMobile(window.innerWidth <= 768);
    }

    handleResize();
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  async function loadConversations() {
    try {
      const res = await fetch("/api/conversations", {
        cache: "no-store",
        headers: {
          Authorization: token,
        },
      });

      let data: any = null;

      try {
        data = await res.json();
      } catch (e) {
        console.error("Invalid conversations JSON response", e);
        setConversations([]);
        return;
      }

      if (!res.ok) {
        console.error("Failed to load conversations", data);
        setConversations([]);
        return;
      }

      const all = data.conversations || [];
      const filtered = all.filter(
        (conversation: Conversation) => conversation.status === viewMode
      );

      setConversations(filtered);

      if (
        activeConversationId &&
        !filtered.some((conversation: Conversation) => conversation.id === activeConversationId)
      ) {
        setActiveConversationId(null);
        setMessages([]);
        setSuggestions([]);
        setInput("");
        setSelectedSuggestionId(null);
      }
    } catch (error) {
      console.error("loadConversations error", error);
      setConversations([]);
    }
  }

  async function loadMessages(conversationId: number) {
    if (!conversationId) {
      setMessages([]);
      setSuggestions([]);
      return;
    }

    try {
      const res = await fetch(`/api/message?conversationId=${conversationId}`, {
        cache: "no-store",
        headers: {
          Authorization: token,
        },
      });

      let data: any = null;

      try {
        data = await res.json();
      } catch (e) {
        console.error("Invalid messages JSON response", e);
        setMessages([]);
        setSuggestions([]);
        return;
      }

      if (!res.ok) {
        console.error("Failed to load messages", data);
        setMessages([]);
        setSuggestions([]);
        return;
      }

      setMessages(data.messages || []);
      setSuggestions(data.suggestions || []);
    } catch (error) {
      console.error("loadMessages error", error);
      setMessages([]);
      setSuggestions([]);
    }
  }

  async function handleCreateConversation() {
    try {
      const res = await fetch("/api/conversations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: token,
        },
        body: JSON.stringify({}),
      });

      let data: any = null;

      try {
        data = await res.json();
      } catch (e) {
        console.error("Invalid create conversation JSON response", e);
        return;
      }

      if (!res.ok || !data?.conversation) {
        console.error("Failed to create conversation", data);
        return;
      }

      if (viewMode !== "OPEN") {
        setViewMode("OPEN");
      }

      await loadConversations();
      setActiveConversationId(data.conversation.id);
      setMessages([]);
      setSuggestions([]);
      setInput("");
      setSelectedSuggestionId(null);

      await loadMessages(data.conversation.id);
    } catch (error) {
      console.error("handleCreateConversation error", error);
    }
  }

  function handleSelectConversation(id: number) {
    setActiveConversationId(id);
    setInput("");
    setSelectedSuggestionId(null);
  }

  async function handleChooseSuggestion(s: Suggestion) {
    try {
      setSelectedSuggestionId(s.id);
      setInput(s.text);

      const res = await fetch("/api/reply-suggestion/action", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: token,
        },
        body: JSON.stringify({
          suggestionId: s.id,
          action: "selected",
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        console.error("Failed to select suggestion", data);
      }
    } catch (error) {
      console.error("handleChooseSuggestion error", error);
    }
  }

  async function handleDismissSuggestion(suggestionId: number) {
    try {
      const res = await fetch("/api/reply-suggestion/action", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: token,
        },
        body: JSON.stringify({
          suggestionId,
          action: "dismissed",
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        console.error("Failed to dismiss suggestion", data);
      }

      if (selectedSuggestionId === suggestionId) {
        setSelectedSuggestionId(null);
        setInput("");
      }

      if (activeConversationId) {
        await loadMessages(activeConversationId);
      }
    } catch (error) {
      console.error("handleDismissSuggestion error", error);
    }
  }

  function handleManualReply() {
    setSelectedSuggestionId(null);
    setInput("");
  }

  async function handleSendBusinessMessage() {
    if (!input.trim() || !activeConversationId) return;

    try {
      if (selectedSuggestionId) {
        const selected = suggestions.find((s) => s.id === selectedSuggestionId);

        if (selected && selected.text !== input) {
          const editRes = await fetch("/api/reply-suggestion/action", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: token,
            },
            body: JSON.stringify({
              suggestionId: selectedSuggestionId,
              action: "edited",
            }),
          });

          if (!editRes.ok) {
            const editData = await editRes.json().catch(() => null);
            console.error("Failed to mark suggestion as edited", editData);
          }
        }
      }

      const res = await fetch("/api/message", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: token,
        },
        body: JSON.stringify({
          conversationId: activeConversationId,
          customerId: 1,
          contentText: input,
          direction: "OUTBOUND",
          senderType: "BUSINESS_USER",
          generatedFromSuggestionId: selectedSuggestionId ?? null,
        }),
      });

      let data: any = null;

      try {
        data = await res.json();
      } catch (e) {
        console.error("Invalid business message JSON response", e);
        return;
      }

      if (!res.ok) {
        console.error("Failed to send business message", data);
        return;
      }

      if (selectedSuggestionId) {
        const sentRes = await fetch("/api/reply-suggestion/action", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: token,
          },
          body: JSON.stringify({
            suggestionId: selectedSuggestionId,
            action: "sent",
          }),
        });

        if (!sentRes.ok) {
          const sentData = await sentRes.json().catch(() => null);
          console.error("Failed to mark suggestion as sent", sentData);
        }
      }

      await loadMessages(activeConversationId);
      await loadConversations();

      setInput("");
      setSelectedSuggestionId(null);
    } catch (error) {
      console.error("handleSendBusinessMessage error", error);
    }
  }

  async function handleSimulateCustomerMessage() {
    if (!input.trim() || !activeConversationId) return;

    try {
      const res = await fetch("/api/message", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: token,
        },
        body: JSON.stringify({
          conversationId: activeConversationId,
          customerId: 1,
          contentText: input,
          direction: "INBOUND",
          senderType: "CUSTOMER",
        }),
      });

      let data: any = null;

      try {
        data = await res.json();
      } catch (e) {
        console.error("Invalid customer message JSON response", e);
        return;
      }

      if (!res.ok) {
        console.error("Failed to send customer message", data);
        return;
      }

      await loadMessages(activeConversationId);
      await loadConversations();

      setInput("");
      setSelectedSuggestionId(null);
    } catch (error) {
      console.error("handleSimulateCustomerMessage error", error);
    }
  }

  async function handleCloseConversation() {
    if (!activeConversationId) return;

    try {
      const res = await fetch(`/api/conversation/${activeConversationId}/close`, {
        method: "POST",
        headers: {
          Authorization: token,
        },
      });

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        console.error("Failed to close conversation", data);
        return;
      }

      setActiveConversationId(null);
      setMessages([]);
      setSuggestions([]);
      setInput("");
      setSelectedSuggestionId(null);

      await loadConversations();
    } catch (error) {
      console.error("handleCloseConversation error", error);
    }
  }

  useEffect(() => {
    loadConversations();
  }, [viewMode]);

  useEffect(() => {
    if (activeConversationId) {
      loadMessages(activeConversationId);
    } else {
      setMessages([]);
      setSuggestions([]);
    }
  }, [activeConversationId]);

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeConversationId) || null,
    [conversations, activeConversationId]
  );

  const activeIndicator = getSmartIndicator({
    currentStage: activeConversation?.currentStage,
    messages,
    suggestions,
  });

  const baseButtonStyle: React.CSSProperties = {
    minWidth: 0,
    padding: "12px 14px",
    borderRadius: 14,
    cursor: "pointer",
    fontWeight: 700,
    color: "#111827",
    touchAction: "manipulation",
    WebkitTapHighlightColor: "transparent",
    WebkitAppearance: "none",
    appearance: "none",
    boxShadow: "0 6px 20px rgba(15, 23, 42, 0.08)",
    border: "1px solid #d6d3d1",
  };

  const softButtonStyle: React.CSSProperties = {
    ...baseButtonStyle,
    background: "linear-gradient(180deg, #ffffff 0%, #f8fafc 100%)",
  };

  const accentButtonStyle: React.CSSProperties = {
    ...baseButtonStyle,
    background: "linear-gradient(180deg, #dcfce7 0%, #bbf7d0 100%)",
    border: "1px solid #86efac",
    color: "#166534",
  };

  const warmButtonStyle: React.CSSProperties = {
    ...baseButtonStyle,
    background: "linear-gradient(180deg, #fef3c7 0%, #fde68a 100%)",
    border: "1px solid #f5c542",
    color: "#92400e",
  };

  const dangerButtonStyle: React.CSSProperties = {
    ...baseButtonStyle,
    background: "linear-gradient(180deg, #fee2e2 0%, #fecaca 100%)",
    border: "1px solid #fca5a5",
    color: "#991b1b",
  };

  return (
    <div
      style={{
        direction: "rtl",
        display: "flex",
        flexDirection: isMobile ? "column" : "row",
        minHeight: "100vh",
        alignItems: "stretch",
        background: "#f8fafc",
        width: "100%",
        maxWidth: "100%",
        overflowX: "hidden",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          width: isMobile ? "100%" : 320,
          maxWidth: "100%",
          minWidth: 0,
          borderLeft: isMobile ? "none" : "1px solid #e5e7eb",
          borderBottom: isMobile ? "1px solid #e5e7eb" : "none",
          padding: isMobile ? 12 : 16,
          boxSizing: "border-box",
          background: "#ffffff",
          flexShrink: 0,
        }}
      >
        <h3 style={{ marginTop: 0, marginBottom: 12, color: "#111827" }}>שיחות</h3>

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
            onClick={() => setViewMode("OPEN")}
            style={{
              ...(viewMode === "OPEN" ? accentButtonStyle : softButtonStyle),
              flex: "1 1 140px",
            }}
          >
            פתוחות
          </button>

          <button
            type="button"
            onClick={() => setViewMode("CLOSED")}
            style={{
              ...(viewMode === "CLOSED" ? warmButtonStyle : softButtonStyle),
              flex: "1 1 140px",
            }}
          >
            סגורות
          </button>
        </div>

        <button
          type="button"
          onClick={handleCreateConversation}
          style={{
            ...accentButtonStyle,
            width: "100%",
            marginBottom: 16,
            minHeight: 56,
            fontSize: 18,
          }}
        >
          התחל שיחה חדשה
        </button>

        {conversations.length === 0 && (
          <div style={{ color: "#6b7280", padding: "8px 2px" }}>
            {viewMode === "OPEN" ? "אין שיחות פתוחות" : "אין שיחות סגורות"}
          </div>
        )}

        {conversations.map((conversation) => (
          <button
            key={conversation.id}
            type="button"
            onClick={() => handleSelectConversation(conversation.id)}
            style={{
              width: "100%",
              display: "block",
              textAlign: "right",
              padding: 14,
              marginBottom: 10,
              border:
                activeConversationId === conversation.id
                  ? "1px solid #86efac"
                  : "1px solid #e5e7eb",
              borderRadius: 16,
              background:
                activeConversationId === conversation.id
                  ? "linear-gradient(180deg, #ecfdf5 0%, #d1fae5 100%)"
                  : "#fff",
              cursor: "pointer",
              color: "#111",
              touchAction: "manipulation",
              WebkitTapHighlightColor: "transparent",
              boxShadow: "0 6px 20px rgba(15, 23, 42, 0.05)",
            }}
          >
            <div style={{ fontWeight: 700 }}>שיחה #{conversation.id}</div>

            <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>
              {conversation.channel} • {conversation.status}
            </div>

            <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
              שלב: {getStageLabel(conversation.currentStage)}
            </div>

            <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 4 }}>
              {new Date(conversation.startedAt).toLocaleString("he-IL")}
            </div>
          </button>
        ))}
      </div>

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
            <div
              style={{
                marginBottom: 20,
                padding: 16,
                border: `1px solid ${activeIndicator.border}`,
                borderRadius: 18,
                background: "#ffffff",
                width: "100%",
                boxSizing: "border-box",
                boxShadow: "0 8px 24px rgba(15, 23, 42, 0.05)",
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
                    }}
                  >
                    שיחה #{activeConversation?.id}
                  </h2>

                  <div style={{ fontSize: 13, color: "#6b7280", marginTop: 6 }}>
                    {activeConversation?.channel} • {activeConversation?.status}
                  </div>

                  <div style={{ fontSize: 13, color: "#6b7280", marginTop: 4 }}>
                    שלב: {getStageLabel(activeConversation?.currentStage)}
                  </div>

                  {activeConversation?.status === "OPEN" && (
                    <button
                      type="button"
                      onClick={handleCloseConversation}
                      style={{
                        ...dangerButtonStyle,
                        marginTop: 12,
                      }}
                    >
                      סגור שיחה
                    </button>
                  )}
                </div>

                <div
                  style={{
                    padding: "10px 14px",
                    borderRadius: 999,
                    border: `1px solid ${activeIndicator.border}`,
                    color: activeIndicator.color,
                    fontWeight: 700,
                    background: "#fff",
                    whiteSpace: "nowrap",
                    maxWidth: "100%",
                    alignSelf: isMobile ? "flex-start" : "center",
                  }}
                >
                  {activeIndicator.emoji} {activeIndicator.label}
                </div>
              </div>
            </div>

            <div style={{ marginBottom: 24 }}>
              <h4 style={{ marginTop: 0, color: "#111827" }}>הודעות</h4>

              {messages.length === 0 && (
                <div style={{ color: "#6b7280" }}>אין הודעות בשיחה הזו</div>
              )}

              {messages.map((msg) => (
                <div
                  key={msg.id}
                  style={{
                    padding: 12,
                    marginBottom: 10,
                    border: "1px solid #e5e7eb",
                    borderRadius: 14,
                    background: "#fff",
                    width: "100%",
                    boxSizing: "border-box",
                    overflowWrap: "anywhere",
                    wordBreak: "break-word",
                    boxShadow: "0 4px 14px rgba(15, 23, 42, 0.04)",
                  }}
                >
                  <b>{msg.senderType}:</b> {msg.contentText}
                </div>
              ))}
            </div>

            <div style={{ marginBottom: 24 }}>
              <h4 style={{ marginTop: 0, color: "#111827" }}>הצעות</h4>

              {suggestions.length === 0 && (
                <div style={{ color: "#6b7280" }}>אין הצעות כרגע</div>
              )}

              {suggestions.map((s) => (
                <div
                  key={s.id}
                  style={{
                    border:
                      selectedSuggestionId === s.id
                        ? "2px solid #22c55e"
                        : "1px solid #d1d5db",
                    borderRadius: 16,
                    background:
                      selectedSuggestionId === s.id ? "#f0fdf4" : "#ffffff",
                    padding: 14,
                    marginBottom: 12,
                    width: "100%",
                    boxSizing: "border-box",
                    overflowX: "hidden",
                    boxShadow: "0 4px 14px rgba(15, 23, 42, 0.04)",
                  }}
                >
                  <div
                    style={{
                      marginBottom: 12,
                      overflowWrap: "anywhere",
                      wordBreak: "break-word",
                      color: "#111827",
                      lineHeight: 1.7,
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
                      onClick={() => handleChooseSuggestion(s)}
                      style={{
                        ...accentButtonStyle,
                        flex: "1 1 120px",
                      }}
                    >
                      בחר
                    </button>

                    <button
                      type="button"
                      onClick={() => handleChooseSuggestion(s)}
                      style={{
                        ...warmButtonStyle,
                        flex: "1 1 120px",
                      }}
                    >
                      ערוך
                    </button>

                    <button
                      type="button"
                      onClick={() => handleDismissSuggestion(s.id)}
                      style={{
                        ...softButtonStyle,
                        flex: "1 1 120px",
                      }}
                    >
                      דלג
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {activeConversation?.status === "OPEN" && (
              <div
                style={{
                  background: "#fff",
                  border: "1px solid #e5e7eb",
                  borderRadius: 18,
                  padding: isMobile ? 14 : 18,
                  boxShadow: "0 8px 24px rgba(15, 23, 42, 0.05)",
                }}
              >
                <h4 style={{ marginTop: 0, color: "#111827" }}>כתיבת הודעה</h4>

                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  style={{
                    width: "100%",
                    maxWidth: "100%",
                    height: 110,
                    padding: 12,
                    boxSizing: "border-box",
                    borderRadius: 14,
                    border: "1px solid #d1d5db",
                    resize: "vertical",
                    fontFamily: "inherit",
                    fontSize: 16,
                    outline: "none",
                    color: "#111827",
                    background: "#fcfcfc",
                  }}
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
                    onClick={handleSendBusinessMessage}
                    style={{
                      ...accentButtonStyle,
                      flex: "1 1 180px",
                    }}
                  >
                    שלח כבעל עסק
                  </button>

                  <button
                    type="button"
                    onClick={handleManualReply}
                    style={{
                      ...softButtonStyle,
                      flex: "1 1 180px",
                    }}
                  >
                    נקה למענה עצמאי
                  </button>

                  <button
                    type="button"
                    onClick={handleSimulateCustomerMessage}
                    style={{
                      ...warmButtonStyle,
                      flex: "1 1 180px",
                    }}
                  >
                    שלח כלקוח
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}