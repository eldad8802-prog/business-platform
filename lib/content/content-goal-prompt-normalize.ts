/**
 * Normalizes stored `contentGoalPrompt`: one clean structured brief,
 * no chained intros, no duplicate sections, no decorative em dashes clutter.
 */

const MARKER_OFFER = "אני רוצה לקדם:";
const MARKER_OBJ = "מה שבדרך כלל עוצר אנשים:";
const MARKER_QUICK = "נקודות מהירות:";

export function stripChainedGoalIntroPrefix(raw: string): string {
  let t = raw.replace(/\s+/g, " ").trim();
  const head = /^אני רוצה לקדמ[א-ת]*\s*[:\s]*/i;
  for (let i = 0; i < 20 && head.test(t); i++) {
    t = t.replace(head, "").trim();
  }
  return t;
}

/** Keep only the first structured goal block if the string was pasted twice. */
export function takeFirstStructuredGoalBlock(full: string): string {
  const t = full.replace(/\s+/g, " ").trim();
  const m = MARKER_OFFER;
  const first = t.indexOf(m);
  if (first === -1) return t;
  const second = t.indexOf(m, first + m.length);
  if (second === -1) return t;
  return t.slice(0, second).trim();
}

export type ParsedStructuredGoal = {
  offer: string;
  objection: string;
  quickLabels: string[];
};

export function parseStructuredGoalPrompt(raw: string): ParsedStructuredGoal | null {
  const t = takeFirstStructuredGoalBlock(raw.replace(/\s+/g, " ").trim());
  const io = t.indexOf(MARKER_OBJ);
  if (io === -1) return null;
  const offerPart = t.slice(0, io).trim();
  if (!offerPart.startsWith(MARKER_OFFER)) return null;
  const offer = offerPart.slice(MARKER_OFFER.length).replace(/^[\s.:]+/, "").replace(/\.\s*$/, "").trim();

  const afterObj = t.slice(io + MARKER_OBJ.length).trim();
  const iq = afterObj.indexOf(MARKER_QUICK);
  let objection: string;
  let quickRaw = "";
  if (iq === -1) {
    objection = afterObj.replace(/\.\s*$/, "").trim();
  } else {
    objection = afterObj.slice(0, iq).replace(/\.\s*$/, "").trim();
    quickRaw = afterObj.slice(iq + MARKER_QUICK.length).trim();
  }

  const quickLabels =
    quickRaw.length > 0
      ? [
          ...new Set(
            quickRaw
              .replace(/\.\s*$/, "")
              .split(/·|\u00B7|,/g)
              .map((s) => s.trim())
              .filter(Boolean)
          ),
        ]
      : [];

  return { offer, objection, quickLabels };
}

export function rebuildStructuredGoalPrompt(parsed: ParsedStructuredGoal): string {
  const offer = stripChainedGoalIntroPrefix(parsed.offer.trim() || "—") || "—";
  const objection = parsed.objection.trim() || "—";
  const parts: string[] = [];
  parts.push(`${MARKER_OFFER} ${offer}.`);
  parts.push(`${MARKER_OBJ} ${objection}.`);
  if (parsed.quickLabels.length) {
    parts.push(`${MARKER_QUICK} ${parsed.quickLabels.join(" · ")}.`);
  }
  let out = parts.join(" ");
  if (out.length < 24) {
    out = `${out} רוצים שזה ירגיש ברור, אנושי וקרוב ללקוח.`;
  }
  return out.replace(/\s*—\s*/g, " ").replace(/\s+/g, " ").trim();
}

/** Single canonical brief for storage + LLM (undefined if empty). */
export function normalizeContentGoalPromptForStorage(raw?: string): string | undefined {
  const t = raw?.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  const collapsed = takeFirstStructuredGoalBlock(t);
  const parsed = parseStructuredGoalPrompt(collapsed);
  if (parsed && (parsed.offer.length > 0 || parsed.objection.length > 0)) {
    return rebuildStructuredGoalPrompt(parsed);
  }
  const stripped = stripChainedGoalIntroPrefix(collapsed)
    .replace(/\s*—\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length ? stripped : undefined;
}

/**
 * True when the user supplied enough goal brief to generate video (not profile-only).
 * Mirrors setup thresholds: structured offer ≥12 chars, objection ≥8 or quick chips.
 */
export function isSubstantiveContentGoalBrief(raw?: string | null | undefined): boolean {
  const rawTrim = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!rawTrim) return false;

  const collapsed = takeFirstStructuredGoalBlock(rawTrim);
  const parsedStruct = parseStructuredGoalPrompt(collapsed);

  if (parsedStruct) {
    const offer = stripChainedGoalIntroPrefix(parsedStruct.offer)
      .replace(/^[`'"׳״\s.\-־–—]+|[`'"׳״\s.\-־–—]+$/g, "")
      .trim();
    const objection = parsedStruct.objection
      .replace(/^[`'"׳״\s.\-־–—]+|[`'"׳״\s.\-־–—]+$/g, "")
      .trim();
    const hasQuick = parsedStruct.quickLabels.length > 0;
    const offerOk = offer.length >= 12 && !/^[\-־–—.]+$/u.test(offer);
    const objOk = objection.length >= 8 || hasQuick;
    return offerOk && objOk;
  }

  const stripped = stripChainedGoalIntroPrefix(collapsed)
    .replace(/\s*—\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped.length < 18) return false;
  const letters = [...stripped].filter((ch) => /\p{L}|\p{N}/u.test(ch)).length;
  return letters >= 14;
}
