import type {
  ContentAngle,
  DirectionInput,
  Goal,
  Mode,
  SelectedFormat,
  SelectedPlatform,
} from "@/lib/features/content/decision";
import type { CreativeBlueprint } from "@/lib/features/content/creative-blueprint/types";
import type { CreativeScore } from "@/lib/features/content/creative-scoring/types";
import type { GrowthSemantics } from "@/lib/features/content/growth-semantics/types";
import type { RenderBlueprint } from "@/lib/features/content/render-blueprint/types";
import type { ContentInsightAnswer } from "@/lib/features/content/question-engine/types";
import { prisma } from "@/lib/prisma";
import type { TenantTx } from "@/lib/tenant/transaction";
import { ContentRunStatus, ContentVariantStatus, Prisma } from "@prisma/client";

const PERSISTENCE_SCHEMA_VERSION = 1;

const VARIANT_KEYS = ["direct", "explanatory", "trust"] as const;
export type ContentPlanVariantKey = (typeof VARIANT_KEYS)[number];

/** Mirrors `VideoPlanRequestBody` in `app/api/video/plan/route.ts` (avoid circular import). */
export type VideoPlanBodyForPersistence = {
  mode?: Mode;
  goal?: Goal;
  intent?: string;
  audienceTypes?: string[];
  contentAngle?: ContentAngle;
  contentGoalPrompt?: string;
  contentArchetypeId?: string;
  contentInsightAnswers?: ContentInsightAnswer[];
  selectedDirection?: DirectionInput;
  selectedFormat?: SelectedFormat;
  selectedPlatform?: SelectedPlatform;
  businessType?: string;
  businessCategory?: string;
  businessName?: string;
  services?: string[];
  products?: string[];
  brandTone?: string;
  priceLevel?: "budget" | "mid" | "premium";
  differentiators?: string[];
};

export type VideoPlanVariantForPersistence = {
  id: string;
  variantBlueprint?: CreativeBlueprint | null;
  renderBlueprint?: RenderBlueprint | null;
  creativeScore?: CreativeScore | null;
  growthSemantics?: GrowthSemantics | null;
};

function wrapJsonDocument(
  source: "user" | "system" | "pipeline",
  data: unknown
): Prisma.InputJsonValue {
  return {
    schemaVersion: PERSISTENCE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    source,
    data: data as Prisma.InputJsonValue,
  };
}

function pickDirectionSnapshot(
  direction: DirectionInput | undefined
): Record<string, unknown> | undefined {
  if (!direction) return undefined;
  return {
    id: direction.id,
    title: direction.title,
    description: direction.description,
    whyItFits: direction.whyItFits,
    type: direction.type,
    strategy: direction.strategy,
    tone: direction.tone,
    pace: direction.pace,
    recommendedFormat: direction.recommendedFormat,
    score: direction.score,
  };
}

function buildInputSnapshotData(body: VideoPlanBodyForPersistence) {
  return {
    mode: body.mode,
    goal: body.goal,
    intent: body.intent,
    audienceTypes: body.audienceTypes,
    contentAngle: body.contentAngle,
    contentGoalPrompt: body.contentGoalPrompt,
    contentArchetypeId: body.contentArchetypeId,
    selectedFormat: body.selectedFormat,
    selectedPlatform: body.selectedPlatform,
    businessType: body.businessType,
    businessCategory: body.businessCategory,
    businessName: body.businessName,
    services: body.services,
    products: body.products,
    brandTone: body.brandTone,
    priceLevel: body.priceLevel,
    differentiators: body.differentiators,
    selectedDirection: pickDirectionSnapshot(body.selectedDirection),
  };
}

function buildCreativeDnaData(
  variantKey: ContentPlanVariantKey,
  blueprint: CreativeBlueprint
) {
  return {
    variantStyle: variantKey,
    visual_strategy: blueprint.visual_strategy,
    visual_energy: blueprint.visual_energy,
    pacing_curve: blueprint.pacing_curve,
    subtitle_behavior: blueprint.subtitle_behavior,
    cta_psychology: blueprint.cta_psychology,
    narration_tone: blueprint.narration_tone,
    attention_strategy: blueprint.attention_strategy,
  };
}

export async function persistContentPlanV1(params: {
  user: { id: number; businessId: number };
  body: VideoPlanBodyForPersistence;
  resolvedBusinessType: string | undefined;
  profileCategory: string | undefined;
  profileSubCategory: string | undefined;
  variants: VideoPlanVariantForPersistence[];
  selectedPlatform: SelectedPlatform;
}, options?: { tx?: TenantTx }): Promise<void> {
  try {
    const { user, body, resolvedBusinessType, profileCategory, profileSubCategory, variants } =
      params;

    if (variants.length !== VARIANT_KEYS.length) {
      console.error(
        "content plan persistence skipped: expected three variants, got",
        variants.length
      );
      return;
    }

    for (let i = 0; i < variants.length; i++) {
      const v = variants[i];
      if (
        !v?.variantBlueprint ||
        !v.renderBlueprint ||
        v.creativeScore == null ||
        v.growthSemantics == null
      ) {
        console.error("content plan persistence skipped: incomplete variant snapshots");
        return;
      }
    }

    // D2/P7 Wave 2: when a tenant transaction is provided, run inside it (the
    // GUC-carrying tx) instead of opening a bare $transaction.
    const runInTx = async (tx: TenantTx) => {
      const run = await tx.contentRun.create({
        data: {
          businessId: user.businessId,
          createdByUserId: user.id,
          status: ContentRunStatus.COMPLETED,
          inputSnapshot: wrapJsonDocument("user", buildInputSnapshotData(body)),
          businessContextSnapshot: wrapJsonDocument("system", {
            resolvedBusinessType: resolvedBusinessType ?? null,
            profileCategory: profileCategory ?? null,
            profileSubCategory: profileSubCategory ?? null,
          }),
          metadata: wrapJsonDocument("system", {
            persistenceVersion: "v1",
            route: "POST /api/video/plan",
          }),
        },
      });

      for (let i = 0; i < VARIANT_KEYS.length; i++) {
        const variantKey = VARIANT_KEYS[i];
        const v = variants[i];
        const blueprint = v.variantBlueprint!;
        await tx.contentVariant.create({
          data: {
            contentRunId: run.id,
            variantKey,
            status: ContentVariantStatus.READY,
            creativeDna: wrapJsonDocument(
              "pipeline",
              buildCreativeDnaData(variantKey, blueprint)
            ),
            creativeBlueprint: wrapJsonDocument("pipeline", blueprint),
            renderBlueprint: wrapJsonDocument("pipeline", v.renderBlueprint!),
            creativeScore: wrapJsonDocument("pipeline", v.creativeScore!),
            growthSemantics: wrapJsonDocument("pipeline", v.growthSemantics!),
            provenance: wrapJsonDocument("pipeline", {
              variantRuntimeId: v.id,
              selectedPlatform: params.selectedPlatform,
            }),
            metadata: wrapJsonDocument("system", {
              persistenceVersion: "v1",
            }),
          },
        });
      }
    };

    if (options?.tx) {
      await runInTx(options.tx);
    } else {
      await prisma.$transaction(runInTx);
    }
  } catch (err) {
    console.error("content plan persistence failed:", err);
  }
}
