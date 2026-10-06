/**
 * Business Intake M4 · destinations the CORE executes (provider-neutral).
 *
 * A destination listed here runs M4's own handler when the adapter opted in
 * (`IntakeAdapter.coreDestinations`). Payload-bound destinations (conversation,
 * message status, document) stay with each adapter's route(). M7-A adds the
 * commerce (R5) and call (R9) destinations; email has none yet — the rules mark
 * it 'unavailable' and the event is dead-lettered with its payload kept.
 */

import type { ClaimedIntakeEvent, IntakeRouteContext, NormalizedIntake, RouteResult, RouteTarget } from "@/lib/intake/core/contract";
import type { RoutingDecision } from "./rules";
import { routeToLead } from "./lead-destination";
import { routeToCommerce } from "./commerce-destination";
import { routeToCall } from "./call-destination";

export type CoreDestinationHandler = (
  ctx: IntakeRouteContext & { decision: RoutingDecision },
  normalized: NormalizedIntake,
  event: ClaimedIntakeEvent
) => Promise<RouteResult>;

export const CORE_DESTINATION_HANDLERS: Partial<Record<RouteTarget, CoreDestinationHandler>> = {
  lead: routeToLead,
  commerce: routeToCommerce,
  call: routeToCall,
};
