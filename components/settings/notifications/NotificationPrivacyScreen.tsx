"use client";

/**
 * הגדרות ← התראות ← פרטיות ושחזור הגדרות (approved design, screen 3).
 *
 *  - "פרטים בהתראות לטלפון" = lockScreenDetails, which the push content really uses
 *    (lib/notifications/push/push-content.ts): off ⇒ the category's generic text only. The preview quotes the
 *    catalog's own generic text, i.e. exactly what a phone shows.
 *  - The security block of the design is NOT here: nothing produces a security notification today and there is
 *    no security email — the screen does not promise either.
 *  - Restoring defaults (POST /api/notifications/settings/reset) after a confirmation that says only YOUR settings
 *    change (the route deletes only the session user's rows).
 */
import { useState } from "react";
import { createPortal } from "react-dom";

import { useI18n } from "@/components/i18n/I18nProvider";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { useAccessibleDialog } from "@/components/ui/accessibility/use-accessible-dialog";
import { getCategory } from "@/lib/notifications/catalog";

import { LoadGate, SaveStatus, SwitchRow } from "./notification-controls";
import { SETTINGS_CONTROLS } from "./notification-settings-model";
import { useNotificationSettings, type NotificationSettingsApi } from "./use-notification-settings";
import s from "./notification-settings.module.css";

const PREVIEW = getCategory("tasks.reminder")!.lockScreen;

function ResetDialog({ open, busy, onCancel, onConfirm }: { open: boolean; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const { t } = useI18n();
  const { dialogProps, backdropProps } = useAccessibleDialog<HTMLDivElement>({
    open,
    onClose: onCancel,
    labelledById: "notif-reset-title",
    describedById: "notif-reset-body",
    disableClose: busy,
    initialFocusId: "notif-reset-cancel",
  });
  if (!open || typeof document === "undefined") return null;
  // Portalled to <body>: the shell's content column is its own stacking context, under the bottom navigation.
  return createPortal(
    <div {...backdropProps} className={s.overlay}>
      <div {...dialogProps} className={s.dialog} data-testid="notif-reset-dialog">
        <h2 id="notif-reset-title" className="text-base font-bold text-[var(--dz-text-primary)]">
          {t("notifications.privacy.dialogTitle")}
        </h2>
        <p id="notif-reset-body" className="mt-2 text-sm leading-6 text-[var(--dz-text-secondary)]">
          {t("notifications.privacy.dialogBody")}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className={`${s.button} ${s.buttonDanger}`} disabled={busy} onClick={onConfirm} data-testid="notif-reset-confirm">
            {t("notifications.privacy.dialogConfirm")}
          </button>
          <button type="button" id="notif-reset-cancel" className={s.button} disabled={busy} onClick={onCancel}>
            {t("notifications.privacy.dialogCancel")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function PrivacyBody({ api }: { api: NotificationSettingsApi }) {
  const { t } = useI18n();
  const v = api.view!.settings;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<"done" | "failed" | null>(null);

  async function confirmReset() {
    setBusy(true);
    const ok = await api.reset();
    setBusy(false);
    setOpen(false);
    setResult(ok ? "done" : "failed");
  }

  return (
    <div className={s.stack} data-testid="notif-privacy">
      <SettingsSection title={t("notifications.privacy.lockTitle")}>
        <SwitchRow
          id="notif-lock-details"
          label={t("notifications.privacy.detailsLabel")}
          help={t("notifications.privacy.detailsHelp")}
          checked={v.lockScreenDetails}
          onChange={(on) => void api.patchSettings({ [SETTINGS_CONTROLS.lockScreenDetails]: on })}
        />
        {v.lockScreenDetails ? (
          <p className={s.note}>{t("notifications.privacy.previewOn")}</p>
        ) : (
          <div>
            <p className={s.note}>{t("notifications.privacy.previewTitle")}</p>
            <div className={s.preview} aria-hidden="true">
              <p className="text-sm font-bold text-[var(--dz-text-primary)]">{PREVIEW.title}</p>
              <p className="text-sm text-[var(--dz-text-secondary)]">{PREVIEW.body}</p>
            </div>
          </div>
        )}
      </SettingsSection>

      <SettingsSection title={t("notifications.privacy.resetTitle")} description={t("notifications.privacy.resetHelp")}>
        <button
          type="button"
          className={s.button}
          onClick={() => {
            setResult(null);
            setOpen(true);
          }}
          data-testid="notif-reset"
        >
          {t("notifications.privacy.resetButton")}
        </button>
        <p role="status" aria-live="polite" className={`${s.note} ${result === "failed" ? s.noteError : ""}`} data-testid="notif-reset-result">
          {result === "done" ? t("notifications.privacy.resetDone") : result === "failed" ? t("notifications.privacy.resetFailed") : ""}
        </p>
      </SettingsSection>

      <SaveStatus note={api.note === "error" && result === "failed" ? "idle" : api.note} />
      <ResetDialog open={open} busy={busy} onCancel={() => setOpen(false)} onConfirm={confirmReset} />
    </div>
  );
}

export function NotificationPrivacyScreen() {
  const api = useNotificationSettings();
  return <LoadGate api={api}>{api.view ? <PrivacyBody api={api} /> : null}</LoadGate>;
}
