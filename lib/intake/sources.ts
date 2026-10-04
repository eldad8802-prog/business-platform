/**
 * Business Intake · the Production source registry.
 *
 * Every source Dubiz accepts in Production is registered HERE, and only here.
 * Adding a connector (Meta Lead Ads, Google Lead Forms, telephony, commerce) =
 * implement an {@link IntakeAdapter} and register it below. Test-only reference
 * adapters are never registered here, so no Production route can reach them.
 */

import { IntakeRegistry } from "@/lib/intake/core/registry";
import { whatsAppIntakeAdapter } from "@/lib/intake/whatsapp/whatsapp-intake";
import { metaLeadAdsAdapter } from "@/lib/intake/acquisition/providers/meta-lead-ads";
import { googleLeadFormAdapter } from "@/lib/intake/acquisition/providers/google-lead-form";
import { webFormAdapter } from "@/lib/intake/acquisition/providers/web-form";

// M6 — first-wave acquisition sources. Each accepts nothing for a business until its platform
// feature (acquisition_*) is enabled for that business; all three are OFF by default.
export const intakeRegistry = new IntakeRegistry()
  .register(whatsAppIntakeAdapter)
  .register(metaLeadAdsAdapter)
  .register(googleLeadFormAdapter)
  .register(webFormAdapter);
