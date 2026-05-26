"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ConversationList } from "@/components/inbox/ConversationList";
import { ConversationView } from "@/components/inbox/ConversationView";
import type { InboxItemViewModel } from "@/lib/inbox-view/inbox-item.types";
import {
  assignInboxWorkCategory,
  countOpenItemsByWorkCategory,
  INBOX_SIDEBAR_LEGACY_OPEN,
  matchesInboxWorkCategory,
  pickDefaultInboxSelection,
  resolveInboxCategoryPick,
  totalOpenInboxCount,
  type InboxSidebarSelection,
  type InboxWorkCategoryId,
} from "@/lib/inbox-view/work-category";
import { sortInboxConversationRows } from "@/lib/inbox-view/inbox-queue-order";
import { buildSmartInboxCategoryRows } from "@/lib/inbox-view/inbox-category-presentation";

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
  suggestionType?: string | null;
};

type ProductLinkPrefill = {
  intro: string | null;
  url: string;
};

type Conversation = {
  id: number;
  channel: string;
  status: string;
  currentStage: string;
  startedAt: string;
  /** From Prisma when present — used for inbox ordering. */
  lastMessageAt?: string | null;
  updatedAt?: string;
  customerId?: number | null;
};

type SmartIndicator = {
  label: string;
  emoji: string;
  color: string;
  border: string;
};

type InboxScreen = "categories" | "conversation_list" | "conversation_detail";

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

  const [selectedWorkCategory, setSelectedWorkCategory] =
    useState<InboxSidebarSelection>(INBOX_SIDEBAR_LEGACY_OPEN);
  const [inboxScreen, setInboxScreen] = useState<InboxScreen>("categories");

  const [allConversations, setAllConversations] = useState<Conversation[]>([]);
  /** Full list from GET /api/conversations; undefined = API without `items` (legacy fallback). */
  const [allConversationItems, setAllConversationItems] = useState<
    InboxItemViewModel[] | undefined
  >(undefined);
  const [activeConversationId, setActiveConversationId] = useState<number | null>(null);

  const [messages, setMessages] = useState<Message[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);

  const [input, setInput] = useState("");
  const [selectedSuggestionId, setSelectedSuggestionId] = useState<number | null>(null);
  const [listSearchQuery, setListSearchQuery] = useState("");
  const [isMobile, setIsMobile] = useState(false);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [takeOverBusy, setTakeOverBusy] = useState(false);
  const [productLinkPrefill, setProductLinkPrefill] =
    useState<ProductLinkPrefill | null>(null);
  const initialInboxTabPickedRef = useRef(false);
  const mobileSkippedCategoriesRef = useRef(false);

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

  function handlePickCategory(category: InboxSidebarSelection) {
    let target = category;
    if (allConversationItems !== undefined) {
      const byId = countOpenItemsByWorkCategory(allConversationItems);
      target = resolveInboxCategoryPick(category, byId);
    }
    setSelectedWorkCategory(target);
    setInboxScreen("conversation_list");
    updateConversationIdInUrl(null, { replace: true });
  }

  function handlePickDesktopCategory(category: InboxSidebarSelection) {
    setSelectedWorkCategory(category);
    setInboxScreen("conversation_list");
  }

  function handleBackToCategories() {
    setInboxScreen("categories");
    updateConversationIdInUrl(null, { replace: true });
  }

  function handleBackToConversationList() {
    setInboxScreen("conversation_list");
    updateConversationIdInUrl(null, { replace: true });
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

  useEffect(() => {
    if (searchParams.get("conversationId")) {
      setInboxScreen("conversation_detail");
    }
  }, [searchParams]);

  async function loadConversations() {
    const rawToken = localStorage.getItem("token");
    if (!rawToken) return;

    try {
      const res = await fetch("/api/conversations", {
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${rawToken}`,
        },
      });

      if (res.status === 401) {
        localStorage.removeItem("token");
        localStorage.removeItem("user");
        router.replace("/login");
        return;
      }

      let data: any = null;

      try {
        data = await res.json();
      } catch (e) {
        console.error("Invalid conversations JSON response", e);
        setAllConversations([]);
        setAllConversationItems(undefined);
        return;
      }

      if (!res.ok) {
        console.error("Failed to load conversations", data);
        setAllConversations([]);
        setAllConversationItems(undefined);
        return;
      }

      const all = data.conversations || [];
      setAllConversations(all);

      if (Array.isArray(data.items)) {
        setAllConversationItems(data.items as InboxItemViewModel[]);
      } else {
        setAllConversationItems(undefined);
      }

      if (
        data.productLinkPrefill &&
        typeof data.productLinkPrefill.url === "string"
      ) {
        setProductLinkPrefill({
          intro: data.productLinkPrefill.intro ?? null,
          url: data.productLinkPrefill.url,
        });
      } else {
        setProductLinkPrefill(null);
      }

      if (
        activeConversationId &&
        !all.some((conversation: Conversation) => conversation.id === activeConversationId)
      ) {
        updateConversationIdInUrl(null, { replace: true });
        setActiveConversationId(null);
        setMessages([]);
        setSuggestions([]);
        setInput("");
        setSelectedSuggestionId(null);
        setInboxScreen("categories");
      }
    } catch (error) {
      console.error("loadConversations error", error);
      setAllConversations([]);
      setAllConversationItems(undefined);
    }
  }

  async function loadMessages(conversationId: number) {
    if (!conversationId) {
      setMessages([]);
      setSuggestions([]);
      return;
    }

    const rawToken = localStorage.getItem("token");
    if (!rawToken) {
      setMessages([]);
      setSuggestions([]);
      return;
    }

    try {
      const res = await fetch(`/api/message?conversationId=${conversationId}`, {
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${rawToken}`,
        },
      });

      if (res.status === 401) {
        localStorage.removeItem("token");
        localStorage.removeItem("user");
        router.replace("/login");
        return;
      }

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

      setSelectedWorkCategory("active");

      await loadConversations();
      updateConversationIdInUrl(data.conversation.id);
      setMessages([]);
      setSuggestions([]);
      setInput("");
      setSelectedSuggestionId(null);
      setInboxScreen("conversation_detail");
    } catch (error) {
      console.error("handleCreateConversation error", error);
    }
  }

  function handleSelectConversation(id: number) {
    updateConversationIdInUrl(id);
    setInput("");
    setSelectedSuggestionId(null);
    setInboxScreen("conversation_detail");
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

  async function handleTakeOverConversation() {
    if (!activeConversationId || !authToken) return;

    setTakeOverBusy(true);
    try {
      const res = await fetch("/api/conversations/take-over", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authToken,
        },
        body: JSON.stringify({ conversationId: activeConversationId }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        console.error("Failed to take over conversation", data);
        return;
      }

      setSelectedSuggestionId(null);
      setInput("");
      await loadMessages(activeConversationId);
      await loadConversations();
    } catch (error) {
      console.error("handleTakeOverConversation error", error);
    } finally {
      setTakeOverBusy(false);
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
      setInboxScreen("conversation_list");

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
  }, [authChecked, authToken]);

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

  useEffect(() => {
    if (allConversationItems === undefined) return;

    const byId = countOpenItemsByWorkCategory(allConversationItems);
    const openTotal = totalOpenInboxCount(byId);
    const hasDeepLinkConversation = !!searchParams.get("conversationId");

    if (!initialInboxTabPickedRef.current) {
      initialInboxTabPickedRef.current = true;
      const picked =
        selectedWorkCategory === INBOX_SIDEBAR_LEGACY_OPEN
          ? pickDefaultInboxSelection(byId)
          : resolveInboxCategoryPick(selectedWorkCategory, byId);
      setSelectedWorkCategory(picked);

      if (
        isMobile &&
        openTotal > 0 &&
        !hasDeepLinkConversation &&
        !mobileSkippedCategoriesRef.current
      ) {
        mobileSkippedCategoriesRef.current = true;
        setInboxScreen("conversation_list");
      }
      return;
    }

    if (selectedWorkCategory === "needs_action" && byId.needs_action === 0) {
      setSelectedWorkCategory(pickDefaultInboxSelection(byId));
    }

    if (
      isMobile &&
      inboxScreen === "conversation_list" &&
      openTotal > 0 &&
      !hasDeepLinkConversation
    ) {
      const resolved = resolveInboxCategoryPick(selectedWorkCategory, byId);
      if (resolved !== selectedWorkCategory) {
        setSelectedWorkCategory(resolved);
      }
    }
  }, [
    allConversationItems,
    selectedWorkCategory,
    isMobile,
    inboxScreen,
    searchParams,
  ]);

  const sidebarCounts = useMemo(() => {
    const openN = allConversations.filter((c) => c.status === "OPEN").length;
    const closedN = allConversations.filter((c) => c.status === "CLOSED").length;

    if (allConversationItems === undefined) {
      return { kind: "legacy" as const, open: openN, closed: closedN };
    }

    const byId: Record<InboxWorkCategoryId, number> = {
      needs_action: 0,
      drafts_ready: 0,
      handoff: 0,
      bot_in_progress: 0,
      hot_leads: 0,
      follow_up: 0,
      completed: 0,
      active: 0,
      closed: 0,
    };

    for (const item of allConversationItems) {
      if (item.status === "CLOSED") {
        byId.closed += 1;
      } else if (item.status === "OPEN") {
        byId[assignInboxWorkCategory(item)] += 1;
      }
    }

    return { kind: "smart" as const, byId };
  }, [allConversations, allConversationItems]);

  const smartCategoryRows = useMemo(() => {
    if (sidebarCounts.kind !== "smart" || allConversationItems === undefined) {
      return undefined;
    }
    return buildSmartInboxCategoryRows(allConversationItems, sidebarCounts.byId);
  }, [sidebarCounts, allConversationItems]);

  const filteredConversations = useMemo(() => {
    if (allConversationItems === undefined) {
      if (selectedWorkCategory === "closed") {
        return allConversations.filter((c) => c.status === "CLOSED");
      }
      return allConversations.filter((c) => c.status === "OPEN");
    }

    if (selectedWorkCategory === INBOX_SIDEBAR_LEGACY_OPEN) {
      return allConversations.filter((c) => c.status === "OPEN");
    }

    if (selectedWorkCategory === "closed") {
      return allConversations.filter((c) => c.status === "CLOSED");
    }

    return allConversations.filter((c) => {
      if (c.status !== "OPEN") return false;
      const item = allConversationItems.find((i) => i.conversationId === c.id);
      return (
        item !== undefined &&
        matchesInboxWorkCategory(item, selectedWorkCategory as InboxWorkCategoryId)
      );
    });
  }, [allConversations, allConversationItems, selectedWorkCategory]);

  const visibleConversations = useMemo(() => {
    const recencyOnly =
      allConversationItems === undefined || selectedWorkCategory === "closed";
    return sortInboxConversationRows(filteredConversations, allConversationItems, {
      recencyOnly,
    });
  }, [filteredConversations, allConversationItems, selectedWorkCategory]);

  const visibleConversationItems = useMemo(() => {
    if (allConversationItems === undefined) return undefined;

    const idSet = new Set(visibleConversations.map((c) => c.id));
    const subset = allConversationItems.filter((i) => idSet.has(i.conversationId));
    const order = new Map(visibleConversations.map((c, idx) => [c.id, idx]));
    return [...subset].sort(
      (a, b) => (order.get(a.conversationId) ?? 0) - (order.get(b.conversationId) ?? 0)
    );
  }, [allConversationItems, visibleConversations]);

  const dailyContext = useMemo<{ urgentCount: number; newSinceYesterday: number } | null>(() => {
    if (allConversationItems === undefined) return null;
    const urgentCount = allConversationItems.filter(
      (item) => item.status === "OPEN" && item.needsHumanAttention === true
    ).length;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const newSinceYesterday = allConversationItems.filter(
      (item) =>
        item.status === "OPEN" &&
        item.lastActivityAt != null &&
        new Date(item.lastActivityAt).getTime() >= cutoff
    ).length;
    return { urgentCount, newSinceYesterday };
  }, [allConversationItems]);

  const activeConversation = useMemo(
    () =>
      activeConversationId == null
        ? null
        : allConversations.find((c) => c.id === activeConversationId) ?? null,
    [allConversations, activeConversationId]
  );

  const activeItem = useMemo(() => {
    if (activeConversationId == null || allConversationItems === undefined) {
      return null;
    }
    return (
      allConversationItems.find((i) => i.conversationId === activeConversationId) ?? null
    );
  }, [activeConversationId, allConversationItems]);

  const activeIndicator = getSmartIndicator({
    currentStage: activeConversation?.currentStage,
    messages,
    suggestions,
  });

  const detailViewMode: "OPEN" | "CLOSED" =
    activeConversation?.status === "CLOSED" ? "CLOSED" : "OPEN";

  const desktopSummaryCards = useMemo(() => {
    const getSmartCount = (id: InboxWorkCategoryId) =>
      sidebarCounts.kind === "smart" ? sidebarCounts.byId[id] : 0;

    const openCount =
      sidebarCounts.kind === "legacy"
        ? sidebarCounts.open
        : allConversationItems?.filter((item) => item.status === "OPEN").length ?? 0;

    return [
      {
        label: "מחכים לך",
        value: dailyContext?.urgentCount ?? getSmartCount("needs_action"),
        tone: "urgent" as const,
        helper: "כאן מתחילים, כדי שאף לקוח לא יישאר באוויר",
      },
      {
        label: "אפשר לסגור מהר",
        value: getSmartCount("drafts_ready"),
        tone: "calm" as const,
        helper: "טיוטות שהמערכת כבר הכינה לך",
      },
      {
        label: "לא צריך לגעת כרגע",
        value: getSmartCount("bot_in_progress"),
        tone: "bot" as const,
        helper: `טיוטות מוכנות — אתה שולח. ${openCount} שיחות פתוחות`,
      },
    ];
  }, [allConversationItems, dailyContext, sidebarCounts]);

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

  if (!isMobile) {
    return (
      <div
        style={{
          direction: "rtl",
          minHeight: "100vh",
          background: "#f8fafc",
          padding: "16px 20px",
          boxSizing: "border-box",
          overflowX: "hidden",
        }}
      >
        <div
          style={{
            maxWidth: 1280,
            margin: "0 auto",
            display: "grid",
            gridTemplateColumns: "360px minmax(0, 1fr)",
            gap: 14,
            alignItems: "stretch",
            minHeight: "calc(100vh - 32px)",
          }}
        >
          <section
            style={{
              background: "#ffffff",
              border: "1px solid rgba(15, 23, 42, 0.08)",
              borderRadius: 22,
              boxShadow: "0 8px 24px rgba(15, 23, 42, 0.05)",
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
            }}
          >
              <DesktopFocusTabs
                selected={selectedWorkCategory}
                onSelect={handlePickDesktopCategory}
                fallbackCounts={sidebarCounts}
                searchQuery={listSearchQuery}
                onSearchQueryChange={setListSearchQuery}
              />
              <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
              <ConversationList
                listPhase="conversation_list"
                layoutMode="desktop"
                isMobile={false}
                selectedWorkCategory={selectedWorkCategory}
                onChangeWorkCategory={setSelectedWorkCategory}
                sidebarCounts={sidebarCounts}
                onCreateConversation={handleCreateConversation}
                conversations={visibleConversations}
                items={visibleConversationItems}
                activeConversationId={activeConversationId}
                onSelectConversation={handleSelectConversation}
                searchQuery={listSearchQuery}
                onSearchQueryChange={setListSearchQuery}
                getStageLabel={getStageLabel}
                styles={{
                  softButtonStyle,
                  accentButtonStyle,
                  warmButtonStyle,
                }}
              />
            </div>
          </section>

          <section
            style={{
              minWidth: 0,
              background: "#ffffff",
              border: "1px solid rgba(15, 23, 42, 0.08)",
              borderRadius: 22,
              boxShadow: "0 8px 24px rgba(15, 23, 42, 0.05)",
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
            }}
          >
              <ConversationView
                isMobile={false}
                viewMode={detailViewMode}
                activeConversationId={activeConversationId}
                activeConversation={activeConversation}
                activeItem={activeItem}
                activeIndicator={activeIndicator}
                getStageLabel={getStageLabel}
                messages={messages}
                suggestions={suggestions}
                selectedSuggestionId={selectedSuggestionId}
                input={input}
                onInputChange={setInput}
                onCloseConversation={handleCloseConversation}
                onTakeOverConversation={handleTakeOverConversation}
                takeOverBusy={takeOverBusy}
                productLinkPrefill={productLinkPrefill}
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
          </section>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        direction: "rtl",
        display: "flex",
        flexDirection: "column",
        minHeight: "100vh",
        alignItems: "stretch",
        background: "#f8fafc",
        width: "100%",
        maxWidth: "100%",
        overflowX: "hidden",
        boxSizing: "border-box",
      }}
    >
      {inboxScreen === "categories" && (
        <ConversationList
          listPhase="categories"
          isMobile={isMobile}
          selectedWorkCategory={selectedWorkCategory}
          onChangeWorkCategory={handlePickCategory}
          sidebarCounts={sidebarCounts}
          onCreateConversation={handleCreateConversation}
          conversations={[]}
          items={undefined}
          dailyContext={dailyContext}
          smartCategoryRows={smartCategoryRows}
          activeConversationId={null}
          onSelectConversation={handleSelectConversation}
          getStageLabel={getStageLabel}
          styles={{
            softButtonStyle,
            accentButtonStyle,
            warmButtonStyle,
          }}
        />
      )}

      {inboxScreen === "conversation_list" && (
        <ConversationList
          listPhase="conversation_list"
          isMobile={isMobile}
          selectedWorkCategory={selectedWorkCategory}
          onChangeWorkCategory={setSelectedWorkCategory}
          onBackFromList={handleBackToCategories}
          sidebarCounts={sidebarCounts}
          onCreateConversation={handleCreateConversation}
          conversations={visibleConversations}
          items={visibleConversationItems}
          activeConversationId={activeConversationId}
          onSelectConversation={handleSelectConversation}
          getStageLabel={getStageLabel}
          styles={{
            softButtonStyle,
            accentButtonStyle,
            warmButtonStyle,
          }}
        />
      )}

      {inboxScreen === "conversation_detail" && (
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
            width: "100%",
            background: "#f8fafc",
          }}
        >
          <ConversationView
            isMobile={isMobile}
            viewMode={detailViewMode}
            activeConversationId={activeConversationId}
            activeConversation={activeConversation}
            activeItem={activeItem}
            activeIndicator={activeIndicator}
            getStageLabel={getStageLabel}
            messages={messages}
            suggestions={suggestions}
            selectedSuggestionId={selectedSuggestionId}
            input={input}
            onInputChange={setInput}
            onCloseConversation={handleCloseConversation}
            onTakeOverConversation={handleTakeOverConversation}
            takeOverBusy={takeOverBusy}
            productLinkPrefill={productLinkPrefill}
            onChooseSuggestion={handleChooseSuggestion}
            onDismissSuggestion={handleDismissSuggestion}
            onManualReply={handleManualReply}
            onSendBusinessMessage={handleSendBusinessMessage}
            onSimulateCustomerMessage={handleSimulateCustomerMessage}
            onBack={handleBackToConversationList}
            styles={{
              softButtonStyle,
              accentButtonStyle,
              warmButtonStyle,
              dangerButtonStyle,
            }}
          />
        </div>
      )}
    </div>
  );
}

function DesktopSummaryCard({
  label,
  value,
  helper,
  tone,
}: {
  label: string;
  value: number;
  helper: string;
  tone: "urgent" | "calm" | "bot" | "neutral";
}) {
  const toneStyles: Record<
    typeof tone,
    { background: string; border: string; color: string }
  > = {
    urgent: {
      background: "linear-gradient(180deg, #fff7ed 0%, #ffedd5 100%)",
      border: "rgba(249, 115, 22, 0.28)",
      color: "#c2410c",
    },
    calm: {
      background: "linear-gradient(180deg, #ecfdf5 0%, #dcfce7 100%)",
      border: "rgba(34, 197, 94, 0.25)",
      color: "#166534",
    },
    bot: {
      background: "linear-gradient(180deg, #eef2ff 0%, #e0e7ff 100%)",
      border: "rgba(99, 102, 241, 0.25)",
      color: "#3730a3",
    },
    neutral: {
      background: "#ffffff",
      border: "rgba(15, 23, 42, 0.08)",
      color: "#334155",
    },
  };

  const style = toneStyles[tone];

  return (
    <div
      style={{
        background: style.background,
        border: `1px solid ${style.border}`,
        borderRadius: 20,
        padding: "14px 15px",
        minWidth: 0,
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 800, color: "#64748b", marginBottom: 8 }}>
        {label}
      </div>
      <div style={{ fontSize: 27, fontWeight: 950, color: style.color, lineHeight: 1 }}>
        {value}
      </div>
      <div style={{ fontSize: 12, color: "#64748b", marginTop: 8, lineHeight: 1.35 }}>
        {helper}
      </div>
    </div>
  );
}

function DesktopFocusTabs({
  selected,
  onSelect,
  fallbackCounts,
  searchQuery,
  onSearchQueryChange,
}: {
  selected: InboxSidebarSelection;
  onSelect: (category: InboxSidebarSelection) => void;
  fallbackCounts:
    | { kind: "smart"; byId: Record<InboxWorkCategoryId, number> }
    | { kind: "legacy"; open: number; closed: number };
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
}) {
  const countFor = (id: InboxSidebarSelection): number => {
    if (fallbackCounts.kind === "legacy") {
      return id === "closed" ? fallbackCounts.closed : fallbackCounts.open;
    }
    if (id === INBOX_SIDEBAR_LEGACY_OPEN) {
      return Object.entries(fallbackCounts.byId).reduce(
        (sum, [key, value]) => (key === "closed" ? sum : sum + value),
        0
      );
    }
    return fallbackCounts.byId[id as InboxWorkCategoryId] ?? 0;
  };

  const focusRows: Array<{ id: InboxSidebarSelection; label: string }> = [
    { id: INBOX_SIDEBAR_LEGACY_OPEN, label: "הכל" },
    { id: "needs_action", label: "דחוף" },
    { id: "drafts_ready", label: "טיוטות" },
    { id: "bot_in_progress", label: "טיוטות" },
    { id: "hot_leads", label: "חם" },
  ];

  return (
    <div
      style={{
        padding: "16px 16px 4px",
        borderBottom: "1px solid rgba(15, 23, 42, 0.06)",
      }}
    >
      <div style={{ fontSize: 18, fontWeight: 900, color: "#111827", marginBottom: 12 }}>
        שיחות
      </div>
      <input
        type="search"
        value={searchQuery}
        onChange={(e) => onSearchQueryChange(e.target.value)}
        placeholder="חיפוש שיחות..."
        style={{
          width: "100%",
          boxSizing: "border-box",
          border: "1px solid rgba(15, 23, 42, 0.08)",
          borderRadius: 14,
          padding: "11px 14px",
          fontSize: 14,
          fontFamily: "inherit",
          outline: "none",
          background: "#f8fafc",
          marginBottom: 12,
        }}
      />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {focusRows.map((row) => {
          const isSelected = selected === row.id;
          const count = countFor(row.id);
          const isUrgent = row.id === "needs_action" && count > 0;

          return (
            <button
              key={String(row.id)}
              type="button"
              onClick={() => onSelect(row.id)}
              style={{
                border: isSelected
                  ? "1px solid rgba(79, 70, 229, 0.42)"
                  : "1px solid rgba(15, 23, 42, 0.08)",
                background: isSelected ? "#eef2ff" : isUrgent ? "#fff7ed" : "#ffffff",
                color: isUrgent ? "#9a3412" : isSelected ? "#3730a3" : "#334155",
                borderRadius: 999,
                padding: "8px 11px",
                fontSize: 12,
                fontWeight: 850,
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <span>{row.label}</span>
              <span
                style={{
                  minWidth: 18,
                  height: 18,
                  borderRadius: 999,
                  background: count > 0 ? "rgba(15, 23, 42, 0.06)" : "transparent",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 11,
                  fontWeight: 900,
                  padding: "0 4px",
                }}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>
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