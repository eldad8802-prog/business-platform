import { notFound } from "next/navigation";
import { SettingsSubPageHeader } from "@/components/settings/SettingsSubPageHeader";
import { getServerI18n } from "@/lib/i18n/server";
import {
  TemplatesScreen,
  type TemplateDomainOption,
} from "@/components/settings/import-export/TemplatesScreen";
import {
  IMPORT_EXPORT_RELEASED,
  IMPORT_EXPORT_ROUTE,
} from "@/components/settings/import-export/import-export-release";
import { DATA_TRANSFER_DOMAINS } from "@/lib/data-transfer/domains";

/**
 * הגדרות → ייבוא וייצוא → תבניות.
 *
 * Same derivation as the export screen: the selectable list comes from the
 * six-domain registry filtered by `kind === "tabular"`, not from a second
 * hand-written list, and filtering here keeps the template builder (and
 * therefore ExcelJS) out of the client bundle.
 */
export default async function ImportTemplatesPage() {
  if (!IMPORT_EXPORT_RELEASED) {
    notFound();
  }
  const { t } = await getServerI18n();

  const domains: TemplateDomainOption[] = DATA_TRANSFER_DOMAINS.filter(
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
        title={t("account.settings.importExport.actions.templates.title")}
        subtitle={t("account.settings.importExport.pages.templatesSubtitle")}
        backHref={IMPORT_EXPORT_ROUTE}
      />
      <TemplatesScreen domains={domains} />
    </>
  );
}
