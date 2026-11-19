"use client";

/**
 * הגדרות ← התראות ← סוגי התראות (approved design, screen 2 and screen 4 state ה): for each type the three
 * choices "בתוך דוביז" / "בטלפון" / "בסיכום היומי", grouped by area. Only catalog categories are listed; a type
 * whose feature is not available to the business is greyed with "לא זמין בחשבון שלכם" and its stored choices are
 * kept (the backend never deletes them). In the appointments area, when the appointment reminder is available: the
 * user's own lead time ("מתי להזכיר לפני תור": 30 דקות / שעה / שעתיים / יום לפני), saved to the caller's own
 * settings (PATCH appointmentReminderMinutes).
 */
import { useNotificationT } from "./copy/notification-copy";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { getCategory } from "@/lib/notifications/catalog";

import { LoadGate, SaveStatus } from "./notification-controls";
import {
  CHOICES,
  SETTINGS_CONTROLS,
  appointmentLeadView,
  buildTypeGroups,
  type CategoryRow,
  type Choice,
} from "./notification-settings-model";
import { useNotificationSettings, type NotificationSettingsApi } from "./use-notification-settings";
import s from "./notification-settings.module.css";

const CHOICE_LABEL = {
  inApp: "notifications.types.choices.inApp",
  phone: "notifications.types.choices.phone",
  digest: "notifications.types.choices.digest",
} as const;

function TypeRow({ row, api }: { row: CategoryRow; api: NotificationSettingsApi }) {
  const t = useNotificationT();
  const name = t(row.labelKey);
  const labelId = `notif-type-${row.key.replace(/[^a-z0-9]/gi, "-")}`;
  const hintId = `${labelId}-hint`;
  const onTap = (choice: Choice, value: boolean) => {
    const cat = getCategory(row.key);
    if (cat) void api.setChoice(cat, choice, value);
  };
  return (
    <div className={s.typeRow} data-testid="notif-type" data-key={row.key} data-available={row.available}>
      <p id={labelId} className={`text-sm font-bold ${row.available ? "text-[var(--dz-text-primary)]" : "text-[var(--dz-text-secondary)]"}`}>
        {name}
        {row.quietBypass ? <span className={s.badge}>{t("notifications.types.quietBypass")}</span> : null}
      </p>
      {row.available ? null : (
        <p id={hintId} className="mt-1 text-xs leading-5 text-[var(--dz-text-secondary)]">
          <span className="font-bold">{t("notifications.types.unavailable")}</span> · {t("notifications.types.unavailableHint")}
        </p>
      )}
      <div
        className={s.choices}
        role="group"
        aria-label={t("notifications.types.choicesAria", { name })}
        aria-describedby={row.available ? undefined : hintId}
      >
        {CHOICES.filter((c) => row.choices[c].shown).map((c) => {
          const ch = row.choices[c];
          return (
            <button
              key={c}
              type="button"
              className={s.chip}
              aria-pressed={ch.pressed}
              disabled={ch.disabled}
              data-choice={c}
              onClick={() => onTap(c, !ch.pressed)}
            >
              {t(CHOICE_LABEL[c])}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The appointment reminder lead time: four chips, one pressed (the existing chip control, single choice). */
function AppointmentLead({ api }: { api: NotificationSettingsApi }) {
  const t = useNotificationT();
  const lead = appointmentLeadView(api.view!);
  if (!lead.shown) return null;
  const labelId = "notif-appointment-lead";
  return (
    <div className={s.typeRow} data-testid="notif-appointment-lead">
      <p id={labelId} className="text-sm font-bold text-[var(--dz-text-primary)]">
        {t("notifications.types.appointmentLead.title")}
      </p>
      <p id={`${labelId}-help`} className="mt-1 text-xs leading-5 text-[var(--dz-text-secondary)]">
        {t("notifications.types.appointmentLead.help")}
      </p>
      <div className={s.choices} role="group" aria-labelledby={labelId} aria-describedby={`${labelId}-help`}>
        {lead.options.map((o) => (
          <button
            key={o.minutes}
            type="button"
            className={s.chip}
            aria-pressed={o.pressed}
            data-minutes={o.minutes}
            onClick={() => {
              if (!o.pressed) void api.patchSettings({ [SETTINGS_CONTROLS.appointmentLead]: o.minutes });
            }}
          >
            {t(o.labelKey)}
          </button>
        ))}
      </div>
    </div>
  );
}

function TypesBody({ api }: { api: NotificationSettingsApi }) {
  const t = useNotificationT();
  const view = api.view!;
  const groups = buildTypeGroups(view);
  return (
    <div className={s.stack} data-testid="notif-types">
      <div className="px-1">
        <p className="text-sm leading-6 text-[var(--dz-text-secondary)]">{t("notifications.types.intro")}</p>
        {view.settings.pushEnabled ? null : <p className={s.note}>{t("notifications.types.phoneOffNote")}</p>}
        {view.settings.digestEnabled ? null : <p className={s.note}>{t("notifications.types.digestOffNote")}</p>}
      </div>
      {groups.map((g) => (
        <SettingsSection key={g.domain} title={t(g.labelKey)}>
          {g.rows.map((row) => (
            <TypeRow key={row.key} row={row} api={api} />
          ))}
          {g.domain === "appointments" ? <AppointmentLead api={api} /> : null}
        </SettingsSection>
      ))}
      <SaveStatus note={api.note} />
    </div>
  );
}

export function NotificationTypesScreen() {
  const api = useNotificationSettings();
  return <LoadGate api={api}>{api.view ? <TypesBody api={api} /> : null}</LoadGate>;
}
