/**
 * M7-B — the commerce sources Dubiz registers in Production. Each accepts nothing for a business until its
 * platform feature (commerce_woocommerce / commerce_wix) is enabled for that business — all OFF by default.
 * Tenant resolution is ONLY the trusted connection: the WooCommerce endpoint id, the Wix app instance id.
 */
import { makeCommerceAdapter } from "./adapter";
import { WOO_SOURCE } from "./woocommerce";
import { WIX_SOURCE } from "./wix";
import { resolvePublicConnection, resolveResourceConnection } from "@/lib/intake/acquisition/resolve";

export const wooCommerceAdapter = makeCommerceAdapter({
  sourceKey: WOO_SOURCE,
  async resolveTenant(accountRef) {
    return (await resolvePublicConnection(WOO_SOURCE, accountRef))?.businessId ?? null;
  },
});

export const wixAdapter = makeCommerceAdapter({
  sourceKey: WIX_SOURCE,
  async resolveTenant(accountRef) {
    return (await resolveResourceConnection(WIX_SOURCE, accountRef))?.businessId ?? null;
  },
});
