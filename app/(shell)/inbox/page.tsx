"use client";

import { Suspense, useEffect, useId, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ConversationList, type InboxListPhase } from "@/components/inbox/ConversationList";
import { ConversationView } from "@/components/inbox/ConversationView";
import { WorkspaceLayout } from "@/components/ui/workspace-layout";
import {
  InboxConnectionLoader,
  WhatsAppInboxOnboarding,
  WhatsAppReconnectBanner,
} from "@/components/inbox/WhatsAppConversationsGate";
import { InboxConnectedEmptyState } from "@/components/inbox/InboxConnectedEmptyState";
import { useWhatsAppConnection } from "@/components/whatsapp/use-whatsapp-connection";
import { WA_COPY } from "@/components/whatsapp/wa-copy";
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

/**
 * Consumer-selected DS breakpoint step for the Inbox WorkspaceLayout adoption.
 * At/above it the list + conversation show in parallel (desktop two-pane);
 * below it the layout collapses (switch) to the single URL-derived surface.
 * 769 preserves the prior `window.innerWidth <= 768 → mobile` engagement point,
 * so no user sees a layout change at their current width. The value lives here
 * (consumer owns the selection); WorkspaceLayout never guesses a breakpoint.
 */
const INBOX_TWO_PANE_STEP = 769;

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
      color: "var(--dz-warning)",
      border: "var(--dz-warning-accent)",
    };
  }

  if (lastMessage?.senderType === "CUSTOMER") {
    return {
      label: "ממתין לבעל העסק",
      emoji: "⏳",
      color: "var(--dz-info)",
      border: "var(--dz-info-accent)",
    };
  }

  if (currentStage === "closing") {
    return {
      label: "שיחה מתקדמת",
      emoji: "⚡",
      color: "var(--dz-success)",
      border: "var(--dz-success-accent)",
    };
  }

  if (currentStage === "middle") {
    return {
      label: "שיחה פעילה",
      emoji: "💬",
      color: "var(--dz-brand)",
      border: "var(--dz-brand)",
    };
  }

  return {
    label: "שיחה חדשה",
    emoji: "🆕",
    color: "var(--dz-text-secondary)",
    border: "var(--dz-border-strong)",
  };
}

/**
 * A stable token per send ATTEMPT (W2.5).
 *
 * Paired with the unique index behind `Message.clientRequestId`, this makes a
 * send exactly-once: a double-tap or a retry carries the same token, so the
 * server returns the message that already exists instead of creating a second
 * one. `randomUUID` is not available on insecure origins, hence the fallback.
 */
function newSendToken(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  return `snd-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function InboxPageContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [selectedWorkCategory, setSelectedWorkCategory] =
    useState<InboxSidebarSelection>(INBOX_SIDEBAR_LEGACY_OPEN);
  // List-internal browsing toggle (mobile only): triage ("categories") vs the
  // selected category's conversations. NOT a top-level navigation source of
  // truth — the open conversation is owned solely by the URL (see below).
  const [mobileListPhase, setMobileListPhase] =
    useState<InboxListPhase>("categories");

  const [allConversations, setAllConversations] = useState<Conversation[]>([]);
  /** Full list from GET /api/conversations; undefined = API without `items` (legacy fallback). */
  const [allConversationItems, setAllConversationItems] = useState<
    InboxItemViewModel[] | undefined
  >(undefined);

  // The open conversation is DERIVED from the URL — the URL is the sole durable
  // source of truth. `null` = no valid conversation open (list surface). Invalid
  // syntax also yields `null` and is normalized out of the URL below.
  const activeConversationId = useMemo<number | null>(() => {
    const raw = searchParams.get("conversationId");
    if (raw == null) return null;
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }, [searchParams]);

  const [messages, setMessages] = useState<Message[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);

  const [input, setInput] = useState("");
  // Guards both send handlers against a double-tap reaching the server twice.
  const sendingRef = useRef(false);
  const [selectedSuggestionId, setSelectedSuggestionId] = useState<number | null>(null);
  const [listSearchQuery, setListSearchQuery] = useState("");
  // SSR-safe scope for the Inbox layout's breakpoint CSS (framing + desktop/mobile
  // surface visibility). No hydration branch — the media query does the switching.
  const inboxScope = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  // NOTE: `isMobile` no longer owns layout — WorkspaceLayout + CSS media queries do
  // (see INBOX_TWO_PANE_STEP). It is retained SOLELY for the mobile-only category
  // auto-pick effect below, which is navigation logic, not layout. Removing it would
  // change that behavior, so per the adoption scope it stays as-is.
  const [isMobile, setIsMobile] = useState(false);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  // WhatsApp connection gate: bumped after a (re)connect completes so the
  // status re-fetches and the onboarding/banner clears.
  const [waReloadKey, setWaReloadKey] = useState(0);
  const waConnection = useWhatsAppConnection(waReloadKey);
  // Friendly notice when an outbound WhatsApp reply couldn't be delivered.
  const [sendNotice, setSendNotice] = useState<string | null>(null);
  const [takeOverBusy, setTakeOverBusy] = useState(false);
  const [productLinkPrefill, setProductLinkPrefill] =
    useState<ProductLinkPrefill | null>(null);
  const initialInboxTabPickedRef = useRef(false);

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

    // Always carry an explicit query string (even when empty) so the App Router
    // applies the cleared search params. Navigating to a bare pathname does NOT
    // strip a pre-existing `conversationId` in the production build, which left
    // invalid/not-found deep links and in-app close with a stale URL.
    const query = params.toString();
    const nextUrl = `${pathname}?${query}`;

    // Search-param-only update on the same route (open/close a conversation).
    // `router.push`/`router.replace` to a bare pathname no-ops on the production
    // build when the only change is removing the query, so it cannot clear
    // `conversationId`. Use the native History API, which Next integrates into the
    // App Router: it copies its internal state (`__NA` + internals tree) into the
    // new entry and syncs `usePathname`/`useSearchParams` without a reload. Pass
    // `null` (not `window.history.state`): a state already carrying `__NA` is
    // treated as an internal call and skips the URL sync. `pushState` keeps a
    // back-entry (Browser Back returns to the conversation); `replaceState`
    // normalizes in place with no history entry. Real route changes still use
    // `router`.
    if (opts?.replace) {
      window.history.replaceState(null, "", nextUrl);
      return;
    }

    window.history.pushState(null, "", nextUrl);
  }

  function handlePickCategory(category: InboxSidebarSelection) {
    let target = category;
    if (allConversationItems !== undefined) {
      const byId = countOpenItemsByWorkCategory(allConversationItems);
      target = resolveInboxCategoryPick(category, byId);
    }
    setSelectedWorkCategory(target);
    setMobileListPhase("conversation_list");
  }

  function handlePickDesktopCategory(category: InboxSidebarSelection) {
    setSelectedWorkCategory(category);
  }

  // Mobile: back from a category's conversations to the triage screen. Pure
  // list-internal browsing — no URL/history change (category is not URL-backed).
  function handleBackToCategories() {
    setMobileListPhase("categories");
  }

  // Mobile: in-app back arrow inside a conversation. Explicit navigation to the
  // list via push — independent of history provenance, so a deep-linked or
  // refreshed detail also lands on the list rather than exiting the app.
  function handleBackToConversationList() {
    updateConversationIdInUrl(null);
  }

  // Invalid-SYNTAX normalization: the param exists but is not a valid id →
  // remove it via replace (no history entry). No loop: once removed raw is null.
  // Not-found / inaccessible ids are handled after conversations load (below),
  // never during loading, so a valid deep link is not dropped early.
  useEffect(() => {
    const raw = searchParams.get("conversationId");
    if (raw != null && activeConversationId == null) {
      updateConversationIdInUrl(null, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, activeConversationId]);

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

      // Not-found / inaccessible: only AFTER a successful conversations load, if
      // the URL's conversation is absent from the list, normalize it out
      // (replace → list surface). This never runs during loading, so a valid
      // deep link is not dropped before the data that decides it is available.
      if (
        activeConversationId &&
        !all.some((conversation: Conversation) => conversation.id === activeConversationId)
      ) {
        updateConversationIdInUrl(null, { replace: true });
        setMessages([]);
        setSuggestions([]);
        setInput("");
        setSelectedSuggestionId(null);
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
      setMobileListPhase("conversation_list");

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

  // Select a conversation (from the list or a smart triage item) — the durable
  // destination is pushed to the URL. Browser Back consumes it → list.
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
    // In-flight guard: neither send handler had one, so a double-tap really did
    // reach the server twice. The token above makes that harmless; this stops
    // it happening at all.
    if (!input.trim() || !activeConversationId) return;
    if (sendingRef.current) return;
    sendingRef.current = true;
    const sendToken = newSendToken();

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
          clientRequestId: sendToken,
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

      // Surface a friendly notice if WhatsApp delivery failed (e.g. outside the
      // 24h window, or the connection was revoked). The message is still stored.
      const wa = data?.whatsappSend;
      if (wa && wa.status === "FAILED") {
        const reasonKey =
          wa.reason === "window"
            ? "windowExpired"
            : wa.reason === "revoked"
              ? "revoked"
              : wa.reason === "not_connected"
                ? "notConnected"
                : "failed";
        setSendNotice(WA_COPY.outbound[reasonKey]);
      } else {
        setSendNotice(null);
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
    } finally {
      sendingRef.current = false;
    }
  }

  async function handleSimulateCustomerMessage() {
    if (!input.trim() || !activeConversationId) return;
    if (sendingRef.current) return;
    sendingRef.current = true;
    const sendToken = newSendToken();

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
          clientRequestId: sendToken,
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
    } finally {
      sendingRef.current = false;
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
      setMobileListPhase("conversation_list");
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

    // Category selection only — no mobile-screen inference (the skip heuristic
    // was removed: mobile shows triage until the user picks a category).
    if (!initialInboxTabPickedRef.current) {
      initialInboxTabPickedRef.current = true;
      const picked =
        selectedWorkCategory === INBOX_SIDEBAR_LEGACY_OPEN
          ? pickDefaultInboxSelection(byId)
          : resolveInboxCategoryPick(selectedWorkCategory, byId);
      setSelectedWorkCategory(picked);
      return;
    }

    if (selectedWorkCategory === "needs_action" && byId.needs_action === 0) {
      setSelectedWorkCategory(pickDefaultInboxSelection(byId));
    }

    if (
      isMobile &&
      mobileListPhase === "conversation_list" &&
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
    mobileListPhase,
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
    color: "var(--dz-text-primary)",
    boxShadow: "0 6px 20px rgba(52, 60, 50, 0.08)",
    border: "1px solid var(--dz-border-strong)",
  };

  const softButtonStyle: React.CSSProperties = {
    ...baseActionStyle,
    background: "linear-gradient(180deg, var(--dz-surface-flat) 0%, var(--dz-surface-muted) 100%)",
  };

  const accentButtonStyle: React.CSSProperties = {
    ...baseActionStyle,
    background: "linear-gradient(180deg, var(--dz-success-bg) 0%, var(--dz-success-bg) 100%)",
    border: "1px solid var(--dz-success-border)",
    color: "var(--dz-success)",
  };

  const warmButtonStyle: React.CSSProperties = {
    ...baseActionStyle,
    background: "linear-gradient(180deg, var(--dz-warning-bg) 0%, var(--dz-warning-bg) 100%)",
    border: "1px solid var(--dz-warning-accent)",
    color: "var(--dz-warning)",
  };

  const dangerButtonStyle: React.CSSProperties = {
    ...baseActionStyle,
    background: "linear-gradient(180deg, var(--dz-danger-bg) 0%, var(--dz-danger-bg) 100%)",
    border: "1px solid var(--dz-danger-border)",
    color: "var(--dz-danger)",
  };

  if (!authChecked) {
    return null;
  }

  if (!authToken) {
    return (
      <div style={{ direction: "rtl", padding: 32, textAlign: "center", color: "var(--dz-text-muted)" }}>
        יש להתחבר כדי לגשת לתיבת הדואר.
      </div>
    );
  }

  // ── WhatsApp connection gate ────────────────────────────────────────────
  // While the status resolves, hold a calm loader (avoids flashing the
  // onboarding then the conversations). Never connected → full onboarding.
  // Was connected but the link broke → conversations + a reconnect banner.
  const reloadWaConnection = () => setWaReloadKey((k) => k + 1);

  if (waConnection.phase === "loading") {
    return <InboxConnectionLoader />;
  }

  const waNeverConnected =
    waConnection.phase === "disconnected" && waConnection.previousStatus === null;
  const waBroken =
    waConnection.phase === "disconnected" && waConnection.previousStatus !== null;

  if (waNeverConnected) {
    return <WhatsAppInboxOnboarding onConnected={reloadWaConnection} />;
  }

  // Connected but no conversations yet → the Inbox's own connected empty state
  // (moment 3) instead of a blank list.
  if (waConnection.phase === "connected" && allConversations.length === 0) {
    return <InboxConnectedEmptyState />;
  }

  const reconnectBanner = waBroken ? (
    <WhatsAppReconnectBanner onConnected={reloadWaConnection} />
  ) : null;

  const sendToast = sendNotice ? (
    <SendNoticeToast message={sendNotice} onClose={() => setSendNotice(null)} />
  ) : null;

  // Single Inbox layout via the WorkspaceLayout primitive (switch + split):
  //  · start region  = the list surface. Both the desktop surface (focus tabs +
  //    desktop ConversationList) and the mobile triage surface (mobile
  //    ConversationList) are rendered as STABLE mounted surfaces; a CSS media
  //    query at INBOX_TWO_PANE_STEP shows exactly one. No window.innerWidth, no
  //    remount across the breakpoint.
  //  · end region    = a single ConversationView across breakpoints; its own CSS
  //    (breakpointStep) drives back-button / empty-state / sizing.
  //  · responsive    = switch: below the step, show the URL-derived region
  //    (detail when a conversation is open, else the list). Above the step both
  //    show in parallel (desktop two-pane).
  //  · scrollModel   = split: each region scrolls independently within the
  //    shell's bounded content height (height:100% chain below).
  // All decorative framing (centered max-width, inter-card gap, rounded cards)
  // lives in this consumer's CSS-toggled wrappers — the primitive stays a bare
  // two-region structure and Customers' shared-scroll adoption is untouched.
  const inboxCss = `
[data-inbox="${inboxScope}"] { height: 100%; box-sizing: border-box; background: var(--dz-surface-muted); direction: rtl; overflow-x: hidden; }
[data-inbox="${inboxScope}"] > .inbox-frame { height: 100%; box-sizing: border-box; }
[data-inbox="${inboxScope}"] .list-frame { height: 100%; box-sizing: border-box; }
[data-inbox="${inboxScope}"] .list-frame > .list-desktop { display: none; }
[data-inbox="${inboxScope}"] .list-frame > .list-mobile { display: block; height: 100%; }
[data-inbox="${inboxScope}"] .cv-frame { height: 100%; box-sizing: border-box; min-width: 0; }
@media (min-width: ${INBOX_TWO_PANE_STEP}px) {
  [data-inbox="${inboxScope}"] > .inbox-frame { max-width: 1280px; margin: 0 auto; padding: 16px 20px; }
  [data-inbox="${inboxScope}"] .list-frame > .list-desktop {
    display: flex; flex-direction: column; height: 100%;
    background: var(--dz-surface); border: 1px solid rgba(52, 60, 50, 0.08); border-radius: 22px;
    box-shadow: 0 8px 24px rgba(52, 60, 50, 0.05); overflow: hidden;
  }
  [data-inbox="${inboxScope}"] .list-frame > .list-mobile { display: none; }
  [data-inbox="${inboxScope}"] .cv-frame {
    margin-inline-start: 14px;
    background: var(--dz-surface); border: 1px solid rgba(52, 60, 50, 0.08); border-radius: 22px;
    box-shadow: 0 8px 24px rgba(52, 60, 50, 0.05); overflow: hidden;
  }
}
`;

  return (
    <>
      {reconnectBanner}
      {sendToast}
      <div data-inbox={inboxScope}>
        <style>{inboxCss}</style>
        <div className="inbox-frame">
          <WorkspaceLayout
            startWidth={360}
            breakpointStep={INBOX_TWO_PANE_STEP}
            responsive={{
              mode: "switch",
              visible: activeConversationId != null ? "end" : "start",
            }}
            scrollModel="split"
            startLabel="רשימת שיחות"
            endLabel="שיחה"
            start={
              <div className="list-frame">
                {/* Desktop surface: focus tabs + desktop list (shown ≥ step). */}
                <div className="list-desktop">
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
                </div>
                {/* Mobile triage surface (shown < step). Content toggles between
                    triage and conversations via `listPhase` — no remount. */}
                <div className="list-mobile">
                  <ConversationList
                    listPhase={mobileListPhase}
                    isMobile={true}
                    selectedWorkCategory={selectedWorkCategory}
                    onChangeWorkCategory={handlePickCategory}
                    onBackFromList={handleBackToCategories}
                    sidebarCounts={sidebarCounts}
                    onCreateConversation={handleCreateConversation}
                    conversations={visibleConversations}
                    items={visibleConversationItems}
                    dailyContext={dailyContext}
                    smartCategoryRows={smartCategoryRows}
                    activeConversationId={activeConversationId}
                    onSelectConversation={handleSelectConversation}
                    getStageLabel={getStageLabel}
                    styles={{
                      softButtonStyle,
                      accentButtonStyle,
                      warmButtonStyle,
                    }}
                  />
                </div>
              </div>
            }
            end={
              <div className="cv-frame">
                <ConversationView
                  breakpointStep={INBOX_TWO_PANE_STEP}
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
            }
          />
        </div>
      </div>
    </>
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
      background: "linear-gradient(180deg, var(--dz-warning-bg-soft) 0%, var(--dz-warning-bg) 100%)",
      border: "rgba(129, 90, 50, 0.28)",
      color: "var(--dz-danger)",
    },
    calm: {
      background: "linear-gradient(180deg, var(--dz-success-bg-soft) 0%, var(--dz-success-bg) 100%)",
      border: "rgba(30, 106, 74, 0.25)",
      color: "var(--dz-success)",
    },
    bot: {
      background: "linear-gradient(180deg, var(--dz-brand-soft) 0%, var(--dz-brand-soft) 100%)",
      border: "rgba(36, 105, 102, 0.25)",
      color: "var(--dz-brand)",
    },
    neutral: {
      background: "var(--dz-surface)",
      border: "rgba(52, 60, 50, 0.08)",
      color: "var(--dz-text-secondary)",
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
      <div style={{ fontSize: 12, fontWeight: 800, color: "var(--dz-text-muted)", marginBottom: 8 }}>
        {label}
      </div>
      <div style={{ fontSize: 27, fontWeight: 950, color: style.color, lineHeight: 1 }}>
        {value}
      </div>
      <div style={{ fontSize: 12, color: "var(--dz-text-muted)", marginTop: 8, lineHeight: 1.35 }}>
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
        borderBottom: "1px solid rgba(52, 60, 50, 0.06)",
      }}
    >
      <div style={{ fontSize: 18, fontWeight: 900, color: "var(--dz-text-primary)", marginBottom: 12 }}>
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
          border: "1px solid rgba(52, 60, 50, 0.08)",
          borderRadius: 14,
          padding: "11px 14px",
          fontSize: 14,
          fontFamily: "inherit",
          outline: "none",
          background: "var(--dz-surface-muted)",
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
                  ? "1px solid rgba(36, 105, 102, 0.42)"
                  : "1px solid rgba(52, 60, 50, 0.08)",
                background: isSelected ? "var(--dz-brand-soft)" : isUrgent ? "var(--dz-warning-bg-soft)" : "var(--dz-surface)",
                color: isUrgent ? "var(--dz-danger)" : isSelected ? "var(--dz-brand)" : "var(--dz-text-secondary)",
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
                  background: count > 0 ? "rgba(52, 60, 50, 0.06)" : "transparent",
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

function SendNoticeToast({
  message,
  onClose,
}: {
  message: string;
  onClose: () => void;
}) {
  return (
    <div
      dir="rtl"
      role="alert"
      style={{
        position: "fixed",
        top: 12,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 2000,
        width: "calc(100% - 32px)",
        maxWidth: 480,
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        background: "var(--dz-warning-bg)",
        border: "1px solid var(--dz-warning-border)",
        borderRadius: 14,
        boxShadow: "0 10px 25px -5px rgba(52, 60, 50, 0.15)",
        padding: "12px 14px",
        boxSizing: "border-box",
      }}
    >
      <span
        style={{
          flex: 1,
          fontSize: 13,
          fontWeight: 600,
          color: "var(--dz-warning)",
          lineHeight: 1.5,
        }}
      >
        {message}
      </span>
      <button
        type="button"
        onClick={onClose}
        aria-label="סגירה"
        style={{
          flex: "0 0 auto",
          border: "none",
          background: "transparent",
          color: "var(--dz-warning)",
          fontSize: 18,
          fontWeight: 800,
          lineHeight: 1,
          cursor: "pointer",
          padding: 0,
        }}
      >
        ×
      </button>
    </div>
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