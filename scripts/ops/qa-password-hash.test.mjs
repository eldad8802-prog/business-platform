#!/usr/bin/env node
/**
 * The credential tool must refuse what actually went wrong.
 *
 * Case one is not hypothetical: a file holding only a UTF-8 byte-order mark is
 * what produced a Production account whose password is U+FEFF. Every case below
 * is written against the real script, through the real filesystem, because the
 * defect being prevented is precisely the kind that survives a review.
 *
 * Run: node scripts/ops/qa-password-hash.test.mjs
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

import { BCRYPT_COST_10_SHAPE } from "../ci/collection-qa-tenant-hash-shape.mjs";

const require = createRequire(import.meta.url);
const bcrypt = require("bcrypt");

const TOOL = "scripts/ops/qa-password-hash.mjs";
const dir = mkdtempSync(join(tmpdir(), "qa-password-"));

let passed = 0;
let failures = 0;

function run(contents, { raw = false } = {}) {
  const passwordFile = join(dir, "password.txt");
  const hashFile = join(dir, "hash.txt");
  if (existsSync(hashFile)) rmSync(hashFile);
  writeFileSync(passwordFile, contents, raw ? undefined : { encoding: "utf8" });
  try {
    const stdout = execFileSync(process.execPath, [TOOL, passwordFile, hashFile], {
      encoding: "utf8",
    });
    return { code: 0, stdout, hashFile };
  } catch (error) {
    return {
      code: error.status ?? 1,
      stdout: `${error.stdout ?? ""}${error.stderr ?? ""}`,
      hashFile,
    };
  }
}

function mustRefuse(label, contents, options) {
  const { code, stdout, hashFile } = run(contents, options);
  const wroteNothing = !existsSync(hashFile);
  if (code !== 0 && wroteNothing) {
    passed += 1;
    console.log(`  ok    refused: ${label}`);
  } else {
    failures += 1;
    console.log(
      `  FAIL  ${code === 0 ? "ACCEPTED" : "refused but still wrote a hash"}: ${label}`
    );
    console.log(`        ${stdout.trim().split("\n")[0] ?? ""}`);
  }
}

console.log("QA password tool — refusal proof\n");

// The failure that actually happened, byte for byte.
mustRefuse("a file holding only a UTF-8 byte-order mark", "﻿");
mustRefuse("a BOM in front of a real password", "﻿correct-horse-battery");
mustRefuse("an empty file", "");
mustRefuse("a single newline", "\n");
mustRefuse("spaces and tabs only", "   \t  ");
mustRefuse("a trailing newline after a real password", "correct-horse-battery\n");
mustRefuse("leading whitespace", "  correct-horse-battery");
mustRefuse("an embedded control character", "correcthorse");
mustRefuse("a password shorter than signup allows", "abc");

// And it must accept an ordinary one, or the refusals above prove nothing.
const good = "qa-collection-sandbox-correct-horse";
const { code, stdout, hashFile } = run(good);
if (code === 0 && existsSync(hashFile)) {
  const hash = readFileSync(hashFile, "utf8");
  const shapeOk = BCRYPT_COST_10_SHAPE.test(hash);
  const roundTrips = await bcrypt.compare(good, hash);
  const leaked = stdout.includes(good) || stdout.includes(hash);
  if (shapeOk && roundTrips && !leaked) {
    passed += 1;
    console.log("  ok    accepted: an ordinary password — cost 10, round-trips, nothing leaked");
  } else {
    failures += 1;
    console.log(
      `  FAIL  accepted but: shape=${shapeOk} round-trips=${roundTrips} leaked=${leaked}`
    );
  }
} else {
  failures += 1;
  console.log(`  FAIL  REFUSED an ordinary password\n${stdout}`);
}

rmSync(dir, { recursive: true, force: true });

console.log(
  `\n${passed} passed, ${failures} failed — ${failures === 0 ? "CREDENTIAL TOOL: PASS" : "CREDENTIAL TOOL: FAIL"}`
);
process.exit(failures === 0 ? 0 : 1);
