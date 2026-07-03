"use client";

import { TOKEN } from "@/lib/design/tokens";
import { WA_COPY } from "@/components/whatsapp/wa-copy";
import { IconCheck, IconSearch } from "@/components/whatsapp/wa-icons";
import { WaBadge } from "@/components/whatsapp/wa-ui";

/**
 * Moment 3 — the Inbox's own empty state once WhatsApp is connected but no
 * customer messages have arrived yet.
 *
 * This is NOT a separate "success" screen: it keeps the Inbox chrome (title +
 * search) so the owner feels they've landed exactly where they'll work. Shown
 * by the Inbox when connected and there are zero conversations.
 */
export function InboxConnectedEmptyState() {
  const c = WA_COPY.inboxConnected;
  return (
    <div
      dir="rtl"
      style={{
        minHeight: "100vh",
        background: TOKEN.surface.page,
        display: "flex",
        flexDirection: "column",
        padding: `${TOKEN.space.lg}px ${TOKEN.space.lg}px 96px`,
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 480,
          margin: "0 auto",
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "4px 2px 12px",
          }}
        >
          <span style={{ fontSize: TOKEN.font.title, fontWeight: TOKEN.weight.bold, color: TOKEN.ink.primary }}>
            שיחות
          </span>
          <WaBadge tone="success" label={c.badge} />
        </div>

        <div
          aria-hidden
          style={{
            display: "flex",
            alignItems: "center",
            gap: TOKEN.space.sm,
            height: 40,
            borderRadius: TOKEN.radius.input,
            background: TOKEN.surface.inset,
            color: TOKEN.ink.meta,
            padding: `0 ${TOKEN.space.md}px`,
            fontSize: TOKEN.font.body,
            fontWeight: TOKEN.weight.medium,
          }}
        >
          <IconSearch size={15} />
          חיפוש שיחות…
        </div>

        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
            gap: TOKEN.space.lg,
            padding: `${TOKEN.space.lg}px ${TOKEN.space.sm}px`,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 60,
              height: 60,
              borderRadius: TOKEN.radius.modal,
              background: TOKEN.semantic.success.bg,
              color: TOKEN.semantic.success.ink,
              display: "grid",
              placeItems: "center",
            }}
          >
            <IconCheck size={30} />
          </span>
          <h2
            style={{
              margin: 0,
              fontSize: TOKEN.font.display,
              fontWeight: TOKEN.weight.bold,
              color: TOKEN.ink.primary,
              lineHeight: 1.3,
            }}
          >
            {c.heading}
          </h2>
          <p
            style={{
              margin: 0,
              maxWidth: "34ch",
              fontSize: TOKEN.font.body,
              fontWeight: TOKEN.weight.medium,
              color: TOKEN.ink.muted,
              lineHeight: 1.6,
            }}
          >
            {c.body}
          </p>
        </div>
      </div>
    </div>
  );
}
