"use client";

import Link from "next/link";
import type { ReactNode } from "react";

type StepState = "done" | "current" | "upcoming";

type StepDef = { id: string; label: string };

const PROGRESS_STEPS: StepDef[] = [
  { id: "rec", label: "המלצות" },
  { id: "select", label: "בחירה" },
  { id: "cart", label: "עגלה" },
  { id: "confirm", label: "אישור" },
];

function stepIndexForPath(pathname: string): number {
  if (pathname.endsWith("/confirm")) return 3;
  if (pathname.endsWith("/cart")) return 2;
  if (pathname.endsWith("/select")) return 1;
  return 0;
}

export function OrderWizardProgress({ pathname }: { pathname: string }) {
  const currentIndex = stepIndexForPath(pathname);

  return (
    <nav className="owz-progress" aria-label="התקדמות ביצירת הזמנה">
      <ol className="owz-progress__list">
        {PROGRESS_STEPS.map((step, idx) => {
          const state: StepState =
            idx < currentIndex
              ? "done"
              : idx === currentIndex
                ? "current"
                : "upcoming";

          return (
            <li key={step.id} className={`owz-progress__step is-${state}`}>
              <span className="owz-progress__node" aria-hidden>
                {state === "done" ? "✓" : idx + 1}
              </span>
              <span className="owz-progress__label">{step.label}</span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export function orderWizardProgressLabel(pathname: string) {
  const idx = stepIndexForPath(pathname);
  const step = PROGRESS_STEPS[idx];

  return (
    <>
      שלב <strong>{idx + 1}</strong> מתוך 4 · <strong>{step?.label}</strong>
    </>
  );
}

export function OrderWizardAlerts({
  error,
  success,
  hasLocalDraft,
  hasUnsavedWork,
  onRestoreDraft,
  onClearDraft,
}: {
  error: string | null;
  success: string | null;
  hasLocalDraft: boolean;
  hasUnsavedWork: boolean;
  onRestoreDraft: () => void;
  onClearDraft: () => void;
}) {
  return (
    <>
      {hasLocalDraft && !hasUnsavedWork ? (
        <section
          className="owz-state-card"
          style={{ borderColor: "#bfdbfe", background: "#eff6ff", color: "#1d4ed8" }}
        >
          <div style={{ fontWeight: 900, marginBottom: 10 }}>
            יש הזמנה שנשמרה להמשך.
          </div>
          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}
          >
            <button type="button" onClick={onRestoreDraft} className="owz-step__next">
              המשך הזמנה
            </button>
            <button type="button" onClick={onClearDraft} className="owz-step__back">
              מחק
            </button>
          </div>
        </section>
      ) : null}

      {error ? (
        <div
          className="owz-state-card"
          style={{ borderColor: "#fecaca", background: "#fef2f2", color: "#991b1b" }}
        >
          {error}
        </div>
      ) : null}

      {success ? (
        <div
          className="owz-state-card"
          style={{ borderColor: "#bbf7d0", background: "#f0fdf4", color: "#166534" }}
        >
          {success}
        </div>
      ) : null}
    </>
  );
}

export function OrderWizardFooter({
  primaryLabel,
  primaryHref,
  onPrimary,
  primaryDisabled,
  primaryLoading,
  secondaryLabel,
  onSecondary,
}: {
  backHref?: string;
  backLabel?: string;
  onBack?: () => void;
  primaryLabel: string;
  primaryHref?: string;
  onPrimary?: () => void;
  primaryDisabled?: boolean;
  primaryLoading?: boolean;
  secondaryLabel?: string;
  onSecondary?: () => void;
}) {
  return (
    <footer className="inv-action-bar" aria-label="פעולות">
      <div className="inv-action-bar-row">
        {secondaryLabel && onSecondary ? (
          <button
            type="button"
            onClick={onSecondary}
            className="inv-action-btn inv-action-btn--secondary"
          >
            {secondaryLabel}
          </button>
        ) : null}

        {primaryHref ? (
          <Link
            href={primaryHref}
            className="inv-action-btn inv-action-btn--primary"
            aria-disabled={primaryDisabled}
            style={{
              pointerEvents: primaryDisabled ? "none" : undefined,
              opacity: primaryDisabled ? 0.55 : 1,
            }}
          >
            {primaryLoading ? "טוען..." : primaryLabel}
          </Link>
        ) : (
          <button
            type="button"
            onClick={onPrimary}
            disabled={primaryDisabled || primaryLoading}
            className="inv-action-btn inv-action-btn--primary"
          >
            {primaryLoading ? "טוען..." : primaryLabel}
          </button>
        )}
      </div>
    </footer>
  );
}

export function ItemThumb({
  imageUrl,
  size = 40,
}: {
  name: string;
  imageUrl?: string | null;
  size?: number;
}) {
  const valid = imageUrl && !imageUrl.includes("example.com") ? imageUrl : null;

  if (valid) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={valid}
        alt=""
        style={{
          width: size,
          height: size,
          borderRadius: 10,
          objectFit: "cover",
          flexShrink: 0,
        }}
      />
    );
  }

  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: 10,
        background: "#f3f4f6",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#94a3b8",
        flexShrink: 0,
      }}
      aria-hidden
    >
      <IconBoxOutline size={Math.round(size * 0.5)} />
    </div>
  );
}

export function StatBox({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="owz-stat">
      <div className="owz-stat__head">
        <span className="owz-stat__label">{label}</span>
      </div>
      <span className="owz-stat__value">{value}</span>
    </div>
  );
}

export function IconBoxOutline({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M3 7.5L12 3l9 4.5v9L12 21l-9-4.5v-9z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M3 7.5L12 12m0 0l9-4.5M12 12v9"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}
