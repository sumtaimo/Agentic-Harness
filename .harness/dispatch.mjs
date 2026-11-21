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
 * No --check?  The planner picks the strongest check from package.json scripts, workspaces,
 *   or project test runners (pytest, go test, cargo test, composer/artisan, Makefile). With none, nothing really checks the work.
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
 * Resume an unfinished editor-workflow run (/harness:run, visible.mjs) in the headless controller:
 *   node .harness/dispatch.mjs --resume-visible [RUN_ID] [--engine antigravity] [--wait]
 *   (omitting RUN_ID picks the open/latest unfinished visible run; keeps partial edits on disk, carries
 *    over assignments/contract/acceptance criteria/last verify error, and updates .harness/visible/<RUN_ID>/ when finished)
 *
 * --role DEV_ENGINEER   give the direct worker (and every --worker) a role: its persona, its tool limits and the
 *                skills for that role whose keywords appear in the task. Without a role a worker gets no skills.
 * --mode normal    one direct worker, no planner (fastest, fewest tokens)  — npm run run -- --goal "…"
 * --mode parallel  AI planner splits into parallel workers (same as --auto-plan)
 * --mode team      orchestrator → leads → workers (same as --hierarchy)
 * Autopilot (backlog loop) is not a dispatch mode: npm run auto
 *
 * --branch uat   build on its own git branches, verify, then merge into 'uat' only if the check passes
 *                (your working folder and main are not touched)
 * --cwd <dir>    run workers, checks, backup/rollback, and auto-commit inside another working folder
 *                (e.g. a child-session worktree) while keeping inbox, logs, config, and session notes here.
 *                Cannot be combined with --branch or --resume-visible.
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
import { ROOT, DIRS, ensureDirs, loadConfig, readJsonSafe, detectVerifyCmd, clipErrorTrace, costlyRunReasons, engineUsable, detectEngines, compatibleModelFor, aiUsageSince, usageLine, usageTodayLine, quotaWarnings, formatQuotaWarning, MODEL_TIERS, isSameDir, validateExternalWorkRoot, harnessPidAlive } from './lib/common.mjs';
import { askEngineConsent } from './lib/consent.mjs';
import { loadTeam, loadRoles } from './lib/governance.mjs';
import { RESUMABLE_STATUSES, VISIBLE_TERMINAL, editorDisplayName, listVisibleRuns, readVisibleRun, writeVisibleRun, inspectVisibleRun } from './lib/handoff.mjs';

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
let cwdArg;
let hierarchy = false;
let maxCost;
let yes = process.env.HARNESS_YES === '1';
let resumeVisible;
let explicitMode = false;
let role;
const KNOWN_OPTIONS = new Set(['--engine', '--model', '--verify', '--check', '--goal', '--title', '--files', '--wait', '--yes', '--branch', '--cwd', '--hierarchy', '--resume-visible', '--mode', '--max-cost', '--auto-plan', '--worker', '--role']);
const subtasks = [];

for (let i = 0; i < args.length; i++) {
  const a = args[i]; const v = args[i + 1];
  const normEng = (s) => { const k = String(s || '').trim().toLowerCase(); return k === 'agy' ? 'antigravity' : k; };
  if (a === '--engine' && v !== undefined) { engine = normEng(args[++i]); }
  else if (a.startsWith('--engine=')) { engine = normEng(a.slice('--engine='.length)); }
  else if (a === '--model' && v !== undefined) { model = args[++i].trim(); if (!/^[\w.:@/-]+$/.test(model)) { console.error('--model takes a tier (fast | medium | high) or a model alias'); process.exit(1); } }
  else if ((a === '--verify' || a === '--check') && v !== undefined) { verifyCmd = args[++i].trim(); }
  else if (a === '--goal' && v !== undefined) { goal = args[++i].trim(); }
  else if (a === '--title' && v !== undefined) { title = args[++i].trim(); }
  else if (a === '--files' && v !== undefined) { files = args[++i].split(',').map((f) => f.trim()).filter(Boolean); }
  else if (a === '--wait') { wait = true; }
  else if (a === '--yes' || a === '-y') { yes = true; }
  else if (a === '--branch' && v !== undefined) { branch = args[++i].trim() || undefined; }
  else if (a === '--cwd') {
    if (v === undefined || !v.trim() || v.startsWith('--')) { console.error('--cwd requires a directory path'); process.exit(1); }
    cwdArg = args[++i].trim();
  }
  else if (a.startsWith('--cwd=')) {
    cwdArg = a.slice('--cwd='.length).trim();
    if (!cwdArg) { console.error('--cwd requires a directory path'); process.exit(1); }
  }
  else if (a === '--hierarchy') { hierarchy = true; explicitMode = true; }
  else if (a === '--resume-visible') { resumeVisible = (v !== undefined && !v.startsWith('-')) ? args[++i].trim() : 'LATEST'; }
  else if (a.startsWith('--resume-visible=')) { resumeVisible = a.slice('--resume-visible='.length).trim() || 'LATEST'; }
  else if (a === '--mode' && v !== undefined) {
    const m = args[++i].trim().toLowerCase();
    explicitMode = true;
    if (m === 'normal' || m === 'direct' || m === 'run') { autoPlan = false; hierarchy = false; }
    else if (m === 'parallel') { autoPlan = true; hierarchy = false; }
    else if (m === 'team' || m === 'hierarchy') { hierarchy = true; autoPlan = false; }
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
    explicitMode = true;
    if (/^(yes|no|true|false|on|off)$/i.test(v || '')) autoPlan = /^(yes|true|on)$/i.test(args[++i]);
  }
  else if (a === '--role' && v !== undefined) {
    role = args[++i].trim().toUpperCase();
    const known = Object.keys(loadRoles());
    if (!known.includes(role)) { console.error(`Unknown role '${role}'. Choose one of: ${known.join(', ')}`); process.exit(1); }
  }
  else if (a === '--worker' && v !== undefined) {
    explicitMode = true;
    const [id, filesCsv, ...promptParts] = args[++i].split(':');
    subtasks.push({
      id: id || `worker-${subtasks.length + 1}`,
      targetFiles: (filesCsv || '').split(',').map((f) => f.trim()).filter(Boolean),
      prompt: promptParts.join(':').trim() || title
    });
  }
  // An option this script does not know was silently ignored before (e.g. --role up to v1.0.28): say so.
  else if (a.startsWith('--') && !KNOWN_OPTIONS.has(a.split('=')[0])) console.error(`dispatch: ignoring unknown option ${a} (see --help)`);
}
if (role) for (const s of subtasks) if (!s.role) s.role = role;
if (!engine || engine === 'auto') engine = undefined;
if (engine && !config.profiles[engine]) {
  console.error(`Unknown engine '${engine}'. Choose one of: auto, ${Object.keys(config.profiles).join(', ')}`);
  process.exit(1);
}

let workRoot = ROOT;
if (cwdArg !== undefined) {
  try {
    workRoot = validateExternalWorkRoot(path.resolve(cwdArg), ROOT, '--cwd');
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
const hasExternalCwd = !isSameDir(workRoot, ROOT);
if (cwdArg !== undefined && branch) { // also for --cwd . : the help promises a refusal, and a silent no-op hides a mistake
  console.error('Cannot combine --cwd with --branch (the external worktree already defines its own branch).');
  process.exit(1);
}
if (cwdArg !== undefined && resumeVisible) {
  console.error('Cannot combine --cwd with --resume-visible (visible runs always target the main project root).');
  process.exit(1);
}

let resumedRun = null;
let resumedInfo = null;
let backlogId;
let acceptanceCriteria;
let interfaceContract;
let initialError;
if (resumeVisible) {
  if (resumeVisible === 'LATEST') {
    const open = listVisibleRuns().filter((r) => !VISIBLE_TERMINAL.has(r.status));
    resumedRun = open[open.length - 1] || null;
    if (!resumedRun) {
      console.error('No unfinished editor-workflow run to resume. See: node .harness/visible.mjs status');
      process.exit(1);
    }
  } else {
    resumedRun = readVisibleRun(resumeVisible);
    if (!resumedRun) {
      console.error(`No such visible run: ${resumeVisible}. See: node .harness/visible.mjs status`);
      process.exit(1);
    }
  }
  if (!RESUMABLE_STATUSES.has(resumedRun.status)) {
    console.error(`Visible run ${resumedRun.id} is ${resumedRun.status} and cannot be resumed (resumable: ${[...RESUMABLE_STATUSES].join(', ')}).`);
    process.exit(1);
  }
  if (resumedRun.pendingJobId && fs.existsSync(path.join(DIRS.inbox, `${resumedRun.pendingJobId}.json`))) {
    console.error(`Visible run ${resumedRun.id} already has pending headless job ${resumedRun.pendingJobId} in .harness/inbox/. Wait for it to finish first.`);
    process.exit(1);
  }
  resumedInfo = inspectVisibleRun(resumedRun, config);
  if (resumedInfo.forbiddenEdits.length) {
    console.error(`Refusing to resume ${resumedRun.id}: forbidden path(s) were modified on disk (${resumedInfo.forbiddenEdits.join(', ')}). Inspect or restore them first.`);
    process.exit(1);
  }
  if (resumedInfo.outOfScope.length) {
    console.warn(`Warning: ${resumedRun.id} has uncommitted out-of-scope change(s) on disk (${resumedInfo.outOfScope.join(', ')}); headless workers will stay inside their assigned files.`);
  }
  if (branch && resumedInfo.diff.all.length) {
    console.log(`Note: --branch ${branch} runs workers from '${branch}' history; ${resumedInfo.diff.all.length} uncommitted partial edit(s) in your working folder will not appear in branch worktrees.`);
  }
  if (!title) title = `Resume ${resumedRun.id}: ${resumedRun.title}`.slice(0, 120);
  if (!goal) goal = resumedRun.goal;
  if (!verifyCmd && resumedRun.check?.cmd) verifyCmd = resumedRun.check.cmd;
  if (!files.length && resumedRun.userAllowed?.length) files = [...resumedRun.userAllowed];
  if (resumedRun.backlogId) backlogId = resumedRun.backlogId;
  if (resumedRun.acceptanceCriteria?.length) acceptanceCriteria = [...resumedRun.acceptanceCriteria];
  if (resumedRun.interfaceContract) interfaceContract = resumedRun.interfaceContract;
  if (resumedRun.lastVerify && !resumedRun.lastVerify.passed) {
    const trace = String(resumedRun.lastVerify.trace || '').trim();
    if (trace) {
      initialError = clipErrorTrace(trace, 6000);
    } else {
      const errBits = [];
      if (resumedRun.lastVerify.violations?.length) errBits.push(...resumedRun.lastVerify.violations);
      if (resumedRun.lastVerify.patchSafety?.blocking?.length) {
        errBits.push(...resumedRun.lastVerify.patchSafety.blocking.map((b) => (/^PATCH_SAFETY:/i.test(String(b)) ? String(b) : `PATCH_SAFETY: ${b}`)));
      }
      const checkText = String(resumedRun.lastVerify.check || '').trim();
      if (checkText && !(errBits.length && /^PASS\b/i.test(checkText))) errBits.push(checkText);
      if (errBits.length) initialError = clipErrorTrace(errBits.join('\n'), 6000);
    }
  }
  const teamDef = loadTeam();
  if (resumedRun.assignments?.length > 0 && subtasks.length === 0 && !hierarchy && !explicitMode) {
    autoPlan = false;
    const members = teamDef?.members || [];
    const usableFirst = detectEngines(config).usable[0];
    for (const a of resumedRun.assignments) {
      const leadDef = members.find((m) => m.id === a.lead);
      const infoLead = resumedInfo.byLead.find((x) => x.lead === a.lead);
      const promptLines = [
        `Resuming editor run ${resumedRun.id} (started in ${editorDisplayName(resumedRun.editor || 'claude-code')}).`,
        infoLead?.changed.length
          ? `Partial work already on disk in your scope (${infoLead.changed.join(', ')}): inspect it first and keep valid work.`
          : 'No edits recorded in your scope yet; implement the assignment below.',
        infoLead?.missingFiles.length ? `Files expected in your scope that do not exist yet: ${infoLead.missingFiles.join(', ')}.` : '',
        a.goal
      ].filter(Boolean).join('\n');
      const rawEffEngine = engine || leadDef?.engine;
      const effEngine = (!rawEffEngine || rawEffEngine === 'auto')
        ? (config.activeProfile && config.activeProfile !== 'auto' ? config.activeProfile : (usableFirst || (config.autoOrder || [])[0]))
        : rawEffEngine;
      const effProfile = effEngine ? { name: effEngine, ...(config.profiles?.[effEngine] || {}) } : null;
      const safeLeadModel = compatibleModelFor(effProfile, leadDef?.model, leadDef?.engine);
      subtasks.push({
        id: a.lead,
        lead: a.lead,
        ...(leadDef?.role ? { role: leadDef.role } : {}),
        ...(leadDef?.skills?.length ? { skills: leadDef.skills } : {}),
        targetFiles: [...a.files],
        goal: resumedRun.goal,
        ...(leadDef?.engine ? { engine: leadDef.engine } : {}),
        ...(safeLeadModel ? { model: safeLeadModel, ...(leadDef?.engine ? { modelSourceEngine: leadDef.engine } : {}) } : {}),
        ...(leadDef?.budget?.maxCostUsd !== undefined ? { maxCostUsd: leadDef.budget.maxCostUsd } : {}),
        prompt: promptLines
      });
    }
  } else if ((!resumedRun.assignments || resumedRun.assignments.length === 0) && subtasks.length === 0 && !hierarchy && !explicitMode) {
    if (teamDef) { hierarchy = true; autoPlan = false; }
    else autoPlan = true;
  }
}

if (!title) title = goal ? goal.slice(0, 80) : 'Dispatched Swarm Task';
if (!goal && subtasks.length === 0) goal = title;

// No --check: the planner (Node 1) picks one from package.json, workspaces, or project test runners. Preview it here.
let checkLine;
if (verifyCmd) checkLine = verifyCmd;
else {
  const d = detectVerifyCmd(workRoot, config);
  checkLine = `${d.cmd}  (${d.source})${d.real ? '' : ' — WARNING: any result will "pass". Add --check "<command>" for a real gate.'}`;
}

for (const s of subtasks) if (engine) s.engine = engine;
const usePlanner = autoPlan && subtasks.length === 0 && !hierarchy;

if (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY) {
  console.log('Note: Paid API key is active in shell env—unset it if you intend to use your personal subscription');
}
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
  const namedUsable = named.filter((k) => usable.includes(k));
  const checkEngines = namedUsable.length ? [...new Set(namedUsable)] : usable.slice(0, 1);
  for (const w of quotaWarnings(config, checkEngines)) console.log(`! ${formatQuotaWarning(w, config)}`);
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
  ...(hasExternalCwd ? { cwd: workRoot } : {}),
  ...(verifyCmd ? { verifyCmd } : {}),
  ...(branch ? { integrationBranch: branch } : {}),
  createdAt: new Date().toISOString(),
  ...(maxCost !== undefined ? { maxCostUsd: maxCost } : {}),
  ...(resumedRun ? { visibleRunId: resumedRun.id } : {}),
  ...(resumedRun?.bugfix ? { bugfix: true } : {}),
  ...(backlogId ? { backlogId } : {}),
  ...(acceptanceCriteria ? { acceptanceCriteria } : {}),
  ...(interfaceContract ? { interfaceContract } : {}),
  ...(initialError ? { initialError } : {}),
  ...(hierarchy && subtasks.length === 0
    ? { hierarchy: true, goal, targetFiles: files }
    : usePlanner
    ? { autoPlan: true, goal, targetFiles: files }
    : {
        subtasks: subtasks.length > 0
          ? subtasks
          : [{ id: 'worker-main', ...(engine ? { engine } : {}), ...(role ? { role } : {}), targetFiles: files, prompt: goal }]
      })
};

ensureDirs();
const inboxPath = path.join(DIRS.inbox, `${job.id}.json`);
fs.writeFileSync(`${inboxPath}.tmp`, JSON.stringify(job, null, 2)); // atomic hand-off:
fs.renameSync(`${inboxPath}.tmp`, inboxPath);                       // the daemon never sees half a file
if (resumedRun) {
  resumedRun.pendingJobId = job.id;
  writeVisibleRun(resumedRun);
  console.log(`Resuming visible run ${resumedRun.id} (origin: ${editorDisplayName(resumedRun.editor || 'claude-code')}, status: ${resumedRun.status})`);
}
console.log(`Dispatched [${(engine || config.activeProfile).toUpperCase()}] job ${job.id} (${job.hierarchy ? 'orchestrator → leads → workers, per team.json' : usePlanner ? 'AI planner will choose the workers' : `${job.subtasks.length} worker[s]`}) -> ${path.relative(ROOT, inboxPath)}`);
if (hasExternalCwd) console.log(`Workdir: ${workRoot}`);
console.log(`Check: ${checkLine}`);
// One short line so the person always sees that this spends their AI quota (no AI call: read from the log).
{ const today = usageTodayLine(config); console.log(`AI: ${engine || 'auto'}, model picked per job (fast / medium / high)${today ? ` · used today: ${today}` : ''}`); }
const startedIso = new Date().toISOString();
console.log(`JOB_ID=${job.id}`);
console.log(`LIVE_FROM=${(() => { try { return fs.statSync(path.join(ROOT, '.harness', 'live.log')).size; } catch { return 0; } })()}`);
if (branch) console.log(`Git: result is merged into '${branch}' only if the check passes; your folder and protected branches are not touched.`);

if (!wait) process.exit(0);

// ── --wait: follow the job to the end ──
const daemonAlive = () => {
  try { const pid = Number(fs.readFileSync(path.join(ROOT, '.harness', 'daemon.pid'), 'utf8')); return harnessPidAlive(pid) ? pid : 0; } catch { return 0; }
};
const runOnceInline = async () => {
  const child = spawn(process.execPath, [path.join(ROOT, '.harness', 'daemon.mjs'), '--once'], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, HARNESS_SILENT: process.env.HARNESS_SILENT ?? '1' } });
  await new Promise((r) => child.on('close', r));
};
const daemonPid = daemonAlive();
if (!daemonPid) {
  console.log('No background daemon running — processing the job in this terminal…');
  await runOnceInline();
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
    const body = readJsonSafe(path.join(done ? DIRS.completed : DIRS.failed, done || failed)) || {};
    const strayLine = Array.isArray(body.outOfScopeMoved) && body.outOfScopeMoved.length
      ? `\nMoved aside (created outside the assigned files, not kept): ${body.outOfScopeMoved.slice(0, 8).join(', ')}${body.outOfScopeMoved.length > 8 ? ', …' : ''} → .harness/staging/${String(job.id).replace(/[^\w.-]/g, '_')}-out-of-scope/`
      : '';
    if (done) { console.log(`RESULT: COMMITTED ✔  (session note: ${note})\n${aiLine}${strayLine}`); process.exit(0); }
    console.log(`RESULT: NOT DONE ✖  ${body.haltReason || ''}\nSession note: ${note}\n${aiLine}${strayLine}`);
    process.exit(1);
  }
  if (!daemonAlive() && fs.existsSync(inboxPath)) {
    console.log('Background daemon stopped before processing this job — processing it in this terminal…');
    await runOnceInline();
    continue;
  }
  await new Promise((r) => setTimeout(r, 1000));
}
