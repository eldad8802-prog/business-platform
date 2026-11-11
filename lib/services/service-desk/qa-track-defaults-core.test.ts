/**
 * Run: npx tsx lib/services/service-desk/qa-track-defaults-core.test.ts
 *
 * The business's default QA list per service track (pure): the PUT body, the change decision (a list of THIS business,
 * active, NO_CHANGE, clearing), the opening's resolution (explicit list / explicit none win; the default only with a
 * track, QA not OFF, the list active — archived = no default; the CURRENT version pinned; REQUIRED without a list keeps
 * the built-in template), the journal payload (tokens and numbers only) and the read model's reason.
 */
import {
  decideDefaultChange,
  isTrackToken,
  openingChoicePayload,
  parseOpeningQaList,
  parseSetDefault,
  resolveOpeningQaList,
  viewReason,
  type ListState,
  type OpeningQaRequest,
} from "./qa-track-defaults.core";
import { choicePayload } from "./qa-lists.core";
import { SERVICE_TRACKS, type QaMode } from "./service-profiles";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`OK: ${name}`); } else { failures.push(name); console.log(`FAIL: ${name}${detail ? " — " + detail : ""}`); }
}
const field = (r: { ok: boolean; field?: string }) => (r.ok ? "OK" : (r as { field: string }).field);

// ── P: the PUT body ─────────────────────────────────────────────────────────────────────────────────────────
ok("P1 the seven tracks and nothing else", SERVICE_TRACKS.every(isTrackToken) && !isTrackToken("T0") && !isTrackToken("T8") && !isTrackToken("t1") && !isTrackToken(1) && !isTrackToken(null));
ok("P2 a list id and the revision read", field(parseSetDefault({ listId: 5, expectedRevision: 0 })) === "OK" && field(parseSetDefault({ listId: 5, expectedRevision: 3 })) === "OK");
ok("P3 null = no default", (() => { const r = parseSetDefault({ listId: null, expectedRevision: 2 }); return r.ok && r.value.listId === null; })());
ok("P4 listId missing, 0, negative, fractional or a string → listId",
  [{}, { listId: 0 }, { listId: -1 }, { listId: 1.5 }, { listId: "5" }].every((b) => field(parseSetDefault({ ...b, expectedRevision: 0 })) === "listId"));
ok("P5 expectedRevision missing, negative, fractional or a string → expectedRevision",
  [undefined, -1, 0.5, "1", null].every((e) => field(parseSetDefault({ listId: 1, expectedRevision: e })) === "expectedRevision"));
ok("P6 an unknown field is refused, never ignored", field(parseSetDefault({ listId: 1, expectedRevision: 0, version: 2 })) === "version");

// ── D: the change decision ──────────────────────────────────────────────────────────────────────────────────
const found = { found: true, archived: false };
ok("D1 the first default names an active list", (() => { const d = decideDefaultChange({ current: null, listId: 7, target: found }); return d.ok && d.listId === 7; })());
ok("D2 a list not found in THIS business (another business's id, a wrong id) → QA_LIST_NOT_FOUND",
  JSON.stringify(decideDefaultChange({ current: null, listId: 7, target: { found: false, archived: false } })) === JSON.stringify({ ok: false, violations: ["QA_LIST_NOT_FOUND"] }));
ok("D3 an archived list → QA_LIST_ARCHIVED", JSON.stringify(decideDefaultChange({ current: { listId: 1 }, listId: 7, target: { found: true, archived: true } })) === JSON.stringify({ ok: false, violations: ["QA_LIST_ARCHIVED"] }));
ok("D4 the same list again → NO_CHANGE", JSON.stringify(decideDefaultChange({ current: { listId: 7 }, listId: 7, target: found })) === JSON.stringify({ ok: false, violations: ["NO_CHANGE"] }));
ok("D5 clearing a default → none", (() => { const d = decideDefaultChange({ current: { listId: 7 }, listId: null, target: null }); return d.ok && d.listId === null; })());
ok("D6 clearing what was never set, or is already cleared → NO_CHANGE",
  !decideDefaultChange({ current: null, listId: null, target: null }).ok && !decideDefaultChange({ current: { listId: null }, listId: null, target: null }).ok);
ok("D7 switching to another active list", decideDefaultChange({ current: { listId: 7 }, listId: 8, target: found }).ok);
ok("D8 a missing target object for a list id is NOT_FOUND (fail closed)", JSON.stringify(decideDefaultChange({ current: null, listId: 3, target: null })) === JSON.stringify({ ok: false, violations: ["QA_LIST_NOT_FOUND"] }));

// ── O: the opening ──────────────────────────────────────────────────────────────────────────────────────────
ok("O1 qaListId: absent → DEFAULT, null → NONE, an id → LIST; anything else refused",
  JSON.stringify(parseOpeningQaList(undefined)) === JSON.stringify({ ok: true, value: { kind: "DEFAULT" } })
    && JSON.stringify(parseOpeningQaList(null)) === JSON.stringify({ ok: true, value: { kind: "NONE" } })
    && JSON.stringify(parseOpeningQaList(4)) === JSON.stringify({ ok: true, value: { kind: "LIST", listId: 4 } })
    && [0, -2, 1.5, "4", true, {}].every((v) => field(parseOpeningQaList(v)) === "qaListId"));
const L = (id: number, v: number, archived = false): ListState => ({ listId: id, currentVersion: v, archived });
const all = { lists: true, defaults: true };
const res = (request: OpeningQaRequest, o: { mode?: QaMode; track?: "T1" | "T3" | null; explicit?: ListState | null; def?: ListState | null; available?: { lists: boolean; defaults: boolean } } = {}) =>
  resolveOpeningQaList({ request, mode: o.mode ?? "REQUIRED", track: o.track === undefined ? "T1" : o.track, explicitList: o.explicit ?? null, defaultList: o.def ?? null, available: o.available ?? all });
const DEF: OpeningQaRequest = { kind: "DEFAULT" };
ok("O2 the default's CURRENT version is pinned", JSON.stringify(res(DEF, { def: L(5, 3) })) === JSON.stringify({ ok: true, to: { listId: 5, listVersion: 3 }, reason: "DEFAULT" }));
ok("O3 on an OPTIONAL track too", JSON.stringify(res(DEF, { mode: "OPTIONAL", def: L(5, 1) })) === JSON.stringify({ ok: true, to: { listId: 5, listVersion: 1 }, reason: "DEFAULT" }));
ok("O4 QA OFF on the track: the default is ignored", JSON.stringify(res(DEF, { mode: "OFF", def: L(5, 1) })) === JSON.stringify({ ok: true, to: null, reason: "QA_OFF" }));
ok("O5 no default: no list (REQUIRED keeps the built-in template)", JSON.stringify(res(DEF, { mode: "REQUIRED" })) === JSON.stringify({ ok: true, to: null, reason: "NO_DEFAULT" }));
ok("O6 an archived default counts as no default (said so)", JSON.stringify(res(DEF, { def: L(5, 2, true) })) === JSON.stringify({ ok: true, to: null, reason: "DEFAULT_ARCHIVED" }));
ok("O7 a case without a track has no track default", JSON.stringify(res(DEF, { track: null, def: L(5, 2) })) === JSON.stringify({ ok: true, to: null, reason: "NO_TRACK" }));
ok("O8 before the migrations: today's behaviour (no list)", JSON.stringify(res(DEF, { def: L(5, 2), available: { lists: true, defaults: false } })) === JSON.stringify({ ok: true, to: null, reason: "NOT_AVAILABLE" })
  && JSON.stringify(res(DEF, { def: L(5, 2), available: { lists: false, defaults: false } })) === JSON.stringify({ ok: true, to: null, reason: "NOT_AVAILABLE" }));
ok("O9 an explicit list overrides the default (its current version)", JSON.stringify(res({ kind: "LIST", listId: 9 }, { explicit: L(9, 4), def: L(5, 2) })) === JSON.stringify({ ok: true, to: { listId: 9, listVersion: 4 }, reason: "EXPLICIT" }));
ok("O10 explicitly none overrides the default — even on a REQUIRED track (the template then)", JSON.stringify(res({ kind: "NONE" }, { mode: "REQUIRED", def: L(5, 2) })) === JSON.stringify({ ok: true, to: null, reason: "EXPLICIT_NONE" }));
ok("O11 an explicit list not found in this business → QA_LIST_NOT_FOUND", JSON.stringify(res({ kind: "LIST", listId: 9 }, { explicit: null })) === JSON.stringify({ ok: false, violations: ["QA_LIST_NOT_FOUND"] }));
ok("O12 an explicit list read under another id is not trusted → QA_LIST_NOT_FOUND", JSON.stringify(res({ kind: "LIST", listId: 9 }, { explicit: L(8, 1) })) === JSON.stringify({ ok: false, violations: ["QA_LIST_NOT_FOUND"] }));
ok("O13 an explicit archived list → QA_LIST_ARCHIVED", JSON.stringify(res({ kind: "LIST", listId: 9 }, { explicit: L(9, 1, true) })) === JSON.stringify({ ok: false, violations: ["QA_LIST_ARCHIVED"] }));
ok("O14 an explicit list where the track's QA is OFF → QA_NOT_FOR_KIND", JSON.stringify(res({ kind: "LIST", listId: 9 }, { mode: "OFF", explicit: L(9, 1) })) === JSON.stringify({ ok: false, violations: ["QA_NOT_FOR_KIND"] }));
ok("O15 explicitly none where QA is OFF is fine", res({ kind: "NONE" }, { mode: "OFF" }).ok);
ok("O16 the default is read but never another business's (the resolver takes only what the store read in this business)",
  JSON.stringify(res(DEF, { def: null })) === JSON.stringify({ ok: true, to: null, reason: "NO_DEFAULT" }));

// ── J: the journal payload ──────────────────────────────────────────────────────────────────────────────────
const pl = openingChoicePayload({ listId: 12, listVersion: 3 }, "DEFAULT");
ok("J1 the opening's choice payload carries #1124's fields (listId / listVersion read by the deferred guard) + its source",
  pl.listId === 12 && pl.listVersion === 3 && pl.fromListId === null && pl.fromListVersion === null && pl.atOpening === true && pl.source === "DEFAULT"
    && Object.keys(choicePayload(null, { listId: 12, listVersion: 3 })).every((k) => k in pl)
    && openingChoicePayload({ listId: 1, listVersion: 1 }, "EXPLICIT").source === "EXPLICIT");
ok("J2 numbers, booleans, nulls and short tokens only (ServiceCaseEvent_payload_closed)",
  Object.values(openingChoicePayload({ listId: 2147483647, listVersion: 2147483647 }, "EXPLICIT")).every((v) => v === null || typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && /^[A-Za-z0-9_:.-]{0,64}$/.test(v))));

// ── V: the read model ───────────────────────────────────────────────────────────────────────────────────────
ok("V1 the view's reason follows the opening's order", viewReason(5, { archived: false }, "REQUIRED") === "DEFAULT" && viewReason(5, { archived: true }, "REQUIRED") === "DEFAULT_ARCHIVED"
  && viewReason(null, null, "REQUIRED") === "NO_DEFAULT" && viewReason(5, { archived: false }, "OFF") === "QA_OFF" && viewReason(5, { archived: true }, "OFF") === "QA_OFF"
  && viewReason(5, null, "OPTIONAL") === "NO_DEFAULT");

console.log(`\nqa-track-defaults-core: ${pass} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
