/**
 * Profile + Settings v2 — the rules that make the redesign truthful, checked
 * without a database (`npm run verify:profile-settings`).
 *
 *   1. Navigation: every hub row, completion item and Profile link opens a page
 *      that exists; the only row with no destination is the reserved
 *      subscription area, and it says "בקרוב".
 *   2. No invented capability: the reference's unsupported concepts are absent,
 *      and wording never promises what the screen behind it cannot do.
 *   3. Rules: completion, category labels, the quote-expiry boundary, the
 *      subscription view and the version line.
 *   4. Public documentation: the data-deletion page names Settings paths that
 *      exist.
 *
 * Tenant isolation of the two read APIs is proven separately, against a real
 * database under FORCE RLS: app/api/profile-settings.rls.integration.test.ts.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { BUSINESS_CATEGORY_OPTIONS, businessCategoryLabel } from "@/lib/business/business-categories";
import { HOME_ROUTES } from "@/lib/navigation/home-routes";
import { formatAppVersion, resolveAppVersion } from "@/lib/app-version";
import { SETTINGS_CATEGORIES } from "@/components/settings/settings-categories";
import { buildSettingsHub, SUPPORT_EMAIL } from "@/components/settings/settings-hub";

import {
  computeProfileCompletion,
  EMPTY_PROFILE_COMPLETION_INPUT,
  PROFILE_COMPLETION_RULES,
} from "./profile-completion";
import { quoteValidityThreshold } from "./profile-metrics";
import { resolveSubscriptionView } from "./subscription-view";

let passed = 0;
function check(label: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

const read = (file: string) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");

/* ------------------------------------------------ route resolution ------ */

/** Every concrete page route under app/, with route groups "(x)" removed. */
function pageRoutes(): Set<string> {
  const routes = new Set<string>();
  const walk = (dir: string, segments: string[]) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith("_") || entry.name === "api") continue;
        const next = /^\(.*\)$/.test(entry.name) ? segments : [...segments, entry.name];
        walk(path.join(dir, entry.name), next);
      } else if (/^page\.(tsx|ts|jsx|js)$/.test(entry.name)) {
        routes.add("/" + segments.join("/"));
      }
    }
  };
  walk("app", []);
  return routes;
}
const ROUTES = pageRoutes();
const exists = (href: string) => ROUTES.has(href.split(/[?#]/)[0].replace(/\/$/, "") || "/");

/* ============================================ 1. navigation ============== */

const HUB = buildSettingsHub();
const HUB_ROWS = HUB.flatMap((g) => g.rows);

check("the hub has the reference's five groups, in order", () => {
  assert.deepEqual(
    HUB.map((g) => g.title),
    ["החשבון והעסק", "העדפות ואפליקציה", "אבטחה ופרטיות", "חיבורים ואינטגרציות", "עזרה ותמיכה"]
  );
});

check("every hub row leads to a page that exists (or to the support mailbox)", () => {
  for (const row of HUB_ROWS) {
    if (row.href === null) continue;
    if (row.external) {
      assert.equal(row.href, `mailto:${SUPPORT_EMAIL}`, row.key);
      continue;
    }
    assert.ok(exists(row.href), `${row.key} → ${row.href} has no page`);
  }
});

check("the only row without a destination is the reserved subscription area, marked בקרוב", () => {
  const dead = HUB_ROWS.filter((r) => r.href === null);
  assert.deepEqual(dead.map((r) => r.key), ["subscription"]);
  assert.equal(dead[0].badge, "soon");
});

check("every released Settings area is reachable from the hub and the rail source", () => {
  const hubKeys = new Set(HUB_ROWS.map((r) => r.key));
  for (const c of SETTINGS_CATEGORIES) {
    assert.ok(hubKeys.has(c.key), `${c.key} missing from the hub`);
    assert.ok(exists(c.href), `${c.key} → ${c.href} has no page`);
  }
  // Released capabilities the redesign must not drop.
  for (const key of ["team", "business", "import-export", "security", "account-privacy", "connections", "workspace"]) {
    assert.ok(hubKeys.has(key), `${key} was dropped`);
  }
});

check("existing icons are kept — each Settings area keeps its emoji", () => {
  const expected: Record<string, string> = {
    team: "👤",
    business: "🏢",
    connections: "🔌",
    workspace: "🌍",
    security: "🛡️",
    "account-privacy": "🔒",
    "import-export": "🔄",
  };
  for (const c of SETTINGS_CATEGORIES) assert.equal(c.icon, expected[c.key], c.key);
});

check("every completion item links to the page that fills it", () => {
  for (const rule of PROFILE_COMPLETION_RULES) assert.ok(exists(rule.href), `${rule.key} → ${rule.href}`);
});

check("Profile resolves to /profile, and every Profile link exists", () => {
  assert.equal(HOME_ROUTES.profile, "/profile");
  assert.ok(exists("/profile"));
  const src = read("features/account/profile/ProfileScreen.tsx");
  const hrefs = [...src.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length >= 3);
  for (const href of hrefs) assert.ok(exists(href), `Profile links to ${href}, which has no page`);
});

check("the sidebar business card is the shared-nav entry to the Profile", () => {
  const nav = read("components/navigation/nav-destinations.tsx");
  assert.ok(nav.includes('export const PROFILE_HREF = "/profile";'));
  const side = read("components/navigation/side-nav.tsx");
  assert.match(side, /href=\{PROFILE_HREF\}\s+prefetch=\{false\}\s+className="dz-sidebar__business"/);
  assert.ok(exists("/profile"));
});

check("the Settings account card leads to the Profile", () => {
  assert.match(read("features/account/settings/SettingsHubScreen.tsx"), /href="\/profile"/);
});

check("WhatsApp settings returns to Connections, not Tools", () => {
  const src = read("app/(shell)/settings/whatsapp/page.tsx");
  assert.match(src, /backHref="\/settings\/connections"/);
  assert.ok(!src.includes('backHref="/tools"'));
});

/* ================================ 2. no invented capability ============== */

const ALL_HUB_COPY = HUB_ROWS.map((r) => `${r.title} ${r.subtitle}`).join(" ");
const PROFILE_SRC = read("features/account/profile/ProfileScreen.tsx");
const HUB_SRC = read("features/account/settings/SettingsHubScreen.tsx");

check("the hub offers none of the capabilities Dubiz does not have", () => {
  for (const absent of ["ניהול עסקים", "צוות והרשאות", "יישומים מחוברים", "מרכז עזרה", "אילו התראות"]) {
    assert.ok(!ALL_HUB_COPY.includes(absent), `hub shows "${absent}"`);
  }
});

check("wording never promises password change, 2FA, retention or e-signature", () => {
  for (const claim of ["סיסמה", "דו-שלבי", "שמירת נתונים", "חתימה דיגיטלית"]) {
    assert.ok(!ALL_HUB_COPY.includes(claim), `hub copy claims "${claim}"`);
    assert.ok(!PROFILE_SRC.includes(claim), `Profile claims "${claim}"`);
  }
});

check("Profile draws no signature rate, no 'sent', no plan, no businesses list, no team", () => {
  for (const absent of ["שיעור חתימה", "נשלחו", "Dubiz Pro", "העסקים שלי", "הוספת עסק", "צוות והרשאות", ">PRO<"]) {
    assert.ok(!PROFILE_SRC.includes(absent), `Profile shows "${absent}"`);
    assert.ok(!HUB_SRC.includes(absent), `Settings hub shows "${absent}"`);
  }
  assert.ok(PROFILE_SRC.includes("מסמכים שהופקו"));
});

check("no metric or count is a literal in the screens", () => {
  // Numbers on screen come from the API. A digit-only JSX text node would be a hard-coded value.
  for (const src of [PROFILE_SRC, HUB_SRC]) {
    assert.ok(!/>\s*\d[\d,.]*%?\s*</.test(src), "a literal number is rendered");
  }
});

/* ============================================ 3. rules ================== */

check("completion: the approved basis — 6 identity fields, logo, category", () => {
  assert.deepEqual(
    PROFILE_COMPLETION_RULES.map((r) => r.key),
    ["legalName", "businessKind", "taxId", "address", "phone", "email", "logo", "category"]
  );
});

check("completion: none → 0%, all → 100%, partial rounds down", () => {
  assert.equal(computeProfileCompletion(null).percent, 0);
  assert.equal(computeProfileCompletion(EMPTY_PROFILE_COMPLETION_INPUT).filled, 0);
  const full = {
    billingLegalName: "x",
    billingBusinessKind: "EXEMPT_DEALER",
    billingTaxId: "1",
    billingAddress: "a",
    billingPhone: "p",
    billingEmail: "e",
    billingLogoDataUrl: "data:image/png;base64,AAAA",
    category: "Food",
  };
  assert.equal(computeProfileCompletion(full).percent, 100);
  const seven = { ...full, category: null };
  assert.equal(computeProfileCompletion(seven).percent, 87); // 7/8 = 87.5 → 87, never "almost 100"
});

check("completion: whitespace, an unknown business kind and a non-image logo are not filled", () => {
  const r = computeProfileCompletion({
    ...EMPTY_PROFILE_COMPLETION_INPUT,
    billingLegalName: "   ",
    billingBusinessKind: "SOMETHING_ELSE",
    billingLogoDataUrl: "https://example.test/logo.png",
  });
  assert.equal(r.filled, 0);
});

check("completion: a new rule needs no screen change", () => {
  const r = computeProfileCompletion(EMPTY_PROFILE_COMPLETION_INPUT, [
    ...PROFILE_COMPLETION_RULES,
    { key: "extra", label: "x", href: "/business", isFilled: () => true },
  ]);
  assert.equal(r.total, 9);
  assert.equal(r.filled, 1);
});

check("category: one shared map; sub-category label first; 'Other' is not shown as a category", () => {
  assert.equal(businessCategoryLabel("Food", "Cafe"), "בית קפה");
  assert.equal(businessCategoryLabel("Food", null), "אוכל ומשקאות");
  assert.equal(businessCategoryLabel("Other", "General"), null);
  assert.equal(businessCategoryLabel(null, null), null);
  assert.equal(businessCategoryLabel("Legacy free text", null), "Legacy free text");
  assert.ok(BUSINESS_CATEGORY_OPTIONS.length === 7);
  const onboarding = read("app/onboarding/page.tsx");
  assert.ok(onboarding.includes("@/lib/business/business-categories"), "onboarding must import the shared map");
  assert.ok(!onboarding.includes('label: "יופי וטיפוח"'), "onboarding still keeps its own copy");
});

check("quotes: valid through the whole Israeli day of validUntil", () => {
  // 23:30 Israel time on 5 Oct 2026 is 20:30Z — still 5 Oct in Israel.
  assert.equal(quoteValidityThreshold(new Date("2026-10-05T20:30:00Z")).toISOString(), "2026-10-05T00:00:00.000Z");
  // 00:30 Israel time on 6 Oct is 21:30Z on 5 Oct — already 6 Oct in Israel.
  assert.equal(quoteValidityThreshold(new Date("2026-10-05T21:30:00Z")).toISOString(), "2026-10-06T00:00:00.000Z");
});

check("subscription: unavailable until a real subscription exists", () => {
  assert.deepEqual(resolveSubscriptionView(), { status: "unavailable" });
});

check("version: package version, plus the short deployed commit only when there is one", () => {
  assert.equal(formatAppVersion(resolveAppVersion({})), resolveAppVersion({}).version);
  assert.equal(
    formatAppVersion(resolveAppVersion({ VERCEL_GIT_COMMIT_SHA: "A13D43F8E2B" })),
    `${resolveAppVersion({}).version} (a13d43f)`
  );
  assert.equal(resolveAppVersion({ VERCEL_GIT_COMMIT_SHA: "not a sha" }).build, null);
});

/* ================================ 4. public documentation =============== */

check("the public data-deletion page names Settings paths that exist", () => {
  const page = read("app/(corporate)/data-deletion/page.tsx");
  const titles = new Map(SETTINGS_CATEGORIES.map((c) => [c.key, c.title]));
  assert.ok(page.includes(`הגדרות ← ${titles.get("account-privacy")} ← מחיקת חשבון`), "account deletion path");
  assert.ok(page.includes(`הגדרות ← ${titles.get("connections")} ← WhatsApp ← מחיקת נתוני Meta`), "Meta path");
  assert.ok(read("components/settings/DeleteAccountSection.tsx").includes("מחיקת חשבון"));
  assert.ok(read("app/settings/account/page.tsx").includes(`>${titles.get("account-privacy")}<`));
});

check("the tax-invoice identity error names the Settings row that exists", () => {
  const src = read("lib/billing/business-identity.ts");
  assert.ok(src.includes(`(הגדרות › ${SETTINGS_CATEGORIES.find((c) => c.key === "business")!.title})`));
});

console.log(`\nPROFILE + SETTINGS VERIFY PASS — ${passed} checks green.`);
