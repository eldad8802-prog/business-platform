/**
 * Service Desk storage keys — pure checks against the database's own CHECKs (migrations 20261112090000, 20261120090000).
 *   npx tsx lib/services/service-desk/storage/service-storage-keys.test.ts
 */
import fs from "node:fs";
import path from "node:path";

import { assertSafeListPrefix, isConditionalOnlyDomain, getRequiredVisibility } from "@/lib/storage";

import {
  INTAKE_PHOTO_MAX_BYTES,
  INTAKE_PHOTOS_PER_CASE,
  SERVICE_STORAGE_DOMAIN,
  intakePhotoKey,
  intakeSignatureKey,
  intakeSlipKey,
  isServiceKeyOfBusiness,
  serviceBusinessPrefix,
} from "./service-storage-keys";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
function throws(fn: () => unknown): boolean {
  try { fn(); return false; } catch { return true; }
}
const SHA = "a".repeat(64);

console.log("— 1. the business prefix");
check("prefix ends with the slash", serviceBusinessPrefix(1) === "biz/1/service/");
check("biz/1/ never covers biz/10/", !"biz/10/service/x".startsWith(serviceBusinessPrefix(1)));
check("a zero / negative / fractional business id is refused", throws(() => serviceBusinessPrefix(0)) && throws(() => serviceBusinessPrefix(-3)) && throws(() => serviceBusinessPrefix(1.5)));
check("the storage layer accepts the prefix as a list prefix", (() => { try { assertSafeListPrefix(serviceBusinessPrefix(42)); return true; } catch { return false; } })());
check("the domain is private and conditional-only", getRequiredVisibility(SERVICE_STORAGE_DOMAIN) === "private" && isConditionalOnlyDomain(SERVICE_STORAGE_DOMAIN));

console.log("— 2. keys of one business");
check("own key", isServiceKeyOfBusiness("biz/7/service/cases/3/intake/photos/x.jpg", 7));
check("another business's key", !isServiceKeyOfBusiness("biz/70/service/cases/3/x.jpg", 7));
check("another domain", !isServiceKeyOfBusiness("biz/7/business-docs/x.pdf", 7));
check("the bare prefix is not an object", !isServiceKeyOfBusiness("biz/7/service/", 7));
check("traversal / backslash / NUL refused", !isServiceKeyOfBusiness("biz/7/service/../8/service/x", 7)
  && !isServiceKeyOfBusiness("biz/7/service\\x", 7) && !isServiceKeyOfBusiness("biz/7/service/\0", 7));
check("longer than the 512 the database allows", !isServiceKeyOfBusiness(`biz/7/service/${"x".repeat(520)}`, 7));

console.log("— 3. intake photo keys = CHECK ServiceIntakePhoto_key");
check("jpeg", intakePhotoKey({ businessId: 9, caseId: 4, sha256: SHA, mimeType: "image/jpeg" }) === `biz/9/service/cases/4/intake/photos/${SHA}.jpg`);
check("png", intakePhotoKey({ businessId: 9, caseId: 4, sha256: SHA, mimeType: "image/png" }).endsWith(`${SHA}.png`));
check("webp", intakePhotoKey({ businessId: 9, caseId: 4, sha256: SHA, mimeType: "image/webp" }).endsWith(`${SHA}.webp`));
check("another type refused", throws(() => intakePhotoKey({ businessId: 9, caseId: 4, sha256: SHA, mimeType: "image/gif" })));
check("upper-case / short sha refused", throws(() => intakePhotoKey({ businessId: 9, caseId: 4, sha256: "A".repeat(64), mimeType: "image/png" }))
  && throws(() => intakePhotoKey({ businessId: 9, caseId: 4, sha256: "a".repeat(63), mimeType: "image/png" })));
check("a bad case id refused", throws(() => intakePhotoKey({ businessId: 9, caseId: 0, sha256: SHA, mimeType: "image/png" })));
check("every intake photo key is a key of its business", isServiceKeyOfBusiness(intakePhotoKey({ businessId: 9, caseId: 4, sha256: SHA, mimeType: "image/png" }), 9));

console.log("— 4. the limits are the database's");
const sql = fs.readFileSync(path.join(process.cwd(), "prisma/migrations/20261120090000_service_desk_ui_foundation/migration.sql"), "utf8");
check("CHECK ServiceIntakePhoto_size = 1..10485760", sql.includes(`"byteSize" BETWEEN 1 AND ${INTAKE_PHOTO_MAX_BYTES}`));
check("the key CHECK maps jpeg/png/else→webp", sql.includes(`WHEN 'image/jpeg' THEN '.jpg' WHEN 'image/png' THEN '.png' ELSE '.webp'`));
check(`the guard caps photos per case at ${INTAKE_PHOTOS_PER_CASE}`, new RegExp(`>=\\s*${INTAKE_PHOTOS_PER_CASE}\\b`).test(sql));

console.log("— 1.3b: the intake signature and slip");
check("signature key: biz/{b}/service/cases/{c}/intake/signature/{sha}.png", intakeSignatureKey({ businessId: 7, caseId: 3, sha256: SHA }) === `biz/7/service/cases/3/intake/signature/${SHA}.png`);
check("slip key: biz/{b}/service/cases/{c}/intake/slip/{sha}.pdf", intakeSlipKey({ businessId: 7, caseId: 3, sha256: SHA }) === `biz/7/service/cases/3/intake/slip/${SHA}.pdf`);
check("signature / slip keys are this business's service keys (the intake object-key CHECK prefix), never another's",
  isServiceKeyOfBusiness(intakeSignatureKey({ businessId: 7, caseId: 3, sha256: SHA }), 7) && isServiceKeyOfBusiness(intakeSlipKey({ businessId: 7, caseId: 3, sha256: SHA }), 7)
    && !isServiceKeyOfBusiness(intakeSlipKey({ businessId: 7, caseId: 3, sha256: SHA }), 70));
check("signature / slip keys refuse a bad hash or id",
  throws(() => intakeSignatureKey({ businessId: 7, caseId: 3, sha256: "A".repeat(64) })) && throws(() => intakeSlipKey({ businessId: 7, caseId: 0, sha256: SHA }))
    && throws(() => intakeSignatureKey({ businessId: 0, caseId: 3, sha256: SHA })));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
