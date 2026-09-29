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

export const intakeRegistry = new IntakeRegistry().register(whatsAppIntakeAdapter);
