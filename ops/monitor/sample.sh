#!/usr/bin/env bash
# Production uptime monitor — sampler.
#
# Requests PUBLIC, unauthenticated pages of Production (no cookies, no credentials, no secrets) at a
# low rate and writes one TSV row per request: target path, round, HTTP code, TTFB / total (ms),
# curl exit code, whether Vercel's Security Checkpoint challenged it, x-vercel-cache, the region
# path of x-vercel-id (request id stripped) and the <html lang> attribute. Bodies are never logged.
#
# Round 0 is a warm-up (discarded by the evaluator); rounds 1..N are the samples. Rounds are
# interleaved (every target once per round) with ~SPACING seconds between ANY two requests, so the
# monitor never looks like a burst to the checkpoint and temporal noise hits all targets equally.
#
# Usage: bash ops/monitor/sample.sh OUT.tsv [BASELINE.json]
set -uo pipefail

OUT="${1:?usage: sample.sh OUT.tsv [BASELINE.json]}"
BASELINE="${2:-$(dirname "$0")/prod-baseline.json}"
SAMPLES="${MONITOR_SAMPLES:-5}"
SPACING="${MONITOR_SPACING_S:-2}"

readb='const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));'
BASE="$(node -e "$readb"'process.stdout.write(b.base)' "$BASELINE")"
TARGETS="$(node -e "$readb"'process.stdout.write([b.reference,...Object.keys(b.targets)].join(" "))' "$BASELINE")"
case "$BASE" in https://*) ;; *) echo "::error::baseline base must be https" >&2; exit 2 ;; esac

work="$(mktemp -d "${RUNNER_TEMP:-/tmp}/prod-monitor-XXXXXX")"
trap 'rm -rf "$work"' EXIT

printf 'target\tround\tcode\tttfb_ms\ttotal_ms\tcurl_exit\tmitigated\tcache\tregions\tlang\n' > "$OUT"

first=1
for round in $(seq 0 "$SAMPLES"); do
  for t in $TARGETS; do
    [ "$first" = 1 ] || sleep "$SPACING"
    first=0
    hdr="$work/h"; body="$work/b"
    : > "$hdr"; : > "$body"
    meta="$(curl -sS -o "$body" -D "$hdr" -w '%{http_code} %{time_starttransfer} %{time_total}' \
      --max-time 20 --connect-timeout 10 "$BASE$t" 2>/dev/null)"
    cexit=$?
    read -r code ttfb total <<< "${meta:-000 0 0}"
    ttfb_ms="$(awk -v s="${ttfb:-0}" 'BEGIN{printf "%d", s*1000+0.5}')"
    total_ms="$(awk -v s="${total:-0}" 'BEGIN{printf "%d", s*1000+0.5}')"
    h() { tr -d '\r' < "$hdr" | grep -i "^$1:" | tail -1 | cut -d: -f2- | sed 's/^ *//'; }
    mitigated="$(h x-vercel-mitigated | tr -cd 'A-Za-z-' | cut -c1-20)"
    cache="$(h x-vercel-cache | tr -cd 'A-Za-z_-' | cut -c1-20)"
    # x-vercel-id = "<edge>::[<fn region>::]<request id>" -> keep only the region path.
    regions="$(h x-vercel-id | awk -F'::' '{o=""; for(i=1;i<NF;i++){o=o (i>1?"::":"") $i} print o}' | tr -cd 'a-z0-9:' | cut -c1-40)"
    lang="-"
    if [ "$code" = "200" ] && h content-type | grep -qi 'text/html'; then
      lang="$(grep -oiE '<html[^>]*>' "$body" | head -1 | grep -oiE '[[:space:]]lang="[^"]*"' | head -1 | cut -d'"' -f2 | tr -cd 'A-Za-z-' | cut -c1-10)"
      [ -n "$lang" ] || lang="none"
    fi
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$t" "$round" "$code" "$ttfb_ms" "$total_ms" "$cexit" \
      "${mitigated:--}" "${cache:--}" "${regions:--}" "$lang" >> "$OUT"
    printf 'round %s %-24s HTTP %s ttfb=%sms cache=%s regions=%s%s\n' "$round" "$t" "$code" "$ttfb_ms" \
      "${cache:--}" "${regions:--}" "$([ -n "$mitigated" ] && echo " mitigated=$mitigated")"
  done
done
