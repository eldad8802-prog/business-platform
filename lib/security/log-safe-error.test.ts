/**
 * L3 — auth logs carry an error's class and code, never the error object.
 *
 *   npx tsx lib/security/log-safe-error.test.ts
 *
 * 1. safeErrorSummary keeps what diagnosis needs (class, Prisma / driver code) and drops message,
 *    meta, cause and stack — where addresses, hashes and connection strings live.
 * 2. Static guard: no auth route (app/api/auth/**) or auth library file passes a raw caught error to
 *    console.* — so the leak cannot come back unnoticed.
 */

import fs from "node:fs";
import path from "node:path";
import { inspect } from "node:util";

import { safeErrorSummary } from "./log-safe-error";

let failed = 0;
let passed = 0;
function ok(name: string, cond: boolean) {
  if (cond) {
    passed += 1;
    console.log("  ok  -", name);
  } else {
    failed += 1;
    console.error("  FAIL -", name);
  }
}

class PrismaClientKnownRequestError extends Error {
  code = "P2002";
  meta = { target: ["email"], modelName: "User" };
  constructor() {
    super('Unique constraint failed: { email: "owner@example.test", password: "$2b$12$abcdefghijklmnopqrstuv" }');
    this.name = "PrismaClientKnownRequestError";
  }
}
class PrismaClientInitializationError extends Error {
  errorCode = "P1001";
  constructor() {
    super("Can't reach database server at db.example.test:5432 postgresql://app:s3cr3t@db.example.test/main");
    this.name = "PrismaClientInitializationError";
  }
}

// 1. The summary.
{
  const s = safeErrorSummary(new PrismaClientKnownRequestError());
  ok("prisma request error -> class + code", s.error === "PrismaClientKnownRequestError" && s.code === "P2002");
  const text = inspect(s);
  ok("prisma request error -> no address, no hash, no meta", !/owner@example\.test|\$2b\$|target|User/.test(text));

  const init = safeErrorSummary(new PrismaClientInitializationError());
  ok("prisma init error -> errorCode kept", init.error === "PrismaClientInitializationError" && init.code === "P1001");
  ok("prisma init error -> no host or DSN", !/example\.test|postgresql|s3cr3t/.test(inspect(init)));

  const net = Object.assign(new Error("connect ECONNRESET 10.0.0.5:6379"), { code: "ECONNRESET" });
  ok("driver error -> code kept, address dropped", safeErrorSummary(net).code === "ECONNRESET" && !/10\.0\.0\.5/.test(inspect(safeErrorSummary(net))));

  const withCause = new TypeError("boom", { cause: { email: "owner@example.test" } });
  ok("cause is never followed", !/owner@example\.test/.test(inspect(safeErrorSummary(withCause))) && safeErrorSummary(withCause).error === "TypeError");

  const weird = Object.assign(new Error("x"), { name: "owner@example.test", code: "a b c <script>" });
  const ws = safeErrorSummary(weird);
  ok("an unsafe name or code is not echoed", ws.error === "Error" && ws.code === undefined);

  ok("a non-Error throw -> its type only", safeErrorSummary("owner@example.test").error === "string" && safeErrorSummary({ email: "x" }).error === "NonError");
}

// 2. Static guard over the auth surface.
{
  const roots = ["app/api/auth", "lib/auth"].map((r) => path.join(process.cwd(), r));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) files.push(p);
    }
  };
  roots.forEach(walk);
  // console.*( ... , error )  /  console.*( error )  — a caught error passed whole.
  const RAW = /console\.(error|warn|log|info)\(([^;]*?,\s*)?(error|err|e)\s*\)/;
  const offenders = files.flatMap((f) =>
    fs
      .readFileSync(f, "utf8")
      .split("\n")
      .map((line, i) => ({ f, i: i + 1, line }))
      .filter(({ line }) => RAW.test(line))
      .map(({ f, i }) => `${path.relative(process.cwd(), f)}:${i}`)
  );
  ok(`no auth file logs a raw error object (${files.length} files scanned)`, offenders.length === 0);
  if (offenders.length) console.error("    offenders:", offenders.join(", "));
}

console.log(`\n[log-safe-error] ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
