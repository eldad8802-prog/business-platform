// DIAGNOSTIC ONLY — issue 3: exactly which bytes the branch adds to each English HTML document.
// usage: node scripts/native/html-bytes-diff.mjs <dir with before-*.html / after-*.html>
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const dir = process.argv[2];
for (const f of readdirSync(dir).filter((x) => x.startsWith("before-")).sort()) {
  const a = readFileSync(join(dir, f), "utf8");
  const b = readFileSync(join(dir, f.replace("before-", "after-")), "utf8");
  // Strip both sides of build-specific hashes so only content differences remain.
  const norm = (s) => s.replace(/\/_next\/static\/[^"'\s)]+/g, "/_next/static/X").replace(/"buildId":"[^"]+"/g, '"buildId":"X"').replace(/\b[0-9a-f]{16,}\b/g, "H");
  const na = norm(a), nb = norm(b);
  let i = 0; while (i < na.length && na[i] === nb[i]) i++;
  let j = 0; while (j < na.length - i && na[na.length - 1 - j] === nb[nb.length - 1 - j]) j++;
  console.log(`\n${f.replace("before-", "")}: raw ${Buffer.byteLength(a)} → ${Buffer.byteLength(b)} (+${Buffer.byteLength(b) - Buffer.byteLength(a)}), normalized +${Buffer.byteLength(nb) - Buffer.byteLength(na)}`);
  // Walk all differing segments with a simple greedy LCS over chunks of the normalized text.
  const segs = [];
  let x = 0, y = 0;
  while (x < na.length || y < nb.length) {
    if (na[x] === nb[y]) { x++; y++; continue; }
    // find resync: smallest k where nb.substr(y+k, 24) appears at na x.. within window
    let found = false;
    for (let k = 1; k < 4000 && !found; k++) {
      const probe = nb.substr(y + k, 32);
      if (probe.length < 32) break;
      const at = na.indexOf(probe, x);
      if (at >= 0 && at - x < 4000) { segs.push({ removed: na.slice(x, at), added: nb.slice(y, y + k) }); x = at; y = y + k; found = true; }
    }
    if (!found) { segs.push({ removed: na.slice(x), added: nb.slice(y) }); break; }
  }
  for (const s of segs) console.log(`  -${Buffer.byteLength(s.removed)} +${Buffer.byteLength(s.added)}  removed=${JSON.stringify(s.removed.slice(0, 160))}  added=${JSON.stringify(s.added.slice(0, 220))}`);
}
