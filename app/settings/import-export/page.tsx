import { notFound } from "next/navigation";
import { SettingsSubPageHeader } from "@/components/settings/SettingsSubPageHeader";
import { getServerI18n } from "@/lib/i18n/server";
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
export default async function ImportExportSettingsPage() {
  if (!IMPORT_EXPORT_RELEASED) {
    notFound();
  }
  const { t } = await getServerI18n();

  return (
    <>
      <SettingsSubPageHeader
        title={t("account.settings.importExport.category.title")}
        subtitle={t("account.settings.importExport.pages.hubSubtitle")}
      />
      <ImportExportHub />
    </>
  );
}
