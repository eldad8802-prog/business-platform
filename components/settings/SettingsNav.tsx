import { SETTINGS_CATEGORIES } from "./settings-categories";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";

export function SettingsNav() {
  return (
    <SettingsSection>
      <nav aria-label="הגדרות" className="flex flex-col divide-y divide-[var(--dz-border-subtle)] min-[1200px]:grid min-[1200px]:grid-cols-2 min-[1200px]:divide-y-0 min-[1200px]:gap-2">
        {SETTINGS_CATEGORIES.map((item) => (
          <SettingsRow
            key={item.key}
            href={item.href}
            icon={item.icon}
            title={item.title}
            description={item.description}
          />
        ))}
      </nav>
    </SettingsSection>
  );
}
