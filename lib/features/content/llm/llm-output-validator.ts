const HEBREW_RE = /[א-ת]/;

// Hebrew conjunction/preposition prefixes that the LLM strips when inflecting
const HE_PREFIX_RE = /^[והבלמכשאל]+/;

export function checkDomainRelevance(
  output: LLMScriptOutput,
  mainOfferLabel: string
): boolean {
  const words = mainOfferLabel
    .split(/[\s,\/\-]+/)
    .map((w) => w.trim().replace(HE_PREFIX_RE, ""))
    .filter((w) => w.length > 2);
  if (words.length === 0) return true;
  const haystack = [
    output.hook,
    output.shots[0]?.visual ?? "",
    output.shots[0]?.voice ?? "",
    output.shots[1]?.voice ?? "",
    output.shots[1]?.visual ?? "",
    output.caption,
  ]
    .join(" ")
    .toLowerCase();
  return words.some((w) => haystack.includes(w.toLowerCase()));
}

export type LLMScriptOutput = {
  hook: string;
  shots: { visual: string; voice: string }[];
  caption: string;
  cta: string;
};

export class LLMOutputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LLMOutputValidationError";
  }
}

export function validateLLMOutput(
  raw: unknown,
  expectedShotCount: number
): LLMScriptOutput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new LLMOutputValidationError("output is not an object");
  }

  const obj = raw as Record<string, unknown>;

  // hook
  const hook = obj.hook;
  if (typeof hook !== "string" || hook.trim().length < 5 || hook.length > 500) {
    throw new LLMOutputValidationError(
      `hook invalid (got: ${typeof hook === "string" ? `length=${hook.length}` : typeof hook})`
    );
  }

  // shots
  if (!Array.isArray(obj.shots) || obj.shots.length === 0) {
    throw new LLMOutputValidationError("shots missing or empty");
  }
  if (obj.shots.length !== expectedShotCount) {
    throw new LLMOutputValidationError(
      `expected ${expectedShotCount} shots, got ${obj.shots.length}`
    );
  }

  const shots = (obj.shots as unknown[]).map((s, i) => {
    if (!s || typeof s !== "object" || Array.isArray(s)) {
      throw new LLMOutputValidationError(`shot[${i}] is not an object`);
    }
    const shot = s as Record<string, unknown>;
    if (typeof shot.visual !== "string" || shot.visual.trim().length === 0) {
      throw new LLMOutputValidationError(`shot[${i}].visual missing or empty`);
    }
    if (typeof shot.voice !== "string" || shot.voice.trim().length === 0) {
      throw new LLMOutputValidationError(`shot[${i}].voice missing or empty`);
    }
    if (shot.visual.length > 500 || shot.voice.length > 600) {
      throw new LLMOutputValidationError(`shot[${i}] field exceeds max length`);
    }
    return { visual: shot.visual.trim(), voice: shot.voice.trim() };
  });

  // caption
  const caption = obj.caption;
  if (
    typeof caption !== "string" ||
    caption.trim().length < 3 ||
    caption.length > 700
  ) {
    throw new LLMOutputValidationError("caption invalid or missing");
  }

  // cta — optional, fall through gracefully
  const cta = typeof obj.cta === "string" ? obj.cta.trim() : "";

  // Hebrew presence — hook or at least one shot voice must contain Hebrew
  const hasHebrew =
    HEBREW_RE.test(hook) || shots.some((s) => HEBREW_RE.test(s.voice));
  if (!hasHebrew) {
    throw new LLMOutputValidationError("no Hebrew content detected in output");
  }

  return {
    hook: hook.trim(),
    shots,
    caption: caption.trim(),
    cta,
  };
}
