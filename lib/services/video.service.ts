import { generateWithRunway } from "./runway.service";
import { generateWithPika } from "./pika.service";
import { generateFallback } from "./fallback.service";
import { generateScriptAndInstructions } from "./script.service";
import { getCurrentBusinessContext } from "./business-context.service";
import { runDecisionEngine } from "./decision-engine.service";
import { runPackagingEngine } from "./packaging-engine.service";
import { normalizeBusiness } from "./business-normalizer.service";
import { runVideoTypeEngine } from "./video-type-engine.service";
import { runAssetEngine } from "./asset-engine.service";
import { buildContentStructure } from "./content-structure-engine.service";

type GenerateVideoInput = {
  goal: "leads" | "trust" | "exposure" | "sales";
  goalDescription: string;
  intent: "message" | "follow" | "watch" | "sale";
  mode: string;
  audienceDescription: string;
  ageRange: string;
};

function buildEffectiveServiceLabel(input: {
  mainService?: string;
  normalizedService?: string;
  subcategory?: string;
  category?: string;
}) {
  return (
    input.mainService?.trim() ||
    input.normalizedService?.trim() ||
    input.subcategory?.trim() ||
    input.category?.trim() ||
    "service"
  );
}

function normalizeInstructions(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is string =>
        typeof item === "string" && item.trim().length > 0
    );
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return [value];
  }

  return [];
}

export async function generateVideo(
  input: GenerateVideoInput,
  req: Request
) {
  const businessContext = await getCurrentBusinessContext(req);

  const normalizedBusiness = normalizeBusiness({
    category: businessContext.category,
    subcategory: businessContext.subcategory,
  });

  const effectiveServiceLabel = buildEffectiveServiceLabel({
    mainService: businessContext.mainService,
    normalizedService: normalizedBusiness.service,
    subcategory: businessContext.subcategory,
    category: businessContext.category,
  });

  const safeBusinessName: string =
    typeof businessContext.businessName === "string" &&
    businessContext.businessName.trim().length > 0
      ? businessContext.businessName
      : "העסק שלך";

  const decision = runDecisionEngine(
    {
      goal: input.goal,
      goalDescription: input.goalDescription,
      intent: input.intent,
      audienceDescription: input.audienceDescription,
    },
    businessContext
  );

  const contentStructure = buildContentStructure({
    goal: input.goal,
    intent: input.intent,
    audienceDescription: input.audienceDescription,
    strategy: decision.strategy,
    angle: decision.angle,
    tone: decision.tone,
    businessName: safeBusinessName,
    effectiveServiceLabel,
  });

  const videoType = runVideoTypeEngine({
    goal: input.goal,
    intent: input.intent,
  });

  const assets = runAssetEngine({
    videoType: videoType.type,
    mode: input.mode,
  });

  const scriptResult = generateScriptAndInstructions({
    contentStructure,
    contentFormat: "video",
  });

  const normalizedInstructions = normalizeInstructions(
    scriptResult.instructions
  );

  const packaging = runPackagingEngine({
    script: scriptResult.script,
    strategy: decision.strategy,
    angle: decision.angle,
    tone: decision.tone,
    businessCategory: normalizedBusiness.label,
    city: businessContext.city,
  });

  try {
    const runway = await generateWithRunway({
      ...input,
      businessContext,
      effectiveServiceLabel,
      script: scriptResult.script,
      instructions: normalizedInstructions,
      strategy: decision.strategy,
      angle: decision.angle,
      tone: decision.tone,
      packaging,
      videoType,
      assets,
    });

    if (runway?.videoUrl) {
      return {
        ...scriptResult,
        ...packaging,
        videoType,
        assets,
        hashtags: Array.from(
          new Set([...(packaging.hashtags || []), ...normalizedBusiness.hashtags])
        ),
        videoUrl: runway.videoUrl,
        provider: "runway",
      };
    }
  } catch {
    // continue to next provider
  }

  try {
    const pika = await generateWithPika({
      ...input,
      businessContext,
      effectiveServiceLabel,
      script: scriptResult.script,
      instructions: normalizedInstructions,
      strategy: decision.strategy,
      angle: decision.angle,
      tone: decision.tone,
      packaging,
      videoType,
      assets,
    });

    if (pika?.videoUrl) {
      return {
        ...scriptResult,
        ...packaging,
        videoType,
        assets,
        hashtags: Array.from(
          new Set([...(packaging.hashtags || []), ...normalizedBusiness.hashtags])
        ),
        videoUrl: pika.videoUrl,
        provider: "pika",
      };
    }
  } catch {
    // continue to fallback
  }

  const fallback = await generateFallback({
    ...input,
    script: scriptResult.script,
    instructions: normalizedInstructions,
    strategy: decision.strategy,
    angle: decision.angle,
    tone: decision.tone,
    packaging,
  });

  return {
    ...scriptResult,
    ...packaging,
    videoType,
    assets,
    hashtags: Array.from(
      new Set([...(packaging.hashtags || []), ...normalizedBusiness.hashtags])
    ),
    videoUrl: fallback.videoUrl,
    provider: fallback.provider,
  };
}