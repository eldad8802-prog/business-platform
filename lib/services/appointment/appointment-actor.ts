/**
 * Who acted on an appointment — validated and translated, PURE (no database).
 *
 * Owner decision 6: an OWNER action carries the owner's user id; a CUSTOMER, BOT or SYSTEM action carries none and is
 * never attributed to a user — not in the appointment, not in the journal, not in a learning sensor.
 */
import type { SensorActor, SensorSource } from "@/lib/sensors/sensor.contract";

import type { ActorContext } from "./appointment.types";

const VALID_ACTORS = new Set(["OWNER", "BOT", "SYSTEM", "CUSTOMER"]);
const VALID_CHANNELS = new Set([
  "INBOX_WEB",
  "MOBILE",
  "WHATSAPP_BOT",
  "PUBLIC_BOOKING",
  "EXTERNAL_API",
  "IMPORT",
]);

function isPositiveInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n > 0;
}

/** Decision 6: the owner acts as a user; a customer, the bot or the system never does. */
export function isValidActor(actor: ActorContext | undefined): boolean {
  if (!actor) return false;
  if (!VALID_ACTORS.has(actor.actor)) return false;
  if (!VALID_CHANNELS.has(actor.sourceChannel)) return false;
  return actor.actor === "OWNER" ? isPositiveInt(actor.userId) : actor.userId === null;
}

/**
 * M5.5 — the appointment's own provenance, translated into the sensor vocabulary. Derived ONLY from
 * the server-built `ActorContext` (routes build it from the session). A BOT, SYSTEM or CUSTOMER actor is never
 * attributed to a user: that id would put a name on a decision nobody made.
 */
export function sensorWho(ctx: ActorContext): { actor: SensorActor; source: SensorSource } {
  if (ctx.actor === "OWNER" && ctx.userId !== null) {
    const source: SensorSource =
      ctx.sourceChannel === "INBOX_WEB" || ctx.sourceChannel === "MOBILE"
        ? "OWNER_UI"
        : ctx.sourceChannel === "IMPORT"
          ? "IMPORT"
          : ctx.sourceChannel === "EXTERNAL_API"
            ? "API"
            : "UNKNOWN";
    return { actor: { type: "OWNER_USER", userId: ctx.userId }, source };
  }
  const source: SensorSource =
    ctx.sourceChannel === "EXTERNAL_API"
      ? "API"
      : ctx.sourceChannel === "PUBLIC_BOOKING"
        ? "INTEGRATION"
        : ctx.sourceChannel === "WHATSAPP_BOT"
          ? "SYSTEM"
          : "UNKNOWN";
  return { actor: { type: "SYSTEM" }, source };
}
