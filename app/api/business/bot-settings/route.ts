import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import {
  isValidProductLinkUrl,
  MAX_PRODUCT_LINK_INTRO_CHARS,
  MAX_PRODUCT_LINK_URL_CHARS,
} from "@/lib/inbox-view/product-link-capability";

const ALLOWED_MODES = new Set(["STARTER"]);
const ALLOWED_CHANNELS = new Set(["WHATSAPP"]);

const MAX_WELCOME_MESSAGE_CHARS = 8_000;
const MAX_FINAL_ACTION_CHARS = 256;
const MAX_JSON_CHARS = 50_000;

const SETTINGS_SELECT = {
  id: true,
  enabled: true,
  mode: true,
  channel: true,
  welcomeMessage: true,
  questions: true,
  finalAction: true,
  finalActionPayload: true,
  handoffRules: true,
  showDraftSuggestionsInInbox: true,
  productLinkEnabled: true,
  productLinkUrl: true,
  productLinkIntro: true,
  updatedAt: true,
} satisfies Prisma.BusinessBotSettingsSelect;

type SettingsPayload = {
  enabled: boolean;
  mode: string;
  channel: string;
  welcomeMessage: string | null;
  finalAction: string | null;
  questions: Prisma.JsonValue | null;
  finalActionPayload: Prisma.JsonValue | null;
  handoffRules: Prisma.JsonValue | null;
  showDraftSuggestionsInInbox: boolean;
  productLinkEnabled: boolean;
  productLinkUrl: string | null;
  productLinkIntro: string | null;
};

function defaultSettingsPayload(): SettingsPayload {
  return {
    enabled: false,
    mode: "STARTER",
    channel: "WHATSAPP",
    welcomeMessage: null,
    finalAction: null,
    questions: null,
    finalActionPayload: null,
    handoffRules: null,
    showDraftSuggestionsInInbox: false,
    productLinkEnabled: false,
    productLinkUrl: null,
    productLinkIntro: null,
  };
}

function jsonPayloadSize(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isJsonLikeValue(value: unknown): value is Prisma.InputJsonValue {
  if (value === null) return true;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return true;
  if (Array.isArray(value)) return value.every(isJsonLikeValue);
  if (t === "object") {
    return Object.getPrototypeOf(value) === Object.prototype;
  }
  return false;
}

/** Flat fields only — safe for both Prisma update and create (unchecked). */
type BotSettingsPatch = {
  enabled?: boolean;
  mode?: string;
  channel?: string;
  welcomeMessage?: string | null;
  finalAction?: string | null;
  questions?: Prisma.InputJsonValue | typeof Prisma.JsonNull;
  finalActionPayload?: Prisma.InputJsonValue | typeof Prisma.JsonNull;
  handoffRules?: Prisma.InputJsonValue | typeof Prisma.JsonNull;
  showDraftSuggestionsInInbox?: boolean;
  productLinkEnabled?: boolean;
  productLinkUrl?: string | null;
  productLinkIntro?: string | null;
};

export async function GET(req: Request) {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const row = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction((tx) =>
          tx.businessBotSettings.findUnique({
            where: { businessId: user.businessId },
            select: SETTINGS_SELECT,
          })
        )
    );

    if (!row) {
      return NextResponse.json({
        success: true,
        persisted: false,
        settings: defaultSettingsPayload(),
      });
    }

    const { id, updatedAt, ...rest } = row;
    return NextResponse.json({
      success: true,
      persisted: true,
      settings: {
        ...rest,
        id,
        updatedAt,
      },
    });
  } catch (error) {
    console.error("BOT_SETTINGS_GET_ERROR:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const patch: BotSettingsPatch = {};

    if (Object.prototype.hasOwnProperty.call(body, "enabled")) {
      if (typeof body.enabled !== "boolean") {
        return NextResponse.json(
          { error: "enabled must be a boolean" },
          { status: 400 }
        );
      }
      patch.enabled = body.enabled;
    }

    if (Object.prototype.hasOwnProperty.call(body, "showDraftSuggestionsInInbox")) {
      if (typeof body.showDraftSuggestionsInInbox !== "boolean") {
        return NextResponse.json(
          { error: "showDraftSuggestionsInInbox must be a boolean" },
          { status: 400 }
        );
      }
      patch.showDraftSuggestionsInInbox = body.showDraftSuggestionsInInbox;
    }

    if (Object.prototype.hasOwnProperty.call(body, "productLinkEnabled")) {
      if (typeof body.productLinkEnabled !== "boolean") {
        return NextResponse.json(
          { error: "productLinkEnabled must be a boolean" },
          { status: 400 }
        );
      }
      patch.productLinkEnabled = body.productLinkEnabled;
    }

    if (Object.prototype.hasOwnProperty.call(body, "productLinkUrl")) {
      const v = body.productLinkUrl;
      if (v !== null && typeof v !== "string") {
        return NextResponse.json(
          { error: "productLinkUrl must be a string or null" },
          { status: 400 }
        );
      }
      const trimmed = typeof v === "string" ? v.trim() : null;
      if (trimmed && trimmed.length > MAX_PRODUCT_LINK_URL_CHARS) {
        return NextResponse.json(
          { error: "productLinkUrl is too long" },
          { status: 400 }
        );
      }
      patch.productLinkUrl = trimmed === "" || trimmed === null ? null : trimmed;
    }

    if (Object.prototype.hasOwnProperty.call(body, "productLinkIntro")) {
      const v = body.productLinkIntro;
      if (v !== null && typeof v !== "string") {
        return NextResponse.json(
          { error: "productLinkIntro must be a string or null" },
          { status: 400 }
        );
      }
      const trimmed = typeof v === "string" ? v.trim() : null;
      if (trimmed && trimmed.length > MAX_PRODUCT_LINK_INTRO_CHARS) {
        return NextResponse.json(
          { error: "productLinkIntro is too long" },
          { status: 400 }
        );
      }
      patch.productLinkIntro = trimmed === "" || trimmed === null ? null : trimmed;
    }

    if (Object.prototype.hasOwnProperty.call(body, "mode")) {
      if (typeof body.mode !== "string" || !ALLOWED_MODES.has(body.mode)) {
        return NextResponse.json(
          { error: 'mode must be "STARTER"' },
          { status: 400 }
        );
      }
      patch.mode = body.mode;
    }

    if (Object.prototype.hasOwnProperty.call(body, "channel")) {
      if (
        typeof body.channel !== "string" ||
        !ALLOWED_CHANNELS.has(body.channel)
      ) {
        return NextResponse.json(
          { error: 'channel must be "WHATSAPP"' },
          { status: 400 }
        );
      }
      patch.channel = body.channel;
    }

    if (Object.prototype.hasOwnProperty.call(body, "welcomeMessage")) {
      const v = body.welcomeMessage;
      if (v !== null && typeof v !== "string") {
        return NextResponse.json(
          { error: "welcomeMessage must be a string or null" },
          { status: 400 }
        );
      }
      if (typeof v === "string" && v.length > MAX_WELCOME_MESSAGE_CHARS) {
        return NextResponse.json(
          { error: "welcomeMessage is too long" },
          { status: 400 }
        );
      }
      patch.welcomeMessage = v === null ? null : v;
    }

    if (Object.prototype.hasOwnProperty.call(body, "finalAction")) {
      const v = body.finalAction;
      if (v !== null && typeof v !== "string") {
        return NextResponse.json(
          { error: "finalAction must be a string or null" },
          { status: 400 }
        );
      }
      if (typeof v === "string" && v.length > MAX_FINAL_ACTION_CHARS) {
        return NextResponse.json(
          { error: "finalAction is too long" },
          { status: 400 }
        );
      }
      patch.finalAction = v === null ? null : v;
    }

    for (const key of ["questions", "finalActionPayload", "handoffRules"] as const) {
      if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
      const v = body[key];
      if (v === null) {
        patch[key] = Prisma.JsonNull;
        continue;
      }
      if (!isJsonLikeValue(v)) {
        return NextResponse.json(
          { error: `${key} must be JSON-serializable object, array, or primitive` },
          { status: 400 }
        );
      }
      if (jsonPayloadSize(v) > MAX_JSON_CHARS) {
        return NextResponse.json(
          { error: `${key} exceeds maximum size` },
          { status: 400 }
        );
      }
      patch[key] = v;
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json(
        { error: "No valid fields to update" },
        { status: 400 }
      );
    }

    const existingForProduct = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction((tx) =>
          tx.businessBotSettings.findUnique({
            where: { businessId: user.businessId },
            select: { productLinkEnabled: true, productLinkUrl: true },
          })
        )
    );

    const effectiveProductEnabled =
      patch.productLinkEnabled !== undefined
        ? patch.productLinkEnabled
        : (existingForProduct?.productLinkEnabled ?? false);

    const effectiveProductUrl =
      patch.productLinkUrl !== undefined
        ? patch.productLinkUrl
        : (existingForProduct?.productLinkUrl ?? null);

    if (effectiveProductEnabled) {
      const url =
        typeof effectiveProductUrl === "string"
          ? effectiveProductUrl.trim()
          : "";
      if (!isValidProductLinkUrl(url)) {
        return NextResponse.json(
          {
            error:
              "כשמפעילים עזרה עם מוצרים, נדרש קישור מלא ותקין (כולל https:// או http://)",
          },
          { status: 400 }
        );
      }
    }

    const create: Prisma.BusinessBotSettingsUncheckedCreateInput = {
      businessId: user.businessId,
      enabled: patch.enabled ?? false,
      mode: patch.mode ?? "STARTER",
      channel: patch.channel ?? "WHATSAPP",
      showDraftSuggestionsInInbox: patch.showDraftSuggestionsInInbox ?? false,
    };
    if (patch.welcomeMessage !== undefined) {
      create.welcomeMessage = patch.welcomeMessage;
    }
    if (patch.finalAction !== undefined) {
      create.finalAction = patch.finalAction;
    }
    if (patch.questions !== undefined) {
      create.questions = patch.questions;
    }
    if (patch.finalActionPayload !== undefined) {
      create.finalActionPayload = patch.finalActionPayload;
    }
    if (patch.handoffRules !== undefined) {
      create.handoffRules = patch.handoffRules;
    }
    create.productLinkEnabled = patch.productLinkEnabled ?? false;
    create.productLinkUrl =
      patch.productLinkUrl !== undefined ? patch.productLinkUrl : null;
    create.productLinkIntro =
      patch.productLinkIntro !== undefined ? patch.productLinkIntro : null;

    const row = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction((tx) =>
          tx.businessBotSettings.upsert({
            where: { businessId: user.businessId },
            update: patch,
            create,
            select: SETTINGS_SELECT,
          })
        )
    );

    const { id, updatedAt, ...rest } = row;
    return NextResponse.json({
      success: true,
      persisted: true,
      settings: {
        ...rest,
        id,
        updatedAt,
      },
    });
  } catch (error) {
    console.error("BOT_SETTINGS_PATCH_ERROR:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
