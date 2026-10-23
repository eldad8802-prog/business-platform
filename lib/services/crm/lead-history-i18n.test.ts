/**
 * Verify — lead lifecycle history labels (B-4).
 * Run: npx tsx lib/services/crm/lead-history-i18n.test.ts
 *
 * The history API keeps returning the Hebrew `label` / `nextActionLabel` (unchanged response); the lead
 * card translates by `kind` instead. Pins: every event / next-action kind has a dictionary key, and the
 * Hebrew dictionary is byte-identical to the server maps, so Hebrew screens render exactly as before.
 */
import assert from "node:assert/strict";

import { getMessages } from "@/lib/i18n/messages";
import {
  LEAD_LIFECYCLE_EVENT_KINDS,
  LEAD_LIFECYCLE_EVENT_LABELS,
  LEAD_NEXT_ACTION_KINDS,
  LEAD_NEXT_ACTION_LABELS,
} from "@/lib/services/crm/lead-lifecycle-core";

const camel = (k: string) => k.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());
const he = getMessages("he").customers.leads.lifecycle;
const en = getMessages("en").customers.leads.lifecycle;

let checks = 0;
for (const kind of LEAD_LIFECYCLE_EVENT_KINDS) {
  const key = camel(kind) as keyof typeof he.events;
  assert.equal(he.events[key], LEAD_LIFECYCLE_EVENT_LABELS[kind], `he events.${key}`);
  assert.ok(en.events[key] && !/[֐-׿]/.test(en.events[key]), `en events.${key}`);
  checks += 2;
}
for (const kind of LEAD_NEXT_ACTION_KINDS) {
  const key = camel(kind) as keyof typeof he.nextActions;
  assert.equal(he.nextActions[key], LEAD_NEXT_ACTION_LABELS[kind], `he nextActions.${key}`);
  assert.ok(en.nextActions[key] && !/[֐-׿]/.test(en.nextActions[key]), `en nextActions.${key}`);
  checks += 2;
}
console.log(`lead history i18n: ${checks} checks pass`);
