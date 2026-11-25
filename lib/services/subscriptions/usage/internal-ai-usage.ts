/**
 * Internal AI — measured, NEVER refused (subscriptions stage C, decision: "internal AI is measured and protected from
 * abuse, but an approved feature must keep working"). SERVER-ONLY.
 *
 * Wraps any model object whose `complete(...)` calls a provider (the landing composer, the knowledge Brain): every
 * provider call is recorded as one ai_internal_calls unit for the business, success or failure (both may be billed).
 * The approved features' own limits stay where they are (LANDING_COMPOSE bucket, Brain cooldowns). Owner-initiated AI
 * (the content studio) is NOT this: it is ai_owner_actions, a quota (Premium only).
 */
import { randomUUID } from "node:crypto";

import { consumeUsage } from "./usage-meter";

type Completing = { complete: (...args: never[]) => Promise<unknown> };

export function measuredInternalAi<M extends Completing>(model: M, businessId: number, source: string): M {
  const record = () =>
    consumeUsage({ businessId, metric: "ai_internal_calls", unitKey: `ai:${source}:${randomUUID()}`, source }).catch(() => undefined);
  return new Proxy(model, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== "complete" || typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        try {
          return await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        } finally {
          await record();
        }
      };
    },
  });
}
