/**
 * Action availability (Daily Tasks spec 4.5, T-A3) — one registry, no local "coming soon" literals.
 *
 *   1. The registry keeps exactly today's states: every governed action is COMING_SOON. Opening one is a
 *      separate decision of its domain and must show up here as a deliberate diff.
 *   2. The screens that show these actions read the registry: each imports it, names its action ids, and no
 *      longer carries a bare `comingSoon` attribute or a hard-coded `disabled` on the governed buttons.
 *   3. R7: the secretary's notification preferences are not stored, so they render inactive with the
 *      coming-soon pill — no local toggle state is left that could pretend otherwise.
 *
 * Pure (reads source files, no DB, no network). Run: npx tsx lib/features/action-availability.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OWNER_ACTION_AVAILABILITY, isActionOpen, isComingSoon, type OwnerActionId } from "./action-availability";

let failed = 0;
let checks = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  checks += 1;
  if (cond) console.log(`OK: ${name}`);
  else {
    failed += 1;
    console.error(`FAIL: ${name}`, extra ?? "");
  }
}

const ROOT = join(__dirname, "..", "..");
const src = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

// ── 1. Today's states, exactly ─────────────────────────────────────────────────────────────────
const EXPECTED: Record<OwnerActionId, "COMING_SOON"> = {
  "whatsapp.reconnect": "COMING_SOON",
  "whatsapp.switch_number": "COMING_SOON",
  "whatsapp.connect": "COMING_SOON",
  "tax_authority.connect": "COMING_SOON",
  "tax_authority.reconnect": "COMING_SOON",
  "meta_lead_ads.connect": "COMING_SOON",
  "meta_lead_ads.reconnect": "COMING_SOON",
  "secretary.notification_preferences": "COMING_SOON",
};
ok("the registry holds exactly the governed actions", JSON.stringify(Object.keys(OWNER_ACTION_AVAILABILITY).sort()) === JSON.stringify(Object.keys(EXPECTED).sort()));
for (const [id, state] of Object.entries(EXPECTED) as [OwnerActionId, string][]) {
  ok(`${id} is ${state} (unchanged from the component it came from)`, OWNER_ACTION_AVAILABILITY[id] === state);
  ok(`${id}: isComingSoon / isActionOpen agree`, isComingSoon(id) === !isActionOpen(id));
}
ok("the registry is frozen", Object.isFrozen(OWNER_ACTION_AVAILABILITY));

// ── 2. The screens read the registry ───────────────────────────────────────────────────────────
const GOVERNED: Record<string, OwnerActionId[]> = {
  "components/whatsapp/WhatsAppConnectedCard.tsx": ["whatsapp.reconnect", "whatsapp.switch_number"],
  "components/whatsapp/WhatsAppConnectInvitation.tsx": ["whatsapp.connect"],
  "components/settings/LeadSourcesPanel.tsx": ["meta_lead_ads.connect", "meta_lead_ads.reconnect"],
  "components/settings/AuthorityConnectionCard.tsx": ["tax_authority.connect", "tax_authority.reconnect"],
  "app/(shell)/secretary/secretary-ui.tsx": ["secretary.notification_preferences"],
};
for (const [file, ids] of Object.entries(GOVERNED)) {
  const s = src(file);
  ok(`${file} imports the registry`, /from "@\/lib\/features\/action-availability"/.test(s));
  for (const id of ids) ok(`${file} reads ${id}`, s.includes(`isComingSoon("${id}")`));
  // A bare JSX `comingSoon` attribute (it ends the tag or its line), or `comingSoon={true}`, is a local literal.
  const bare = s.match(/\scomingSoon(?=\s*(?:\/?>|\r?\n))|comingSoon=\{true\}/g) ?? [];
  ok(`${file} has no local comingSoon literal`, bare.length === 0, bare);
}
const authority = src("components/settings/AuthorityConnectionCard.tsx");
ok("the Tax Authority buttons are not hard-coded disabled", !/onClick=\{startConnect\} disabled>/.test(authority));

// ── 3. R7 ──────────────────────────────────────────────────────────────────────────────────────
const secretary = src("app/(shell)/secretary/secretary-ui.tsx");
const notify = secretary.slice(secretary.indexOf("function NotifyScreen("), secretary.indexOf("function Horizon("));
ok("R7: the notification screen keeps no local toggle state", !/useState\(/.test(notify), notify.match(/useState\([^)]*\)/g));
ok("R7: all three preference rows render through the registry", (notify.match(/comingSoon=\{prefsSoon\}/g) ?? []).length === 3);
ok("R7: an inactive row shows the coming-soon pill and is not a button",
  /if \(comingSoon\) return <div className=\{styles\.settingRow\} aria-disabled="true">.*<ComingSoonPill \/><\/div>;/.test(secretary));

console.log(failed === 0 ? `\naction availability: all ${checks} checks hold.` : `\n${failed} of ${checks} FAILED`);
process.exit(failed === 0 ? 0 : 1);
