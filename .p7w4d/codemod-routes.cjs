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
const IMP = `import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";`;

// Wrap expression `prisma.X(...)` (no await prefix needed) with a wrapper fn.
function wrapCalls(file, callStarts, opener, closer) {
  let s = fs.readFileSync(file, "utf8");
  for (const c of callStarts) {
    const start = s.indexOf(c);
    if (start === -1) { console.error("MISS call in " + file + ": " + c.slice(0, 60)); process.exit(1); }
    const parenIdx = s.indexOf("(", start + c.length - 1);
    let depth = 0, i = parenIdx;
    for (; i < s.length; i++) {
      if (s[i] === "(") depth++;
      else if (s[i] === ")") { depth--; if (depth === 0) break; }
    }
    const orig = s.slice(start, i + 1);
    const wrapped = opener + orig.replace(/^prisma\./, "db.") + closer;
    s = s.slice(0, start) + wrapped + s.slice(i + 1);
  }
  fs.writeFileSync(file, s);
  console.log("wrapped " + callStarts.length + " calls in " + file);
}

const DBSTEP_ROUTE = `
// D2/P7-W4D: each read runs on its own short tenant transaction (independent
// transactions may run concurrently — never one shared interactive tx).
async function dbStep<T>(fn: (db: typeof prisma) => Promise<T>): Promise<T> {
  return withTenantTransaction((tx) => fn(tx as unknown as typeof prisma));
}`;

// ── upload: dedup read + create under tenant tx ──
patch("app/api/documents/upload/route.ts", [
  [`import { runTenantJob } from "@/lib/tenant/job";`,
   `import { runTenantJob } from "@/lib/tenant/job";
${IMP}`],
  [`      const existing = await prisma.document.findFirst({`,
   `      const existing = await runWithTenantContext(
        { businessId: user.businessId },
        () =>
          withTenantTransaction((tx) => tx.document.findFirst({`],
  [`          financialRecord: {
            select: { vendorName: true, amount: true, date: true },
          },
        },
      });`,
   `          financialRecord: {
            select: { vendorName: true, amount: true, date: true },
          },
        },
          }))
      );`],
  [`    const document = await prisma.document.create({`,
   `    const document = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction((tx) => tx.document.create({`],
]);
{
  // close the create call: find its end `});` right after the data object.
  const f = "app/api/documents/upload/route.ts";
  let s = fs.readFileSync(f, "utf8");
  const start = s.indexOf("withTenantTransaction((tx) => tx.document.create({");
  const seg = s.slice(start);
  const m = seg.match(/\n(\s*)\}\);/);
  if (!m) { console.error("MISS upload create close"); process.exit(1); }
  const idx = start + seg.indexOf(m[0]);
  s = s.slice(0, idx) + m[0].replace("});", "}))\n    );") + s.slice(idx + m[0].length);
  fs.writeFileSync(f, s);
  console.log("closed upload create");
}

// ── process: read + 2 updates tenant-scoped ──
patch("app/api/documents/[id]/process/route.ts", [
  [`import { runTenantJob } from "@/lib/tenant/job";`,
   `import { runTenantJob } from "@/lib/tenant/job";
${IMP}`],
  [`    const document = await prisma.document.findUnique({
      where: { id },`,
   `    const document = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction((tx) => tx.document.findFirst({
          where: { id, businessId: user.businessId },`],
]);
{
  const f = "app/api/documents/[id]/process/route.ts";
  let s = fs.readFileSync(f, "utf8");
  const start = s.indexOf("withTenantTransaction((tx) => tx.document.findFirst({");
  const seg = s.slice(start);
  const m = seg.match(/\n(\s*)\}\);/);
  if (!m) { console.error("MISS process read close"); process.exit(1); }
  const idx = start + seg.indexOf(m[0]);
  s = s.slice(0, idx) + m[0].replace("});", "}))\n    );") + s.slice(idx + m[0].length);
  // the two status updates
  s = s.replace(/await prisma\.document\.update\(\{\s*\r?\n\s*where: \{ id \},\s*\r?\n\s*data: \{ status: "failed" \},\s*\r?\n\s*\}\);/,
    'await runWithTenantContext({ businessId: user.businessId }, () =>\n        withTenantTransaction((tx) =>\n          tx.document.updateMany({\n            where: { id, businessId: user.businessId },\n            data: { status: "failed" },\n          })\n        )\n      );');
  s = s.replace(/await prisma\.document\.update\(\{\s*\r?\n\s*where: \{ id \},\s*\r?\n\s*data: \{ status: "processing" \},\s*\r?\n\s*\}\);/,
    'await runWithTenantContext({ businessId: user.businessId }, () =>\n      withTenantTransaction((tx) =>\n        tx.document.updateMany({\n          where: { id, businessId: user.businessId },\n          data: { status: "processing" },\n        })\n      )\n    );');
  fs.writeFileSync(f, s);
  console.log("patched process updates");
}

// ── [id] GET + file GET: tenant-scoped reads ──
for (const f of ["app/api/documents/[id]/route.ts", "app/api/documents/[id]/file/route.ts"]) {
  let s = fs.readFileSync(f, "utf8");
  const nl = s.includes("\r\n") ? "\r\n" : "\n";
  s = s.replace('import { getCurrentUser } from "@/lib/auth";',
    'import { getCurrentUser } from "@/lib/auth";' + nl + IMP.split("\n").join(nl));
  const start = s.indexOf("await prisma.document.findUnique({");
  if (start === -1) { console.error("MISS read in " + f); process.exit(1); }
  const parenIdx = s.indexOf("(", start + "await prisma.document.findUnique".length - 1);
  let depth = 0, i = parenIdx;
  for (; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") { depth--; if (depth === 0) break; }
  }
  const orig = s.slice(start, i + 1);
  const wrapped = "await runWithTenantContext({ businessId: user.businessId }, () => withTenantTransaction((tx) => " +
    orig.replace("await prisma.document.findUnique", "tx.document.findUnique") + "))";
  s = s.slice(0, start) + wrapped + s.slice(i + 1);
  fs.writeFileSync(f, s);
  console.log("patched " + f);
}

// ── inbox: rWTC wrap + per-read short txs (Promise.all of independent txs) ──
{
  const f = "app/api/documents/inbox/route.ts";
  let s = fs.readFileSync(f, "utf8");
  const nl = s.includes("\r\n") ? "\r\n" : "\n";
  s = s.replace('import { getCurrentUser } from "@/lib/auth";',
    'import { getCurrentUser } from "@/lib/auth";' + nl + IMP.split("\n").join(nl) + nl + DBSTEP_ROUTE.split("\n").join(nl));
  fs.writeFileSync(f, s);
}
wrapCalls("app/api/documents/inbox/route.ts",
  [
    "prisma.financialRecord.aggregate", "prisma.financialRecord.aggregate",
    "prisma.financialRecord.count", "prisma.document.count", "prisma.document.count",
    "prisma.document.findFirst",
    "prisma.financialRecord.aggregate", "prisma.financialRecord.aggregate",
    "prisma.document.count", "prisma.document.count",
    "prisma.document.findFirst", "prisma.financialRecord.aggregate",
    "prisma.financialRecord.aggregate", "prisma.financialRecord.count",
  ].filter((v, idx, arr) => true),
  "dbStep((db) => ", ")");

// ── export / summary / search: single reads under tenant tx ──
for (const [f, call] of [
  ["app/api/reports/export/route.ts", "await prisma.financialRecord.findMany"],
  ["app/api/reports/summary/route.ts", "await prisma.financialRecord.findMany"],
  ["app/api/search/route.ts", "await prisma.financialRecord.findMany"],
]) {
  let s = fs.readFileSync(f, "utf8");
  const nl = s.includes("\r\n") ? "\r\n" : "\n";
  s = s.replace('import { getCurrentUser } from "@/lib/auth";',
    'import { getCurrentUser } from "@/lib/auth";' + nl + IMP.split("\n").join(nl));
  const start = s.indexOf(call);
  if (start === -1) { console.error("MISS in " + f); process.exit(1); }
  const parenIdx = s.indexOf("(", start + call.length - 1);
  let depth = 0, i = parenIdx;
  for (; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") { depth--; if (depth === 0) break; }
  }
  const orig = s.slice(start, i + 1);
  const wrapped = "await runWithTenantContext({ businessId: user.businessId }, () => withTenantTransaction((tx) => " +
    orig.replace("await prisma.", "tx.") + "))";
  s = s.slice(0, start) + wrapped + s.slice(i + 1);
  fs.writeFileSync(f, s);
  console.log("patched " + f);
}

// ── gmail import: bare document.create onto the tenant tx ──
{
  const f = "app/api/integrations/gmail/import/route.ts";
  let s = fs.readFileSync(f, "utf8");
  const call = "await prisma.document.create";
  const start = s.indexOf(call);
  if (start === -1) { console.error("MISS gmail bare create"); process.exit(1); }
  const parenIdx = s.indexOf("(", start + call.length - 1);
  let depth = 0, i = parenIdx;
  for (; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") { depth--; if (depth === 0) break; }
  }
  const orig = s.slice(start, i + 1);
  const wrapped = "await withTenantTransaction((tx) => " + orig.replace("await prisma.", "tx.") + ")";
  s = s.slice(0, start) + wrapped + s.slice(i + 1);
  fs.writeFileSync(f, s);
  console.log("patched gmail bare create");
}

// ── approve: initial read under tenant tx; vendor learning post-commit on wTT ──
patch("app/api/documents/[id]/approve/route.ts", [
  [`import { runTenantJob } from "@/lib/tenant/job";`,
   `import { runTenantJob } from "@/lib/tenant/job";
import { runWithTenantContext } from "@/lib/tenant/context";`],
  [`    const document = await prisma.document.findUnique({
      where: { id: documentId },
      include: { extractedData: true },
    });

    if (!document) {
      return Response.json({ error: "המסמך לא נמצא" }, { status: 404 });
    }

    if (document.businessId !== user.businessId) {
      return Response.json({ error: "אין הרשאה" }, { status: 403 });
    }`,
   `    const document = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction((tx) =>
          tx.document.findFirst({
            where: { id: documentId, businessId: user.businessId },
            include: { extractedData: true },
          })
        )
    );

    if (!document) {
      return Response.json({ error: "המסמך לא נמצא" }, { status: 404 });
    }`],
  [`        await prisma.vendorLearning.upsert({`,
   `        await runWithTenantContext({ businessId: user.businessId }, () =>
          withTenantTransaction((tx) => tx.vendorLearning.upsert({`],
  [`            isGlobal: false,
          },
        });
      } catch (vendorLearningError) {`,
   `            isGlobal: false,
          },
          }))
        );
      } catch (vendorLearningError) {`],
]);

// approve: the output-profile resolver + duplicate-signals run before the tx —
// give them tenant context so their dbSteps engage.
patch("app/api/documents/[id]/approve/route.ts", [
  [`    const profile = await resolveDocumentOutputProfile({`,
   `    const profile = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        resolveDocumentOutputProfile({`],
  [`      allowUnified: false, // IMPORTANT: approve must never run unified
      debug: false,
    });`,
   `      allowUnified: false, // IMPORTANT: approve must never run unified
      debug: false,
        })
    );`],
]);
