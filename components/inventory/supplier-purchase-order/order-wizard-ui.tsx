"use client";

import type { ReactNode } from "react";
import { WizardSteps } from "@/components/inventory/inventory-design";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { MessageKey, Translator } from "@/lib/i18n/translate";

// 3-step order flow (product-first), matching the mockup's `.steps` pills.
const PROGRESS_STEP_KEYS: readonly MessageKey[] = [
  "customers.purchases.wizard.steps.select",
  "customers.purchases.wizard.steps.cart",
  "customers.purchases.wizard.steps.confirm",
];

function stepIndexForPath(pathname: string): number {
  if (pathname.endsWith("/confirm")) return 2;
  if (pathname.endsWith("/cart")) return 1;
  return 0;
}

export function OrderWizardProgress({ pathname }: { pathname: string }) {
  const { t } = useI18n();
  return <WizardSteps steps={PROGRESS_STEP_KEYS.map((key) => t(key))} activeIndex={stepIndexForPath(pathname)} />;
}

export function orderWizardProgressLabel(pathname: string, t: Translator) {
  const idx = stepIndexForPath(pathname);
  return (
    <>
      {t("customers.purchases.wizard.progress.step")} <strong>{idx + 1}</strong>{" "}
      {t("customers.purchases.wizard.progress.of", { total: PROGRESS_STEP_KEYS.length })} ·{" "}
      <strong>{t(PROGRESS_STEP_KEYS[idx])}</strong>
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
  const { t } = useI18n();
  return (
    <>
      {hasLocalDraft && !hasUnsavedWork ? (
        <section
          className="owz-state-card"
          style={{ borderColor: "var(--inv-info-border)", background: "var(--inv-info-bg)", color: "var(--inv-info-ink)" }}
        >
          <div style={{ fontWeight: 600, marginBottom: 10 }}>
            {t("customers.purchases.wizard.alerts.savedDraft")}
          </div>
          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}
          >
            <button type="button" onClick={onRestoreDraft} className="owz-step__next">
              {t("customers.purchases.wizard.alerts.resume")}
            </button>
            <button type="button" onClick={onClearDraft} className="owz-step__back">
              {t("customers.purchases.wizard.alerts.delete")}
            </button>
          </div>
        </section>
      ) : null}

      {error ? (
        <div
          className="owz-state-card"
          style={{ borderColor: "var(--inv-danger-border)", background: "var(--inv-danger-bg)", color: "var(--inv-danger)" }}
        >
          {error}
        </div>
      ) : null}

      {success ? (
        <div
          className="owz-state-card"
          style={{ borderColor: "var(--inv-success-border)", background: "var(--inv-success-bg)", color: "var(--inv-success)" }}
        >
          {success}
        </div>
      ) : null}
    </>
  );
}

/**
 * Renders a translated template with ONE `{var}` placeholder wrapped in <bdi> — keeps the bidi
 * isolation the screens always had around numbers/names, without concatenating text fragments.
 * Pass the template untranslated-vars (t(key) with no vars leaves `{var}` intact).
 */
export function BdiTemplate({ template, name, value }: { template: string; name: string; value: ReactNode }) {
  const token = `{${name}}`;
  const at = template.indexOf(token);
  if (at < 0) return <>{template}</>;
  return (
    <>
      {template.slice(0, at)}
      <bdi>{value}</bdi>
      {template.slice(at + token.length)}
    </>
  );
}
