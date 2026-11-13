"use client";

import type { ReactNode } from "react";

import { useI18n } from "@/components/i18n/I18nProvider";
import { SettingsSection } from "@/components/settings/SettingsSection";

import type { NotificationSettingsApi } from "./use-notification-settings";
import s from "./notification-settings.module.css";

/** A labelled switch: a real checkbox with role="switch", its visible label and its help text wired by id. */
export function SwitchRow({
  id,
  label,
  help,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  help?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  const helpId = help ? `${id}-help` : undefined;
  return (
    <div className={s.row}>
      <div className={s.rowText}>
        <label htmlFor={id} className="block text-sm font-bold text-[var(--dz-text-primary)]">
          {label}
        </label>
        {help ? (
          <p id={helpId} className="mt-1 text-xs leading-5 text-[var(--dz-text-secondary)]">
            {help}
          </p>
        ) : null}
      </div>
      <input
        id={id}
        type="checkbox"
        role="switch"
        className={s.switch}
        checked={checked}
        aria-checked={checked}
        aria-describedby={helpId}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </div>
  );
}

/** The polite save line: "שומרים…" / "נשמר" / the error with what to do next. */
export function SaveStatus({ note }: { note: NotificationSettingsApi["note"] }) {
  const { t } = useI18n();
  const text =
    note === "saving"
      ? t("notifications.state.saving")
      : note === "saved"
        ? t("notifications.state.saved")
        : note === "error"
          ? t("notifications.state.saveError")
          : "";
  return (
    <p
      role="status"
      aria-live="polite"
      data-testid="notif-save-status"
      data-note={note}
      className={`${s.note} ${note === "error" ? s.noteError : ""} min-h-5 px-1`}
    >
      {text}
    </p>
  );
}

/** Loading / not available yet / load error — the same calm states on every notification settings screen. */
export function LoadGate({ api, children }: { api: NotificationSettingsApi; children: ReactNode }) {
  const { t } = useI18n();
  if (api.state === "loading") {
    return (
      <p role="status" className="px-4 py-6 text-sm text-[var(--dz-text-secondary)]">
        {t("common.loading")}
      </p>
    );
  }
  if (api.state === "unavailable") {
    return (
      <div data-testid="notif-unavailable">
        <SettingsSection title={t("notifications.state.unavailable")} description={t("notifications.state.unavailableHint")}>
          {null}
        </SettingsSection>
      </div>
    );
  }
  if (api.state === "error" || !api.view) {
    return (
      <div className="px-4 py-6" data-testid="notif-load-error">
        <p className="text-sm text-[var(--dz-text-secondary)]">{t("notifications.state.loadError")}</p>
        <button type="button" className={`${s.button} ${s.buttonPrimary} mt-3`} onClick={api.reload}>
          {t("notifications.state.retry")}
        </button>
      </div>
    );
  }
  return <>{children}</>;
}
