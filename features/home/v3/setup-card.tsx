"use client";

/**
 * "ההתחלה שלך" — Home's first-action card for a new business.
 *
 * One action, picked by the goal the owner chose in setup (or a DEFAULTED one
 * when they skipped), plus at most three short follow-ups. It disappears on its
 * own once the first action has happened and nothing is left to complete, and
 * the owner can hide it — a per-viewer convenience, so it is kept in
 * localStorage and nothing breaks when storage is unavailable.
 */

import Link from "next/link";
import { useState, type CSSProperties } from "react";

import type { SetupView } from "@/lib/services/onboarding/setup-model";

import { CARD, INK, LINE, MUTED, TEAL } from "./home-parts";
import type { Load } from "./home-v3-model";

const HIDE_KEY = "dz.home.setupCard.hidden";

function readHidden(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(HIDE_KEY) === "1";
  } catch {
    return false;
  }
}

export function SetupCard({
  setup,
  variant,
  style,
}: {
  setup: Load<SetupView>;
  variant: "mobile" | "tablet" | "desktop";
  style?: CSSProperties;
}) {
  // The card only renders once the client has loaded setup state, so reading
  // storage at first render cannot disagree with a server render.
  const [hidden, setHidden] = useState(readHidden);

  if (setup.state !== "ready") return null;
  const v = setup.value;
  // needsSetup → /app is already redirecting to /setup; settled → nothing to say.
  if (v.needsSetup || v.settled || hidden) return null;

  const wide = variant === "desktop";
  const action = v.startAction;

  const hide = () => {
    setHidden(true);
    try {
      window.localStorage.setItem(HIDE_KEY, "1");
    } catch {
      /* the card simply returns next visit */
    }
  };

  return (
    <section
      aria-labelledby="home-setup-title"
      style={{
        background: CARD,
        border: `1px solid ${LINE}`,
        borderRadius: wide ? 22 : 20,
        padding: wide ? "22px 24px" : 18,
        display: "flex",
        flexDirection: wide ? "row" : "column",
        gap: wide ? 28 : 16,
        alignItems: wide ? "stretch" : undefined,
        ...style,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: wide ? "1 1 0" : undefined, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: TEAL }}>ההתחלה שלך</span>
          <button
            type="button"
            onClick={hide}
            style={{ border: 0, background: "none", color: MUTED, fontSize: 13, cursor: "pointer", padding: 4 }}
          >
            הסתר
          </button>
        </div>
        <h2 id="home-setup-title" style={{ margin: 0, fontSize: wide ? 20 : 18, fontWeight: 600, color: INK }}>
          {action.done ? "הצעד הראשון מאחוריך" : action.title}
        </h2>
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: MUTED }}>
          {action.done ? "כל הכבוד. נשארו עוד כמה דברים קטנים שיעזרו ל-Dubiz לעבוד בשבילך." : action.body}
        </p>
        {!action.done && (
          <Link
            href={action.href}
            prefetch={false}
            style={{
              alignSelf: "flex-start",
              marginTop: 4,
              padding: "11px 18px",
              borderRadius: 14,
              background: TEAL,
              color: "#FFFFFF",
              fontSize: 15,
              fontWeight: 600,
              textDecoration: "none",
            }}
          >
            {action.cta}
          </Link>
        )}
      </div>

      {v.checklist.length > 0 && (
        <ul
          aria-label="עוד דברים שכדאי להשלים"
          style={{
            listStyle: "none",
            margin: 0,
            padding: wide ? "0 24px 0 0" : 0,
            borderInlineStart: wide ? `1px solid ${LINE}` : undefined,
            display: "flex",
            flexDirection: "column",
            gap: 4,
            flex: wide ? "0 1 340px" : undefined,
            justifyContent: "center",
          }}
        >
          {v.checklist.map((item) => (
            <li key={item.key}>
              <Link
                href={item.href}
                prefetch={false}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  minHeight: 44,
                  padding: "8px 2px",
                  color: INK,
                  fontSize: 15,
                  textDecoration: "none",
                  borderBottom: `1px solid ${LINE}`,
                }}
              >
                <span>{item.title}</span>
                <span aria-hidden style={{ color: MUTED }}>
                  ‹
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
