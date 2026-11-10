/**
 * Service Desk — the universal service model's profile and track catalog (planning doc sections ה, ו, יא, יב–יד, כב,
 * כח; owner decisions D7, D8, D14, D15, D17, C1, D23). Code only: pure, no database, no clock, no network.
 *
 * NOT WIRED. Nothing in the product reads this module yet; the case machine (service-case.core.ts), the QA templates
 * and every route behave exactly as before. Stage 3 (PR-B, after migration M1) connects it.
 *
 * Two layers, kept apart (section יב):
 *   - the business PROFILE decides terminology, which tracks are suggested / enabled, and the D8 requirements;
 *   - the case TRACK (T1–T7) is chosen per case, from any track the profile enables.
 * A profile never removes a capability: every track can be enabled by any business (D23, "+" in the matrix).
 *
 * Requirements are data the server will enforce later, never UI hints. Three of them are fixed for every profile
 * because the code already enforces them today, and an override may not loosen them:
 *   - a signed intake when an item enters the business's custody (core: CHECK_IN on IN_SHOP needs the signature);
 *   - a signed handover when such an item is handed back (DB CHECK ServiceHandover_signed);
 *   - QA on every case where the item is at the business (core: IN_SHOP FINISH_REPAIR → QA). Owner decision C1: an
 *     exchange keeps the QA step, with the short EXCHANGE.v1 checklist; the rule for other cases does not change.
 */

export const SERVICE_TRACKS = ["T1", "T2", "T3", "T4", "T5", "T6", "T7"] as const;
export type ServiceTrack = (typeof SERVICE_TRACKS)[number];

export type ServiceWorkType = "REPAIR" | "MAINTENANCE" | "INSTALLATION" | "INSPECTION" | "PROFESSIONAL" | "REMOTE_SUPPORT" | "AFTER_SALE";
export type ServiceLocation = "AT_BUSINESS" | "AT_CUSTOMER" | "FIELD_SITE" | "REMOTE";
export type ServiceSubjectKind = "ITEM" | "VEHICLE" | "SYSTEM" | "NONE";

export type TrackDefinition = {
  track: ServiceTrack;
  workType: ServiceWorkType;
  /** "ANY" = the professional-service track can run anywhere; the case records the actual place. */
  location: ServiceLocation | "ANY";
  subject: ServiceSubjectKind;
  /** The item is in the business's custody during the case — drives the three fixed requirements. */
  itemAtBusiness: boolean;
};

export const TRACKS: Readonly<Record<ServiceTrack, TrackDefinition>> = {
  T1: { track: "T1", workType: "REPAIR", location: "AT_BUSINESS", subject: "ITEM", itemAtBusiness: true },
  T2: { track: "T2", workType: "REPAIR", location: "AT_BUSINESS", subject: "VEHICLE", itemAtBusiness: true },
  T3: { track: "T3", workType: "REPAIR", location: "AT_CUSTOMER", subject: "SYSTEM", itemAtBusiness: false },
  T4: { track: "T4", workType: "INSTALLATION", location: "AT_CUSTOMER", subject: "SYSTEM", itemAtBusiness: false },
  T5: { track: "T5", workType: "PROFESSIONAL", location: "ANY", subject: "NONE", itemAtBusiness: false },
  T6: { track: "T6", workType: "REMOTE_SUPPORT", location: "REMOTE", subject: "NONE", itemAtBusiness: false },
  T7: { track: "T7", workType: "AFTER_SALE", location: "AT_BUSINESS", subject: "ITEM", itemAtBusiness: true },
};

/** AFTER_SALE (T7) reasons — owner decision D18a; the reason picks the suggested resolution, never hides the others. */
export const RETURN_REASONS = ["DEFECT", "NOT_AS_DESCRIBED", "WRONG_ITEM", "CHANGE_OF_MIND", "LEGAL_CANCELLATION", "OTHER"] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];

/** How a T7 case ends (section כח). Each has its own requirement row. */
export const AFTER_SALE_RESOLUTIONS = ["REPAIR", "EXCHANGE", "CREDIT", "RETURN_ORIGINAL"] as const;
export type AfterSaleResolution = (typeof AFTER_SALE_RESOLUTIONS)[number];

export const SERVICE_PROFILE_KEYS = [
  "general",
  "device_lab",
  "garage",
  "home_technician",
  "installer",
  "remote_it",
  "professional",
  "jewelry",
] as const;
export type ServiceProfileKey = (typeof SERVICE_PROFILE_KEYS)[number];

/** Terminology slots (section ו: up to six terms). Values are term ids; the UI maps an id to its dictionary text. */
export const TERM_SLOTS = ["case", "subject", "professional", "work", "intake", "completion"] as const;
export type TermSlot = (typeof TERM_SLOTS)[number];

export type QaMode = "REQUIRED" | "OPTIONAL" | "OFF";
export type IntakeSignature = "REQUIRED" | "NONE";
/** D15: ALWAYS = an approved quote or cover before every repair (today's rule); BY_D15 = only when a quote or a money
 *  commitment exists; NONE = the path has no repair step (credit, returning the item as is). */
export type WorkApproval = "ALWAYS" | "BY_D15" | "NONE";
export type CompletionProof =
  | "HANDOVER_SIGNED"
  | "CUSTOMER_SIGNATURE"
  | "NAME_AND_PROFESSIONAL"
  | "REMOTE_CONFIRMATION"
  | "PROFESSIONAL_CONFIRMATION"
  | "OWNER_WITH_CREDIT_DOCUMENT";

export type Requirements = {
  intakeSignature: IntakeSignature;
  workApproval: WorkApproval;
  qa: { mode: QaMode; template: string | null };
  completion: CompletionProof;
  /** A signed handover of an item back to the customer (ServiceHandover). */
  handoverSigned: boolean;
};

export type ProfileDefinition = {
  key: ServiceProfileKey;
  /** ★ suggested first. */
  defaultTracks: readonly ServiceTrack[];
  /** ✓ enabled without any setting. Every other track is "+": the owner may enable it. */
  enabledTracks: readonly ServiceTrack[];
  terms: Readonly<Record<TermSlot, string>>;
  /** Profile-specific requirement changes on top of the track base (only where the D8 table differs). */
  requirementAdjustments?: Partial<Record<ServiceTrack, Partial<Requirements>>>;
};

const T = (c: string, s: string, p: string, w: string, i: string, done: string): Record<TermSlot, string> => ({
  case: c,
  subject: s,
  professional: p,
  work: w,
  intake: i,
  completion: done,
});

/** Matrix table 1 (section יג) and the D8 table (section יא). */
export const PROFILES: Readonly<Record<ServiceProfileKey, ProfileDefinition>> = {
  general: {
    key: "general",
    defaultTracks: [],
    enabledTracks: ["T1", "T3", "T5", "T6", "T7"],
    terms: T("service_case", "item", "professional", "work", "intake", "completion"),
  },
  device_lab: {
    key: "device_lab",
    defaultTracks: ["T1", "T7"],
    enabledTracks: ["T3", "T6"],
    terms: T("repair", "device", "technician", "repair", "intake", "handover"),
    requirementAdjustments: { T1: { workApproval: "ALWAYS" } },
  },
  garage: {
    key: "garage",
    defaultTracks: ["T2"],
    enabledTracks: ["T3", "T7"],
    terms: T("job_card", "vehicle", "mechanic", "repair", "vehicle_intake", "handover"),
    requirementAdjustments: { T2: { workApproval: "ALWAYS" } },
  },
  home_technician: {
    key: "home_technician",
    defaultTracks: ["T3"],
    enabledTracks: ["T4", "T7"],
    terms: T("service_call", "system", "technician", "repair", "arrival", "customer_signoff"),
  },
  installer: {
    key: "installer",
    defaultTracks: ["T4"],
    enabledTracks: ["T3", "T6", "T7"],
    terms: T("installation", "system", "installer", "installation", "arrival", "customer_signoff"),
  },
  remote_it: {
    key: "remote_it",
    defaultTracks: ["T6"],
    enabledTracks: ["T3"],
    terms: T("request", "system", "support_agent", "support", "opening", "remote_confirmation"),
  },
  professional: {
    key: "professional",
    defaultTracks: ["T5"],
    enabledTracks: ["T6"],
    terms: T("request", "none", "professional", "service", "opening", "professional_confirmation"),
  },
  jewelry: {
    key: "jewelry",
    defaultTracks: ["T1", "T7"],
    enabledTracks: ["T5"],
    terms: T("service_case", "product", "jeweler", "repair", "intake", "handover"),
  },
};

/** The base requirements of a track, before profile adjustments (D8 table + C1 + existing code rules). */
function trackBase(track: ServiceTrack): Requirements {
  switch (track) {
    case "T1":
      return { intakeSignature: "REQUIRED", workApproval: "BY_D15", qa: { mode: "REQUIRED", template: "IN_SHOP.v1" }, completion: "HANDOVER_SIGNED", handoverSigned: true };
    case "T2":
      return { intakeSignature: "REQUIRED", workApproval: "BY_D15", qa: { mode: "REQUIRED", template: "VEHICLE.v1" }, completion: "HANDOVER_SIGNED", handoverSigned: true };
    case "T3":
      return { intakeSignature: "NONE", workApproval: "BY_D15", qa: { mode: "OPTIONAL", template: "FIELD.v1" }, completion: "CUSTOMER_SIGNATURE", handoverSigned: false };
    case "T4":
      return { intakeSignature: "NONE", workApproval: "BY_D15", qa: { mode: "REQUIRED", template: "INSTALLATION.v1" }, completion: "CUSTOMER_SIGNATURE", handoverSigned: false };
    case "T5":
      return { intakeSignature: "NONE", workApproval: "BY_D15", qa: { mode: "OFF", template: null }, completion: "PROFESSIONAL_CONFIRMATION", handoverSigned: false };
    case "T6":
      return { intakeSignature: "NONE", workApproval: "BY_D15", qa: { mode: "OPTIONAL", template: "REMOTE.v1" }, completion: "REMOTE_CONFIRMATION", handoverSigned: false };
    case "T7":
      // T7 has one row per resolution; this base is the repair row (afterSaleRequirements gives the others).
      return { intakeSignature: "REQUIRED", workApproval: "BY_D15", qa: { mode: "REQUIRED", template: "IN_SHOP.v1" }, completion: "HANDOVER_SIGNED", handoverSigned: true };
  }
}

/** Section כח table: the T7 rows. Exchange keeps QA with the short EXCHANGE.v1 checklist (C1). */
function afterSaleBase(resolution: AfterSaleResolution): Requirements {
  switch (resolution) {
    case "REPAIR":
      return trackBase("T7");
    case "EXCHANGE":
      return { intakeSignature: "REQUIRED", workApproval: "BY_D15", qa: { mode: "REQUIRED", template: "EXCHANGE.v1" }, completion: "HANDOVER_SIGNED", handoverSigned: true };
    case "CREDIT":
      return { intakeSignature: "REQUIRED", workApproval: "NONE", qa: { mode: "OFF", template: null }, completion: "OWNER_WITH_CREDIT_DOCUMENT", handoverSigned: false };
    case "RETURN_ORIGINAL":
      return { intakeSignature: "REQUIRED", workApproval: "NONE", qa: { mode: "OFF", template: null }, completion: "HANDOVER_SIGNED", handoverSigned: true };
  }
}

/** The resolution a T7 reason suggests first (section כב). The others stay available. */
export function suggestedResolution(reason: ReturnReason): AfterSaleResolution {
  switch (reason) {
    case "WRONG_ITEM":
    case "CHANGE_OF_MIND":
    case "LEGAL_CANCELLATION":
      return "EXCHANGE";
    case "DEFECT":
    case "NOT_AS_DESCRIBED":
    case "OTHER":
      return "REPAIR";
  }
}

// ── Resolving the profile (section ו) ─────────────────────────────────────────────────────────────────────────────

/** Stored BusinessProfile values (lib/business/business-categories.ts) → profile. Unknown or empty → general. */
const SUBCATEGORY_PROFILE: Readonly<Record<string, ServiceProfileKey>> = {
  Repairs: "device_lab",
  "Air Conditioning": "home_technician",
  Plumbing: "home_technician",
  Electrical: "home_technician",
  Jewelry: "jewelry",
  // Categories proposed in the separate categories PR (D6). Harmless until those values exist.
  Garage: "garage",
  "Body Shop": "garage",
  Tires: "garage",
  "Auto Electric": "garage",
  "Mobile Phones": "device_lab",
  Computers: "device_lab",
  Electronics: "device_lab",
  "Security Cameras": "installer",
  "Furniture Assembly": "installer",
  Solar: "installer",
  "Tech Support": "remote_it",
  Networks: "remote_it",
  Consulting: "professional",
  Training: "professional",
};

const CATEGORY_PROFILE: Readonly<Record<string, ServiceProfileKey>> = {
  Automotive: "garage",
  "Device Repair": "device_lab",
  Installations: "installer",
  "IT Services": "remote_it",
  "Professional Services": "professional",
};

export function isServiceProfileKey(value: unknown): value is ServiceProfileKey {
  return typeof value === "string" && (SERVICE_PROFILE_KEYS as readonly string[]).includes(value);
}

/**
 * Resolution order: the owner's explicit choice, then the sub-category, then the category, then "general".
 * A stored choice that is no longer a known key falls through rather than failing (free strings in the DB).
 */
export function resolveProfileKey(input: {
  serviceProfileKey?: string | null;
  category?: string | null;
  subCategory?: string | null;
}): ServiceProfileKey {
  const chosen = typeof input.serviceProfileKey === "string" ? input.serviceProfileKey.trim() : "";
  if (isServiceProfileKey(chosen)) return chosen;
  const sub = typeof input.subCategory === "string" ? input.subCategory.trim() : "";
  if (sub && Object.prototype.hasOwnProperty.call(SUBCATEGORY_PROFILE, sub)) return SUBCATEGORY_PROFILE[sub];
  const cat = typeof input.category === "string" ? input.category.trim() : "";
  if (cat && Object.prototype.hasOwnProperty.call(CATEGORY_PROFILE, cat)) return CATEGORY_PROFILE[cat];
  return "general";
}

// ── Owner overrides (sections ו, יא; bounds) ──────────────────────────────────────────────────────────────────────

export type RequirementOverride = Partial<{
  qaMode: QaMode;
  workApproval: WorkApproval;
  completion: CompletionProof;
}>;

export type ProfileOverrides = {
  /** Additional tracks to enable ("+" → "✓"). Default and enabled tracks of the profile always stay enabled. */
  enabledTracks?: readonly string[];
  /** Owner wording for up to six slots, 1–40 characters each. */
  terms?: Partial<Record<string, string>>;
  /** Per-track requirement changes; loosening a fixed requirement is refused, never silently ignored. */
  requirements?: Partial<Record<string, RequirementOverride>>;
};

export type OverrideViolation = { code: string; path: string };

const TERM_MAX = 40;
const QA_STRICTNESS: Readonly<Record<QaMode, number>> = { OFF: 0, OPTIONAL: 1, REQUIRED: 2 };
const APPROVAL_STRICTNESS: Readonly<Record<WorkApproval, number>> = { NONE: 0, BY_D15: 1, ALWAYS: 2 };
const COMPLETION_PROOFS: readonly CompletionProof[] = [
  "HANDOVER_SIGNED",
  "CUSTOMER_SIGNATURE",
  "NAME_AND_PROFESSIONAL",
  "REMOTE_CONFIRMATION",
  "PROFESSIONAL_CONFIRMATION",
  "OWNER_WITH_CREDIT_DOCUMENT",
];

function isTrack(value: unknown): value is ServiceTrack {
  return typeof value === "string" && (SERVICE_TRACKS as readonly string[]).includes(value);
}

/** Bounds of an override against one track's base, before it is applied. */
function checkRequirementOverride(track: ServiceTrack, base: Requirements, o: RequirementOverride, path: string): OverrideViolation[] {
  const v: OverrideViolation[] = [];
  const def = TRACKS[track];
  if (o.qaMode !== undefined) {
    if (!(o.qaMode in QA_STRICTNESS)) v.push({ code: "INVALID_VALUE", path: `${path}.qaMode` });
    // C1 / today's rule: QA stays REQUIRED wherever the item is at the business.
    else if (def.itemAtBusiness && QA_STRICTNESS[o.qaMode] < QA_STRICTNESS[base.qa.mode]) v.push({ code: "FIXED_REQUIREMENT", path: `${path}.qaMode` });
    else if (o.qaMode !== "OFF" && base.qa.template === null) v.push({ code: "NO_QA_TEMPLATE", path: `${path}.qaMode` });
  }
  if (o.workApproval !== undefined) {
    if (!(o.workApproval in APPROVAL_STRICTNESS)) v.push({ code: "INVALID_VALUE", path: `${path}.workApproval` });
    // D15: never below "when there is a quote or a money commitment".
    else if (o.workApproval === "NONE") v.push({ code: "BELOW_D15", path: `${path}.workApproval` });
  }
  if (o.completion !== undefined) {
    if (!COMPLETION_PROOFS.includes(o.completion)) v.push({ code: "INVALID_VALUE", path: `${path}.completion` });
    else if (!allowedCompletions(base).includes(o.completion)) {
      v.push({ code: base.handoverSigned ? "FIXED_REQUIREMENT" : "COMPLETION_NOT_ALLOWED", path: `${path}.completion` });
    }
  }
  return v;
}

/**
 * Completion proofs an owner may choose for a row:
 *   - a held item always leaves through a signed handover (DB CHECK ServiceHandover_signed) — nothing else;
 *   - on site, a customer signature may be relaxed to name + professional confirmation (both always remain);
 *   - anywhere else, the base proof or the stricter customer signature.
 */
function allowedCompletions(base: Requirements): readonly CompletionProof[] {
  if (base.handoverSigned) return ["HANDOVER_SIGNED"];
  if (base.completion === "CUSTOMER_SIGNATURE") return ["CUSTOMER_SIGNATURE", "NAME_AND_PROFESSIONAL"];
  return [base.completion, "CUSTOMER_SIGNATURE"];
}

export function validateOverrides(profileKey: ServiceProfileKey, overrides: ProfileOverrides | null | undefined): OverrideViolation[] {
  if (overrides === null || overrides === undefined) return [];
  const v: OverrideViolation[] = [];
  if (typeof overrides !== "object" || Array.isArray(overrides)) return [{ code: "INVALID_SHAPE", path: "overrides" }];
  const known = new Set(["enabledTracks", "terms", "requirements"]);
  for (const k of Object.keys(overrides)) if (!known.has(k)) v.push({ code: "UNKNOWN_KEY", path: k });
  if (overrides.enabledTracks !== undefined) {
    if (!Array.isArray(overrides.enabledTracks)) v.push({ code: "INVALID_SHAPE", path: "enabledTracks" });
    else overrides.enabledTracks.forEach((t, i) => { if (!isTrack(t)) v.push({ code: "UNKNOWN_TRACK", path: `enabledTracks[${i}]` }); });
  }
  if (overrides.terms !== undefined) {
    if (!overrides.terms || typeof overrides.terms !== "object" || Array.isArray(overrides.terms)) v.push({ code: "INVALID_SHAPE", path: "terms" });
    else {
      for (const [slot, text] of Object.entries(overrides.terms)) {
        if (!(TERM_SLOTS as readonly string[]).includes(slot)) { v.push({ code: "UNKNOWN_TERM_SLOT", path: `terms.${slot}` }); continue; }
        if (typeof text !== "string") { v.push({ code: "INVALID_VALUE", path: `terms.${slot}` }); continue; }
        const t = text.trim();
        if (t.length === 0 || [...t].length > TERM_MAX || t !== text || /[\u0000-\u001f\u007f]/.test(t)) v.push({ code: "INVALID_TERM", path: `terms.${slot}` });
      }
    }
  }
  if (overrides.requirements !== undefined) {
    if (!overrides.requirements || typeof overrides.requirements !== "object" || Array.isArray(overrides.requirements)) v.push({ code: "INVALID_SHAPE", path: "requirements" });
    else {
      for (const [track, o] of Object.entries(overrides.requirements)) {
        if (!isTrack(track)) { v.push({ code: "UNKNOWN_TRACK", path: `requirements.${track}` }); continue; }
        if (!o || typeof o !== "object" || Array.isArray(o)) { v.push({ code: "INVALID_SHAPE", path: `requirements.${track}` }); continue; }
        for (const k of Object.keys(o)) if (!["qaMode", "workApproval", "completion"].includes(k)) v.push({ code: "UNKNOWN_KEY", path: `requirements.${track}.${k}` });
        v.push(...checkRequirementOverride(track, profileRequirements(profileKey, track), o, `requirements.${track}`));
      }
    }
  }
  return v;
}

function profileRequirements(profileKey: ServiceProfileKey, track: ServiceTrack): Requirements {
  const base = trackBase(track);
  const adj = PROFILES[profileKey].requirementAdjustments?.[track];
  return adj ? { ...base, ...adj, qa: adj.qa ?? base.qa } : base;
}

// ── The effective profile and its snapshot (D14, D17) ─────────────────────────────────────────────────────────────

export const PROFILE_SNAPSHOT_VERSION = 1;

export type ProfileSnapshot = {
  version: typeof PROFILE_SNAPSHOT_VERSION;
  profileKey: ServiceProfileKey;
  defaultTracks: ServiceTrack[];
  enabledTracks: ServiceTrack[];
  terms: Record<TermSlot, { id: string; custom: string | null }>;
  /** Every track's requirements, so a later change of track (D3) reads the same frozen rules. */
  requirements: Record<ServiceTrack, Requirements>;
  /** T7 rows per resolution. */
  afterSale: Record<AfterSaleResolution, Requirements>;
};

export type EffectiveProfileResult = { ok: true; snapshot: ProfileSnapshot } | { ok: false; violations: OverrideViolation[] };

function applyOverride(base: Requirements, o: RequirementOverride | undefined): Requirements {
  if (!o) return base;
  return {
    ...base,
    workApproval: o.workApproval ?? base.workApproval,
    completion: o.completion ?? base.completion,
    qa: o.qaMode !== undefined ? { mode: o.qaMode, template: base.qa.template } : base.qa,
  };
}

/**
 * The profile a case is opened with (D14). Overrides that break a bound refuse the whole result — the server will
 * refuse to save them, so a snapshot is never built from a partly-applied set.
 */
export function buildProfileSnapshot(profileKey: ServiceProfileKey, overrides?: ProfileOverrides | null): EffectiveProfileResult {
  const violations = validateOverrides(profileKey, overrides);
  if (violations.length > 0) return { ok: false, violations };
  const p = PROFILES[profileKey];
  const extra = (overrides?.enabledTracks ?? []).filter(isTrack);
  const enabled = SERVICE_TRACKS.filter((t) => p.defaultTracks.includes(t) || p.enabledTracks.includes(t) || extra.includes(t));
  const terms = Object.fromEntries(
    TERM_SLOTS.map((slot) => [slot, { id: p.terms[slot], custom: overrides?.terms?.[slot] ?? null }]),
  ) as Record<TermSlot, { id: string; custom: string | null }>;
  const requirements = Object.fromEntries(
    SERVICE_TRACKS.map((t) => [t, applyOverride(profileRequirements(profileKey, t), overrides?.requirements?.[t])]),
  ) as Record<ServiceTrack, Requirements>;
  const t7Override = overrides?.requirements?.T7;
  const afterSale = Object.fromEntries(
    AFTER_SALE_RESOLUTIONS.map((r) => {
      const base = afterSaleBase(r);
      // A T7 override applies only where its bound holds for that row (a CREDIT row has no QA to raise, etc.).
      const usable = t7Override && checkRequirementOverride("T7", base, t7Override, "").length === 0 ? t7Override : undefined;
      return [r, applyOverride(base, usable)];
    }),
  ) as Record<AfterSaleResolution, Requirements>;
  const snapshot: ProfileSnapshot = {
    version: PROFILE_SNAPSHOT_VERSION,
    profileKey,
    defaultTracks: [...p.defaultTracks],
    enabledTracks: enabled,
    terms,
    requirements,
    afterSale,
  };
  return { ok: true, snapshot: deepFreeze(snapshot) };
}

/** What a case must satisfy, read only from its own snapshot — later setting changes never reach it (D17). */
export function requirementsFromSnapshot(snapshot: ProfileSnapshot, track: ServiceTrack, resolution?: AfterSaleResolution): Requirements {
  if (track === "T7" && resolution !== undefined) return snapshot.afterSale[resolution];
  return snapshot.requirements[track];
}

export function isTrackEnabled(snapshot: ProfileSnapshot, track: ServiceTrack): boolean {
  return snapshot.enabledTracks.includes(track);
}

// ── Suggesting a track at opening (section יד) ────────────────────────────────────────────────────────────────────

export type OpeningContext = {
  fromSale?: boolean;
  fromAppointmentWithAddress?: boolean;
  customerHasVehicle?: boolean;
};

export type TrackSuggestion = { track: ServiceTrack; enabled: boolean; reason: "CONTEXT" | "DEFAULT" | "ENABLED" | "AVAILABLE" };

/**
 * An ordered list: the opening context first, then the profile's ★ tracks, then the other enabled ones, then the
 * tracks the owner can still enable. A suggestion is never a decision; the server checks the chosen track.
 */
export function suggestTracks(snapshot: ProfileSnapshot, ctx: OpeningContext = {}): TrackSuggestion[] {
  const out: TrackSuggestion[] = [];
  const seen = new Set<ServiceTrack>();
  const push = (track: ServiceTrack, reason: TrackSuggestion["reason"]) => {
    if (seen.has(track)) return;
    seen.add(track);
    out.push({ track, enabled: isTrackEnabled(snapshot, track), reason });
  };
  const contextual: ServiceTrack[] = [];
  if (ctx.fromSale) contextual.push("T7");
  if (ctx.fromAppointmentWithAddress) contextual.push("T3");
  if (ctx.customerHasVehicle) contextual.push("T2");
  for (const t of contextual) if (isTrackEnabled(snapshot, t)) push(t, "CONTEXT");
  for (const t of snapshot.defaultTracks) push(t, "DEFAULT");
  for (const t of snapshot.enabledTracks) push(t, "ENABLED");
  for (const t of SERVICE_TRACKS) push(t, "AVAILABLE");
  return out;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}
