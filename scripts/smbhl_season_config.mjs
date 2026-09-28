#!/usr/bin/env node
// Adds SMBHL's season config (src/season_config.js SMBHL_SEASON_CONFIG --
// exactly what the code does today for a season with none) to one season
// of SMBHL's data.json, offline: it reads a downloaded copy and writes a
// new file; it never talks to Cloudflare. Applying the result is a
// separate, deliberate `wrangler kv key put`.
//
// Deploy the Worker that knows the config's shortfallMinSkaters FIRST.
// On an older Worker a season with a config reads "minSkaters configured"
// and SMBHL's shortfall sub call drops from 7 skaters to 5.
//
// Usage (PowerShell, from the repo):
//   npx wrangler kv key get data_json --namespace-id=e5af34ebf39b4c5d8851d7b071368a0e --remote > data_json.before.json
//   node scripts/smbhl_season_config.mjs data_json.before.json data_json.after.json ["Fall 2026"]
//   npx wrangler kv key put backup:before_season_config --path=data_json.before.json --namespace-id=e5af34ebf39b4c5d8851d7b071368a0e --remote
//   npx wrangler kv key put data_json --path=data_json.after.json --namespace-id=e5af34ebf39b4c5d8851d7b071368a0e --remote
//
// The season defaults to data.json's current_season. A season that already
// carries a config is left as it is (the script says so and writes
// nothing). Only that season's `config` changes: the output is otherwise
// the input, re-serialized the way the Worker writes data_json (2-space
// JSON), and the script prints the other seasons and top-level keys
// it checked are untouched.
import fs from 'node:fs';
import { addSmbhlSeasonConfig } from '../src/season_config.js';

const [inPath, outPath, seasonName] = process.argv.slice(2);
if (!inPath || !outPath) {
  console.error('usage: node scripts/smbhl_season_config.mjs <data_json.before.json> <data_json.after.json> [season name]');
  process.exit(2);
}
// PowerShell 5.1's > writes UTF-16LE; wrangler's own output is UTF-8.
const buf = fs.readFileSync(inPath);
const raw = (buf[0] === 0xFF && buf[1] === 0xFE ? buf.toString('utf16le') : buf.toString('utf8')).replace(/^\uFEFF/, '');
const before = JSON.parse(raw);
const { data: after, changed, reason } = addSmbhlSeasonConfig(before, seasonName || null);
console.log(reason);
if (!changed) process.exit(1);

// Nothing else may differ: compare every season but the target, and every
// top-level key but seasons.
const name = seasonName || before.current_season;
const list = d => (Array.isArray(d.seasons) ? d.seasons : Object.values(d.seasons || {}));
const strip = s => { const { config, ...rest } = s; return rest; };
for (const k of Object.keys(before)) {
  if (k === 'seasons') continue;
  if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) throw new Error(`top-level ${k} changed`);
}
const b = list(before), a = list(after);
if (b.length !== a.length) throw new Error('season count changed');
b.forEach((s, i) => {
  const same = s.name === name ? JSON.stringify(strip(s)) === JSON.stringify(strip(a[i])) : JSON.stringify(s) === JSON.stringify(a[i]);
  if (!same) throw new Error(`season ${s.name} changed beyond its config`);
});
fs.writeFileSync(outPath, JSON.stringify(after, null, 2));
console.log(`wrote ${outPath}: ${b.length} seasons, only ${name}.config added`);
console.log(JSON.stringify(list(after).find(s => s.name === name).config, null, 2));
