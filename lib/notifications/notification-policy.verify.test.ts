/**
 * Verify — notification policy.
 * Run: npx tsx lib/notifications/notification-policy.verify.test.ts
 *
 * Pure: no database, no network, no clock of its own. What is proven here is
 * the decision itself — which facts earn a channel, which stay silent, what
 * identifies a fact across snapshots, and that push is genuinely rare.
 *
 * The most important assertions are the negative ones. A notification system
 * fails by being noisy far more often than by being quiet, and the failure is
 * gradual: each individual "surely this one is worth telling them" is
 * defensible, and the sum is a product people mute.
 */
import assert from "node:assert/strict";

import type { BusinessStatusItem } from "@/lib/business-status/types";
import {
  QUIET_HOURS_END,
  QUIET_HOURS_START,
  buildDedupeKey,
  decideForSnapshot,
  decideNotification,
  isQuietHour,
  pushEligibleRuleKeys,
} from "@/lib/notifications/notification-policy";

let checks = 0;
function ok(label: string, cond: boolean, detail = "") {
  assert.ok(cond, `${label}${detail ? ` — ${detail}` : ""}`);
  checks += 1;
}
function eq<T>(label: string, actual: T, expected: T) {
  assert.deepEqual(actual, expected, `${label} (got ${JSON.stringify(actual)})`);
  checks += 1;
}

const BUSINESS = 42;

/** Midday and midnight in Israel, expressed in UTC so the test states intent. */
const MIDDAY = new Date("2026-06-15T09:00:00Z"); // 12:00 Jerusalem (UTC+3)
const NIGHT = new Date("2026-06-15T20:00:00Z"); // 23:00 Jerusalem

function item(over: Partial<BusinessStatusItem> = {}): BusinessStatusItem {
  return {
    itemId: "x",
    domain: "inventory",
    semanticCategory: "ALERT",
    title: "t",
    summary: null,
    severity: "CRITICAL",
    priorityScore: 90,
    entityRef: { type: "InventoryAlert", id: 7 },
    state: "open",
    createdAt: "2026-06-15T00:00:00.000Z",
    primaryAction: { kind: "navigate", label: "l", href: "/inventory" },
    sourceEngine: "test",
    ...over,
  };
}

function main() {
  /* ------------------------------------------------ silence is the default -- */

  {
    // A real domain, a real category, a severity with no rule.
    const d = decideNotification(BUSINESS, item({ severity: "LOW" }), MIDDAY);
    ok("unlisted severity is silent", d.notify === false);
    eq("silent decision carries no channels", d.channels, []);
  }
  {
    const d = decideNotification(BUSINESS, item({ severity: "INFO" }), MIDDAY);
    ok("INFO is silent", d.notify === false);
  }
  {
    const d = decideNotification(
      BUSINESS,
      item({ domain: "inbox", semanticCategory: "WARNING", severity: "HIGH" }),
      MIDDAY
    );
    ok("unlisted category is silent", d.notify === false);
  }
  {
    // Every domain, every category, every severity: whatever is not in the
    // table must be silent. This is the assertion that stops the table from
    // quietly growing a default.
    const domains = ["inbox", "documents", "inventory", "billing", "supplier", "leads"] as const;
    const cats = ["ACTION_REQUIRED", "ALERT", "WARNING", "FAILURE_EVENT"] as const;
    const sevs = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"] as const;
    let notifying = 0;
    let total = 0;
    for (const domain of domains) {
      for (const semanticCategory of cats) {
        for (const severity of sevs) {
          total += 1;
          const d = decideNotification(
            BUSINESS,
            item({ domain, semanticCategory, severity }),
            MIDDAY
          );
          if (d.notify) notifying += 1;
        }
      }
    }
    eq("the full matrix is 120 combinations", total, 120);
    ok(
      "only a small minority of the matrix notifies at all",
      notifying <= 12,
      `${notifying}/120 notify`
    );
  }

  /* ------------------------------------------------------ push is rare ------ */

  {
    const pushKeys = pushEligibleRuleKeys();
    ok("push is granted to very few rules", pushKeys.length <= 3, pushKeys.join(", "));
    ok(
      "every push rule is CRITICAL or a FAILURE_EVENT",
      pushKeys.every((k) => k.endsWith("|CRITICAL") || k.includes("|FAILURE_EVENT|")),
      pushKeys.join(", ")
    );
    ok(
      "documents never push",
      !pushKeys.some((k) => k.startsWith("documents|")),
      "backlog must never interrupt"
    );
    ok(
      "leads never push",
      !pushKeys.some((k) => k.startsWith("leads|")),
      "the owner scheduled it themselves"
    );
  }

  /* ----------------------------------------------------------- quiet hours -- */

  {
    ok("22:00 Israel is quiet", isQuietHour(new Date("2026-06-15T19:00:00Z")));
    ok("23:00 Israel is quiet", isQuietHour(NIGHT));
    ok("03:00 Israel is quiet", isQuietHour(new Date("2026-06-15T00:00:00Z")));
    ok("06:59 Israel is quiet", isQuietHour(new Date("2026-06-15T03:59:00Z")));
    ok("07:00 Israel is NOT quiet", !isQuietHour(new Date("2026-06-15T04:00:00Z")));
    ok("midday is NOT quiet", !isQuietHour(MIDDAY));
    ok("21:59 Israel is NOT quiet", !isQuietHour(new Date("2026-06-15T18:59:00Z")));

    // The window wraps midnight; a naive `start <= h && h < end` would make it
    // permanently false. Sweep the whole day and count.
    let quiet = 0;
    for (let h = 0; h < 24; h += 1) {
      // Build an instant that lands on hour h in Israel by going through UTC+3.
      const utcHour = (h - 3 + 24) % 24;
      if (isQuietHour(new Date(`2026-06-15T${String(utcHour).padStart(2, "0")}:30:00Z`))) {
        quiet += 1;
      }
    }
    eq("exactly 9 hours of the day are quiet (22,23,0..6)", quiet, 24 - (QUIET_HOURS_START - QUIET_HOURS_END));
  }

  {
    // Quiet hours downgrade push; they never silence the fact.
    const day = decideNotification(BUSINESS, item(), MIDDAY);
    const night = decideNotification(BUSINESS, item(), NIGHT);

    ok("critical stock pushes during the day", day.channels.includes("PUSH"));
    ok("the same fact does NOT push at night", !night.channels.includes("PUSH"));
    ok("but it is still notified in-app at night", night.notify && night.channels.includes("IN_APP"));
    ok("the suppression is stated in the reason", /quiet hours/.test(night.reason));
    eq("cooldown is unaffected by quiet hours", night.cooldownHours, day.cooldownHours);
    eq("dedupe key is unaffected by quiet hours", night.dedupeKey, day.dedupeKey);
  }

  /* ------------------------------------------------------------ dedupe key -- */

  {
    const a = buildDedupeKey(BUSINESS, item());
    const b = buildDedupeKey(BUSINESS, item({ priorityScore: 12, itemId: "different" }));
    eq("key ignores priorityScore and itemId (they change every snapshot)", a, b);

    const laterSnapshot = buildDedupeKey(
      BUSINESS,
      item({ createdAt: "2099-01-01T00:00:00.000Z" })
    );
    eq("key ignores createdAt", a, laterSnapshot);

    const otherEntity = buildDedupeKey(BUSINESS, item({ entityRef: { type: "InventoryAlert", id: 8 } }));
    ok("a different entity is a different fact", a !== otherEntity);

    const otherTenant = buildDedupeKey(99, item());
    ok("the same entity in another business is a different key", a !== otherTenant);
    ok("the key is tenant-qualified", a.startsWith("b42:"));

    const otherDomain = buildDedupeKey(BUSINESS, item({ domain: "billing" }));
    ok("domain participates in identity", a !== otherDomain);
  }

  /* --------------------------------------------------------- snapshot pass -- */

  {
    const items = [
      item(), // critical stock -> notifies
      item({ severity: "LOW", entityRef: { type: "InventoryAlert", id: 2 } }), // silent
      item({
        domain: "documents",
        semanticCategory: "ACTION_REQUIRED",
        severity: "HIGH",
        entityRef: { type: "Document", id: 3 },
      }), // in-app
      item({ severity: "INFO", entityRef: { type: "InventoryAlert", id: 4 } }), // silent
    ];
    const out = decideForSnapshot(BUSINESS, items, MIDDAY);
    eq("silenced items are dropped, not passed downstream", out.length, 2);
    ok("every returned decision is a notifying one", out.every((o) => o.decision.notify));
    ok(
      "each carries its own key",
      new Set(out.map((o) => o.decision.dedupeKey)).size === out.length
    );
  }
  {
    eq("an empty snapshot yields nothing", decideForSnapshot(BUSINESS, [], MIDDAY).length, 0);
  }

  /* ------------------------------------------------------------- cooldowns -- */

  {
    const doc = decideNotification(
      BUSINESS,
      item({ domain: "documents", semanticCategory: "ACTION_REQUIRED", severity: "HIGH", entityRef: { type: "Document", id: 1 } }),
      MIDDAY
    );
    ok("backlog cooldown is long (>= 24h)", doc.cooldownHours >= 24, `${doc.cooldownHours}h`);
    ok("every notifying decision has a non-zero cooldown", doc.cooldownHours > 0);
    ok("every notifying decision has a dedupe key", doc.dedupeKey.length > 0);
    ok("every notifying decision states a reason", doc.reason.length > 0);
  }

  console.log(`notification-policy.verify.test.ts: ok (${checks} checks)`);
}

main();
