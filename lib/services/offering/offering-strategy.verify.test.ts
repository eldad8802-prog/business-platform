import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { projectProduct, projectService, type OfferingView } from "./offering-projection";

const money = (value: string) => new Prisma.Decimal(value);

function service(partial: Partial<Parameters<typeof projectService>[0]>): OfferingView {
  return projectService({
    id: partial.id ?? 1,
    businessId: 1,
    name: partial.name ?? "service",
    description: partial.description ?? null,
    priceMode: partial.priceMode ?? null,
    priceAmount: partial.priceAmount ?? null,
    priceMax: partial.priceMax ?? null,
    categoryLabel: partial.categoryLabel ?? null,
    active: partial.active ?? true,
    featuredByOwner: partial.featuredByOwner ?? false,
    durationMinutes: partial.durationMinutes ?? null,
    fulfillment: partial.fulfillment ?? "UNSPECIFIED",
    assetLinks: partial.assetLinks,
  });
}

function product(partial: Partial<Parameters<typeof projectProduct>[0]>): OfferingView {
  return projectProduct({
    id: partial.id ?? 1,
    businessId: 1,
    name: partial.name ?? "product",
    description: partial.description ?? null,
    sellPricePerUnit: partial.sellPricePerUnit ?? null,
    isActive: partial.isActive ?? true,
    featuredByOwner: partial.featuredByOwner ?? false,
    currentQuantity: partial.currentQuantity ?? 0,
    category: partial.category,
    assetLinks: partial.assetLinks,
  });
}

const retail = [
  product({ id: 1, name: "מעיל", sellPricePerUnit: 399, featuredByOwner: true, currentQuantity: 4, category: { name: "חורף" }, description: "צמר" }),
  product({ id: 2, name: "כובע", sellPricePerUnit: 79, category: { name: "חורף" }, description: "כותנה" }),
  product({ id: 3, name: "תיק", sellPricePerUnit: 149, category: { name: "אביזרים" }, description: "עור" }),
];
assert.equal(retail.filter((row) => row.featuredByOwner && row.priceMode === "FIXED").length, 1);
assert.equal(new Set(retail.map((row) => row.category)).size, 2);
assert.ok(retail.every((row) => row.kind === "PRODUCT" && row.durationMinutes === null));

const beauty = [
  service({ id: 1, name: "תספורת", priceMode: "FIXED", priceAmount: money("80"), categoryLabel: "שיער", durationMinutes: 45, fulfillment: "AT_BUSINESS", featuredByOwner: true }),
  service({ id: 2, name: "צבע", priceMode: "FROM", priceAmount: money("250"), categoryLabel: "שיער", durationMinutes: 90, fulfillment: "AT_BUSINESS" }),
  service({ id: 3, name: "ייעוץ תדמית", priceMode: "QUOTE_REQUIRED", categoryLabel: "ייעוץ", fulfillment: "AT_BUSINESS" }),
];
assert.notEqual(beauty[0].durationMinutes, null);
assert.equal(beauty.filter((row) => row.priceMode === "QUOTE_REQUIRED").length, 1);
assert.equal(beauty.filter((row) => row.featuredByOwner).length, 1);

const field = [
  service({ id: 1, name: "קריאת חירום", priceMode: "NO_PUBLIC_PRICE", categoryLabel: "חירום", fulfillment: "AT_CUSTOMER", featuredByOwner: true }),
  service({ id: 2, name: "התקנת מזגן", priceMode: "FROM", priceAmount: money("350"), categoryLabel: "התקנה", fulfillment: "AT_CUSTOMER" }),
  service({ id: 3, name: "תחזוקה", priceMode: "RANGE", priceAmount: money("200"), priceMax: money("600"), categoryLabel: "תחזוקה", fulfillment: "AT_CUSTOMER" }),
];
assert.ok(field.every((row) => row.fulfillment === "AT_CUSTOMER"));
assert.equal(field.filter((row) => row.priceMode === "NO_PUBLIC_PRICE").length, 1);

const restaurant = [
  product({ id: 1, name: "המבורגר", sellPricePerUnit: 62, category: { name: "עיקרית" }, description: "200 גרם", featuredByOwner: true }),
  product({ id: 2, name: "סלט", sellPricePerUnit: 38, category: { name: "ראשונות" }, description: "עונתי" }),
  service({ id: 3, name: "קייטרינג", priceMode: "QUOTE_REQUIRED", categoryLabel: "אירוע", fulfillment: "AT_CUSTOMER" }),
];
assert.equal(restaurant.filter((row) => row.kind === "PRODUCT").length, 2);
assert.equal(restaurant.filter((row) => row.kind === "SERVICE").length, 1);

const professional = [
  service({ id: 1, name: "נדל״ן", priceMode: "QUOTE_REQUIRED", categoryLabel: "משפט", fulfillment: "ONLINE" }),
  service({ id: 2, name: "חוזים", priceMode: "NO_PUBLIC_PRICE", categoryLabel: "משפט", fulfillment: "ONLINE" }),
  service({ id: 3, name: "שיחת היכרות", priceMode: "FIXED", priceAmount: money("0"), categoryLabel: "פגישה", durationMinutes: 30, fulfillment: "ONLINE", featuredByOwner: true }),
];
assert.equal(professional.filter((row) => row.priceAmount !== null).length, 1);
assert.ok(professional.some((row) => row.durationMinutes === null));

const hybrid = [
  service({ id: 1, name: "פן", priceMode: "FIXED", priceAmount: money("70"), categoryLabel: "שיער", durationMinutes: 20, fulfillment: "AT_BUSINESS", featuredByOwner: true }),
  product({ id: 9, name: "שמפו", sellPricePerUnit: 48, category: { name: "מוצרים" }, description: "ללא מלחים", featuredByOwner: true }),
];
assert.deepEqual(hybrid.map((row) => row.kind).sort(), ["PRODUCT", "SERVICE"]);
assert.equal(hybrid[0].stockQuantity, null);
assert.equal(hybrid[1].durationMinutes, null);

console.log("offering strategy fixtures: all checks passed");
