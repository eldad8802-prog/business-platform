import { SettingsSubPageHeader } from "@/components/settings/SettingsSubPageHeader";
import { WixConnectConfirm } from "@/components/settings/WixConnectConfirm";

/**
 * Settings → Connections → Wix (M7-B): the Dubiz Wix app's dashboard page. After installing the app, Wix opens
 * this page with its SIGNED `instance` parameter; the signed-in owner confirms and the store is bound to their
 * business (server-verified — the parameter alone binds nothing).
 */
export const dynamic = "force-dynamic";

export default async function WixConnectPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const instance = typeof sp.instance === "string" ? sp.instance : null;
  return (
    <>
      <SettingsSubPageHeader title="חיבור חנות Wix" />
      <WixConnectConfirm instance={instance} />
    </>
  );
}
