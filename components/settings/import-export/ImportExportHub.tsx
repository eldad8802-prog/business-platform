/**
 * הגדרות → ייבוא וייצוא — the hub.
 *
 * Composed ENTIRELY from the existing Settings primitives (`SettingsSection` +
 * `SettingsRow`), in the same shape `SettingsNav` uses. That is the whole
 * design decision: no new card, no new spacing scale, no new interaction. The
 * screen inherits Dubiz Mist tokens, RTL, the 44px touch target, the hover and
 * active states and the chevron direction for free, and it cannot drift from
 * the rest of Settings later because it owns none of that styling.
 */

import { SettingsRow } from "@/components/settings/SettingsRow";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { IMPORT_EXPORT_ACTIONS } from "./import-export-actions";

export function ImportExportHub() {
  return (
    <SettingsSection>
      <nav
        aria-label="ייבוא וייצוא"
        className="flex flex-col divide-y divide-[var(--dz-border-subtle)]"
      >
        {IMPORT_EXPORT_ACTIONS.map((action) => (
          <SettingsRow
            key={action.key}
            href={action.href}
            icon={action.icon}
            title={action.title}
            description={action.description}
          />
        ))}
      </nav>
    </SettingsSection>
  );
}
