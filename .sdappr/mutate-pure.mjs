// Actor / approver — mutation run over the pure guards. Each mutation weakens one rule in the source, runs
// lib/services/service-desk/approvals.test.ts, and restores the file byte-for-byte. Every mutation must be KILLED.
//   node .sdappr/mutate-pure.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const A = "lib/services/service-desk/approvals.ts";
const CORE = "lib/services/service-desk/service-case.core.ts";
const HTTP = "lib/services/service-desk/service-desk-http.ts";
const MUTATIONS = [
  ["resolveApproval: the approver is not the session user", A, `actorUserId: p.userId, approverUserId: p.userId,`, `actorUserId: p.userId, approverUserId: p.userId + 1,`],
  ["approverFor: a plain object counts as a grant", A, `.find((x) => isApprovalGrant(x) && x.kind === kind)`, `.find((x) => x.kind === kind)`],
  ["approverFor: another business's grant accepted", A, `if (!g || g.businessId !== actor.businessId ||`, `if (!g ||`],
  ["approverFor: another actor's grant accepted", A, ` || g.actorUserId !== actor.userId || (`, ` || (`],
  ["resolveApproval: no authority check", A, `if (held === null || held !== APPROVAL_POLICY[kind].authority)`, `if (false)`],
  ["isApprovalGrant: shape instead of identity", A, `return typeof g === "object" && g !== null && ISSUED.has(g);`, `return typeof g === "object" && g !== null && (g as Record<symbol, unknown>)[GRANT] === true;`],
  ["assertNoClientIdentity: nothing refused", A, `if (isIdentityField(k)) throw`, `if (false) throw`],
  ["assertNoClientIdentity: not recursive", A, `    assertNoClientIdentity(v, \`\${path}.\${k}\`, depth + 1);\n`, ``],
  ["isIdentityField: *UserId keys pass", A, ` || /UserIds?$/.test(key)`, ``],
  ["isIdentityField: approver* / actor* keys pass", A, ` || IDENTITY_PREFIX.test(key)`, ``],
  ["core: DELIVER debt names no approval", CORE, `if (balance.debtApproved) r.approvals.push("HANDOVER_OPEN_DEBT");`, ``],
  ["core: DELIVER loaner names no approval", CORE, `if (loanerApproved) r.approvals.push("HANDOVER_OPEN_LOANER");`, ``],
  ["core: COMPLETE debt names no approval", CORE, `if (balance.debtApproved) r.approvals.push("COMPLETION_OPEN_DEBT");`, ``],
  ["core: the handover record not set", CORE, `r.handover = { ...balance, loanerApproved };`, ``],
  ["http: jsonBody does not check identities", HTTP, `  assertNoClientIdentity(body);\n`, ``],
];
let killed = 0;
const survived = [];
for (const [label, file, from, to] of MUTATIONS) {
  const orig = readFileSync(file, "utf8");
  if (!orig.includes(from)) { console.log(`  [ANCHOR MISSING] ${label}`); survived.push(label); continue; }
  writeFileSync(file, orig.replace(from, to));
  try {
    const r = spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "lib/services/service-desk/approvals.test.ts"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, AUTH_TOKEN_SECRET: process.env.AUTH_TOKEN_SECRET ?? "sd-mutate-synthetic-auth-secret-0123456789abcdef" },
    });
    const line = (`${r.stdout}`.match(/^\d+ passed, \d+ failed.*$/m) ?? ["(no summary)"])[0];
    if (r.status !== 0) { killed++; console.log(`  [KILLED] ${label} — ${line}`); } else { survived.push(label); console.log(`  [SURVIVED] ${label} — ${line}`); }
  } finally {
    writeFileSync(file, orig);
    if (readFileSync(file, "utf8") !== orig) throw new Error(`RESTORE NOT BYTE-IDENTICAL: ${file}`);
  }
}
console.log(`MUTATIONS: ${killed} killed, ${survived.length} survived`);
if (survived.length) process.exit(1);
