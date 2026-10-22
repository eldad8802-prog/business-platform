import { notFound } from "next/navigation";
import { SettingsSubPageHeader } from "@/components/settings/SettingsSubPageHeader";
import { getServerI18n } from "@/lib/i18n/server";
import { DocumentsImportScreen } from "@/components/settings/import-export/DocumentsImportScreen";
import {
  IMPORT_EXPORT_RELEASED,
  IMPORT_EXPORT_ROUTE,
} from "@/components/settings/import-export/import-export-release";

/**
 * הגדרות → ייבוא וייצוא → ייבוא מסמכים.
 *
 * The batch check only: pick files, see what would happen to each. Nothing
 * behind this screen writes — no document, no storage object, no ledger row.
 */
export default async function DocumentsImportSettingsPage() {
  if (!IMPORT_EXPORT_RELEASED) {
    notFound();
  }
  const { t } = await getServerI18n();

  return (
    <>
      <SettingsSubPageHeader
        title={t("account.settings.importExport.actions.documentsImport.title")}
        subtitle={t("account.settings.importExport.pages.documentsSubtitle")}
        backHref={IMPORT_EXPORT_ROUTE}
      />
      <DocumentsImportScreen />
    </>
  );
}
