const fs = require("fs");
function patch(file, edits) {
  let s = fs.readFileSync(file, "utf8");
  const nl = s.includes("\r\n") ? "\r\n" : "\n";
  for (let [from, to] of edits) {
    from = from.split("\n").join(nl); to = to.split("\n").join(nl);
    if (!s.includes(from)) { console.error("MISS in " + file + ": " + JSON.stringify(from.slice(0, 70))); process.exit(1); }
    s = s.replace(from, to);
  }
  fs.writeFileSync(file, s);
  console.log("patched " + file);
}

const DBSTEP = `import type { Prisma } from "@prisma/client";
import { getTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

// D2/P7-W4D: reads of FORCE-RLS'd tables run on a short tenant transaction
// when a tenant context is established; outside a context they read directly
// (unit tests). Under context there is NO fallback to the global client.
async function dbStep<T>(fn: (db: typeof prisma) => Promise<T>): Promise<T> {
  if (getTenantContext() !== undefined) {
    return withTenantTransaction((tx) => fn(tx as unknown as typeof prisma));
  }
  return fn(prisma);
}`;

// pending-review: two reads.
patch("lib/documents/pending-review.ts", [
  [`import { prisma } from "@/lib/prisma";`,
   `import { prisma } from "@/lib/prisma";
${DBSTEP}`],
  [`export function countPendingReviewAllTime(businessId: number): Promise<number> {
  return prisma.document.count({ where: pendingReviewWhere(businessId) });
}`,
   `export function countPendingReviewAllTime(businessId: number): Promise<number> {
  return dbStep((db) => db.document.count({ where: pendingReviewWhere(businessId) }));
}`],
  [`  const rows = await prisma.document.findMany({
    where: pendingReviewWhere(businessId),
    select: { createdAt: true },
  });`,
   `  const rows = await dbStep((db) => db.document.findMany({
    where: pendingReviewWhere(businessId),
    select: { createdAt: true },
  }));`],
]);

// loaders: the Document read joins the existing dbStep helper.
patch("lib/business-status/loaders.ts", [
  [`  const docs = await prisma.document.findMany({`,
   `  const docs = await dbStep((db) => db.document.findMany({`],
]);
{
  const f = "lib/business-status/loaders.ts";
  let s = fs.readFileSync(f, "utf8");
  const m = s.match(/const docs = await dbStep\(\(db\) => db\.document\.findMany\(\{[\s\S]*?\n(\s*)\}\);/);
  if (!m) { console.error("MISS loaders close"); process.exit(1); }
  s = s.replace(m[0], m[0].replace(/\}\);$/, "}));"));
  fs.writeFileSync(f, s);
  console.log("closed loaders doc read");
}

// learning-center: migrate ALL reads (incl. raw) to the sanctioned admin client.
{
  const f = "lib/services/learning-center/learning-center-data.ts";
  let s = fs.readFileSync(f, "utf8");
  const nl = s.includes("\r\n") ? "\r\n" : "\n";
  if (!s.includes('import { prisma } from "@/lib/prisma";')) { console.error("MISS lc import"); process.exit(1); }
  s = s.replace('import { prisma } from "@/lib/prisma";',
    '// D2/P7-W4D: learning-center is a cross-tenant platform-admin analytics' + nl +
    '// surface. Under FORCE RLS its unscoped reads would silently return zero on' + nl +
    '// the tenant client, so ALL reads run on the sanctioned admin client' + nl +
    '// (read-only via p7adm_read policies; the admin role has no write grants).' + nl +
    'import { getPrismaAdmin } from "@/lib/prisma-admin";' + nl + nl +
    'const prisma = getPrismaAdmin();');
  fs.writeFileSync(f, s);
  console.log("learning-center on admin client");
}

// vendor-learning.service: proven dead (0 importers) — delete.
fs.unlinkSync("lib/services/documents/vendor-learning.service.ts");
console.log("deleted dead vendor-learning.service.ts");
