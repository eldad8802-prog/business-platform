/**
 * SEC-F negative proofs for the CODE controls (same contract as
 * ./negative-proofs.mjs): anchor exactly once, file must change, the named
 * command must exit 1 (2 = setup crash = proof FAILS) with the SPECIFIC
 * `[FAIL] <label>` line, restore byte-identical (sha256), then every command
 * post-restore green.
 *
 * Usage: node .secf/code-negative-proofs.mjs [id ...]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const UNIT = ["npx", "tsx", "lib/security/security-observability.verify.test.ts"];
const CHAIN = ["npx", "tsx", "lib/audit/audit-chain.verify.test.ts"];
const DB = ["npx", "tsx", ".secf/code-battery.ts"];

const MUTATIONS = [
  {
    id: "CN1", file: "lib/services/billing/billing-audit.service.ts", cmd: DB,
    anchor: "      occurredAt: normalized.occurredAt,\n      ...(link ?? {}),\n",
    replacement: "      occurredAt: normalized.occurredAt,\n",
    expect: "K-BILLING-CHAINED",
    reason: "the billing writer stops persisting its chain link — rows fall back to an unkeyed checksum",
  },
  {
    id: "CN2", file: "lib/audit/audit-chain.ts", cmd: CHAIN,
    anchor: "    summary: content.summary,\n  });",
    replacement: "  });",
    expect: "MODIFY summary → MAC_MISMATCH",
    reason: "a field left out of the MAC can be rewritten undetected",
  },
  {
    id: "CN3", file: "lib/audit/audit-chain.ts", cmd: DB,
    anchor: "  await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock($1::int, $2::int)`, LOCK_NAMESPACE[table], content.businessId);\n",
    replacement: "",
    expect: "K-CONCURRENT",
    reason: "without the per-business lock concurrent writers read the same head and collide (23505 / DZ002)",
  },
  {
    id: "CN4", file: "app/api/auth/login/route.ts", cmd: DB,
    anchor: `  await recordSecurityEvent({ type: "AUTH_LOGIN_FAILURE", outcome: "FAILURE", reason: input.reason, businessId: input.businessId, userId: input.userId, actor: "ANONYMOUS" });\n`,
    replacement: "",
    expect: "S-LOGIN-FAILURE-RECORDED",
    reason: "a refused login leaves no durable record",
  },
  {
    id: "CN5", file: "lib/security/security-events.ts", cmd: UNIT,
    anchor: `    else if (typeof value === "string" && SAFE_STRING.test(value) && !value.includes("@")) out[key] = value;`,
    replacement: `    else if (typeof value === "string") out[key] = value;`,
    expect: "metadata keeps only safe scalars",
    reason: "free-text metadata lets an email address into the security store",
  },
  {
    id: "CN6", file: "lib/security/rate-limiter/buckets.ts", cmd: UNIT,
    anchor: "  COST_LLM_GENERATION: {\n    failMode: \"closed\",",
    replacement: "  COST_LLM_GENERATION: {\n    failMode: \"open\",",
    expect: "LLM bucket FAILS CLOSED → 503 cost_limit_unavailable",
    reason: "a limiter outage becomes unlimited paid LLM calls",
  },
  {
    id: "CN7", file: "lib/security/rate-limiter/buckets.ts", cmd: UNIT,
    anchor: "      { scope: \"business\", limit: 20, windowSeconds: 60 },\n      { scope: \"business\", limit: 400, windowSeconds: 24 * 60 * 60 },",
    replacement: "      { scope: \"business\", limit: 400, windowSeconds: 24 * 60 * 60 },",
    expect: "call 21 for that business → 429 cost_limit_exceeded (scope=business)",
    reason: "without the per-business minute rule many members of one business multiply its LLM spend",
  },
  {
    id: "CN8", file: "lib/observability/report-error.ts", cmd: UNIT,
    anchor: "  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/g, \"[redacted-email]\"],\n",
    replacement: "",
    expect: "scrubber removes email",
    reason: "error reports carry customer email addresses to the log/vendor",
  },
];

function run(cmd) {
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8", env: process.env, shell: process.platform === "win32", maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const wanted = process.argv.slice(2);
const selected = wanted.length ? MUTATIONS.filter((m) => wanted.includes(m.id)) : MUTATIONS;
let bad = 0;
for (const m of selected) {
  const original = readFileSync(m.file);
  const originalSha = sha(original);
  const text = original.toString("utf8");
  const n = text.split(m.anchor).length - 1;
  console.log(`\n=== ${m.id} ===`);
  console.log(`MUTATION:        ${m.file}: ${JSON.stringify(m.anchor.slice(0, 80))} -> ${JSON.stringify(m.replacement.slice(0, 50))}`);
  console.log(`EXPECTED RED:    exit 1 with [FAIL] ${m.expect}`);
  console.log(`INTENDED REASON: ${m.reason}`);
  if (n !== 1) { console.log(`ACTUAL RED:      PROOF INVALID — anchor occurs ${n} times`); bad++; continue; }
  writeFileSync(m.file, text.replace(m.anchor, m.replacement));
  let res;
  try {
    if (sha(readFileSync(m.file)) === originalSha) throw new Error("mutation did not change the file");
    res = run(m.cmd);
  } finally {
    writeFileSync(m.file, original);
  }
  const restored = sha(readFileSync(m.file)) === originalSha;
  const failLine = res.out.split("\n").find((l) => l.includes(`[FAIL] ${m.expect}`));
  const crash = res.code === 2 || res.out.includes("[SETUP-ERROR]");
  const red = res.code === 1 && !!failLine && !crash;
  console.log(`ACTUAL RED:      exit=${res.code}${crash ? " SETUP CRASH" : ""} ${failLine ? failLine.trim().slice(0, 200) : "(expected FAIL line absent)"}`);
  console.log(`RESTORE:         sha256 ${restored ? "identical" : "DIFFERS"} (${originalSha.slice(0, 16)}…)`);
  if (!red || !restored) {
    bad++;
    if (!red) console.log(res.out.split("\n").filter((l) => /\[FAIL\]|SETUP|Error/.test(l)).slice(0, 15).join("\n"));
  }
}
for (const cmd of [CHAIN, UNIT, DB]) {
  const g = run(cmd);
  const green = g.code === 0 && !g.out.includes("[FAIL]");
  console.log(`POST-RESTORE GREEN: ${cmd.slice(2).join(" ")} exit=${g.code}${green ? "" : " NOT GREEN"}`);
  if (!green) { bad++; console.log(g.out.split("\n").filter((l) => /\[FAIL\]|SETUP/.test(l)).join("\n")); }
}
console.log(bad === 0 ? "CODE NEGATIVE PROOFS: ALL RED AS INTENDED, RESTORED, GREEN" : `CODE NEGATIVE PROOFS: ${bad} PROBLEM(S)`);
process.exit(bad === 0 ? 0 : 1);
