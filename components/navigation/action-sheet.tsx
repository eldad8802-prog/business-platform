"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type ActionSheetProps = {
  open: boolean;
  onClose: () => void;
};

/** Above bottom bar (100), below heavy in-app modals (~200). */
const OVERLAY_Z = 150;

const TRANS_MS = 240;
const EASE_OUT = "cubic-bezier(0.32, 0.72, 0, 1)";
const EASE_IN = "cubic-bezier(0.4, 0, 1, 1)";

const QUICK_ACTIONS: {
  label: string;
  href: string;
  icon:
    | "upload"
    | "invoice"
    | "chat"
    | "content"
    | "inventory"
    | "secretary"
    | "payments";
}[] = [
  { label: "המזכירה", href: "/secretary", icon: "secretary" },
  { label: "סליקה", href: "/payments", icon: "payments" },
  { label: "העלאת מסמך", href: "/documents/upload", icon: "upload" },
  { label: "חשבונית חדשה", href: "/billing", icon: "invoice" },
  { label: "שיחה חדשה", href: "/inbox", icon: "chat" },
  { label: "יצירת תוכן", href: "/content", icon: "content" },
  { label: "מלאי", href: "/inventory", icon: "inventory" },
];

/**
 * Static quick actions from the FAB — no server / AI / registry.
 * When fully closed after exit animation, renders nothing (no overlay in DOM).
 */
export function ActionSheet({ open, onClose }: ActionSheetProps) {
  const router = useRouter();
  const [isPresent, setIsPresent] = useState(open);
  const [visualOpen, setVisualOpen] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enterRafRef = useRef<number | null>(null);

  useEffect(() => {
    if (open) {
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
      setIsPresent(true);
      setVisualOpen(false);
      enterRafRef.current = requestAnimationFrame(() => {
        enterRafRef.current = requestAnimationFrame(() => {
          setVisualOpen(true);
          enterRafRef.current = null;
        });
      });
      return () => {
        if (enterRafRef.current != null) {
          cancelAnimationFrame(enterRafRef.current);
          enterRafRef.current = null;
        }
      };
    }

    setVisualOpen(false);
    closeTimerRef.current = setTimeout(() => {
      setIsPresent(false);
      closeTimerRef.current = null;
    }, TRANS_MS);

    return () => {
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    };
  }, [open]);

  useEffect(() => {
    if (!isPresent || !visualOpen) return;

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [isPresent, visualOpen]);

  useEffect(() => {
    if (!isPresent) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isPresent, onClose]);

  if (!isPresent) {
    return null;
  }

  function go(href: string) {
    router.push(href);
    onClose();
  }

  const overlayOpacity = visualOpen ? 1 : 0;
  const sheetTransform = visualOpen ? "translate3d(0, 0, 0)" : "translate3d(0, 108%, 0)";

  return (
    <div
      dir="rtl"
      inert={!visualOpen}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: OVERLAY_Z,
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
        /* Root must not steal hits when children are pointer-events: none (e.g. exit / pre-open). */
        pointerEvents: "none",
        WebkitTapHighlightColor: "transparent",
      }}
    >
      <div
        role="presentation"
        aria-hidden={!visualOpen}
        onClick={onClose}
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(15, 23, 42, 0.42)",
          opacity: overlayOpacity,
          transition: `opacity ${TRANS_MS}ms ${visualOpen ? EASE_OUT : EASE_IN}`,
          pointerEvents: visualOpen ? "auto" : "none",
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="פעולות מהירות"
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "relative",
          zIndex: 1,
          width: "100%",
          maxWidth: 440,
          maxHeight: "min(78vh, 560px)",
          overflowY: "auto",
          WebkitOverflowScrolling: "touch",
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
          background: "rgba(255, 255, 255, 0.98)",
          boxShadow:
            "0 -8px 32px rgba(15, 23, 42, 0.08), 0 -2px 12px rgba(15, 23, 42, 0.04)",
          transform: sheetTransform,
          transition: `transform ${TRANS_MS}ms ${visualOpen ? EASE_OUT : EASE_IN}`,
          willChange: "transform",
          padding:
            "10px 14px calc(18px + env(safe-area-inset-bottom, 0px)) 14px",
          pointerEvents: visualOpen ? "auto" : "none",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            marginBottom: 10,
          }}
        >
          <div
            aria-hidden
            style={{
              width: 40,
              height: 4,
              borderRadius: 999,
              background: "rgba(15, 23, 42, 0.12)",
              marginBottom: 12,
            }}
          />
        </div>

        <div
          style={{
            fontSize: 17,
            fontWeight: 800,
            color: "#0f172a",
            marginBottom: 4,
            textAlign: "right",
            letterSpacing: "-0.02em",
          }}
        >
          פעולות מהירות
        </div>
        <p
          style={{
            margin: "0 0 16px",
            fontSize: 13,
            color: "#64748b",
            lineHeight: 1.45,
            textAlign: "right",
          }}
        >
          בחירה מהירה — ללא המלצות דינמיות
        </p>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
            gap: 10,
          }}
        >
          {QUICK_ACTIONS.map((item, index) => (
            <button
              key={item.href}
              type="button"
              onClick={() => go(item.href)}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "stretch",
                justifyContent: "center",
                gap: 10,
                minHeight: 76,
                padding: "14px 12px",
                borderRadius: 16,
                border: "1px solid rgba(148, 163, 184, 0.35)",
                background:
                  "linear-gradient(180deg, #ffffff 0%, #f8fafc 100%)",
                cursor: "pointer",
                textAlign: "right",
                touchAction: "manipulation",
                WebkitTapHighlightColor: "transparent",
                boxShadow: "0 1px 2px rgba(15, 23, 42, 0.04)",
                transition:
                  "transform 0.12s ease, box-shadow 0.12s ease, border-color 0.12s ease",
                ...(index === QUICK_ACTIONS.length - 1 &&
                QUICK_ACTIONS.length % 2 === 1
                  ? { gridColumn: "1 / -1" }
                  : {}),
              }}
            >
              <span
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "flex-end",
                  gap: 10,
                }}
              >
                <span
                  style={{
                    flex: 1,
                    fontSize: 14,
                    fontWeight: 700,
                    color: "#0f172a",
                    lineHeight: 1.25,
                  }}
                >
                  {item.label}
                </span>
                <span
                  style={{
                    flexShrink: 0,
                    width: 40,
                    height: 40,
                    borderRadius: 12,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: "rgba(63, 97, 156, 0.08)",
                    color: "#3F619C",
                  }}
                  aria-hidden
                >
                  <ActionGlyph kind={item.icon} />
                </span>
              </span>
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={onClose}
          style={{
            width: "100%",
            marginTop: 14,
            minHeight: 50,
            borderRadius: 16,
            border: "1px solid rgba(148, 163, 184, 0.4)",
            background: "#ffffff",
            fontSize: 15,
            fontWeight: 700,
            color: "#475569",
            cursor: "pointer",
            touchAction: "manipulation",
            WebkitTapHighlightColor: "transparent",
          }}
        >
          סגור
        </button>
      </div>
    </div>
  );
}

function ActionGlyph({
  kind,
}: {
  kind:
    | "upload"
    | "invoice"
    | "chat"
    | "content"
    | "inventory"
    | "secretary"
    | "payments";
}) {
  const stroke = 1.85;
  const size = 22;
  switch (kind) {
    case "secretary":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <path
            d="M9 4h6a1 1 0 0 1 1 1v1h2a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h2V5a1 1 0 0 1 1-1z"
            stroke="currentColor"
            strokeWidth={stroke}
            strokeLinejoin="round"
          />
          <path
            d="M9 13l2 2 4-4"
            stroke="currentColor"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "upload":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <path
            d="M12 5v10M8 9l4-4 4 4M5 19h14"
            stroke="currentColor"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "invoice":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <path
            d="M7 3h10l3 3v15a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"
            stroke="currentColor"
            strokeWidth={stroke}
            strokeLinejoin="round"
          />
          <path
            d="M14 3v4h4M8 12h8M8 16h5"
            stroke="currentColor"
            strokeWidth={stroke}
            strokeLinecap="round"
          />
        </svg>
      );
    case "chat":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <path
            d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"
            stroke="currentColor"
            strokeWidth={stroke}
            strokeLinejoin="round"
          />
        </svg>
      );
    case "content":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <path
            d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"
            stroke="currentColor"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "inventory":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <path
            d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"
            stroke="currentColor"
            strokeWidth={stroke}
            strokeLinejoin="round"
          />
          <path
            d="M3.27 6.96L12 12.01l8.73-5.05M12 22.08V12"
            stroke="currentColor"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "payments":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <rect
            x="2.5"
            y="5"
            width="19"
            height="14"
            rx="2.5"
            stroke="currentColor"
            strokeWidth={stroke}
            strokeLinejoin="round"
          />
          <path
            d="M2.5 9.5h19"
            stroke="currentColor"
            strokeWidth={stroke}
            strokeLinecap="round"
          />
          <path
            d="M6 15h4"
            stroke="currentColor"
            strokeWidth={stroke}
            strokeLinecap="round"
          />
        </svg>
      );
  }
}
