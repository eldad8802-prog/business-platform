/**
 * ERASURE CONTRACT GUARD — proves the manifest, the schema and the adapter agree.
 *
 * Run: npm run verify:erasure-contract              (honest: red while debt exists)
 *      npm run verify:erasure-contract -- --baseline-check   (CI: red only on NEW debt)
 *
 * ── WHY THE MANIFEST VALIDATES THE ADAPTER RATHER THAN DRIVING IT ──────────────
 *
 * The obvious fix for two artifacts that can disagree is to delete one: make the
 * manifest the specification and have a generic executor derive the statements. That
 * was considered and rejected, and the reason is worth writing down, because it will
 * look like the better idea again in six months.
 *
 * The erasure is not a uniform sweep. It is a sequence of decisions that a data-driven
 * loop would have to encode anyway, and would then hide:
 *
 *   - the conversation graph must be written deepest-first, so a failure part-way can
 *     never leave a child holding content whose parent claims to be clean;
 *   - `MessageAnalysis` has no `businessId`, so it is reached through a relation filter
 *     that is simultaneously what satisfies its RLS policy;
 *   - a nullable Json column needs `Prisma.DbNull`, because a plain `null` writes the
 *     JSON value null instead of emptying the column;
 *   - `POSApiKey` rows are DELETED rather than blanked, because `keyHash` is globally
 *     unique and a constant would collide across two account deletions;
 *   - `Customer` is anonymised rather than deleted because issued invoices reference it;
 *   - stages 1, 2 and 3 sit in different transactions on purpose, and the ordering IS
 *     the security property.
 *
 * A generic executor would either lose those or grow an option for each, at which point
 * it is the same code with an interpreter in front of it — and one that takes a list of
 * tables to mutate, which is a far wider blast radius than a fixed sequence of
 * statements. So the adapter stays explicit and readable, and this guard makes it
 * impossible for the adapter and the manifest to drift apart without the build saying so.
 *
 * Trade-off accepted: this reads the adapter statically, so it proves the code CONTAINS
 * the write. That the write reaches its rows under FORCE RLS is a different property,
 * proven at runtime by `.ad2a/battery.mjs`. Neither replaces the other.
 */
import path from "node:path";
import fs from "node:fs";
import ts from "typescript";
import {
  ANONYMIZE_MODELS,
  DELETE_MODELS,
  RETAIN_MODELS,
  REVOKE_ENTRIES,
  revokesRow,
} from "./account-erasure-manifest";
import { COVERED_MODELS, DISPOSITIONS } from "./erasure-dispositions";
import { COVERAGE_SOURCES, MODEL_COVERAGE } from "../../../scripts/ci/erasure/erasure-model-coverage";
import {
  NOT_OWNED_POINTERS,
  OBJECT_SURFACES,
  POINTER_NAME_PATTERN,
} from "../../../scripts/ci/erasure/erasure-object-surfaces";
import { ACCEPTED_DEBT, debtKey } from "../../../scripts/ci/erasure/erasure-contract-debt";
import {
  delegateName,
  isSystemDerived,
  parseAdapter,
  parsePrismaSchema,
  scanCodebaseWrites,
} from "./erasure-contract";

const ROOT = path.resolve(__dirname, "../../..");
const SCHEMA = path.join(ROOT, "prisma", "schema.prisma");
const ADAPTER = path.join(ROOT, "lib", "services", "account", "account-deletion.prisma-store.ts");

type Finding = { code: string; key: string; detail: string };

const findings: Finding[] = [];
const seenFinding = new Set<string>();
/** Deduped on code + key. The same model is resolved from several buckets, and one
 *  broken name should be one finding, not one per place it is mentioned — otherwise
 *  the debt baseline records the same fact several times and drifts on refactors. */
const report = (code: string, key: string, detail: string) => {
  const id = `${code}::${key}`;
  if (seenFinding.has(id)) return;
  seenFinding.add(id);
  findings.push({ code, key, detail });
};

/**
 * Writes that are lifecycle bookkeeping, not erasure. The deletion has to record that
 * it happened; that is the audit trail, not personal data, and requiring a disposition
 * for it would be noise. Listed explicitly so the exemption is visible and bounded.
 */
const LIFECYCLE_WRITES = new Set([
  "business.deletionRequestedAt",
  "business.deletedAt",
  "business.archivedAt",
  "business.archivedByUserId",
]);

function main(): number {
  for (const f of [SCHEMA, ADAPTER]) {
    if (!fs.existsSync(f)) {
      console.log(`FATAL: required artifact missing -> ${f}`);
      return 1;
    }
  }

  const models = parsePrismaSchema(SCHEMA);
  const byDelegate = new Map([...models.values()].map((m) => [m.delegate, m]));
  const adapter = parseAdapter(ADAPTER);

  console.log(
    `[contract] schema: ${models.size} models | adapter: ${adapter.writes.length} field write(s), ` +
      `${adapter.deletes.length} delete(s)`
  );

  // ── Parse integrity ────────────────────────────────────────────────────────
  // Before any conclusion: if the analyzer did not understand the adapter, it cannot
  // claim anything about it. An unread call site is a failure, never a pass.
  for (const u of adapter.unanalyzable) {
    report("C0-UNREADABLE", `adapter:${u.line}`, `${u.detail} (line ${u.line})`);
  }

  /** Resolve a manifest model string to a real schema model, or report why not. */
  const resolve = (name: string, bucket: string) => {
    const direct = byDelegate.get(name);
    if (direct) return direct;
    // A manifest name that differs only in case from a real delegate is the most
    // likely mistake, and naming the correction makes the failure actionable.
    const near = [...byDelegate.keys()].find((d) => d.toLowerCase() === name.toLowerCase());
    report(
      "C1-NO-SUCH-MODEL",
      `${bucket}:${name}`,
      near
        ? `${bucket} names "${name}", which is not a Prisma delegate. Did you mean "${near}"?`
        : `${bucket} names "${name}", which matches no model in the schema`
    );
    return null;
  };

  /** Resolve a field on a model, requiring it to be an actual column. */
  const requireScalar = (model: ReturnType<typeof resolve>, field: string, bucket: string) => {
    if (!model) return null;
    const f = model.fields.find((x) => x.name === field);
    if (!f) {
      report(
        "C2-NO-SUCH-FIELD",
        `${model.name}.${field}`,
        `${bucket} names "${field}" on ${model.name}, which has no such field`
      );
      return null;
    }
    if (!f.isScalar) {
      // C5. A relation is not a column. Nulling it in Prisma is a different
      // operation with different semantics, and it can never be the thing that
      // satisfies a promise to erase a stored value.
      report(
        "C5-NOT-A-COLUMN",
        `${model.name}.${field}`,
        `${bucket} names "${field}" on ${model.name}, but that is a relation field, not a column`
      );
      return null;
    }
    return f;
  };

  // ── C1/C2 — every manifest name exists, on the model it is claimed on ──────
  for (const name of RETAIN_MODELS) resolve(name, "RETAIN_MODELS");
  for (const name of DELETE_MODELS) resolve(name, "DELETE_MODELS");

  const written = new Set(adapter.writes.map((w) => `${w.delegate}.${w.field}`));
  const deleted = new Set(adapter.deletes.map((d) => d.delegate));

  for (const entry of ANONYMIZE_MODELS) {
    const model = resolve(entry.model, "ANONYMIZE_MODELS");
    for (const field of Object.keys(entry.fields)) {
      if (!requireScalar(model, field, "ANONYMIZE_MODELS")) continue;
      // ── C3 — the promise must be kept ────────────────────────────────────
      if (!written.has(`${model!.delegate}.${field}`)) {
        report(
          "C3-DECLARED-NOT-IMPLEMENTED",
          `${model!.name}.${field}`,
          `the manifest declares ${model!.name}.${field} is erased; the adapter never writes it`
        );
      }
    }
  }

  // ── C3 for Bucket C — each shape is held to its OWN promise ───────────────
  //
  // `deleteRow` and `clear` claim different things, so nothing that satisfies one
  // may be accepted as satisfying the other.
  //
  // This block used to accept EITHER: a declared `clear` passed if the adapter wrote
  // the column OR deleted the row. That escape is what let `OAuthToken` and
  // `POSApiKey` be described as column clears while the adapter destroyed the whole
  // row, and it hid the fact that the declared columns were not columns on those
  // models at all. The escape is gone, in both directions.
  for (const entry of REVOKE_ENTRIES) {
    const model = resolve(entry.model, "REVOKE_INTEGRATIONS");
    if (revokesRow(entry)) {
      // The strong claim: the row goes. Only a delete keeps it. A write — even one
      // that blanks every column the row has — leaves the row, and is therefore a
      // different outcome, not a stronger way of reaching the same one.
      if (model && !deleted.has(model.delegate)) {
        report(
          "C3-DECLARED-NOT-IMPLEMENTED",
          `${model.name}.*`,
          `the manifest declares ${model.name} rows are deleted on revoke; the adapter issues no delete on it`
        );
      }
      continue;
    }
    for (const field of [...entry.clear, ...Object.keys(entry.set)]) {
      if (!requireScalar(model, field, "REVOKE_INTEGRATIONS")) continue;
      if (!written.has(`${model!.delegate}.${field}`)) {
        report(
          "C3-DECLARED-NOT-IMPLEMENTED",
          `${model!.name}.${field}`,
          `the manifest declares ${model!.name}.${field} is cleared; the adapter never writes it`
        );
      }
    }
  }

  for (const name of DELETE_MODELS) {
    const model = resolve(name, "DELETE_MODELS");
    if (model && !deleted.has(model.delegate)) {
      report(
        "C3-DECLARED-NOT-IMPLEMENTED",
        `${model.name}.*`,
        `the manifest declares ${model.name} rows are deleted; the adapter issues no delete on it`
      );
    }
  }

  // ── C4 — nothing the adapter erases may be undeclared ──────────────────────
  // The reverse direction, and the one that catches a field quietly added to a
  // `data` object. Every write on the erasure path is erasure behaviour and has to
  // be represented, either by the manifest or by an explicit disposition.
  const manifestFields = new Set<string>();
  for (const e of ANONYMIZE_MODELS) {
    for (const f of Object.keys(e.fields)) manifestFields.add(`${e.model}.${f}`);
  }
  for (const e of REVOKE_ENTRIES) {
    // A row-deletion entry declares no columns. It authorises the DELETE (below) and
    // nothing else, so a field write on that same delegate stays undeclared.
    if (revokesRow(e)) continue;
    for (const f of [...e.clear, ...Object.keys(e.set)]) manifestFields.add(`${e.model}.${f}`);
  }

  for (const w of adapter.writes) {
    const key = `${w.delegate}.${w.field}`;
    if (LIFECYCLE_WRITES.has(key)) continue;
    const model = byDelegate.get(w.delegate);
    if (!model) {
      report(
        "C4-UNKNOWN-DELEGATE",
        key,
        `the adapter writes \`${w.delegate}\`, which matches no model in the schema (line ${w.line})`
      );
      continue;
    }
    const declaredInManifest = manifestFields.has(key) || manifestFields.has(`${model.name}.${w.field}`);
    const disp = DISPOSITIONS[model.name]?.[w.field];
    const declaredByDisposition =
      disp !== undefined && ["ERASE", "ANONYMISE", "UNLINK"].includes(disp.disposition);
    if (!declaredInManifest && !declaredByDisposition) {
      report(
        "C4-UNDECLARED-MUTATION",
        `${model.name}.${w.field}`,
        `the adapter writes ${model.name}.${w.field} (line ${w.line}) and no contract declares it`
      );
    }
  }

  for (const d of adapter.deletes) {
    const model = byDelegate.get(d.delegate);
    if (!model) {
      report(
        "C4-UNKNOWN-DELEGATE",
        d.delegate,
        `the adapter deletes from \`${d.delegate}\`, which matches no model in the schema (line ${d.line})`
      );
      continue;
    }
    // Only an explicit `deleteRow` authorises a row deletion. A Bucket-C entry that
    // declares `clear` says the row survives, so a delete on that delegate contradicts
    // its own declaration and must be reported rather than excused by membership.
    const delegateDeclared = new Set<string>([
      ...DELETE_MODELS.map((m) => m as string),
      ...REVOKE_ENTRIES.filter(revokesRow).map((e) => e.model),
    ]);
    if (!delegateDeclared.has(model.delegate) && !delegateDeclared.has(model.name)) {
      report(
        "C4-UNDECLARED-DELETE",
        `${model.name}.*`,
        `the adapter deletes ${model.name} rows (line ${d.line}) and no contract declares it`
      );
    }
  }

  // ── C6 — a covered model answers for every column it has ──────────────────
  for (const modelName of COVERED_MODELS) {
    const model = models.get(modelName);
    if (!model) {
      report("C6-NO-SUCH-MODEL", modelName, `COVERED_MODELS names ${modelName}, which is not in the schema`);
      continue;
    }
    const table = DISPOSITIONS[modelName] ?? {};
    for (const field of model.fields) {
      if (!field.isScalar) continue;
      const d = table[field.name];
      if (!d) {
        report(
          "C6-NO-DISPOSITION",
          `${modelName}.${field.name}`,
          `${modelName}.${field.name} is a covered column with no disposition — decide ERASE / ANONYMISE / UNLINK / RETAIN_BY_DESIGN / STRUCTURAL`
        );
        continue;
      }
      if (d.disposition === "RETAIN_BY_DESIGN" && (!d.purpose || !d.basis)) {
        report(
          "C6-RETENTION-WITHOUT-BASIS",
          `${modelName}.${field.name}`,
          `${modelName}.${field.name} is retained by design without a stated purpose and basis`
        );
        continue;
      }
      if (["ERASE", "ANONYMISE", "UNLINK"].includes(d.disposition)) {
        if (!written.has(`${model.delegate}.${field.name}`) && !deleted.has(model.delegate)) {
          report(
            "C6-DISPOSITION-NOT-IMPLEMENTED",
            `${modelName}.${field.name}`,
            `${modelName}.${field.name} is dispositioned ${d.disposition} and the adapter never writes it`
          );
        }
      }
    }
    // ── C7 — the KIND of write has to match the disposition ────────────────
    // ERASE means the value is destroyed, so the column must end up null or blank.
    // A write the analyzer cannot evaluate to a constant is not proof of erasure: a
    // value derived from the old one would satisfy a mere "is this field written?"
    // check while leaving the information in place.
    for (const [fieldName, d] of Object.entries(table)) {
      if (d.disposition !== "ERASE" && d.disposition !== "UNLINK") continue;
      const w = adapter.writes.find(
        (x) => x.delegate === model.delegate && x.field === fieldName
      );
      if (w && w.kind !== "CLEAR") {
        report(
          "C7-WRONG-WRITE-KIND",
          `${modelName}.${fieldName}`,
          `${modelName}.${fieldName} is dispositioned ${d.disposition}, but the adapter writes a ${w.kind} value (line ${w.line}) rather than clearing it`
        );
      }
    }

    // A disposition for a column that no longer exists is drift in the other
    // direction, and would otherwise sit unnoticed forever.
    for (const declared of Object.keys(table)) {
      if (!model.fields.some((f) => f.name === declared && f.isScalar)) {
        report(
          "C6-STALE-DISPOSITION",
          `${modelName}.${declared}`,
          `a disposition exists for ${modelName}.${declared}, which is not a column on that model`
        );
      }
    }
  }

  // ── E1.1 — model-level coverage ────────────────────────────────────────────
  //
  // E1 proves the models inside the boundary are handled correctly. These checks
  // prove there is no outside: every model in the schema carries exactly one
  // explicit disposition, and the model-level answer agrees with the field-level
  // one. Without them a new model is simply a question nobody asked — which is
  // what happened when the inbound-email models landed.

  // C8 — fail closed on a model with no disposition.
  for (const model of models.values()) {
    if (!MODEL_COVERAGE[model.name]) {
      report(
        "C8-UNCLASSIFIED-MODEL",
        model.name,
        `${model.name} is in the schema and has no erasure disposition — classify it in erasure-model-coverage.ts`
      );
    }
  }

  // C9 — a disposition for a model that no longer exists is drift the other way.
  for (const declared of Object.keys(MODEL_COVERAGE)) {
    if (!models.has(declared)) {
      report(
        "C9-STALE-CLASSIFICATION",
        declared,
        `a disposition exists for ${declared}, which is not a model in the schema`
      );
    }
  }

  // C10 — one model, one answer. The registry merges several objects, and a merge
  // would silently keep the last write, so the sources are compared directly.
  const seenIn = new Map<string, string[]>();
  for (const src of COVERAGE_SOURCES) {
    for (const name of Object.keys(src.models)) {
      seenIn.set(name, [...(seenIn.get(name) ?? []), src.name]);
    }
  }
  for (const [name, where] of seenIn) {
    if (where.length > 1) {
      report(
        "C10-CONFLICTING-CLASSIFICATION",
        name,
        `${name} is classified ${where.length} times: ${where.join(", ")}`
      );
    }
  }

  // C11 — the bridge to E1. A model-level answer that contradicts what the adapter
  // actually does is the same class of lie the field-level contract was built to
  // stop, one level up.
  //
  // "Erasure writes" excludes the lifecycle bookkeeping, so marking a business
  // deleted does not make `Business` erasure-managed.
  const erasureWrites = new Set(
    adapter.writes
      .filter((w) => !LIFECYCLE_WRITES.has(`${w.delegate}.${w.field}`))
      .map((w) => byDelegate.get(w.delegate)?.name)
      .filter((n): n is string => !!n)
  );
  for (const d of adapter.deletes) {
    const n = byDelegate.get(d.delegate)?.name;
    if (n) erasureWrites.add(n);
  }

  for (const [name, cov] of Object.entries(MODEL_COVERAGE)) {
    const touched = erasureWrites.has(name);
    if (cov.disposition === "ERASURE_MANAGED" && !touched) {
      report(
        "C11-MANAGED-BUT-UNTOUCHED",
        name,
        `${name} claims ERASURE_MANAGED and the adapter performs no erasure write or delete on it`
      );
    }
    if (cov.disposition !== "ERASURE_MANAGED" && touched) {
      report(
        "C11-TOUCHED-BUT-UNMANAGED",
        name,
        `the adapter erases ${name} but its model disposition is ${cov.disposition}`
      );
    }
    if (cov.disposition === "RETAINED_BY_DESIGN" && (!cov.reason || !cov.basis)) {
      report("C11-RETENTION-WITHOUT-BASIS", name, `${name} is retained by design without a purpose and a basis`);
    }
    if (
      (cov.disposition === "NON_PERSONAL_OPERATIONAL" || cov.disposition === "SYSTEM_INTERNAL") &&
      !cov.reason
    ) {
      report("C11-DECLARATION-WITHOUT-REASON", name, `${name} is declared ${cov.disposition} with no stated reason`);
    }
    // Both of these ARE findings, by design. The registry being complete is not the
    // same as the erasure being complete, and collapsing the two would be the exact
    // comfortable green this whole programme exists to refuse.
    if (cov.disposition === "UNMANAGED_PERSONAL_DATA") {
      if (!cov.surface || !cov.target) {
        report("C11-UNMANAGED-WITHOUT-TARGET", name, `${name} is unmanaged personal data with no surface or target named`);
      } else {
        report(
          "C12-UNMANAGED-PERSONAL-DATA",
          name,
          `${name} holds personal data the erasure does not touch (${cov.surface}) — ${cov.target}`
        );
      }
    }
    if (cov.disposition === "NEEDS_OWNER_DECISION") {
      if (!cov.question) {
        report("C11-DECISION-WITHOUT-QUESTION", name, `${name} needs a decision but no question is stated`);
      } else {
        report("C13-NEEDS-OWNER-DECISION", name, `${name}: ${cov.question}`);
      }
    }
  }

  // ── C17 — a conditional retention, held to its condition ──────────────────
  //
  // Some columns are retained BECAUSE something else is erased. The provenance
  // pointers on ReceivingSession and PurchaseOrderLine are kept on exactly that
  // basis: they name a `User` row whose email, name and password this same erasure
  // destroys, so they are ids rather than identities.
  //
  // That is a defensible retention and a fragile one. It stops being true the moment
  // `User.email` is reclassified as retained, or the adapter quietly stops writing
  // it — and nothing would announce either. So the condition is declared beside the
  // retention and checked here, in both halves: the dependency must still be
  // dispositioned as destruction, AND the adapter must still carry it out.
  for (const [modelName, table] of Object.entries(DISPOSITIONS)) {
    for (const [fieldName, d] of Object.entries(table)) {
      if (!d.dependsOn) continue;
      const dep = d.dependsOn;
      const key = `${modelName}.${fieldName}`;
      const depModel = models.get(dep.model);
      if (!depModel) {
        report(
          "C17-RETENTION-DEPENDENCY-BROKEN",
          key,
          `${key} is retained because ${dep.model} is erased, and ${dep.model} is not a model in the schema`
        );
        continue;
      }
      for (const depField of dep.fields) {
        const depDisp = DISPOSITIONS[dep.model]?.[depField];
        const depKey = `${key} -> ${dep.model}.${depField}`;
        if (!depDisp) {
          report(
            "C17-RETENTION-DEPENDENCY-BROKEN",
            depKey,
            `${key} is retained because ${dep.model}.${depField} is destroyed, but that column has no disposition`
          );
          continue;
        }
        if (!["ERASE", "ANONYMISE"].includes(depDisp.disposition)) {
          report(
            "C17-RETENTION-DEPENDENCY-BROKEN",
            depKey,
            `${key} is retained because ${dep.model}.${depField} is destroyed, but that column is now ` +
              `dispositioned ${depDisp.disposition} — the pointer identifies a person again`
          );
          continue;
        }
        if (!written.has(`${depModel.delegate}.${depField}`) && !deleted.has(depModel.delegate)) {
          report(
            "C17-RETENTION-DEPENDENCY-BROKEN",
            depKey,
            `${key} is retained because ${dep.model}.${depField} is destroyed, and the adapter no longer writes it`
          );
        }
      }
    }
  }

  // ── C18 — every erasure statement on a covered model is tenant-scoped ──────
  //
  // Row-level security is the enforcing boundary, and the AD-2A battery proves it
  // holds. But under RLS a widened `where` is INVISIBLE: `where: {}` clears the same
  // rows as `where: { businessId }`, because the policy narrows it back. So no runtime
  // test can notice the adapter losing its own scope — and the day the statement runs
  // on a connection that bypasses RLS, it clears every tenant.
  //
  // The shape is therefore held statically, and only two shapes are accepted: a
  // model with a `businessId` column is reached by `{ businessId }`; a model without
  // one (PurchaseOrderLine, which owns through PurchaseOrder) by `{ <relation>:
  // { businessId } }`, where the relation leads to a model that carries it.
  {
    const src = ts.createSourceFile(
      path.basename(ADAPTER),
      fs.readFileSync(ADAPTER, "utf8"),
      ts.ScriptTarget.Latest,
      true
    );
    const covered = new Map(
      COVERED_MODELS.map((n) => models.get(n))
        .filter((m): m is NonNullable<typeof m> => !!m)
        .map((m) => [m.delegate, m])
    );
    const METHODS = new Set(["update", "updateMany", "updateManyAndReturn", "upsert", "delete", "deleteMany"]);
    const hasBusinessId = (m: { fields: { name: string; isScalar: boolean }[] }) =>
      m.fields.some((f) => f.name === "businessId" && f.isScalar);
    /** `{ businessId }` or `{ businessId: businessId }` — exactly that, nothing else. */
    const isBusinessIdOnly = (e: ts.Expression): boolean => {
      if (!ts.isObjectLiteralExpression(e) || e.properties.length !== 1) return false;
      const p = e.properties[0];
      if (ts.isShorthandPropertyAssignment(p)) return p.name.text === "businessId";
      return (
        ts.isPropertyAssignment(p) &&
        ts.isIdentifier(p.name) &&
        p.name.text === "businessId" &&
        ts.isIdentifier(p.initializer) &&
        p.initializer.text === "businessId"
      );
    };

    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        METHODS.has(node.expression.name.text) &&
        ts.isPropertyAccessExpression(node.expression.expression) &&
        covered.has(node.expression.expression.name.text)
      ) {
        const model = covered.get(node.expression.expression.name.text)!;
        const line = src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1;
        const arg = node.arguments[0];
        const where =
          arg && ts.isObjectLiteralExpression(arg)
            ? arg.properties.find(
                (p): p is ts.PropertyAssignment =>
                  ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "where"
              )
            : undefined;
        let scoped = false;
        if (where && hasBusinessId(model)) {
          scoped = isBusinessIdOnly(where.initializer);
        } else if (
          where &&
          ts.isObjectLiteralExpression(where.initializer) &&
          where.initializer.properties.length === 1
        ) {
          const rel = where.initializer.properties[0];
          if (ts.isPropertyAssignment(rel) && ts.isIdentifier(rel.name)) {
            const relField = model.fields.find(
              (f) => f.name === (rel.name as ts.Identifier).text && !f.isScalar && !f.isList
            );
            const parent = relField ? models.get(relField.type) : undefined;
            scoped = !!parent && hasBusinessId(parent) && isBusinessIdOnly(rel.initializer);
          }
        }
        if (!scoped) {
          report(
            "C18-UNSCOPED-ERASURE-WRITE",
            `${model.name}@adapter`,
            `${model.name}.${node.expression.name.text}() at adapter line ${line} is not scoped to the tenant: ` +
              `expected ${hasBusinessId(model) ? "`where: { businessId }`" : "`where: { <relation>: { businessId } }`"}, ` +
              `found ${where ? where.initializer.getText(src) : "no `where`"}`
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(src);
  }

  // ── C19…C23 — S8: the objects, which are not the rows ─────────────────────
  //
  // A model-level disposition answers "does the erasure touch this table". It cannot
  // answer "and the bytes the row points at?", and that silence had a cost:
  // `CrmAttachment` is ERASURE_MANAGED, the erasure deleted the row, the object stayed
  // in storage — and the `storageKey` went with the row, so nothing could even find it
  // afterwards. No finding existed that could say so.
  //
  // These five codes are a SECOND dimension, keyed by surface. They do not weaken or
  // replace C12: a model can be fully ERASURE_MANAGED and still carry an OPEN object
  // surface, and resolving the model-level finding cannot make this one disappear.
  {
    const surfaceKey = (s: { model: string; field: string }) => `${s.model}.${s.field}`;
    const declared = new Map(OBJECT_SURFACES.map((s) => [surfaceKey(s), s]));
    const notOwned = new Map(NOT_OWNED_POINTERS.map((p) => [surfaceKey(p), p]));

    // C21 — a declaration that no longer describes the schema, or that does not carry
    // what its own state requires, is not a classification. It is a leftover.
    for (const [key, s] of [
      ...[...declared.entries()],
      ...[...notOwned.entries()],
    ] as [string, { model: string; field: string; reason: string }][]) {
      const model = models.get(s.model);
      const field = model?.fields.find((f) => f.name === s.field && f.isScalar);
      if (!model) report("C21-OBJECT-SURFACE-INVALID", key, `declares ${s.model}, which is not a model in the schema`);
      else if (!field) report("C21-OBJECT-SURFACE-INVALID", key, `declares ${s.model}.${s.field}, which is not a column on it`);
      if (!s.reason) report("C21-OBJECT-SURFACE-INVALID", key, "no reason is stated");
      const surface = declared.get(key);
      if (!surface) continue;
      if (surface.state === "RETAINED" && !surface.basis) {
        report("C21-OBJECT-SURFACE-INVALID", key, "RETAINED without a basis");
      }
      if (surface.state === "ERASED" && !surface.erasedBy) {
        report("C21-OBJECT-SURFACE-INVALID", key, "ERASED without naming the function that deletes the object");
      }
      if ((surface.state === "OPEN" || surface.state === "OPEN_INERT") && !surface.target) {
        report("C21-OBJECT-SURFACE-INVALID", key, `${surface.state} without a target increment`);
      }
    }

    // C20 — completeness. Every pointer-shaped column in the schema must have an
    // answer: an owned object surface, or a stated reason why it is not one.
    for (const model of models.values()) {
      for (const f of model.fields) {
        if (!f.isScalar || f.isId || f.type !== "String") continue;
        if (!POINTER_NAME_PATTERN.test(f.name)) continue;
        const key = `${model.name}.${f.name}`;
        if (!declared.has(key) && !notOwned.has(key)) {
          report(
            "C20-UNDECLARED-OBJECT-POINTER",
            key,
            `${key} looks like a pointer to stored bytes and is declared neither as an object surface nor as not-owned`
          );
        }
      }
    }

    // C22 — an ERASED claim has to be carried out, and in the right ORDER. Deleting
    // the row first destroys the only key the application has; after that no retry can
    // find the object. So the named deleter must appear in the adapter, and it must
    // appear BEFORE the write or delete on the delegate that holds the pointer.
    {
      const src = ts.createSourceFile(
        path.basename(ADAPTER),
        fs.readFileSync(ADAPTER, "utf8"),
        ts.ScriptTarget.Latest,
        true
      );
      const callLines = (predicate: (n: ts.CallExpression) => boolean) => {
        const out: number[] = [];
        const walk = (n: ts.Node) => {
          if (ts.isCallExpression(n) && predicate(n)) {
            out.push(src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1);
          }
          ts.forEachChild(n, walk);
        };
        walk(src);
        return out;
      };
      for (const s of OBJECT_SURFACES) {
        if (s.state !== "ERASED" || !s.erasedBy) continue;
        const key = surfaceKey(s);
        const fnName = s.erasedBy.fn;
        const delegate = s.erasedBy.beforeDelegate;
        const eraser = callLines(
          (n) =>
            (ts.isIdentifier(n.expression) && n.expression.text === fnName) ||
            (ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === fnName)
        );
        const rowWrite = callLines(
          (n) =>
            ts.isPropertyAccessExpression(n.expression) &&
            ts.isPropertyAccessExpression(n.expression.expression) &&
            n.expression.expression.name.text === delegate &&
            /^(delete|deleteMany|update|updateMany|upsert)$/.test(n.expression.name.text)
        );
        if (eraser.length === 0) {
          report(
            "C22-OBJECT-ERASURE-NOT-IMPLEMENTED",
            key,
            `${key} is declared ERASED, but the adapter never calls ${fnName}()`
          );
          continue;
        }
        if (rowWrite.length === 0) {
          report(
            "C22-OBJECT-ERASURE-NOT-IMPLEMENTED",
            key,
            `${key} is declared ERASED before the ${delegate} row write, and the adapter performs none`
          );
          continue;
        }
        if (Math.min(...eraser) > Math.min(...rowWrite)) {
          report(
            "C22-OBJECT-ERASURE-NOT-IMPLEMENTED",
            key,
            `the adapter writes ${delegate} at line ${Math.min(...rowWrite)} before calling ${fnName}() at line ${Math.min(
              ...eraser
            )} — the key is destroyed before the object`
          );
        }
      }
    }

    // C23 — "nothing can create such an object yet" is a claim about the product, and
    // it expires the moment somebody writes the column. Proven, not asserted.
    const inert = OBJECT_SURFACES.filter((s) => s.state === "OPEN_INERT");
    if (inert.length > 0) {
      const delegates = new Set(
        inert.map((s) => models.get(s.model)?.delegate).filter((d): d is string => !!d)
      );
      const scan = scanCodebaseWrites(ROOT, ["app", "lib"], delegates);
      for (const s of inert) {
        const delegate = models.get(s.model)?.delegate;
        const writers = scan.writes.filter(
          (w) => w.delegate === delegate && w.fields.some((f) => f.name === s.field)
        );
        if (writers.length > 0) {
          report(
            "C23-INERT-OBJECT-SURFACE-HAS-WRITER",
            surfaceKey(s),
            `${surfaceKey(s)} is declared OPEN_INERT, but ${writers
              .map((w) => `${w.file}:${w.line}`)
              .join(", ")} writes it`
          );
        }
      }
      for (const u of scan.unreadable) report("C0-UNREADABLE", u.file, u.detail);
    }

    // C19 — the debt itself. One finding per surface the erasure does not reach. This
    // is what survives a model's C12 being resolved.
    for (const s of OBJECT_SURFACES) {
      if (s.state !== "OPEN" && s.state !== "OPEN_INERT") continue;
      report(
        "C19-EXTERNAL-OBJECT-UNERASED",
        surfaceKey(s),
        `${surfaceKey(s)} points at stored bytes the erasure does not delete (${s.state}) — ${s.reason} [target ${s.target}]`
      );
    }
  }

  // ── C14…C16 — NON_PERSONAL_OPERATIONAL, proven instead of promised ─────────
  //
  // Four models were classified UNMANAGED_PERSONAL_DATA on the assumption that a
  // text column is personal data. Three of them cannot receive a person at all —
  // one has no writer in the product, one is filled from a fixed rule table, one
  // interpolates a stock item's name — and the fourth's only text column is a
  // product name. Reclassifying them is a correction, not an erasure.
  //
  // But a correction that rests on "no writer exists today" expires the first time
  // somebody writes one, and nothing would say so. These three checks are what
  // stop the correction from rotting into a false green.
  const evidenced = Object.entries(MODEL_COVERAGE).filter(
    ([, cov]) => cov.disposition === "NON_PERSONAL_OPERATIONAL" && cov.evidence
  );

  if (evidenced.length > 0) {
    const watched = new Set<string>();
    for (const [name, cov] of evidenced) {
      const model = models.get(name);
      if (model) watched.add(model.delegate);
      for (const via of cov.evidence!.viaDelegates ?? []) watched.add(via);
    }

    const scan = scanCodebaseWrites(ROOT, ["app", "lib", "scripts"], watched);

    // Fail closed. A file the scanner could not read is not evidence of absence —
    // it is the absence of evidence, and E1's whole premise is that those are not
    // the same thing.
    for (const u of scan.unreadable) {
      report("C0-UNREADABLE", `scan:${u.file}`, `${u.file}: ${u.detail}`);
    }

    for (const [name, cov] of evidenced) {
      const ev = cov.evidence!;
      const model = models.get(name);
      if (!model) continue; // C9 already reported it.

      // ── C14 — the schema may not grow a text column behind the claim ───────
      const actual = model.fields
        .filter((f) => f.isScalar && !f.isId && (f.type === "String" || f.type === "Json"))
        .map((f) => f.name);
      const declared = new Set(ev.textualSurface);
      for (const col of actual) {
        if (!declared.has(col)) {
          report(
            "C14-TEXTUAL-SURFACE-DRIFT",
            `${name}.${col}`,
            `${name}.${col} is a text column that ${name}'s non-personal evidence does not account for — ` +
              `classify it or add it to textualSurface`
          );
        }
      }
      for (const col of ev.textualSurface) {
        if (!actual.includes(col)) {
          report(
            "C14-STALE-TEXTUAL-SURFACE",
            `${name}.${col}`,
            `${name}'s evidence names ${col}, which is no longer a text column on that model`
          );
        }
      }

      // ── C15 — only declared files may write it ─────────────────────────────
      const own = model.delegate;
      const via = new Set(ev.viaDelegates ?? []);
      const allowed = new Set(ev.writeSites);
      const surface = new Set(ev.textualSurface);
      for (const w of scan.writes) {
        // A via-delegate counts in full. It is declared precisely because this
        // model is created through it, so every file that writes the parent is a
        // file that can write the child — narrowing that would reintroduce the
        // guess the declaration exists to remove.
        if (w.delegate !== own && !via.has(w.delegate)) continue;
        if (!allowed.has(w.file)) {
          report(
            "C15-UNDECLARED-WRITE-SITE",
            `${name}@${w.file}`,
            `${w.file} writes ${name} via ${w.delegate}.${w.method}() (line ${w.line}) and is not a declared ` +
              `write site for a model classified NON_PERSONAL_OPERATIONAL`
          );
        }
      }

      // ── C16 — the written value must be system-derived ─────────────────────
      if (ev.derivedFrom) {
        const ok = new Set(ev.derivedFrom);
        for (const w of scan.writes) {
          if (w.delegate !== own) continue;
          for (const f of w.fields) {
            if (!surface.has(f.name)) continue;
            if (!isSystemDerived(f.value, ok)) {
              report(
                "C16-NON-DERIVED-VALUE",
                `${name}.${f.name}@${w.file}:${f.line}`,
                `${w.file} writes ${name}.${f.name} (line ${f.line}) from something other than a literal or a ` +
                  `template over [${ev.derivedFrom.join(", ")}] — the non-personal claim does not cover it`
              );
            }
          }
        }
      }
    }
  }

  // ── Result ─────────────────────────────────────────────────────────────────
  const baselineMode = process.argv.includes("--baseline-check");
  const accepted = new Set(ACCEPTED_DEBT.map((d) => debtKey(d)));
  const seen = new Set(findings.map((f) => debtKey(f)));

  const fresh = findings.filter((f) => !accepted.has(debtKey(f)));
  const fixed = [...accepted].filter((k) => !seen.has(k));

  if (findings.length === 0) {
    console.log("[contract] NO FINDINGS — schema, manifest and adapter agree on every field.");
  } else {
    console.log(`\n[contract] ${findings.length} finding(s):\n`);
    const byCode = new Map<string, Finding[]>();
    for (const f of findings) byCode.set(f.code, [...(byCode.get(f.code) ?? []), f]);
    for (const [code, list] of [...byCode.entries()].sort()) {
      console.log(`  ${code}  (${list.length})`);
      for (const f of list) {
        console.log(`    ${accepted.has(debtKey(f)) ? "known" : " NEW "}  ${f.detail}`);
      }
      console.log("");
    }
  }

  if (!baselineMode) {
    console.log(
      findings.length === 0
        ? "[contract] PASS"
        : `[contract] FAIL — ${findings.length} finding(s). This is the honest mode: it is red while the contract is broken.`
    );
    return findings.length === 0 ? 0 : 1;
  }

  console.log("--- baseline check ---");
  console.log(`NEW FINDINGS      = ${fresh.length}`);
  console.log(`ACCEPTED DEBT     = ${accepted.size}`);
  console.log(`DEBT NOW RESOLVED = ${fixed.length}`);
  for (const f of fresh) console.log(`  NEW    ${f.code}  ${f.detail}`);
  for (const k of fixed) console.log(`  FIXED  ${k}`);

  if (fresh.length > 0) {
    console.log(
      "\nBASELINE FAIL — the erasure contract broke in a NEW place. Either implement it or, " +
        "if it is a deliberate deferral, record it in erasure-contract-debt.ts with a reason."
    );
    return 1;
  }
  if (fixed.length > 0) {
    console.log(
      "\nBASELINE FAIL — recorded debt is now clean. Remove those entries from " +
        "erasure-contract-debt.ts so the improvement is locked in and cannot silently regress."
    );
    return 1;
  }
  console.log("\nBASELINE OK — the failure set is exactly the recorded debt.");
  return 0;
}

process.exit(main());
