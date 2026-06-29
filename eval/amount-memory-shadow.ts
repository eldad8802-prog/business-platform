/**
 * Phase 2 MVP — Amount Memory, SHADOW runner (run manually):
 *   npx tsx --env-file=.env eval/amount-memory-shadow.ts
 *
 * Wires the full pipeline END-TO-END, read-only, zero production touch:
 *   Correction Ledger → Memory Extraction → Prior Generation
 *     → Shadow Re-Ranking → Measurement
 *
 * It NEVER changes a live decision. With an empty/low-support ledger the priors
 * are inactive and memory reports "No Effect" — a valid state. The point of this
 * step is a working, measurable pipeline that is ready when data arrives.
 */

import fs from "fs";
import path from "path";
import { prisma } from "@/lib/prisma";
import { runGoogleVisionOCRWithGeometry } from "@/lib/services/documents/google-vision-ocr.service";
import { buildRepresentationFromOcr } from "@/lib/services/documents/representation/document-representation";
import { groupTokensGeometrically } from "@/lib/services/documents/representation/document-grouping";
import { deriveMoneyAmounts } from "@/lib/services/documents/representation/document-money-amount";
import { findAmountRelationsFromMoneyAmounts } from "@/lib/services/documents/representation/document-amount-relations";
import { deriveAmountRoles } from "@/lib/services/documents/representation/document-amount-roles";
import { readAmount } from "@/lib/services/documents/representation/document-amount-readout";
import { runUnifiedDocumentIntelligence } from "@/lib/services/documents/unified-extraction-engine.service";
import {
  loadAmountCorrectionsFromLedger,
  type RawAmountCorrection,
} from "@/lib/services/documents/memory/amount-correction-source";
import {
  accumulate,
  bandOfNormalizedY,
  buildAmountPriors,
  emptyMeasurement,
  reRankAmount,
  scopeKey,
  type AmountCandidate,
  type AmountCorrection,
  type AmountScopeKey,
} from "@/lib/services/documents/memory/amount-memory";

// ---- corpus helpers ----------------------------------------------------------
function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
const isMedia = (f: string) => /\.(jpe?g|png|pdf)$/i.test(f);
const mimeFor = (f: string) =>
  f.toLowerCase().endsWith(".pdf") ? "application/pdf" : f.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
function businessIdFor(file: string): number {
  const norm = file.replace(/\\/g, "/");
  const m = norm.match(/storage\/documents\/(\d+)\//) || norm.match(/storage\/platform\/biz\/(\d+)\//);
  return m ? Number(m[1]) : 1;
}
function sampleUploads(cap: number): string[] {
  const all = walk(path.join("public", "uploads")).filter(isMedia).sort();
  if (all.length === 0) return [];
  const stride = Math.max(1, Math.floor(all.length / cap));
  return all.filter((_, i) => i % stride === 0).slice(0, cap);
}
async function silence<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log, err = console.error;
  console.log = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.log = log; console.error = err; }
}

// ---- candidate extraction (value + value-free vertical band) ------------------
type MoneyLike = { magnitude: number; sourceTokens: Array<{ geometry?: { bbox?: { y?: number } | null } }> };

function buildCandidates(money: MoneyLike[], currentWinner: number | null): AmountCandidate[] {
  const ys = money.map((m) => m.sourceTokens[0]?.geometry?.bbox?.y ?? null);
  const valid = ys.filter((y): y is number => y != null);
  const minY = valid.length ? Math.min(...valid) : 0;
  const maxY = valid.length ? Math.max(...valid) : 1;
  const span = maxY - minY;
  return money.map((m, i) => {
    const y = ys[i];
    const normY = y == null ? null : span > 0 ? (y - minY) / span : 0.5;
    return {
      value: m.magnitude,
      band: bandOfNormalizedY(normY),
      isCurrentWinner: currentWinner != null && Math.abs(m.magnitude - currentWinner) <= 0.01,
    };
  });
}

type Analyzed = {
  candidates: AmountCandidate[];
  currentWinner: number | null;
  currentResolved: boolean;
  scope: AmountScopeKey;
};

async function analyzeFile(file: string): Promise<Analyzed> {
  const ocr = await silence(() => runGoogleVisionOCRWithGeometry(path.resolve(file), mimeFor(file)));
  const rep = buildRepresentationFromOcr(ocr);
  const grouping = groupTokensGeometrically(rep);
  const money = deriveMoneyAmounts(rep);
  const relation = findAmountRelationsFromMoneyAmounts(money, grouping);
  const roles = deriveAmountRoles(relation, grouping);
  const readout = readAmount(roles, money);
  const legacy = await silence(() =>
    runUnifiedDocumentIntelligence({ businessId: businessIdFor(file), rawText: ocr.text })
  );
  return {
    candidates: buildCandidates(money as unknown as MoneyLike[], readout.value),
    currentWinner: readout.value,
    currentResolved: readout.resolutionState === "resolved",
    scope: {
      businessId: businessIdFor(file),
      vendor: (legacy.vendorName ?? "").trim(),
      docType: String(legacy.documentType ?? "unknown"),
      direction: String(legacy.direction ?? "unknown"),
    },
  };
}

// ---- correction enrichment (won candidate's band) ----------------------------
async function resolveFile(documentId: number): Promise<string | null> {
  const doc = await prisma.document.findUnique({
    where: { id: documentId },
    select: { fileUrl: true, businessId: true },
  });
  if (!doc?.fileUrl) return null;
  const candidates = [
    path.join("storage", "documents", String(doc.businessId), doc.fileUrl),
    path.join("storage", "platform", "biz", String(doc.businessId), doc.fileUrl),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

async function enrich(raw: RawAmountCorrection): Promise<AmountCorrection> {
  let wonBand: AmountCorrection["wonBand"] = null;
  try {
    const file = await resolveFile(raw.documentId);
    if (file) {
      const a = await analyzeFile(file);
      const won = a.candidates.find((k) => Math.abs(k.value - raw.humanAmount) <= 0.01);
      wonBand = won?.band ?? null;
    }
  } catch {
    /* best-effort; unlocatable winners simply do not contribute to support */
  }
  return { scope: raw.scope, documentId: raw.documentId, humanAmount: raw.humanAmount, wonBand };
}

// ---- main --------------------------------------------------------------------
async function main(): Promise<void> {
  // 1. Correction Ledger
  let raw: RawAmountCorrection[] = [];
  try {
    raw = await loadAmountCorrectionsFromLedger();
  } catch (e) {
    console.error("ledger read failed (table missing / not activated?):", e instanceof Error ? e.message : e);
  }
  console.log("corrections loaded from ledger:", raw.length);

  // 2. Memory Extraction (enrich with winning band)
  const corrections: AmountCorrection[] = [];
  for (const c of raw) corrections.push(await enrich(c));
  const located = corrections.filter((c) => c.wonBand != null).length;
  console.log("corrections with locatable winner:", located);

  // 3. Prior Generation
  const priors = buildAmountPriors(corrections);
  const active = [...priors.values()].filter((p) => p.preferredBand != null);
  console.log(`priors: ${priors.size} scopes, ${active.length} active (>=support & consistent)`);

  // 4 + 5. Shadow Re-Ranking + Measurement over the representation corpus
  const corpus = [
    ...Array.from(new Set([...walk("storage/documents"), ...walk("storage/platform")])).filter(
      (f) => isMedia(f) && /[\\/]documents[\\/]/.test(f)
    ),
    ...sampleUploads(40),
  ];
  console.log(`re-rank corpus: ${corpus.length} documents\n`);

  let m = emptyMeasurement();
  m.priorsAvailable = priors.size;
  m.priorsActive = active.length;
  const sample: unknown[] = [];

  for (const file of corpus) {
    try {
      const a = await analyzeFile(file);
      const prior = priors.get(scopeKey(a.scope)) ?? null;
      const outcome = reRankAmount({
        candidates: a.candidates,
        currentWinner: a.currentWinner,
        currentResolved: a.currentResolved,
        prior,
      });
      m = accumulate(m, outcome, null); // no verdict for corpus files
      if (outcome.changed || sample.length < 6) {
        sample.push({
          file: file.replace(/\\/g, "/").replace("storage/", ""),
          vendor: a.scope.vendor || "?",
          current: outcome.currentWinner,
          memory: outcome.memoryWinner,
          changed: outcome.changed,
          reason: outcome.reason,
        });
      }
    } catch {
      /* skip unreadable file */
    }
  }

  console.log("==================== AMOUNT MEMORY — SHADOW REPORT ====================");
  console.log("documents re-ranked:        ", m.documentsReRanked);
  console.log("priors available (scopes):  ", m.priorsAvailable);
  console.log("priors active:              ", m.priorsActive);
  console.log("prior applied (docs):       ", m.priorApplied);
  console.log("winner changed by memory:   ", m.winnerChanged);
  console.log("no effect:                  ", m.noEffect);
  console.log("with human verdict:         ", m.withVerdict);
  console.log("current agrees human:       ", m.currentAgreesHuman);
  console.log("memory agrees human:        ", m.memoryAgreesHuman);
  console.log("memory NET agreement delta: ", m.memoryNetAgreementDelta, "(>0 = memory helped)");
  console.log("\n---- sample ----");
  for (const s of sample) console.log(JSON.stringify(s));

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  try { await prisma.$disconnect(); } catch { /* noop */ }
  process.exit(1);
});
