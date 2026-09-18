/**
 * HOME 2B — real-data runtime proof against the isolated Preview environment.
 *
 * This is the counterpart to `home-2b-states.mjs`, and the two must never be
 * confused: that one STUBS all six endpoints to drive populated and failure
 * states; this one stubs NOTHING. Every figure it checks comes from the real
 * application stack answering for a real tenant.
 *
 * READ ONLY by construction: it issues no POST/PATCH/DELETE of its own, seeds
 * nothing, and has no database access — it holds no DATABASE_URL and opens no
 * SQL connection. It reads the DOM and the actual network responses, and the
 * only requests made are the ones the product itself issues.
 *
 * Authentication comes from a persistent browser profile the operator logged
 * into by hand (Vercel SSO + the Dubiz login). No credential is read, stored or
 * sent by this file, and no Vercel automation-bypass header is used.
 *
 *   AUDIT_BASE_URL=<preview alias> AUDIT_PROFILE_DIR=<profile> \
 *     node scripts/qa/ui/home-2b-realdata.mjs
 *
 * Every assertion is a PROOF CHAIN: the value rendered in the UI, the endpoint
 * it must come from, the field in that endpoint's real response, the derivation
 * the product applies, and whether they match. A figure whose chain cannot be
 * completed is a FAIL — never a pass by absence.
 */
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * AUDIT_BASE_URL is REQUIRED and deliberately has no default: a preview alias
 * is per-branch and per-deployment, so a hardcoded one would silently point a
 * future run at the wrong build — or at an environment nobody intended.
 */
const BASE = process.env.AUDIT_BASE_URL;
if (!BASE) {
  console.error(
    [
      "ABORT: AUDIT_BASE_URL is required.",
      "",
      "  Point it at the Preview deployment of the branch under test, e.g. the",
      "  stable alias shown by:  vercel inspect <deployment-url>",
      "",
      "  AUDIT_BASE_URL=https://<preview-alias> \\",
      "    AUDIT_PROFILE_DIR=<profile> node scripts/qa/ui/home-2b-realdata.mjs",
      "",
      "  Never point this at production: this harness proves a branch build.",
    ].join("\n")
  );
  process.exit(2);
}

/**
 * A persistent browser profile the OPERATOR authenticated by hand (Vercel SSO
 * + the Dubiz login). The default lives under `.home-2b/`, which is gitignored,
 * so no profile, cookie or token is ever committed.
 */
const PROFILE =
  process.env.AUDIT_PROFILE_DIR || path.join(process.cwd(), ".home-2b", "pw-profile");
const OUT = process.env.AUDIT_OUT_DIR || path.join(process.cwd(), ".home-2b");
const WIDTH = Number(process.env.AUDIT_WIDTH || 390);

/**
 * The expected QA identity. Identifiers only — the tenant this proof is valid
 * for. No credential is recorded here, and none is needed: the session comes
 * from the profile. Override per environment if the approved persona differs.
 */
const EXPECT_USER = Number(process.env.AUDIT_EXPECT_USER || 92);
const EXPECT_BUSINESS = Number(process.env.AUDIT_EXPECT_BUSINESS || 91);

const results = [];
function check(name, cond, detail = "") {
  results.push({ name, pass: Boolean(cond), detail: String(detail) });
  console.log(`${cond ? "OK  " : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

/** One line of the evidence table: UI → ENDPOINT → RESPONSE → DERIVATION → MATCH. */
const chains = [];
function chain(ui, endpoint, response, derivation, match) {
  chains.push({ ui: String(ui), endpoint, response: String(response), derivation, match });
  console.log(
    `  CHAIN ${match ? "MATCH " : "DIFFER"} | UI=${ui} | ${endpoint} | RESPONSE=${response} | ${derivation}`
  );
}

/* ------------------------------------------------- product derivations -- */
/* Mirrors features/home/lib/home-model.ts exactly. If these drift from the
 * product the proof is worthless, so they are written against the same rules
 * rather than re-derived loosely. */

function startOfLocalDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
function dueBadgeFor(iso, now) {
  const due = new Date(iso);
  if (Number.isNaN(due.getTime())) return null;
  const today = startOfLocalDay(now);
  const dueDay = startOfLocalDay(due);
  const day = 24 * 60 * 60 * 1000;
  if (dueDay < today) return "late";
  if (dueDay === today) return "today";
  if (dueDay === today + day) return "tomorrow";
  return null;
}
const URGENT = ["CRITICAL", "HIGH"];
function groupStatusLabel(items, domains) {
  const mine = items.filter((i) => domains.includes(i.domain));
  if (mine.length === 0) return "הכול מטופל";
  if (mine.some((i) => URGENT.includes(i.severity))) return "דורש טיפול עכשיו";
  return "יש מה לבדוק";
}
const GROUPS = [
  { key: "money", label: "כסף ומסמכים", anchor: "group-money", domains: ["billing", "documents"] },
  { key: "customers", label: "לקוחות ושיחות", anchor: "group-customers", domains: ["inbox", "leads"] },
  { key: "operations", label: "מלאי וספקים", anchor: "group-operations", domains: ["inventory", "supplier"] },
];
const ALL_DOMAINS = ["inbox", "documents", "inventory", "billing", "supplier", "leads"];

/** The verdict copy, as the product composes it. */
function expectedVerdict(b) {
  const { breakToday, attention, watching } = b.counts;
  if (b.state === "CRITICAL") {
    return {
      badge: "דחוף",
      cta: "לטפל עכשיו",
      sentence:
        breakToday === 1
          ? "יש התחייבות אחת שנשברת היום."
          : `יש ${breakToday} התחייבויות שנשברות היום.`,
    };
  }
  if (b.state === "BUSY") {
    return {
      badge: "עמוס",
      cta: "בוא נתחיל",
      sentence:
        attention === 1
          ? "דבר אחד מבקש אותך היום, ואף אחד לא נשבר."
          : `${attention} דברים מבקשים אותך היום, ואף אחד לא נשבר.`,
    };
  }
  if (b.state === "STILL_SETTLING_IN") {
    return {
      badge: "עדיין מתמקמים",
      cta: "מה בהשגחה",
      sentence:
        watching === 0
          ? "אני עוד לומדת את העסק. עדיין מוקדם לי להגיד לך שהכול בשליטה."
          : watching === 1
            ? "אני עוד לומדת את העסק. התחייבות אחת בהשגחה שלי."
            : `אני עוד לומדת את העסק. ${watching} התחייבויות בהשגחה שלי.`,
    };
  }
  return {
    badge: "רגוע",
    cta: "מה בהשגחה",
    sentence:
      watching === 0
        ? "אתה מכוסה. אין היום משהו שנשבר."
        : watching === 1
          ? "אתה מכוסה. התחייבות אחת בהשגחה שלי, והיא לא נשברת היום."
          : `אתה מכוסה. ${watching} התחייבויות בהשגחה שלי, אף אחת לא נשברת היום.`,
  };
}

/* ------------------------------------------------------------- capture -- */

/** Records the real response body of every endpoint Home actually calls. */
function attachRecorder(page, seen) {
  page.on("response", async (res) => {
    const u = new URL(res.url());
    if (!u.pathname.startsWith("/api/")) return;
    const key = u.pathname + (u.pathname.includes("documents/inbox") ? u.search : "");
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON — status still recorded */
    }
    seen[key] = { status: res.status(), body };
  });
}

/** The six requests Home issues. The documents one carries a query string. */
function sixSeen(seen) {
  const need = [
    "/api/home",
    "/api/notifications/unread-count",
    "/api/obligations/briefing",
    "/api/business-status",
    "/api/payments/collection-workspace",
  ];
  const haveDocs = Object.keys(seen).some((k) => k.startsWith("/api/documents/inbox"));
  return need.every((p) => seen[p]) && haveDocs;
}

async function waitForSixEndpoints(seen, timeoutMs) {
  const started = Date.now();
  while (!sixSeen(seen) && Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 250));
  }
  const ms = Date.now() - started;
  console.log(`  (all six endpoints settled in ${ms}ms${sixSeen(seen) ? "" : " — TIMED OUT"})\n`);
}

function readHome(page) {
  return page.evaluate(() => {
    const txt = (el) => (el ? el.textContent.trim() : null);
    return {
      greeting: txt(document.querySelector(".dzhome .ghi")),
      verdictBadge: txt(document.querySelector(".dzhome .sbadge")),
      verdictSentence: txt(document.querySelector(".dzhome .smsg")),
      cta: txt(document.querySelector(".dzhome .dzcta")),
      secretaryHref: document.querySelector(".dzhome .seccard-link")?.getAttribute("href") ?? null,
      failedCard: !!document.querySelector(".dzhome .sec-failed"),
      counters: [...document.querySelectorAll(".dzhome .ntile")].map((el) => ({
        value: txt(el.querySelector(".nval")),
        label: txt(el.querySelector(".nlab")),
        note: txt(el.querySelector(".nnote")),
        href: el.getAttribute("href"),
      })),
      groups: [...document.querySelectorAll(".dzhome .ftile")].map((el) => ({
        label: txt(el.querySelector(".flab")),
        status: txt(el.querySelector(".fstat")),
        href: el.getAttribute("href"),
      })),
      todayRows: [...document.querySelectorAll(".dzhome .trow")].map((el) => ({
        badge: txt(el.querySelector(".tbadge")),
        name: txt(el.querySelector(".tname")),
        amount: txt(el.querySelector(".tamt")),
        href: el.getAttribute("href"),
      })),
      todayEmpty: txt(document.querySelector(".dzhome .tempty")),
      links: [...document.querySelectorAll(".dzhome a[href]")].map((el, i) => {
        el.setAttribute("data-qa-idx", String(i));
        return {
          idx: i,
          href: el.getAttribute("href"),
          label: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 30),
        };
      }),
    };
  });
}

/* ---------------------------------------------------------------- main -- */

async function main() {
  await mkdir(path.join(OUT, "shots"), { recursive: true });
  console.log(`BASE    : ${BASE}`);
  console.log(`PROFILE : ${PROFILE}`);
  console.log(`WIDTH   : ${WIDTH}\n`);

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: true,
    viewport: { width: WIDTH, height: 900 },
    locale: "he-IL",
    reducedMotion: "reduce",
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const seen = {};
  attachRecorder(page, seen);

  const now = new Date();
  await page.goto(`${BASE}/app`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".dzhome .seccard", { state: "visible", timeout: 60000 });

  // Wait on the CONDITION, not on a guessed duration. Home's four secondary
  // sources settle independently and a cold serverless function can take
  // several seconds; a fixed sleep turns that latency into a phantom failure.
  await waitForSixEndpoints(seen, 60000);
  await page.waitForTimeout(500);

  /* -- identity, re-proven inside this run ------------------------------ */
  const me = await page.evaluate(async () => {
    const t = localStorage.getItem("token");
    const r = await fetch("/api/auth/me", { headers: { authorization: `Bearer ${t}` }, cache: "no-store" });
    return { status: r.status, body: await r.json().catch(() => null) };
  });
  const meUser = me.body?.user ?? me.body ?? {};
  check(
    `identity is the approved Preview persona`,
    me.status === 200 && meUser.id === EXPECT_USER && meUser.businessId === EXPECT_BUSINESS,
    `status=${me.status} user=${meUser.id} business=${meUser.businessId}`
  );

  /* -- all six endpoints answered --------------------------------------- */
  const SIX = [
    "/api/home",
    "/api/notifications/unread-count",
    "/api/obligations/briefing",
    "/api/business-status",
    "/api/payments/collection-workspace",
  ];
  for (const p of SIX) {
    check(`endpoint responded 200: ${p}`, seen[p]?.status === 200, `status=${seen[p]?.status ?? "not called"}`);
  }
  const docsKey = Object.keys(seen).find((k) => k.startsWith("/api/documents/inbox"));
  check(
    `endpoint responded 200: /api/documents/inbox?summaryOnly=1`,
    docsKey && seen[docsKey].status === 200,
    `status=${docsKey ? seen[docsKey].status : "not called"}`
  );

  const briefing = seen["/api/obligations/briefing"]?.body;
  const status = seen["/api/business-status"]?.body;
  const collection = seen["/api/payments/collection-workspace"]?.body;
  const docs = docsKey ? seen[docsKey].body : null;

  const ui = await readHome(page);
  await page.screenshot({ path: path.join(OUT, "shots", `realdata-home-${WIDTH}.png`), fullPage: true });

  /* -- A. ASSISTANT ------------------------------------------------------ */
  check("assistant card did not fall back to its failure state", !ui.failedCard);
  if (briefing) {
    const want = expectedVerdict(briefing);
    chain(ui.verdictBadge, "GET /api/obligations/briefing", `state=${briefing.state}`, "state → badge", ui.verdictBadge === want.badge);
    check("assistant badge matches the real verdict", ui.verdictBadge === want.badge, `want ${want.badge}, got ${ui.verdictBadge}`);

    chain(
      ui.verdictSentence,
      "GET /api/obligations/briefing",
      `counts=${JSON.stringify(briefing.counts)}`,
      "state + counts → sentence",
      ui.verdictSentence === want.sentence
    );
    check("assistant wording matches the real counts", ui.verdictSentence === want.sentence, `want "${want.sentence}", got "${ui.verdictSentence}"`);
    check("assistant CTA matches the state", ui.cta === want.cta, `want ${want.cta}, got ${ui.cta}`);
    check("assistant destination is /attention", ui.secretaryHref === "/attention", String(ui.secretaryHref));
    check(
      "attention state is honest for an oriented/unoriented tenant",
      !(briefing.state === "CALM" && briefing.oriented === false),
      `state=${briefing.state} oriented=${briefing.oriented}`
    );
  } else {
    check("briefing body captured", false, "no response body");
  }

  /* -- B. TODAY METRICS -------------------------------------------------- */
  const byLabel = (l) => ui.counters.find((c) => c.label === l);
  if (collection) {
    const c1 = byLabel("נגבה ואומת");
    const want1 = String(collection.summary.collectedThisMonth.count);
    chain(c1?.value, "GET /api/payments/collection-workspace", `summary.collectedThisMonth.count=${want1}`, "direct count (NOT history)", c1?.value === want1);
    check("counter «נגבה ואומת» = summary.collectedThisMonth.count", c1?.value === want1, `want ${want1}, got ${c1?.value}`);
    check("counter «נגבה ואומת» names its window", c1?.note === "בחודש הנוכחי", String(c1?.note));

    const c2 = byLabel("ממתינים לגבייה");
    const want2 = String(collection.summary.pending.count);
    chain(c2?.value, "GET /api/payments/collection-workspace", `summary.pending.count=${want2}`, "direct count", c2?.value === want2);
    check("counter «ממתינים לגבייה» = summary.pending.count", c2?.value === want2, `want ${want2}, got ${c2?.value}`);
  }
  if (docs) {
    const c3 = byLabel("מסמכים לבדיקה");
    const want3 = String(docs.financialPulse?.inboxDocumentCounts?.totalPendingReview);
    chain(c3?.value, "GET /api/documents/inbox?summaryOnly=1", `inboxDocumentCounts.totalPendingReview=${want3}`, "direct count", c3?.value === want3);
    check("counter «מסמכים לבדיקה» = totalPendingReview", c3?.value === want3, `want ${want3}, got ${c3?.value}`);
  }
  if (briefing) {
    const c4 = byLabel("תשלומים למועד");
    const want4 = String(briefing.attention.filter((i) => ["late", "today"].includes(dueBadgeFor(i.obligation.dueAt, now))).length);
    chain(c4?.value, "GET /api/obligations/briefing", `attention[]=${briefing.attention.length}`, "count of dueAt ≤ today", c4?.value === want4);
    check("counter «תשלומים למועד» = obligations at/past due", c4?.value === want4, `want ${want4}, got ${c4?.value}`);
  }

  /* -- C. FEATURE GROUPS ------------------------------------------------- */
  if (status) {
    const items = status.items ?? [];
    check("business-status returned an items array", Array.isArray(items), `n=${items.length}`);
    const covered = new Set(GROUPS.flatMap((g) => g.domains));
    for (const d of ALL_DOMAINS) check(`domain is represented by a group: ${d}`, covered.has(d));
    for (const g of GROUPS) {
      const tile = ui.groups.find((t) => t.label === g.label);
      const want = groupStatusLabel(items, g.domains);
      const mine = items.filter((i) => g.domains.includes(i.domain));
      chain(
        `${g.label} → ${tile?.status}`,
        "GET /api/business-status",
        `items in [${g.domains}]=${mine.length}`,
        "severity → label (never a count)",
        tile?.status === want
      );
      check(`group «${g.label}» label matches real status`, tile?.status === want, `want ${want}, got ${tile?.status}`);
      check(`group «${g.label}» points at its anchor`, tile?.href === `/tools#${g.anchor}`, String(tile?.href));
      check(`group «${g.label}» label carries no number`, tile?.status ? !/\d/.test(tile.status) : false, String(tile?.status));
    }
  }

  /* -- D. היום שלך ------------------------------------------------------- */
  if (briefing) {
    const expected = briefing.attention
      .map((i) => ({ id: i.obligation.id, badge: dueBadgeFor(i.obligation.dueAt, now), dueAt: i.obligation.dueAt }))
      .filter((r) => r.badge)
      .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
    const LABEL = { late: "באיחור", today: "היום", tomorrow: "מחר" };

    chain(
      `${ui.todayRows.length} rows`,
      "GET /api/obligations/briefing",
      `attention[] with dueAt ≤ tomorrow = ${expected.length}`,
      "late|today|tomorrow only, soonest first",
      ui.todayRows.length === expected.length
    );
    check("«היום שלך» row count matches real obligations", ui.todayRows.length === expected.length, `want ${expected.length}, got ${ui.todayRows.length}`);

    expected.forEach((e, i) => {
      const row = ui.todayRows[i];
      check(`row ${i + 1} badge is ${LABEL[e.badge]}`, row?.badge === LABEL[e.badge], `want ${LABEL[e.badge]}, got ${row?.badge}`);
      check(`row ${i + 1} opens obligation ${e.id}`, row?.href === `/secretary?screen=detail&id=${e.id}`, String(row?.href));
    });

    if (expected.length === 0) {
      check(
        "empty «היום שלך» states the honest empty line, not a failure line",
        ui.todayEmpty === "אין היום מועדים פתוחים. אני ממשיכה להשגיח.",
        String(ui.todayEmpty)
      );
    }
  }

  /* -- F. TRUTHFULNESS --------------------------------------------------- */
  // No failure is injected. This only asserts that a NATURALLY empty or zero
  // response is never rendered as something stronger than it is.
  const zeroCounters = ui.counters.filter((c) => c.value === "0");
  check(
    "a real zero renders as 0 and stays a link (never blank, never hidden)",
    zeroCounters.every((c) => c.href && c.href.startsWith("/")),
    `${zeroCounters.length} zero counters, all linked`
  );
  check(
    "no counter rendered the not-loaded placeholder while its endpoint returned 200",
    !ui.counters.some((c) => c.value === "לא נטען"),
    ui.counters.map((c) => `${c.label}=${c.value}`).join(" | ")
  );

  /* -- E. CLICK PROOF ---------------------------------------------------- */
  for (const t of ui.links) {
    const sel = `.dzhome a[data-qa-idx="${t.idx}"]`;
    await page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: "center" }), sel);
    await page.waitForTimeout(80);

    const hit = await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return { ok: false, why: "missing" };
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return { ok: false, why: "zero-size" };
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      if (!top) return { ok: false, why: "nothing-at-point" };
      const ours = el.contains(top) || top.contains(el);
      return { ok: ours, why: ours ? "" : `covered by ${top.tagName}` };
    }, sel);
    check(`hit-test: ${t.label} (${t.href})`, hit.ok, hit.why);
    if (!hit.ok) continue;

    await page.click(sel);
    await page.waitForTimeout(700);
    const got = new URL(page.url());
    const landed = got.pathname + got.search + got.hash;
    check(`click lands on ${t.href}`, landed === t.href, `landed on ${landed}`);

    await page.goto(`${BASE}/app`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".dzhome .seccard", { state: "visible", timeout: 60000 });
    await page.waitForTimeout(1200);
    await page.evaluate(() =>
      [...document.querySelectorAll(".dzhome a[href]")].forEach((el, i) => el.setAttribute("data-qa-idx", String(i)))
    );
  }

  await writeFile(
    path.join(OUT, "home-2b-realdata-evidence.json"),
    JSON.stringify(
      {
        base: BASE,
        width: WIDTH,
        identity: { user: meUser.id, business: meUser.businessId, businessName: meUser.business?.name },
        endpointStatuses: Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, v.status])),
        responses: { briefing, status, collection, docs },
        ui,
        chains,
        results,
      },
      null,
      2
    ),
    "utf8"
  );

  await ctx.close();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.error("HOME 2B real-data proof — FAILED");
    process.exit(1);
  }
  console.log("HOME 2B real-data proof — PASSED");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
