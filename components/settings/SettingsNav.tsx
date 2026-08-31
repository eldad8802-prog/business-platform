import { SETTINGS_CATEGORIES } from "./settings-categories";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";

export function SettingsNav() {
  return (
    <SettingsSection>
      <nav aria-label="הגדרות" className="flex flex-col divide-y divide-[var(--dz-border-subtle)]">
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
