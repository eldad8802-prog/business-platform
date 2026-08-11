/**
 * Detection Grammar — Equality Runtime · Minimum Executable Proof (fixtures-only).
 *
 * Proves end-to-end that C0 CanonicalObservation accounts can enter an Equality
 * Runtime conformant to the ratified §N contract (Equality/contract@v1-2026-08-11),
 * produce a deterministic Projection, and replay to the same result — with no
 * persistence, no product coupling, no Belief/Judgment, and no C0 mutation.
 *
 * Run: npx tsx lib/detection-grammar/equality/equality.verify.test.ts
 */
import { makeIntegerDomain } from "./fixtures/fixture-equality-domain";
import { fixtureObservation } from "./fixtures/fixture-observations";
import {
  normalizeIntegerObservation,
  H1_REAL_CONCEPT_SNAPSHOT,
} from "./fixtures/fixture-normalize-observations";
import { admitFromCot } from "./cot-to-relatum";
import { evaluateEquality, runEqualityFromCots } from "./equality-operator";
import { projectionsReplayEqual } from "./equality-replay";
import type { EqualityProjection } from "./equality.types";

let failures = 0;
function check(name: string, cond: boolean, extra = ""): void {
  const status = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`  [${status}] ${name}${extra ? " — " + extra : ""}`);
}
function label(p: EqualityProjection): string {
  return p.disposition.kind === "OUTCOME"
    ? p.disposition.outcome
    : `FAILURE/${p.disposition.family}(${p.disposition.source})`;
}

const domain = makeIntegerDomain();

console.log("Equality Runtime Proof — C0 -> Equality -> Projection -> Replay\n");

// S1 — same abstract value in two representations -> EQUAL (EA1 / EB4).
{
  const a = fixtureObservation("1", "s1a");
  const b = fixtureObservation("01", "s1b");
  const p = runEqualityFromCots(domain, a, b);
  check("S1 value != representation: '1' vs '01' -> EQUAL (EA1/EB4)", label(p) === "EQUAL", label(p));
}

// S2 — different values -> NOT_EQUAL (EC1).
{
  const p = runEqualityFromCots(domain, fixtureObservation("1", "s2a"), fixtureObservation("2", "s2b"));
  check("S2 '1' vs '2' -> NOT_EQUAL (EC1)", label(p) === "NOT_EQUAL", label(p));
}

// S3 — swap (a,b)<->(b,a): same Outcome, different Operation identity (EB1 / ED1).
{
  const a = admitFromCot(domain, fixtureObservation("1", "s3a"));
  const b = admitFromCot(domain, fixtureObservation("2", "s3b"));
  if (a.ok && b.ok) {
    const ab = evaluateEquality(domain, a.relatum, b.relatum);
    const ba = evaluateEquality(domain, b.relatum, a.relatum);
    check("S3 swap -> same Outcome (EB1 symmetry)", label(ab) === label(ba) && label(ab) === "NOT_EQUAL", label(ab));
    check("S3 swap -> different Operation identity (ED1)", ab.operationIdentityDigest !== ba.operationIdentityDigest);
  } else {
    check("S3 admit both relata", false);
  }
}

// S4 — Domain ID mismatch -> Family A, never NOT_EQUAL (EB2 / R1).
{
  const domX = makeIntegerDomain("fixture:domX", "v1");
  const domY = makeIntegerDomain("fixture:domY", "v1");
  const a = admitFromCot(domX, fixtureObservation("1", "s4a"));
  const b = admitFromCot(domY, fixtureObservation("1", "s4b"));
  if (a.ok && b.ok) {
    const p = evaluateEquality(domX, a.relatum, b.relatum);
    check(
      "S4 Domain ID mismatch -> Family A, not NOT_EQUAL (EB2/R1)",
      p.disposition.kind === "FAILURE" && p.disposition.family === "A",
      label(p)
    );
  } else {
    check("S4 admit both relata", false);
  }
}

// S5 — Domain Version mismatch -> Family A (EA3 / EB2 / R1).
{
  const domV1 = makeIntegerDomain("fixture:dom", "v1");
  const domV2 = makeIntegerDomain("fixture:dom", "v2");
  const a = admitFromCot(domV1, fixtureObservation("1", "s5a"));
  const b = admitFromCot(domV2, fixtureObservation("1", "s5b"));
  if (a.ok && b.ok) {
    const p = evaluateEquality(domV1, a.relatum, b.relatum);
    check(
      "S5 Domain Version mismatch -> Family A (EA3/EB2/R1)",
      p.disposition.kind === "FAILURE" && p.disposition.family === "A",
      label(p)
    );
  } else {
    check("S5 admit both relata", false);
  }
}

// S6 — inadmissible relatum -> Family B (Domain-supplied), never NOT_EQUAL (EB3 / EE2).
{
  const p = runEqualityFromCots(domain, fixtureObservation("abc", "s6a"), fixtureObservation("1", "s6b"));
  check(
    "S6 inadmissible relatum -> Family B (Domain), not NOT_EQUAL (EB3/EE2)",
    p.disposition.kind === "FAILURE" && p.disposition.family === "B" && p.disposition.source === "DOMAIN",
    label(p)
  );
}

// S7 — replay determinism: same pinned execution -> identical Projection (ED3);
//      also confirms C0 identity determinism (same content -> same account id).
{
  const a = fixtureObservation("5", "s7a");
  const b = fixtureObservation("5", "s7b");
  const p1 = runEqualityFromCots(domain, a, b);
  const p2 = runEqualityFromCots(domain, a, b);
  const aReseal = fixtureObservation("5", "s7a"); // same content, sealed again
  check("S7a C0 identity deterministic (same content -> same account id)", a.observationAccountId === aReseal.observationAccountId);
  check(
    "S7b replay -> identical deterministic Projection (ED3)",
    projectionsReplayEqual(p1, p2) && p1.operationIdentityDigest === p2.operationIdentityDigest && label(p1) === "EQUAL"
  );
}

// S8 — change version-pinned semantic spec -> different Operation identity (ED4).
{
  const a = admitFromCot(domain, fixtureObservation("5", "s8a"));
  const b = admitFromCot(domain, fixtureObservation("5", "s8b"));
  if (a.ok && b.ok) {
    const p1 = evaluateEquality(domain, a.relatum, b.relatum, "Equality/contract@v1-2026-08-11");
    const p2 = evaluateEquality(domain, a.relatum, b.relatum, "Equality/contract@v2-FUTURE");
    check("S8 version change -> different Operation identity (ED4)", p1.operationIdentityDigest !== p2.operationIdentityDigest);
    check("S8 both remain successful EQUAL (successful-Outcome only)", label(p1) === "EQUAL" && label(p2) === "EQUAL");
  } else {
    check("S8 admit both relata", false);
  }
}

// S9 — Outcome XOR Failure invariant across a representative set (EC2).
{
  const cases: EqualityProjection[] = [];
  cases.push(runEqualityFromCots(domain, fixtureObservation("1", "x1"), fixtureObservation("01", "x2"))); // EQUAL
  cases.push(runEqualityFromCots(domain, fixtureObservation("1", "x3"), fixtureObservation("2", "x4"))); // NOT_EQUAL
  cases.push(runEqualityFromCots(domain, fixtureObservation("abc", "x5"), fixtureObservation("1", "x6"))); // Family B
  const domY = makeIntegerDomain("fixture:other", "v1");
  const rY = admitFromCot(domY, fixtureObservation("1", "x7"));
  const rX = admitFromCot(domain, fixtureObservation("1", "x8"));
  if (rX.ok && rY.ok) cases.push(evaluateEquality(domain, rX.relatum, rY.relatum)); // Family A
  const xor = cases.length === 4 && cases.every((p) => {
    const isOutcome = p.disposition.kind === "OUTCOME";
    const isFailure = p.disposition.kind === "FAILURE";
    return isOutcome !== isFailure; // exactly one; Failure structurally carries no `outcome`
  });
  check("S9 Outcome XOR Failure invariant (EC2)", xor, `dispositions: ${cases.map(label).join(", ")}`);
}

// S10 — C0 account is immutable (C0 boundary §11: C1 must not mutate Evidence).
{
  const a = fixtureObservation("7", "s10");
  const before = a.value.datum;
  let threw = false;
  try {
    // deliberate mutation attempt on a deep-frozen account. A frozen-property write
    // throws in strict mode and silently no-ops in sloppy mode; either way the
    // Evidence must remain unchanged — that unchanged-ness is the C0 invariant.
    (a as unknown as { value: { datum: unknown } }).value.datum = "999";
  } catch {
    threw = true;
  }
  check("S10a C0 account frozen (top + nested)", Object.isFrozen(a) && Object.isFrozen(a.value));
  check(
    "S10b Evidence unchanged after mutation attempt (C0 §11)",
    Object.isFrozen(a.value) && a.value.datum === before,
    `datum=${String(a.value.datum)}, writeThrew=${threw}`
  );
}

// S11 — HARDENED end-to-end: Fixture RawInput -> C0 normalize() -> sealed account
//       (real pinned registry snapshot) -> Equality -> Projection -> replay (D1+D9).
{
  const placeholder = "regsnap:concept:sha256:" + "0".repeat(64);
  const accA = normalizeIntegerObservation(5, "h1-a", "run-a");
  const accB = normalizeIntegerObservation(5, "h1-b", "run-b");
  check(
    "S11a account produced by genuine C0 normalize() (ResourceLevel@1, coverage resolved)",
    accA.concept.conceptId === "ResourceLevel" &&
      accA.concept.conceptVersion === "1" &&
      accA.coverage.state === "FULL",
    `${accA.concept.conceptId}@${accA.concept.conceptVersion}, coverage=${accA.coverage.state}`
  );
  check("S11b normalized account sealed / deep-frozen", Object.isFrozen(accA) && Object.isFrozen(accA.value));
  check(
    "S11c ExecutionContext pinned to REAL registry snapshot, not placeholder (D9)",
    accA.context.conceptRegistrySnapshot === H1_REAL_CONCEPT_SNAPSHOT &&
      accA.context.conceptRegistrySnapshot !== placeholder,
    accA.context.conceptRegistrySnapshot.slice(0, 34) + "…"
  );
  const p = runEqualityFromCots(domain, accA, accB);
  check("S11d Equality over normalized C0 accounts -> EQUAL (5 == 5)", label(p) === "EQUAL", label(p));
  // Replay: same pinned inputs through the full pipeline -> identical account id + Projection.
  const accA2 = normalizeIntegerObservation(5, "h1-a", "run-a");
  const accB2 = normalizeIntegerObservation(5, "h1-b", "run-b");
  const p2 = runEqualityFromCots(domain, accA2, accB2);
  check(
    "S11e replay: identical account identity through full C0 pipeline",
    accA2.observationAccountId === accA.observationAccountId &&
      accB2.observationAccountId === accB.observationAccountId
  );
  check(
    "S11f replay: identical deterministic Projection (ED3, end-to-end)",
    projectionsReplayEqual(p, p2) && p.operationIdentityDigest === p2.operationIdentityDigest
  );
}

console.log(`\n${failures === 0 ? "ALL SCENARIOS PASS" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
