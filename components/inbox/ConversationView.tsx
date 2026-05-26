"use client";

import React, { useEffect, useRef, useState } from "react";
import type { InboxItemViewModel } from "@/lib/inbox-view/inbox-item.types";
import { INBOX_SURFACE } from "@/components/inbox/inbox-ui-tokens";
import { resolveConversationDisplayTitle } from "@/lib/inbox-view/conversation-display-title";
import { formatProductLinkComposerText } from "@/lib/inbox-view/product-link-capability";

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

function resolveTitle(item: InboxItemViewModel | null): string {
  return resolveConversationDisplayTitle(item);
}

function formatMessageTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("he-IL", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Chip shows the start of the message the owner will send — not a generic label. */
function compactSuggestionLabel(suggestion: Suggestion): string {
  if (suggestion.suggestionType === "STARTER_BOT_DRAFT") return "טיוטת פתיחה";

  const text = suggestion.text.trim();
  if (!text) return "הצעה";

  const max = 44;
  if (text.length <= max) return text;

  const slice = text.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace >= 14 ? slice.slice(0, lastSpace) : slice;
  return `${cut}…`;
}

function quickReplyText(kind: "product_link" | "ask_details" | "follow_up"): string {
  if (kind === "product_link") {
    return "שולח קישור עם הפרטים. צריך עזרה בבחירה?";
  }
  if (kind === "ask_details") {
    return "מה בדיוק אתה צריך?";
  }
  return "עדיין רלוונטי? אשמח לעדכן.";
}

type QuickActionChip = {
  key: string;
  label: string;
  icon: string;
  tone: "default" | "primary" | "success";
  text?: string;
  closesConversation?: boolean;
};

function textForBusinessAction(
  actionId: string,
  productLinkPrefill?: { intro: string | null; url: string } | null
): string {
  if (actionId === "SHOW_PRODUCT_LINK" && productLinkPrefill?.url) {
    return formatProductLinkComposerText(
      productLinkPrefill.intro,
      productLinkPrefill.url
    );
  }

  const byId: Record<string, string> = {
    SHOW_PRODUCT_LINK:
      "שולח קישור עם הפרטים. צריך עזרה בבחירה?",
    CREATE_FOLLOW_UP:
      "רק מוודא איתך אם זה עדיין רלוונטי. אם כן, אשמח להתקדם איתך מכאן.",
    HANDOFF_TO_OWNER:
      "אני בודק את זה אישית וחוזר אליך עם תשובה מסודרת.",
    SAVE_DOCUMENT_FROM_CHAT:
      "קיבלתי את הקובץ, אני שומר אותו ומעדכן אותך בהמשך הטיפול.",
    CREATE_LEAD: "מה אתה צריך? כתוב במשפט אחד.",
    MARK_QUOTE_SENT:
      "שלחתי לך את ההצעה. אם יש שאלה או משהו שתרצה לשנות, אני כאן.",
    CREATE_INVOICE_DRAFT:
      "אפשר להתקדם מכאן לתשלום / חשבונית. אכין לך את הפרטים בצורה מסודרת.",
    CHECK_PRODUCT_AVAILABILITY:
      "אני בודק זמינות וחוזר אליך עם תשובה מסודרת.",
    BOOK_APPOINTMENT:
      "אפשר לתאם זמן שנוח לך. שלח לי יום ושעה שמתאימים לך.",
  };
  return byId[actionId] ?? quickReplyText("ask_details");
}

function labelForBusinessAction(actionId: string): { label: string; icon: string } {
  const byId: Record<string, { label: string; icon: string }> = {
    SHOW_PRODUCT_LINK: { label: "שלח קישור למוצר", icon: "↗" },
    CREATE_FOLLOW_UP: { label: "מעקב קצר", icon: "↺" },
    HANDOFF_TO_OWNER: { label: "קח טיפול", icon: "!" },
    SAVE_DOCUMENT_FROM_CHAT: { label: "שמור קובץ", icon: "□" },
    CREATE_LEAD: { label: "ברר צורך", icon: "?" },
    MARK_QUOTE_SENT: { label: "שלח הצעת מחיר", icon: "₪" },
    CREATE_INVOICE_DRAFT: { label: "הכן תשלום", icon: "₪" },
    CHECK_PRODUCT_AVAILABILITY: { label: "בדוק זמינות", icon: "✓" },
    BOOK_APPOINTMENT: { label: "תאם זמן", icon: "◷" },
  };
  return byId[actionId] ?? { label: "פעולה מומלצת", icon: "•" };
}

function fallbackQuickActions(
  item: InboxItemViewModel | null,
  opts?: { skipProductLink?: boolean }
): QuickActionChip[] {
  const situation = item?.businessSituation?.kind;
  if (situation === "QUOTE_WAITING") {
    return [
      {
        key: "follow_up_quote",
        label: "מעקב להצעה",
        icon: "↺",
        tone: "primary",
        text: "רק מוודא שההצעה ברורה ואם יש משהו שתרצה שאחדד.",
      },
    ];
  }
  if (situation === "BOT_COLLECTING" || situation === "BOT_HANDOFF") {
    return [];
  }
  if (situation === "NEW_LEAD" || situation === "CUSTOMER_WAITING") {
    const chips: QuickActionChip[] = [
      {
        key: "ask_details",
        label: "בקש עוד פרט",
        icon: "?",
        tone: "default",
        text: quickReplyText("ask_details"),
      },
    ];
    if (!opts?.skipProductLink) {
      chips.push({
        key: "product_link",
        label: "שלח קישור למוצר",
        icon: "↗",
        tone: "default",
        text: quickReplyText("product_link"),
      });
    }
    return chips;
  }
  return [
    {
      key: "follow_up",
      label: "מעקב קצר",
      icon: "↺",
      tone: "default",
      text: quickReplyText("follow_up"),
    },
  ];
}

function buildQuickActionChips(
  item: InboxItemViewModel | null,
  productLinkPrefill?: { intro: string | null; url: string } | null
): QuickActionChip[] {
  const hasCatalogLink = !!productLinkPrefill?.url;
  const fromBusinessActions =
    item?.suggestedBusinessActions?.map((action) => {
      const meta = labelForBusinessAction(action.id);
      return {
        key: action.id,
        label: meta.label,
        icon: meta.icon,
        tone: action.id === "HANDOFF_TO_OWNER" ? "primary" : "default",
        text: textForBusinessAction(action.id, productLinkPrefill),
      } satisfies QuickActionChip;
    }) ?? [];

  const fallback = fallbackQuickActions(item, {
    skipProductLink: hasCatalogLink,
  });
  const doneAction: QuickActionChip = {
    key: "mark_done",
    label: "סיים שיחה",
    icon: "✓",
    tone: "success",
    closesConversation: true,
  };

  const merged = [...fromBusinessActions, ...fallback, doneAction];
  const seen = new Set<string>();
  return merged.filter((action) => {
    if (seen.has(action.key)) return false;
    seen.add(action.key);
    return true;
  }).slice(0, 5);
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function avatarAccentColor(item: InboxItemViewModel | null): string {
  if (!item?.businessSituation) return "#94a3b8";
  const byKind: Record<string, string> = {
    CUSTOMER_WAITING: "#dc2626",
    DRAFT_READY: "#6366f1",
    BOT_HANDOFF: "#ea580c",
    BOT_COLLECTING: "#16a34a",
    QUOTE_WAITING: "#b45309",
    FOLLOW_UP_DUE: "#7c3aed",
    WAITING_ON_CUSTOMER: "#2563eb",
    HOT_OPPORTUNITY: "#ea580c",
    NEW_LEAD: "#0891b2",
    ACTIVE: "#94a3b8",
    CLOSED: "#94a3b8",
  };
  return byKind[item.businessSituation.kind] ?? "#94a3b8";
}

/** Single ambient whisper — presentation only, no logic changes. */
function whisperLineForItem(
  item: InboxItemViewModel | null,
  viewMode: "OPEN" | "CLOSED"
): string | null {
  if (viewMode === "CLOSED") return "השיחה נסגרה";

  if (!item) return null;

  if (item.humanTakeoverActive) {
    return "אתה מטפל מכאן";
  }

  if (item.botFlowStatus === "IN_PROGRESS") {
    return "טיוטה מוכנה לשליחה";
  }

  if (item.botFlowStatus === "HANDOFF") {
    return "מחכה לך";
  }

  if (item.botFlowStatus === "COMPLETED") {
    return "סיום פתיחה — מחכה לך";
  }

  const kind = item.businessSituation?.kind;
  if (!kind) {
    return item.needsHumanAttention ? "ממתינה לתשובה שלך" : null;
  }

  const byKind: Partial<Record<string, string>> = {
    CUSTOMER_WAITING: "ממתינה לתשובה שלך",
    DRAFT_READY: "טיוטה מוכנה לשליחה",
    BOT_HANDOFF: "מחכה לך",
    BOT_COLLECTING: "טיוטה מוכנה לשליחה",
    QUOTE_WAITING: "ממתין לתשובה על ההצעה",
    FOLLOW_UP_DUE: "כדאי לחזור ללקוח",
    WAITING_ON_CUSTOMER: "ממתין לתשובת הלקוח",
    HOT_OPPORTUNITY: "הזדמנות חמה",
    NEW_LEAD: "פנייה חדשה",
    CLOSED: "השיחה נסגרה",
  };

  if (kind === "ACTIVE") {
    return item.needsHumanAttention ? "ממתינה לתשובה שלך" : null;
  }

  const mapped = byKind[kind];
  if (mapped) return mapped;
  return item.businessSituation?.shortLabel ?? null;
}

type ReplyOption =
  | { kind: "suggestion"; key: string; label: string; suggestion: Suggestion }
  | { kind: "action"; key: string; label: string; text: string };

function buildReplyOptions(
  suggestions: Suggestion[],
  quickActionChips: QuickActionChip[],
  activeItem: InboxItemViewModel | null
): ReplyOption[] {
  const generated = suggestions.filter((s) => s.status === "GENERATED");

  const starter = generated
    .filter((s) => s.suggestionType === "STARTER_BOT_DRAFT")
    .slice(0, 1);
  const auto = generated
    .filter((s) => s.suggestionType !== "STARTER_BOT_DRAFT")
    .slice(0, 2);

  const options: ReplyOption[] = [];

  starter.forEach((s) => {
    options.push({
      kind: "suggestion",
      key: `suggestion-${s.id}`,
      label: compactSuggestionLabel(s),
      suggestion: s,
    });
  });

  auto.forEach((s) => {
    options.push({
      kind: "suggestion",
      key: `suggestion-${s.id}`,
      label: compactSuggestionLabel(s),
      suggestion: s,
    });
  });

  const hasDrafts = starter.length + auto.length > 0;
  const botActive =
    activeItem?.botFlowStatus === "IN_PROGRESS" ||
    activeItem?.botFlowStatus === "HANDOFF";

  const actionCandidates = quickActionChips.filter(
    (a) => !a.closesConversation && a.text
  );

  let actionsToShow = actionCandidates;
  if (hasDrafts || botActive) {
    actionsToShow = actionCandidates.filter(
      (a) =>
        a.key === "SHOW_PRODUCT_LINK" ||
        a.key === "HANDOFF_TO_OWNER" ||
        a.key === "product_link"
    );
    if (actionsToShow.some((a) => a.key === "SHOW_PRODUCT_LINK")) {
      actionsToShow = actionsToShow.filter((a) => a.key !== "product_link");
    }
    actionsToShow = actionsToShow.slice(0, 1);
  } else {
    actionsToShow = actionsToShow.slice(0, 2);
  }

  actionsToShow.forEach((action) => {
    options.push({
      kind: "action",
      key: action.key,
      label: action.label,
      text: action.text!,
    });
  });

  const seen = new Set<string>();
  return options.filter((opt) => {
    if (seen.has(opt.label)) return false;
    seen.add(opt.label);
    return true;
  });
}

function canShowTakeOver(item: InboxItemViewModel | null): boolean {
  if (!item || item.humanTakeoverActive) return false;
  return (
    item.botFlowStatus === "IN_PROGRESS" || item.botFlowStatus === "HANDOFF"
  );
}

export function ConversationView(props: {
  isMobile: boolean;
  viewMode: "OPEN" | "CLOSED";
  activeConversationId: number | null;
  activeConversation: Conversation | null;
  activeItem?: InboxItemViewModel | null;
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
  onBack?: () => void;
  onTakeOverConversation?: () => void;
  takeOverBusy?: boolean;
  productLinkPrefill?: { intro: string | null; url: string } | null;
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
    activeItem = null,
    messages,
    suggestions,
    input,
    onInputChange,
    onCloseConversation,
    onChooseSuggestion,
    onManualReply,
    onSendBusinessMessage,
    onSimulateCustomerMessage,
    onBack,
    onTakeOverConversation,
    takeOverBusy = false,
    productLinkPrefill = null,
    styles,
  } = props;

  const [menuOpen, setMenuOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const hasDraft = input.trim().length > 0;
  const headerTitle = resolveTitle(activeItem);
  const whisperLine = whisperLineForItem(activeItem, viewMode);
  const accentColor = avatarAccentColor(activeItem);
  const quickActionChips = buildQuickActionChips(activeItem, productLinkPrefill);
  const replyOptions = buildReplyOptions(
    suggestions,
    quickActionChips,
    activeItem
  );

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
  }, [activeConversationId, messages.length]);

  useEffect(() => {
    if (!menuOpen) return;
    function handlePointerDown(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [menuOpen]);

  const composerMinHeight = hasDraft ? 40 : 36;

  return (
    <div
      style={{
        flex: "1 1 420px",
        minWidth: 0,
        width: "100%",
        maxWidth: "100%",
        display: "flex",
        flexDirection: "column",
        minHeight: isMobile ? "100%" : "calc(100vh - 48px)",
        background: INBOX_SURFACE.chatBg,
        boxSizing: "border-box",
        overflow: "hidden",
        position: "relative",
      }}
    >
      {!activeConversationId && !isMobile && (
        <div
          style={{
            margin: 24,
            background: INBOX_SURFACE.cardBg,
            border: `1px solid ${INBOX_SURFACE.border}`,
            borderRadius: 16,
            padding: 24,
          }}
        >
          <h2 style={{ marginTop: 0, color: "#111827", fontSize: 18 }}>בחר שיחה</h2>
          <div style={{ color: "#64748b", lineHeight: 1.6, fontSize: 14 }}>
            בחר שיחה מהרשימה כדי להמשיך את השיחה עם הלקוח.
          </div>
        </div>
      )}

      {activeConversationId && (
        <>
          {/* Slim header */}
          <header
            style={{
              flexShrink: 0,
              background: INBOX_SURFACE.cardBg,
              borderBottom: `1px solid ${INBOX_SURFACE.border}`,
              padding: isMobile ? "8px 10px" : "10px 14px",
              display: "flex",
              alignItems: "center",
              gap: 8,
              zIndex: 2,
            }}
          >
            {isMobile && onBack ? (
              <button
                type="button"
                onClick={onBack}
                aria-label="חזרה לשיחות"
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 999,
                  border: "none",
                  background: "transparent",
                  color: "#64748b",
                  fontSize: 20,
                  cursor: "pointer",
                  flexShrink: 0,
                }}
              >
                →
              </button>
            ) : null}

            <div style={{ position: "relative", flexShrink: 0 }}>
              <div
                aria-hidden
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 999,
                  background: "#f1f5f9",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 13,
                  fontWeight: 800,
                  color: "#475569",
                }}
              >
                {initials(headerTitle)}
              </div>
              {whisperLine && viewMode === "OPEN" ? (
                <span
                  aria-hidden
                  style={{
                    position: "absolute",
                    bottom: 0,
                    left: 0,
                    width: 10,
                    height: 10,
                    borderRadius: 999,
                    background: accentColor,
                    border: "2px solid #ffffff",
                  }}
                />
              ) : null}
            </div>

            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 800,
                  color: "#111827",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  lineHeight: 1.25,
                }}
              >
                {headerTitle}
              </div>
              {whisperLine ? (
                <div
                  style={{
                    fontSize: 12,
                    color: accentColor,
                    fontWeight: 600,
                    marginTop: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {whisperLine}
                </div>
              ) : null}
            </div>

            {viewMode === "OPEN" ? (
              <div ref={menuRef} style={{ position: "relative", flexShrink: 0 }}>
                <button
                  type="button"
                  aria-label="אפשרויות"
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen((open) => !open)}
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 999,
                    border: "none",
                    background: "transparent",
                    color: "#94a3b8",
                    fontSize: 20,
                    fontWeight: 700,
                    cursor: "pointer",
                    lineHeight: 1,
                  }}
                >
                  ⋮
                </button>
                {menuOpen ? (
                  <div
                    role="menu"
                    style={{
                      position: "absolute",
                      top: "100%",
                      left: 0,
                      marginTop: 4,
                      minWidth: 168,
                      background: "#ffffff",
                      border: `1px solid ${INBOX_SURFACE.border}`,
                      borderRadius: 12,
                      boxShadow: "0 8px 24px rgba(15, 23, 42, 0.12)",
                      padding: 4,
                      zIndex: 30,
                    }}
                  >
                    {onTakeOverConversation && canShowTakeOver(activeItem) ? (
                      <button
                        type="button"
                        role="menuitem"
                        disabled={takeOverBusy}
                        onClick={() => {
                          setMenuOpen(false);
                          onTakeOverConversation();
                        }}
                        style={{
                          width: "100%",
                          border: "none",
                          background: "transparent",
                          color: "#334155",
                          fontSize: 13,
                          fontWeight: 700,
                          padding: "10px 12px",
                          borderRadius: 8,
                          cursor: takeOverBusy ? "wait" : "pointer",
                          textAlign: "right",
                        }}
                      >
                        אני מטפל מכאן
                      </button>
                    ) : null}
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        onCloseConversation();
                      }}
                      style={{
                        width: "100%",
                        border: "none",
                        background: "transparent",
                        color: "#64748b",
                        fontSize: 13,
                        fontWeight: 600,
                        padding: "10px 12px",
                        borderRadius: 8,
                        cursor: "pointer",
                        textAlign: "right",
                      }}
                    >
                      סיים שיחה
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </header>

          {viewMode === "OPEN" &&
          onTakeOverConversation &&
          canShowTakeOver(activeItem) ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                padding: "8px 18px",
                borderBottom: `1px solid ${INBOX_SURFACE.border}`,
                background: "#f8fafc",
              }}
            >
              <span style={{ fontSize: 12, color: "#64748b", lineHeight: 1.4 }}>
                אפשר לקחת שליטה בכל רגע
              </span>
              <button
                type="button"
                disabled={takeOverBusy}
                onClick={() => onTakeOverConversation()}
                style={{
                  flexShrink: 0,
                  border: "1px solid #cbd5e1",
                  borderRadius: 999,
                  background: "#ffffff",
                  color: "#334155",
                  fontSize: 13,
                  fontWeight: 700,
                  padding: "7px 14px",
                  cursor: takeOverBusy ? "wait" : "pointer",
                  fontFamily: "inherit",
                }}
              >
                אני מטפל מכאן
              </button>
            </div>
          ) : null}

          {/* Messages — center of gravity */}
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              overflowX: "hidden",
              padding: isMobile ? "8px 10px 4px" : "10px 14px 4px",
              background: INBOX_SURFACE.chatBg,
            }}
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 2,
                minHeight: "min-content",
              }}
            >
              {messages.length === 0 && (
                <div
                  style={{
                    alignSelf: "center",
                    color: "#94a3b8",
                    fontSize: 13,
                    padding: "24px 8px",
                  }}
                >
                  אין הודעות עדיין
                </div>
              )}

              {messages.map((msg) => {
                const isBusiness = msg.senderType === "BUSINESS_USER";

                return (
                  <div
                    key={msg.id}
                    style={{
                      display: "flex",
                      justifyContent: isBusiness ? "flex-start" : "flex-end",
                      padding: "1px 0",
                    }}
                  >
                    <div
                      style={{
                        maxWidth: isMobile ? "88%" : "72%",
                        padding: isBusiness ? "8px 12px 6px" : "8px 12px 6px",
                        borderRadius: isBusiness
                          ? "14px 14px 4px 14px"
                          : "14px 14px 14px 4px",
                        background: isBusiness ? INBOX_SURFACE.greenBubble : "#ffffff",
                        border: isBusiness ? "none" : `1px solid ${INBOX_SURFACE.border}`,
                        boxSizing: "border-box",
                        overflowWrap: "anywhere",
                        wordBreak: "break-word",
                      }}
                    >
                      <div style={{ color: "#111827", lineHeight: 1.5, fontSize: 14.5 }}>
                        {msg.contentText}
                      </div>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "flex-end",
                          marginTop: 2,
                          color: "#94a3b8",
                          fontSize: 10,
                          fontWeight: 500,
                        }}
                      >
                        <span>{formatMessageTime(msg.createdAt)}</span>
                        {isBusiness ? (
                          <span style={{ color: "#22c55e", marginRight: 4 }}>✓</span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} aria-hidden style={{ height: 4 }} />
            </div>
          </div>

          {/* Sticky composer + quick replies */}
          {viewMode === "OPEN" && (
            <footer
              style={{
                flexShrink: 0,
                position: "sticky",
                bottom: 0,
                zIndex: 3,
                background: INBOX_SURFACE.chatBg,
                padding: isMobile ? "6px 8px 10px" : "8px 12px 12px",
                paddingBottom: isMobile
                  ? "max(10px, env(safe-area-inset-bottom))"
                  : 12,
              }}
            >
              {replyOptions.length > 0 && (
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    overflowX: "auto",
                    paddingBottom: 8,
                    WebkitOverflowScrolling: "touch",
                    scrollbarWidth: "none",
                  }}
                >
                  {replyOptions.map((option) => (
                    <button
                      key={option.key}
                      type="button"
                      onClick={() => {
                        if (option.kind === "suggestion") {
                          onChooseSuggestion(option.suggestion);
                        } else {
                          onInputChange(option.text);
                        }
                      }}
                      style={{
                        flexShrink: 0,
                        border: "none",
                        background: "rgba(255, 255, 255, 0.92)",
                        borderRadius: 999,
                        padding: "8px 14px",
                        fontSize: 13,
                        fontWeight: 650,
                        color: "#334155",
                        cursor: "pointer",
                        boxShadow: "0 1px 2px rgba(15, 23, 42, 0.06)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              )}

              <div
                style={{
                  display: "flex",
                  alignItems: "flex-end",
                  gap: 6,
                  background: "#ffffff",
                  borderRadius: 24,
                  padding: "4px 6px 4px 8px",
                  boxShadow: "0 1px 3px rgba(15, 23, 42, 0.08)",
                }}
              >
                <button
                  type="button"
                  aria-label="צרף קובץ"
                  onClick={() => {
                    if (!input.trim()) onInputChange("");
                  }}
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 999,
                    border: "none",
                    background: "transparent",
                    color: "#94a3b8",
                    fontSize: 18,
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  📎
                </button>
                <textarea
                  value={input}
                  onChange={(e) => onInputChange(e.target.value)}
                  rows={1}
                  style={{
                    flex: 1,
                    minHeight: composerMinHeight,
                    maxHeight: 120,
                    padding: "8px 4px",
                    boxSizing: "border-box",
                    border: "none",
                    resize: "none",
                    fontFamily: "inherit",
                    fontSize: 15,
                    lineHeight: 1.4,
                    outline: "none",
                    color: "#111827",
                    background: "transparent",
                  }}
                  placeholder="הודעה"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      if (hasDraft) onSendBusinessMessage();
                    }
                  }}
                />
                {hasDraft ? (
                  <button
                    type="button"
                    onClick={onManualReply}
                    aria-label="נקה"
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 999,
                      border: "none",
                      background: "transparent",
                      color: "#94a3b8",
                      fontSize: 16,
                      cursor: "pointer",
                      flexShrink: 0,
                    }}
                  >
                    ×
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={!hasDraft}
                  onClick={onSendBusinessMessage}
                  aria-label="שלח"
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 999,
                    border: "none",
                    background: INBOX_SURFACE.purple,
                    color: "#ffffff",
                    fontSize: 16,
                    cursor: hasDraft ? "pointer" : "default",
                    opacity: hasDraft ? 1 : 0.35,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                    transition: "opacity 0.15s ease",
                  }}
                >
                  ➤
                </button>
              </div>

              {process.env.NODE_ENV === "development" && (
                <button
                  type="button"
                  onClick={onSimulateCustomerMessage}
                  style={{
                    ...styles.softButtonStyle,
                    marginTop: 6,
                    minHeight: 28,
                    padding: "4px 8px",
                    boxShadow: "none",
                    fontSize: 10,
                    width: "100%",
                    opacity: 0.7,
                  }}
                >
                  תצוגה: הודעת לקוח
                </button>
              )}
            </footer>
          )}
        </>
      )}
    </div>
  );
}
