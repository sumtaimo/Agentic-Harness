#!/usr/bin/env node
/**
 * test/live-e2e.mjs — REAL end-to-end test with real Claude Code agents (not the mock engine).
 *
 *   npm run test:live              all four scenarios
 *   node test/live-e2e.mjs manual      one scenario: manual | autonomous | hierarchy | editor
 *
 * It costs real money (roughly $1.5 for everything: a dozen agent runs) and needs the `claude` CLI installed
 * and logged in. It is NOT part of `npm test`. Every scenario runs in its own throw-away project
 * under your temp folder and stops any controller it starts.
 *
 *   manual      controller in the background → dispatch → follow the live feed → committed, tests pass
 *   autonomous  charter on + backlog item → `daemon --tick` → DEV + QA agents in parallel → merged into
 *               `uat` only after the check passed; main and your branch untouched
 *   hierarchy   `dispatch --hierarchy --max-cost 2` → a REAL orchestrator splits the goal between REAL team leads,
 *               each lead plans its REAL workers, the workers run in parallel inside their lead's scope; the
 *               cost of every agent is counted against the cap
 *   editor      Claude Code accepts .claude/settings.json (no rule-syntax warnings) and the
 *               SessionStart hook really reaches the AI
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const only = process.argv[2];
const t0 = Date.now();
let pass = 0; let fail = 0;

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });
const claude = sh('claude', ['--version']);
if (claude.status !== 0) { console.log('SKIPPED: the `claude` CLI is not installed (or not on PATH). Install it and run `claude` once to log in.'); process.exit(0); }
console.log(`Real-agent end-to-end test — ${claude.stdout.trim()}\n`);

function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✔ ${name}`); } else { fail++; console.log(`  ✖ ${name}${detail ? `\n      ${String(detail).split('\n').slice(0, 6).join('\n      ')}` : ''}`); }
}
const git = (d, ...a) => execFileSync('git', a, { cwd: d, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitOr = (d, ...a) => { try { return git(d, ...a); } catch { return null; } };
const json = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

function project(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `harness-live-${name}-`));
  const r = sh(process.execPath, [path.join(REPO, 'install.mjs'), d]);
  if (r.status !== 0) throw new Error(`install failed: ${r.stderr}`);
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: `live-${name}`, private: true, scripts: { test: 'node --test' } }));
  git(d, 'init', '-q', '-b', 'main'); git(d, 'config', 'user.email', 'live@test'); git(d, 'config', 'user.name', 'live'); git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'initial');
  return d;
}
const nodeIn = (d, args, opts = {}) => sh(process.execPath, args, { cwd: d, timeout: 700000, ...opts });
const startController = async (d) => {
  const child = spawn(process.execPath, ['.harness/daemon.mjs'], { cwd: d, stdio: 'ignore', detached: false });
  const pidFile = path.join(d, '.harness', 'daemon.pid');
  for (let i = 0; i < 40 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 250));
  return child;
};
const stopController = (child) => new Promise((resolve) => { child.on('close', resolve); child.kill('SIGTERM'); setTimeout(resolve, 5000); });
const worktreesLeft = (d) => git(d, 'worktree', 'list').split('\n').length - 1;
const header = (f) => `node -e "const t=require('fs').readFileSync('${f}','utf8').trimStart();if(!t.startsWith('/**')||!t.slice(0,t.indexOf('*/')).includes('@governed-by PO_ARCHITECT')){console.error('${f} lacks the governance header');process.exit(1)}"`;

// ───────────────────────── manual: controller + dispatch + live feed ─────────────────────────
async function manual() {
  console.log('Scenario 1/4 — manual task: real agent, live feed, verified result');
  const d = project('manual');
  const ctl = await startController(d);
  try {
    const disp = nodeIn(d, ['.harness/dispatch.mjs', '--engine', 'claude', '--goal',
      'Create src/slug.js (CommonJS) exporting slugify(text): lowercase, trim, replace every run of non-alphanumeric characters with a single "-", strip leading/trailing "-"; throw TypeError if text is not a string. Also create tests/slug.test.js (node:test + node:assert) covering that, then run npm test and fix any failure.',
      '--files', 'src/slug.js,tests/slug.test.js']);
    const id = (disp.stdout.match(/^JOB_ID=(\S+)/m) || [])[1]; const from = (disp.stdout.match(/^LIVE_FROM=(\d+)/m) || [])[1];
    check('dispatch printed a job id and a live-feed position', !!id && from !== undefined, disp.stdout + disp.stderr);
    const w = nodeIn(d, ['.harness/watch.mjs', '--job', id, '--from', from, '--max-wait', '420']);
    console.log(w.stdout.split('\n').filter((l) => /^\d\d:\d\d:\d\d +\[/.test(l) && !/\[harness\]/.test(l)).map((l) => `      ${l.slice(0, 150)}`).join('\n'));
    check('watch streamed the agent\'s actions live (tool calls) and ended COMMITTED (exit 0)', w.status === 0 && /🔧/.test(w.stdout) && /RESULT: COMMITTED/.test(w.stdout), `exit ${w.status}\n${w.stdout.slice(-600)}`);
    const t = nodeIn(d, ['--test']);
    check('the agent really produced working code (node --test passes in the project)', t.status === 0 && /# pass [1-9]/.test(t.stdout), t.stdout.slice(-400));
    check('the check passed and the job was archived', fs.readdirSync(path.join(d, '.harness', 'completed')).some((f) => f.startsWith(id)), '');
  } finally { await stopController(ctl); }
  check('no controller left running', !fs.existsSync(path.join(d, '.harness', 'daemon.pid')));
}

// ───────────────────────── autonomous: backlog → tick → uat ─────────────────────────
async function autonomous() {
  console.log('\nScenario 2/4 — autonomous tick: DEV + QA agents in parallel, merged into uat only after the check');
  const d = project('auto');
  const mainBefore = git(d, 'rev-parse', 'main');
  const charter = path.join(d, '.harness', 'charter.md');
  fs.writeFileSync(charter, fs.readFileSync(charter, 'utf8').replace('- autonomous: off', '- autonomous: on').replace('- maxAutoTasksPerRun: 3', '- maxAutoTasksPerRun: 1'));
  git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'turn autonomous on');
  const mainBase = git(d, 'rev-parse', 'main');
  fs.writeFileSync(path.join(d, '.harness', 'backlog.json'), JSON.stringify({ version: '2.0.0', project: 'live e2e', tasks: [{
    id: 'LIVE-001', title: 'clamp helper with tests', priority: 1, status: 'READY',
    interfaceContract: 'src/clamp.js (CommonJS) exports { clamp }. clamp(n, min, max) returns n limited to [min, max]. It throws TypeError if any argument is not a finite number and RangeError if min > max.',
    acceptanceCriteria: ['clamp(15, 0, 10) === 10', 'clamp(-5, 0, 10) === 0', 'clamp(5, 0, 10) === 5', 'clamp(1, 10, 0) throws RangeError', 'both files start with a JSDoc block containing @governed-by PO_ARCHITECT'],
    verifyCmd: `${header('src/clamp.js')} && ${header('tests/clamp.test.js')} && npm test`,
    subtasks: [
      { id: 'dev', role: 'DEV_ENGINEER', skills: ['code-craft'], targetFiles: ['src/clamp.js'], prompt: 'Create src/clamp.js exactly as the shared interface contract says. You may run `npm test` or `node --test` to check it.' },
      { id: 'qa', role: 'QA_AUDITOR', skills: ['code-craft'], targetFiles: ['tests/clamp.test.js'], prompt: 'Write tests/clamp.test.js with node:test and node:assert that require("../src/clamp.js") and check every acceptance criterion. Do not create src/clamp.js.' }] }] }, null, 2));
  const r = nodeIn(d, ['.harness/daemon.mjs', '--tick'], { env: { ...process.env, HARNESS_LIVE: '1' } });
  console.log(r.stdout.split('\n').filter((l) => /^ +\[(dev|qa)\]/.test(l.replace(/\x1b\[[0-9;]*m/g, ''))).map((l) => `      ${l.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 150)}`).join('\n'));
  const b = json(path.join(d, '.harness', 'backlog.json')).tasks[0];
  check('backlog item went READY → DONE', b.status === 'DONE', `${b.status} ${b.blockedReason || ''}\n${r.stdout.slice(-500)}`);
  check('main is unchanged', git(d, 'rev-parse', 'main') === mainBase, '');
  check('your folder stayed on main and has no new source files', git(d, 'branch', '--show-current') === 'main' && !fs.existsSync(path.join(d, 'src')), '');
  const uat = gitOr(d, 'rev-parse', '--verify', 'refs/heads/uat');
  check('uat exists and moved forward with the merged work', !!uat && uat !== mainBase && !!gitOr(d, 'show', 'uat:src/clamp.js') && !!gitOr(d, 'show', 'uat:tests/clamp.test.js'), '');
  const log = fs.readFileSync(path.join(d, '.harness', 'telemetry.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const spawns = log.filter((e) => e.phase === 'ENGINE_SPAWN');
  check('DEV and QA agents were started in parallel, each in its own worktree', spawns.length === 2 && Math.abs(new Date(spawns[0].ts) - new Date(spawns[1].ts)) < 2000 && spawns.every((e) => /worktrees/.test(e.cwd)), JSON.stringify(spawns.map((e) => [e.ts, e.cwd])));
  const dev = log.find((e) => e.phase === '1_ROLE_SKILL_MATCH' && /dev/.test(e.message)); const qa = log.find((e) => e.phase === '1_ROLE_SKILL_MATCH' && /qa/.test(e.message));
  check('role tool limits applied (DEV: npm test + node --test; QA: npm test only)', !!dev && !!qa && dev.allowedTools.includes('Bash(node --test:*)') && !qa.allowedTools.some((t) => /node/.test(t)), JSON.stringify([dev && dev.allowedTools, qa && qa.allowedTools]));
  // verify the merged code on uat, not in the folder
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-live-uatcheck-'));
  fs.rmSync(wt, { recursive: true }); git(d, 'worktree', 'add', '-q', '--detach', wt, 'uat');
  const t = sh(process.execPath, ['--test'], { cwd: wt, encoding: 'utf8' });
  git(d, 'worktree', 'remove', '--force', wt);
  check('the tests pass on the uat code', t.status === 0 && /# pass [1-9]/.test(t.stdout) && /# fail 0/.test(t.stdout), t.stdout.slice(-400));
  check('PROTECTED_BRANCHES_UNCHANGED was logged', log.some((e) => e.phase === 'PROTECTED_BRANCHES_UNCHANGED'), '');
  check('no leftover worktrees or harness/* branches', worktreesLeft(d) === 0 && git(d, 'branch', '--list', 'harness/*') === '', `${worktreesLeft(d)} worktrees; ${git(d, 'branch', '--list', 'harness/*')}`);
  void mainBefore;
}

// ───────────────────────── hierarchy: real orchestrator → real leads → real workers ─────────────────────────
async function hierarchy() {
  console.log('\nScenario 3/4 — team hierarchy: real orchestrator → leads → workers, scoped, in parallel, cost counted');
  const d = project('hier');
  const ctl = await startController(d);
  let from; let id;
  try {
    const goal = 'Build a small statistics feature as a team. (1) A short spec in docs/stats.md describing mean(numbers) and median(numbers): inputs, outputs and every error case. (2) src/stats.js, CommonJS, exporting exactly { mean, median }; both take an array of finite numbers and return a number; both throw a TypeError if the argument is not a non-empty array of finite numbers; median of an even-length array is the average of the two middle values. (3) tests/stats.test.js using node:test and node:assert that require("../src/stats.js") and cover normal cases, even and odd lengths, and every error case. Then run npm test.';
    const disp = nodeIn(d, ['.harness/dispatch.mjs', '--engine', 'claude', '--hierarchy', '--max-cost', '2', '--goal', goal,
      '--check', `node -e "const f=require('fs');for(const p of ['docs/stats.md','src/stats.js','tests/stats.test.js'])if(!f.existsSync(p)){console.error('missing '+p);process.exit(1)}" && npm test`]);
    id = (disp.stdout.match(/^JOB_ID=(\S+)/m) || [])[1]; from = (disp.stdout.match(/^LIVE_FROM=(\d+)/m) || [])[1];
    check('dispatch accepted a team (hierarchy) job with a $2 cost cap', !!id && /orchestrator → leads → workers/.test(disp.stdout), disp.stdout + disp.stderr);
    const w = nodeIn(d, ['.harness/watch.mjs', '--job', id, '--from', from, '--max-wait', '720']);
    const feed = w.stdout.split('\n').filter((l) => /^\d\d:\d\d:\d\d +\[/.test(l) && !/\[harness\]/.test(l));
    console.log(feed.map((l) => `      ${l.slice(0, 150)}`).join('\n'));
    check('the whole team ran and the job ended COMMITTED (exit 0)', w.status === 0 && /RESULT: COMMITTED/.test(w.stdout), `exit ${w.status}\n${w.stdout.slice(-700)}`);
    const names = new Set(feed.map((l) => (l.match(/\[([\w.-]+)\]/) || [])[1]));
    const leadsSeen = [...names].filter((n) => /^lead-[a-z]+$/.test(n)); const workersSeen = [...names].filter((n) => /^lead-[a-z]+\./.test(n));
    check('the live feed shows all three levels (orchestrator, ≥2 leads, ≥2 workers) under their own names', names.has('orchestrator') && leadsSeen.length >= 2 && workersSeen.length >= 2, [...names].join(', '));
  } finally { await stopController(ctl); }

  const log = fs.readFileSync(path.join(d, '.harness', 'telemetry.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const spawns = log.filter((e) => e.phase === 'ENGINE_SPAWN');
  const tools = (e) => (e.args[e.args.indexOf('--allowedTools') + 1] || '').split(',');
  const planners = spawns.filter((e) => /^(orchestrator|lead-[a-z]+)$/.test(e.message.replace(/^Spawned \w+ for /, '')));
  check('orchestrator and leads were REAL, separate agents and strictly read-only (Read, Glob, Grep only)', planners.length >= 3 && planners.every((e) => tools(e).join() === 'Read,Glob,Grep'), JSON.stringify(planners.map((e) => [e.message, tools(e)])));
  const planned = log.find((e) => e.phase === '1_HIERARCHY_PLANNED');
  check('the controller validated and recorded the team plan before any worker started', !!planned && planned.team.assignments.length >= 2, JSON.stringify(planned && planned.team));
  const scope = { 'lead-ba': ['docs/'], 'lead-dev': ['src/'], 'lead-qa': ['tests/', 'test/'] };
  const outside = (planned ? planned.team.assignments : []).flatMap((a) => a.workers.flatMap((wk) => wk.files.filter((f) => !(scope[a.lead] || []).some((p) => f.startsWith(p))).map((f) => `${wk.id}:${f}`)));
  check('every worker only owns files inside its lead\'s scope (BA docs/, DEV src/, QA tests/)', !!planned && outside.length === 0, outside.join(', '));
  const workerSpawns = spawns.filter((e) => /^Spawned \w+ for lead-[a-z]+\./.test(e.message));
  check('workers started in parallel (all within 3s of each other)', workerSpawns.length >= 2 && Math.max(...workerSpawns.map((e) => +new Date(e.ts))) - Math.min(...workerSpawns.map((e) => +new Date(e.ts))) < 3000, JSON.stringify(workerSpawns.map((e) => e.ts)));
  const tp = nodeIn(d, ['--test']);
  check('the team produced working code: its own tests pass (node --test)', tp.status === 0 && /# pass [1-9]/.test(tp.stdout) && /# fail 0/.test(tp.stdout), tp.stdout.slice(-400));
  const changed = git(d, 'status', '--porcelain', '-uall').split('\n').filter(Boolean).map((l) => l.slice(3)).filter((f) => !/^(\.harness|\.claude)\//.test(f) && !/^(CLAUDE|GEMINI|AGENTS)\.md$|^\.(vscode|github|cursor)\/|^\.windsurfrules$|^package\.json$|^\.gitignore$/.test(f));
  check('only files in docs/, src/ and tests/ were created or changed', changed.length > 0 && changed.every((f) => /^(docs|src|tests)\//.test(f)), changed.join(', '));
  const arch = fs.readdirSync(path.join(d, '.harness', 'completed')).filter((f) => f.startsWith(id) && f.endsWith('.json')).map((f) => json(path.join(d, '.harness', 'completed', f)))[0];
  check('real cost was counted per agent and stayed under the $2 cap', !!arch && arch.costUsd > 0 && arch.costUsd <= 2 && !!arch.costByAgent.orchestrator && Object.keys(arch.costByAgent).length >= 5, JSON.stringify(arch && [arch.costUsd, arch.costByAgent]));
  console.log(`      real cost of this team run: $${arch ? arch.costUsd.toFixed(3) : '?'} for ${arch ? Object.keys(arch.costByAgent).length : 0} agents`);
  const sessions = fs.readdirSync(path.join(d, '.harness', 'memory', 'sessions')).map((f) => fs.readFileSync(path.join(d, '.harness', 'memory', 'sessions', f), 'utf8')).join('\n');
  check('the session note records the team and the cost', /- Team: orchestrator →/.test(sessions) && /- Cost: \$/.test(sessions), sessions.slice(0, 500));
  check('no controller left running', !fs.existsSync(path.join(d, '.harness', 'daemon.pid')));
}

// ───────────────────────── editor: Claude Code accepts our settings + hook reaches the AI ─────────────────────────
function editor() {
  console.log('\nScenario 4/4 — Claude Code editor integration (.claude/settings.json + SessionStart hook)');
  const d = project('editor');
  check('install copied .claude/settings.json and the slash commands', fs.existsSync(path.join(d, '.claude', 'settings.json')) && ['status', 'tick', 'doctor', 'run', 'teach', 'team'].every((c) => fs.existsSync(path.join(d, '.claude', 'commands', 'harness', `${c}.md`))), '');
  const ping = sh('claude', ['-p', 'Reply with the single word OK.'], { cwd: d, stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 });
  const bad = (ping.stderr || '').split('\n').filter((l) => /not matched|invalid|unrecognized|unknown|schema|failed to parse|error/i.test(l) && !/trusted/i.test(l));
  check('Claude Code reports no problem with any permission rule or hook in .claude/settings.json', bad.length === 0, bad.join('\n') || ping.stderr);
  const hook = sh('claude', ['-p', '--output-format', 'json', "Without running any command: quote word for word the line that starts with '- Controller:' from the context you were given at session start. If there is none, reply NONE."], { cwd: d, stdio: ['ignore', 'pipe', 'pipe'], timeout: 240000 });
  let result = '';
  try { result = JSON.parse(hook.stdout.slice(hook.stdout.indexOf('{'))).result; } catch { result = hook.stdout; }
  check('the SessionStart hook reached the AI (it can quote the harness status line)', /Controller:/.test(result) && !/^NONE/.test(result.trim()), result);
}

try {
  if (!only || only === 'manual') await manual();
  if (!only || only === 'autonomous') await autonomous();
  if (!only || only === 'hierarchy') await hierarchy();
  if (!only || only === 'editor') editor();
} catch (e) { fail++; console.log(`  ✖ scenario crashed: ${e.stack}`); }
console.log(`\n${pass} passed, ${fail} failed  (${Math.round((Date.now() - t0) / 1000)}s)`);
process.exit(fail ? 1 : 0);
