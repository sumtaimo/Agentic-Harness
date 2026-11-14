#!/usr/bin/env node
/**
 * .harness/usage.mjs — where did your tokens / quota go? Read-only: it only reads the controller's own log.
 *
 *   node .harness/usage.mjs            last 7 days, per day → engine → model
 *   node .harness/usage.mjs --days 30
 *   node .harness/usage.mjs --json     the same numbers as JSON
 *
 * One AGENT_USAGE line is logged per AI call: engine, model, tier, ok, tokens (when the engine reports them, e.g.
 * Claude Code; Antigravity does not), cost in USD (Claude Code only) and duration. Daily caps: "dailyLimits" in config.json.
 */
import fs from 'node:fs';
import { FILES, loadConfig, helpIfAsked } from './lib/common.mjs';
helpIfAsked(import.meta.url);

const args = process.argv.slice(2);
const days = Math.max(1, Number(args[args.indexOf('--days') + 1]) || 7);
const asJson = args.includes('--json');
const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);

const rows = [];
try {
  for (const line of fs.readFileSync(FILES.log, 'utf8').split('\n')) {
    if (!line.includes('"AGENT_USAGE"')) continue;
    try { const e = JSON.parse(line); if (e.ts.slice(0, 10) >= since) rows.push(e); } catch { /* skip a broken line */ }
  }
} catch { /* no log yet */ }

const sum = {};
for (const e of rows) {
  const day = e.ts.slice(0, 10); const key = `${e.engine}|${e.model || 'CLI default'}`;
  const d = (sum[day] ||= {}); const r = (d[key] ||= { engine: e.engine, model: e.model || 'CLI default', calls: 0, failed: 0, tokens: 0, tokensKnown: 0, usd: 0, minutes: 0 });
  r.calls++; if (!e.ok) r.failed++;
  if (typeof e.tokens === 'number') { r.tokens += e.tokens; r.tokensKnown++; }
  r.usd += Number(e.usd) || 0; r.minutes += (Number(e.ms) || 0) / 60000;
}

if (asJson) { console.log(JSON.stringify({ since, days, usage: sum }, null, 2)); process.exit(0); }

const config = (() => { try { return loadConfig(); } catch { return {}; } })();
const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
console.log(`AI usage since ${since} (${days} day${days > 1 ? 's' : ''}), from .harness/telemetry.log\n`);
if (!rows.length) { console.log('No AI calls logged in this period.'); process.exit(0); }
const totals = {};
for (const day of Object.keys(sum).sort()) {
  console.log(day);
  for (const r of Object.values(sum[day]).sort((a, b) => b.calls - a.calls)) {
    const tok = r.tokensKnown ? `${fmt(r.tokens)} tokens` : 'tokens not reported';
    console.log(`  ${r.engine.padEnd(12)} ${r.model.padEnd(28)} ${String(r.calls).padStart(3)} call(s)${r.failed ? ` (${r.failed} failed)` : ''}  ${tok}${r.usd ? `  $${r.usd.toFixed(3)}` : ''}  ${r.minutes.toFixed(1)} min`);
    const t = (totals[r.engine] ||= { calls: 0, tokens: 0, usd: 0 }); t.calls += r.calls; t.tokens += r.tokens; t.usd += r.usd;
  }
}
console.log('\nTotal per engine:');
for (const [eng, t] of Object.entries(totals)) {
  const cap = (config.dailyLimits || {})[eng];
  const capTxt = cap && typeof cap === 'object' ? `  daily cap: ${Object.entries(cap).map(([k, v]) => `${v} ${k}`).join(', ')}` : '  no daily cap (config.json "dailyLimits")';
  console.log(`  ${eng.padEnd(12)} ${t.calls} call(s)${t.tokens ? `, ${fmt(t.tokens)} tokens` : ''}${t.usd ? `, $${t.usd.toFixed(2)}` : ''}${capTxt}`);
}
