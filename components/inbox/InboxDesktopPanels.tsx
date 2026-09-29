"use client";

import Link from "next/link";
import type { InboxItemViewModel } from "@/lib/inbox-view/inbox-item.types";
import { resolveConversationDisplayTitle } from "@/lib/inbox-view/conversation-display-title";

/**
 * Desktop-only Inbox panels. Everything shown here is already on the page:
 * the conversation items the list renders and the counts its tabs use. Nothing
 * is fetched, derived anew, or sent.
 */

type OverviewCard = { label: string; value: number; helper: string };

/**
 * The thread pane before a conversation is chosen. On a phone the list IS the
 * starting point; on desktop the empty half of the screen says where to start
 * and opens the most pressing conversation, instead of asking the owner to
 * pick one.
 */
export function InboxStartPane({
  cards,
  next,
  onOpen,
}: {
  cards: OverviewCard[];
  next: InboxItemViewModel | null;
  onOpen: (conversationId: number) => void;
}) {
  return (
    <div className="inbox-start">
      <h2>מה מחכה בשיחות</h2>
      <p>הרשימה מסודרת לפי מה שדחוף. אפשר להתחיל מלמעלה, או לבחור שיחה.</p>
      <div className="inbox-start-cards">
        {cards.map((card) => (
          <div key={card.label} className="inbox-start-card">
            <span className="inbox-start-label">{card.label}</span>
            <b>{card.value}</b>
            <span className="inbox-start-helper">{card.helper}</span>
          </div>
        ))}
      </div>
      {next ? (
        <button type="button" className="inbox-start-open" onClick={() => onOpen(next.conversationId)}>
          <span>
            <b>{resolveConversationDisplayTitle(next)}</b>
            {next.signalLabel ? <span> · {next.signalLabel}</span> : null}
          </span>
          <span aria-hidden>פתח ←</span>
        </button>
      ) : null}
    </div>
  );
}

const CHANNEL_LABEL: Record<string, string> = {
  WHATSAPP: "WhatsApp",
  INSTAGRAM: "Instagram",
  FACEBOOK: "Facebook",
  EMAIL: "אימייל",
  PHONE: "טלפון",
  OTHER: "אחר",
};

function waitingText(minutes: number | null): string | null {
  if (minutes == null || minutes <= 0) return null;
  if (minutes < 60) return `${minutes} דק׳`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "שעה" : `${hours} שעות`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "יום" : `${days} ימים`;
}

/**
 * Context beside the thread (from 1600): who this is and where the
 * conversation stands, from the same item the list row summarises. On a phone
 * this lives in the header and the row; desktop can keep it in view while the
 * owner reads and replies.
 */
export function InboxContextPane({
  item,
  customerId,
}: {
  item: InboxItemViewModel | null;
  customerId: number | null | undefined;
}) {
  if (!item) return null;
  const waiting = waitingText(item.waitingMinutes);
  const nextStep = item.nextBestAction?.label || item.suggestedActionLabel;
  const rows: Array<{ label: string; value: string | null | undefined }> = [
    { label: "ערוץ", value: CHANNEL_LABEL[item.channel] ?? item.channel },
    { label: "טלפון", value: item.customerName ? item.customerPhone : null },
    { label: "שלב", value: item.stageLabel },
    { label: "מצב", value: item.businessSituation?.label ?? item.signalLabel },
    { label: "מחכה לתשובה", value: waiting },
    { label: "הבוט", value: item.humanTakeoverActive ? "אתה מטפל בשיחה" : item.botProgressLabel },
  ];
  return (
    <aside className="inbox-context" aria-label="על השיחה">
      <h2>{resolveConversationDisplayTitle(item)}</h2>
      <dl>
        {rows
          .filter((row) => row.value)
          .map((row) => (
            <div key={row.label}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
      </dl>
      {nextStep ? (
        <div className="inbox-context-next">
          <span>הצעד הבא</span>
          <b>{nextStep}</b>
          {item.businessSituation?.explanation ? <p>{item.businessSituation.explanation}</p> : null}
        </div>
      ) : null}
      {customerId ? (
        <Link href={`/customers/${customerId}`} className="inbox-context-link">
          כרטיס הלקוח ←
        </Link>
      ) : null}
    </aside>
  );
}
