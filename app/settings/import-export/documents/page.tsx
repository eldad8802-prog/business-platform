import { notFound } from "next/navigation";
import { SettingsSubPageHeader } from "@/components/settings/SettingsSubPageHeader";
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
export default function DocumentsImportSettingsPage() {
  if (!IMPORT_EXPORT_RELEASED) {
    notFound();
  }

  return (
    <>
      <SettingsSubPageHeader
        title="ייבוא מסמכים"
        subtitle="בדיקת קבצים לפני קליטה"
        backHref={IMPORT_EXPORT_ROUTE}
      />
      <DocumentsImportScreen />
    </>
  );
}
