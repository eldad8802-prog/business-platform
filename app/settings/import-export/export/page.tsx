import { notFound } from "next/navigation";
import { SettingsSubPageHeader } from "@/components/settings/SettingsSubPageHeader";
import { getServerI18n } from "@/lib/i18n/server";
import {
  ExportScreen,
  type ExportDomainOption,
} from "@/components/settings/import-export/ExportScreen";
import {
  IMPORT_EXPORT_RELEASED,
  IMPORT_EXPORT_ROUTE,
} from "@/components/settings/import-export/import-export-release";
import { DATA_TRANSFER_DOMAINS } from "@/lib/data-transfer/domains";

/**
 * הגדרות → ייבוא וייצוא → ייצוא.
 *
 * The selectable list is derived from the six-domain registry by `kind`, not
 * from a second hand-written list: I-3 exports the TABULAR domains, and
 * Documents (`files`) / issued documents (`fiscal`) are absent because they are
 * not spreadsheet rows — a fact about the artifacts, not a hardcoded four.
 * Filtering on `kind` here also keeps the export descriptors (and therefore
 * Prisma) out of the page.
 */
export default async function ExportSettingsPage() {
  if (!IMPORT_EXPORT_RELEASED) {
    notFound();
  }
  const { t } = await getServerI18n();

  const domains: ExportDomainOption[] = DATA_TRANSFER_DOMAINS.filter(
    (domain) => domain.kind === "tabular"
  ).map((domain) => ({
    id: domain.id,
    title: domain.title,
    description: domain.description,
    icon: domain.icon,
  }));

  return (
    <>
      <SettingsSubPageHeader
        title={t("account.settings.importExport.actions.export.title")}
        subtitle={t("account.settings.importExport.pages.exportSubtitle")}
        backHref={IMPORT_EXPORT_ROUTE}
      />
      <ExportScreen domains={domains} />
    </>
  );
}
