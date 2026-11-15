/**
 * Run: npx tsx lib/services/service-desk/service-profiles.test.ts
 *
 * Stage 1 (PR-B0) — the service profile and track catalog, pure proofs (no database, no network, no clock):
 *   - the catalog equals the planning matrix (8 profiles × 7 tracks: ★ default, ✓ enabled, every other track "+");
 *   - profile resolution: owner choice → sub-category → category → general;
 *   - the three fixed requirements wherever the item is at the business (owner-confirmed intake, QA, owner-confirmed
 *     handover — C1; owner decision 2026-11-11: no customer signature anywhere);
 *   - D15 approval levels; T7 rows per resolution (exchange keeps QA with EXCHANGE.v1);
 *   - owner overrides: tightening allowed, loosening a fixed requirement refused, never silently dropped;
 *   - the snapshot (D14) is frozen, serialisable, deterministic and unaffected by later settings (D17);
 *   - track suggestions keep every track reachable;
 *   - the module is pure and not wired into the product yet.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  AFTER_SALE_RESOLUTIONS,
  PROFILES,
  RETURN_REASONS,
  SERVICE_PROFILE_KEYS,
  SERVICE_TRACKS,
  TERM_SLOTS,
  TRACKS,
  buildProfileSnapshot,
  isTrackEnabled,
  requirementsFromSnapshot,
  resolveProfileKey,
  suggestTracks,
  suggestedResolution,
  validateOverrides,
  type ProfileSnapshot,
  type ServiceProfileKey,
  type ServiceTrack,
} from "./service-profiles";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`OK: ${name}`); } else { failures.push(name); console.log(`FAIL: ${name}${detail ? " — " + detail : ""}`); }
}
function snap(key: ServiceProfileKey, overrides?: Parameters<typeof buildProfileSnapshot>[1]): ProfileSnapshot {
  const r = buildProfileSnapshot(key, overrides);
  if (!r.ok) throw new Error(`snapshot refused for ${key}: ${JSON.stringify(r.violations)}`);
  return r.snapshot;
}
const codes = (key: ServiceProfileKey, o: unknown) => validateOverrides(key, o as never).map((v) => v.code);

// ── P1 catalog shape ───────────────────────────────────────────────────────────────────────────────────────────────
ok("P1 eight profiles, keyed by their own key", SERVICE_PROFILE_KEYS.length === 8 && SERVICE_PROFILE_KEYS.every((k) => PROFILES[k].key === k));
ok("P1 seven tracks, each with a work type and a location", SERVICE_TRACKS.length === 7 && SERVICE_TRACKS.every((t) => TRACKS[t].track === t));
ok("P1 every profile: default and enabled tracks are real and disjoint; all six term slots filled",
  SERVICE_PROFILE_KEYS.every((k) => {
    const p = PROFILES[k];
    const all = [...p.defaultTracks, ...p.enabledTracks];
    return all.every((t) => (SERVICE_TRACKS as readonly string[]).includes(t)) && new Set(all).size === all.length
      && TERM_SLOTS.every((s) => typeof p.terms[s] === "string" && /^[a-z_]{2,40}$/.test(p.terms[s]));
  }));

// ── P2 the matrix (planning doc, section יג table 1) ───────────────────────────────────────────────────────────────
const MATRIX: Record<ServiceProfileKey, string> = {
  // T1 T2 T3 T4 T5 T6 T7 — ★ default, ✓ enabled, + available
  jewelry:         "★+++✓+★",
  device_lab:      "★+✓++✓★",
  garage:          "+★✓+++✓",
  home_technician: "++★✓++✓",
  installer:       "++✓★+✓✓",
  professional:    "++++★✓+",
  general:         "✓+✓+✓✓✓",
  remote_it:       "++✓++★+",
};
for (const k of SERVICE_PROFILE_KEYS) {
  const row = SERVICE_TRACKS.map((t) => (PROFILES[k].defaultTracks.includes(t) ? "★" : PROFILES[k].enabledTracks.includes(t) ? "✓" : "+")).join("");
  ok(`P2 ${k} matches the matrix row ${MATRIX[k]}`, row === MATRIX[k], row);
}

// ── P3 resolution ──────────────────────────────────────────────────────────────────────────────────────────────────
ok("P3 the owner's explicit choice wins over the category", resolveProfileKey({ serviceProfileKey: "garage", category: "Retail", subCategory: "Jewelry" }) === "garage");
ok("P3 an unknown stored choice falls through, never fails", resolveProfileKey({ serviceProfileKey: "spaceship", subCategory: "Plumbing" }) === "home_technician");
ok("P3 sub-category before category", resolveProfileKey({ category: "Automotive", subCategory: "Mobile Phones" }) === "device_lab");
ok("P3 existing values map: Repairs → device_lab, AC / Plumbing / Electrical → home_technician, Jewelry → jewelry",
  resolveProfileKey({ category: "Home Services", subCategory: "Repairs" }) === "device_lab"
    && ["Air Conditioning", "Plumbing", "Electrical"].every((s) => resolveProfileKey({ category: "Home Services", subCategory: s }) === "home_technician")
    && resolveProfileKey({ category: "Retail", subCategory: "Jewelry" }) === "jewelry");
ok("P3 category-level mapping when the sub-category is unknown", resolveProfileKey({ category: "IT Services", subCategory: "Something" }) === "remote_it");
ok("P3 everything else, empty or missing → general",
  resolveProfileKey({ category: "Beauty", subCategory: "Nails" }) === "general" && resolveProfileKey({}) === "general"
    && resolveProfileKey({ category: null, subCategory: null, serviceProfileKey: null }) === "general"
    && resolveProfileKey({ category: "  ", subCategory: "" }) === "general");
ok("P3 surrounding spaces in stored values are ignored", resolveProfileKey({ subCategory: "  Plumbing " }) === "home_technician" && resolveProfileKey({ serviceProfileKey: " jewelry " }) === "jewelry");
ok("P3 prototype keys are not categories", resolveProfileKey({ category: "constructor", subCategory: "toString" }) === "general");

// ── P4 fixed requirements where the item is at the business (C1 + today's code) ─────────────────────────────────────
for (const k of SERVICE_PROFILE_KEYS) {
  const s = snap(k);
  const held = SERVICE_TRACKS.filter((t) => TRACKS[t].itemAtBusiness);
  ok(`P4 ${k}: T1 / T2 / T7 — owner-confirmed intake, QA REQUIRED, owner-confirmed handover`,
    held.length === 3 && held.every((t) => {
      const r = requirementsFromSnapshot(s, t);
      return r.intakeConfirmation === "OWNER" && r.qa.mode === "REQUIRED" && r.qa.template !== null && r.handoverByOwner && r.completion === "OWNER_HANDOVER";
    }));
  ok(`P4 ${k}: T7 exchange keeps QA with the short EXCHANGE.v1 checklist (C1)`,
    requirementsFromSnapshot(s, "T7", "EXCHANGE").qa.mode === "REQUIRED" && requirementsFromSnapshot(s, "T7", "EXCHANGE").qa.template === "EXCHANGE.v1");
  ok(`P4 ${k}: T7 credit — owner-confirmed intake, no handover, the owner's confirmation with the credit document`,
    (() => { const r = requirementsFromSnapshot(s, "T7", "CREDIT"); return r.intakeConfirmation === "OWNER" && !r.handoverByOwner && r.completion === "OWNER_WITH_CREDIT_DOCUMENT"; })());
  ok(`P4 ${k}: T7 returning the original — owner-confirmed intake and handover`,
    (() => { const r = requirementsFromSnapshot(s, "T7", "RETURN_ORIGINAL"); return r.intakeConfirmation === "OWNER" && r.handoverByOwner; })());
}
ok("P4 on site / remote / professional: no intake signature, no handover", SERVICE_PROFILE_KEYS.every((k) => {
  const s = snap(k);
  return (["T3", "T4", "T5", "T6"] as ServiceTrack[]).every((t) => requirementsFromSnapshot(s, t).intakeConfirmation === "NONE" && !requirementsFromSnapshot(s, t).handoverByOwner);
}));
ok("P4 every T7 resolution has a row", SERVICE_PROFILE_KEYS.every((k) => AFTER_SALE_RESOLUTIONS.every((r) => requirementsFromSnapshot(snap(k), "T7", r) !== undefined)));

// ── P5 D15 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
ok("P5 device_lab T1 and garage T2 keep today's rule: approval ALWAYS",
  requirementsFromSnapshot(snap("device_lab"), "T1").workApproval === "ALWAYS" && requirementsFromSnapshot(snap("garage"), "T2").workApproval === "ALWAYS");
ok("P5 everywhere else a repair step is BY_D15 (only with a quote or a money commitment)",
  SERVICE_PROFILE_KEYS.every((k) => SERVICE_TRACKS.every((t) => {
    const r = requirementsFromSnapshot(snap(k), t).workApproval;
    return (k === "device_lab" && t === "T1") || (k === "garage" && t === "T2") ? r === "ALWAYS" : r === "BY_D15";
  })));
ok("P5 NONE only where the path has no repair step (credit, returning the original)",
  SERVICE_PROFILE_KEYS.every((k) => requirementsFromSnapshot(snap(k), "T7", "CREDIT").workApproval === "NONE"
    && requirementsFromSnapshot(snap(k), "T7", "RETURN_ORIGINAL").workApproval === "NONE"
    && requirementsFromSnapshot(snap(k), "T7", "EXCHANGE").workApproval === "BY_D15"));

// ── P6 overrides refused ───────────────────────────────────────────────────────────────────────────────────────────
ok("P6 QA cannot be loosened where the item is at the business (T1 / T2 / T7)",
  (["T1", "T2", "T7"] as const).every((t) => codes("general", { requirements: { [t]: { qaMode: "OPTIONAL" } } }).includes("FIXED_REQUIREMENT")
    && codes("general", { requirements: { [t]: { qaMode: "OFF" } } }).includes("FIXED_REQUIREMENT")));
ok("P6 an owner-confirmed handover of a held item cannot be replaced", codes("jewelry", { requirements: { T1: { completion: "OWNER_CONFIRMATION" } } }).includes("FIXED_REQUIREMENT"));
ok("P6 approval never below D15", codes("home_technician", { requirements: { T3: { workApproval: "NONE" } } }).includes("BELOW_D15"));
ok("P6 an on-site completion cannot become a handover or a credit document", codes("home_technician", { requirements: { T3: { completion: "OWNER_HANDOVER" } } }).includes("COMPLETION_NOT_ALLOWED")
  && codes("home_technician", { requirements: { T3: { completion: "OWNER_WITH_CREDIT_DOCUMENT" } } }).includes("COMPLETION_NOT_ALLOWED"));
ok("P6 the removed signature proofs are unknown values now (owner decision: no customer signature)",
  ["HANDOVER_SIGNED", "CUSTOMER_SIGNATURE", "NAME_AND_PROFESSIONAL", "REMOTE_CONFIRMATION"].every((c) => codes("home_technician", { requirements: { T3: { completion: c as never } } }).includes("INVALID_VALUE")));
ok("P6 QA cannot be raised where the track has no checklist", codes("professional", { requirements: { T5: { qaMode: "REQUIRED" } } }).includes("NO_QA_TEMPLATE"));
ok("P6 unknown keys, tracks, slots and values are refused",
  codes("general", { colour: "red" }).includes("UNKNOWN_KEY")
    && codes("general", { enabledTracks: ["T9"] }).includes("UNKNOWN_TRACK")
    && codes("general", { requirements: { T9: {} } }).includes("UNKNOWN_TRACK")
    && codes("general", { requirements: { T3: { colour: "red" } } }).includes("UNKNOWN_KEY")
    && codes("general", { requirements: { T3: { qaMode: "SOMETIMES" } } }).includes("INVALID_VALUE")
    && codes("general", { terms: { mood: "שמח" } }).includes("UNKNOWN_TERM_SLOT"));
ok("P6 terms: blank, padded, over 40 characters or with control characters are refused",
  ["", "  ", " טכנאי", "א".repeat(41), "טכ\nנאי"].every((t) => codes("general", { terms: { professional: t } }).includes("INVALID_TERM")));
ok("P6 a malformed overrides object is refused", codes("general", [] as unknown).includes("INVALID_SHAPE") && codes("general", { enabledTracks: "T3" }).includes("INVALID_SHAPE"));
ok("P6 a refused override builds no snapshot at all", (() => {
  const r = buildProfileSnapshot("general", { enabledTracks: ["T2"], requirements: { T1: { qaMode: "OFF" } } });
  return !r.ok && r.violations.length === 1;
})());

// ── P7 overrides allowed ───────────────────────────────────────────────────────────────────────────────────────────
ok("P7 tightening is always allowed (T3 QA OPTIONAL → REQUIRED); every on-site / remote / professional row completes by owner confirmation",
  requirementsFromSnapshot(snap("home_technician", { requirements: { T3: { qaMode: "REQUIRED" } } }), "T3").qa.mode === "REQUIRED"
    && (["T3", "T4", "T5", "T6"] as const).every((t) => requirementsFromSnapshot(snap("general"), t).completion === "OWNER_CONFIRMATION"));
ok("P7 the owner may loosen on-site QA; restating the owner confirmation is accepted",
  requirementsFromSnapshot(snap("installer", { requirements: { T4: { qaMode: "OPTIONAL" } } }), "T4").qa.mode === "OPTIONAL"
    && requirementsFromSnapshot(snap("home_technician", { requirements: { T3: { completion: "OWNER_CONFIRMATION" } } }), "T3").completion === "OWNER_CONFIRMATION");
ok("P7 no requirement anywhere names a customer signature (owner decision 2026-11-11)",
  !/SIGNATURE|SIGNED|signature/.test(JSON.stringify((["T1", "T2", "T3", "T4", "T5", "T6", "T7"] as const).map((t) => requirementsFromSnapshot(snap("general"), t)))));
ok("P7 approval ALWAYS may relax to BY_D15, never further",
  requirementsFromSnapshot(snap("device_lab", { requirements: { T1: { workApproval: "BY_D15" } } }), "T1").workApproval === "BY_D15");
ok("P7 the owner can enable any other track; the profile's own tracks stay enabled",
  (() => { const s = snap("jewelry", { enabledTracks: ["T3", "T6"] }); return ["T1", "T7", "T5", "T3", "T6"].every((t) => isTrackEnabled(s, t as ServiceTrack)) && !isTrackEnabled(s, "T2"); })());
ok("P7 owner wording is kept next to the term id", (() => {
  const s = snap("jewelry", { terms: { professional: "צורף ראשי" } });
  return s.terms.professional.custom === "צורף ראשי" && s.terms.professional.id === "jeweler" && s.terms.case.custom === null;
})());

// ── P8 the snapshot (D14 / D17) ────────────────────────────────────────────────────────────────────────────────────
const s1 = snap("installer");
ok("P8 deep-frozen", Object.isFrozen(s1) && Object.isFrozen(s1.requirements) && Object.isFrozen(s1.requirements.T4) && Object.isFrozen(s1.requirements.T4.qa) && Object.isFrozen(s1.enabledTracks));
ok("P8 serialisable: JSON round trip is identical", JSON.stringify(JSON.parse(JSON.stringify(s1))) === JSON.stringify(s1));
ok("P8 deterministic: the same input gives the same snapshot", JSON.stringify(snap("installer")) === JSON.stringify(s1));
ok("P8 a later, different setting does not touch an existing snapshot (D17)", (() => {
  const before = JSON.stringify(s1);
  snap("installer", { requirements: { T4: { qaMode: "OPTIONAL" } }, enabledTracks: ["T2"] });
  return JSON.stringify(s1) === before && requirementsFromSnapshot(s1, "T4").qa.mode === "REQUIRED";
})());
ok("P8 every track's rules are in the snapshot, so a change of track before work (D3) reads the same frozen rules",
  SERVICE_TRACKS.every((t) => s1.requirements[t] !== undefined) && AFTER_SALE_RESOLUTIONS.every((r) => s1.afterSale[r] !== undefined));
ok("P8 the snapshot carries its version and profile", s1.version === 1 && s1.profileKey === "installer");
ok("P8 the inputs are not mutated", (() => {
  const o = { enabledTracks: ["T3"], terms: { case: "קריאה" }, requirements: { T3: { qaMode: "REQUIRED" as const } } };
  const copy = JSON.stringify(o);
  snap("general", o);
  return JSON.stringify(o) === copy;
})());

// ── P9 suggestions (section יד) ────────────────────────────────────────────────────────────────────────────────────
for (const k of SERVICE_PROFILE_KEYS) {
  const list = suggestTracks(snap(k));
  ok(`P9 ${k}: every track appears exactly once`, list.length === 7 && new Set(list.map((x) => x.track)).size === 7);
  ok(`P9 ${k}: ★ tracks first, then enabled, then available`, (() => {
    const order = { CONTEXT: 0, DEFAULT: 1, ENABLED: 2, AVAILABLE: 3 } as const;
    return list.every((x, i) => i === 0 || order[list[i - 1].reason] <= order[x.reason])
      && list.filter((x) => x.reason === "AVAILABLE").every((x) => !x.enabled)
      && list.filter((x) => x.reason !== "AVAILABLE").every((x) => x.enabled);
  })());
}
ok("P9 opening from a sale puts T7 first when it is enabled", suggestTracks(snap("jewelry"), { fromSale: true })[0].track === "T7"
  && suggestTracks(snap("jewelry"), { fromSale: true })[0].reason === "CONTEXT");
ok("P9 context never promotes a track the business has not enabled",
  (() => { const l = suggestTracks(snap("professional"), { customerHasVehicle: true }); return l[0].track === "T5" && l.find((x) => x.track === "T2")?.reason === "AVAILABLE"; })());
ok("P9 general has no ★, so its enabled tracks come first in track order",
  suggestTracks(snap("general")).slice(0, 5).map((x) => x.track).join() === "T1,T3,T5,T6,T7");

// ── P10 AFTER_SALE reasons (D18a) ──────────────────────────────────────────────────────────────────────────────────
ok("P10 every reason suggests a resolution", RETURN_REASONS.every((r) => AFTER_SALE_RESOLUTIONS.includes(suggestedResolution(r))));
ok("P10 wrong item / change of mind / legal cancellation suggest an exchange; a defect suggests a repair",
  suggestedResolution("WRONG_ITEM") === "EXCHANGE" && suggestedResolution("CHANGE_OF_MIND") === "EXCHANGE"
    && suggestedResolution("LEGAL_CANCELLATION") === "EXCHANGE" && suggestedResolution("DEFECT") === "REPAIR");

// ── P11 purity and stage 1 scope ───────────────────────────────────────────────────────────────────────────────────
const SRC = fs.readFileSync(path.join(__dirname, "service-profiles.ts"), "utf8");
ok("P11 the module imports nothing", !/^\s*import\s/m.test(SRC) && !/require\(/.test(SRC));
ok("P11 no clock, randomness, network or environment", !/\bDate\b|Math\.random|fetch\(|process\.env/.test(SRC));
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (/\.(ts|tsx|mts)$/.test(e.name)) out.push(p);
  }
  return out;
}
const ROOT = path.resolve(__dirname, "../../..");
const importers = ["lib", "app", "features", "components"].flatMap((d) => (fs.existsSync(path.join(ROOT, d)) ? walk(path.join(ROOT, d)) : []))
  .filter((f) => !/service-profiles(\.test)?\.ts$/.test(f) && /service-profiles["']/.test(fs.readFileSync(f, "utf8")));
ok("P11 stage 1: not wired — no product file imports the catalog yet", importers.length === 0, importers.join(", "));

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
