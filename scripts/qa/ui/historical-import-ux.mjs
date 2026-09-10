/**
 * I-8B.6 — היסטוריה ממערכת קודמת: layout / RTL / state evidence harness.
 *
 * READ-ONLY against the app: it navigates GET routes and drives the screen, and
 * every historical endpoint is INTERCEPTED and answered with synthetic
 * responses. Nothing reaches a database, nothing is imported, and no owner data
 * exists anywhere in this file.
 *
 * # Why interception rather than a real import
 *
 * The states that most need looking at are the ones a healthy database will not
 * produce on demand: an ambiguous date, a strong duplicate candidate, a blocked
 * reversal, an expired preview, stale evidence. Fixturing the responses is the
 * only way to SEE all of them, and the shapes are taken from the engine's own
 * types — a fixture that drifted from the contract would render wrongly here in
 * exactly the way it would in production.
 *
 * What this harness therefore proves: rendering, wording, RTL, overflow, touch
 * targets and state coverage. What it does NOT prove: the engine's behaviour —
 * that is `.i8b6/battery.mjs` and the verifiers.
 *
 *   npx next dev -p 3111            # in another shell
 *   node scripts/qa/ui/historical-import-ux.mjs
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import path from "node:path";

const BASE = process.env.QA_BASE_URL || "http://localhost:3111";
const OUT = process.env.QA_OUT_DIR || path.join(process.cwd(), ".tmp-i8b6");
const HUB = "/settings/import-export";
const IMPORT_ROUTE = "/settings/import-export/historical";
const RECORDS_ROUTE = "/settings/import-export/historical/records";

mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  ["m360-mobile-small", 360, 740],
  ["m390-mobile", 390, 844],
  ["t768-tablet", 768, 1024],
  ["t1024-tablet-wide", 1024, 768],
  ["d1440-desktop", 1440, 900],
];

const results = [];
const consoleErrors = [];

function check(name, condition, detail = "") {
  const pass = Boolean(condition);
  results.push({ name, pass, detail });
  console.log(`${pass ? "OK  " : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

/* ------------------------------------------------------------ fixtures -- */

const H = {
  type: "סוג מסמך",
  number: "מספר מסמך מקורי",
  date: "תאריך המסמך",
  total: "סכום כולל",
  subtotal: "סכום לפני מע״מ",
  vat: "מע״מ",
  currency: "מטבע",
  customer: "שם לקוח",
  taxId: "מספר עוסק / ח.פ. לקוח",
  source: "מערכת מקור",
  reverses: "מספר מסמך שמזוכה",
};

const HEADERS = Object.values(H);

const value = (field, original, normalized = original) => ({
  field,
  original,
  normalized,
});

const NO_DUPLICATE = {
  database: { state: "NONE", matchCount: 0, comparison: null, differingFields: [] },
  inFile: { state: "NONE", firstOccurrenceRow: null, laterRows: [] },
};
const NO_REVERSAL = {
  state: "NOT_APPLICABLE",
  rawNumber: null,
  targetSourceRow: null,
  targetSummary: null,
  candidateCount: 0,
};

/** A row as Analyze returns it. */
function row(n, overrides = {}) {
  return {
    sourceRowNumber: n,
    state: "READY",
    errors: [],
    warnings: [],
    values: [
      value(H.type, "חשבונית מס", "TAX_INVOICE"),
      value(H.number, `2024/000${n}`),
      value(H.date, "17/03/2024", "2024-03-17"),
      value(H.total, "1170.00"),
      value(H.subtotal, "1000.00"),
      value(H.vat, "170.00"),
      value(H.currency, "ILS"),
      value(H.customer, "חברת דוגמה בעלת שם ארוך מאוד לבדיקת גלישה בע״מ"),
      value(H.taxId, "512345678"),
      value(H.source, "legacy-erp"),
      value(H.reverses, "", null),
    ],
    duplicate: NO_DUPLICATE,
    reversal: NO_REVERSAL,
    ...overrides,
  };
}

const mappingEntries = HEADERS.map((header, index) => ({
  field: header,
  target: "documentTypeCode",
  requirement:
    header === H.subtotal || header === H.vat || header === H.customer || header === H.taxId
      ? "optional"
      : header === H.reverses
        ? "conditional"
        : "required",
  sourceHeader: header,
  sourceIndex: index,
  status: "EXACT",
  candidates: [],
}));

function analyzeBody(overrides = {}) {
  const rows = overrides.rows ?? [row(1), row(2)];
  return {
    ok: true,
    file: {
      filename: "history.csv",
      format: "csv",
      sheetName: null,
      availableSheets: [],
      headers: HEADERS,
      rowCount: rows.length,
      contentHash: "fixture-content",
    },
    mapping: {
      entries: mappingEntries,
      unmappedSourceHeaders: [],
      blockers: [],
      mappingHash: "fixture-mapping",
    },
    dateInterpretation: {
      suppliedFormat: null,
      deterministic: true,
      requirement: null,
      choices: ["DMY", "MDY"],
    },
    summary: {
      totalRows: rows.length,
      ready: rows.filter((r) => r.state === "READY").length,
      warning: rows.filter((r) => r.state === "WARNING").length,
      error: rows.filter((r) => r.state === "ERROR").length,
      stoppedAtMapping: false,
    },
    rows,
    duplicateEvidence: {
      fingerprint: "fixture-evidence",
      identitiesQueried: rows.length,
      recordsMatched: 0,
      readAt: new Date().toISOString(),
      queryCount: 1,
    },
    analysisHash: "fixture-analysis",
    ...overrides,
  };
}

function previewRow(base, overrides = {}) {
  return {
    ...base,
    reversalTarget: "NOT_APPLICABLE",
    defaultDecision: "CREATE",
    allowedDecisions: ["CREATE", "SKIP"],
    selectedDecision: "CREATE",
    ownerDecisionRequired: false,
    blocked: false,
    blockingReasons: [],
    ...overrides,
  };
}

function previewBody(rows, overrides = {}) {
  const decisions = {};
  for (const r of rows) decisions[r.sourceRowNumber] = r.selectedDecision;
  const awaiting = rows.filter((r) => r.ownerDecisionRequired).map((r) => r.sourceRowNumber);
  const notReady = awaiting.length > 0 ? ["OWNER_DECISION_REQUIRED"] : [];
  return {
    ok: true,
    file: {
      filename: "history.csv",
      format: "csv",
      sheetName: null,
      rowCount: rows.length,
      contentHash: "fixture-content",
    },
    dateInterpretation: {
      suppliedFormat: null,
      deterministic: true,
      requirement: null,
      choices: ["DMY", "MDY"],
    },
    summary: {
      totalRows: rows.length,
      willCreate: rows.filter((r) => r.selectedDecision === "CREATE").length,
      willSkip: rows.filter((r) => r.selectedDecision === "SKIP").length,
      createAnyway: rows.filter((r) => r.selectedDecision === "CREATE_ANYWAY").length,
      ownerDecisionRequired: awaiting.length,
      blocked: rows.filter((r) => r.blocked).length,
      withWarnings: rows.filter((r) => r.warnings.length > 0).length,
      exactDatabaseDuplicates: rows.filter((r) => r.duplicate.database.state === "EXACT").length,
      strongDuplicateCandidates: rows.filter(
        (r) => r.duplicate.database.state === "STRONG_CANDIDATE"
      ).length,
      inFileCollisions: rows.filter((r) => r.duplicate.inFile.state !== "NONE").length,
      unresolvedReversals: rows.filter((r) => r.reversal.state === "NOT_FOUND").length,
    },
    rows,
    rowsTruncated: false,
    decisions,
    awaitingDecision: awaiting,
    readyForExecute: notReady.length === 0,
    notReadyReasons: notReady,
    evidenceFingerprint: "fixture-evidence",
    previewToken: notReady.length === 0 ? "fixture-token" : null,
    expiresAt:
      notReady.length === 0 ? new Date(Date.now() + 1_800_000).toISOString() : null,
    ...overrides,
  };
}

const recordItem = (id, overrides = {}) => ({
  id,
  documentTypeCode: "TAX_INVOICE",
  originalDocumentNumber: `2024/${String(id).padStart(4, "0")}`,
  originalIssueDate: "2024-03-17",
  totalAmount: "1170.00",
  currency: "ILS",
  customerNameSnapshot: "חברת דוגמה בעלת שם ארוך במיוחד לבדיקת גלישה בע״מ",
  sourceSystemCode: "legacy-erp",
  sourceSystemNameRaw: "Legacy ERP 7 — מערכת חשבונאות ותיקה עם שם ארוך",
  reversesLinked: false,
  reversesOriginalNumberRaw: null,
  ...overrides,
});

function recordsBody(overrides = {}) {
  const items = overrides.items ?? Array.from({ length: 20 }, (_, i) => recordItem(i + 1));
  return {
    ok: true,
    items,
    page: 1,
    pageSize: 20,
    total: 43,
    totalPages: 3,
    hasMore: true,
    sourceSystems: ["legacy-erp", "zzz-rare-system"],
    emptyHistory: false,
    ...overrides,
  };
}

/* ------------------------------------------------------------- browser -- */

const browser = await chromium.launch();
const context = await browser.newContext({ locale: "he-IL" });
const page = await context.newPage();

page.on("console", (msg) => {
  if (msg.type() !== "error") return;
  // This harness DELIBERATELY serves 401, 409 and 500 to see the states they
  // produce, and the browser logs every one as a failed resource load. Those are
  // the fixtures, not defects. A real script error still counts.
  if (/Failed to load resource/i.test(msg.text())) return;
  consoleErrors.push(msg.text());
});

// A session token so the screens send an Authorization header. The endpoints are
// intercepted, so this value never authenticates anything.
await context.addInitScript(() => {
  try {
    localStorage.setItem("token", "qa-fixture-token");
  } catch {
    /* a blocked storage is not this harness's problem */
  }
});

/** Serve one fixture for a historical endpoint. */
let handlers = {};
await page.route("**/api/data-transfer/**", async (route) => {
  const url = route.request().url();
  for (const [fragment, handler] of Object.entries(handlers)) {
    if (url.includes(fragment)) {
      const { status = 200, body } = await handler(route);
      await route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
      return;
    }
  }
  await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
});

const measure = () =>
  page.evaluate(() => {
    const doc = document.documentElement;
    const controls = Array.from(
      document.querySelectorAll("button, select, input:not([type=file]), a[href]")
    ).filter((el) => el.getBoundingClientRect().height > 0)
      // The shared "חזרה" control is the app's ONE canonical back button and its
      // own module fixes it at 40px for every screen in the product — its doc
      // says do not restyle it at a call site. It is measured separately below
      // so the finding stays visible instead of being folded into this feature.
      .filter((el) => el.getAttribute("aria-label") !== "חזרה");
    return {
      backButtonHeight: (() => {
        const back = Array.from(document.querySelectorAll("button")).find(
          (el) => el.getAttribute("aria-label") === "חזרה"
        );
        return back ? Math.round(back.getBoundingClientRect().height) : null;
      })(),
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      dir: getComputedStyle(document.querySelector("[dir='rtl']") || doc).direction,
      heading: document.querySelector("h1")?.innerText?.trim() ?? null,
      text: document.body.innerText.replace(/\s+/g, " "),
      shortControls: controls
        .map((el) => ({
          h: Math.round(el.getBoundingClientRect().height),
          t: (el.innerText || el.getAttribute("aria-label") || el.tagName).slice(0, 24),
        }))
        .filter((c) => c.h < 44),
    };
  });

/* =============================================== 1. the hub ============== */

await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${BASE}${HUB}`, { waitUntil: "networkidle", timeout: 90_000 });

const hub = await page.evaluate(() => {
  const nav = document.querySelector('nav[aria-label="ייבוא וייצוא"]');
  const rows = nav ? Array.from(nav.children) : [];
  return {
    count: rows.length,
    hrefs: rows.map((el) => (el.tagName === "A" ? el.getAttribute("href") : null)),
    text: (nav?.innerText || "").replace(/\s+/g, " "),
  };
});
check("the hub now offers five ways in and out", hub.count === 5, hub.hrefs.join(" | "));
check(
  "the historical row is a real link, fourth, before Export",
  hub.hrefs[3] === IMPORT_ROUTE,
  String(hub.hrefs[3])
);
check(
  "the historical row says the documents came from another system",
  hub.text.includes("היסטוריה ממערכת קודמת") && hub.text.includes("מערכת אחרת"),
  hub.text.slice(0, 120)
);
check("no row says 'בקרוב'", !hub.text.includes("בקרוב"));
await page.screenshot({ path: path.join(OUT, "hub-m390.png"), fullPage: true });

/* =============================================== 2. the import screen ==== */

for (const [label, width, height] of VIEWPORTS) {
  handlers = {};
  await page.setViewportSize({ width, height });
  const response = await page.goto(`${BASE}${IMPORT_ROUTE}`, {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  await page.waitForTimeout(120);
  const m = await measure();
  const overflow = m.scrollWidth - m.clientWidth;

  check(`[${label}] the import screen renders`, response?.status() === 200, `HTTP ${response?.status()}`);
  check(`[${label}] no horizontal overflow`, overflow <= 0, `${overflow}px`);
  check(`[${label}] direction is RTL`, m.dir === "rtl", m.dir);
  check(
    `[${label}] every control meets 44px`,
    m.shortControls.length === 0,
    JSON.stringify(m.shortControls).slice(0, 120)
  );

  if (label === "m390-mobile") {
    // Recorded, not owned: the shared back button is 40px on every settings
    // sub-page in the product, including ones that shipped long before this
    // feature. Reported as a pre-existing platform finding.
    check(
      "PRE-EXISTING: the shared back button is 40px, not 44px",
      m.backButtonHeight === 40,
      `${m.backButtonHeight}px — shared primitive, unchanged by this feature`
    );
    check("the heading names the flow", m.heading === "היסטוריה ממערכת קודמת", String(m.heading));
    check(
      "it says Dubiz did not issue, number or report these",
      m.text.includes("לא הפיקה") && m.text.includes("לא הקצתה") && m.text.includes("לא דיווחה"),
      "origin denial"
    );
    check("the no-write promise is on the page", m.text.includes("שום דבר לא נשמר עד שתאשרו"));
    check("the template is offered", m.text.includes("הורדת התבנית"));
    check("the records view is reachable before importing anything", m.text.includes("שכבר נקלטו"));
    check("the file limits are stated in the owner's terms", m.text.includes("10,000"));
  }

  await page.screenshot({ path: path.join(OUT, `import-${label}.png`), fullPage: true });
}

/* ---------------------------------------- the flow, state by state ------ */

const CSV = Buffer.from(`${HEADERS.join(",")}\nחשבונית מס,2024/0001,17/03/2024,1170.00,1000.00,170.00,ILS,לקוח,512345678,legacy-erp,\n`, "utf8");

async function upload() {
  await page.setInputFiles('input[type="file"]', {
    name: "history.csv",
    mimeType: "text/csv",
    buffer: CSV,
  });
  await page.waitForTimeout(400);
}

async function freshImportScreen(fixtures) {
  handlers = fixtures;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}${IMPORT_ROUTE}`, { waitUntil: "networkidle", timeout: 90_000 });
  await upload();
}

/* -- a mapping blocker ---------------------------------------------------- */

await freshImportScreen({
  "historical/analyze": async () => ({
    body: analyzeBody({
      rows: [],
      mapping: {
        entries: mappingEntries,
        unmappedSourceHeaders: ["סכום"],
        blockers: [
          { code: "MAPPING_REQUIRED_MISSING", field: H.currency, reason: "server reason" },
        ],
        mappingHash: "fixture-mapping",
      },
      summary: {
        totalRows: 0,
        ready: 0,
        warning: 0,
        error: 0,
        stoppedAtMapping: true,
      },
    }),
  }),
});
let text = (await measure()).text;
check(
  "a missing required column is explained in owner language",
  text.includes("עמודת חובה שלא נמצאה בקובץ") && text.includes(H.currency),
  "mapping blocker"
);
check(
  "no preview is offered while a column is missing",
  !text.includes("המשיכו לתצוגה מקדימה"),
  "preview offered anyway"
);
await page.screenshot({ path: path.join(OUT, "state-mapping-blocker.png"), fullPage: true });

/* -- an ambiguous date ---------------------------------------------------- */

await freshImportScreen({
  "historical/analyze": async () => ({
    body: analyzeBody({
      rows: [
        row(1, {
          state: "ERROR",
          errors: [
            { field: H.date, code: "AMBIGUOUS_DATE", reason: "server reason" },
          ],
          values: [
            value(H.type, "חשבונית מס", "TAX_INVOICE"),
            value(H.number, "2024/0001"),
            value(H.date, "03/04/2025", null),
            value(H.total, "1170.00"),
            value(H.currency, "ILS"),
            value(H.source, "legacy-erp"),
          ],
        }),
      ],
      dateInterpretation: {
        suppliedFormat: null,
        deterministic: false,
        requirement: "DATE_FORMAT_REQUIRED",
        choices: ["DMY", "MDY"],
      },
    }),
  }),
});
text = (await measure()).text;
check(
  "an ambiguous date is a QUESTION, with the example the owner needs",
  text.includes("03/04/2025") && text.includes("ה־3 באפריל") && text.includes("ה־4 במרץ"),
  "date question"
);
check(
  "the ambiguous row says what to do about it",
  text.includes("בחרו למעלה איך לקרוא תאריכים"),
  "row-level guidance"
);
check(
  "neither reading is preselected",
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    const chosen = buttons.filter((b) =>
      /יום\/חודש|חודש\/יום/.test(b.innerText) &&
      b.className.includes("--dz-accent")
    );
    return chosen.length === 0;
  }),
  "a format was preselected"
);
await page.screenshot({ path: path.join(OUT, "state-ambiguous-date.png"), fullPage: true });

/* -- warnings that remain importable, and a hard error -------------------- */

await freshImportScreen({
  "historical/analyze": async () => ({
    body: analyzeBody({
      rows: [
        row(1, {
          state: "WARNING",
          warnings: [
            { field: H.total, code: "VAT_ARITHMETIC_MISMATCH", reason: "server reason" },
          ],
        }),
        row(2, {
          state: "ERROR",
          errors: [{ field: H.currency, code: "MISSING_CURRENCY", reason: "server reason" }],
        }),
        row(3),
      ],
    }),
  }),
});
text = (await measure()).text;
check(
  "a warning is distinguished from a blocker, in words",
  text.includes("שורה עם התראה עדיין ניתנת לקליטה"),
  "warning wording"
);
check(
  "the VAT mismatch says the numbers are KEPT, not repaired",
  text.includes("נשמור את שלושתם בדיוק כפי שנכתבו"),
  "vat wording"
);
check(
  "a missing currency is refused rather than assumed",
  text.includes("לא נניח מטבע במקומכם"),
  "currency wording"
);
check("the three buckets are counted separately", text.includes("שווה מבט") && text.includes("לא ניתן לייבא"));
await page.screenshot({ path: path.join(OUT, "state-warnings-and-errors.png"), fullPage: true });

/* -- duplicates and a blocked reversal, then the decision step ------------ */

const dupeRows = [
  // DB EXACT — already held, defaults to SKIP, override allowed.
  previewRow(
    row(1, {
      state: "WARNING",
      warnings: [{ field: H.number, code: "DUPLICATE_EXISTS", reason: "r" }],
      duplicate: {
        database: {
          state: "EXACT",
          matchCount: 1,
          comparison: [],
          differingFields: [],
        },
        inFile: { state: "NONE", firstOccurrenceRow: null, laterRows: [] },
      },
    }),
    {
      defaultDecision: "SKIP",
      allowedDecisions: ["SKIP", "CREATE_ANYWAY"],
      selectedDecision: "SKIP",
    }
  ),
  // STRONG_CANDIDATE — same number, different facts. Owner must decide.
  previewRow(
    row(2, {
      state: "WARNING",
      warnings: [{ field: H.number, code: "DUPLICATE_CONFLICT", reason: "r" }],
      duplicate: {
        database: {
          state: "STRONG_CANDIDATE",
          matchCount: 1,
          comparison: [],
          differingFields: ["totalAmount", "originalIssueDate"],
        },
        inFile: { state: "NONE", firstOccurrenceRow: null, laterRows: [] },
      },
    }),
    {
      defaultDecision: "SKIP",
      allowedDecisions: ["SKIP", "CREATE_ANYWAY"],
      selectedDecision: "SKIP",
      ownerDecisionRequired: true,
    }
  ),
  // DB AMBIGUOUS — blocked, SKIP only.
  previewRow(
    row(3, {
      state: "ERROR",
      errors: [{ field: H.number, code: "DUPLICATE_AMBIGUOUS", reason: "r" }],
      duplicate: {
        database: {
          state: "AMBIGUOUS",
          matchCount: 2,
          comparison: null,
          differingFields: [],
        },
        inFile: { state: "NONE", firstOccurrenceRow: null, laterRows: [] },
      },
    }),
    {
      defaultDecision: "SKIP",
      allowedDecisions: ["SKIP"],
      selectedDecision: "SKIP",
      blocked: true,
      blockingReasons: ["DUPLICATE_AMBIGUOUS"],
    }
  ),
  // In-file conflict — row 18 against row 7, first wins.
  previewRow(
    row(18, {
      state: "WARNING",
      warnings: [{ field: H.number, code: "IN_FILE_CONFLICT", reason: "r" }],
      duplicate: {
        database: {
          state: "NONE",
          matchCount: 0,
          comparison: null,
          differingFields: [],
        },
        inFile: { state: "CONFLICTING_DUPLICATE", firstOccurrenceRow: 7, laterRows: [] },
      },
    }),
    {
      defaultDecision: "SKIP",
      allowedDecisions: ["SKIP", "CREATE_ANYWAY"],
      selectedDecision: "SKIP",
      ownerDecisionRequired: true,
    }
  ),
  // A credit whose target is later in the file — blocked.
  previewRow(
    row(20, {
      state: "ERROR",
      errors: [
        { field: H.reverses, code: "REVERSAL_TARGET_AFTER_CREDIT", reason: "r" },
      ],
      reversal: {
        state: "TARGET_AFTER_CREDIT",
        rawNumber: "2024/0099",
        targetSourceRow: 30,
        targetSummary: null,
        candidateCount: 1,
      },
    }),
    {
      reversalTarget: "BLOCKED",
      defaultDecision: "SKIP",
      allowedDecisions: ["SKIP"],
      selectedDecision: "SKIP",
      blocked: true,
      blockingReasons: ["REVERSAL_TARGET_AFTER_CREDIT"],
    }
  ),
  // A credit whose original was never imported — text only, still importable.
  previewRow(
    row(21, {
      state: "WARNING",
      warnings: [
        { field: H.reverses, code: "REVERSAL_TARGET_NOT_FOUND", reason: "r" },
      ],
      reversal: {
        state: "NOT_FOUND",
        rawNumber: "NEVER-IMPORTED-9",
        targetSourceRow: null,
        targetSummary: null,
        candidateCount: 0,
      },
    }),
    { reversalTarget: "TEXT_ONLY" }
  ),
];

await freshImportScreen({
  "historical/analyze": async () => ({
    body: analyzeBody({ rows: dupeRows.map(({ ...r }) => r) }),
  }),
  "historical/preview": async () => ({ body: previewBody(dupeRows) }),
});
await page.getByRole("button", { name: "המשיכו לתצוגה מקדימה" }).click();
await page.waitForTimeout(400);
text = (await measure()).text;

check(
  "an already-held document is explained and defaults to being skipped",
  text.includes("כבר קיים בהיסטוריה, עם אותם פרטים בדיוק") && text.includes("ידולג"),
  "DB EXACT"
);
check(
  "a same-number-different-facts row NAMES the differences",
  text.includes("שונה ב:") && text.includes("סכום כולל") && text.includes("תאריך המסמך"),
  "STRONG_CANDIDATE differences"
);
check(
  "an in-file conflict is explained as row against row, first wins",
  text.includes("שורה 18 מתנגשת עם שורה 7") && text.includes("והראשונה קודמת"),
  "in-file conflict"
);
check(
  "a blocked row states its reason and offers no action",
  text.includes("אי אפשר לקלוט אותה") &&
    text.includes("כבר יש בהיסטוריה יותר ממסמך אחד עם המספר הזה"),
  "blocked rows"
);
check(
  "a missing reversal target is text-only and still importable",
  text.includes("המספר שנכתב יישמר כפי שהוא, בלי קישור") ||
    text.includes("המספר יישמר כטקסט בלבד"),
  "NOT_FOUND"
);
check(
  "the file is NOT confirmable while a decision is outstanding",
  text.includes("יש שורות שממתינות להחלטה שלכם"),
  "not-ready reason"
);
check(
  "the confirm button is disabled",
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll("button")).find((x) =>
      x.innerText.includes("אשרו וקלטו")
    );
    return b ? b.disabled : "no button";
  }) === true,
  "confirm gating"
);

const overrideButtons = await page.evaluate(
  () =>
    Array.from(document.querySelectorAll("button"))
      .map((b) => b.innerText.trim())
      .filter((t) => t.includes("בכל זאת")).length
);
check(
  "CREATE_ANYWAY is offered only where the server allows it",
  overrideButtons === 3,
  `${overrideButtons} override buttons for 3 overridable rows`
);
check(
  "the override is described as an ADDITIONAL record, not a replacement",
  text.includes("כרשומה נוספת") || text.includes("רשומה היסטורית נוספת"),
  "CREATE_ANYWAY wording"
);
await page.screenshot({ path: path.join(OUT, "state-duplicates-decisions.png"), fullPage: true });

/* -- choosing an override asks for a fresh preview before running -------- */

await page.getByRole("button", { name: "לקלוט בכל זאת, כרשומה נוספת" }).first().click();
await page.waitForTimeout(200);
text = (await measure()).text;
check(
  "a new choice must be re-checked by the server before it can run",
  text.includes("עדכנו את התצוגה המקדימה לפי הבחירות"),
  "re-preview required"
);
check(
  "the override's consequence is spelled out where it was chosen",
  text.includes("הרשומה הקיימת נשארת כפי שהיא") && text.includes("לא מוחלפת"),
  "override help text"
);
await page.screenshot({ path: path.join(OUT, "state-override-chosen.png"), fullPage: true });

/* -- an expired preview -------------------------------------------------- */

const readyRows = [previewRow(row(1)), previewRow(row(2))];
await freshImportScreen({
  "historical/analyze": async () => ({ body: analyzeBody({ rows: [row(1), row(2)] }) }),
  "historical/preview": async () => ({ body: previewBody(readyRows) }),
  "historical/execute": async () => ({
    status: 401,
    body: { ok: false, code: "TOKEN_EXPIRED", message: "server message" },
  }),
});
await page.getByRole("button", { name: "המשיכו לתצוגה מקדימה" }).click();
await page.waitForTimeout(300);
await page.getByRole("button", { name: /אשרו וקלטו/ }).click();
await page.waitForTimeout(400);
text = (await measure()).text;
check(
  "an expired preview says so, and never 'אירעה שגיאה'",
  text.includes("התצוגה המקדימה פגה") && !text.includes("אירעה שגיאה"),
  "TOKEN_EXPIRED"
);
check("and it offers the way out", text.includes("בדקו את הקובץ מחדש"), "recovery control");
await page.screenshot({ path: path.join(OUT, "state-token-expired.png"), fullPage: true });

/* -- stale evidence ------------------------------------------------------ */

await freshImportScreen({
  "historical/analyze": async () => ({ body: analyzeBody({ rows: [row(1)] }) }),
  "historical/preview": async () => ({
    status: 409,
    body: {
      ok: false,
      code: "ANALYSIS_STALE",
      message: "server message",
      currentEvidenceFingerprint: "moved",
    },
  }),
});
await page.getByRole("button", { name: "המשיכו לתצוגה מקדימה" }).click();
await page.waitForTimeout(400);
text = (await measure()).text;
check(
  "stale data says the data moved and a fresh check is needed",
  text.includes("הנתונים השתנו מאז הבדיקה") && text.includes("תצוגה מקדימה מחדש"),
  "ANALYSIS_STALE"
);
await page.screenshot({ path: path.join(OUT, "state-analysis-stale.png"), fullPage: true });

/* -- completion, and the replayed variant -------------------------------- */

await freshImportScreen({
  "historical/analyze": async () => ({ body: analyzeBody({ rows: [row(1), row(2)] }) }),
  "historical/preview": async () => ({ body: previewBody(readyRows) }),
  "historical/execute": async () => ({
    body: {
      ok: true,
      runId: 4242,
      status: "COMPLETED",
      replayed: false,
      totals: { totalRows: 2, created: 2, skipped: 0, failed: 0, alreadyExecuted: 0 },
      rows: [
        { sourceRowNumber: 1, result: "CREATED" },
        { sourceRowNumber: 2, result: "CREATED" },
      ],
    },
  }),
});
await page.getByRole("button", { name: "המשיכו לתצוגה מקדימה" }).click();
await page.waitForTimeout(300);
await page.getByRole("button", { name: /אשרו וקלטו/ }).click();
await page.waitForTimeout(500);
text = (await measure()).text;
check("the completion summary counts what happened", text.includes("הקליטה הסתיימה") && text.includes("נשמרו"));
check("no internal run identifier is shown", !text.includes("4242"), "runId leaked");
check(
  "the completion leads to the records view",
  text.includes("לצפייה במסמכים ההיסטוריים"),
  "records path"
);
await page.screenshot({ path: path.join(OUT, "state-completed.png"), fullPage: true });

await freshImportScreen({
  "historical/analyze": async () => ({ body: analyzeBody({ rows: [row(1), row(2)] }) }),
  "historical/preview": async () => ({ body: previewBody(readyRows) }),
  "historical/execute": async () => ({
    body: {
      ok: true,
      runId: 4242,
      status: "COMPLETED",
      replayed: true,
      totals: { totalRows: 2, created: 0, skipped: 0, failed: 0, alreadyExecuted: 2 },
      rows: [
        { sourceRowNumber: 1, result: "ALREADY_EXECUTED" },
        { sourceRowNumber: 2, result: "ALREADY_EXECUTED" },
      ],
    },
  }),
});
await page.getByRole("button", { name: "המשיכו לתצוגה מקדימה" }).click();
await page.waitForTimeout(300);
await page.getByRole("button", { name: /אשרו וקלטו/ }).click();
await page.waitForTimeout(500);
text = (await measure()).text;
check(
  "a replayed import does not claim to have imported anything twice",
  text.includes("שום דבר לא נשמר") && text.includes("כבר נקלט קודם"),
  "replay wording"
);
await page.screenshot({ path: path.join(OUT, "state-replayed.png"), fullPage: true });

/* =============================================== 3. the records view ===== */

for (const [label, width, height] of VIEWPORTS) {
  handlers = { "historical/records": async () => ({ body: recordsBody() }) };
  await page.setViewportSize({ width, height });
  const response = await page.goto(`${BASE}${RECORDS_ROUTE}`, {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  await page.waitForTimeout(300);
  const m = await measure();
  const overflow = m.scrollWidth - m.clientWidth;

  check(`[${label}] the records view renders`, response?.status() === 200, `HTTP ${response?.status()}`);
  check(`[${label}] no horizontal overflow with long names`, overflow <= 0, `${overflow}px`);
  check(`[${label}] direction is RTL`, m.dir === "rtl", m.dir);
  check(
    `[${label}] every control meets 44px`,
    m.shortControls.length === 0,
    JSON.stringify(m.shortControls).slice(0, 120)
  );

  if (label === "m390-mobile") {
    check("every record is badged as external", (m.text.match(/יובא ממערכת אחרת/g) ?? []).length >= 20);
    check("the list is read-only and says so", m.text.includes("לצפייה בלבד"));
    check(
      "no billing action is offered",
      !/שליחה|הפקת מסמך|ביטול מסמך|דיווח לרשות|עריכה|מחיקה/.test(m.text),
      "an action leaked"
    );
    check("paging is offered, server-side", m.text.includes("עמוד 1 מתוך 3"));
    check("the total is stated", m.text.includes("43"));
  }

  await page.screenshot({ path: path.join(OUT, `records-${label}.png`), fullPage: true });
}

/* -- the empty history -------------------------------------------------- */

handlers = {
  "historical/records": async () => ({
    body: recordsBody({
      items: [],
      total: 0,
      totalPages: 1,
      hasMore: false,
      sourceSystems: [],
      emptyHistory: true,
    }),
  }),
};
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${BASE}${RECORDS_ROUTE}`, { waitUntil: "networkidle", timeout: 90_000 });
await page.waitForTimeout(300);
text = (await measure()).text;
check(
  "an empty history explains itself and offers the way in",
  text.includes("עדיין לא נקלטו מסמכים היסטוריים") &&
    text.includes("להעלאת מסמכים מהמערכת הקודמת"),
  "empty state"
);
await page.screenshot({ path: path.join(OUT, "records-empty.png"), fullPage: true });

/* -- a filter that matches nothing -------------------------------------- */

handlers = {
  "historical/records": async () => ({
    body: recordsBody({
      items: [],
      total: 0,
      totalPages: 1,
      hasMore: false,
      emptyHistory: false,
    }),
  }),
};
await page.goto(`${BASE}${RECORDS_ROUTE}`, { waitUntil: "networkidle", timeout: 90_000 });
await page.waitForTimeout(300);
await page.getByRole("button", { name: "סננו" }).click();
await page.waitForTimeout(300);
text = (await measure()).text;
check(
  "no match under a filter is NOT the same message as an empty history",
  text.includes("אין מסמכים שמתאימים לסינון") &&
    !text.includes("עדיין לא נקלטו מסמכים היסטוריים"),
  "filtered-empty state"
);
await page.screenshot({ path: path.join(OUT, "records-filtered-empty.png"), fullPage: true });

/* -- the list failed ---------------------------------------------------- */

handlers = {
  "historical/records": async () => ({
    status: 500,
    body: { error: "server", code: "RECORDS_FAILED" },
  }),
};
await page.goto(`${BASE}${RECORDS_ROUTE}`, { waitUntil: "networkidle", timeout: 90_000 });
await page.waitForTimeout(300);
text = (await measure()).text;
check(
  "a failed load says so in owner language and offers a retry",
  text.includes("טעינת ההיסטוריה נכשלה") && text.includes("נסו שוב"),
  "error state"
);
await page.screenshot({ path: path.join(OUT, "records-error.png"), fullPage: true });

/* =============================================== 4. one record ========== */

const DETAIL = {
  ok: true,
  record: {
    ...recordItem(7, { documentTypeCode: "CREDIT_NOTE", totalAmount: "-1170.00" }),
    subtotalAmount: "-1000.00",
    vatAmount: "-170.00",
    customerTaxIdSnapshot: "512345678",
    sourceDocumentTypeRaw: "תעודת זיכוי",
    importedAt: new Date().toISOString(),
    reversesLinked: true,
    reversesOriginalNumberRaw: "2024/0001",
    reverses: {
      id: 1,
      documentTypeCode: "TAX_INVOICE",
      originalDocumentNumber: "2024/0001",
      originalIssueDate: "2024-03-17",
    },
    reversedBy: [],
  },
};

for (const [label, width, height] of [
  ["m390-mobile", 390, 844],
  ["d1440-desktop", 1440, 900],
]) {
  handlers = { "historical/records/7": async () => ({ body: DETAIL }) };
  await page.setViewportSize({ width, height });
  const response = await page.goto(`${BASE}${RECORDS_ROUTE}/7`, {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  await page.waitForTimeout(300);
  const m = await measure();
  check(`[${label}] the record renders`, response?.status() === 200, `HTTP ${response?.status()}`);
  check(`[${label}] no horizontal overflow`, m.scrollWidth - m.clientWidth <= 0);
  check(`[${label}] direction is RTL`, m.dir === "rtl", m.dir);

  if (label === "m390-mobile") {
    check("the record is badged as external", m.text.includes("יובא ממערכת אחרת"));
    check("it is named by its type, not by an id", m.text.includes("חשבונית זיכוי") && !m.text.includes("#7"));
    check(
      "the fiscal facts of the ORIGINAL are shown",
      m.text.includes("מספר מסמך מקורי") && m.text.includes("2024/0007"),
      "facts"
    );
    check(
      "the customer is shown as a snapshot, not a linked card",
      m.text.includes("לא מקושר לכרטיס לקוח"),
      "customer boundary"
    );
    check("the source system keeps its own words", m.text.includes("Legacy ERP 7"));
    check("the reversal relationship is shown", m.text.includes("המסמך הזה מזכה את"));
    check("read-only is stated", m.text.includes("לצפייה בלבד"));
    check(
      "no billing action is offered",
      !/שליחה|הפקת מסמך|ביטול מסמך|דיווח לרשות|עריכת|מחיקת/.test(m.text),
      "an action leaked"
    );
  }
  await page.screenshot({ path: path.join(OUT, `record-${label}.png`), fullPage: true });
}

/* -- an unresolved credit keeps the number it was given ------------------ */

handlers = {
  "historical/records/8": async () => ({
    body: {
      ok: true,
      record: {
        ...DETAIL.record,
        id: 8,
        reversesLinked: false,
        reverses: null,
        reversesOriginalNumberRaw: "NEVER-IMPORTED-9",
      },
    },
  }),
};
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${BASE}${RECORDS_ROUTE}/8`, { waitUntil: "networkidle", timeout: 90_000 });
await page.waitForTimeout(300);
text = (await measure()).text;
check(
  "an unresolved credit shows the number the source wrote, and says no link was found",
  text.includes("NEVER-IMPORTED-9") && text.includes("לא נמצא בהיסטוריה"),
  "unresolved reversal"
);
await page.screenshot({ path: path.join(OUT, "record-unresolved-credit.png"), fullPage: true });

/* -- a record that is not this business's ------------------------------- */

handlers = {
  "historical/records/999": async () => ({
    status: 404,
    body: { error: "המסמך לא נמצא", code: "NOT_FOUND" },
  }),
};
await page.goto(`${BASE}${RECORDS_ROUTE}/999`, { waitUntil: "networkidle", timeout: 90_000 });
await page.waitForTimeout(300);
text = (await measure()).text;
check(
  "a record that is not yours is simply not found — no hint that it exists",
  text.includes("המסמך לא נמצא") && !text.includes("הרשאה") && !text.includes("עסק אחר"),
  "404 wording"
);
await page.screenshot({ path: path.join(OUT, "record-not-found.png"), fullPage: true });

/* ------------------------------------------------------------- verdict -- */

check(
  "no console errors anywhere in the run",
  consoleErrors.length === 0,
  consoleErrors.slice(0, 3).join(" | ")
);

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log(`screenshots: ${OUT}`);
if (failed.length > 0) {
  console.log("\nFAILED:");
  failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ""}`));
  process.exitCode = 1;
}
