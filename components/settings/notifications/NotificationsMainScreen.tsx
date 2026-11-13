"use client";

/**
 * הגדרות ← התראות (approved design, screen 1): phone notifications (the account switch, this device, the test
 * notification), how to receive (daily summary, quiet hours), and the two sub-screens (types; privacy and
 * restoring defaults). Every control writes a real field of the notification engine's settings.
 */
import { useEffect, useRef, useState } from "react";

import { useI18n } from "@/components/i18n/I18nProvider";
import { SettingsRow } from "@/components/settings/SettingsRow";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { buildClientAuthHeaders } from "@/lib/client-session";

import { LoadGate, SaveStatus, SwitchRow } from "./notification-controls";
import {
  SETTINGS_CONTROLS,
  TEST_MESSAGE_KEYS,
  minuteToTime,
  testOutcome,
  timeToMinute,
  type TestOutcome,
} from "./notification-settings-model";
import { PhoneDeviceCard } from "./PhoneDeviceCard";
import { useNotificationSettings, type NotificationSettingsApi } from "./use-notification-settings";
import s from "./notification-settings.module.css";

type MinuteField = typeof SETTINGS_CONTROLS.digestTime | typeof SETTINGS_CONTROLS.quietFrom | typeof SETTINGS_CONTROLS.quietTo;

/** An <input type="time"> bound to a minute-of-day field; saved shortly after the last change. */
function TimeInput({
  id,
  label,
  field,
  api,
  disabled,
}: {
  id: string;
  label: string;
  field: MinuteField;
  api: NotificationSettingsApi;
  disabled?: boolean;
}) {
  const saved = api.view?.settings[field] ?? 0;
  const [value, setValue] = useState(minuteToTime(saved));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A new saved value (the server's answer, a rollback, a reset) replaces what is typed.
  const [synced, setSynced] = useState(saved);
  if (synced !== saved) {
    setSynced(saved);
    setValue(minuteToTime(saved));
  }
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const commit = (v: string) => {
    const m = timeToMinute(v);
    if (m === null || m === saved) return;
    void api.patchSettings({ [field]: m });
  };
  return (
    <span className={s.timeField}>
      <label htmlFor={id} className="text-sm font-bold text-[var(--dz-text-primary)]">
        {label}
      </label>
      <input
        id={id}
        type="time"
        dir="ltr"
        className={s.time}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          setValue(e.target.value);
          if (timer.current) clearTimeout(timer.current);
          const v = e.target.value;
          timer.current = setTimeout(() => commit(v), 700);
        }}
        onBlur={(e) => {
          if (timer.current) clearTimeout(timer.current);
          commit(e.target.value);
        }}
      />
    </span>
  );
}

function TestButton({ disabled }: { disabled: boolean }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<TestOutcome | null>(null);
  async function run() {
    setBusy(true);
    setOutcome(null);
    let status: number | null = null;
    let body: unknown = null;
    try {
      const res = await fetch("/api/notifications/test", { method: "POST", cache: "no-store", headers: buildClientAuthHeaders() });
      status = res.status;
      body = await res.json().catch(() => null);
    } catch {
      status = null;
    }
    setOutcome(testOutcome(status, body));
    setBusy(false);
  }
  return (
    <div className="mt-3">
      <button type="button" className={s.button} disabled={disabled || busy} onClick={run} data-testid="notif-test">
        {busy ? t("notifications.phone.testSending") : t("notifications.phone.testButton")}
      </button>
      <p
        role="status"
        aria-live="polite"
        data-testid="notif-test-result"
        data-outcome={outcome ?? ""}
        className={`${s.note} ${outcome && outcome !== "sent" ? s.noteError : ""}`}
      >
        {outcome ? t(TEST_MESSAGE_KEYS[outcome]) : ""}
      </p>
    </div>
  );
}

export function NotificationsMainScreen() {
  const api = useNotificationSettings();
  return (
    <LoadGate api={api}>
      {api.view ? <MainBody api={api} /> : null}
    </LoadGate>
  );
}

function MainBody({ api }: { api: NotificationSettingsApi }) {
  const { t } = useI18n();
  const v = api.view!.settings;
  return (
    <div className={s.stack} data-testid="notif-main">
      <SettingsSection title={t("notifications.phone.sectionTitle")}>
        <SwitchRow
          id="notif-push"
          label={t("notifications.phone.switchLabel")}
          help={t("notifications.phone.switchHelp")}
          checked={v.pushEnabled}
          onChange={(on) => void api.patchSettings({ [SETTINGS_CONTROLS.phoneSwitch]: on })}
        />
        {v.pushEnabled ? null : <p className={s.note}>{t("notifications.phone.offNote")}</p>}
        <PhoneDeviceCard />
        <TestButton disabled={!v.pushEnabled} />
      </SettingsSection>

      <SettingsSection title={t("notifications.delivery.sectionTitle")}>
        <SwitchRow
          id="notif-digest"
          label={t("notifications.delivery.digestLabel")}
          help={t("notifications.delivery.digestHelp")}
          checked={v.digestEnabled}
          onChange={(on) => void api.patchSettings({ [SETTINGS_CONTROLS.digestSwitch]: on })}
        />
        {v.digestEnabled ? (
          <div className={s.timeRow}>
            <TimeInput id="notif-digest-time" label={t("notifications.delivery.digestTime")} field={SETTINGS_CONTROLS.digestTime} api={api} />
          </div>
        ) : null}
        <SwitchRow
          id="notif-quiet"
          label={t("notifications.delivery.quietLabel")}
          help={t("notifications.delivery.quietHelp")}
          checked={v.quietHoursEnabled}
          onChange={(on) => void api.patchSettings({ [SETTINGS_CONTROLS.quietSwitch]: on })}
        />
        {v.quietHoursEnabled ? (
          <div className={s.timeRow}>
            <TimeInput id="notif-quiet-from" label={t("notifications.delivery.quietFrom")} field={SETTINGS_CONTROLS.quietFrom} api={api} />
            <TimeInput id="notif-quiet-to" label={t("notifications.delivery.quietTo")} field={SETTINGS_CONTROLS.quietTo} api={api} />
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection title={t("notifications.more.sectionTitle")}>
        <SettingsRow
          href="/settings/notifications/types"
          icon="🗂️"
          title={t("notifications.types.rowTitle")}
          description={t("notifications.types.rowDescription")}
        />
        <SettingsRow
          href="/settings/notifications/privacy"
          icon="🔒"
          title={t("notifications.privacy.rowTitle")}
          description={t("notifications.privacy.rowDescription")}
        />
      </SettingsSection>

      <SaveStatus note={api.note} />
    </div>
  );
}
