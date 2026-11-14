#!/usr/bin/env node
/**
 * .harness/team.mjs — the agent team.
 *
 *   node .harness/team.mjs show        the hierarchy with every member's set-up (role, engine, scope, tools, budget)
 *   node .harness/team.mjs validate    check the guardrails; exit 0 = valid, 1 = errors (it also lists warnings)
 *   node .harness/team.mjs sync-agents [--check]
 *        write the leads as NAMED agents for the editor (.claude/agents/<lead>.md), generated from team.json + roles,
 *        so you see "lead-dev" etc. working in your Claude Code session. --check only reports whether they are in sync.
 *   node .harness/team.mjs auto-assign [--dry-run]
 *        detect which AI CLIs are usable here (claude, agy, codex) and route each role to one of them in
 *        team.json ("engine" per member). Only the "engine" fields change. --dry-run prints the routing without writing.
 *        HARNESS_ENGINES="claude,codex" skips detection and routes to exactly those engines.
 *
 * show / validate / sync-agents --check are read-only. The team lives in .harness/team.json (plain JSON).
 * After editing team.json or a role, run sync-agents again.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ensureDirs, loadConfig, detectEngines, HARNESS_DIR } from './lib/common.mjs';
import { readCharter, loadRoles, loadTeam, validateTeam, describeMember, syncAgents, planEngineRouting, applyEngineRouting } from './lib/governance.mjs';

ensureDirs();
const cmd = process.argv[2] || 'show';
const team = loadTeam();
if (!team) { console.error('No .harness/team.json found. Copy it from the template to use the team hierarchy.'); process.exit(1); }
const config = loadConfig();
const roles = loadRoles();
const charter = readCharter();
const maxWorkers = (config.planner || {}).maxWorkers || 4;
const engines = Object.keys(config.profiles || {});
const { errors, warnings } = validateTeam(team, { roles, charter, plannerMaxWorkers: maxWorkers, engines });
const LABEL = { antigravity: 'antigravity (agy)' };
const label = (e) => (e ? LABEL[e] || e : 'auto');

if (cmd === 'validate') {
  errors.forEach((e) => console.log(`  ✖ ${e}`));
  warnings.forEach((w) => console.log(`  ! ${w}`));
  console.log(errors.length ? `\nTeam is INVALID: ${errors.length} error(s). Nothing will start until they are fixed.` : `Team is valid.${warnings.length ? ` (${warnings.length} warning(s))` : ''}`);
  process.exit(errors.length ? 1 : 0);
} else if (cmd === 'auto-assign') {
  const dry = process.argv.includes('--dry-run');
  const { usable, skipped } = detectEngines(config);
  console.log(`Usable AI engines on this machine: ${usable.length ? usable.map(label).join(', ') : 'none'}`);
  skipped.forEach((s) => console.log(`  · ${label(s.name)}: ${s.why}`));
  const routing = planEngineRouting(usable);
  if (!routing) {
    console.log('\nNo engine to route to, so team.json was not changed (members keep "auto"). Install and log in to one CLI (see docs/MULTI-MODEL-SETUP.md in the harness repo), then run this again.');
    process.exit(0);
  }
  const mode = usable.length >= 3 ? '3+ engines: planning / coding / QA each get their own' : usable.length === 2 ? '2 engines: planning on one, coding + QA on the other' : '1 engine: it does every role';
  console.log(`\nRouting (${mode}):\n  planning / research (PO_ARCHITECT, BA_ANALYST) → ${label(routing.plan)}\n  coding (DEV_ENGINEER)                          → ${label(routing.code)}\n  QA / review (QA_AUDITOR)                       → ${label(routing.qa)}`);
  const next = applyEngineRouting(team, routing);
  console.log('');
  next.members.forEach((m) => console.log(`  ${m.id.padEnd(14)} [${m.role}]  → ${label(m.engine)}${(team.members.find((o) => o.id === m.id) || {}).engine === m.engine ? '' : '   (changed)'}`));
  const changed = JSON.stringify(next) !== JSON.stringify(team);
  if (dry) { console.log('\n--dry-run: team.json was not changed.'); process.exit(0); }
  if (!changed) { console.log('\nteam.json already has this routing; nothing changed.'); process.exit(0); }
  const file = path.join(HARNESS_DIR, 'team.json');
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  console.log('\nWrote the "engine" of each member to .harness/team.json. The routing applies to the headless team mode (dispatch --hierarchy);\nan explicit --engine on a task still overrides it. Undo: git checkout -- .harness/team.json');
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
    console.log(`L1  ${d.id}  [${d.role}]  engine: ${label(d.engine)}  budget: ${money(d.budget)}`);
    console.log(`      plans and delegates; read-only. Tools: ${tools(d.tools)}`);
  }
  leads.forEach((l, i) => {
    const d = describeMember(l, roles);
    const last = i === leads.length - 1;
    console.log(`${last ? '└─' : '├─'} L2  ${d.id}  [${d.role}]  engine: ${label(d.engine)}  budget: ${money(d.budget)}`);
    const pad = last ? '   ' : '│  ';
    console.log(`${pad}   owns: ${d.scope.join(', ')}  |  up to ${d.maxWorkers} worker(s)`);
    console.log(`${pad}   └─ L3 workers (created by ${d.id}, role ${d.role}, engine ${label(d.engine)}) tools: ${tools(d.tools)}`);
  });
  console.log(`\nRun a task through it:  node .harness/dispatch.mjs --goal "…" --hierarchy [--max-cost <usd>] --wait`);
  console.log('Route roles to your installed engines:  node .harness/team.mjs auto-assign [--dry-run]');
  console.log(errors.length ? `\n✖ ${errors.length} error(s) — run "node .harness/team.mjs validate"` : '\n✔ team is valid');
  if (warnings.length) warnings.forEach((w) => console.log(`! ${w}`));
} else {
  console.error('Usage: team.mjs show | validate | sync-agents [--check] | auto-assign [--dry-run]');
  process.exit(1);
}
