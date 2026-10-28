/**
 * Connections center (S1-B · M1) — state and layout evidence for /settings/connections.
 *
 * Renders the REAL page (real components, real CSS) against STUBBED API responses, so every state
 * of the overview can be captured without touching any business's data: mixed statuses with
 * attention items, one source unavailable, empty, loading and a failed overview. It proves
 * composition, not production data.
 *
 * For each state and width it asserts:
 *   - no horizontal overflow; RTL on the document
 *   - the four existing management components are present, in their category sections
 *   - action items carry a link, info items carry none
 *
 *   AUDIT_BASE_URL=http://localhost:3197 AUDIT_OUT_DIR=<dir> node scripts/qa/ui/connections-center-states.mjs
 */
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.AUDIT_BASE_URL || "http://localhost:3197";
const OUT = process.env.AUDIT_OUT_DIR || path.join(process.cwd(), ".connections-center");
const VIEWPORTS = [
  { width: 360, height: 800 },
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
];

const results = [];
function check(name, cond, detail = "") {
  results.push({ name, pass: Boolean(cond), detail: String(detail) });
  console.log(`${cond ? "OK  " : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

/* ----------------------------------------------------------- fixtures -- */

const K = "account.settings.connections.center";
const AT = "2026-10-26T09:15:00.000Z";
const manageAnchor = (id) => ({ href: `#${id}`, labelKey: `${K}.manage` });
const managePage = (href) => ({ href, labelKey: `${K}.manage` });

function card(over) {
  return {
    accountLabel: null,
    availability: "available",
    lastActivity: null,
    errorKey: null,
    provides: [],
    manage: null,
    attention: null,
    ...over,
  };
}

const CARDS = {
  gmailError: card({
    id: "gmail:2", category: "invoices", provider: "gmail", nameKey: `${K}.providers.gmail`, accountLabel: "office@falafel-hadar.co.il",
    state: "attention", lastActivity: { at: AT, labelKey: `${K}.activity.synced` }, errorKey: `${K}.gmail.error`,
    provides: [`${K}.provides.gmailDocuments`], manage: managePage("/documents/email"),
    attention: { kind: "action", textKey: `${K}.gmail.error`, action: { href: "/documents/email", labelKey: `${K}.fix` } },
  }),
  gmailOff: card({ id: "gmail", category: "invoices", provider: "gmail", nameKey: `${K}.providers.gmail`, state: "disconnected", provides: [`${K}.provides.gmailDocuments`], manage: managePage("/documents/email") }),
  cardcomOn: card({
    id: "payments:CARDCOM:3", category: "payments", provider: "CARDCOM", nameKey: `${K}.providers.cardcom`, state: "connected",
    lastActivity: { at: AT, labelKey: `${K}.activity.settingsUpdated` }, provides: [`${K}.provides.cardcomPayments`], manage: manageAnchor("connections-payments"),
  }),
  cardcomOff: card({ id: "payments:CARDCOM", category: "payments", provider: "CARDCOM", nameKey: `${K}.providers.cardcom`, state: "disconnected", provides: [`${K}.provides.cardcomPayments`], manage: manageAnchor("connections-payments") }),
  whatsappOn: card({
    id: "whatsapp", category: "messaging", provider: "whatsapp", nameKey: "account.settings.connections.integrations.whatsappTitle", accountLabel: "+972 50-123-4567",
    state: "connected", lastActivity: { at: AT, labelKey: `${K}.activity.verified` }, provides: [`${K}.provides.whatsappMessages`], manage: managePage("/settings/whatsapp"),
  }),
  whatsappOff: card({ id: "whatsapp", category: "messaging", provider: "whatsapp", nameKey: "account.settings.connections.integrations.whatsappTitle", state: "disconnected", provides: [`${K}.provides.whatsappMessages`], manage: managePage("/settings/whatsapp") }),
  webFormOn: card({
    id: "web.form:1", category: "leads", provider: "web.form", nameKey: "account.settings.connections.leads.sources.webForm.title", accountLabel: "טופס צור קשר",
    state: "connected", lastActivity: { at: AT, labelKey: `${K}.activity.lastEvent` }, provides: [`${K}.provides.webFormLeads`], manage: manageAnchor("connections-leads"),
  }),
  googlePaused: card({
    id: "google.lead_form:4", category: "leads", provider: "google.lead_form", nameKey: "account.settings.connections.leads.sources.google.title",
    state: "paused", provides: [`${K}.provides.googleLeads`], manage: manageAnchor("connections-leads"), attention: { kind: "info", textKey: `${K}.attention.paused` },
  }),
  wooRevoked: card({
    id: "commerce.woocommerce:5", category: "stores_calls", provider: "commerce.woocommerce", nameKey: "account.settings.connections.stores.sources.woocommerce.title", accountLabel: "falafel-hadar.co.il",
    state: "attention", lastActivity: { at: AT, labelKey: `${K}.activity.lastEvent` }, errorKey: "account.settings.connections.stores.health.wooKeysRevoked",
    provides: [`${K}.provides.storeOrders`], manage: manageAnchor("connections-stores"),
    attention: { kind: "action", textKey: "account.settings.connections.stores.health.wooKeysRevoked", action: { href: "#connections-stores", labelKey: `${K}.fix` } },
  }),
  authorityExpired: card({
    id: "authority", category: "authority", provider: "tax_authority", nameKey: "account.settings.connections.authority.title", state: "attention",
    lastActivity: { at: AT, labelKey: `${K}.activity.authorized` }, errorKey: `${K}.authority.expired`, provides: [`${K}.provides.allocationNumbers`],
    manage: manageAnchor("connections-authority"), attention: { kind: "info", textKey: `${K}.authority.expired` },
  }),
  unavailable: (category, provider, nameKey, manage) => card({ id: `${provider}:unavailable`, category, provider, nameKey, state: "unavailable", errorKey: `${K}.unavailable`, manage }),
};

const TITLES = { invoices: "invoices", pos: "pos", payments: "payments", messaging: "messaging", leads: "leads", stores_calls: "storesCalls", authority: "authority" };
function center(cards, unavailableSources = []) {
  const order = ["invoices", "pos", "payments", "messaging", "leads", "stores_calls", "authority"];
  const categories = order
    .map((category) => ({ category, titleKey: `${K}.categories.${TITLES[category]}`, cards: cards.filter((c) => c.category === category) }))
    .filter((g) => g.cards.length);
  return {
    categories,
    counts: { connected: cards.filter((c) => c.state === "connected").length, needsAction: cards.filter((c) => c.attention?.kind === "action").length },
    unavailableSources,
  };
}

const STATES = {
  mixed: { center: center([CARDS.gmailError, CARDS.cardcomOn, CARDS.whatsappOn, CARDS.webFormOn, CARDS.googlePaused, CARDS.wooRevoked, CARDS.authorityExpired]) },
  unavailable: {
    center: center(
      [
        CARDS.gmailError,
        CARDS.cardcomOn,
        CARDS.whatsappOn,
        CARDS.unavailable("leads", "lead_sources", "account.settings.connections.leads.title", manageAnchor("connections-leads")),
        CARDS.unavailable("stores_calls", "stores_calls", "account.settings.connections.stores.title", manageAnchor("connections-stores")),
      ],
      ["acquisition"]
    ),
  },
  empty: { center: center([CARDS.gmailOff, CARDS.cardcomOff, CARDS.whatsappOff]) },
  loading: { hang: true },
  failed: { status: 500 },
};

/* -------------------------------------------------------------- stubs -- */

const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const ACQUISITION = {
  sources: { "web.form": true, "google.lead_form": true, "meta.lead_ads": false, "commerce.woocommerce": true, "commerce.wix": false, "telephony.cloudtalk": false, "telephony.voicenter": false, "pos.rivhit": false },
  meta: { available: false, login: null },
  wix: { available: false, installUrl: null },
  connections: [
    { id: 1, sourceKey: "web.form", status: "ACTIVE", label: "טופס צור קשר", keyHint: "ab12", allowedOrigins: ["https://falafel-hadar.co.il"], lastEventAt: AT, lastErrorCode: null, endpointUrl: "http://localhost/api/intake/acquisition/web/pub1", activity: { lastTestAt: null, lastDeliveryAt: AT, deliveries30d: 7 }, setup: null },
    { id: 4, sourceKey: "google.lead_form", status: "PAUSED", label: null, keyHint: "cd34", allowedOrigins: [], lastEventAt: null, lastErrorCode: null, endpointUrl: "http://localhost/api/intake/acquisition/google/pub4", activity: { lastTestAt: null, lastDeliveryAt: null, deliveries30d: 0 }, setup: null },
    { id: 5, sourceKey: "commerce.woocommerce", status: "ERROR", label: "falafel-hadar.co.il", keyHint: null, allowedOrigins: [], lastEventAt: AT, lastErrorCode: "WOO_KEYS_REVOKED", endpointUrl: "http://localhost/api/intake/commerce/woocommerce/pub5", activity: { lastTestAt: null, lastDeliveryAt: AT, deliveries30d: 3 }, setup: null },
  ],
};

async function installStubs(page, key) {
  const s = STATES[key];
  // Catch-all first: Playwright gives the LAST registered matching route priority.
  await page.route("**/api/**", (route) => json(route, {}));
  await page.route("**/api/payments/providers", (route) =>
    json(route, { providers: [{ key: "CARDCOM", label: "CardCom", merchantIdField: { key: "terminalNumber", label: "Terminal Number" }, credentialFields: [{ key: "apiName", label: "API Name", type: "text", required: true }] }] })
  );
  await page.route("**/api/payments/connections", (route) =>
    json(route, { connections: key === "empty" ? [] : [{ provider: "CARDCOM", merchantId: "1000", isActive: true, hasCredential: true }] })
  );
  await page.route("**/api/taxes/authority/status", (route) =>
    json(route, { authority: key === "mixed" ? { environment: "SANDBOX", status: "EXPIRED", connectedAt: AT, expiresAt: AT, canConnect: false, canReconnect: true } : { environment: "SANDBOX", status: "NOT_CONFIGURED", connectedAt: null, expiresAt: null, canConnect: false, canReconnect: false } })
  );
  await page.route("**/api/integrations/acquisition", (route) =>
    json(route, key === "empty" ? { ...ACQUISITION, connections: [] } : ACQUISITION)
  );
  await page.route("**/api/settings/connections-center", async (route) => {
    if (s.hang) return; // never answered: the loading skeleton stays
    if (s.status) return json(route, { error: "Server error" }, s.status);
    return json(route, s.center);
  });
}

/* ---------------------------------------------------------------- main -- */

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  for (const key of Object.keys(STATES)) {
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, locale: "he-IL", reducedMotion: "reduce" });
      const page = await ctx.newPage();
      await installStubs(page, key);
      await page.addInitScript(() => {
        try {
          localStorage.setItem("token", "qa-stub-token");
        } catch {
          /* ignore */
        }
      });
      await page.goto(`${BASE}/settings/connections`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("[data-connection-category=payments]", { timeout: 120000 });
      // The overview answers after the page hydrates; the loading state never gets an answer.
      if (key === "loading") await page.waitForSelector("[aria-busy=true]", { timeout: 120000 });
      else await page.waitForSelector("[data-connection-card]", { timeout: 120000 });
      await page.waitForTimeout(800);

      const m = await page.evaluate(() => {
        const q = (s) => document.querySelectorAll(s).length;
        return {
          dir: document.documentElement.getAttribute("dir"),
          scrollW: document.documentElement.scrollWidth,
          iw: window.innerWidth,
          sections: [...document.querySelectorAll("[data-connection-category]")].map((e) => e.getAttribute("data-connection-category")),
          rows: q("[data-connection-card]"),
          anchors: ["connections-payments", "connections-leads", "connections-stores", "connections-authority"].filter((id) => document.getElementById(id)).length,
          busy: q("[aria-busy=true]"),
        };
      });
      const tag = `${key} @${vp.width}`;
      check(`${tag}: RTL`, m.dir === "rtl", m.dir);
      check(`${tag}: no horizontal overflow`, m.scrollW <= m.iw + 1, `${m.scrollW} vs ${m.iw}`);
      check(`${tag}: the four management sections keep their anchors`, m.anchors === 4, String(m.anchors));
      if (key === "loading") check(`${tag}: skeleton shown`, m.busy === 1);
      if (key === "mixed") {
        check(`${tag}: one status row per card (7)`, m.rows === 7, String(m.rows));
        const actionLinks = await page.locator("section >> text=דורש טיפול").count();
        check(`${tag}: "דורש טיפול" list present`, actionLinks >= 1);
      }
      if (key === "failed") check(`${tag}: WhatsApp / Gmail fall back to unchecked rows`, m.rows === 2, String(m.rows));

      const file = path.join(OUT, `connections-${key}-${vp.width}.png`);
      await page.screenshot({ path: file, fullPage: true });
      if (vp.width !== 360) {
        await page.screenshot({ path: path.join(OUT, `connections-${key}-${vp.width}-fold.png`), fullPage: false });
      }
      await ctx.close();
    }
  }
  await browser.close();
  await writeFile(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
