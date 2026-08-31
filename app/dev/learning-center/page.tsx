"use client";

/**
 * Learning Center v1 — internal page (platform-admin only; gated by the API).
 * READ-ONLY decision-support view over the General Decision Ledger. Not a
 * user-facing feature. Simple functional UI (not final design).
 */

import { useEffect, useState } from "react";
import type {
  LearningCenterOverview,
  TimeWindowKey,
} from "@/lib/services/learning-center/learning-center.types";

type State =
  | { status: "loading" }
  | { status: "error"; code: number; message: string }
  | { status: "ready"; data: LearningCenterOverview };

const WINDOWS: TimeWindowKey[] = ["all", "24h", "7d", "30d"];

function pct(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}
function num(n: number | null): string {
  return n === null ? "—" : String(n);
}

const cell: React.CSSProperties = { padding: "6px 10px", borderBottom: "1px solid var(--dz-border-subtle)", textAlign: "left" };
const th: React.CSSProperties = { ...cell, fontWeight: 600, background: "var(--dz-surface-muted)" };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 24 }}>
      <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>{title}</h2>
      {children}
    </section>
  );
}

export default function LearningCenterPage() {
  const [windowKey, setWindowKey] = useState<TimeWindowKey>("all");
  const [state, setState] = useState<State>({ status: "loading" });

  // Fetch on mount and whenever the window changes. setState only runs after an
  // await (never synchronously in the effect body); the "loading" indicator is
  // driven by the initial state and the picker handler below.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch(`/api/dev/learning-center?window=${windowKey}`, {
          cache: "no-store",
        });
        if (!active) return;
        if (!res.ok) {
          setState({
            status: "error",
            code: res.status,
            message:
              res.status === 401 || res.status === 403
                ? "Platform-admin access required."
                : `Request failed (${res.status})`,
          });
          return;
        }
        const data = (await res.json()) as LearningCenterOverview;
        if (!active) return;
        setState({ status: "ready", data });
      } catch (err) {
        if (active) {
          setState({
            status: "error",
            code: 0,
            message: err instanceof Error ? err.message : "Unknown error",
          });
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [windowKey]);

  function onPick(w: TimeWindowKey) {
    setState({ status: "loading" });
    setWindowKey(w);
  }

  return (
    <div style={{ padding: 32, maxWidth: 1100, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 22, margin: 0 }}>Learning Center</h1>
      <p style={{ color: "var(--dz-text-secondary)", marginTop: 4 }}>
        Internal decision-support over the General Decision Ledger. Read-only.
      </p>

      <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
        {WINDOWS.map((w) => (
          <button
            key={w}
            onClick={() => setWindowKey(w)}
            style={{
              padding: "6px 12px",
              borderRadius: 6,
              border: "1px solid var(--dz-border-strong)",
              background: windowKey === w ? "var(--dz-info-accent)" : "var(--dz-surface)",
              color: windowKey === w ? "var(--dz-text-on-brand)" : "var(--dz-text-primary)",
              cursor: "pointer",
            }}
          >
            {w}
          </button>
        ))}
      </div>

      {state.status === "loading" ? <p style={{ marginTop: 24 }}>Loading…</p> : null}
      {state.status === "error" ? (
        <p style={{ marginTop: 24, color: "crimson" }}>
          {state.message} {state.code ? `(${state.code})` : ""}
        </p>
      ) : null}

      {state.status === "ready" ? <Overview data={state.data} /> : null}
    </div>
  );
}

function Overview({ data }: { data: LearningCenterOverview }) {
  return (
    <>
      <Section title="Volume">
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
          <Stat label="Documents analyzed" value={num(data.volume.documentsAnalyzed)} />
          <Stat label="Snapshots" value={num(data.volume.snapshots)} />
          <Stat label="With geometry" value={`${num(data.volume.withGeometry)} (${pct(data.volume.geometryRate)})`} />
          <Stat label="Amount slice runs" value={num(data.volume.sliceProducedAmount)} />
        </div>
      </Section>

      <Section title="Decisions by layer / stage">
        <Table head={["Layer", "Stage", "Count"]}
          rows={data.decisionsByLayerStage.map((r) => [r.layer, r.stage, String(r.count)])} />
      </Section>

      <Section title="Engine identity (derived — no engineId column)">
        <Table head={["Engine", "Produced by", "Count"]}
          rows={data.decisionsByEngine.map((r) => [r.engineId, r.producedBy, String(r.count)])} />
      </Section>

      <Section title="Slice vs Legacy agreement">
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
          <Stat label="Agree" value={num(data.sliceVsLegacy.agree)} />
          <Stat label="Disagree" value={num(data.sliceVsLegacy.disagree)} />
          <Stat label="Slice abstain" value={num(data.sliceVsLegacy.sliceAbstain)} />
          <Stat label="Agreement rate" value={pct(data.sliceVsLegacy.agreementRate)} />
        </div>
      </Section>

      <Section title="Correction rate by field">
        <Table head={["Field", "Corrected", "Confirmed", "Rate"]}
          rows={data.correctionByField.map((r) => [r.field, String(r.corrected), String(r.confirmed), pct(r.correctionRate)])} />
      </Section>

      <Section title="Coverage by field">
        <Table head={["Field", "Resolved", "Total", "Coverage"]}
          rows={data.coverageByField.map((r) => [r.fieldKey, String(r.resolved), String(r.total), pct(r.coverageRate)])} />
      </Section>

      <Section title="Produced by (slice vs legacy) per field">
        <Table head={["Field", "Slice", "Legacy", "Total"]}
          rows={data.producedByField.map((r) => [r.fieldKey, String(r.slice), String(r.legacy), String(r.total)])} />
      </Section>

      <Section title="Timeline (snapshots & corrections per day)">
        <Table head={["Date", "Snapshots", "Corrections"]}
          rows={data.trend.map((r) => [r.dateIso, String(r.snapshots), String(r.corrections)])} />
      </Section>

      <Section title="Amount slice performance">
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
          <Stat label="Resolved" value={num(data.amountSlice.resolved)} />
          <Stat label="Ambiguous" value={num(data.amountSlice.ambiguous)} />
          <Stat label="Unresolved" value={num(data.amountSlice.unresolved)} />
          <Stat label="Agreement" value={pct(data.amountSlice.agreement.agreementRate)} />
          <Stat label="Resolved-but-corrected" value={num(data.amountSlice.resolvedButCorrected)} />
          <Stat label="Abstained-but-needed" value={num(data.amountSlice.abstainedButNeeded)} />
        </div>
        <p style={{ color: "var(--dz-text-secondary)", fontSize: 13, marginTop: 8 }}>
          basis: {Object.entries(data.amountSlice.byBasis).map(([k, v]) => `${k}=${v}`).join(", ") || "—"}
        </p>
      </Section>

      <Section title="Promotion readiness (advisory — never auto-promotes)">
        <Table head={["Field", "Slice n", "Agreement", "Slice right", "Legacy right", "Score", "Readiness"]}
          rows={data.promotion.map((r) => [
            r.fieldKey,
            String(r.producedBySlice),
            pct(r.agreementRate),
            String(r.sliceRight),
            String(r.legacyRight),
            String(r.readinessScore),
            r.readiness,
          ])} />
      </Section>

      <Section title="Outcome by field (who was right vs human final)">
        <Table head={["Field", "Slice right", "Legacy right", "Both wrong", "Confirmed", "Corrected", "Undetermined"]}
          rows={data.outcomeByField.map((r) => [
            r.fieldKey, String(r.sliceRight), String(r.legacyRight), String(r.bothWrong),
            String(r.userConfirmed), String(r.userCorrected), String(r.undetermined),
          ])} />
      </Section>

      <Section title="Evidence quality">
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
          <Stat label="Geometry" value={pct(data.evidenceQuality.geometryRate)} />
          <Stat label="Reasoning" value={pct(data.evidenceQuality.reasoningRate)} />
          <Stat label="Quality score" value={num(data.evidenceQuality.evidenceQualityScore)} />
        </div>
      </Section>

      <Section title="Engine health (not collected yet — future instrumentation)">
        <Table head={["Engine", "Status", "Runs", "Failures", "Avg ms"]}
          rows={data.engineHealth.map((r) => [r.engineId, r.status, num(r.totalRuns), num(r.failures), num(r.avgRuntimeMs)])} />
      </Section>

      <p style={{ color: "var(--dz-text-muted)", fontSize: 12, marginTop: 24 }}>
        generated {data.generatedAt} · window {data.window.key}
      </p>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ minWidth: 120 }}>
      <div style={{ fontSize: 12, color: "var(--dz-text-muted)" }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600 }}>{value}</div>
    </div>
  );
}

function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 14 }}>
      <thead>
        <tr>{head.map((h) => <th key={h} style={th}>{h}</th>)}</tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr><td style={cell} colSpan={head.length}>No data</td></tr>
        ) : (
          rows.map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j} style={cell}>{c}</td>)}</tr>
          ))
        )}
      </tbody>
    </table>
  );
}
