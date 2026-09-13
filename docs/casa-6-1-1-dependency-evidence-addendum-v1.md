# CASA 6.1.1 — Dependency Evidence, Addendum v1

**Status:** addendum to `docs/casa-6-1-1-dependency-evidence-v1.md` (merged as `6bf268c`).
**Baseline:** `cd45af1` — current `main`, and the SHA currently deployed to production.
**Scope:** re-scan only. No dependency was added, removed, upgraded or pinned by this document.

## Why this addendum exists

The base memo recorded a scan taken at `0123c15`. Advisories are published
continuously, so a memo is evidence of a moment, not a standing claim. This
addendum re-runs the same two commands at the current baseline and records what
moved.

The base memo's control objective is unchanged and is restated here because the
delta only means something against it:

> a component vulnerable to a CVE with severity **>= CVSS 7.0**, with an
> exemption where the vulnerable code is **not invoked**, or where the library
> has published no fix.

The criterion is the **published CVSS score**, not `npm audit`'s severity
label. That distinction is load-bearing again below.

## Counts — base memo vs current baseline

| Scan | Base memo (`0123c15`) | Current (`cd45af1`) | Delta |
| --- | --- | --- | --- |
| Full tree, total | 12 | 13 | +1 |
| Full tree, high | 6 | 6 | 0 |
| Full tree, critical | 0 | 0 | 0 |
| Production graph (`--omit=dev`), total | 7 | 8 | +1 |
| Production graph, high | 4 | 4 | 0 |
| Production graph, critical | 0 | 0 | 0 |

No advisory was resolved and no new **high or critical** label appeared. One new
advisory entered the production graph.

## The delta — `fflate`

`fflate@0.8.2`, reached only through `jspdf@4.2.1`.

| Field | Value |
| --- | --- |
| Advisory | GHSA-px8p-9vwx-vf98 |
| Title | `unzipSync` can enter an infinite loop when parsing malformed ZIP64 archives |
| Published CVSS | **7.5** |
| `npm audit` label | `moderate` |
| Fix available | no |

This is exactly the case the base memo warned about in reverse: `npm audit`
labels it **moderate**, but its **published CVSS is 7.5**, which is at or above
the CASA threshold. Read by label it would have been filtered out. It is
therefore recorded here as **CASA-relevant**, and classified **B — relevant but
demonstrably not invoked**, on the following evidence.

**1. The vulnerable function is a decompression entry point.** The advisory is
specific to `unzipSync` parsing a malformed ZIP64 archive.

**2. Dubiz never calls it.** A search across `app/`, `lib/`, `components/`,
`scripts/` and `eval/` for `fflate`, `unzipSync`, `unzlibSync`, `inflateSync`,
`decompress`, `AdmZip`, `yauzl` and `node-stream-zip` returns **no match**.
There is no code path in this application that decompresses an archive at all,
let alone an attacker-supplied one.

**3. The only carrier is PDF generation.** `fflate` has exactly one dependent in
the lockfile: `jspdf`. `jspdf` has exactly one consumer in this repository,
`lib/utils/generate-supplier-pdf.ts`, which imports `jsPDF` to **write** a
document. That path compresses; it never unzips.

**4. The one place Dubiz does create a ZIP does not use `fflate`.** The SHAAM
uniform-file export builds `BKMVDATA.zip` through `archiver@7.0.1`
(`lib/services/billing/uniform/uniform-packaging.ts`). That is also a write
path, and a different library.

**Conclusion.** No untrusted archive is decompressed anywhere in Dubiz, so the
vulnerable code is unreachable. This qualifies for the base memo's stated
non-invocation exemption. No upgrade is proposed, and none is available.

## The base memo's other findings, re-checked

| Package | Installed | Published CVSS | Still present | Classification unchanged |
| --- | --- | --- | --- | --- |
| `uuid` (via `exceljs@4.4.0`) | 8.3.2 | 7.5 | yes | B — not invoked |
| `tmp` (via `exceljs@4.4.0`) | 0.2.5 | unscored | yes | C + B |
| `dompurify` (via `jspdf@4.2.1`) | 3.4.1 | 6.1 max | yes | C — below threshold |
| `exceljs` | 4.4.0 | carrier only | yes | E |

`npm audit` now labels `uuid` and `exceljs` **moderate** where it previously
labelled them high. Their **published** CVSS is unchanged, so their CASA
treatment is unchanged. This is a labelling movement, not a security movement,
and it is recorded so that a future reader does not mistake the lower label for
remediation.

## Build-only advisories

`prisma@6.19.3` and its subtree (`@prisma/config`, `deepmerge-ts`),
`browserslist@4.28.2` (CVSS 7.5), `js-yaml@4.1.1` (CVSS 7.5), `@babel/core`,
`xcode` and `@capacitor/cli` remain **build/CLI-only**. `prisma` is declared in
`devDependencies`; the runtime client is `@prisma/client`. None of these ship in
the deployed runtime, and the two that carry a CVSS at the threshold —
`browserslist` and `js-yaml` — appear only in the full-tree scan and not in the
production graph.

The available fix for the Prisma subtree is `prisma@6.12.0`, which `npm` flags
as a **major, breaking** change and which is a **downgrade** from the installed
6.19.3. It is not applied here.

## Standing position for 6.1.1

**Zero** components in the production graph carry a published CVSS >= 7.0 that
is also invoked by this application. Two carry a published CVSS of 7.5 —
`uuid` and `fflate` — and both are argued under the non-invocation exemption,
each with a source-level search and a single-carrier dependency path.

## Not claimed

No assessor acceptance. No claim that a scanner will agree with the
non-invocation argument without inspecting it. No claim about the dev/build
tree beyond its exclusion from the deployed runtime.

## Reproduction

```
npm audit --package-lock-only
npm audit --package-lock-only --omit=dev
```

Published CVSS values must be read from the advisory record, not from
`npm audit`'s inline `cvss.score`, which is `0` for unscored advisories and
which does not drive `npm`'s own severity label.
