# CASA 6.1.1 — Dependency / Vulnerable Component Evidence

**Baseline:** `origin/main` at `0123c15`, `package-lock.json` lockfileVersion 3, 994 package entries.
**Date of analysis:** 2026-09-02.
**Scope:** evidence for CASA requirement 6.1.1 only.

Every number in this memo was recomputed from the current lockfile and the
current advisory database. Historical figures from the original readiness audit
are quoted only where explicitly labelled as historical.

This document contains no credentials, environment values or tokens.

---

## Control objective

CASA 6.1.1, as validated for this program:

> The application shall not use any third-party libraries at a version
> vulnerable to a CVE with a severity **>= CVSS 7.0** — with an explicit
> exemption where **the application does not invoke the vulnerable third-party
> library code**, or where **the third-party library has not yet made an update
> available**.

Two consequences follow, and both matter for reading this memo honestly:

- The criterion is **CVSS-scored severity**, not a package manager's severity
  label. `npm audit` labels several advisories "high" that carry no published
  CVSS at all; those labels are not the CASA threshold.
- The requirement is **vulnerability management with justification**, not a zero
  count. A residual advisory with a proven non-invocation argument satisfies it;
  a suppressed one does not.

AL1 evidence for this requirement is the output of a dependency scan. CI
automation of that scan is not itself a CASA requirement.

---

## Current dependency baseline

| Item | Value |
| --- | --- |
| Main SHA | `0123c15` |
| Lockfile | `package-lock.json`, lockfileVersion 3, 994 entries, clean against the working tree |
| Production dependencies declared | 37 |
| Dev dependencies declared | 15 |
| Next.js | `16.3.3` |
| React / React DOM | `19.2.4` |
| `@prisma/client` | `6.19.3` |
| `exceljs` | `4.4.0` |
| `jspdf` | `4.2.1` |

Scan commands: `npm audit` (full tree) and `npm audit --omit=dev` (production
graph). Advisory metadata was taken from the GitHub Advisory Database via the
GraphQL `securityAdvisory` API, because `npm audit`'s inline `cvss.score` is `0`
for advisories that carry no published CVSS and would otherwise be misread as a
score of zero.

**Full tree:** 12 advisories — 6 high, 5 moderate, 1 low, 0 critical.
**Production graph (`--omit=dev`):** 7 advisories — 4 high, 3 moderate, 0 critical.

---

## Wave C remediation already performed

CASA Wave C upgraded Next.js `16.2.1 → 16.3.3` (PR #312, commit `b2c3250`).

Effect on the historical production findings that met the CASA threshold at the
original audit baseline `fc63f07`:

| Package | Historical CVSS | Status at `0123c15` |
| --- | --- | --- |
| `next` | 8.6 | **fixed by upgrade** — now `16.3.3`, no advisory |
| `brace-expansion` | 7.5 | **fixed by upgrade** — no advisory |
| `postcss` | 7.5 | **fixed by upgrade** — now `8.5.23`, no advisory |
| `protobufjs` | 7.5 | **fixed by upgrade** — now `7.6.6`, no advisory |
| `uuid` | 7.5 | **still present** — see below |

Four of the five were resolved by the single Next.js upgrade and its transitive
consequences. One remains, and it is the subject of the rest of this memo.

---

## Current vulnerability inventory — production graph

| Package | Installed | Path | Advisory | Published CVSS | Classification |
| --- | --- | --- | --- | --- | --- |
| `uuid` | 8.3.2 | `exceljs@4.4.0 → uuid` | GHSA-w5hq-g745-h8pq / CVE-2026-41907 | **7.5** | **B — CASA-relevant, demonstrably not invoked** |
| `tmp` | 0.2.5 | `exceljs@4.4.0 → tmp` | GHSA-ph9p-34f9-6g65 / CVE-2026-44705 | **unscored** | C + B — below the scored threshold, and not invoked |
| `deepmerge-ts` | 7.1.5 | `@prisma/client → (peer) prisma → @prisma/config → deepmerge-ts` | GHSA-ggr8-5vv4-36mx / CVE-2026-40345 | **unscored** | C + D — below the scored threshold; CLI/build-time path |
| `dompurify` | 3.4.1 | `jspdf@4.2.1 → dompurify` | 10 advisories, highest CVE-2026-49458 / -49459 / -65902 | **6.1 max** | C — below the CASA threshold |
| `exceljs` | 4.4.0 | direct | *carrier only* (`via: uuid`) | — | E — not its own advisory |
| `prisma` | 6.19.3 | peer of `@prisma/client` | *carrier only* (`via: @prisma/config`) | — | E — not its own advisory |
| `@prisma/config` | 6.19.3 | see `deepmerge-ts` | *carrier only* (`via: deepmerge-ts`) | — | E — not its own advisory |

Dev-only findings, present in the full tree but **absent from the production
graph** (classification **D**): `js-yaml` 4.1.1 (CVSS 7.5), `browserslist`
4.28.2 (CVSS 7.5), `@babel/core` 7.29.0 (CVSS 3.2), `xcode` 3.0.1 and
`@capacitor/cli` 8.5.0 (carriers of a second `uuid@7.0.3` copy). These are build
and tooling dependencies; they are not shipped in the deployed application.

**Exactly one production finding carries a published CVSS >= 7.0: `uuid` at 7.5.**

---

## Finding 1 — `uuid` via `exceljs` (the one CASA-relevant finding)

**Advisory.** GHSA-w5hq-g745-h8pq, CVE-2026-41907, CVSS 3.1 **7.5**
(`AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:H/A:N` — integrity only, no confidentiality or
availability impact). Summary: *"Missing buffer bounds check in v3/v5/v6 when
`buf` is provided."* Vulnerable range `< 11.1.1`; first patched `11.1.1`.

**Installed.** `uuid@8.3.2`, reached only through `exceljs@4.4.0`.

**Vulnerable behaviour.** An out-of-bounds write occurs when `v3()`, `v5()` or
`v6()` is called **with a caller-supplied `buf` argument** that is too small.
The defect is in the buffer-writing path; it is not reachable through the
argument-less form, which returns a string.

**How Dubiz uses `exceljs`.** One consumer:
[`lib/reports/accountant-export-zip.ts`](../lib/reports/accountant-export-zip.ts).
It constructs `new ExcelJS.Workbook()` and serialises with
`workbook.xlsx.writeBuffer()` — the in-memory **writer**. Dubiz never uses the
streaming reader, and never parses an uploaded spreadsheet through `exceljs`.

**Reachability — proven, not asserted:**

1. **Dubiz does not import `uuid` at all.** A search across `app/`, `lib/`,
   `components/`, `scripts/` and `eval/` for any `uuid` import or require
   returns zero results. The package enters the graph solely as an `exceljs`
   transitive dependency.
2. **`exceljs` imports only `v4`.** Every reference in the package is the same
   line in one module — `const {v4: uuidv4} = require('uuid')` in
   `lib/xlsx/xform/sheet/cf-ext/cf-rule-ext-xform.js`, repeated verbatim in the
   three pre-built `dist/` bundles. `v3`, `v5` and `v6` are never imported.
3. **Every call site passes no arguments.** All eight call sites across `lib/`
   and `dist/` are `uuidv4()` — used to mint an `x14Id` for a conditional
   formatting rule extension. No `buf` is ever supplied, to `v4` or anything
   else.
4. **`v6` does not exist in the installed version.** `uuid@8.3.2` exports
   `v1, v3, v4, v5, NIL, version, validate, stringify, parse`. Two of the three
   vulnerable functions are present but unreferenced; the third is absent
   entirely.
5. **No attacker-controlled path.** The only invocation is `v4()` with no input,
   producing a random identifier during spreadsheet *writing*. There is no input
   from a request, an upload or a tenant that can reach the vulnerable code,
   because the vulnerable code is never called on any input.

**Is a patched compatible path available?** No. `exceljs@4.4.0` **is the latest
published version**, and it declares `uuid: ^8.3.0` — a range that cannot
resolve to the patched `11.1.1`. There is no upstream release of `exceljs` that
moves off the vulnerable major.

**Classification: B — CASA-relevant but demonstrably non-invoked.** This finding
satisfies **both** documented CASA exemptions independently: the application
does not invoke the vulnerable library code, and the library has not made an
update available. The first is the stronger claim and is the one relied upon
here; it rests on the five points above, not on the fact that the dependency is
transitive. Transitivity alone would not be sufficient and is not the argument.

**Available hardening (not required, not applied).** An npm `overrides` entry
pinning `uuid` to `>= 11.1.1` beneath `exceljs` would very likely work, since
only `v4()` is used and its signature is unchanged across those majors. It is
recorded here as an option rather than a necessity: it is a dependency change,
it is not required by 6.1.1 given the non-invocation evidence, and forcing a
three-major jump under a library that pins `^8.3.0` carries its own risk. The
`fixAvailable` value npm reports for this finding is a **downgrade** of
`exceljs` to `3.4.0` (`isSemVerMajor: true`), which would move the application
onto an older major of the export library and is not a defensible remediation.

---

## Finding 2 — `tmp` via `exceljs`

**Advisory.** GHSA-ph9p-34f9-6g65, CVE-2026-44705, GitHub severity **high**,
**no published CVSS**. Summary: *"tmp has Path Traversal via unsanitized
prefix/postfix that enables directory escape."* Vulnerable `< 0.2.6`; patched
`0.2.6`. Installed `tmp@0.2.5`.

**Reachability:**

1. The only `exceljs` consumer of `tmp` is
   `lib/stream/xlsx/workbook-reader.js` — the streaming **reader**. Dubiz uses
   the writer path only, as established above, so this module is not exercised.
2. Even in that module, `exceljs` calls `tmp.file(callback)` with **no options
   object**. The vulnerability requires a caller-supplied `prefix` or `postfix`;
   `exceljs` supplies neither, so there is no input to traverse with.
3. Dubiz does not import `tmp` directly.

**Classification: C (no CVSS >= 7.0 published, so below the CASA threshold) and
independently B (the vulnerable input path is never supplied).** A patched
version exists upstream; adopting it would require an `overrides` pin, which is
a dependency change and is not required by 6.1.1.

---

## Finding 3 — `deepmerge-ts` via the Prisma chain (the historical chain, still present)

The historical Prisma/`deepmerge` chain **still exists** and is recorded here as
current rather than treated as resolved.

**Advisory.** GHSA-ggr8-5vv4-36mx, CVE-2026-40345, GitHub severity **high**,
**no published CVSS**. Summary: *"DeepmergeTS has stack exhaustion when merging
recursive object graphs."* Vulnerable `< 8.0.0`; patched `8.0.0`. Installed
`deepmerge-ts@7.1.5`.

**Path.** `@prisma/client@6.19.3` declares `prisma` as a **peer dependency**
(`peerDependencies: { prisma: "*", typescript: ">=5.1.0" }`), not as a runtime
dependency. npm installs peer dependencies by default, which is why the CLI
package and its own dependency `@prisma/config@6.19.3 → deepmerge-ts@7.1.5`
appear outside the dev-only set in the lockfile.

**Reachability:**

1. **No application code imports the `prisma` CLI package.** A search across
   `app/`, `lib/` and `components/` for an import of `prisma` (as distinct from
   `@prisma/client`) returns zero results. The runtime client is reached
   exclusively through the canonical `lib/prisma.ts`.
2. **No application code imports `@prisma/config` or any deepmerge package.**
3. `deepmerge-ts` is used by `@prisma/config` to merge Prisma CLI configuration.
   That runs when the CLI loads a config file, i.e. at migration and generation
   time, not while serving a request. **The repository contains no
   `prisma.config.*` file at all**, so even the CLI path has no user config to
   merge.
4. The impact is stack exhaustion from a recursive object graph — a
   denial-of-service shape that would require attacker-controlled input into a
   configuration merge. No such input path exists.

**Classification: C (no published CVSS, therefore below the CASA threshold) and
D (build/CLI-time dependency reached through a peer install, not at runtime).**
The npm-proposed fix is a **downgrade** of `prisma` to `6.12.0`
(`isSemVerMajor: true`), which would break compatibility with the installed
`@prisma/client@6.19.3` and is not a defensible remediation.

---

## Finding 4 — `dompurify` via `jspdf`

**Advisories.** Ten, against `dompurify@3.4.1`, reached through `jspdf@4.2.1`.
Highest published score is **6.1** (CVE-2026-49458, CVE-2026-49459,
CVE-2026-65902, all `CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N`); the
remaining seven carry no published CVSS. All concern DOM sanitisation bypasses,
predominantly in `IN_PLACE` mode.

**Classification: C — below the CASA 6.1.1 threshold of 7.0.**

Supporting context, offered for completeness rather than as the basis for the
classification: `jspdf` pulls `dompurify` for its optional HTML-to-PDF rendering
path. Dubiz's only `jspdf` consumer is
[`lib/utils/generate-supplier-pdf.ts`](../lib/utils/generate-supplier-pdf.ts),
and there are no calls to a jsPDF `.html()` method anywhere in the application,
so the sanitiser is not exercised. `jspdf@4.2.1` is the latest published
version.

---

## Reachability conclusions

| Finding | CVSS >= 7.0 | In production graph | Vulnerable code invoked | Attacker-controlled input | Patched upstream path |
| --- | --- | --- | --- | --- | --- |
| `uuid` | **yes (7.5)** | yes | **no** — only `v4()`, no `buf` | no | **no** — `exceljs@4.4.0` is latest and pins `^8.3.0` |
| `tmp` | no (unscored) | yes | no — reader path unused; no prefix/postfix passed | no | yes, via override only |
| `deepmerge-ts` | no (unscored) | yes (peer install) | no — CLI config merge; no config file present | no | no (proposed "fix" is a downgrade) |
| `dompurify` | no (6.1) | yes | no — no `.html()` usage | no | no (`jspdf@4.2.1` is latest) |

---

## Residual risk

The residual risk carried by this baseline is low and is stated plainly rather
than argued away:

- **`uuid@8.3.2` remains in the production dependency graph.** If a future
  change introduces a direct call to `uuid.v3()`, `v5()` or `v6()` with a
  caller-supplied buffer — in application code or through a new `exceljs`
  code path — the non-invocation argument in this memo becomes void. The
  argument is a statement about today's call graph, not a permanent property.
- **`tmp@0.2.5` becomes relevant if Dubiz ever adopts the `exceljs` streaming
  reader** to parse uploaded spreadsheets. That would place a
  temporary-file path in a request-handling flow.
- **`deepmerge-ts@7.1.5` becomes relevant if a `prisma.config.*` file is added**
  and its contents ever derive from untrusted input.
- The dev-only findings (`js-yaml`, `browserslist`, `@babel/core`) affect the
  build environment. They are not shipped, but a compromised build host remains
  a supply-chain consideration outside 6.1.1's scope.

None of these is a present exposure. Each is a condition under which this
evidence would need to be re-derived.

---

## Evidence boundaries

1. **This is a point-in-time scan.** The inventory is valid for `0123c15` and
   the advisory database as of 2026-09-02. New advisories against already
   installed versions can change the picture without any code change here.
2. **No SCA automation is claimed.** There is no Dependabot configuration and no
   dependency scan wired into CI. AL1 evidence for 6.1.1 is the scan output,
   which this memo provides; continuous scanning is a maturity improvement, not
   a requirement this memo claims to satisfy.
3. **Unscored advisories are reported as unscored.** `tmp` and `deepmerge-ts`
   carry GitHub severity "high" with no published CVSS. They are classified
   below the CASA threshold on that basis, and each is *additionally* given a
   reachability argument so the classification does not rest on the absence of a
   score alone.
4. **Reachability was established by static analysis** of the current source and
   the installed package contents — import graphs and call sites — not by
   runtime instrumentation.
5. **The `uuid` exemption is narrow by construction.** It claims only that the
   specific vulnerable functions are never called with the argument that
   triggers the defect. It does not claim the package is safe in general.

---

## Conclusion

Against CASA 6.1.1 as validated for this program:

- The production dependency graph at `0123c15` contains **one** finding with a
  published CVSS at or above 7.0: `uuid@8.3.2`, CVE-2026-41907, CVSS 7.5.
- That finding qualifies for the requirement's **explicit exemption on both
  available grounds** — the application does not invoke the vulnerable code
  (proven by import graph and call-site analysis), and the parent library has
  published no update that moves off the vulnerable major.
- Four of the five findings that met the threshold at the original audit
  baseline were **fixed by upgrade** in Wave C; they are recorded as fixed, not
  as exempted.
- The remaining production findings are **below the CVSS 7.0 threshold** or
  carry no published CVSS, and each additionally has a documented
  non-reachability argument.
- **No further dependency remediation is required to satisfy CASA 6.1.1** at
  this baseline.

This document makes **no claim** that an external CASA assessor has reviewed or
accepted this evidence, no claim of a Letter of Validation, and no claim that
Google OAuth verification is complete. It records the implementer's evidence for
CASA requirement 6.1.1 as of 2026-09-02, for submission and assessor review.

---

## Change history

| Date | Change |
| --- | --- |
| 2026-09-02 | v1 — initial dependency evidence record at `0123c15`, following the Wave C Next.js upgrade. |
