#!/usr/bin/env node
/**
 * .harness/team.mjs — the agent team (read-only).
 *
 *   node .harness/team.mjs show        the hierarchy with every member's set-up (role, scope, tools, budget)
 *   node .harness/team.mjs validate    check the guardrails; exit 0 = valid, 1 = errors (it also lists warnings)
 *   node .harness/team.mjs sync-agents [--check]
 *        write the leads as NAMED agents for the editor (.claude/agents/<lead>.md), generated from team.json + roles,
 *        so you see "lead-dev" etc. working in your Claude Code session. --check only reports whether they are in sync.
 *
 * The team lives in .harness/team.json. Edit that file to change who is on the team: it is plain JSON.
 * After editing team.json or a role, run sync-agents again.
 */

import { ensureDirs, loadConfig } from './lib/common.mjs';
import { readCharter, loadRoles, loadTeam, validateTeam, describeMember, syncAgents } from './lib/governance.mjs';

ensureDirs();
const cmd = process.argv[2] || 'show';
const team = loadTeam();
if (!team) { console.error('No .harness/team.json found. Copy it from the template to use the team hierarchy.'); process.exit(1); }
const roles = loadRoles();
const charter = readCharter();
const maxWorkers = (loadConfig().planner || {}).maxWorkers || 4;
const { errors, warnings } = validateTeam(team, { roles, charter, plannerMaxWorkers: maxWorkers });

if (cmd === 'validate') {
  errors.forEach((e) => console.log(`  ✖ ${e}`));
  warnings.forEach((w) => console.log(`  ! ${w}`));
  console.log(errors.length ? `\nTeam is INVALID: ${errors.length} error(s). Nothing will start until they are fixed.` : `Team is valid.${warnings.length ? ` (${warnings.length} warning(s))` : ''}`);
  process.exit(errors.length ? 1 : 0);
} else if (cmd === 'sync-agents') {
  if (errors.length) { console.error(`team.json is invalid, so no agents were written: ${errors.join('; ')}`); process.exit(1); }
  const check = process.argv.includes('--check');
  const r = syncAgents(team, roles, { check });
  if (check) {
    r.stale.forEach((f) => console.log(`  ✖ .claude/agents/${f} is missing or out of date`));
    console.log(r.stale.length ? `\n${r.stale.length} agent file(s) out of sync. Run: node .harness/team.mjs sync-agents` : 'Editor agents are in sync with team.json.');
    process.exit(r.stale.length ? 1 : 0);
  }
  r.written.forEach((f) => console.log(`  wrote .claude/agents/${f}`));
  r.unchanged.forEach((f) => console.log(`  kept  .claude/agents/${f} (already up to date)`));
  console.log('\nThe leads are now named agents in your editor session. If Claude Code is already open, restart the session so it loads them.');
} else if (cmd === 'show') {
  const orch = team.members.find((m) => m.level === 'orchestrator');
  const leads = team.members.filter((m) => m.level === 'lead');
  const money = (b) => [b.maxCostUsd !== undefined ? `max $${b.maxCostUsd}` : '', b.maxMinutes !== undefined ? `${b.maxMinutes} min` : ''].filter(Boolean).join(', ') || 'no cap';
  const tools = (t) => (t.length ? t.map((x) => x.replace('{targetFiles}', '<its files>')).join(', ') : '(none)');
  console.log('Agent team (level 1 → 2 → 3)\n');
  if (orch) {
    const d = describeMember(orch, roles);
    console.log(`L1  ${d.id}  [${d.role}]  budget: ${money(d.budget)}`);
    console.log(`      plans and delegates; read-only. Tools: ${tools(d.tools)}`);
  }
  leads.forEach((l, i) => {
    const d = describeMember(l, roles);
    const last = i === leads.length - 1;
    console.log(`${last ? '└─' : '├─'} L2  ${d.id}  [${d.role}]  budget: ${money(d.budget)}`);
    const pad = last ? '   ' : '│  ';
    console.log(`${pad}   owns: ${d.scope.join(', ')}  |  up to ${d.maxWorkers} worker(s)`);
    console.log(`${pad}   └─ L3 workers (created by ${d.id}, role ${d.role}) tools: ${tools(d.tools)}`);
  });
  console.log(`\nRun a task through it:  node .harness/dispatch.mjs --goal "…" --hierarchy [--max-cost <usd>] --wait`);
  console.log(errors.length ? `\n✖ ${errors.length} error(s) — run "node .harness/team.mjs validate"` : '\n✔ team is valid');
  if (warnings.length) warnings.forEach((w) => console.log(`! ${w}`));
} else {
  console.error('Usage: team.mjs show | validate');
  process.exit(1);
}
