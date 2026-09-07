"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

/**
 * The notification centre.
 *
 * Reads the persisted notifications the inventory consumers write, and lets the
 * owner mark them seen. It is a consumption surface and nothing more: it never
 * resolves a problem, never dismisses one, and never decides what matters —
 * that already happened, server-side, before any of this was written.
 *
 * WHAT THE OWNER HAS TO UNDERSTAND IN SECONDS
 *
 *   unread   a soft mark and a heavier title. Noticeable, not shouting.
 *   active   the problem is still true. Says so in words, not only in colour.
 *   resolved the problem is over. Reads as history — muted, past tense.
 *
 * "Read" and "resolved" are deliberately never shown as the same thing. An
 * owner who has SEEN a critical stock alert has not fixed it, and the card goes
 * on saying the condition is open until the domain says otherwise.
 *
 * Severity colours mirror `app/(shell)/attention/page.tsx` and use the same
 * Mist tokens and the same Hebrew labels. They are restated here rather than
 * imported because that page is out of scope for this change; unifying the two
 * into one shared mapping is a small follow-up worth doing.
 */

type NotificationItem = {
  id: number;
  domain: string;
  semanticCategory: string;
  severity: string;
  entityType: string;
  entityId: number;
  title: string;
  summary: string | null;
  href: string;
  firstSurfacedAt: string;
  lastSurfacedAt: string;
  readAt: string | null;
  resolvedAt: string | null;
};

type Page = {
  notifications: NotificationItem[];
  unreadCount: number;
  nextCursor: number | null;
};

type Filter = "all" | "unread";

/** Mirrors the attention page's severity presentation. */
export function severityStyle(severity: string): { label: string; bg: string; color: string; border: string } {
  switch (severity) {
    case "CRITICAL":
      return { label: "קריטי", bg: "var(--dz-danger-bg-soft)", color: "var(--dz-danger)", border: "rgba(155, 70, 52, 0.22)" };
    case "HIGH":
      return { label: "גבוה", bg: "var(--dz-warning-bg-soft)", color: "var(--dz-warning)", border: "rgba(129, 90, 50, 0.22)" };
    case "MEDIUM":
      return { label: "בינוני", bg: "var(--dz-surface-muted)", color: "var(--dz-text-secondary)", border: "rgba(52, 60, 50, 0.1)" };
    default:
      return { label: severity, bg: "var(--dz-surface-muted)", color: "var(--dz-text-muted)", border: "rgba(52, 60, 50, 0.06)" };
  }
}

/**
 * Hebrew relative time, coarse on purpose. "לפני 3 שעות" is what the owner
 * needs; a timestamp to the minute is noise they have to decode.
 */
export function relativeTime(iso: string, now: number): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "כרגע";
  if (minutes < 60) return `לפני ${minutes} דק׳`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `לפני ${hours} שע׳`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "אתמול";
  if (days < 30) return `לפני ${days} ימים`;
  return new Date(iso).toLocaleDateString("he-IL");
}

/** Internal links only. An href from the server is still not a reason to leave the app. */
export function isSafeInternalHref(href: string): boolean {
  return typeof href === "string" && href.startsWith("/") && !href.startsWith("//");
}

export function NotificationCenter() {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [cursor, setCursor] = useState<number | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [loadingMore, setLoadingMore] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  /**
   * One fetch path for both the first page and "load more" — `append` is the
   * only difference, so the two can never drift into different parsing.
   */
  const load = useCallback(
    async (opts: { append: boolean; cursor: number | null; filter: Filter }) => {
      const params = new URLSearchParams();
      if (opts.cursor !== null) params.set("cursor", String(opts.cursor));
      if (opts.filter === "unread") params.set("unreadOnly", "true");

      const res = await fetch(`/api/notifications?${params.toString()}`, {
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const page = (await res.json()) as Page;
      setItems((prev) => (opts.append ? [...prev, ...page.notifications] : page.notifications));
      setUnreadCount(page.unreadCount);
      setCursor(page.nextCursor);
      setNow(Date.now());
    },
    [],
  );

  // Fetched when the centre opens and after the owner changes the filter. No
  // polling: a notification the owner has not opened the app to see is exactly
  // what push is for, later.
  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    load({ append: false, cursor: null, filter })
      .then(() => {
        if (!cancelled) setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [filter, load]);

  /**
   * Mark one read. Optimistic, because the failure is recoverable and harmless:
   * the worst case is a row that looks read until the next load, and the item
   * itself is never removed from the list. On failure the mark is rolled back
   * rather than silently kept.
   */
  const markRead = useCallback(async (id: number) => {
    let wasUnread = false;
    setItems((prev) =>
      prev.map((n) => {
        if (n.id !== id || n.readAt !== null) return n;
        wasUnread = true;
        return { ...n, readAt: new Date().toISOString() };
      }),
    );
    if (!wasUnread) return;
    setUnreadCount((c) => Math.max(0, c - 1));

    try {
      const res = await fetch(`/api/notifications/${id}/read`, { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      setItems((prev) => prev.map((n) => (n.id === id ? { ...n, readAt: null } : n)));
      setUnreadCount((c) => c + 1);
    }
  }, []);

  /**
   * Clear the badge. Not optimistic: it is a bulk write, and the honest number
   * afterwards is the server's, so this reloads rather than guessing.
   */
  const markAllRead = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications/read-all", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load({ append: false, cursor: null, filter });
    } catch {
      setStatus("error");
    }
  }, [filter, load]);

  const loadMore = useCallback(async () => {
    if (cursor === null || loadingMore) return;
    setLoadingMore(true);
    try {
      await load({ append: true, cursor, filter });
    } catch {
      setStatus("error");
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, filter, load, loadingMore]);

  return (
    <div dir="rtl" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "var(--dz-text-primary)", margin: 0 }}>
          התראות
        </h1>
        {unreadCount > 0 ? (
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "var(--dz-text-secondary)",
              background: "var(--dz-surface-muted)",
              borderRadius: 999,
              padding: "2px 10px",
            }}
          >
            {unreadCount} חדשות
          </span>
        ) : null}

        <div style={{ marginInlineStart: "auto", display: "flex", gap: 8 }}>
          {/* A filter, not a tab bar: two states is all a first release earns. */}
          <div role="group" aria-label="סינון התראות" style={{ display: "flex", gap: 4 }}>
            {(["all", "unread"] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                aria-pressed={filter === f}
                style={{
                  border: "1px solid var(--dz-border-subtle, rgba(52,60,50,0.12))",
                  background: filter === f ? "var(--dz-surface-muted)" : "transparent",
                  color: filter === f ? "var(--dz-text-primary)" : "var(--dz-text-secondary)",
                  fontWeight: filter === f ? 600 : 500,
                  borderRadius: 999,
                  padding: "6px 14px",
                  minHeight: 36,
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                {f === "all" ? "הכול" : "לא נקראו"}
              </button>
            ))}
          </div>

          {unreadCount > 0 ? (
            <button
              type="button"
              onClick={markAllRead}
              style={{
                border: "1px solid var(--dz-border-subtle, rgba(52,60,50,0.12))",
                background: "transparent",
                color: "var(--dz-text-secondary)",
                borderRadius: 999,
                padding: "6px 14px",
                minHeight: 36,
                fontSize: 13,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              סמן הכל כנקרא
            </button>
          ) : null}
        </div>
      </header>

      {status === "loading" ? (
        <p role="status" style={{ color: "var(--dz-text-muted)", fontSize: 14 }}>
          טוען התראות…
        </p>
      ) : null}

      {status === "error" ? (
        <div
          role="alert"
          style={{
            border: "1px solid rgba(155, 70, 52, 0.22)",
            background: "var(--dz-danger-bg-soft)",
            borderRadius: 12,
            padding: 16,
            display: "flex",
            flexDirection: "column",
            gap: 10,
            alignItems: "flex-start",
          }}
        >
          <p style={{ margin: 0, color: "var(--dz-danger)", fontSize: 14, fontWeight: 600 }}>
            לא הצלחנו לטעון את ההתראות.
          </p>
          <button
            type="button"
            onClick={() => setFilter((f) => f)}
            onMouseDown={() => {
              setStatus("loading");
              load({ append: false, cursor: null, filter })
                .then(() => setStatus("ready"))
                .catch(() => setStatus("error"));
            }}
            style={{
              border: "1px solid rgba(155, 70, 52, 0.22)",
              background: "transparent",
              color: "var(--dz-danger)",
              borderRadius: 999,
              padding: "6px 14px",
              minHeight: 36,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            נסה שוב
          </button>
        </div>
      ) : null}

      {status === "ready" && items.length === 0 ? (
        <p style={{ color: "var(--dz-text-muted)", fontSize: 14, lineHeight: 1.7 }}>
          {filter === "unread"
            ? "אין התראות שלא נקראו."
            : "אין התראות. כשמשהו ידרוש תשומת לב — הוא יופיע כאן."}
        </p>
      ) : null}

      {status === "ready" && items.length > 0 ? (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10 }}>
          {items.map((n) => {
            const sev = severityStyle(n.severity);
            const unread = n.readAt === null;
            const resolved = n.resolvedAt !== null;
            const linkable = isSafeInternalHref(n.href);

            const card = (
              <article
                style={{
                  border: `1px solid ${resolved ? "rgba(52,60,50,0.08)" : sev.border}`,
                  background: resolved ? "var(--dz-surface-muted)" : "var(--dz-surface-raised, var(--dz-surface-muted))",
                  borderRadius: 14,
                  padding: 14,
                  display: "flex",
                  gap: 12,
                  alignItems: "flex-start",
                  opacity: resolved ? 0.72 : 1,
                }}
              >
                {/* Unread mark. Never the only signal — the title weight and the
                    screen-reader label below carry it too. */}
                <span
                  aria-hidden="true"
                  style={{
                    marginTop: 6,
                    width: 8,
                    height: 8,
                    flex: "0 0 auto",
                    borderRadius: 999,
                    background: unread && !resolved ? sev.color : "transparent",
                  }}
                />

                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 4 }}>
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        color: resolved ? "var(--dz-text-muted)" : sev.color,
                        background: resolved ? "transparent" : sev.bg,
                        border: `1px solid ${resolved ? "rgba(52,60,50,0.12)" : sev.border}`,
                        borderRadius: 999,
                        padding: "1px 8px",
                      }}
                    >
                      {sev.label}
                    </span>
                    <span style={{ fontSize: 12, color: "var(--dz-text-muted)" }}>
                      {resolved ? "נפתר" : "פעיל"}
                    </span>
                    <span style={{ fontSize: 12, color: "var(--dz-text-muted)", marginInlineStart: "auto" }}>
                      {relativeTime(n.lastSurfacedAt, now)}
                    </span>
                  </div>

                  <p
                    style={{
                      margin: 0,
                      fontSize: 15,
                      lineHeight: 1.5,
                      overflowWrap: "anywhere",
                      fontWeight: unread && !resolved ? 700 : 500,
                      color: resolved ? "var(--dz-text-secondary)" : "var(--dz-text-primary)",
                    }}
                  >
                    {n.title}
                  </p>

                  {n.summary ? (
                    <p
                      style={{
                        margin: "4px 0 0",
                        fontSize: 13,
                        lineHeight: 1.6,
                        color: "var(--dz-text-secondary)",
                        overflowWrap: "anywhere",
                      }}
                    >
                      {n.summary}
                    </p>
                  ) : null}

                  {/* The state in words, for anyone not seeing the colours. */}
                  <span className="sr-only">
                    {unread ? "לא נקראה. " : "נקראה. "}
                    {resolved ? "הבעיה נפתרה." : "הבעיה עדיין פעילה."}
                  </span>
                </div>
              </article>
            );

            return (
              <li key={n.id}>
                {linkable ? (
                  <Link
                    href={n.href}
                    onClick={() => void markRead(n.id)}
                    style={{ display: "block", textDecoration: "none", color: "inherit", borderRadius: 14 }}
                  >
                    {card}
                  </Link>
                ) : (
                  <div
                    role={unread ? "button" : undefined}
                    tabIndex={unread ? 0 : undefined}
                    onClick={unread ? () => void markRead(n.id) : undefined}
                    onKeyDown={
                      unread
                        ? (e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              void markRead(n.id);
                            }
                          }
                        : undefined
                    }
                    style={{ borderRadius: 14, cursor: unread ? "pointer" : "default" }}
                  >
                    {card}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}

      {status === "ready" && cursor !== null ? (
        <button
          type="button"
          onClick={loadMore}
          disabled={loadingMore}
          style={{
            alignSelf: "center",
            border: "1px solid var(--dz-border-subtle, rgba(52,60,50,0.12))",
            background: "transparent",
            color: "var(--dz-text-secondary)",
            borderRadius: 999,
            padding: "8px 20px",
            minHeight: 40,
            fontSize: 13,
            cursor: loadingMore ? "default" : "pointer",
          }}
        >
          {loadingMore ? "טוען…" : "טען עוד"}
        </button>
      ) : null}
    </div>
  );
}
