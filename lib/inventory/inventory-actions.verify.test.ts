/**
 * Inventory actions — regressions for the 2026-11-03 inventory audit. Pure: no DB,
 * no network. Run:
 *   npx tsx lib/inventory/inventory-actions.verify.test.ts
 *
 *   ב4  saving a product from the edit sheet cleared its category
 *   ב5  "טופל" on an alert called a URL with no handler
 *   ב7  the manual-sale total added unit prices without the quantity
 *   O1  the movement sheet's confirm sat under the bottom bar on phones
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { decideCategoryOnSave } from "@/lib/inventory/category-edit";
import { inventoryAlertResolvePath } from "@/lib/inventory/inventory-routes";
import { chargedSaleTotal } from "@/lib/inventory/sale-total";
import { keyboardSheetInset } from "@/lib/inventory/sheet-viewport";
import { INVENTORY_ITEM_DETAIL_INCLUDE } from "@/lib/services/inventory/inventory-item-detail";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, extra = ""): void {
  total += 1;
  if (!cond) failures += 1;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
}

const ROOT = process.cwd();

// ---------------------------------------------------------------- ב4 category
const dairy = { id: 7, name: "מוצרי חלב" };
const item = { categoryId: 7, category: dairy };

const unchanged = decideCategoryOnSave("מוצרי חלב", item, [dairy]);
check("unchanged category is kept by id", unchanged.kind === "keep" && unchanged.id === 7, JSON.stringify(unchanged));

const unchangedNoList = decideCategoryOnSave("מוצרי חלב", item, []);
check(
  "unchanged category is kept even when the category list failed to load (no duplicate create)",
  unchangedNoList.kind === "keep" && unchangedNoList.id === 7,
  JSON.stringify(unchangedNoList)
);

const spacing = decideCategoryOnSave("  מוצרי   חלב ", item, []);
check("whitespace-only difference keeps the category", spacing.kind === "keep" && spacing.id === 7);

const latin = decideCategoryOnSave("dairy", { categoryId: 3, category: { id: 3, name: "Dairy" } }, []);
check("case-only difference keeps the category", latin.kind === "keep" && latin.id === 3);

check("emptied field clears the category", decideCategoryOnSave("", item, [dairy]).kind === "clear");
check("item without a category and an empty field sends null", decideCategoryOnSave("", { categoryId: null, category: null }, []).kind === "clear");

const other = decideCategoryOnSave("ירקות", item, [dairy, { id: 9, name: "ירקות" }]);
check("switching to an existing category uses its id", other.kind === "existing" && other.id === 9);

const fresh = decideCategoryOnSave(" פירות ", item, [dairy]);
check("a new name is created (normalized)", fresh.kind === "create" && fresh.name === "פירות");

check(
  "the product payload (GET and PATCH) includes the category",
  (INVENTORY_ITEM_DETAIL_INCLUDE as { category?: unknown }).category === true
);
check(
  "the product payload keeps only open alerts, newest first",
  INVENTORY_ITEM_DETAIL_INCLUDE.alerts.where.isResolved === false &&
    INVENTORY_ITEM_DETAIL_INCLUDE.alerts.orderBy.createdAt === "desc"
);

const itemRoute = readFileSync(join(ROOT, "app/api/inventory/items/[id]/route.ts"), "utf8");
check(
  "GET and PATCH of /api/inventory/items/[id] both read with the shared include",
  (itemRoute.match(/include:\s*INVENTORY_ITEM_DETAIL_INCLUDE/g) ?? []).length >= 2
);

// ---------------------------------------------------------------- ב5 resolve
const path = inventoryAlertResolvePath(42);
check("resolve path is /inventory/alerts/:id/resolve", path === "/inventory/alerts/42/resolve", path);

// Map the URL back to a handler file. Route groups such as (shell) are not part
// of the URL, so try every app/<group>/… candidate.
const segments = path.split("/").filter(Boolean).map((s) => (s === "42" ? "[id]" : s));
const candidates = [join(ROOT, "app", ...segments, "route.ts"), join(ROOT, "app", "(shell)", ...segments, "route.ts")];
const handler = candidates.find((file) => existsSync(file));
check("a route handler exists for the resolve path", Boolean(handler), handler ?? candidates.join(" | "));
check(
  "that handler exports PATCH (the method the client sends)",
  Boolean(handler) && /export\s+async\s+function\s+PATCH\b/.test(readFileSync(handler!, "utf8"))
);
check(
  "no stale /api/inventory/alerts/[id]/resolve URL is used by the client",
  !readFileSync(join(ROOT, "lib/api/inventory.ts"), "utf8").includes("/api/inventory/alerts/${")
);

// ---------------------------------------------------------------- ב7 sale total
const three = chargedSaleTotal([{ quantity: 3, rawPrice: "10" }]);
check("3 × ₪10 is ₪30, not ₪10", three.kind === "total" && three.cents === 3000, JSON.stringify(three));

const exact = chargedSaleTotal([{ quantity: 3, rawPrice: "19.90" }, { quantity: 1, rawPrice: "0.10" }]);
check("agorot are exact: 3 × 19.90 + 0.10 = 59.80", exact.kind === "total" && exact.cents === 5980, JSON.stringify(exact));

const blank = chargedSaleTotal([{ quantity: 2, rawPrice: "  " }, { quantity: 1, rawPrice: undefined }]);
check("blank prices stay absent (no total, not ₪0)", blank.kind === "none");

const zero = chargedSaleTotal([{ quantity: 5, rawPrice: "0" }]);
check("a typed 0 is a real zero price", zero.kind === "total" && zero.cents === 0 && zero.pricedLines === 1);

const mixed = chargedSaleTotal([{ quantity: 2, rawPrice: "12.5" }, { quantity: 4, rawPrice: "" }]);
check(
  "a priced and an unpriced line: only the priced line counts",
  mixed.kind === "total" && mixed.cents === 2500 && mixed.pricedLines === 1 && mixed.unpricedLines === 1
);

check("an invalid price invalidates the total", chargedSaleTotal([{ quantity: 1, rawPrice: "abc" }, { quantity: 1, rawPrice: "5" }]).kind === "invalid");
check("a negative price is invalid", chargedSaleTotal([{ quantity: 1, rawPrice: "-5" }]).kind === "invalid");

// ---------------------------------------------------------------- O1 sheet layer
// Inside the shell the page sits in a z-index:1 context; the BottomBar (z-100)
// and the accessibility button (z-101) are outside it. A sheet rendered inline
// is painted under both — so the product card portals its movement sheet to body.
const detail = readFileSync(join(ROOT, "components/inventory/product-detail-view.tsx"), "utf8");
const sheetAt = detail.indexOf("<MovementSheet");
const portalAt = detail.lastIndexOf("createPortal(", sheetAt);
const between = portalAt >= 0 ? detail.slice(portalAt, sheetAt) : "";
check(
  "the movement sheet is rendered through createPortal(…, document.body)",
  sheetAt > 0 && portalAt > 0 && !between.includes(") : null}") && detail.slice(sheetAt).includes("document.body")
);
check("the portaled movement sheet keeps the inventory style scope", between.includes("data-inventory-module"));

// ---------------------------------------------------------------- O1 keyboard
// iOS keeps the layout viewport at full height when the keyboard opens and shrinks
// only the visual viewport; the sheet must sit above the keyboard and fit what is visible.
check("no visualViewport → sheet keeps its CSS", keyboardSheetInset(844, null) === null);
check("keyboard closed (visual = layout) → no inset", keyboardSheetInset(844, { height: 844, offsetTop: 0 }) === null);
const kb = keyboardSheetInset(844, { height: 480, offsetTop: 0 });
check("keyboard of 364px lifts the sheet by 364 and caps it to 92% of the visible 480", kb?.bottom === 364 && kb?.maxHeight === 441, JSON.stringify(kb));
const panned = keyboardSheetInset(844, { height: 400, offsetTop: 40 });
check("a panned visual viewport (offsetTop) is accounted for", panned?.bottom === 404 && panned?.maxHeight === 368, JSON.stringify(panned));
check("sub-pixel rounding is not treated as a keyboard", keyboardSheetInset(844, { height: 843.6, offsetTop: 0 }) === null);
check("a nonsense viewport height is ignored", keyboardSheetInset(844, { height: 0, offsetTop: 0 }) === null);

const movementSheet = readFileSync(join(ROOT, "components/inventory/movement-sheet.tsx"), "utf8");
check(
  "the movement sheet follows visualViewport and passes the inset to its BottomSheet",
  movementSheet.includes("window.visualViewport") && movementSheet.includes("keyboardSheetInset(") && /sheetStyle=\{keyboard/.test(movementSheet)
);
const primitives = readFileSync(join(ROOT, "components/inventory/inventory-primitives.tsx"), "utf8");
check("BottomSheet applies an optional sheetStyle (absent for every other sheet)", /style=\{sheetStyle\}/.test(primitives));

console.log(`\n${total - failures}/${total} passed`);
if (failures > 0) process.exit(1);
