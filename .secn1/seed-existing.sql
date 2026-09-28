-- SEC N-1 lab: rows that exist in the five P0 tables BEFORE the N-1 migration runs,
-- for two tenants (n1-A, n1-B). Written as the owner, as Production's writers did.
-- Parent rows (Business, InventoryItem, InventoryMovement, ContentRun, Offer, Coupon)
-- are the minimum the composite foreign keys need.
DO $seed$
DECLARE
  t text;
  biz int;
  item int;
  mv int;
  run int;
  offer int;
  coupon int;
  sale int;
  line int;
BEGIN
  FOREACH t IN ARRAY ARRAY['n1-A', 'n1-B'] LOOP
    INSERT INTO "Business" ("name", "updatedAt") VALUES (t, now()) RETURNING "id" INTO biz;

    INSERT INTO "InventoryItem" ("businessId", "name", "unitType", "currentQuantity", "updatedAt")
    VALUES (biz, t || ' item', 'UNIT', 100, now()) RETURNING "id" INTO item;

    INSERT INTO "InventoryMovement" ("businessId", "itemId", "movementType", "reason", "quantityDelta", "quantityBefore", "quantityAfter")
    VALUES (biz, item, 'OUT', 'SALE', -1, 101, 100) RETURNING "id" INTO mv;

    INSERT INTO "InventorySale" ("businessId", "source", "externalSaleId", "idempotencyKey")
    VALUES (biz, 'POS', t || '-ext-1', NULL) RETURNING "id" INTO sale;

    INSERT INTO "InventorySaleLine" ("businessId", "saleId", "itemId", "movementId", "lineKey", "quantity", "unitPrice")
    VALUES (biz, sale, item, mv, '0', 1, 12.50) RETURNING "id" INTO line;

    INSERT INTO "InventorySourceSaleLine" ("businessId", "externalSaleId", "lineKey", "sku", "quantity", "unitPrice", "recognizedItemId", "saleLineId")
    VALUES (biz, t || '-ext-1', '0', 'SKU-' || t, 1, 12.50, item, line);

    INSERT INTO "ContentRun" ("businessId", "status", "inputSnapshot", "updatedAt")
    VALUES (biz, 'FAILED', '{}'::jsonb, now()) RETURNING "id" INTO run;

    INSERT INTO "BusinessAsset" ("businessId", "origin", "storageKey", "assetRef", "contentRunId", "idempotencyKey")
    VALUES (biz, 'OWNER_UPLOAD', 'content/' || t || '/existing.png', NULL, run, t || '-asset-existing');

    INSERT INTO "Offer" ("issuingBusinessId", "title", "customerBenefitText", "validUntil", "updatedAt")
    VALUES (biz, t || ' offer', '10% off', now() + interval '30 days', now()) RETURNING "id" INTO offer;

    INSERT INTO "Coupon" ("offerId", "issuingBusinessId", "token", "qrValue", "expiresAt", "updatedAt", "publicId")
    VALUES (offer, biz, t || '-tok', t || '-qr', now() + interval '30 days', now(), gen_random_uuid()) RETURNING "id" INTO coupon;

    INSERT INTO "CouponSurfaceEvent" ("issuingBusinessId", "couponId", "offerId", "eventType")
    VALUES (biz, coupon, offer, 'PUBLIC_DETAIL_SERVED');
  END LOOP;
END
$seed$;
