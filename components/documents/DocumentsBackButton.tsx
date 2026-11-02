"use client";

import { useRef } from "react";
import { useBackDestination, useGoBack } from "@/components/ui/back-button";
import { useI18n } from "@/components/i18n/I18nProvider";

const ONCLICK_DEBOUNCE_MS = 350;

/**
 * Documents back control — the approved documents look ("› חזרה": chevron +
 * word, no pill) over the app-wide canonical back BEHAVIOUR. Destination logic
 * is the canonical one, via the same hooks `BackButton` uses: the screen the
 * user actually came from when the trail can verify it, otherwise the route
 * registry's parent, shown by name ("למסמכים") instead of claiming "back".
 * `onClick` keeps its meaning: an in-screen step that replaces the history
 * logic. The `data-dz-back*` attributes match `BackButton` for QA.
 * Styled by `.dz-docs-back` in app/(shell)/documents/layout.tsx.
 */
export default function DocumentsBackButton({
  onClick,
  label,
}: {
  onClick?: () => void;
  label?: string;
}) {
  const { t } = useI18n();
  const lastClick = useRef(0);
  const { target, fallback, pathname } = useBackDestination();
  const navigate = useGoBack(fallback.url);

  const word = label ?? t("documents.common.back");
  const showFallbackLabel = !onClick && target?.kind === "none";
  const text = showFallbackLabel ? fallback.label : word;
  const mode = onClick ? "step" : !target ? "pending" : target.kind === "history" ? "history" : "fallback";

  const handleClick = () => {
    if (onClick) {
      const now = Date.now();
      if (now - lastClick.current < ONCLICK_DEBOUNCE_MS) return;
      lastClick.current = now;
      onClick();
      return;
    }
    navigate();
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      data-dz-back={mode}
      data-dz-back-target={onClick ? undefined : target?.kind === "history" ? target.url : target ? fallback.url : undefined}
      data-dz-back-path={pathname}
      className="dz-docs-back"
    >
      {/* Points right = back in RTL; mirrored for LTR in CSS. */}
      <svg className="dz-docs-back__chev" viewBox="0 0 24 24" width="24" height="24" aria-hidden focusable="false">
        <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>{text}</span>
    </button>
  );
}
