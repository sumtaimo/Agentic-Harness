#!/usr/bin/env node
/**
 * .harness/dispatch.mjs — put a job into .harness/inbox/ for the daemon.
 *
 * Simple (one AI worker):
 *   node .harness/dispatch.mjs --goal "Add a dark-mode toggle to the settings page" \
 *        [--files "src/settings.tsx,src/theme.css"] [--check "npm test"] [--engine claude] [--wait]
 *
 * AI planner (the AI splits the goal into parallel workers with separate files):
 *   node .harness/dispatch.mjs --goal "Add a /health API endpoint with tests" --auto-plan --wait
 *   (--files then limits which files the planner may hand out; --auto-plan no turns it off)
 *
 * No --check?  The planner picks the strongest check from package.json scripts
 *   (check > typecheck + test > build > lint). With none, nothing really checks the work.
 *
 * Swarm (original spec form — several workers in parallel, each owning its files):
 *   node .harness/dispatch.mjs "Build API & Tests" --engine claude --verify "npm test" \
 *     --worker "w1:src/api.ts:Implement endpoint" \
 *     --worker "w2:src/api.test.ts:Write tests"
 *
 * Team hierarchy (orchestrator → leads → workers, as defined in .harness/team.json):
 *   node .harness/dispatch.mjs --goal "Build a login feature with spec, code and tests" --hierarchy [--max-cost 1.5] [--wait]
 *   (--max-cost: the controller stops the task if the agents spend more than this many dollars)
 *
 * --mode normal    one direct worker, no planner (fastest, fewest tokens)  — npm run run -- --goal "…"
 * --mode parallel  AI planner splits into parallel workers (same as --auto-plan)
 * --mode team      orchestrator → leads → workers (same as --hierarchy)
 * Autopilot (backlog loop) is not a dispatch mode: npm run auto
 *
 * --branch uat   build on its own git branches, verify, then merge into 'uat' only if the check passes
 *                (your working folder and main are not touched)
 * --model fast|medium|high   force a model tier for every agent of this job (default: the controller picks
 *                (or a model alias from config.json)  the cheapest tier that fits each agent's job; see docs/MULTI-MODEL-SETUP.md)
 * AI tools: a tool that is installed and logged in is used only after you allowed it once (asked here in a
 *          terminal, or: node .harness/engines.mjs). Without any allowed tool it stops with ENGINE_APPROVAL_NEEDED (exit 3).
 * --yes    skip the big-run question (never the one-time tool question). The question appears only for runs that may use a lot of quota
 *          (team or parallel mode, 3+ workers, --model high): answer y / n / a ("a" saves it in .harness/approvals.json
 *          so that kind of run is not asked again). Without a terminal it stops with APPROVAL_NEEDED (exit 3).
 * --wait   block until the job finishes and print the result (exit 0 = committed).
 *          If no background daemon is running, this command processes the job itself.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline/promises';
import { ROOT, DIRS, ensureDirs, loadConfig, readJsonSafe, detectVerifyCmd, costlyRunReasons, engineUsable, aiUsageSince, usageLine, usageTodayLine } from './lib/common.mjs';
import { askEngineConsent } from './lib/consent.mjs';

if (process.env.HARNESS_WORKER === '1') {
  console.error('Refusing to dispatch from inside a harness worker (prevents agents spawning agents in a loop).');
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*?/, '').replace(/^ \* ?/gm, ''));
  process.exit(args.length === 0 ? 1 : 0);
}

const config = loadConfig();
let title = args[0] && !args[0].startsWith('--') ? args[0] : '';
let goal = '';
let engine;
let model;
let verifyCmd;
let files = [];
let wait = false;
let autoPlan = !!config.planner?.defaultAutoPlan;
let branch;
let hierarchy = false;
let maxCost;
let yes = process.env.HARNESS_YES === '1';
const subtasks = [];

for (let i = 0; i < args.length; i++) {
  const a = args[i]; const v = args[i + 1];
  if (a === '--engine' && v !== undefined) { engine = args[++i].trim().toLowerCase(); }
  else if (a === '--model' && v !== undefined) { model = args[++i].trim(); if (!/^[\w.:@/-]+$/.test(model)) { console.error('--model takes a tier (fast | medium | high) or a model alias'); process.exit(1); } }
  else if ((a === '--verify' || a === '--check') && v !== undefined) { verifyCmd = args[++i].trim(); }
  else if (a === '--goal' && v !== undefined) { goal = args[++i].trim(); }
  else if (a === '--title' && v !== undefined) { title = args[++i].trim(); }
  else if (a === '--files' && v !== undefined) { files = args[++i].split(',').map((f) => f.trim()).filter(Boolean); }
  else if (a === '--wait') { wait = true; }
  else if (a === '--yes' || a === '-y') { yes = true; }
  else if (a === '--branch' && v !== undefined) { branch = args[++i].trim() || undefined; }
  else if (a === '--hierarchy') { hierarchy = true; }
  else if (a === '--mode' && v !== undefined) {
    const m = args[++i].trim().toLowerCase();
    if (m === 'normal' || m === 'direct' || m === 'run') { autoPlan = false; hierarchy = false; }
    else if (m === 'parallel') { autoPlan = true; hierarchy = false; }
    else if (m === 'team' || m === 'hierarchy') { hierarchy = true; }
    else if (m === 'auto' || m === 'autopilot') {
      console.error('Autopilot works from the backlog, not from one goal. Add the task with:\n  node .harness/backlog.mjs add "<title>" --status READY\nthen start autopilot with:  npm run auto');
      process.exit(1);
    } else { console.error(`Unknown --mode '${m}'. Use: normal | parallel | team (autopilot: npm run auto)`); process.exit(1); }
  }
  else if (a === '--max-cost' && v !== undefined) {
    maxCost = Number(args[++i]);
    if (!Number.isFinite(maxCost) || maxCost < 0) { console.error('--max-cost must be a number of dollars, e.g. --max-cost 1.5'); process.exit(1); }
  }
  else if (a === '--auto-plan') {
    autoPlan = true;
    if (/^(yes|no|true|false|on|off)$/i.test(v || '')) autoPlan = /^(yes|true|on)$/i.test(args[++i]);
  }
  else if (a === '--worker' && v !== undefined) {
    const [id, filesCsv, ...promptParts] = args[++i].split(':');
    subtasks.push({
      id: id || `worker-${subtasks.length + 1}`,
      targetFiles: (filesCsv || '').split(',').map((f) => f.trim()).filter(Boolean),
      prompt: promptParts.join(':').trim() || title
    });
  }
}
if (!engine || engine === 'auto') engine = undefined;
if (engine && !config.profiles[engine]) {
  console.error(`Unknown engine '${engine}'. Choose one of: auto, ${Object.keys(config.profiles).join(', ')}`);
  process.exit(1);
}
if (!title) title = goal ? goal.slice(0, 80) : 'Dispatched Swarm Task';
if (!goal && subtasks.length === 0) goal = title;

// No --check: the planner (Node 1) picks one from package.json when the job runs. Preview it here.
let checkLine;
if (verifyCmd) checkLine = verifyCmd;
else {
  const d = detectVerifyCmd(ROOT, config);
  checkLine = `${d.cmd}  (${d.source})${d.real ? '' : ' — WARNING: any result will "pass". Add --check "<command>" for a real gate.'}`;
}

for (const s of subtasks) if (engine) s.engine = engine;
const usePlanner = autoPlan && subtasks.length === 0;

// ── AI tools: a tool that is installed and logged in is never used silently; the person allows it once ──
{
  const team = hierarchy ? (readJsonSafe(path.join(ROOT, '.harness', 'team.json'), {}).members || []).map((m) => m.engine).filter((e) => e && e !== 'auto') : [];
  const named = [engine, ...subtasks.map((s) => s.engine), ...team].filter(Boolean);
  const candidates = named.length ? named : (config.activeProfile && config.activeProfile !== 'auto' ? [config.activeProfile] : (config.autoOrder || Object.keys(config.profiles)));
  const fallback = config.autoOrder || Object.keys(config.profiles); // a named tool that is not allowed falls back to auto
  await askEngineConsent(config, [...candidates, ...fallback]);
  const usable = [...new Set([...candidates, ...fallback])].filter((k) => config.profiles[k] && engineUsable(config, k).ok);
  if (!usable.length) {
    const why = [...new Set([...candidates, ...fallback])].filter((k) => config.profiles[k]).map((k) => `  - ${k}: ${engineUsable(config, k).why}`).join('\n');
    console.error(`ENGINE_APPROVAL_NEEDED: no AI tool is allowed and ready on this machine, so nothing was started.\n${why}\nAllow one in a terminal with:  node .harness/engines.mjs`);
    process.exit(3);
  }
}

// ── Approval gate: ask the person only when this run may use a lot of tokens / quota ──
{
  const costly = costlyRunReasons(config, { hierarchy: hierarchy && subtasks.length === 0, autoPlan: usePlanner, workers: subtasks.length, model });
  const approvalsFile = path.join(ROOT, '.harness', 'approvals.json');
  const saved = readJsonSafe(approvalsFile) || {};
  const always = new Set(Array.isArray(saved.alwaysAllow) ? saved.alwaysAllow : []);
  const pending = costly.filter((c) => !always.has(c.kind));
  if (pending.length && !yes) {
    const names = engine ? [engine] : (config.activeProfile && config.activeProfile !== 'auto' ? [config.activeProfile] : (config.autoOrder || Object.keys(config.profiles)));
    const models = names.filter((n) => config.profiles[n]).map((n) => `${n}: ${config.profiles[n].models?.high || "the CLI's default"}`).join(' | ');
    console.log('This run may use a lot of tokens or quota:');
    for (const c of pending) console.log(`  - ${c.text}`);
    console.log(`  High-tier model per engine: ${models}`);
    if (maxCost === undefined) console.log('  No --max-cost set: only config budget limits apply.');
    if (!process.stdin.isTTY) {
      console.error('APPROVAL_NEEDED: no terminal to ask in, so nothing was started. Ask the person; if they agree, run the same command again with --yes.');
      process.exit(3);
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ans = (await rl.question("Start it? [y] yes  [n] no  [a] yes, and don't ask again for this kind of run: ")).trim().toLowerCase();
    rl.close();
    if (ans === 'a' || ans === 'always') {
      for (const c of pending) always.add(c.kind);
      fs.writeFileSync(approvalsFile, JSON.stringify({ ...saved, alwaysAllow: [...always] }, null, 2) + '\n');
      console.log(`Saved in .harness/approvals.json (delete a line there to be asked again).`);
    } else if (ans !== 'y' && ans !== 'yes') {
      console.log('Not started.');
      process.exit(4);
    }
  }
}
const job = {
  id: `job-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`,
  ...(engine ? { engine } : {}),
  ...(model ? { model } : {}),
  title,
  ...(verifyCmd ? { verifyCmd } : {}),
  ...(branch ? { integrationBranch: branch } : {}),
  createdAt: new Date().toISOString(),
  ...(maxCost !== undefined ? { maxCostUsd: maxCost } : {}),
  ...(hierarchy && subtasks.length === 0
    ? { hierarchy: true, goal, targetFiles: files }
    : usePlanner
    ? { autoPlan: true, goal, targetFiles: files }
    : {
        subtasks: subtasks.length > 0
          ? subtasks
          : [{ id: 'worker-main', ...(engine ? { engine } : {}), targetFiles: files, prompt: goal }]
      })
};

ensureDirs();
const inboxPath = path.join(DIRS.inbox, `${job.id}.json`);
fs.writeFileSync(`${inboxPath}.tmp`, JSON.stringify(job, null, 2)); // atomic hand-off:
fs.renameSync(`${inboxPath}.tmp`, inboxPath);                       // the daemon never sees half a file
console.log(`Dispatched [${(engine || config.activeProfile).toUpperCase()}] job ${job.id} (${job.hierarchy ? 'orchestrator → leads → workers, per team.json' : usePlanner ? 'AI planner will choose the workers' : `${job.subtasks.length} worker[s]`}) -> ${path.relative(ROOT, inboxPath)}`);
console.log(`Check: ${checkLine}`);
// One short line so the person always sees that this spends their AI quota (no AI call: read from the log).
{ const today = usageTodayLine(config); console.log(`AI: ${engine || 'auto'}, model picked per job (fast / medium / high)${today ? ` · used today: ${today}` : ''}`); }
const startedIso = new Date().toISOString();
console.log(`JOB_ID=${job.id}`);
console.log(`LIVE_FROM=${(() => { try { return fs.statSync(path.join(ROOT, '.harness', 'live.log')).size; } catch { return 0; } })()}`);
if (branch) console.log(`Git: result is merged into '${branch}' only if the check passes; your folder and protected branches are not touched.`);

if (!wait) process.exit(0);

// ── --wait: follow the job to the end ──
const daemonPid = (() => {
  try { const pid = Number(fs.readFileSync(path.join(ROOT, '.harness', 'daemon.pid'), 'utf8')); process.kill(pid, 0); return pid; } catch { return 0; }
})();
if (!daemonPid) {
  console.log('No background daemon running — processing the job in this terminal…');
  const child = spawn(process.execPath, [path.join(ROOT, '.harness', 'daemon.mjs'), '--once'], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, HARNESS_SILENT: process.env.HARNESS_SILENT ?? '1' } });
  await new Promise((r) => child.on('close', r));
} else {
  console.log(`Background daemon (PID ${daemonPid}) is working on it — watch the Harness panel. Waiting…`);
}

const find = (dir) => fs.readdirSync(dir).find((f) => f.startsWith(job.id));
for (;;) {
  const done = find(DIRS.completed); const failed = find(DIRS.failed);
  if (done || failed) {
    const sessions = fs.readdirSync(DIRS.sessions).filter((f) => f.includes(job.id));
    const note = sessions.length ? path.join('.harness', 'memory', 'sessions', sessions[sessions.length - 1]) : '(none)';
    const spent = usageLine(aiUsageSince(startedIso));
    const today = usageTodayLine(config);
    const aiLine = `AI used by this job: ${spent || 'none'}${today ? ` · today: ${today}` : ''}`;
    if (done) { console.log(`RESULT: COMMITTED ✔  (session note: ${note})\n${aiLine}`); process.exit(0); }
    const body = readJsonSafe(path.join(DIRS.failed, failed));
    console.log(`RESULT: NOT DONE ✖  ${body.haltReason || ''}\nSession note: ${note}\n${aiLine}`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 1000));
}
