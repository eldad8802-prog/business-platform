"use client";

import Link from "next/link";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { MessageKey, Translator } from "@/lib/i18n/translate";
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
  const { t } = useI18n();
  return (
    <div className="inbox-start">
      <h2>{t("inbox.panels.startTitle")}</h2>
      <p>{t("inbox.panels.startBody")}</p>
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
            <b>{resolveConversationDisplayTitle(next, t)}</b>
            {next.signalLabel ? <span> · {next.signalLabel}</span> : null}
          </span>
          <span aria-hidden>{t("inbox.panels.open")}</span>
        </button>
      ) : null}
    </div>
  );
}

/** Brand names stay as-is; generic channels are translated. */
const CHANNEL_BRAND: Record<string, string> = {
  WHATSAPP: "WhatsApp",
  INSTAGRAM: "Instagram",
  FACEBOOK: "Facebook",
};
const CHANNEL_KEY: Record<string, MessageKey> = {
  EMAIL: "inbox.panels.channel.EMAIL",
  PHONE: "inbox.panels.channel.PHONE",
  OTHER: "inbox.panels.channel.OTHER",
};

function channelLabel(channel: string, t: Translator): string {
  const key = CHANNEL_KEY[channel];
  return CHANNEL_BRAND[channel] ?? (key ? t(key) : channel);
}

function waitingText(minutes: number | null, t: Translator): string | null {
  if (minutes == null || minutes <= 0) return null;
  if (minutes < 60) return t("inbox.panels.waitingMinutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? t("inbox.panels.waitingHourOne") : t("inbox.panels.waitingHours", { count: hours });
  const days = Math.floor(hours / 24);
  return days === 1 ? t("inbox.panels.waitingDayOne") : t("inbox.panels.waitingDays", { count: days });
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
  const { t } = useI18n();
  if (!item) return null;
  const waiting = waitingText(item.waitingMinutes, t);
  const nextStep = item.nextBestAction?.label || item.suggestedActionLabel;
  const rows: Array<{ label: string; value: string | null | undefined }> = [
    { label: t("inbox.panels.rows.channel"), value: channelLabel(item.channel, t) },
    { label: t("inbox.panels.rows.phone"), value: item.customerName ? item.customerPhone : null },
    { label: t("inbox.panels.rows.stage"), value: item.stageLabel },
    { label: t("inbox.panels.rows.situation"), value: item.businessSituation?.label ?? item.signalLabel },
    { label: t("inbox.panels.rows.waiting"), value: waiting },
    { label: t("inbox.panels.rows.bot"), value: item.humanTakeoverActive ? t("inbox.panels.youHandle") : item.botProgressLabel },
  ];
  return (
    <aside className="inbox-context" aria-label={t("inbox.panels.contextLabel")}>
      <h2>{resolveConversationDisplayTitle(item, t)}</h2>
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
          <span>{t("inbox.panels.nextStep")}</span>
          <b>{nextStep}</b>
          {item.businessSituation?.explanation ? <p>{item.businessSituation.explanation}</p> : null}
        </div>
      ) : null}
      {customerId ? (
        <Link href={`/customers/${customerId}`} className="inbox-context-link">
          {t("inbox.panels.customerCard")}
        </Link>
      ) : null}
    </aside>
  );
}
