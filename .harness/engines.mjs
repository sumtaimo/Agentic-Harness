#!/usr/bin/env node
/**
 * .harness/engines.mjs — which AI tools may the harness use on THIS machine (your own logins and quota)?
 *
 *   node .harness/engines.mjs              list the tools; in a terminal, ask once about each one found but not answered yet
 *   node .harness/engines.mjs allow agy    let the harness use a tool   (names: claude, antigravity or agy, codex)
 *   node .harness/engines.mjs deny  agy    stop the harness using it
 *
 * Answers are saved per person in .harness/approvals.json (git-ignored), so every teammate decides for themselves.
 */
import { loadConfig, probeEngine, engineConsent, setEngineConsent, ROUTABLE_ENGINES, helpIfAsked } from './lib/common.mjs';
helpIfAsked(import.meta.url);
import { askEngineConsent, ENGINE_LABELS } from './lib/consent.mjs';

const config = loadConfig();
const [cmd, rawName] = process.argv.slice(2);
const alias = (n) => { const k = String(n || '').toLowerCase(); return k === 'agy' ? 'antigravity' : k; };
const names = ROUTABLE_ENGINES.filter((k) => config.profiles[k]);

if (cmd === 'allow' || cmd === 'deny') {
  const k = alias(rawName);
  if (!config.profiles[k]) { console.error(`Unknown tool '${rawName}'. Use one of: ${names.join(', ')} (agy = antigravity).`); process.exit(1); }
  setEngineConsent(k, cmd === 'allow');
  console.log(`${k}: ${cmd === 'allow' ? 'allowed' : 'not allowed'} (saved in .harness/approvals.json)`);
  process.exit(0);
}
if (cmd && cmd !== 'list') { console.error('Usage: node .harness/engines.mjs [list | allow <tool> | deny <tool>]'); process.exit(1); }

if (!cmd) await askEngineConsent(config, names);
console.log('AI tools on this machine:');
for (const k of names) {
  const probe = probeEngine(config.profiles[k]);
  const c = engineConsent(k);
  const state = !probe.installed ? 'not installed' : !probe.compatible ? 'installed, but its flags do not match (run doctor)' : c === true ? 'ALLOWED' : c === false ? 'not allowed' : 'installed, not answered yet';
  console.log(`  ${k.padEnd(12)} ${(ENGINE_LABELS[k] || '').padEnd(18)} ${state}`);
}
