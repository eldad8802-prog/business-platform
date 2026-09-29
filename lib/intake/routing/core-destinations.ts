/**
 * Business Intake M4 · destinations the CORE executes (provider-neutral).
 *
 * A destination listed here runs M4's own handler when the adapter opted in
 * (`IntakeAdapter.coreDestinations`). Payload-bound destinations (conversation,
 * message status, document) stay with each adapter's route(). Commerce, calls
 * and email get their handlers in M6+ — until then the routing rules mark them
 * 'unavailable' and the event is dead-lettered with its payload kept.
 */

import type { ClaimedIntakeEvent, IntakeRouteContext, NormalizedIntake, RouteResult, RouteTarget } from "@/lib/intake/core/contract";
import type { RoutingDecision } from "./rules";
import { routeToLead } from "./lead-destination";

export type CoreDestinationHandler = (
  ctx: IntakeRouteContext & { decision: RoutingDecision },
  normalized: NormalizedIntake,
  event: ClaimedIntakeEvent
) => Promise<RouteResult>;

export const CORE_DESTINATION_HANDLERS: Partial<Record<RouteTarget, CoreDestinationHandler>> = {
  lead: routeToLead,
};
