#!/usr/bin/env node
/**
 * .harness/feature.mjs — a big feature from a short goal: BA grows it into the whole user workflow, you keep the steps
 * you want (one stop), then autopilot builds them on the 'uat' branch.
 *
 *   node .harness/feature.mjs "login"                    new feature + BA expands it now (needs an allowed AI tool)
 *   node .harness/feature.mjs new "login" [--max 12] [--no-expand]
 *   node .harness/feature.mjs expand F1 [--from steps.json]   (re)expand; --from = JSON written by your editor's BA agent
 *   node .harness/feature.mjs prompt F1                  print the BA prompt (for an editor agent; it replies with JSON)
 *   node .harness/feature.mjs show F1                    the steps, the open decisions (🟡) and the spec page
 *   node .harness/feature.mjs approve F1 --keep 1,2,5    keep those steps (or --keep 1-4, or --all) → READY backlog items
 *   node .harness/feature.mjs cancel F1                  drop a feature that is not approved yet
 *   node .harness/feature.mjs status                     every feature and how far it got (default)
 *   npm run feature -- "login"                           same as the first line
 *
 * At most 12 steps per feature by default (--max, never more than 20). Steps run in journey order: a step waits until
 * the steps it depends on are DONE. Nothing is built before you approve; the build is the normal autopilot (`npm run
 * auto`), which works on 'uat' only and holds big runs for your OK.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, HARNESS_DIR, ensureDirs, helpIfAsked } from './lib/common.mjs';
helpIfAsked(import.meta.url);
import { readBacklog, writeBacklog } from './lib/governance.mjs';
import { createFeature, findFeature, engineGate, markFeatureError, approveFeature, featureProgress, renderFeatureDoc, readFeatures, FEATURE_MAX_STEPS } from './lib/feature.mjs';
import { checkHumanApprovalOrigin } from './lib/guard.mjs';

ensureDirs();
const argv = process.argv.slice(2);
const READ_ONLY = ['status', 'show', 'prompt', 'list'];
const known = ['new', 'expand', 'prompt', 'show', 'approve', 'cancel', 'status', 'list'];
let cmd = argv[0] || 'status';
let rest = argv.slice(1);
if (!known.includes(cmd)) { cmd = cmd.startsWith('--') ? 'status' : 'new'; rest = argv; } // `feature "login"` = new + expand
if (process.env.HARNESS_WORKER === '1' && !READ_ONLY.includes(cmd)) { console.error('Harness workers may only read features (status / show / prompt).'); process.exit(2); }

const flag = (name) => rest.includes(name);
const val = (name) => { const i = rest.indexOf(name); return i > -1 && rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : undefined; };
const positional = () => { const out = []; for (let i = 0; i < rest.length; i++) { if (rest[i].startsWith('--')) { if (['--max', '--keep', '--from'].includes(rest[i])) i++; continue; } out.push(rest[i]); } return out; };
const die = (msg, code = 1) => { console.error(msg); process.exit(code); };
const need = () => { const id = positional()[0]; if (!id) die(`Usage: node .harness/feature.mjs ${cmd} F1`); const f = findFeature(id); if (!f) die(`No feature ${id}. See: node .harness/feature.mjs status`); return f; };

async function expandChecked(f, from) {
  if (!from) { // an AI call: refuse early and say what to do; keep the draft and the reason so "Needs you" shows it
    const gate = await engineGate();
    if (!gate.ok) { markFeatureError(f.id, 'No AI tool is allowed yet. Allow one: node .harness/engines.mjs, then: node .harness/feature.mjs expand ' + f.id); console.error(gate.message); return 3; }
  }
  return expand(f, from);
}

function expand(f, from) {
  const args = [path.join(HARNESS_DIR, 'daemon.mjs'), '--feature-expand', f.id];
  if (from) args.push('--from', path.resolve(from));
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
  return r.status ?? 1;
}

switch (cmd) {
  case 'new': {
    const goal = positional().join(' ').trim();
    if (!goal) die('Usage: node .harness/feature.mjs "login"   (a short goal; BA grows it into the whole user workflow)');
    let f; try { f = createFeature(goal, { max: val('--max') ?? FEATURE_MAX_STEPS }); } catch (e) { die(e.message); }
    console.log(f.reused ? `${f.id} already exists for this goal and was not expanded yet: trying again.` : `${f.id} created: "${f.goal}" (≤ ${f.maxSteps} steps). Spec page will be ${f.doc}.`);
    if (flag('--no-expand')) { console.log(`Expand it later: node .harness/feature.mjs expand ${f.id}   (editor: node .harness/feature.mjs prompt ${f.id})`); break; }
    process.exit(await expandChecked(f));
  }
  case 'expand': { const f = need(); process.exit(await expandChecked(f, val('--from'))); }
  case 'prompt': {
    const f = need();
    // the exact prompt the headless run sends (project files, roles, repo map, skills), without calling an AI
    const r = spawnSync(process.execPath, [path.join(HARNESS_DIR, 'daemon.mjs'), '--feature-expand', f.id, '--print-prompt'], { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) die((r.stderr || r.stdout || 'could not build the prompt').trim());
    if (r.stderr) process.stderr.write(r.stderr);
    process.stdout.write(r.stdout);
    console.log(`\n[EDITOR NOTE] Give this to a read-only agent (BA); it writes no file. Save its JSON reply to a file, then: node .harness/feature.mjs expand ${f.id} --from <file>`);
    break;
  }
  case 'show': {
    const f = need();
    if (!f.steps.length) { console.log(`${f.id} "${f.goal}" is ${f.status}; no steps yet.${f.lastError ? `\nLast error: ${f.lastError}` : ''}`); break; }
    console.log(renderFeatureDoc(f));
    if (f.status === 'DRAFT') console.log(`Keep the steps you want: node .harness/feature.mjs approve ${f.id} --keep 1,2,3   (or --all)`);
    break;
  }
  case 'approve': {
    const f = need();
    const spec = flag('--all') ? 'all' : val('--keep');
    if (!spec) die(`Say which steps to keep: node .harness/feature.mjs approve ${f.id} --keep 1,2,5   (or --keep 1-4, or --all)`);
    const origin = checkHumanApprovalOrigin({ root: ROOT, actionRule: 'Bash(node .harness/feature.mjs approve:*)', commandHint: `node .harness/feature.mjs approve ${f.id} ${spec === 'all' ? '--all' : `--keep ${spec}`}` });
    if (!origin.ok) die(origin.reason);
    let r; try { r = approveFeature(f.id, spec); } catch (e) { die(e.message); }
    console.log(`${r.feature.id} APPROVED: ${r.added.length} step(s) are READY in the backlog (${r.added.map((t) => t.id).join(', ')}).`);
    for (const w of r.warnings) console.log(`! ${w}`);
    console.log('Build them: npm run auto  (autopilot, on the uat branch)  ·  in Claude Code: /harness:auto  ·  progress: node .harness/feature.mjs status');
    break;
  }
  case 'cancel': {
    const f = need();
    const origin = checkHumanApprovalOrigin({ root: ROOT, actionRule: 'Bash(node .harness/feature.mjs cancel:*)', commandHint: `node .harness/feature.mjs cancel ${f.id}` });
    if (!origin.ok) die(origin.reason);
    if (f.status === 'APPROVED') die(`${f.id} is approved: its steps are backlog items now. Block them instead: node .harness/backlog.mjs block <id> "reason"`);
    const b = readBacklog();
    b.features = readFeatures(b).map((x) => (x.id === f.id ? { ...x, status: 'CANCELLED', cancelledAt: new Date().toISOString() } : x));
    writeBacklog(b);
    console.log(`${f.id} cancelled (kept in the list; nothing was built).`);
    break;
  }
  default: {
    const rows = featureProgress();
    if (!rows.length) { console.log('No features yet. Start one: node .harness/feature.mjs "login"'); break; }
    for (const p of rows) {
      const tail = p.status === 'APPROVED' || p.status === 'DONE'
        ? `${p.done}/${p.kept} done${p.running ? `, ${p.running} running` : ''}${p.ready ? `, ${p.ready} waiting` : ''}${p.blocked ? `, ${p.blocked} BLOCKED (needs you)` : ''}`
        : p.status === 'DRAFT' ? `${p.steps} step(s) to review${p.decisions ? `, ${p.decisions} 🟡 decision(s)` : ''} → approve ${p.id} --keep …` : p.lastError ? `last error: ${p.lastError.slice(0, 120)}` : '';
      console.log(`${p.id.padEnd(4)} ${p.status.padEnd(9)} ${p.goal.slice(0, 50).padEnd(50)} ${tail}`);
    }
  }
}
