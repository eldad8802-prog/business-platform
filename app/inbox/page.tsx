"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ConversationList } from "@/components/inbox/ConversationList";
import { ConversationView } from "@/components/inbox/ConversationView";

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
  customerId?: number | null;
};

type SmartIndicator = {
  label: string;
  emoji: string;
  color: string;
  border: string;
};

function Pressable({
  children,
  onPress,
  disabled = false,
  style,
}: {
  children: React.ReactNode;
  onPress: () => void;
  disabled?: boolean;
  style?: React.CSSProperties;
}) {
  const handlePress = () => {
    if (disabled) return;
    onPress();
  };

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      onClick={handlePress}
      onTouchEnd={(e) => {
        e.preventDefault();
        handlePress();
      }}
      onKeyDown={(e) => {
        if (disabled) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handlePress();
        }
      }}
      style={{
        ...pressableBaseStyle,
        ...(disabled ? disabledPressableStyle : null),
        ...style,
      }}
    >
      {children}
    </div>
  );
}

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

function InboxPageContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [viewMode, setViewMode] = useState<"OPEN" | "CLOSED">("OPEN");

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<number | null>(null);

  const [messages, setMessages] = useState<Message[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);

  const [input, setInput] = useState("");
  const [selectedSuggestionId, setSelectedSuggestionId] = useState<number | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

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

  useEffect(() => {
    const raw = localStorage.getItem("token");
    setAuthToken(raw);
    setAuthChecked(true);
  }, []);

  const token = authToken ? `Bearer ${authToken}` : "";

  function updateConversationIdInUrl(conversationId: number | null, opts?: { replace?: boolean }) {
    const params = new URLSearchParams(searchParams.toString());

    if (conversationId) {
      params.set("conversationId", String(conversationId));
    } else {
      params.delete("conversationId");
    }

    const query = params.toString();
    const nextUrl = query ? `${pathname}?${query}` : pathname;

    if (opts?.replace) {
      router.replace(nextUrl);
      return;
    }

    router.push(nextUrl);
  }

  useEffect(() => {
    const raw = searchParams.get("conversationId");

    if (!raw) {
      if (activeConversationId !== null) {
        setActiveConversationId(null);
      }
      return;
    }

    const parsed = Number(raw);
    const nextId = parsed && !Number.isNaN(parsed) ? parsed : null;

    if (nextId !== activeConversationId) {
      setActiveConversationId(nextId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

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
        updateConversationIdInUrl(null, { replace: true });
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
      updateConversationIdInUrl(data.conversation.id);
      setMessages([]);
      setSuggestions([]);
      setInput("");
      setSelectedSuggestionId(null);
    } catch (error) {
      console.error("handleCreateConversation error", error);
    }
  }

  function handleSelectConversation(id: number) {
    updateConversationIdInUrl(id);
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
      const customerId = activeConversation?.customerId ?? null;

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
          ...(customerId != null ? { customerId } : {}),
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
      const customerId = activeConversation?.customerId ?? null;

      const res = await fetch("/api/message", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: token,
        },
        body: JSON.stringify({
          conversationId: activeConversationId,
          ...(customerId ? { customerId } : null),
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

      updateConversationIdInUrl(null);
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
    if (authChecked && authToken) {
      loadConversations();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, authChecked]);

  useEffect(() => {
    if (!authChecked || !authToken) return;
    if (activeConversationId) {
      loadMessages(activeConversationId);
    } else {
      setMessages([]);
      setSuggestions([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversationId, authChecked]);

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeConversationId) || null,
    [conversations, activeConversationId]
  );

  const activeIndicator = getSmartIndicator({
    currentStage: activeConversation?.currentStage,
    messages,
    suggestions,
  });

  const baseActionStyle: React.CSSProperties = {
    minWidth: 0,
    minHeight: 48,
    padding: "12px 14px",
    borderRadius: 14,
    fontWeight: 700,
    color: "#111827",
    boxShadow: "0 6px 20px rgba(15, 23, 42, 0.08)",
    border: "1px solid #d6d3d1",
  };

  const softButtonStyle: React.CSSProperties = {
    ...baseActionStyle,
    background: "linear-gradient(180deg, #ffffff 0%, #f8fafc 100%)",
  };

  const accentButtonStyle: React.CSSProperties = {
    ...baseActionStyle,
    background: "linear-gradient(180deg, #dcfce7 0%, #bbf7d0 100%)",
    border: "1px solid #86efac",
    color: "#166534",
  };

  const warmButtonStyle: React.CSSProperties = {
    ...baseActionStyle,
    background: "linear-gradient(180deg, #fef3c7 0%, #fde68a 100%)",
    border: "1px solid #f5c542",
    color: "#92400e",
  };

  const dangerButtonStyle: React.CSSProperties = {
    ...baseActionStyle,
    background: "linear-gradient(180deg, #fee2e2 0%, #fecaca 100%)",
    border: "1px solid #fca5a5",
    color: "#991b1b",
  };

  if (!authChecked) {
    return null;
  }

  if (!authToken) {
    return (
      <div style={{ direction: "rtl", padding: 32, textAlign: "center", color: "#64748b" }}>
        יש להתחבר כדי לגשת לתיבת הדואר.
      </div>
    );
  }

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
      <ConversationList
        isMobile={isMobile}
        viewMode={viewMode}
        onChangeViewMode={setViewMode}
        onCreateConversation={handleCreateConversation}
        conversations={conversations}
        activeConversationId={activeConversationId}
        onSelectConversation={handleSelectConversation}
        getStageLabel={getStageLabel}
        styles={{
          softButtonStyle,
          accentButtonStyle,
          warmButtonStyle,
        }}
      />

      <ConversationView
        isMobile={isMobile}
        viewMode={viewMode}
        activeConversationId={activeConversationId}
        activeConversation={activeConversation}
        activeIndicator={activeIndicator}
        getStageLabel={getStageLabel}
        messages={messages}
        suggestions={suggestions}
        selectedSuggestionId={selectedSuggestionId}
        input={input}
        onInputChange={setInput}
        onCloseConversation={handleCloseConversation}
        onChooseSuggestion={handleChooseSuggestion}
        onDismissSuggestion={handleDismissSuggestion}
        onManualReply={handleManualReply}
        onSendBusinessMessage={handleSendBusinessMessage}
        onSimulateCustomerMessage={handleSimulateCustomerMessage}
        styles={{
          softButtonStyle,
          accentButtonStyle,
          warmButtonStyle,
          dangerButtonStyle,
        }}
      />
    </div>
  );
}

export default function InboxPage() {
  return (
    <Suspense fallback={null}>
      <InboxPageContent />
    </Suspense>
  );
}

const pressableBaseStyle: React.CSSProperties = {
  cursor: "pointer",
  userSelect: "none",
  WebkitTapHighlightColor: "transparent",
  touchAction: "manipulation",
  position: "relative",
  zIndex: 1,
  pointerEvents: "auto",
  boxSizing: "border-box",
};

const disabledPressableStyle: React.CSSProperties = {
  opacity: 0.6,
  cursor: "not-allowed",
};