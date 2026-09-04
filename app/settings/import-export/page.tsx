import { notFound } from "next/navigation";
import { SettingsSubPageHeader } from "@/components/settings/SettingsSubPageHeader";
import { ImportExportHub } from "@/components/settings/import-export/ImportExportHub";
import { IMPORT_EXPORT_RELEASED } from "@/components/settings/import-export/import-export-release";

/**
 * הגדרות → ייבוא וייצוא.
 *
 * Closed until the first real capability ships (Export, I-3). `notFound()` is
 * the gate rather than a hidden link, because "not linked from Settings" is not
 * the same as "not reachable" — a half-built screen that still renders for
 * anyone who types the URL is still exposure. See
 * `components/settings/import-export/import-export-release.ts`.
 */
export default function ImportExportSettingsPage() {
  if (!IMPORT_EXPORT_RELEASED) {
    notFound();
  }

  return (
    <>
      <SettingsSubPageHeader
        title="ייבוא וייצוא"
        subtitle="העברת מידע אל דוביז וממנה"
      />
      <ImportExportHub />
    </>
  );
}
