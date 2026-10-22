import { notFound } from "next/navigation";
import { SettingsSubPageHeader } from "@/components/settings/SettingsSubPageHeader";
import { getServerI18n } from "@/lib/i18n/server";
import {
  ImportScreen,
  type ImportDomainOption,
} from "@/components/settings/import-export/ImportScreen";
import {
  IMPORT_EXPORT_RELEASED,
  IMPORT_EXPORT_ROUTE,
} from "@/components/settings/import-export/import-export-release";
import { DATA_TRANSFER_DOMAINS } from "@/lib/data-transfer/domains";

/**
 * הגדרות → ייבוא וייצוא → ייבוא.
 *
 * The dry run only: analyze, map, check. Nothing behind this screen writes.
 *
 * Same derivation as Export and Templates — the selectable areas come from the
 * six-domain registry filtered by `kind === "tabular"`, so the import engine
 * (and Prisma with it) stays out of the client bundle.
 */
export default async function ImportSettingsPage() {
  if (!IMPORT_EXPORT_RELEASED) {
    notFound();
  }
  const { t } = await getServerI18n();

  const domains: ImportDomainOption[] = DATA_TRANSFER_DOMAINS.filter(
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
        title={t("account.settings.importExport.actions.import.title")}
        subtitle={t("account.settings.importExport.pages.importSubtitle")}
        backHref={IMPORT_EXPORT_ROUTE}
      />
      <ImportScreen domains={domains} />
    </>
  );
}
