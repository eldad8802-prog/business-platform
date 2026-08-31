import { SettingsSection } from "@/components/settings/SettingsSection";
import { SettingsSubPageHeader } from "@/components/settings/SettingsSubPageHeader";

const SYSTEM_VALUES: { label: string; value: string }[] = [
  { label: "שפה", value: "עברית" },
  { label: "כיווניות", value: "מימין לשמאל (RTL)" },
  { label: "מטבע", value: "שקל חדש (ILS)" },
  { label: "אזור זמן", value: "Asia/Jerusalem" },
];

export default function SettingsWorkspacePage() {
  return (
    <>
      <SettingsSubPageHeader title="שפה ואזור" />
      <SettingsSection title="הגדרות אזור">
        <p className="text-sm leading-6 text-[var(--dz-text-muted)]">
          כך המערכת מוצגת ומחשבת. כרגע לקריאה בלבד.
        </p>
        <div className="mt-3 divide-y divide-[var(--dz-border-subtle)]">
          {SYSTEM_VALUES.map((row) => (
            <div
              key={row.label}
              className="flex items-center justify-between gap-3 py-2"
            >
              <span className="text-xs font-semibold text-[var(--dz-text-muted)]">
                {row.label}
              </span>
              <span className="text-sm font-medium text-[var(--dz-text-primary)]">
                {row.value}
              </span>
            </div>
          ))}
        </div>
      </SettingsSection>
    </>
  );
}
