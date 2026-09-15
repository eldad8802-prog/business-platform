/**
 * Entity-list overflow invariants (Customers / Leads / Suppliers / Inventory).
 *
 * WHAT THIS LOCKS. The defect these four screens shared was not a missing rule
 * — it was a rule that could not apply. `overflow: hidden` and
 * `text-overflow: ellipsis` do NOTHING on a non-replaced INLINE box, while
 * `white-space: nowrap` on that same box very much does. Every CRM row declared
 * all three on a `<span>`, so the "truncation" was inert and the only surviving
 * effect was a line that refused to wrap and ran out of the card. Because
 * `body { overflow-x: hidden }` then clipped it, no scrollbar ever appeared —
 * which is exactly why it survived earlier responsive passes.
 *
 * So the invariant is about the PAIRING, not about either half:
 *   a truncation declaration is only valid on a box that is blockified.
 *
 * These are cheap textual invariants over the real stylesheets and the real
 * consumers. They cannot prove geometry — `scripts/qa/ui/entity-list-overflow.mjs`
 * does that in a browser. They exist so the geometry harness can never quietly
 * start passing for the wrong reason, and so a future edit that reintroduces the
 * inline/truncation pairing fails in CI rather than in a customer's hand.
 *
 * Run: npx tsx lib/design/entity-list-overflow.verify.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

const CRM_CSS = read("app/(shell)/customers/crm.css");
const INV_PRIMITIVES = read("components/inventory/inventory-primitives.css.ts");
const INV_ITEMS = read("components/inventory/inventory-items-list.css.ts");

const CONSUMERS = [
  "components/customers/CustomerRow.tsx",
  "components/customers/CustomerCard.tsx",
  "components/leads/LeadRow.tsx",
  "components/leads/LeadCard.tsx",
  "components/suppliers/SuppliersList.tsx",
  "components/suppliers/SupplierDuplicateNotice.tsx",
  "app/(shell)/suppliers/[id]/page.tsx",
] as const;

let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail = "") {
  checks += 1;
  if (ok) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Body of one CSS rule, by exact selector, from a stylesheet or a CSS-in-TS string. */
function ruleBody(css: string, selector: string): string | null {
  // Selectors here are literal class chains, so escaping the regex metacharacters
  // is enough — no selector grammar is needed.
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|[},/*\\s])${escaped}\\s*\\{([^}]*)\\}`, "m").exec(css);
  return m ? m[1] : null;
}

const has = (body: string | null, prop: RegExp) => body != null && prop.test(body);

console.log("\n[1] Truncation is only declared on boxes that can honour it");

/**
 * Every rule that declares `text-overflow: ellipsis` must also establish a
 * non-inline display — either on itself, or (the flex case) by being a child of
 * a container this test confirms is a flex/grid box.
 */
const TRUNCATING_RULES: Array<{
  css: string;
  where: string;
  selector: string;
  /**
   * How the box stops being inline: `self` — it declares a display of its own;
   * `parent` — a flex/grid container blockifies it; `markup` — the consumer
   * renders it as a block element (`<div>`), so it is a block box already.
   */
  blockifiedBy: { selector: string; via: "self" | "parent" | "markup" };
}> = [
  {
    css: CRM_CSS,
    where: "crm.css",
    selector: ".crm-row__name",
    blockifiedBy: { selector: ".crm-row__body", via: "parent" },
  },
  // These two are already block boxes: AttachmentList renders them as <div>
  // inside `.crm-att-card__main`, which is itself a flex ITEM of `.crm-att-card`
  // (so its own `min-width: 0` applies). That is WHY attachments never showed
  // the defect the rows did — same declarations, different element.
  {
    css: CRM_CSS,
    where: "crm.css",
    selector: ".crm-att-card__name",
    blockifiedBy: { selector: "crm-att-card__name", via: "markup" },
  },
  {
    css: CRM_CSS,
    where: "crm.css",
    selector: ".crm-att-card__meta",
    blockifiedBy: { selector: "crm-att-card__meta", via: "markup" },
  },
  {
    css: INV_PRIMITIVES,
    where: "inventory-primitives.css.ts",
    selector: "[data-inventory-module] .inv-oline__nm",
    blockifiedBy: {
      selector: "[data-inventory-module] .inv-oline__mid",
      via: "parent",
    },
  },
  {
    css: INV_ITEMS,
    where: "inventory-items-list.css.ts",
    selector: "[data-inventory-items-list] .inv-items-list__name",
    blockifiedBy: {
      selector: "[data-inventory-items-list] .inv-items-list__main",
      via: "parent",
    },
  },
  {
    css: INV_ITEMS,
    where: "inventory-items-list.css.ts",
    selector: "[data-inventory-items-list] .inv-items-list__meta",
    blockifiedBy: {
      selector: "[data-inventory-items-list] .inv-items-list__main",
      via: "parent",
    },
  },
];

for (const rule of TRUNCATING_RULES) {
  const body = ruleBody(rule.css, rule.selector);
  check(`${rule.where} ${rule.selector} exists`, body != null);
  if (!body) continue;

  if (/text-overflow\s*:\s*ellipsis/.test(body)) {
    if (rule.blockifiedBy.via === "self") {
      check(
        `${rule.selector} declares a non-inline display itself`,
        /display\s*:\s*(block|flex|grid|-webkit-box|inline-block)/.test(body),
      );
    } else if (rule.blockifiedBy.via === "markup") {
      // The consumer must keep rendering it as a <div>. If someone "tidies" it
      // into a <span>, the ellipsis goes inert exactly as it did on the rows.
      const cls = rule.blockifiedBy.selector;
      const rendered = CONSUMERS.concat(["components/crm/AttachmentList.tsx"]).filter((f) =>
        read(f).includes(`"${cls}"`),
      );
      check(`${rule.selector} is rendered somewhere`, rendered.length > 0);
      for (const file of rendered) {
        check(
          `${rule.selector} is a block element in ${file}`,
          new RegExp(`<div[^>]*className=["']${cls}["']`).test(read(file)),
          "a <span> here would make the ellipsis inert",
        );
      }
    } else {
      const parent = ruleBody(rule.css, rule.blockifiedBy.selector);
      check(
        `${rule.selector} is blockified by ${rule.blockifiedBy.selector}`,
        has(parent, /display\s*:\s*(flex|grid)/),
        "parent must be flex/grid, or the ellipsis is inert on an inline span",
      );
      check(
        `${rule.blockifiedBy.selector} can actually shrink (min-width: 0)`,
        has(parent, /min-width\s*:\s*0/),
      );
    }
  }
}

console.log("\n[2] No CRM row text can set a min-content floor wider than its pane");

/**
 * `overflow-wrap: anywhere` and NOT `break-word`: only `anywhere` also reduces
 * the intrinsic min-content width, which is the property that actually stops a
 * 60-character email from widening the flex item it sits in. `break-word` looks
 * equivalent and is not.
 */
const MUST_WRAP_ANYWHERE: Array<[string, string]> = [
  [".crm-row__name", "row title"],
  [".crm-row__meta", "row meta line"],
  [".crm-row__meta-part", "one meta value"],
  [".crm-id__name", "card subject name"],
  [".crm-id__value", "card identity value"],
  [".crm-item__title", "card section item title"],
  [".crm-item__meta", "card section item meta"],
  [".crm-hd__title", "list header title"],
];

for (const [selector, label] of MUST_WRAP_ANYWHERE) {
  const body = ruleBody(CRM_CSS, selector);
  check(`${selector} (${label}) has overflow-wrap: anywhere`, has(body, /overflow-wrap\s*:\s*anywhere/));
  check(
    `${selector} does not rely on word-break: break-word`,
    body != null && !/word-break\s*:\s*break-word/.test(body),
    "break-word does not lower min-content width",
  );
}

console.log("\n[3] Controls keep their size; the text column is the one that gives");

const FLEX_CONTRACT: Array<[string, RegExp, string]> = [
  [".crm-row__body", /flex\s*:\s*1 1 auto/, "row text column takes the leftover width"],
  [".crm-row__body", /min-width\s*:\s*0/, "row text column may shrink"],
  [".crm-row__avatar", /flex-shrink\s*:\s*0/, "avatar is never crushed"],
  [".crm-row__chevron", /flex-shrink\s*:\s*0/, "chevron is never crushed"],
  [".crm-item__main", /flex\s*:\s*1 1 auto/, "item text column takes the leftover width"],
  [".crm-item__main", /min-width\s*:\s*0/, "item text column may shrink"],
  [".crm-item__amount", /flex-shrink\s*:\s*0/, "amount is never crushed"],
  [".crm-id__actions", /flex-shrink\s*:\s*0/, "card actions are never crushed"],
  [".crm-id__name", /min-width\s*:\s*0/, "card name may shrink"],
  [".crm-att-card__main", /min-width\s*:\s*0/, "attachment text column may shrink"],
  [".crm-att-card__actions", /flex-shrink\s*:\s*0/, "attachment actions are never crushed"],
];

for (const [selector, prop, label] of FLEX_CONTRACT) {
  check(`${selector}: ${label}`, has(ruleBody(CRM_CSS, selector), prop));
}

console.log("\n[4] Wrapping containers, so metadata stacks instead of colliding");

for (const [selector, label] of [
  [".crm-hd", "list header wraps below its action"],
  [".crm-id__head", "card head wraps below its actions"],
  [".crm-row__meta", "meta values move to the next line"],
] as Array<[string, string]>) {
  check(`${selector}: ${label}`, has(ruleBody(CRM_CSS, selector), /flex-wrap\s*:\s*wrap/));
}

console.log("\n[5] Bidi: LTR values inside an RTL surface are isolated");

for (const selector of [".crm-row__meta-part", ".crm-id__value", ".crm-att-card__name"]) {
  check(
    `${selector} is bidi-isolated`,
    has(ruleBody(CRM_CSS, selector), /unicode-bidi\s*:\s*isolate/),
  );
}

// The separator must be generated, never a literal "·" in the text run: a
// neutral character between an RTL label and an LTR value attaches itself to
// whichever run wins, which is how the parts ended up in an order nobody wrote.
check(
  "the meta separator is generated in CSS, not part of the text run",
  /\.crm-row__meta-part \+ \.crm-row__meta-part::before\s*\{[^}]*content\s*:\s*"·"/.test(CRM_CSS),
);

console.log("\n[6] A row's meta line is built from VALUES, never a joined string");

const ROW_META_USERS = [
  "components/customers/CustomerRow.tsx",
  "components/leads/LeadRow.tsx",
  "components/suppliers/SuppliersList.tsx",
  "components/suppliers/SupplierDuplicateNotice.tsx",
] as const;

/**
 * What is actually forbidden is joining values of DIFFERENT text direction into
 * one run — `phone · email · city` — because the bidi algorithm then reorders
 * the parts and the neutral separators attach to whichever run wins. Joining
 * same-direction labels into a single value (SupplierDuplicateNotice's list of
 * match reasons, all Hebrew) is fine: it arrives as ONE part and is isolated as
 * a whole. So the check looks at what is being joined, not at the join itself.
 */
const DIRECTIONAL_VALUE = /formatPhoneForDisplay|\bemail\b|\bwebsite\b|\btaxId\b/;

for (const file of ROW_META_USERS) {
  const src = read(file);
  const offenders: string[] = [];
  const joinRe = /\.join\(\s*["'] · ["']\s*\)/g;
  for (let m = joinRe.exec(src); m; m = joinRe.exec(src)) {
    const window = src.slice(Math.max(0, m.index - 220), m.index);
    if (DIRECTIONAL_VALUE.test(window)) offenders.push(window.trim().split("\n").pop() ?? "");
  }
  check(
    `${file} never joins mixed-direction values into one meta run`,
    offenders.length === 0,
    offenders.length ? `pass them to CrmRowMeta as parts: ${offenders[0]}` : "",
  );
}

console.log("\n[7] Consumers still render the classes this contract is written against");

for (const file of ROW_META_USERS) {
  const src = read(file);
  check(`${file} renders its meta through CrmRowMeta`, /<CrmRowMeta\b/.test(src));
  check(
    `${file} has no raw className="crm-row__meta"`,
    !/className=["']crm-row__meta["']/.test(src),
    "raw use bypasses the per-value isolation",
  );
}

for (const file of [
  "components/customers/CustomerCard.tsx",
  "components/leads/LeadCard.tsx",
  "app/(shell)/suppliers/[id]/page.tsx",
] as const) {
  const src = read(file);
  check(`${file} uses the shared .crm-id__head`, /className="crm-id__head"/.test(src));
}

/**
 * The row name is clamped to two lines, so ANYTHING rendered after the name
 * text inside that element is simply clipped away on long names. A lifecycle
 * badge ("לא פעיל") disappearing because a customer has a long name is silent
 * information loss — the row looks perfectly tidy and no longer says the record
 * is inactive. Badges therefore live in `.crm-row__badges`, a sibling.
 */
check(
  "crm.css defines the sibling badge row",
  /\.crm-row__badges\s*\{[^}]*display\s*:\s*flex/.test(CRM_CSS),
);

for (const file of ROW_META_USERS) {
  const src = read(file);
  // Look inside each `crm-row__name` element for a badge.
  const nameBlocks = src.match(/className="crm-row__name"[\s\S]*?<\/span>/g) ?? [];
  check(
    `${file} keeps status badges out of the clamped name`,
    !nameBlocks.some((b) => b.includes("crm-badge")),
    "a badge after the clamped text is clipped away on long names",
  );
}

console.log("\n[8] Inventory rows keep price and stock status on a phone");

const mobileBlock = /@media \(max-width: 720px\) \{([\s\S]*?)\n  \}/.exec(INV_ITEMS)?.[1] ?? "";
check("inventory mobile block found", mobileBlock.length > 0);
check(
  "the price is not display:none on mobile",
  !/__price[^{]*\{[^}]*display\s*:\s*none/.test(mobileBlock),
  "the selling price is not derivable from anything else on the row",
);
check(
  "the stock badge is not display:none on mobile",
  !/__badge-cell[^{]*\{[^}]*display\s*:\s*none/.test(mobileBlock),
  "the coloured quantity is colour alone, not a label",
);
check(
  "the row becomes two grid rows rather than seven squeezed cells",
  /grid-template-rows\s*:\s*auto auto/.test(mobileBlock),
);

console.log(
  `\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} checks passed`,
);
if (failures > 0) process.exit(1);
