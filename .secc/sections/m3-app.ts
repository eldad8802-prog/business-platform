/**
 * sec(C) M-3 (app layer) + T-09 — the REAL route handlers and services, driven
 * against a fresh lab as a NOSUPERUSER NOBYPASSRLS runtime and a separate auth
 * identity (AUTH_PLANE_ENABLED=true), exactly the Production split.
 *
 *   own reference        -> created
 *   foreign reference    -> uniform rejection (404 {"error":"not found"} / invalid_input)
 *   nonexistent reference-> byte-identical rejection (no existence oracle)
 *   tenant B             -> byte-unchanged; tenant A gains no row on rejection
 *
 * The app check is proved WITH the DB constraint absent (lab without the sec(C)
 * migration), so a pass here cannot be the composite FK answering for it.
 */
import { newLab, dropLab } from "../lab.mjs";
import { ok, section, client, fingerprint, makeTenant, prodLikeRuntimeGrants } from "../common";

void section("m3-app", async () => {
  // Without the sec(C) migration: the ONLY thing standing between tenants here is the app check.
  const lab = await newLab("m3app", { secC: false });
  const owner = client(lab.ownerUrl);
  await prodLikeRuntimeGrants(owner);
  const a = await makeTenant(owner, "appA");
  const b = await makeTenant(owner, "appB");

  Object.assign(process.env, {
    DATABASE_URL: lab.rtUrl,
    DIRECT_URL: lab.rtUrl,
    AUTH_PLANE_ENABLED: "true",
    AUTH_DATABASE_URL: lab.authUrl,
    AUTH_TOKEN_SECRET: "secc_ci_synthetic_auth_token_secret_0123456789",
    KNOWLEDGE_DERIVE_SECRET: "secc_ci_synthetic_derive_secret_0123456789abcdef",
    CRON_SECRET: "",
    PRODUCT_USAGE_TRACKING: "false",
  });
  const { signAuthToken } = await import("@/lib/auth-token");
  const token = signAuthToken(a.userId, 0);
  const post = (body: unknown, auth = `Bearer ${token}`) =>
    new Request("http://lab.local/api/x", { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify(body) });
  const read = async (r: Response) => ({ status: r.status, body: await r.text() });

  const bBefore: Record<string, string> = {};
  for (const t of ["Conversation", "Message", "Customer", "Lead", "ReplySuggestion", "Appointment"]) bBefore[t] = await fingerprint(owner, t, b.businessId);
  const countA = async (t: string) => Number((await owner.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${t}" WHERE "businessId" = ${a.businessId}`))[0].n);
  const MISSING = 2_000_000_000;

  for (const [label, path] of [["POST /api/conversation", "@/app/api/conversation/route"], ["POST /api/conversations", "@/app/api/conversations/route"]] as const) {
    const { POST } = await import(path);
    for (const field of ["customerId", "leadId"] as const) {
      const own = await read(await POST(post({ [field]: a[field] })));
      ok(`M3-APP ${label} own ${field} -> 201`, own.status === 201, own);
      const n0 = await countA("Conversation");
      const foreign = await read(await POST(post({ [field]: b[field] })));
      const none = await read(await POST(post({ [field]: MISSING })));
      ok(`M3-APP ${label} foreign ${field} -> 404 not found`, foreign.status === 404 && foreign.body === JSON.stringify({ error: "not found" }), foreign);
      ok(`M3-APP ${label} nonexistent ${field} -> byte-identical to foreign (no oracle)`, none.status === foreign.status && none.body === foreign.body, { foreign, none });
      ok(`M3-APP ${label} rejected ${field} created no row`, (await countA("Conversation")) === n0);
    }
  }

  {
    const { POST } = await import("@/app/api/message/route");
    const base = { conversationId: a.conversationId, direction: "OUTBOUND", senderType: "BUSINESS_USER", channel: "OTHER", contentText: "lab" };
    for (const [field, key] of [["customerId", "customerId"], ["generatedFromSuggestionId", "suggestionId"]] as const) {
      const own = await read(await POST(post({ ...base, [field]: a[key] })));
      ok(`M3-APP POST /api/message own ${field} -> 2xx`, own.status >= 200 && own.status < 300, own);
      const n0 = await countA("Message");
      const foreign = await read(await POST(post({ ...base, [field]: b[key] })));
      const none = await read(await POST(post({ ...base, [field]: MISSING })));
      ok(`M3-APP POST /api/message foreign ${field} -> 404 not found`, foreign.status === 404 && foreign.body === JSON.stringify({ error: "not found" }), foreign);
      ok(`M3-APP POST /api/message nonexistent ${field} -> byte-identical to foreign`, none.status === foreign.status && none.body === foreign.body, { foreign, none });
      ok(`M3-APP POST /api/message rejected ${field} created no row`, (await countA("Message")) === n0);
    }
  }

  {
    const appt = await import("@/lib/services/appointment/appointment.service");
    const actor = { actor: "OWNER", sourceChannel: "INBOX_WEB", userId: a.userId } as const;
    for (const [field, key] of [["customerId", "customerId"], ["leadId", "leadId"], ["messageId", "messageId"]] as const) {
      const own = await appt.create({ businessId: a.businessId, actor, links: { [field]: a[key] } } as never);
      ok(`M3-APP appointment own ${field} -> created`, own.ok === true, own);
      const n0 = await countA("Appointment");
      const foreign = await appt.create({ businessId: a.businessId, actor, links: { [field]: b[key] } } as never);
      const none = await appt.create({ businessId: a.businessId, actor, links: { [field]: MISSING } } as never);
      ok(`M3-APP appointment foreign ${field} -> invalid_input`, JSON.stringify(foreign) === JSON.stringify({ ok: false, reason: "invalid_input" }), foreign);
      ok(`M3-APP appointment nonexistent ${field} -> identical to foreign`, JSON.stringify(none) === JSON.stringify(foreign), { foreign, none });
      ok(`M3-APP appointment rejected ${field} created no row`, (await countA("Appointment")) === n0);
    }
  }

  const bAfter: Record<string, string> = {};
  for (const t of Object.keys(bBefore)) bAfter[t] = await fingerprint(owner, t, b.businessId);
  ok("M3-APP tenant B rows byte-unchanged", JSON.stringify(bAfter) === JSON.stringify(bBefore), { bBefore, bAfter });

  // ── T-09 / L-8: knowledge derive ────────────────────────────────────────────
  {
    const { POST } = await import("@/app/api/knowledge/derive/route");
    const call = async (bid: number | string, secret = process.env.KNOWLEDGE_DERIVE_SECRET!) =>
      read(await POST(new Request(`http://lab.local/api/knowledge/derive?businessId=${bid}`, { method: "POST", headers: { authorization: `Bearer ${secret}` } }) as never));
    const good = await call(a.businessId);
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(good.body); } catch { /* asserted below */ }
    ok("T09 derive for an active tenant -> 200", good.status === 200, good.body.slice(0, 200));
    const leaked = ["role", "diagnostics", "rls", "withoutTenant", "foreignRows", "superuser", "bypassrls", "app_runtime", lab.roles.rt]
      .filter((k) => good.body.includes(`"${k}"`) || good.body.includes(k === lab.roles.rt ? k : `"${k}":`));
    ok("T09 no posture in response (no role name/flags, no per-table RLS, no cross-tenant counts)", leaked.length === 0, leaked);
    ok("T09 verdicts kept: proofLevel FULL and isolation.holds true", parsed.proofLevel === "FULL" && (parsed.isolation as { holds?: boolean })?.holds === true, { proofLevel: parsed.proofLevel, isolation: parsed.isolation });

    const missing = await call(MISSING);
    await owner.$executeRawUnsafe(`UPDATE "Business" SET "deletionRequestedAt" = now() WHERE id = ${b.businessId}`);
    const quarantined = await call(b.businessId);
    ok("T09 nonexistent tenant refused by the lifecycle gate (409 tenant_unavailable)", missing.status === 409 && missing.body.includes("tenant_unavailable"), missing);
    ok("T09 quarantined tenant refused identically to nonexistent (no oracle)", quarantined.status === missing.status && quarantined.body === missing.body, { missing, quarantined });
    const cron = await call(a.businessId, "secc_some_other_cron_secret_value_0123456789");
    ok("L8 with KNOWLEDGE_DERIVE_SECRET set, any other bearer is 401", cron.status === 401, cron);
  }

  await owner.$disconnect();
  dropLab(lab);
});
