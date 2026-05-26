import { SETTINGS_CATEGORIES } from "./settings-categories";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";

export function SettingsNav() {
  return (
    <SettingsSection
      title="קטגוריות"
      description="הגדרות מערכתיות בלבד — לא ניהול שוטף של העסק"
    >
      <nav aria-label="הגדרות מערכת" className="flex flex-col divide-y divide-gray-100">
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
