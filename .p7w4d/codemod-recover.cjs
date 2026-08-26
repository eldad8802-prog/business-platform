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
const DBSTEP = `import type { Prisma } from "@prisma/client";
import { getTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

// D2/P7-W4D: ctx-aware short tenant tx per DB step (no global fallback under
// an established context; direct reads only for context-less unit tests).
async function dbStep<T>(fn: (db: typeof prisma) => Promise<T>): Promise<T> {
  if (getTenantContext() !== undefined) {
    return withTenantTransaction((tx) => fn(tx as unknown as typeof prisma));
  }
  return fn(prisma);
}`;

function wrapAwaitCall(file, call, opener, closer, replPrefix) {
  let s = fs.readFileSync(file, "utf8");
  const start = s.indexOf(call);
  if (start === -1) { console.error("MISS call in " + file + ": " + call.slice(0, 50)); process.exit(1); }
  const parenIdx = s.indexOf("(", start + call.length - 1);
  let depth = 0, i = parenIdx;
  for (; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") { depth--; if (depth === 0) break; }
  }
  const orig = s.slice(start, i + 1);
  const wrapped = opener + orig.replace(call, replPrefix) + closer;
  s = s.slice(0, start) + wrapped + s.slice(i + 1);
  fs.writeFileSync(file, s);
  console.log("wrapped in " + file);
}

// 1. accountant-export-zip: add dbStep (the earlier run never reached it).
{
  const f = "lib/reports/accountant-export-zip.ts";
  let s = fs.readFileSync(f, "utf8");
  const nl = s.includes("\r\n") ? "\r\n" : "\n";
  if (!s.includes("async function dbStep")) {
    if (!s.includes('import { prisma } from "@/lib/prisma";')) { console.error("MISS prisma import zip"); process.exit(1); }
    s = s.replace('import { prisma } from "@/lib/prisma";',
      'import { prisma } from "@/lib/prisma";' + nl + DBSTEP.split("\n").join(nl));
    fs.writeFileSync(f, s);
    console.log("dbStep added to " + f);
  }
}

// 2. evidence readers (flag-gated business-memory reads).
for (const [f, call] of [
  ["lib/business-memory/evidence/extraction-snapshot.mapper.ts", "await prisma.extractionSnapshot.findMany"],
  ["lib/business-memory/evidence/review-event.reader.ts", "await prisma.reviewEvent.findMany"],
]) {
  let s = fs.readFileSync(f, "utf8");
  const nl = s.includes("\r\n") ? "\r\n" : "\n";
  if (!s.includes("async function dbStep")) {
    if (!s.includes('import { prisma } from "@/lib/prisma";')) { console.error("MISS prisma import " + f); process.exit(1); }
    s = s.replace('import { prisma } from "@/lib/prisma";',
      'import { prisma } from "@/lib/prisma";' + nl + DBSTEP.split("\n").join(nl));
    fs.writeFileSync(f, s);
  }
  wrapAwaitCall(f, call, "await dbStep((db) => ", ")", call.replace("await prisma.", "db."));
}

// 3. export / summary / search routes.
for (const f of [
  "app/api/reports/export/route.ts",
  "app/api/reports/summary/route.ts",
  "app/api/search/route.ts",
]) {
  let s = fs.readFileSync(f, "utf8");
  const nl = s.includes("\r\n") ? "\r\n" : "\n";
  if (!s.includes("runWithTenantContext")) {
    s = s.replace('import { getCurrentUser } from "@/lib/auth";',
      'import { getCurrentUser } from "@/lib/auth";' + nl + IMP.split("\n").join(nl));
    fs.writeFileSync(f, s);
  }
  wrapAwaitCall(f, "await prisma.financialRecord.findMany",
    "await runWithTenantContext({ businessId: user.businessId }, () => withTenantTransaction((tx) => ", "))",
    "tx.financialRecord.findMany");
}

// 4. gmail bare create.
wrapAwaitCall("app/api/integrations/gmail/import/route.ts", "await prisma.document.create",
  "await withTenantTransaction((tx) => ", ")", "tx.document.create");

// 5. approve: initial read + vendor learning + resolver context.
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
