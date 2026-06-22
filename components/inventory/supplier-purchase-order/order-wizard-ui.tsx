"use client";

import { WizardSteps } from "@/components/inventory/inventory-design";

// 3-step order flow (product-first), matching the mockup's `.steps` pills.
const PROGRESS_STEPS = ["בחירה", "עגלה", "אישור"];

function stepIndexForPath(pathname: string): number {
  if (pathname.endsWith("/confirm")) return 2;
  if (pathname.endsWith("/cart")) return 1;
  return 0;
}

export function OrderWizardProgress({ pathname }: { pathname: string }) {
  return <WizardSteps steps={PROGRESS_STEPS} activeIndex={stepIndexForPath(pathname)} />;
}

export function orderWizardProgressLabel(pathname: string) {
  const idx = stepIndexForPath(pathname);
  return (
    <>
      שלב <strong>{idx + 1}</strong> מתוך {PROGRESS_STEPS.length} · <strong>{PROGRESS_STEPS[idx]}</strong>
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
          style={{ borderColor: "#bfdbfe", background: "#eff6ff", color: "#3F619C" }}
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
