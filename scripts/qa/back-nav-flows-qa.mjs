/**
 * Back navigation — REAL FLOW CHAINS in a real browser.
 *
 * Each chain walks an entry path the way a user does (real clicks, typing and
 * links; `window.next.router.push` — the router every <Link> uses — only to
 * stand in for "arrived from screen X"), then presses back several times in a
 * row. Every press must land on the previous step ACTUALLY taken, with the data
 * entered still there; steps after a completed action must not re-trigger it
 * (committing POSTs are counted). Several chains are replayed with the
 * browser's own Back to prove both follow the same order.
 *
 * Output: qa-evidence/back-nav/flow-chains.md (+ .json, screenshots per step).
 * Run: build, `npx next start -p 3527`, then `node scripts/qa/back-nav-flows-qa.mjs`.
 */
import { chromium, webkit } from "playwright";
// QA_BROWSER=webkit runs the same suite on WebKit (Safari engine).
const ENGINE = process.env.QA_BROWSER === "webkit" ? webkit : chromium;
import { mkdirSync } from "node:fs";
import { wire, posts, resetPosts } from "./back-nav-fixtures.mjs";
import { check, here, runChain, summary, writeEvidence } from "./back-nav-chain-lib.mjs";

const BASE = process.env.QA_BASE ?? "http://localhost:3527";
const ONLY = process.env.QA_ONLY ? new Set(process.env.QA_ONLY.split(",")) : null;
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "mobile", width: 390, height: 844 },
];
mkdirSync("qa-evidence/back-nav/chains", { recursive: true });

const settle = (page) => page.waitForLoadState("networkidle").catch(() => {});
async function pushTo(page, url) {
  await page.evaluate((u) => window.next.router.push(u), url);
  await page.waitForFunction((u) => decodeURIComponent(location.pathname + location.search) === u, url, { timeout: 15000 });
  await settle(page);
}
const at = (path) => (url) => url === path;
const startsAt = (path) => (url) => url.split("?")[0] === path;
const step = (label, act) => ({ label, act });
async function clickVisible(page, locator) {
  return locator.filter({ visible: true }).first().click();
}
const waitUrl = (page, pred) =>
  page.waitForFunction(
    (src) => new Function("u", `return (${src})(u)`)(decodeURIComponent(location.pathname + location.search)),
    pred.toString(),
    { timeout: 15000 },
  );

/* ================================================================ chains == */

function chains(vp) {
  const crmSinglePane = vp.width < 1280; // ≥1280: CRM two-pane, card back hidden
  const list = [];

  /* F1 — Collection create: in-screen steps, entered data kept ------------- */
  list.push({
    id: "F1-collection-steps",
    title: "Collection: customer → details → other customer, then back ×3",
    entry: [
      step("Tools", (p) => p.goto(`${BASE}/tools`, { waitUntil: "networkidle" })),
      step("Collection", (p) => pushTo(p, "/collection")),
      step("גבה", async (p) => {
        await p.getByRole("button", { name: "גבה", exact: true }).first().click();
        await waitUrl(p, (u) => u === "/collection/new");
      }),
      step("pick customer", async (p) => {
        await p.getByRole("option").first().click();
        await waitUrl(p, (u) => u === "/collection/new?step=details");
        await p.locator("#amount").waitFor();
        await p.locator("#amount").fill("450");
      }),
      step("לקוח אחר", async (p) => {
        await p.getByRole("button", { name: "לקוח אחר" }).click();
        // The customer step is the flow's first step: its URL carries no param.
        await waitUrl(p, (u) => u === "/collection/new");
        await p.getByRole("listbox", { name: "לקוחות" }).waitFor();
      }),
    ],
    backs: [
      { label: "details step, amount 450 kept", expect: at("/collection/new?step=details"),
        checks: async (p) => [["amount still 450", (await p.locator("#amount").inputValue()) === "450", await p.locator("#amount").inputValue()]] },
      { label: "customer step (flow start)", expect: at("/collection/new"),
        checks: async (p) => [["customer picker shown", await p.getByRole("listbox", { name: "לקוחות" }).isVisible()]] },
      { label: "collection inbox (a root: no back control)", expect: at("/collection"),
        checks: async (p) => [["root shows no back control", (await p.locator("[data-dz-back]:visible").count()) === 0]] },
    ],
  });

  /* F2 — Collection: completed action is not re-triggered ----------------- */
  list.push({
    id: "F2-collection-created",
    title: "Collection: create request → send step, back ×1 (no second request)",
    before: () => resetPosts(),
    entry: [
      step("Collection", (p) => p.goto(`${BASE}/collection`, { waitUntil: "networkidle" })),
      step("גבה", async (p) => {
        await p.getByRole("button", { name: "גבה", exact: true }).first().click();
        await waitUrl(p, (u) => u === "/collection/new");
      }),
      step("pick customer", async (p) => {
        await p.getByRole("option").first().click();
        await waitUrl(p, (u) => u === "/collection/new?step=details");
        await p.locator("#amount").fill("450");
      }),
      step("צור בקשה (POST)", async (p) => {
        await p.getByRole("button", { name: /צור בקשה/ }).click();
        await waitUrl(p, (u) => u === "/collection/new?step=send");
        await p.getByRole("button", { name: "שליחה בוואטסאפ" }).waitFor();
      }),
    ],
    backs: [
      { label: "collection inbox — the completed flow is left as a whole", expect: at("/collection"),
        checks: async (p) => [
          ["exactly one payment request POSTed", posts.paymentRequest === 1, `POSTs=${posts.paymentRequest}`],
          ["no create form / send step shown", (await p.getByRole("button", { name: /צור בקשה/ }).count()) === 0 && (await p.getByRole("button", { name: "שליחה בוואטסאפ" }).count()) === 0],
        ] },
    ],
  });

  /* F3 — Pricing: catalog → calc → result (button) ------------------------ */
  const pricingEntry = [
    step("Tools", (p) => p.goto(`${BASE}/tools`, { waitUntil: "networkidle" })),
    step("Pricing", (p) => pushTo(p, "/pricing")),
    step("item תספורת", async (p) => {
      await p.getByRole("button", { name: /תספורת/ }).click();
      await waitUrl(p, (u) => u === "/pricing?step=calc");
      await p.locator("#calc-material").fill("123");
    }),
    step("חשב מחיר", async (p) => {
      await p.getByRole("button", { name: "חשב מחיר" }).click();
      await waitUrl(p, (u) => u === "/pricing?step=result");
    }),
  ];
  const pricingBacks = [
    { label: "calc form, 123 kept", expect: at("/pricing?step=calc"),
      checks: async (p) => [["material cost still 123", (await p.locator("#calc-material").inputValue()) === "123", await p.locator("#calc-material").inputValue()]] },
    { label: "catalog", expect: at("/pricing"),
      checks: async (p) => [["catalog list shown", await p.getByRole("button", { name: /צבע/ }).isVisible()]] },
    { label: "Tools", expect: at("/tools") },
  ];
  list.push({ id: "F3-pricing-calc", title: "Pricing: catalog → calculation → result, back ×3", entry: pricingEntry, backs: pricingBacks });
  list.push({ id: "F3b-pricing-calc-browser", title: "Pricing: same chain, browser Back", entry: pricingEntry, backs: pricingBacks, via: "browser" });

  /* F4 — Pricing new item wizard ----------------------------------------- */
  list.push({
    id: "F4-pricing-new",
    title: "Pricing: new item step 1 → step 2, back ×3",
    entry: [
      step("Tools", (p) => p.goto(`${BASE}/tools`, { waitUntil: "networkidle" })),
      step("Pricing", (p) => pushTo(p, "/pricing")),
      step("+ הוספת פריט", async (p) => {
        await p.getByRole("button", { name: "הוספת פריט" }).first().click();
        await waitUrl(p, (u) => u === "/pricing?step=new1");
        await p.getByPlaceholder("לדוגמה: ייעוץ אסטרטגי").fill("ייעוץ");
      }),
      step("המשך לעלויות", async (p) => {
        await p.getByRole("button", { name: "המשך לעלויות" }).click();
        await waitUrl(p, (u) => u === "/pricing?step=new2");
      }),
    ],
    backs: [
      { label: "step 1, name kept", expect: at("/pricing?step=new1"),
        checks: async (p) => [["item name still ייעוץ", (await p.getByPlaceholder("לדוגמה: ייעוץ אסטרטגי").inputValue()) === "ייעוץ"]] },
      { label: "catalog", expect: at("/pricing") },
      { label: "Tools", expect: at("/tools"),
        checks: async () => [["no item was created", posts.pricingCreate === 0, `POSTs=${posts.pricingCreate}`]] },
    ],
  });

  /* F5 — Coupon wizard ------------------------------------------------------ */
  list.push({
    id: "F5-coupon-wizard",
    title: "Coupons: my coupons → create → goal → direction → builder, back ×5 (draft guard)",
    entry: [
      step("Tools", (p) => p.goto(`${BASE}/tools`, { waitUntil: "networkidle" })),
      step("My coupons", (p) => pushTo(p, "/revenue")),
      step("צור קופון חדש", async (p) => {
        await p.getByRole("button", { name: "צור קופון חדש" }).first().click();
        await waitUrl(p, (u) => u === "/revenue?view=create");
      }),
      step("goal", async (p) => {
        await p.getByRole("button", { name: /להביא לקוחות חדשים/ }).click();
        await waitUrl(p, (u) => u === "/revenue?view=create&cstep=direction");
      }),
      step("direction הנחה", async (p) => {
        await p.getByRole("button", { name: /^הנחה/ }).click();
        await waitUrl(p, (u) => u === "/revenue?view=create&cstep=builder");
      }),
    ],
    backs: [
      { label: "direction step", expect: at("/revenue?view=create&cstep=direction") },
      { label: "goal step (first step of the flow)", expect: at("/revenue?view=create") },
      { label: "my coupons — after confirming the discard prompt", expect: at("/revenue"), dialog: "accept" },
      { label: "Tools", expect: at("/tools") },
    ],
  });

  /* F6 — Redeem: error path, typed code kept ------------------------------- */
  list.push({
    id: "F6-redeem-error",
    title: "Redeem: scan → manual → wrong code (error), back ×3",
    before: () => resetPosts(),
    entry: [
      step("Tools", (p) => p.goto(`${BASE}/tools`, { waitUntil: "networkidle" })),
      step("Redeem", (p) => pushTo(p, "/revenue/redeem")),
      step("הקלד קוד", async (p) => {
        await p.getByRole("button", { name: "הקלד קוד במקום סריקה" }).click();
        await waitUrl(p, (u) => u === "/revenue/redeem?step=manual");
        await p.getByPlaceholder("הדבק או הקלד קוד קופון").fill("BAD");
      }),
      step("אמת קופון → error", async (p) => {
        await p.getByRole("button", { name: "אמת קופון" }).click();
        await waitUrl(p, (u) => u === "/revenue/redeem?step=error");
      }),
    ],
    backs: [
      { label: "manual entry, code kept", expect: at("/revenue/redeem?step=manual"),
        checks: async (p) => [["code still BAD", (await p.getByPlaceholder("הדבק או הקלד קוד קופון").inputValue()) === "BAD"]] },
      { label: "scan step", expect: at("/revenue/redeem") },
      { label: "Tools", expect: at("/tools") },
    ],
  });

  /* F7 — Redeem: success is a completed action ------------------------------ */
  list.push({
    id: "F7-redeem-done",
    title: "Redeem: manual → redeemed (completed), back ×2 (no second redemption)",
    before: () => resetPosts(),
    entry: [
      step("Tools", (p) => p.goto(`${BASE}/tools`, { waitUntil: "networkidle" })),
      step("Redeem", (p) => pushTo(p, "/revenue/redeem")),
      step("הקלד קוד", async (p) => {
        await p.getByRole("button", { name: "הקלד קוד במקום סריקה" }).click();
        await waitUrl(p, (u) => u === "/revenue/redeem?step=manual");
        await p.getByPlaceholder("הדבק או הקלד קוד קופון").fill("GOOD1");
      }),
      step("אמת קופון → redeemed", async (p) => {
        await p.getByRole("button", { name: "אמת קופון" }).click();
        await waitUrl(p, (u) => u === "/revenue/redeem?step=done");
      }),
    ],
    backs: [
      { label: "scan step — manual entry was replaced (completed)", expect: at("/revenue/redeem"),
        checks: async () => [["exactly one redemption POST", posts.redeem === 1, `POSTs=${posts.redeem}`]] },
      { label: "Tools", expect: at("/tools"),
        checks: async () => [["still one redemption", posts.redeem === 1, `POSTs=${posts.redeem}`]] },
    ],
  });

  /* F8 — Secretary: query-routed screens ------------------------------------ */
  list.push({
    id: "F8-secretary",
    title: "Secretary: home → all → item → edit, back ×3",
    entry: [
      step("Secretary", (p) => p.goto(`${BASE}/secretary`, { waitUntil: "networkidle" })),
      step("all", (p) => pushTo(p, "/secretary?screen=all")),
      step("item חברת החשמל", async (p) => {
        await p.getByRole("button", { name: /חברת החשמל/ }).first().click();
        if (vp.width >= 1200) await p.getByRole("link", { name: "הפעולה הבאה" }).click();
        await waitUrl(p, (u) => u === "/secretary?screen=detail&id=41");
      }),
      step("עריכת התחייבות", async (p) => {
        await p.getByRole("link", { name: "עריכת התחייבות" }).click();
        await waitUrl(p, (u) => u === "/secretary?screen=update&id=41");
      }),
    ],
    backs: [
      { label: "item detail", expect: at("/secretary?screen=detail&id=41") },
      { label: "all obligations", expect: at("/secretary?screen=all") },
      { label: "secretary home", expect: at("/secretary") },
    ],
  });

  /* F9 — Documents: search state restored ---------------------------------- */
  list.push({
    id: "F9-documents-search",
    title: "Documents: hub → search (query + filter) → document, back ×2",
    entry: [
      step("Documents", (p) => p.goto(`${BASE}/documents`, { waitUntil: "networkidle" })),
      step("search", (p) => pushTo(p, "/documents/search")),
      step("query דלק + filter הוצאה", async (p) => {
        await p.getByPlaceholder("חיפוש לפי שם ספק או קטגוריה").fill("דלק");
        await p.getByRole("button", { name: "הוצאה" }).click();
        await settle(p);
        await p.waitForTimeout(500);
      }),
      step("open דלק 2", async (p) => {
        // Phone/tablet: the card opens the document. Desktop: the row selects
        // it and the inspector's "פתח מסמך" opens it.
        await p.locator("text=דלק 2 >> visible=true").first().click();
        await p.waitForTimeout(400);
        if (!here(p).startsWith("/documents/review/")) await p.getByRole("button", { name: "פתח מסמך" }).click();
        await waitUrl(p, (u) => u.startsWith("/documents/review/"));
      }),
    ],
    backs: [
      { label: "search, query + filter restored", expect: at("/documents/search"),
        checks: async (p) => [
          ["query still דלק", (await p.getByPlaceholder("חיפוש לפי שם ספק או קטגוריה").inputValue()) === "דלק"],
          ["filter הוצאה still selected", (await p.getByRole("button", { name: "הוצאה" }).getAttribute("aria-pressed")) === "true"],
        ] },
      { label: "documents hub", expect: at("/documents") },
    ],
  });

  /* F10 — same screen from two flows (CRM) --------------------------------- */
  if (crmSinglePane) {
    list.push({
      id: "F10a-customer-from-lead",
      title: "Customer card reached from a lead: leads → lead → customer, back ×2",
      entry: [
        step("Leads", (p) => p.goto(`${BASE}/leads`, { waitUntil: "networkidle" })),
        step("lead 3", async (p) => {
          await p.locator('a[href="/leads/3"]').first().click();
          await waitUrl(p, (u) => u === "/leads/3");
        }),
        step("customer chip", async (p) => {
          await p.getByRole("link", { name: /כרטיס הלקוח/ }).click();
          await waitUrl(p, (u) => u === "/customers/7");
        }),
      ],
      backs: [
        { label: "the lead it was opened from", expect: at("/leads/3") },
        { label: "leads list", expect: at("/leads") },
      ],
    });
    list.push({
      id: "F10b-customer-from-list",
      title: "Same customer card reached from the customer list (search), back ×1",
      entry: [
        step("Customers", (p) => p.goto(`${BASE}/customers`, { waitUntil: "networkidle" })),
        step("search 'לקוח 7'", async (p) => {
          await p.getByPlaceholder("חיפוש לפי שם או טלפון").fill("לקוח 7");
          await p.waitForTimeout(600);
          await settle(p);
        }),
        step("open", async (p) => {
          await p.locator('a[href="/customers/7"]').first().click();
          await waitUrl(p, (u) => u === "/customers/7");
        }),
      ],
      backs: [
        { label: "customer list, search kept", expect: at("/customers"),
          checks: async (p) => [["search still 'לקוח 7'", (await p.getByPlaceholder("חיפוש לפי שם או טלפון").inputValue()) === "לקוח 7"]] },
      ],
    });
  }

  /* F11 — Content creation flow (route steps, choices restored) ----------- */
  const contentEntry = [
    step("Tools", async (p) => {
      await p.goto(`${BASE}/tools`, { waitUntil: "networkidle" });
      await p.evaluate(() => localStorage.removeItem("content_flow"));
    }),
    step("Content", (p) => pushTo(p, "/content")),
    step("vibe + film → המשך", async (p) => {
      await p.locator(".vibe-tile").first().click();
      await p.locator(".film-pill").first().click();
      await p.getByRole("button", { name: "המשך" }).click();
      await waitUrl(p, (u) => u === "/content/goal");
    }),
    step("goal + platform → המשך", async (p) => {
      await p.locator(".goal-card").first().click();
      await p.locator(".platform-chip").first().click();
      await p.getByRole("button", { name: "המשך" }).click();
      await waitUrl(p, (u) => u === "/content/archetype");
    }),
    step("direction → המשך", async (p) => {
      await p.locator(".direction-card").first().click();
      await p.getByRole("button", { name: "המשך" }).click();
      await waitUrl(p, (u) => u === "/content/setup");
    }),
  ];
  const checked = (sel) => async (p) => [[`${sel} choice restored`, (await p.locator(`${sel}[aria-checked="true"]`).count()) === 1]];
  list.push({
    id: "F11-content",
    title: "Content creation: vibe → goal → direction → setup, back ×4",
    entry: contentEntry,
    backs: [
      { label: "direction step, choice kept", expect: at("/content/archetype"), checks: checked(".direction-card") },
      { label: "goal step, choice kept", expect: at("/content/goal"), checks: checked(".goal-card") },
      { label: "vibe step, choice kept", expect: at("/content"), checks: checked(".vibe-tile") },
      { label: "Tools", expect: at("/tools") },
    ],
  });
  list.push({
    id: "F11b-content-browser",
    title: "Content creation: same chain, browser Back",
    entry: contentEntry,
    via: "browser",
    backs: [
      { label: "direction step", expect: at("/content/archetype"), checks: checked(".direction-card") },
      { label: "goal step", expect: at("/content/goal"), checks: checked(".goal-card") },
      { label: "vibe step", expect: at("/content"), checks: checked(".vibe-tile") },
      { label: "Tools", expect: at("/tools") },
    ],
  });

  /* ============ completed actions: every commit counted ================= */

  const couponToTerms = [
    step("Tools", (p) => p.goto(`${BASE}/tools`, { waitUntil: "networkidle" })),
    step("My coupons", (p) => pushTo(p, "/revenue")),
    step("צור קופון חדש", async (p) => {
      await p.getByRole("button", { name: "צור קופון חדש" }).first().click();
      await waitUrl(p, (u) => u === "/revenue?view=create");
    }),
    step("goal → direction → builder → terms", async (p) => {
      await p.getByRole("button", { name: /להביא לקוחות חדשים/ }).click();
      await waitUrl(p, (u) => u.endsWith("cstep=direction"));
      await p.getByRole("button", { name: /^הנחה/ }).click();
      await waitUrl(p, (u) => u.endsWith("cstep=builder"));
      await p.getByRole("button", { name: "המשך" }).click();
      await waitUrl(p, (u) => u.endsWith("cstep=terms"));
    }),
    step("צור את הקופון (POST publish)", async (p) => {
      await p.getByRole("button", { name: "צור את הקופון" }).click();
      await waitUrl(p, (u) => u.endsWith("cstep=published"));
    }),
  ];
  for (const via of ["button", "browser"]) {
    list.push({
      id: `F12-coupon-published${via === "browser" ? "-browser" : ""}`,
      title: "Coupon published: back leaves the finished wizard (no second publish)",
      before: () => resetPosts(),
      via,
      entry: couponToTerms,
      backs: [
        { label: "my coupons — wizard steps consumed", expect: at("/revenue"),
          ...(via === "button" ? { press: (p) => p.getByRole("button", { name: "סגירה" }).click(), pressLabel: "close (X)" } : {}),
          checks: async () => [["exactly one publish POST", posts.couponPublish === 1, `POSTs=${posts.couponPublish}`]] },
        { label: "Tools", expect: at("/tools"),
          checks: async () => [["still one publish", posts.couponPublish === 1, `POSTs=${posts.couponPublish}`]] },
      ],
    });
  }

  list.push({
    id: "F13-pricing-saved",
    title: "Pricing: save costs to the item (completed), back ×2",
    before: () => resetPosts(),
    entry: [
      step("Tools", (p) => p.goto(`${BASE}/tools`, { waitUntil: "networkidle" })),
      step("Pricing", (p) => pushTo(p, "/pricing")),
      step("item תספורת", async (p) => {
        await p.getByRole("button", { name: /תספורת/ }).click();
        await waitUrl(p, (u) => u === "/pricing?step=calc");
        await p.locator("#calc-material").fill("77");
      }),
      step("חשב מחיר → result", async (p) => {
        await p.getByRole("button", { name: "חשב מחיר" }).click();
        await waitUrl(p, (u) => u === "/pricing?step=result");
      }),
      step("שמור עלויות לפריט (PATCH)", async (p) => {
        await p.getByRole("button", { name: "שמור עלויות לפריט" }).click();
        await waitUrl(p, (u) => u === "/pricing?step=saved");
      }),
    ],
    backs: [
      { label: "catalog — the saving step consumed", expect: at("/pricing"),
        checks: async () => [["exactly one save", posts.pricingSave === 1, `saves=${posts.pricingSave}`]] },
      { label: "Tools", expect: at("/tools"),
        checks: async () => [["still one save", posts.pricingSave === 1, `saves=${posts.pricingSave}`]] },
    ],
  });

  for (const via of ["button", "browser"]) {
    list.push({
      id: `F14-pricing-created${via === "browser" ? "-browser" : ""}`,
      title: "Pricing: new item created (completed), back ×2",
      before: () => resetPosts(),
      via,
      entry: [
        step("Tools", (p) => p.goto(`${BASE}/tools`, { waitUntil: "networkidle" })),
        step("Pricing", (p) => pushTo(p, "/pricing")),
        step("+ → name → step 2", async (p) => {
          await p.getByRole("button", { name: "הוספת פריט" }).first().click();
          await waitUrl(p, (u) => u === "/pricing?step=new1");
          await p.getByPlaceholder("לדוגמה: ייעוץ אסטרטגי").fill("ייעוץ");
          await p.getByRole("button", { name: "המשך לעלויות" }).click();
          await waitUrl(p, (u) => u === "/pricing?step=new2");
        }),
        step("צור פריט (POST)", async (p) => {
          await p.getByRole("button", { name: "צור פריט" }).click();
          await waitUrl(p, (u) => u === "/pricing?step=created");
        }),
      ],
      backs: [
        { label: "catalog — wizard steps consumed", expect: at("/pricing"),
          checks: async () => [["exactly one create", posts.pricingCreate === 1, `creates=${posts.pricingCreate}`]] },
        { label: "Tools", expect: at("/tools"),
          checks: async () => [["still one create", posts.pricingCreate === 1, `creates=${posts.pricingCreate}`]] },
      ],
    });
  }

  list.push({
    id: "F15-secretary-met",
    title: "Secretary: mark an item handled from its detail (completed), back ×2",
    before: () => resetPosts(),
    entry: [
      step("Secretary", (p) => p.goto(`${BASE}/secretary`, { waitUntil: "networkidle" })),
      step("all", (p) => pushTo(p, "/secretary?screen=all")),
      step("item", async (p) => {
        await p.getByRole("button", { name: /חברת החשמל/ }).first().click();
        if (vp.width >= 1200) await p.getByRole("link", { name: "הפעולה הבאה" }).click();
        await waitUrl(p, (u) => u === "/secretary?screen=detail&id=41");
      }),
      step("סמן שטופל (POST complete)", async (p) => {
        await p.getByRole("button", { name: "סמן שטופל" }).click();
        await waitUrl(p, (u) => u.startsWith("/secretary?screen=loops&id=41"));
      }),
    ],
    backs: [
      { label: "all obligations — the item's screen consumed", expect: at("/secretary?screen=all"),
        checks: async () => [["exactly one complete", posts.obligationComplete === 1, `completes=${posts.obligationComplete}`]] },
      { label: "secretary home", expect: at("/secretary"),
        checks: async () => [["still one complete", posts.obligationComplete === 1, `completes=${posts.obligationComplete}`]] },
    ],
  });

  /* ============ supplier order wizard with products in the cart ========= */
  const draftQty = async (p) =>
    p.evaluate(() => {
      try {
        return JSON.parse(localStorage.getItem("inventory:supplierPurchases:newDraft:v1") ?? "{}")?.order?.["1"] ?? null;
      } catch {
        return null;
      }
    });
  const wizardToConfirm = [
    step("Tools", async (p) => {
      await p.goto(`${BASE}/tools`, { waitUntil: "networkidle" });
      await p.evaluate(() => localStorage.removeItem("inventory:supplierPurchases:newDraft:v1"));
    }),
    step("Inventory", (p) => pushTo(p, "/inventory")),
    step("order wizard", (p) => pushTo(p, "/inventory/supplier-purchases/new")),
    step("add קפה ×2 → cart", async (p) => {
      const add = p.getByRole("button", { name: /^הוסף( קפה)?$/ });
      await clickVisible(p, add);
      await p.waitForTimeout(200);
      await clickVisible(p, p.getByRole("button", { name: /המשך לעגלה/ }));
      await waitUrl(p, (u) => u === "/inventory/supplier-purchases/new/cart");
    }),
    step("+1 in cart → confirm", async (p) => {
      // Cart increment: "הוסף" (phone/tablet) / "הוספה" (desktop).
      await clickVisible(p, p.getByRole("button", { name: /^(הוסף|הוספה)$/ }));
      await p.waitForTimeout(300);
      await clickVisible(p, p.getByRole("button", { name: "המשך לאישור" }));
      await waitUrl(p, (u) => u === "/inventory/supplier-purchases/new/confirm");
    }),
  ];
  list.push({
    id: "F16-order-wizard",
    title: "Supplier order wizard: products → cart → confirm, back ×3 (cart kept)",
    entry: wizardToConfirm,
    backs: [
      { label: "cart, quantities kept", expect: at("/inventory/supplier-purchases/new/cart"),
        checks: async (p) => { const q = await draftQty(p); return [["קפה quantity kept in the draft (added, then +1 in cart)", Number(q) >= 2, `qty=${q}`]]; } },
      { label: "products step, cart kept", expect: at("/inventory/supplier-purchases/new"),
        checks: async (p) => { const q = await draftQty(p); return [["קפה still in the draft", Number(q) >= 1, `qty=${q}`]]; } },
      { label: "inventory (where the wizard was opened)", expect: at("/inventory") },
    ],
  });
  list.push({
    id: "F16b-order-created",
    title: "Supplier order created (completed): back leaves the wizard (no second order)",
    before: () => resetPosts(),
    entry: [
      ...wizardToConfirm,
      step("צור הזמנה (POST create)", async (p) => {
        await clickVisible(p, p.getByRole("button", { name: "צור הזמנה" }));
        // The confirm modal: "אישור ושליחה" commits the order.
        await clickVisible(p, p.getByRole("button", { name: "אישור ושליחה" }));
        await waitUrl(p, (u) => u === "/inventory/supplier-purchases/77/send");
      }),
    ],
    backs: [
      { label: "inventory — products/cart steps consumed", expect: at("/inventory"),
        checks: async () => [["exactly one order created", posts.orderCreate === 1, `orders=${posts.orderCreate}`]] },
    ],
  });

  /* ============ content: back from the result, no new render ============= */
  const seedContent = async (p) =>
    p.evaluate(() => {
      localStorage.setItem("content_flow", JSON.stringify({ mode: "ai", goal: "trust", contentAngle: "story", selectedDirection: "d1", selectedFormat: "reel", selectedPlatform: "instagram", vibe: "warm_personal", canFilm: false }));
      localStorage.setItem("content_result", JSON.stringify({ selectedVariant: { script: { scriptText: "טקסט", caption: "כיתוב", shots: [] } } }));
      localStorage.setItem("content_ai_assets", JSON.stringify({ "1": "https://cdn.example.test/a.png" }));
      localStorage.removeItem("content_render_output");
      localStorage.removeItem("content_render_job");
    });
  for (const via of ["button", "browser"]) {
    list.push({
      id: `F17-content-result${via === "browser" ? "-browser" : ""}`,
      title: "Content: step → render → result, back ×2 (no second render)",
      before: () => resetPosts(),
      via,
      entry: [
        step("Tools + flow data", async (p) => {
          await p.goto(`${BASE}/tools`, { waitUntil: "networkidle" });
          await seedContent(p);
        }),
        step("content step", (p) => pushTo(p, "/content")),
        step("render (POST, quota)", async (p) => {
          await pushTo(p, "/content/render");
          await p.getByRole("button", { name: "לראות את הסרטון" }).waitFor({ timeout: 15000 });
        }),
        step("לראות את הסרטון → result", async (p) => {
          await p.getByRole("button", { name: "לראות את הסרטון" }).click();
          await waitUrl(p, (u) => u === "/content/result");
        }),
      ],
      backs: [
        { label: "the step before the render (render never re-entered)", expect: at("/content"),
          checks: async () => [["exactly one render POST", posts.contentRender === 1, `renders=${posts.contentRender}`]] },
        { label: "Tools", expect: at("/tools"),
          checks: async () => [["still one render", posts.contentRender === 1, `renders=${posts.contentRender}`]] },
      ],
    });
  }

  /* ============ inbox on mobile: triage → list → conversation ============ */
  if (vp.width <= 768) {
    for (const via of ["button", "browser"]) {
      list.push({
        id: `F18-inbox-mobile${via === "browser" ? "-browser" : ""}`,
        title: "Inbox (mobile): triage → category list → conversation, back ×2",
        via,
        entry: [
          step("Notifications", (p) => p.goto(`${BASE}/notifications`, { waitUntil: "networkidle" })),
          step("Inbox", (p) => pushTo(p, "/inbox")),
          step("פתוחות", async (p) => {
            await p.getByRole("button", { name: /^פתוחות/ }).click();
            await waitUrl(p, (u) => u === "/inbox?list=conversation_list");
          }),
          step("conversation", async (p) => {
            await p.locator("button:visible", { hasText: "לקוח חדש" }).first().click();
            await waitUrl(p, (u) => u.includes("conversationId="));
          }),
        ],
        backs: [
          { label: "the category's conversation list", expect: at("/inbox?list=conversation_list"),
            checks: async (p) => [["list shown", await p.getByRole("button", { name: "חזרה לקטגוריות" }).isVisible()]] },
          { label: "triage (inbox root)", expect: at("/inbox"),
            checks: async (p) => [["triage shown", await p.getByRole("button", { name: /^פתוחות/ }).isVisible()]] },
        ],
      });
    }
  }

  /* ============ billing: every unsaved-changes dialog answer ============= */
  const billingDirty = [
    step("Billing", (p) => p.goto(`${BASE}/billing`, { waitUntil: "networkidle" })),
    step("draft document", (p) => pushTo(p, "/billing/12")),
    step("edit a line (unsaved)", async (p) => {
      const inp = p.locator('input[placeholder="תיאור פריט"]');
      await inp.first().waitFor({ state: "attached" });
      if (!(await inp.filter({ visible: true }).count())) {
        // Open the collapsed editing section, as a user does.
        for (const name of [/פריטים נוספים/, /עריכה נוספת/]) {
          const sum = p.locator("summary", { hasText: name });
          if (await sum.count()) await sum.first().click();
          if (await inp.filter({ visible: true }).count()) break;
        }
      }
      await inp.filter({ visible: true }).first().fill("שירות מעודכן");
    }),
  ];
  const dialogBtn = (name) => async (p) => {
    await p.getByRole("button", { name }).click();
  };
  list.push({
    id: "F19a-billing-keep-then-leave",
    title: "Billing draft with unsaved line: back → keep editing, back → leave without saving",
    before: () => resetPosts(),
    entry: billingDirty,
    backs: [
      { label: "stays on the document (keep editing), edit intact", expect: at("/billing/12"), stays: true, afterPress: dialogBtn("המשך עריכה"),
        checks: async (p) => [
          ["edit still there", (await p.locator('input[placeholder="תיאור פריט"]').first().inputValue()) === "שירות מעודכן"],
          ["nothing saved", posts.billingLinesSave === 0, `saves=${posts.billingLinesSave}`],
        ] },
      { label: "billing list (left without saving)", expect: at("/billing"), afterPress: dialogBtn("צא בלי לשמור"),
        checks: async () => [["nothing saved", posts.billingLinesSave === 0, `saves=${posts.billingLinesSave}`]] },
    ],
  });
  list.push({
    id: "F19b-billing-save-and-continue",
    title: "Billing draft with unsaved line: back → save and continue",
    before: () => resetPosts(),
    entry: billingDirty,
    backs: [
      { label: "billing list, after saving once", expect: at("/billing"), afterPress: dialogBtn("שמור והמשך"),
        checks: async () => [["exactly one save", posts.billingLinesSave === 1, `saves=${posts.billingLinesSave}`]] },
    ],
  });

  /* ============ #hash and history entries not made by the mechanism ===== */
  for (const via of ["button", "browser"]) {
    list.push({
      id: `F20-hash${via === "browser" ? "-browser" : ""}`,
      title: "#fragment jump on a detail screen keeps the chain",
      via,
      entry: [
        step("Tools", (p) => p.goto(`${BASE}/tools`, { waitUntil: "networkidle" })),
        step("detail", (p) => pushTo(p, "/payables/match/41")),
        step("#lines (fragment entry)", async (p) => {
          await p.evaluate(() => {
            location.hash = "lines";
          });
          await p.waitForTimeout(400);
        }),
      ],
      backs:
        via === "button"
          ? [{ label: "Tools — the real origin (fragment entry is the same screen)", expect: at("/tools") }]
          : [
              { label: "the detail without the fragment", expect: at("/payables/match/41") },
              { label: "Tools", expect: at("/tools") },
            ],
    });
  }
  list.push({
    id: "F21a-external-then-direct",
    title: "Entry from outside the app (prior non-app history), back stays in the app",
    entry: [
      step("outside page", (p) => p.goto("about:blank")),
      step("direct link", (p) => p.goto(`${BASE}/payables/match/41`, { waitUntil: "networkidle" })),
    ],
    backs: [
      { label: "labelled fallback /payables (never history.back out of the app)", expect: at("/payables"),
        checks: async (p) => [["still inside the app", new URL(p.url()).origin === new URL(BASE).origin]] },
    ],
  });
  list.push({
    id: "F21b-full-reload-navigation",
    title: "Entry created by a full-document navigation (location.assign): no fabricated origin",
    entry: [
      step("Tools", (p) => p.goto(`${BASE}/tools`, { waitUntil: "networkidle" })),
      step("location.assign → detail", async (p) => {
        await p.evaluate(() => location.assign("/payables/match/42"));
        await p.waitForURL("**/payables/match/42");
        await settle(p);
      }),
    ],
    backs: [{ label: "labelled fallback /payables", expect: at("/payables") }],
  });
  list.push({
    id: "F21c-lost-session-trail",
    title: "Trail storage lost (cleared), then refresh: no fabricated origin",
    entry: [
      step("Tools", (p) => p.goto(`${BASE}/tools`, { waitUntil: "networkidle" })),
      step("detail", (p) => pushTo(p, "/payables/match/41")),
      step("sessionStorage cleared + reload", async (p) => {
        await p.evaluate(() => sessionStorage.clear());
        await p.reload({ waitUntil: "networkidle" });
      }),
    ],
    backs: [{ label: "labelled fallback /payables", expect: at("/payables") }],
  });

  /* ============ suppliers list: back only with a verified origin ========= */
  if (vp.width < 1280) {
    list.push({
      id: "F22-suppliers-list",
      title: "Suppliers list (phone/tablet) opened from Tools: back to Tools",
      entry: [
        step("Tools", (p) => p.goto(`${BASE}/tools`, { waitUntil: "networkidle" })),
        step("Suppliers", (p) => pushTo(p, "/suppliers")),
      ],
      backs: [{ label: "Tools", expect: at("/tools") }],
    });
  }

  return list.filter((c) => !ONLY || ONLY.has(c.id));
}

/* ================================================================== run == */

const browser = await ENGINE.launch();
try {
  for (const vp of VIEWPORTS) {
    console.log(`\n=== ${vp.name} ${vp.width}x${vp.height} ===`);
    for (const c of chains(vp)) {
      // Fresh context per chain: own tab, own history, own sessionStorage.
      const context = await browser.newContext({ locale: "he-IL", viewport: { width: vp.width, height: vp.height } });
      await wire(context);
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));
      c.before?.();
      // Dialog answers per back step (the coupon discard prompt).
      let pendingDialog = null;
      page.on("dialog", (d) => (pendingDialog === "accept" ? d.accept() : d.dismiss()).catch(() => {}));
      try {
        await runChain(page, {
          id: c.id,
          title: c.title,
          viewport: vp.name,
          via: c.via ?? "button",
          entry: c.entry,
          backs: c.backs,
          beforeEachBack: (i) => {
            pendingDialog = c.backs[i]?.dialog ?? null;
          },
        });
      } catch (e) {
        check(`${c.id} [${vp.name}] chain ran to completion`, false, String(e?.message ?? e).split(/\r?\n/)[0]);
      }
      check(`${c.id} [${vp.name}] no page errors`, errors.length === 0, errors.slice(0, 2).join(" | "));
      await context.close();
    }
  }
} finally {
  await browser.close();
  writeEvidence();
}
const { pass, failures } = summary();
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("FAILED:\n - " + failures.join("\n - "));
  process.exit(1);
}
