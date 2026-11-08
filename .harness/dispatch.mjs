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
 * --wait   block until the job finishes and print the result (exit 0 = committed).
 *          If no background daemon is running, this command processes the job itself.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, DIRS, ensureDirs, loadConfig, readJsonSafe, detectVerifyCmd } from './lib/common.mjs';

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
let verifyCmd;
let files = [];
let wait = false;
let autoPlan = !!config.planner?.defaultAutoPlan;
const subtasks = [];

for (let i = 0; i < args.length; i++) {
  const a = args[i]; const v = args[i + 1];
  if (a === '--engine' && v !== undefined) { engine = args[++i].trim().toLowerCase(); }
  else if ((a === '--verify' || a === '--check') && v !== undefined) { verifyCmd = args[++i].trim(); }
  else if (a === '--goal' && v !== undefined) { goal = args[++i].trim(); }
  else if (a === '--title' && v !== undefined) { title = args[++i].trim(); }
  else if (a === '--files' && v !== undefined) { files = args[++i].split(',').map((f) => f.trim()).filter(Boolean); }
  else if (a === '--wait') { wait = true; }
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
const job = {
  id: `job-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`,
  ...(engine ? { engine } : {}),
  title,
  ...(verifyCmd ? { verifyCmd } : {}),
  createdAt: new Date().toISOString(),
  ...(usePlanner
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
console.log(`Dispatched [${(engine || config.activeProfile).toUpperCase()}] job ${job.id} (${usePlanner ? 'AI planner will choose the workers' : `${job.subtasks.length} worker[s]`}) -> ${path.relative(ROOT, inboxPath)}`);
console.log(`Check: ${checkLine}`);

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
    if (done) { console.log(`RESULT: COMMITTED ✔  (session note: ${note})`); process.exit(0); }
    const body = readJsonSafe(path.join(DIRS.failed, failed));
    console.log(`RESULT: NOT DONE ✖  ${body.haltReason || ''}\nSession note: ${note}`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 1000));
}
