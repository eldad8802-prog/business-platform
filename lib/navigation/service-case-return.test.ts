/** Pure: `npx tsx lib/navigation/service-case-return.test.ts`. */
import { serviceCaseReturnPath } from "./service-case-return";

let passed = 0, failed = 0;
const ok = (n: string, c: boolean) => { if (c) passed++; else { failed++; console.log(`  [FAIL] ${n}`); } };
ok("a case path is accepted", serviceCaseReturnPath("/service-desk/cases/12") === "/service-desk/cases/12");
ok("anything else is refused", ["", "/service-desk/cases/0", "/service-desk/cases/12/intake", "//evil.example/service-desk/cases/1", "https://x/service-desk/cases/1",
  "/service-desk/cases/1?x=1", "/billing", "javascript:alert(1)", "/service-desk/cases/12345678901"].every((v) => serviceCaseReturnPath(v) === null) && serviceCaseReturnPath(null) === null);
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
