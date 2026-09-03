/**
 * Notification policy — the decision, separated from the delivery.
 *
 * WHERE THIS SITS
 *
 *   business-status (derived truth)  ->  THIS  ->  persisted notification
 *                                                   ->  in-app
 *                                                   ->  later: push, email
 *
 * `lib/business-status` recomputes a fresh snapshot on every read. That makes it
 * an excellent source of "what needs attention right now", and structurally
 * incapable of answering "have we already told them?" — it has no memory. This
 * module does not add memory either. It answers the question that comes first:
 *
 *   given a fact the business status engine surfaced, does it deserve to reach
 *   the owner at all, and if so, how loudly?
 *
 * Keeping that decision here — pure, no database, no clock of its own, no
 * provider — means it can be argued about and tested exhaustively. When the
 * persistent layer lands, it stores what this decided; it does not re-decide.
 *
 * THE GOVERNING RULE
 *
 * Silence is the default. A channel is granted only by an explicit entry in the
 * table below, and push only by a second, deliberately shorter one. The
 * temptation this resists is real: the status engine already produces a stream
 * of true, well-formed, plausibly-interesting items, and turning that stream
 * into notifications would be a single line of code and would ruin the product.
 * "We can tell them" is not "we should interrupt them".
 *
 * WHAT THIS MODULE DOES NOT DO
 *
 * It does not persist, deduplicate, count cooldowns, or send. It says what the
 * dedupe key IS and how long the cooldown SHOULD be; enforcing them needs
 * storage, which is the next increment.
 */

import type {
  BusinessStatusDomain,
  BusinessStatusItem,
  SemanticCategory,
  Severity,
} from "@/lib/business-status/types";
import { jerusalemHour } from "@/lib/utils/jerusalem-day";

export type NotificationChannel = "IN_APP" | "PUSH";

export type NotificationDecision = {
  /** False means: record nothing, show nothing, send nothing. */
  notify: boolean;
  channels: NotificationChannel[];
  /**
   * Stable identity of the underlying FACT, not of this observation of it.
   * Two snapshots of the same unresolved problem produce the same key.
   */
  dedupeKey: string;
  /**
   * How long the same key should stay quiet after being delivered. Enforcing
   * this needs storage; this module only states the interval.
   */
  cooldownHours: number;
  /** Why — kept so a surprising decision can be explained without a debugger. */
  reason: string;
};

/**
 * Quiet hours in Israel: 22:00 up to (not including) 07:00.
 *
 * Push is suppressed inside this window and downgraded to in-app. The
 * information is never lost — it is waiting when the owner next opens Dubiz.
 * There is deliberately no "urgent enough to override" exception yet: adding
 * one requires naming an event whose consequence within eight hours justifies
 * waking someone, and no event in the current inventory clears that bar.
 */
export const QUIET_HOURS_START = 22;
export const QUIET_HOURS_END = 7;

export function isQuietHour(instant: Date): boolean {
  const hour = jerusalemHour(instant);
  // The window wraps midnight, so this is a union, not a range.
  return hour >= QUIET_HOURS_START || hour < QUIET_HOURS_END;
}

type Rule = {
  channels: NotificationChannel[];
  cooldownHours: number;
  reason: string;
};

/** A rule key is intentionally coarse: domain + category + severity. */
function ruleKey(
  domain: BusinessStatusDomain,
  category: SemanticCategory,
  severity: Severity
): string {
  return `${domain}|${category}|${severity}`;
}

/**
 * The complete set of facts that may become a notification.
 *
 * Anything absent is silent. That is the point: the table is the argument, and
 * a new entry has to be defended rather than inherited.
 *
 * Cooldowns are long on purpose. These are standing conditions, not events —
 * an unreviewed document is still unreviewed an hour later, and saying so again
 * teaches the owner to ignore us.
 */
const RULES: Record<string, Rule> = {
  // ── Inventory ──────────────────────────────────────────────────────────────
  // Running out of stock has a consequence that accrues while the owner is not
  // looking: sales they cannot fulfil. This is the clearest case in the product
  // for reaching outside the app.
  [ruleKey("inventory", "ALERT", "CRITICAL")]: {
    channels: ["IN_APP", "PUSH"],
    cooldownHours: 24,
    reason: "critical stock — unfulfillable sales accrue while unattended",
  },
  [ruleKey("inventory", "ALERT", "HIGH")]: {
    channels: ["IN_APP"],
    cooldownHours: 24,
    reason: "inventory needs attention, but not outside the app",
  },

  // ── Billing ────────────────────────────────────────────────────────────────
  // A document that failed to produce its PDF is a legal artefact that does not
  // exist. The owner may believe they invoiced someone when they did not.
  [ruleKey("billing", "FAILURE_EVENT", "HIGH")]: {
    channels: ["IN_APP", "PUSH"],
    cooldownHours: 12,
    reason: "billing document failed to generate — the owner may believe it exists",
  },
  [ruleKey("billing", "ACTION_REQUIRED", "MEDIUM")]: {
    channels: ["IN_APP"],
    cooldownHours: 48,
    reason: "billing awaiting review — standing state, not an event",
  },

  // ── Documents ──────────────────────────────────────────────────────────────
  // Backlog. Real, and never urgent enough to interrupt: nothing about an
  // unreviewed document changes for the worse in the next eight hours.
  [ruleKey("documents", "ACTION_REQUIRED", "HIGH")]: {
    channels: ["IN_APP"],
    cooldownHours: 48,
    reason: "documents awaiting review — backlog, never an interruption",
  },
  [ruleKey("documents", "ACTION_REQUIRED", "MEDIUM")]: {
    channels: ["IN_APP"],
    cooldownHours: 72,
    reason: "documents backlog, low urgency",
  },

  // ── Leads ──────────────────────────────────────────────────────────────────
  // A follow-up the owner already scheduled. In-app only: they chose the date,
  // so being told about it on their own phone at 21:00 is not help.
  [ruleKey("leads", "ACTION_REQUIRED", "HIGH")]: {
    channels: ["IN_APP"],
    cooldownHours: 24,
    reason: "lead follow-up due — owner-scheduled, no interruption warranted",
  },
  [ruleKey("leads", "ACTION_REQUIRED", "MEDIUM")]: {
    channels: ["IN_APP"],
    cooldownHours: 24,
    reason: "lead attention, low urgency",
  },

  // ── Inbox ──────────────────────────────────────────────────────────────────
  [ruleKey("inbox", "ACTION_REQUIRED", "HIGH")]: {
    channels: ["IN_APP"],
    cooldownHours: 12,
    reason: "conversation waiting on the business",
  },

  // ── Supplier ───────────────────────────────────────────────────────────────
  [ruleKey("supplier", "ACTION_REQUIRED", "MEDIUM")]: {
    channels: ["IN_APP"],
    cooldownHours: 72,
    reason: "supplier purchase pending — slow-moving",
  },
};

const SILENT: NotificationDecision = {
  notify: false,
  channels: [],
  dedupeKey: "",
  cooldownHours: 0,
  reason: "no rule grants this fact a channel",
};

/**
 * The dedupe key identifies the FACT, so the same unresolved problem seen in a
 * hundred snapshots is one notification.
 *
 * Deliberately excluded: `priorityScore` and anything derived from
 * `generatedAt`. Both change between reads of an unchanged situation, and
 * including either would make every snapshot look like news.
 *
 * `businessId` is included so a key can never collide across tenants — the
 * persisted layer will be tenant-scoped anyway, but a key that is globally
 * unique cannot be mixed up by a future cache or queue.
 */
export function buildDedupeKey(
  businessId: number,
  item: Pick<BusinessStatusItem, "domain" | "semanticCategory" | "entityRef">
): string {
  return [
    `b${businessId}`,
    item.domain,
    item.semanticCategory,
    item.entityRef.type,
    item.entityRef.id,
  ].join(":");
}

/**
 * Decide what should happen to one business-status item.
 *
 * `now` is injected rather than read, so quiet-hours behaviour is testable and
 * a snapshot can be evaluated against a single consistent clock.
 */
export function decideNotification(
  businessId: number,
  item: BusinessStatusItem,
  now: Date
): NotificationDecision {
  const rule = RULES[ruleKey(item.domain, item.semanticCategory, item.severity)];

  if (!rule) return SILENT;

  const dedupeKey = buildDedupeKey(businessId, item);
  const quiet = isQuietHour(now);
  const wantsPush = rule.channels.includes("PUSH");

  if (wantsPush && quiet) {
    return {
      notify: true,
      // The fact still reaches the owner — just not by waking them.
      channels: ["IN_APP"],
      dedupeKey,
      cooldownHours: rule.cooldownHours,
      reason: `${rule.reason} (push suppressed: quiet hours)`,
    };
  }

  return {
    notify: true,
    channels: rule.channels,
    dedupeKey,
    cooldownHours: rule.cooldownHours,
    reason: rule.reason,
  };
}

/**
 * Apply the policy across a snapshot.
 *
 * Returns only the items that earned a channel, each with its decision. Items
 * the policy silenced are dropped here rather than downstream, so no later stage
 * can accidentally treat "no rule" as "default to notify".
 */
export function decideForSnapshot(
  businessId: number,
  items: BusinessStatusItem[],
  now: Date
): Array<{ item: BusinessStatusItem; decision: NotificationDecision }> {
  const out: Array<{ item: BusinessStatusItem; decision: NotificationDecision }> = [];
  for (const item of items) {
    const decision = decideNotification(businessId, item, now);
    if (decision.notify) out.push({ item, decision });
  }
  return out;
}

/** Exposed so tests and future review can enumerate what is allowed to push. */
export function pushEligibleRuleKeys(): string[] {
  return Object.entries(RULES)
    .filter(([, r]) => r.channels.includes("PUSH"))
    .map(([k]) => k)
    .sort();
}
