#!/usr/bin/env node
/**
 * .harness/daemon.mjs
 * Unified Background Agentic Controller (Claude Code / Antigravity / Orca / Gemini / Codex)
 *
 *   Square loop:  1_PLANNER -> 2_EXECUTOR_SWARM -> 3_VERIFIER -> 4_COMMITTED
 *                 (verifier failure feeds its error back to the planner, max `maxCycles` times,
 *                  then HALTED_HITL_REQUIRED — a human must look)
 *   AI planner:   a job with "autoPlan": true and only a goal is split by an AI into parallel
 *                 workers with disjoint targetFiles (validated; overlapping plans are rejected).
 *   Swarm mesh:   several workers in parallel; a plan where two workers claim the same file is
 *                 rejected BEFORE any worker starts. Optional git-worktree isolation.
 *   Safety net:   without worktrees, scoped files are backed up to .harness/staging/<taskId>/
 *                 and restored if the task ends in failure. Failed jobs go to .harness/failed/.
 *   Memory:       .harness/memory/* is injected into worker prompts (deduplicated, capped).
 *   Live screen:  4-corner HUD in the terminal (VS Code / Antigravity / Cursor task panel).
 *
 * Usage:
 *   node .harness/daemon.mjs              watch .harness/inbox/ (default; --watch is accepted too)
 *   node .harness/daemon.mjs --self-test  run the built-in 2-worker self-test and exit 0/1
 *   node .harness/daemon.mjs --once       process what is in the inbox now, then exit
 *
 * Env: HARNESS_AGENT=<engine> overrides config.activeProfile; HARNESS_SILENT=1 hides the HUD.
 */

import fs from 'node:fs';
import path from 'node:path';
import { exec, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  ROOT, DIRS, FILES, ensureDirs, loadConfig, atomicWriteJson, readJsonSafe, which,
  resolveProfile, memoryContext, recordSession, remember, listLessons, detectVerifyCmd,
  listProjectFiles, safeTarget
} from './lib/common.mjs';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

ensureDirs();
const config = loadConfig();
const MAX_CYCLES = config.maxCycles ?? 3;
const activeFileLocks = new Set();
const startTime = Date.now();
const queue = [];
const queued = new Set();
let draining = false;
let state = {};

// ───────────────────────────── state + telemetry ─────────────────────────────

function writeState(patch) {
  state = {
    ...state,
    ...patch,
    maxCycles: MAX_CYCLES,
    activeLocks: Array.from(activeFileLocks),
    queueLength: queue.length,
    pid: process.pid,
    uptimeSec: Math.floor((Date.now() - startTime) / 1000),
    updatedAt: new Date().toISOString()
  };
  atomicWriteJson(FILES.state, state); // atomic: temp file + rename
  renderHUD(state);
  return state;
}

function logTelemetry(phase, message, meta = {}) {
  const entry = JSON.stringify({ ts: new Date().toISOString(), phase, message, ...meta });
  fs.appendFileSync(FILES.log, entry + '\n');
}

// ───────────────────────────── 4-corner live HUD ─────────────────────────────

const W = 76;
const C = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m' };
const fit = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n); };
const row = (left, right = '', color = '') => {
  const r = right ? ` ${right}` : '';
  const body = fit(left, W - r.length) + r;
  return `│ ${color}${body}${color ? C.reset : ''} │`;
};
const sep = (a = '├', b = '┤') => `${a}${'─'.repeat(W + 2)}${b}`;

const PHASE_STEPS = ['1_PLANNER', '2_EXECUTOR_SWARM', '3_VERIFIER', '4_COMMITTED'];
function phaseTrack(phase = '') {
  const idx = phase.startsWith('4') ? 3 : phase.startsWith('3') ? 2 : phase.startsWith('2') ? 1 : phase.startsWith('1') ? 0 : -1;
  return PHASE_STEPS.map((p, i) => (i === idx ? `[${p}]` : p)).join(' > ');
}

function nextStepHint(s) {
  const p = s.phase || '';
  if (p === 'HALTED_HITL_REQUIRED') return 'STOPPED: the AI could not pass the check. Your files were restored. Read the newest note in .harness/memory/sessions/.';
  if (p === 'REJECTED') return 'REJECTED before start (see VERIFY line). Fix the task and dispatch it again.';
  if (p.startsWith('4')) return 'Done. The task passed the check. Drop or dispatch the next task.';
  if (p.startsWith('3')) return 'Checking the work with the verify command…';
  if (p.startsWith('2')) return 'AI workers are working. Their files are locked so they cannot collide.';
  if (p === '1_AI_PLANNER') return 'The AI planner is splitting your goal into parallel workers…';
  if (p.startsWith('1')) return 'Reading the task and checking which files each worker owns…';
  return 'Ready. Run task "Harness: 2. New task" (Ctrl/Cmd+Shift+P > Run Task) or ask your AI chat.';
}

const engineList = () => Object.entries(config.profiles)
  .map(([k, p]) => `${k.toUpperCase()}${which(p.binary) ? '✓' : '·'}`).join(' ');

function renderHUD(s) {
  if (process.env.HARNESS_SILENT === '1') return;
  const p = s.phase || 'IDLE';
  if (!process.stdout.isTTY) { // logs / CI: one compact line per change
    console.log(`[harness] ${p} | ${s.engine || '-'} | cycle ${s.cycle || 0}/${MAX_CYCLES} | ${s.taskTitle || ''} | ${s.lastGateStatus || ''}`);
    return;
  }
  const color = p.startsWith('HALT') || p.includes('FAIL') || p === 'REJECTED' ? C.red
    : p.startsWith('4') || p.startsWith('3_VERIFIED') ? C.green
      : p.startsWith('IDLE') ? C.cyan : C.yellow;
  const taught = listLessons(FILES.lessons).length;
  const auto = listLessons(FILES.autoLessons).length;
  const out = [
    '\x1b[2J\x1b[H', // clear screen, keep scrollback
    `${C.bold}  AGENTIC HARNESS${C.reset}${C.dim}  — square loop + swarm mesh · ${ROOT}${C.reset}`,
    sep('┌', '┐'),
    row(`TOPOLOGY: ${s.mode || 'SQUARE-4-NODE'} [${s.engine || '-'}]`, `CYCLE: ${s.cycle || 0}/${MAX_CYCLES} | LOCKS: ${activeFileLocks.size}`),
    row(`PHASE:    ${p}`, `UPTIME: ${s.uptimeSec || 0}s | PID: ${process.pid}`, color),
    row(`          ${phaseTrack(p)}`, '', C.dim),
    sep(),
    row(`TASK:    ${s.taskTitle || 'Waiting for .harness/inbox/*.json …'}`),
    row(`PLAN:    ${s.planSummary || '-'}`),
    row(`SWARM:   ${s.workerSummary || 'No active swarm workers'}`),
    row(`VERIFY:  ${s.lastGateStatus || 'READY'}`, '', color),
    row(`QUEUE:   ${queue.length} waiting  |  MEMORY: ${taught} taught rule(s), ${auto} auto lesson(s)`),
    sep(),
    row(`ENGINES: ${engineList()}   (✓ installed)`),
    row('LOGS: .harness/telemetry.log', 'MEMORY: .harness/memory/'),
    sep('└', '┘'),
    `  ${color}➜ ${nextStepHint(s)}${C.reset}`,
    ...(s.history || []).slice(-5).reverse().map((h) => `  ${C.dim}${h}${C.reset}`)
  ];
  process.stdout.write(out.join('\n') + '\n');
}

// ───────────────────────────── engine spawning ─────────────────────────────

const fatal = (msg) => Object.assign(new Error(msg), { fatal: true });
const winQuote = (a) => (/[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);

/**
 * Build the engine command line. The prompt is delivered according to profile.promptVia:
 *   "stdin" (default) — piped to the engine's standard input (robust: no flag can swallow it)
 *   "arg"             — substituted where "{prompt}" appears in args
 *   "after--"         — appended after a "--" separator
 */
function buildArgs(profile, prompt, allowedTools) {
  const allowed = (allowedTools || profile.allowedTools || []).join(',');
  const via = profile.promptVia || ((profile.args || []).includes('{prompt}') ? 'arg' : 'stdin');
  const args = [];
  for (const a of profile.args || []) {
    if (a === '{prompt}') { if (via === 'arg') args.push(prompt); continue; }
    args.push(a.replace('{allowedTools}', allowed));
  }
  const mcpFile = profile.mcpConfigPath && path.join(ROOT, profile.mcpConfigPath);
  if (profile.useMcp && mcpFile && fs.existsSync(mcpFile)) {
    args.push(...(profile.mcpArgs || []).map((a) => a.replace('{mcpConfig}', mcpFile)));
  }
  if (via === 'after--') args.push('--', prompt);
  return { args, viaStdin: via === 'stdin' };
}

/** Spawn an AI engine with a prompt. Resolves { engine, output }. */
function spawnEngine({ id, engine, prompt, cwd, timeoutMs, allowedTools }) {
  return new Promise((resolve, reject) => {
    let profile;
    try { profile = resolveProfile(config, engine); } catch (e) { return reject(e); }
    if (profile.fallbackFrom) {
      logTelemetry('ENGINE_FALLBACK', `Engine '${profile.fallbackFrom}' unavailable (${profile.fallbackReason}); using '${profile.name}'`, { worker: id });
      writeState({ engine: profile.name.toUpperCase(), history: pushHistory(`! ${profile.fallbackFrom} unavailable → using ${profile.name}`) });
    }
    const binPath = which(profile.binary);
    const { args, viaStdin } = buildArgs(profile, prompt, allowedTools);
    const isWin = process.platform === 'win32';
    const env = { ...process.env, HARNESS_WORKER: '1', HARNESS_WORKER_ID: id };
    const child = spawn(isWin ? winQuote(binPath) : binPath, isWin ? args.map(winQuote) : args, { cwd, env, shell: isWin, stdio: ['pipe', 'pipe', 'pipe'] });
    logTelemetry('ENGINE_SPAWN', `Spawned ${profile.name} for ${id}`, { engine: profile.name, binary: binPath, args: args.map((a) => (a === prompt ? '<prompt>' : a)), promptVia: viaStdin ? 'stdin' : 'args', cwd });

    let stdout = ''; let stderr = ''; let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
    const ms = timeoutMs || config.workerTimeoutMs || 300000;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      done(reject, new Error(`${id} (${profile.name}) timed out after ${ms}ms`));
    }, ms);

    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.stdin.on('error', () => {}); // engine may close stdin early
    if (viaStdin) child.stdin.write(prompt);
    child.stdin.end();

    child.on('error', (err) => done(reject, Object.assign(new Error(`Failed to start '${profile.binary}': ${err.message}`), { fatal: err.code === 'ENOENT' })));
    child.on('close', (code) => {
      if (code !== 0) return done(reject, new Error(`${id} (${profile.name}) exited with code ${code}: ${(stderr || stdout).trim().slice(0, 4000)}`));
      try { done(resolve, { engine: profile.name, output: summarizeOutput(stdout) }); } catch (e) { done(reject, e); }
    });
  });
}

/** Claude's --output-format json returns {result, is_error, ...}; other engines return text. */
function summarizeOutput(stdout) {
  const text = stdout.trim();
  let j;
  try { j = JSON.parse(text); } catch { return text; }
  if (j && typeof j === 'object' && 'result' in j) {
    if (j.is_error) throw new Error(`Engine reported an error: ${String(j.result).slice(0, 2000)}`);
    return String(j.result);
  }
  return text;
}

/** Which memory parts the engine already loads itself (e.g. CLAUDE.md "@.harness/memory/lessons.md"). */
function autoLoadedMemory(profile, cwd) {
  if (!profile.instructionFile || config.useGitWorktrees) return []; // worktrees see the last commit, maybe stale
  let text = '';
  try { text = fs.readFileSync(path.join(cwd, profile.instructionFile), 'utf8'); } catch { return []; }
  const skip = [];
  if (/^@\.harness\/memory\/profile\.md\s*$/m.test(text)) skip.push('profile');
  if (/^@\.harness\/memory\/lessons\.md\s*$/m.test(text)) skip.push('lessons');
  return skip;
}

function buildWorkerPrompt(subtask, profileName, cwd, errorContext) {
  let skip = [];
  try { skip = autoLoadedMemory(config.profiles[profileName] || {}, cwd); } catch { /* inject everything */ }
  const memory = memoryContext(config, { skip });
  const scoped = (subtask.targetFiles || []).length > 0;
  return [
    `[HARNESS WORKER ID: ${subtask.id} | ENGINE: ${String(profileName).toUpperCase()}]`,
    '[YOU ARE A HARNESS WORKER: do the task below directly. Do NOT dispatch new harness tasks.]',
    scoped
      ? `[SCOPED TARGET FILES: ${subtask.targetFiles.join(', ')}]\n[STRICT CONSTRAINT: Only modify your scoped target files. Do not touch unrelated files.]`
      : '[SCOPE: whole project — change only what the task needs.]',
    memory ? `[USER MEMORY — follow these preferences and rules]:\n${memory}` : '',
    subtask.goal ? `[OVERALL GOAL (other workers handle the other parts in parallel)]:\n${subtask.goal}` : '',
    errorContext ? `[PREVIOUS VERIFIER ERROR TO FIX]:\n${String(errorContext).slice(0, 6000)}` : '',
    `[TASK INSTRUCTIONS]:\n${subtask.prompt}`
  ].filter(Boolean).join('\n\n');
}

function runWorker(subtask, cwd, errorContext) {
  const timeoutMs = subtask.timeoutMs || config.workerTimeoutMs || 300000;
  // Plain shell command worker (no AI): used by the self-test and for scripted steps.
  if (subtask.cliCommand && !subtask.prompt) {
    return new Promise((resolve, reject) => {
      exec(subtask.cliCommand, { cwd, env: { ...process.env, HARNESS_WORKER: '1', HARNESS_WORKER_ID: subtask.id }, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(`Worker ${subtask.id} command failed: ${(stderr || err.message).trim()}`));
        resolve({ id: subtask.id, engine: 'shell', output: stdout.trim() });
      });
    });
  }
  let profileName;
  try { profileName = resolveProfile(config, subtask.engine).name; } catch (e) { return Promise.reject(e); }
  const prompt = buildWorkerPrompt(subtask, profileName, cwd, errorContext);
  return spawnEngine({ id: subtask.id, engine: subtask.engine, prompt, cwd, timeoutMs, allowedTools: subtask.allowedTools })
    .then((r) => ({ id: subtask.id, ...r }));
}

// ───────────────────────────── git helpers ─────────────────────────────

async function isGitRepo() {
  try { await execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: ROOT }); return true; } catch { return false; }
}

const inScope = (file, targets) => targets.length === 0 || targets.some((t) => {
  const n = t.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  return file === n || file.startsWith(n + '/');
});

/** Copy the worker's changes from its worktree back to the main folder — only files in scope. */
async function syncWorktree(wtPath, sub) {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain', '-uall', '-z'], { cwd: wtPath });
  const entries = stdout.split('\0').filter(Boolean);
  const copied = []; const blocked = [];
  for (let i = 0; i < entries.length; i++) {
    const status = entries[i].slice(0, 2);
    const file = entries[i].slice(3);
    if (status.startsWith('R')) i++; // rename: next entry is the old path
    if (file.startsWith('.harness/')) continue;
    if (!inScope(file, sub.targetFiles)) { blocked.push(file); continue; }
    const src = path.join(wtPath, file); const dest = path.join(ROOT, file);
    if (fs.existsSync(src)) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(src, dest); } else if (fs.existsSync(dest)) fs.rmSync(dest);
    copied.push(file);
  }
  if (blocked.length) logTelemetry('2_SCOPE_VIOLATION', `Worker ${sub.id} changed files outside its scope; those changes were discarded`, { worker: sub.id, blocked });
  return { copied, blocked };
}

// ───────────────────────────── staging backup + rollback ─────────────────────────────

/** Back up every scoped target before Node 2 runs (only when worktrees are off). */
function backupScope(plan) {
  if (config.useGitWorktrees || config.rollbackOnFailure === false) return null;
  const aiWorkers = plan.subtasks.filter((s) => s.prompt);
  if (!aiWorkers.length) return null;
  if (aiWorkers.some((s) => s.targetFiles.length === 0)) {
    logTelemetry('ROLLBACK_UNAVAILABLE', 'An AI worker has no targetFiles, so its changes cannot be backed up. Use --files, --auto-plan, or git to undo.', { taskId: plan.taskId });
    return { unavailable: true };
  }
  const dir = path.join(DIRS.staging, plan.taskId.replace(/[^\w.-]/g, '_'));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
  const manifest = [];
  for (const t of [...new Set(aiWorkers.flatMap((s) => s.targetFiles))]) {
    const abs = path.join(ROOT, t);
    if (fs.existsSync(abs)) {
      fs.cpSync(abs, path.join(dir, 'files', t), { recursive: true });
      manifest.push({ path: t, existed: true });
    } else manifest.push({ path: t, existed: false });
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ taskId: plan.taskId, createdAt: new Date().toISOString(), entries: manifest }, null, 2));
  logTelemetry('STAGING_BACKUP', `Backed up ${manifest.length} scoped path(s) before execution`, { taskId: plan.taskId, paths: manifest.map((m) => m.path) });
  return { dir, manifest };
}

function restoreScope(backup) {
  if (!backup || backup.unavailable) return backup?.unavailable ? 'not possible (unscoped AI worker)' : null;
  for (const m of backup.manifest) {
    const abs = path.join(ROOT, m.path);
    fs.rmSync(abs, { recursive: true, force: true });
    if (m.existed) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.cpSync(path.join(backup.dir, 'files', m.path), abs, { recursive: true });
    }
  }
  fs.rmSync(backup.dir, { recursive: true, force: true });
  logTelemetry('ROLLBACK_DONE', `Restored ${backup.manifest.length} scoped path(s) to their state before the task`, { paths: backup.manifest.map((m) => m.path) });
  return `restored ${backup.manifest.map((m) => m.path).join(', ')}`;
}

function discardBackup(backup) {
  if (backup?.dir) fs.rmSync(backup.dir, { recursive: true, force: true });
}

// ───────────────────────────── Node 1: planner ─────────────────────────────

/**
 * Validate subtasks: safe paths, unique ids, and the Swarm Conflict Invariant
 *   LockedFiles(A) ∩ LockedFiles(B) = ∅  (a folder also conflicts with any file inside it).
 */
function validateSubtasks(subtasks, { source = 'task', allowed = [], requireScope = false } = {}) {
  const owner = new Map();
  const ids = new Set();
  for (const sub of subtasks) {
    sub.id = String(sub.id || `worker-${subtasks.indexOf(sub) + 1}`).replace(/[^\w.-]/g, '-').slice(0, 40);
    if (ids.has(sub.id)) sub.id = `${sub.id}-${subtasks.indexOf(sub) + 1}`;
    ids.add(sub.id);
    const raw = sub.targetFiles || (sub.targetFile ? [sub.targetFile] : []);
    if (!Array.isArray(raw)) throw fatal(`${source}: worker '${sub.id}' targetFiles must be a list.`);
    sub.targetFiles = raw.map((f) => {
      const s = safeTarget(f);
      if (!s) throw fatal(`${source}: worker '${sub.id}' has an unsafe target path '${f}' (absolute, "..", ".", .git or .harness).`);
      return s.replace(/\/$/, '') + (String(f).endsWith('/') ? '/' : '');
    });
    if (!sub.prompt && !sub.cliCommand) throw fatal(`${source}: worker '${sub.id}' has neither a prompt nor a cliCommand.`);
    if ((requireScope || subtasks.length > 1) && sub.targetFiles.length === 0) {
      throw fatal(`Swarm Lock Collision: ${source} worker '${sub.id}' has no targetFiles, so it could touch any file. In a swarm every worker must own explicit files.`);
    }
    if (allowed.length) {
      const outside = sub.targetFiles.filter((f) => !inScope(f.replace(/\/$/, ''), allowed));
      if (outside.length) throw fatal(`${source}: worker '${sub.id}' targets ${outside.join(', ')}, outside the allowed files (${allowed.join(', ')}).`);
    }
    for (const f of sub.targetFiles) {
      const key = f.replace(/\/$/, '');
      for (const [other, by] of owner) {
        if (by !== sub.id && (key === other || key.startsWith(other + '/') || other.startsWith(key + '/'))) {
          throw fatal(`Swarm Lock Collision: ${source === 'task' ? '' : `${source} produced overlapping targetFiles — `}'${sub.id}' and '${by}' both claim '${key === other ? key : `${other}' / '${key}`}'. Plan rejected before any worker started.`);
        }
      }
      owner.set(key, sub.id);
    }
  }
  return subtasks;
}

function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return JSON.parse(candidate);
}

/** Ask the AI to split a goal into parallel workers with disjoint files. Re-asks once on an invalid plan. */
async function aiDecompose(task) {
  const pc = config.planner || {};
  const maxWorkers = pc.maxWorkers || 4;
  const allowed = (task.targetFiles || []).map(safeTarget).filter(Boolean);
  const { files, total } = listProjectFiles(ROOT, pc.maxFilesListed || 400);
  const scripts = readJsonSafe(path.join(ROOT, 'package.json'), null)?.scripts;
  const memory = memoryContext(config);
  let feedback = '';
  const attempts = pc.maxAttempts || 2;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    writeState({ phase: '1_AI_PLANNER', planSummary: `AI planner attempt ${attempt}/${attempts}…` });
    const prompt = [
      '[HARNESS PLANNER]',
      'You are the PLANNING node of an agentic harness. Do NOT create, edit or delete any file. You may read files to understand the project.',
      `Split the GOAL into 1 to ${maxWorkers} workers that will run IN PARALLEL. Rules:`,
      '- Each worker owns a list of targetFiles (paths relative to the project root). Only it may change those files.',
      '- No path may appear in two workers, and no worker may own a folder that contains another worker\'s file.',
      '- Never use absolute paths, "..", ".", ".git/" or ".harness/".',
      allowed.length ? `- Workers may ONLY own paths inside: ${allowed.join(', ')}` : '',
      '- If the work cannot be split safely, return exactly ONE worker.',
      '- Each worker prompt must be self-contained: what to build in its files AND the exact names/exports/interfaces it shares with the other workers.',
      'Reply with ONLY this JSON object, no other text:',
      '{"subtasks":[{"id":"short-kebab-id","targetFiles":["path/file.ext"],"prompt":"instructions"}],"verifySuggestion":"optional shell command that would prove the goal works"}',
      `\n[GOAL]:\n${task.goal || task.prompt || task.title}`,
      `\n[PROJECT FILES (${files.length} of ${total})]:\n${files.join('\n') || '(empty project)'}`,
      scripts ? `\n[package.json scripts]:\n${JSON.stringify(scripts, null, 2)}` : '',
      memory ? `\n[USER MEMORY]:\n${memory}` : '',
      feedback ? `\n[YOUR PREVIOUS PLAN WAS REJECTED — fix this]:\n${feedback}` : ''
    ].filter(Boolean).join('\n');

    logTelemetry('1_AI_PLANNER', `AI planner attempt ${attempt}/${attempts}`, { goal: (task.goal || '').slice(0, 300) });
    const { output, engine } = await spawnEngine({
      id: 'ai-planner', engine: task.engine, prompt, cwd: ROOT,
      timeoutMs: pc.timeoutMs || config.workerTimeoutMs, allowedTools: pc.allowedTools || ['Read', 'Glob', 'Grep']
    });
    try {
      let plan;
      try { plan = extractJson(output); } catch { throw new Error(`Reply was not valid JSON: ${output.slice(0, 300)}`); }
      if (!Array.isArray(plan.subtasks) || plan.subtasks.length === 0) throw new Error('JSON has no "subtasks" list.');
      if (plan.subtasks.length > maxWorkers) throw new Error(`Too many workers (${plan.subtasks.length}); the maximum is ${maxWorkers}.`);
      const subtasks = plan.subtasks.map((s) => ({ id: s.id, targetFiles: s.targetFiles, prompt: String(s.prompt || '').trim(), engine: task.engine, goal: task.goal }));
      validateSubtasks(subtasks, { source: 'AI planner', allowed, requireScope: true });
      logTelemetry('1_AI_PLANNED', `AI planner produced ${subtasks.length} worker(s)`, { engine, subtasks: subtasks.map((s) => ({ id: s.id, targetFiles: s.targetFiles })) });
      return { subtasks, verifySuggestion: typeof plan.verifySuggestion === 'string' ? plan.verifySuggestion.slice(0, 300) : '' };
    } catch (e) {
      feedback = e.message;
      logTelemetry('1_AI_PLAN_INVALID', e.message, { attempt });
    }
  }
  throw fatal(`AI planner could not produce a valid plan after ${attempts} attempt(s): ${feedback}`);
}

async function runPlanner(task, errorTrace = null, previous = null) {
  const allShell = (subs) => subs.length > 0 && subs.every((s) => s.cliCommand && !s.prompt);
  const engineLabel = (subs) => {
    if (allShell(subs)) return String(task.engine || 'shell').toUpperCase(); // no AI involved
    try { return resolveProfile(config, task.engine).name.toUpperCase(); } catch { return String(task.engine || '?').toUpperCase(); }
  };

  if (previous) { // later cycles keep the same workers + files; only the error context changes
    writeState({ phase: '1_PLANNER', taskTitle: task.title, planSummary: `${previous.planSummary} (cycle retry with error)` });
    logTelemetry('1_PLANNER', 'Re-using plan; feeding verifier error to workers', { errorTrace: String(errorTrace).slice(0, 2000) });
    return { ...previous, errorContext: errorTrace };
  }

  const given = Array.isArray(task.subtasks) && task.subtasks.length > 0;
  writeState({ phase: '1_PLANNER', engine: engineLabel(given ? task.subtasks : [{ prompt: 'x' }]), taskTitle: task.title, planSummary: given ? `${task.subtasks.length} worker(s) given by the task` : 'single worker' });
  logTelemetry('1_PLANNER', 'Validating task and checking file-lock boundaries', { engine: task.engine || 'auto', errorTrace });

  let subtasks; let planSummary; let verifySuggestion = '';
  if (given) {
    subtasks = task.subtasks.map((s) => ({ ...s, engine: s.engine || task.engine }));
    validateSubtasks(subtasks);
    planSummary = `${subtasks.length} worker(s) given by the task`;
  } else if (task.autoPlan) {
    const r = await aiDecompose(task);
    subtasks = r.subtasks; verifySuggestion = r.verifySuggestion;
    planSummary = `AI planner → ${subtasks.length} worker(s): ${subtasks.map((s) => `${s.id}[${s.targetFiles.join(',')}]`).join('  ')}`;
  } else {
    subtasks = validateSubtasks([{
      id: 'worker-primary', engine: task.engine, targetFiles: task.targetFiles || [],
      prompt: task.goal || task.prompt || null, cliCommand: task.cliCommand || (task.goal || task.prompt ? null : 'node -v')
    }]);
    planSummary = 'single worker';
  }

  let verifyCmd = task.verifyCmd; let verifySource = 'given by task';
  if (!verifyCmd) { const d = detectVerifyCmd(ROOT, config); verifyCmd = d.cmd; verifySource = d.source; }
  const mode = subtasks.length > 1 ? `SWARM-MESH (${subtasks.length}W)` : 'SQUARE-4-NODE';
  writeState({ engine: engineLabel(subtasks), mode, planSummary, lastGateStatus: `Check: ${verifyCmd}  (${verifySource})` });
  return {
    taskId: task.id || `job-${Date.now()}`,
    title: task.title || 'Unnamed Harness Task',
    engine: engineLabel(subtasks), mode, subtasks, verifyCmd, verifySource, verifySuggestion, planSummary,
    errorContext: errorTrace
  };
}

// ───────────────────────────── Node 2: executor swarm ─────────────────────────────

async function runExecutorSwarm(plan) {
  writeState({ phase: '2_EXECUTOR_SWARM', mode: plan.mode, workerSummary: `Spawning ${plan.subtasks.length} worker(s): ${plan.subtasks.map((s) => s.id).join(', ')}` });
  logTelemetry('2_EXECUTOR', `Dispatching ${plan.subtasks.length} worker(s)`, { mode: plan.mode, engine: plan.engine });

  const useWorktrees = config.useGitWorktrees && plan.subtasks.some((s) => s.prompt);
  if (useWorktrees && !(await isGitRepo())) throw fatal('useGitWorktrees is on, but this folder is not a git repository with at least one commit.');

  let finished = 0;
  const workerPromises = plan.subtasks.map(async (sub) => {
    for (const f of sub.targetFiles) activeFileLocks.add(f);
    writeState({ phase: '2_EXECUTOR_SWARM' });
    let workerCwd = ROOT;
    const wtPath = path.join(DIRS.worktrees, `${plan.taskId}-${sub.id}`.replace(/[^\w.-]/g, '_'));
    try {
      if (useWorktrees) {
        await execFileAsync('git', ['worktree', 'add', '--detach', wtPath, 'HEAD'], { cwd: ROOT });
        workerCwd = wtPath;
      }
      const result = await runWorker(sub, workerCwd, plan.errorContext);
      if (useWorktrees) result.sync = await syncWorktree(wtPath, sub);
      finished++;
      writeState({ workerSummary: `${finished}/${plan.subtasks.length} worker(s) finished (last: ${sub.id})` });
      return result;
    } finally {
      for (const f of sub.targetFiles) activeFileLocks.delete(f);
      if (useWorktrees && fs.existsSync(wtPath)) await execFileAsync('git', ['worktree', 'remove', '--force', wtPath], { cwd: ROOT }).catch(() => {});
      writeState({ phase: '2_EXECUTOR_SWARM' });
    }
  });

  const results = await Promise.allSettled(workerPromises);
  const rejected = results.filter((r) => r.status === 'rejected');
  if (rejected.length > 0) {
    const errMsg = rejected.map((r) => r.reason.message).join(' | ');
    writeState({ workerSummary: `FAILED: ${errMsg}` });
    throw Object.assign(new Error(`Swarm execution failed: ${errMsg}`), { fatal: rejected.some((r) => r.reason.fatal) });
  }
  writeState({ phase: '2_EXECUTED', workerSummary: `All ${plan.subtasks.length} worker(s) completed cleanly.` });
  return results.map((r) => r.value);
}

// ───────────────────────────── Node 3: verifier ─────────────────────────────

async function runVerifier(plan) {
  writeState({ phase: '3_VERIFIER', lastGateStatus: `Running: ${plan.verifyCmd}` });
  logTelemetry('3_VERIFIER', `Executing verification command: ${plan.verifyCmd}`, { source: plan.verifySource });
  try {
    const { stdout } = await execAsync(plan.verifyCmd, { cwd: ROOT, timeout: config.verifyTimeoutMs || 600000, maxBuffer: 32 * 1024 * 1024 });
    const cleanOut = (stdout || '').trim().split('\n').filter(Boolean).pop() || 'OK';
    writeState({ phase: '3_VERIFIED', lastGateStatus: `PASS (Exit 0): ${plan.verifyCmd} -> ${cleanOut}` });
    logTelemetry('3_VERIFIED', 'Verifier exit code 0');
    return { passed: true, output: stdout.trim() };
  } catch (err) {
    const trace = `exit code ${err.code ?? '?'}\n${[err.stderr, err.stdout].filter(Boolean).join('\n').trim() || err.message}`;
    writeState({ phase: '3_VERIFY_FAILED', lastGateStatus: `FAIL: ${trace.replace(/\s+/g, ' ')}` });
    logTelemetry('3_VERIFY_FAILED', 'Verifier returned non-zero', { trace: trace.slice(0, 4000) });
    return { passed: false, trace };
  }
}

// ───────────────────────────── Node 4: committer ─────────────────────────────

async function runCommitter(plan, task, taskFile) {
  let gitNote = '';
  if (config.autoGitCommit && (await isGitRepo())) {
    const scope = plan.subtasks.flatMap((s) => s.targetFiles);
    try {
      await execFileAsync('git', ['add', '-A', '--', ...(scope.length ? scope : ['.']), ':(exclude).harness'], { cwd: ROOT });
      const { stdout } = await execFileAsync('git', ['diff', '--cached', '--name-only'], { cwd: ROOT });
      if (stdout.trim()) {
        await execFileAsync('git', ['commit', '-m', `harness: ${plan.title}`, '-m', `Task ${plan.taskId}; verified by: ${plan.verifyCmd}`], { cwd: ROOT });
        gitNote = ' + git commit';
      }
    } catch (e) { logTelemetry('4_GIT_COMMIT_FAILED', e.message); gitNote = ' (git commit failed — see log)'; }
  }
  writeState({ phase: '4_COMMITTED', lastGateStatus: `COMMITTED: ${plan.taskId} verified & archived${gitNote}.` });
  logTelemetry('4_COMMITTER', 'Task passed all gates and committed', { taskId: plan.taskId, engine: plan.engine, verifyCmd: plan.verifyCmd });
  archiveTask(taskFile, task, DIRS.completed, { result: 'COMMITTED', plan: plan.subtasks, verifyCmd: plan.verifyCmd, completedAt: new Date().toISOString() });
}

/** Move a job out of the inbox to completed/ or failed/ as <id>-<timestamp>.json (+ .trace.txt for failures). */
function archiveTask(taskFile, task, destDir, extra = {}, trace = '') {
  const base = String(task?.id || path.basename(taskFile, '.json')).replace(/[^\w.-]/g, '_');
  const dest = path.join(destDir, `${base}-${Date.now()}.json`);
  const body = task || { raw: fs.existsSync(taskFile) ? fs.readFileSync(taskFile, 'utf8') : '' };
  fs.writeFileSync(dest, JSON.stringify({ ...body, ...extra }, null, 2));
  if (trace) fs.writeFileSync(dest.replace(/\.json$/, '.trace.txt'), trace);
  fs.rmSync(taskFile, { force: true });
  return dest;
}

function pushHistory(line) {
  return [...(state.history || []), `${new Date().toLocaleTimeString()}  ${line}`].slice(-20);
}

// ───────────────────────────── the square loop ─────────────────────────────

async function readTask(taskFile) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return JSON.parse(fs.readFileSync(taskFile, 'utf8')); } catch (e) {
      if (attempt === 2) throw e;
      await new Promise((r) => setTimeout(r, 300)); // file may still be being written
    }
  }
}

async function executeSquareCycle(taskFile) {
  if (!fs.existsSync(taskFile)) return false;
  let task;
  try { task = await readTask(taskFile); } catch (e) {
    archiveTask(taskFile, null, DIRS.failed, { result: 'REJECTED', haltReason: `Invalid JSON: ${e.message}` }, e.stack);
    writeState({ phase: 'REJECTED', taskTitle: path.basename(taskFile), lastGateStatus: `Invalid task JSON: ${e.message}` });
    logTelemetry('REJECTED', `Invalid task JSON in ${path.basename(taskFile)}`, { error: e.message });
    return false;
  }

  const errors = [];
  let plan = null; let outputs = []; let cycle = 1; let lastErrorTrace = null; let haltReason = null; let backup = null;
  const title = task.title || path.basename(taskFile);
  writeState({ planSummary: '-', workerSummary: '-' });

  while (cycle <= MAX_CYCLES) {
    writeState({ cycle, taskId: task.id, taskTitle: title, lastGateStatus: cycle > 1 ? `Retrying with previous error (cycle ${cycle})` : 'Planning…' });
    try {
      plan = await runPlanner(task, lastErrorTrace, plan);
      if (cycle === 1 && !backup) backup = backupScope(plan);
      outputs = await runExecutorSwarm(plan);
      const verification = await runVerifier(plan);
      if (verification.passed) {
        await runCommitter(plan, task, taskFile);
        discardBackup(backup);
        finishSession(task, plan, 'COMMITTED', cycle, errors, outputs);
        writeState({ history: pushHistory(`✔ COMMITTED  ${title} (cycle ${cycle}/${MAX_CYCLES})`) });
        return true;
      }
      lastErrorTrace = verification.trace;
      errors.push(verification.trace);
      logTelemetry('SQUARE_RETRY', `Cycle ${cycle} failed verification; feeding trace to Planner`, { cycle, trace: lastErrorTrace.slice(0, 4000) });
    } catch (err) {
      lastErrorTrace = err.message;
      errors.push(err.message);
      logTelemetry('CYCLE_EXCEPTION', err.message, { cycle, fatal: !!err.fatal });
      if (err.fatal) { haltReason = err.message; break; } // retrying cannot fix this: reject now
    }
    cycle++;
  }

  const usedCycles = Math.min(cycle, MAX_CYCLES);
  const phase = haltReason ? 'REJECTED' : 'HALTED_HITL_REQUIRED';
  const reason = haltReason || `HALTED after ${MAX_CYCLES} cycles. Last error: ${lastErrorTrace}`;
  let rollback = null;
  try { rollback = restoreScope(backup); } catch (e) { rollback = `FAILED: ${e.message} — backup kept in .harness/staging/`; logTelemetry('ROLLBACK_FAILED', e.message); }
  const dest = archiveTask(taskFile, task, DIRS.failed, {
    result: phase, haltReason: reason, haltedAt: new Date().toISOString(), cyclesUsed: usedCycles, rollback, errors
  }, errors.map((e, i) => `===== cycle ${i + 1} =====\n${e}`).join('\n\n'));
  finishSession(task, plan, phase, usedCycles, errors, outputs, rollback);
  writeState({
    phase,
    lastGateStatus: haltReason ? `REJECTED: ${haltReason}` : `HALTED after ${MAX_CYCLES} cycles${rollback ? `; files ${rollback}` : ''}. Inspect .harness/failed/`,
    history: pushHistory(`✖ ${phase}  ${title} → ${path.relative(ROOT, dest)}`)
  });
  logTelemetry(phase, reason.slice(0, 4000), { taskId: task.id, rollback, deadLetter: path.relative(ROOT, dest) });
  return false;
}

function finishSession(task, plan, result, cycles, errors, outputs, rollback = null) {
  const mem = config.memory || {};
  const title = task.title || task.id || 'task';
  try {
    if (mem.recordSessions !== false) {
      recordSession({
        taskId: task.id || 'task', title, result, cycles, maxCycles: MAX_CYCLES, goal: task.goal,
        engine: plan?.engine || task.engine || '-', verifyCmd: plan?.verifyCmd || task.verifyCmd || '-', verifySource: plan?.verifySource,
        verifySuggestion: plan?.verifySuggestion, planner: plan?.planSummary, rollback,
        subtasks: plan?.subtasks || task.subtasks || [], errors, outputs, finishedAt: new Date().toISOString()
      });
    }
    if (mem.autoLessons !== false && errors.length > 0 && !String(task.id || '').startsWith('self-test')) {
      const short = (s) => String(s).replace(/\s+/g, ' ').slice(0, 220);
      if (result === 'COMMITTED') remember(`"${title}": first attempt failed with "${short(errors[0])}" — passed after ${cycles} cycles. Check for this earlier next time.`, FILES.autoLessons);
      else remember(`"${title}": ${result} — last error "${short(errors[errors.length - 1])}". Needs a human decision before retrying.`, FILES.autoLessons);
    }
  } catch (e) { logTelemetry('MEMORY_WRITE_FAILED', e.message); }
}

// ───────────────────────────── queue + watcher ─────────────────────────────

function enqueue(file) {
  if (!file.endsWith('.json') || queued.has(file)) return;
  queued.add(file);
  queue.push(file);
  drain();
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const file = queue.shift();
      try { await executeSquareCycle(file); } finally { queued.delete(file); }
    }
  } finally {
    draining = false;
    if (!onceMode && !selfTestMode) setTimeout(() => !draining && writeState({ phase: 'IDLE_WATCHING', mode: 'SQUARE + SWARM', cycle: 0, workerSummary: 'Idle — waiting for the next task', activeLocks: [] }), 1500);
  }
}

const scanInbox = () => fs.readdirSync(DIRS.inbox).filter((f) => f.endsWith('.json')).sort().forEach((f) => enqueue(path.join(DIRS.inbox, f)));

function daemonAlive() {
  const pid = Number(fs.existsSync(FILES.pid) && fs.readFileSync(FILES.pid, 'utf8'));
  if (!pid || pid === process.pid) return 0;
  try { process.kill(pid, 0); return pid; } catch { return 0; }
}

// ───────────────────────────── entry point ─────────────────────────────

const args = process.argv.slice(2);
const selfTestMode = args.includes('--self-test');
const onceMode = args.includes('--once');

if (selfTestMode) {
  const testTaskFile = path.join(DIRS.inbox, 'self-test-swarm.json');
  const selfTest = {
    id: 'self-test-001',
    engine: 'antigravity',
    title: 'Antigravity & Orca Square + 2-Worker Swarm Self-Test',
    verifyCmd: 'node -e "const fs=require(\'fs\'); if(!fs.existsSync(\'.harness/state.json\')) process.exit(1);"',
    subtasks: [
      { id: 'antigravity-worker-1', engine: 'antigravity', targetFiles: ['src/module-a.lock'], cliCommand: 'node -e "console.log(\'Antigravity worker 1 executed\')"' },
      { id: 'orca-worker-2', engine: 'orca', targetFiles: ['src/module-b.lock'], cliCommand: 'node -e "console.log(\'Orca worker 2 executed\')"' }
    ]
  };
  const running = daemonAlive();
  if (running) {
    // A background daemon owns the inbox: hand the job to it and wait for the result.
    const before = new Set([...fs.readdirSync(DIRS.completed), ...fs.readdirSync(DIRS.failed)]);
    fs.writeFileSync(`${testTaskFile}.tmp`, JSON.stringify(selfTest, null, 2));
    fs.renameSync(`${testTaskFile}.tmp`, testTaskFile);
    console.log(`Background daemon (PID ${running}) is running — self-test handed to it. Waiting up to 60s…`);
    const deadline = Date.now() + 60000;
    const fresh = (dir) => fs.readdirSync(dir).some((f) => !before.has(f) && f.startsWith('self-test-001'));
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      if (fresh(DIRS.completed)) { console.log('SELF-TEST PASSED (processed by the background daemon).'); process.exit(0); }
      if (fresh(DIRS.failed)) break;
    }
    console.log('SELF-TEST FAILED — see .harness/telemetry.log'); process.exit(1);
  }
  fs.writeFileSync(testTaskFile, JSON.stringify(selfTest, null, 2));
  const ok = await executeSquareCycle(testTaskFile);
  if (process.env.HARNESS_SILENT !== '1') console.log(ok ? '\nSELF-TEST PASSED' : '\nSELF-TEST FAILED — see .harness/telemetry.log');
  process.exit(ok ? 0 : 1);
} else {
  const other = daemonAlive();
  if (other) {
    console.log(`Another harness daemon is already running for this folder (PID ${other}). Not starting a second one.`);
    process.exit(0);
  }
  fs.writeFileSync(FILES.pid, String(process.pid));
  const cleanup = () => { try { if (Number(fs.readFileSync(FILES.pid, 'utf8')) === process.pid) fs.rmSync(FILES.pid); } catch { /* ignore */ } };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));
  if (await isGitRepo()) await execFileAsync('git', ['worktree', 'prune'], { cwd: ROOT }).catch(() => {});

  // A backup left in staging/ means a task was interrupted (daemon killed mid-task). Do not
  // auto-restore (the user may have edited since) — tell them where it is.
  const leftovers = fs.readdirSync(DIRS.staging).filter((d) => fs.existsSync(path.join(DIRS.staging, d, 'manifest.json')));
  let history = [];
  if (leftovers.length) {
    history = leftovers.map((d) => `${new Date().toLocaleTimeString()}  ! interrupted task backup kept in .harness/staging/${d}/ (restore by hand if needed)`);
    logTelemetry('STAGING_LEFTOVER', 'Backups from interrupted tasks found', { dirs: leftovers });
  }
  let engine = '-';
  try { engine = resolveProfile(config).name.toUpperCase(); } catch { engine = 'NONE'; }
  writeState({
    phase: 'IDLE_WATCHING', mode: 'SQUARE + SWARM', cycle: 0, engine, history, planSummary: '-',
    taskTitle: '', workerSummary: 'Idle — Drop a task JSON into .harness/inbox/ to dispatch', lastGateStatus: 'READY'
  });
  logTelemetry('DAEMON_START', `Daemon started (PID ${process.pid})`, { root: ROOT });

  if (onceMode) {
    scanInbox();
    while (draining || queue.length) await new Promise((r) => setTimeout(r, 100));
    process.exit(0);
  }

  scanInbox();
  fs.watch(DIRS.inbox, (_event, filename) => {
    if (filename && filename.endsWith('.json')) setTimeout(() => {
      const full = path.join(DIRS.inbox, filename);
      if (fs.existsSync(full)) enqueue(full);
    }, 150);
  });
  setInterval(scanInbox, 3000).unref?.(); // fallback for file systems where fs.watch is unreliable
  setInterval(() => { if (!draining) writeState({}); }, 5000); // keep uptime + engine list fresh
}
