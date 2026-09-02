import { notFound } from "next/navigation";
import { SettingsSubPageHeader } from "@/components/settings/SettingsSubPageHeader";
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
export default function ImportTemplatesPage() {
  if (!IMPORT_EXPORT_RELEASED) {
    notFound();
  }

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
        title="תבניות לייבוא"
        subtitle="הכינו את המידע מראש"
        backHref={IMPORT_EXPORT_ROUTE}
      />
      <TemplatesScreen domains={domains} />
    </>
  );
}
