/**
 * Header synonyms, per domain.
 *
 * # The rule for adding one
 *
 * An alias earns its place when a real competing system, or a real Israeli
 * business, would plausibly label the column that way — and when it cannot
 * reasonably mean a DIFFERENT field in the same domain. "It sounds related" is
 * not enough: a wrong mapping silently writes the right value into the wrong
 * column, which is worse than asking the owner.
 *
 * Aliases are scoped per domain, so "שם" meaning the item name in Inventory
 * cannot collide with "שם" meaning the customer name in Customers. Within a
 * domain, a header that matches two fields is reported as AMBIGUOUS and the
 * owner decides — it is never silently resolved.
 *
 * # Deliberate omissions
 *
 *  - "עוסק מורשה" is NOT an alias for the supplier tax-id column: it is a VALUE
 *    of "סוג עוסק". A file with a "עוסק מורשה" column almost certainly means
 *    the type, not the number.
 *  - bare "code" is NOT an alias for מק״ט: in an inventory file it is at least
 *    as likely to mean the barcode.
 *  - bare "amount"/"total" are absent everywhere: they could mean cost, price,
 *    or quantity depending on the exporter.
 *
 * Kept in its own module rather than inline in the export descriptors: this is
 * IMPORT vocabulary, it will keep growing as real files arrive, and the
 * descriptors should stay readable as the field contract.
 */

import type { DataTransferDomainId } from "@/lib/data-transfer/domains";

/** Canonical Hebrew header -> accepted synonyms. */
export type DomainAliasMap = Record<string, readonly string[]>;

const CUSTOMERS: DomainAliasMap = {
  שם: ["שם לקוח", "שם הלקוח", "לקוח", "שם מלא", "name", "full name", "customer", "customer name", "client", "client name"],
  טלפון: ["נייד", "טלפון נייד", "מספר טלפון", "phone", "phone number", "mobile", "telephone", "tel", "cell"],
  אימייל: ['דוא"ל', "דואר אלקטרוני", "מייל", "email", "e-mail", "mail", "email address"],
  עיר: ["יישוב", "ישוב", "city", "town"],
  הערות: ["הערה", "notes", "note", "comment", "comments", "remarks"],
};

const SUPPLIERS: DomainAliasMap = {
  "שם ספק": ["ספק", "שם הספק", "supplier", "supplier name", "vendor", "vendor name"],
  "שם משפטי": ["שם חברה", "legal name", "company name", "registered name"],
  "סוג עוסק": ["סוג עסק", "סוג ישות", "entity type", "business type"],
  "מספר עוסק / ח.פ.": ["ח.פ.", "חפ", "ע.מ.", "מספר עוסק", "מספר ח.פ.", "tax id", "vat number", "business number", "company number"],
  תחום: ["תחום עיסוק", "קטגוריה", "category", "sector", "industry"],
  טלפון: ["טלפון ספק", "מספר טלפון", "phone", "phone number", "telephone", "tel"],
  אימייל: ['דוא"ל', "מייל", "email", "e-mail", "mail"],
  אתר: ["אתר אינטרנט", "website", "web", "url"],
  "איש קשר": ["שם איש קשר", "contact", "contact name", "contact person"],
  "תפקיד איש קשר": ["תפקיד", "contact role", "role", "title"],
  "טלפון איש קשר": ["נייד איש קשר", "contact phone", "contact mobile"],
  "אימייל איש קשר": ["מייל איש קשר", "contact email"],
  רחוב: ["כתובת", "address", "street"],
  עיר: ["יישוב", "ישוב", "city", "town"],
  מיקוד: ["zip", "zip code", "postal code", "postcode"],
  "ימי תשלום": ["תנאי תשלום", "שוטף", "payment terms", "terms", "payment days"],
  "אמצעי תשלום מועדף": ["אמצעי תשלום", "payment method", "preferred payment"],
  "ימי אספקה": ["זמן אספקה", "ימי הספקה", "lead time", "delivery days", "supply days"],
  הערות: ["הערה", "notes", "note", "comment", "comments", "remarks"],
};

const LEADS: DomainAliasMap = {
  שם: ["שם הפונה", "שם מלא", "לקוח", "פונה", "name", "full name", "lead", "lead name", "contact", "contact name"],
  טלפון: ["נייד", "טלפון נייד", "מספר טלפון", "phone", "phone number", "mobile", "telephone", "tel", "cell"],
  אימייל: ['דוא"ל', "מייל", "email", "e-mail", "mail"],
  "מקור הפנייה": ["מקור", "ערוץ", "source", "lead source", "channel", "origin"],
  "מה ביקשו": ["בקשה", "פנייה", "תיאור", "הערות", "message", "request", "inquiry", "description"],
};

const INVENTORY: DomainAliasMap = {
  "שם פריט": ["שם", "מוצר", "שם מוצר", "פריט", "name", "item", "item name", "product", "product name", "description"],
  "מק״ט": ["מקט", 'מק"ט', "מספר קטלוגי", "sku", "item code", "product code", "catalog number"],
  ברקוד: ["בר קוד", "barcode", "bar code", "ean", "upc", "gtin"],
  "יחידת מידה": ["יחידה", 'יח"מ', "יחמ", "unit", "uom", "unit of measure", "measure"],
  ספק: ["שם ספק", "supplier", "vendor"],
  "כמות במלאי": ["כמות", "מלאי", "quantity", "qty", "stock", "on hand", "in stock"],
  "כמות מינימום": ["מינימום", "כמות מזערית", "מלאי מינימלי", "min", "minimum", "min quantity", "min stock"],
  "נקודת הזמנה": ["נקודת הזמנה מחדש", "reorder point", "reorder", "reorder level"],
  "עלות ליחידה": ["עלות", "מחיר עלות", "מחיר קנייה", "cost", "unit cost", "cost price", "purchase price"],
  "מחיר מכירה": ["מחיר", "מחיר לצרכן", "price", "sale price", "selling price", "retail price"],
};

const BY_DOMAIN: Partial<Record<DataTransferDomainId, DomainAliasMap>> = {
  customers: CUSTOMERS,
  suppliers: SUPPLIERS,
  leads: LEADS,
  inventory: INVENTORY,
};

/** Synonyms for one canonical header in one domain. Empty when none. */
export function aliasesFor(
  domainId: DataTransferDomainId,
  header: string
): readonly string[] {
  return BY_DOMAIN[domainId]?.[header] ?? [];
}

/** The whole alias map for a domain. Empty for domains without templates. */
export function domainAliasMap(domainId: DataTransferDomainId): DomainAliasMap {
  return BY_DOMAIN[domainId] ?? {};
}
