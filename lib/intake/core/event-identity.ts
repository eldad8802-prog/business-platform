/**
 * Business Intake · deterministic receipt identity.
 *
 * The receipt key (`IntakeEvent.externalEventId`) is what makes a provider's
 * redelivery a no-op. It is:
 *
 *   - DETERMINISTIC: the same provider event always yields the same key, so a
 *     duplicate or concurrent delivery hits the (businessId, sourceKey,
 *     externalEventId) unique index instead of creating a second receipt;
 *   - HASHED: `sha256:<hex>` — the receipt never stores the raw provider id
 *     (which can reconnect to a live thread / a person);
 *   - SCOPED: collisions across sources and businesses are impossible by the
 *     unique index itself; an adapter whose provider ids are only unique per
 *     ACCOUNT includes the account in the identity;
 *   - EXPLICIT when the provider gives no id: a content FINGERPRINT over fields
 *     the adapter names, recorded as `dedupeBasis = content_fingerprint`. With
 *     neither an id nor a fingerprint the receipt is refused — never keyed by
 *     something random (which would silently disable dedupe) or by something
 *     accidental (which would silently merge distinct events).
 */

import { createHash } from "node:crypto";
import type { DedupeBasis } from "./contract";

export type EventIdentityInput =
  | {
      /** The provider's own id for this event. */
      providerEventId: string;
      /** Set when the provider's ids are only unique within one account. */
      accountScope?: string | null;
    }
  | {
      /**
       * Canonical, ordered facts that identify the event when the provider
       * gives no id (e.g. form id + submission time + normalized contact).
       * The adapter owns the choice and documents it.
       */
      fingerprint: ReadonlyArray<string | number | null>;
      accountScope?: string | null;
    };

export type EventIdentity = { externalEventId: string; dedupeBasis: DedupeBasis };

export class MissingEventIdentityError extends Error {
  readonly code = "missing_event_identity";
  constructor() {
    super("missing_event_identity");
    this.name = "MissingEventIdentityError";
  }
}

/** `sha256:<hex>` of a string. */
export function sha256Key(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

// A separator that cannot appear in the (trimmed) parts, so ("ab","c") and
// ("a","bc") can never hash alike.
const SEP = "\u001f";

export function deriveEventIdentity(input: EventIdentityInput): EventIdentity {
  const scope = input.accountScope?.trim() || null;
  if ("providerEventId" in input) {
    const id = typeof input.providerEventId === "string" ? input.providerEventId.trim() : "";
    if (!id) throw new MissingEventIdentityError();
    return {
      externalEventId: sha256Key(scope ? ["id", scope, id].join(SEP) : id),
      dedupeBasis: "provider_event_id",
    };
  }
  const parts = input.fingerprint.map((p) => (p === null ? "" : String(p).trim()));
  if (parts.length === 0 || parts.every((p) => p === "")) throw new MissingEventIdentityError();
  return {
    externalEventId: sha256Key(["fp", scope ?? "", ...parts].join(SEP)),
    dedupeBasis: "content_fingerprint",
  };
}

/** A receipt key must be exactly what {@link sha256Key} produces. */
export function isValidReceiptKey(key: unknown): key is string {
  return typeof key === "string" && /^sha256:[0-9a-f]{64}$/.test(key);
}
