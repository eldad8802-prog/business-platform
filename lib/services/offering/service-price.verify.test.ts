import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { projectProduct, projectService } from "./offering-projection";
import { normalizeServicePrice, ServicePriceError } from "./service-price";

function throws(fn: () => unknown) {
  try {
    fn();
    return false;
  } catch (error) {
    return error instanceof ServicePriceError;
  }
}

assert.equal(normalizeServicePrice({ priceMode: "FIXED", priceAmount: 0 }).priceAmount?.toFixed(2), "0.00");
assert.equal(throws(() => normalizeServicePrice({ priceMode: "QUOTE_REQUIRED", priceAmount: 0 })), true);
assert.equal(throws(() => normalizeServicePrice({ priceMode: "NO_PUBLIC_PRICE", priceAmount: 0 })), true);
assert.equal(throws(() => normalizeServicePrice({ priceMode: "FIXED" })), true);
assert.equal(
  normalizeServicePrice({ priceMode: "RANGE", priceAmount: "80", priceMax: "120" }).priceMax?.equals(
    new Prisma.Decimal("120")
  ),
  true
);
assert.equal(throws(() => normalizeServicePrice({ priceMode: "RANGE", priceAmount: 100, priceMax: 40 })), true);

const legacy = projectService({
  id: 1,
  businessId: 9,
  name: "ייעוץ",
  description: null,
  priceMode: null,
  priceAmount: null,
  priceMax: null,
  categoryLabel: "משפט",
  active: true,
  featuredByOwner: false,
  durationMinutes: null,
  fulfillment: "UNSPECIFIED",
});
assert.equal(legacy.kind, "SERVICE");
assert.equal(legacy.priceMode, null);
assert.equal(legacy.priceAmount, null);
assert.equal(legacy.durationMinutes, null);

const free = projectProduct({
  id: 2,
  businessId: 9,
  name: "דוגמית",
  description: null,
  sellPricePerUnit: 0,
  isActive: true,
  featuredByOwner: true,
  currentQuantity: 3,
});
assert.equal(free.kind, "PRODUCT");
assert.equal(free.priceMode, "FIXED");
assert.equal(free.priceAmount, "0.00");
assert.equal(free.featuredByOwner, true);
assert.equal(free.durationMinutes, null);

const unknown = projectProduct({
  id: 3,
  businessId: 9,
  name: "בלי מחיר",
  description: null,
  sellPricePerUnit: null,
  isActive: true,
  featuredByOwner: false,
  currentQuantity: 1,
});
assert.equal(unknown.priceMode, null);
assert.equal(unknown.priceAmount, null);

console.log("offering price and projection: all checks passed");
