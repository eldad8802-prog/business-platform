"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { useI18n } from "@/components/i18n/I18nProvider";
import { createActionsFor, createLimitedNote, type CreateAction } from "@/features/home/v4/home-v4-model";
import { useLimitedCopy } from "@/features/home/v4/limited-copy-loader";
import { useHomeAccess } from "@/features/home/v4/use-home-access";

type ActionSheetProps = {
  open: boolean;
  onClose: () => void;
};

/** Above bottom bar (100), below heavy in-app modals (~200). */
const OVERLAY_Z = 150;

const TRANS_MS = 240;
const EASE_OUT = "cubic-bezier(0.32, 0.72, 0, 1)";
const EASE_IN = "cubic-bezier(0.4, 0, 1, 1)";

/**
 * "+" OWNS CREATION, and every entry here must START something (a deep link that opens the real create flow).
 *
 * HOME v4: the list is no longer static. It is `createActionsFor(access)` — only actions whose module is ON for
 * the business (GET /api/business/capabilities) and whose scope the person holds, ordered by what this kind of
 * business creates most. Nothing locked, nothing "coming soon": those belong to "יכולות נוספות", not to "+".
 * Until capabilities answer, nothing module-bound is shown (fail-closed); a failed read says so, with a retry.
 *
 * The sheet overlays the current screen without navigating, so closing it returns to the same place and the
 * same scroll position (only `overflow` is toggled on <body>; the scroll offset is never touched).
 */
export function ActionSheet({ open, onClose }: ActionSheetProps) {
  const router = useRouter();
  const { t, locale } = useI18n();
  const { access, retry } = useHomeAccess(open);
  const actions: CreateAction[] = access.state === "ready" ? createActionsFor(access.value) : [];
  // FREE_LIMITED only (never today): its one line is downloaded on demand, nobody else ships it.
  const limitedNote = useLimitedCopy(access.state === "ready" && createLimitedNote(access.value), locale)?.copy.createNote ?? null;
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
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isPresent, onClose]);

  if (!isPresent) return null;

  function go(href: string) {
    router.push(href);
    onClose();
  }

  const overlayOpacity = visualOpen ? 1 : 0;
  const sheetTransform = visualOpen ? "translate3d(0, 0, 0)" : "translate3d(0, 108%, 0)";

  return (
    <div
      inert={!visualOpen}
      data-component="create-sheet"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: OVERLAY_Z,
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
        pointerEvents: "none",
        WebkitTapHighlightColor: "transparent",
        fontFamily: "var(--font-rubik), 'Heebo', system-ui, sans-serif",
      }}
    >
      <div
        role="presentation"
        aria-hidden={!visualOpen}
        onClick={onClose}
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(35, 48, 43, 0.28)",
          opacity: overlayOpacity,
          transition: `opacity ${TRANS_MS}ms ${visualOpen ? EASE_OUT : EASE_IN}`,
          pointerEvents: visualOpen ? "auto" : "none",
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="dz-create-title"
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "relative",
          zIndex: 1,
          width: "100%",
          maxWidth: 480,
          maxHeight: "min(80vh, 600px)",
          overflowY: "auto",
          WebkitOverflowScrolling: "touch",
          borderTopLeftRadius: 28,
          borderTopRightRadius: 28,
          background: "#FFFDF8",
          boxShadow: "0 -10px 34px rgba(35, 48, 43, 0.12)",
          transform: sheetTransform,
          transition: `transform ${TRANS_MS}ms ${visualOpen ? EASE_OUT : EASE_IN}`,
          willChange: "transform",
          padding: "10px 16px calc(18px + env(safe-area-inset-bottom, 0px)) 16px",
          pointerEvents: visualOpen ? "auto" : "none",
          color: "#23302B",
        }}
      >
        <div aria-hidden style={{ width: 40, height: 4, borderRadius: 999, background: "rgba(35, 48, 43, 0.14)", margin: "0 auto 14px" }} />
        <h2 id="dz-create-title" style={{ margin: 0, fontSize: 19, fontWeight: 700, letterSpacing: "-0.01em" }}>
          {t("home.v4.create.title")}
        </h2>
        <p style={{ margin: "2px 0 16px", fontSize: 14, color: "#566159" }}>{t("home.v4.create.subtitle")}</p>

        {access.state === "loading" ? (
          <p role="status" style={{ margin: "8px 0 4px", fontSize: 14, color: "#566159" }}>{t("home.v4.create.loading")}</p>
        ) : access.state === "failed" ? (
          <div role="status" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 12px", borderRadius: 14, background: "#F8F1EE", color: "#7A3E2E", fontSize: 14 }}>
            <span>{t("home.v4.create.failed")}</span>
            <button type="button" onClick={retry} style={{ minHeight: 40, border: 0, background: "transparent", color: "#1F4A46", fontWeight: 600, font: "inherit", cursor: "pointer" }}>
              {t("home.v4.create.retry")}
            </button>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
            {actions.map((item, index) => (
              <button
                key={item.key}
                type="button"
                onClick={() => go(item.href)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  minHeight: 64,
                  padding: "12px",
                  borderRadius: 18,
                  border: "1px solid #E3E5DD",
                  background: "#FFFFFF",
                  cursor: "pointer",
                  textAlign: "start",
                  font: "inherit",
                  color: "#23302B",
                  touchAction: "manipulation",
                  boxShadow: "0 1px 2px rgba(35, 48, 43, 0.04)",
                  ...(index === actions.length - 1 && actions.length % 2 === 1 ? { gridColumn: "1 / -1" } : {}),
                }}
              >
                <span aria-hidden style={{ flexShrink: 0, width: 40, height: 40, borderRadius: 14, display: "flex", alignItems: "center", justifyContent: "center", background: "#E3EEE7", color: "#2F615C" }}>
                  <ActionGlyph kind={item.icon} />
                </span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 15, fontWeight: 600, lineHeight: 1.25 }}>{t(`home.v4.create.action.${item.labelKey}`)}</span>
              </button>
            ))}
          </div>
        )}

        {/* FREE_LIMITED (owner decision 4): what is not available is simply absent — one line says what returns with
            an active plan. Never drawn otherwise. */}
        {limitedNote ? (
          <p role="note" style={{ margin: "12px 0 0", padding: "10px 12px", borderRadius: 14, background: "#F3F0E8", fontSize: 13.5, lineHeight: 1.45, color: "#566159" }}>
            {limitedNote}
          </p>
        ) : null}

        <button
          type="button"
          onClick={onClose}
          style={{
            width: "100%",
            marginTop: 14,
            minHeight: 50,
            borderRadius: 999,
            border: "1px solid #E3E5DD",
            background: "transparent",
            fontSize: 15,
            fontWeight: 600,
            font: "inherit",
            color: "#566159",
            cursor: "pointer",
            touchAction: "manipulation",
          }}
        >
          {t("home.v4.create.close")}
        </button>
      </div>
    </div>
  );
}

function ActionGlyph({ kind }: { kind: CreateAction["icon"] }) {
  const p = { width: 22, height: 22, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.85, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (kind) {
    case "calendar":
      return <svg {...p}><path d="M4 6.5h16v13.5H4zM4 10.5h16M8.5 3.5v4M15.5 3.5v4M12 13.5v4M10 15.5h4" /></svg>;
    case "task":
      return <svg {...p}><path d="M9 6h11M9 12h11M9 18h7M4 6l1 1 2-2M4 12l1 1 2-2" /></svg>;
    case "lead":
      return <svg {...p}><path d="M4 6h16M6.5 12h11M9.5 18h5" /></svg>;
    case "customer":
      return <svg {...p}><circle cx="10" cy="8" r="3.5" /><path d="M3.5 19.5c.6-3 3.1-4.8 6.5-4.8 1.5 0 2.8.3 3.9 1M18 14v6M15 17h6" /></svg>;
    case "secretary":
      return <svg {...p}><path d="M9 4h6a1 1 0 0 1 1 1v1h2a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h2V5a1 1 0 0 1 1-1z" /><path d="M9 13l2 2 4-4" /></svg>;
    case "upload":
      return <svg {...p}><path d="M12 5v10M8 9l4-4 4 4M5 19h14" /></svg>;
    case "invoice":
      return <svg {...p}><path d="M7 3h10l3 3v15a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" /><path d="M14 3v4h4M8 12h8M8 16h5" /></svg>;
    case "inventory":
      return <svg {...p}><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /><path d="M3.27 6.96L12 12.01l8.73-5.05M12 22.08V12" /></svg>;
    case "payments":
      return <svg {...p}><rect x="2.5" y="5" width="19" height="14" rx="2.5" /><path d="M2.5 9.5h19M6 15h4" /></svg>;
    case "service":
      return <svg {...p}><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.5-.5-.5-2.5z" /></svg>;
  }
}
