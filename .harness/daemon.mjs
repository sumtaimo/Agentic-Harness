#!/usr/bin/env node
/**
 * .harness/daemon.mjs
 * Unified Background Agentic Controller (Claude Code / Antigravity / Orca / Gemini / Codex)
 *
 *   Square loop:  1_PLANNER -> 2_EXECUTOR_SWARM -> 3_VERIFIER -> 4_COMMITTED
 *                 (verifier failure feeds its error back to the planner, max `maxCycles` times,
 *                  then HALTED_HITL_REQUIRED — a human must look)
 *   Swarm mesh:   several workers in parallel; a plan where two workers claim the same file is
 *                 rejected BEFORE any worker starts. Optional git-worktree isolation.
 *   Memory:       .harness/memory/* is injected into every worker prompt; every run is recorded.
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
  resolveProfile, memoryContext, recordSession, remember, listLessons
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
  if (p === 'HALTED_HITL_REQUIRED') return 'STOPPED: the AI could not pass the check. Read the newest note in .harness/memory/sessions/ and tell your AI what to change.';
  if (p === 'REJECTED') return 'REJECTED before start (see VERIFY line). Fix the task and dispatch it again.';
  if (p.startsWith('4')) return 'Done. The task passed the check. Drop or dispatch the next task.';
  if (p.startsWith('3')) return 'Checking the work with the verify command…';
  if (p.startsWith('2')) return 'AI workers are working. Their files are locked so they cannot collide.';
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

// ───────────────────────────── worker spawning ─────────────────────────────

function buildWorkerPrompt(subtask, profile, errorContext) {
  const memory = memoryContext(config);
  const scoped = (subtask.targetFiles || []).length > 0;
  return [
    `[HARNESS WORKER ID: ${subtask.id} | ENGINE: ${profile.name.toUpperCase()}]`,
    '[YOU ARE A HARNESS WORKER: do the task below directly. Do NOT dispatch new harness tasks.]',
    scoped
      ? `[SCOPED TARGET FILES: ${subtask.targetFiles.join(', ')}]\n[STRICT CONSTRAINT: Only modify your scoped target files. Do not touch unrelated files.]`
      : '[SCOPE: whole project — change only what the task needs.]',
    memory ? `[USER MEMORY — follow these preferences and rules]:\n${memory}` : '',
    errorContext ? `[PREVIOUS VERIFIER ERROR TO FIX]:\n${String(errorContext).slice(0, 6000)}` : '',
    `[TASK INSTRUCTIONS]:\n${subtask.prompt}`
  ].filter(Boolean).join('\n\n');
}

function buildArgs(profile, subtask, prompt) {
  const allowed = (subtask.allowedTools || profile.allowedTools || []).join(',');
  const args = [];
  let promptInArgs = false;
  for (const a of profile.args || []) {
    if (a === '{prompt}') { args.push(prompt); promptInArgs = true; continue; }
    args.push(a.replace('{allowedTools}', allowed));
  }
  const mcpFile = profile.mcpConfigPath && path.join(ROOT, profile.mcpConfigPath);
  if (profile.useMcp && mcpFile && fs.existsSync(mcpFile)) {
    args.push(...(profile.mcpArgs || []).map((a) => a.replace('{mcpConfig}', mcpFile)));
  }
  return { args, promptInArgs };
}

const winQuote = (a) => (/[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);

function spawnAgentWorker(subtask, cwd, errorContext) {
  return new Promise((resolve, reject) => {
    const timeoutMs = subtask.timeoutMs || config.workerTimeoutMs || 300000;
    const env = { ...process.env, HARNESS_WORKER: '1', HARNESS_WORKER_ID: subtask.id };

    // Plain shell command worker (no AI): used by the self-test and for scripted steps.
    if (subtask.cliCommand && !subtask.prompt) {
      exec(subtask.cliCommand, { cwd, env, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(`Worker ${subtask.id} command failed: ${(stderr || err.message).trim()}`));
        resolve({ id: subtask.id, engine: 'shell', output: stdout.trim() });
      });
      return;
    }

    let profile;
    try { profile = resolveProfile(config, subtask.engine); } catch (e) { return reject(e); }
    const binPath = which(profile.binary);
    if (!binPath) {
      return reject(Object.assign(new Error(
        `Engine '${profile.name}' is not installed (no '${profile.binary}' on PATH). Run task "Harness: Doctor" or choose another engine.`
      ), { fatal: true }));
    }

    const prompt = buildWorkerPrompt(subtask, profile, errorContext);
    const { args, promptInArgs } = buildArgs(profile, subtask, prompt);
    const isWin = process.platform === 'win32';
    const child = spawn(isWin ? winQuote(binPath) : binPath, isWin ? args.map(winQuote) : args, {
      cwd, env, shell: isWin, stdio: ['pipe', 'pipe', 'pipe']
    });
    logTelemetry('2_WORKER_SPAWN', `Spawned ${profile.name} worker ${subtask.id}`, {
      engine: profile.name, binary: binPath, args: args.map((a) => (a === prompt ? '<prompt>' : a)), cwd
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      done(reject, new Error(`Worker ${subtask.id} (${profile.name}) timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.stdin.on('error', () => {}); // engine may close stdin early
    if (!promptInArgs) child.stdin.write(prompt);
    child.stdin.end();

    child.on('error', (err) => done(reject, Object.assign(new Error(`Failed to spawn '${profile.binary}': ${err.message}`), { fatal: err.code === 'ENOENT' })));
    child.on('close', (code) => {
      if (code !== 0) return done(reject, new Error(`Worker ${subtask.id} (${profile.name}) exited with code ${code}: ${(stderr || stdout).trim().slice(0, 4000)}`));
      try { done(resolve, { id: subtask.id, engine: profile.name, output: summarizeOutput(stdout) }); } catch (e) { done(reject, e); }
    });
  });
}

/** Claude's --output-format json returns {result, is_error, ...}; other engines return text. */
function summarizeOutput(stdout) {
  const text = stdout.trim();
  try {
    const j = JSON.parse(text);
    if (j && typeof j === 'object' && 'result' in j) {
      if (j.is_error) throw Object.assign(new Error(`Engine reported an error: ${String(j.result).slice(0, 2000)}`));
      return String(j.result);
    }
  } catch (e) { if (e.message.startsWith('Engine reported')) throw e; }
  return text;
}

// ───────────────────────────── git helpers ─────────────────────────────

async function isGitRepo() {
  try { await execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: ROOT }); return true; } catch { return false; }
}

const inScope = (file, targets) => targets.length === 0 || targets.some((t) => {
  const norm = t.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  return file === norm || file.startsWith(norm + '/');
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

// ───────────────────────────── the 4 nodes ─────────────────────────────

const fatal = (msg) => Object.assign(new Error(msg), { fatal: true });

async function runPlanner(task, errorTrace = null) {
  const profile = (() => { try { return resolveProfile(config, task.engine); } catch { return { name: task.engine || 'unknown' }; } })();
  writeState({ phase: '1_PLANNER', engine: profile.name.toUpperCase(), taskTitle: task.title });
  logTelemetry('1_PLANNER', 'Validating task and checking file-lock boundaries', { engine: profile.name, errorTrace });

  const subtasks = Array.isArray(task.subtasks) && task.subtasks.length > 0
    ? task.subtasks
    : [{
        id: 'worker-primary',
        engine: task.engine,
        targetFiles: task.targetFiles || [],
        prompt: task.prompt || null,
        cliCommand: task.cliCommand || (task.prompt ? null : 'node -v')
      }];

  // Swarm Conflict Invariant: LockedFiles(A) ∩ LockedFiles(B) = ∅ for every pair of workers.
  const owner = new Map();
  for (const sub of subtasks) {
    sub.id = sub.id || `worker-${subtasks.indexOf(sub) + 1}`;
    sub.engine = sub.engine || task.engine;
    sub.targetFiles = sub.targetFiles || (sub.targetFile ? [sub.targetFile] : []);
    if (!sub.prompt && !sub.cliCommand) throw fatal(`Worker '${sub.id}' has neither a prompt nor a cliCommand.`);
    if (subtasks.length > 1 && sub.targetFiles.length === 0) {
      throw fatal(`Swarm Lock Collision: worker '${sub.id}' has no targetFiles, so it could touch any file. In a swarm every worker must own explicit files.`);
    }
    for (const f of sub.targetFiles) {
      const key = f.replace(/\\/g, '/').replace(/^\.\//, '');
      for (const [other, by] of owner) {
        if (by !== sub.id && (key === other || key.startsWith(other.replace(/\/$/, '') + '/') || other.startsWith(key.replace(/\/$/, '') + '/'))) {
          throw fatal(`Swarm Lock Collision: '${sub.id}' and '${by}' both claim '${key === other ? key : `${other}' / '${key}`}'. Plan rejected before any worker started.`);
        }
      }
      owner.set(key, sub.id);
    }
  }

  const mode = subtasks.length > 1 ? `SWARM-MESH (${subtasks.length}W)` : 'SQUARE-4-NODE';
  return {
    taskId: task.id || `job-${Date.now()}`,
    title: task.title || 'Unnamed Harness Task',
    engine: profile.name.toUpperCase(),
    mode,
    subtasks,
    verifyCmd: task.verifyCmd || config.defaultVerifyCmd,
    errorContext: errorTrace
  };
}

async function runExecutorSwarm(plan) {
  writeState({
    phase: '2_EXECUTOR_SWARM',
    mode: plan.mode,
    workerSummary: `Spawning ${plan.subtasks.length} worker(s): ${plan.subtasks.map((s) => s.id).join(', ')}`
  });
  logTelemetry('2_EXECUTOR', `Dispatching ${plan.subtasks.length} worker(s)`, { mode: plan.mode, engine: plan.engine });

  const useWorktrees = config.useGitWorktrees && plan.subtasks.some((s) => s.prompt);
  if (useWorktrees && !(await isGitRepo())) {
    throw fatal('useGitWorktrees is on, but this folder is not a git repository with at least one commit.');
  }

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
      const result = await spawnAgentWorker(sub, workerCwd, plan.errorContext);
      if (useWorktrees) result.sync = await syncWorktree(wtPath, sub);
      finished++;
      writeState({ workerSummary: `${finished}/${plan.subtasks.length} worker(s) finished (last: ${sub.id})` });
      return result;
    } finally {
      for (const f of sub.targetFiles) activeFileLocks.delete(f);
      if (useWorktrees && fs.existsSync(wtPath)) {
        await execFileAsync('git', ['worktree', 'remove', '--force', wtPath], { cwd: ROOT }).catch(() => {});
      }
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

async function runVerifier(plan) {
  writeState({ phase: '3_VERIFIER', lastGateStatus: `Running: ${plan.verifyCmd}` });
  logTelemetry('3_VERIFIER', `Executing verification command: ${plan.verifyCmd}`);
  try {
    const { stdout } = await execAsync(plan.verifyCmd, { cwd: ROOT, timeout: config.verifyTimeoutMs || 600000, maxBuffer: 32 * 1024 * 1024 });
    const cleanOut = (stdout || '').trim().split('\n')[0] || 'OK';
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

async function runCommitter(plan, taskFile) {
  let gitNote = '';
  if (config.autoGitCommit && (await isGitRepo())) {
    const scope = plan.subtasks.flatMap((s) => s.targetFiles);
    const paths = scope.length ? scope : ['.'];
    try {
      await execFileAsync('git', ['add', '-A', '--', ...paths, ':(exclude).harness'], { cwd: ROOT });
      const { stdout } = await execFileAsync('git', ['diff', '--cached', '--name-only'], { cwd: ROOT });
      if (stdout.trim()) {
        await execFileAsync('git', ['commit', '-m', `harness: ${plan.title}`, '-m', `Task ${plan.taskId}; verified by: ${plan.verifyCmd}`], { cwd: ROOT });
        gitNote = ' + git commit';
      }
    } catch (e) { logTelemetry('4_GIT_COMMIT_FAILED', e.message); gitNote = ' (git commit failed — see log)'; }
  }
  writeState({ phase: '4_COMMITTED', lastGateStatus: `COMMITTED: ${plan.taskId} verified & archived${gitNote}.` });
  logTelemetry('4_COMMITTER', 'Task passed all gates and committed', { taskId: plan.taskId, engine: plan.engine, verifyCmd: plan.verifyCmd });
  moveTask(taskFile, DIRS.completed);
}

function moveTask(taskFile, destDir, extra) {
  if (!fs.existsSync(taskFile)) return null;
  const dest = path.join(destDir, `${path.basename(taskFile, '.json')}-${Date.now()}.json`);
  if (extra) {
    const body = readJsonSafe(taskFile, { raw: fs.readFileSync(taskFile, 'utf8') });
    fs.writeFileSync(dest, JSON.stringify({ ...body, ...extra }, null, 2));
    fs.rmSync(taskFile);
  } else fs.renameSync(taskFile, dest);
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
    moveTask(taskFile, DIRS.failed, { haltReason: `Invalid JSON: ${e.message}` });
    writeState({ phase: 'REJECTED', taskTitle: path.basename(taskFile), lastGateStatus: `Invalid task JSON: ${e.message}` });
    logTelemetry('REJECTED', `Invalid task JSON in ${path.basename(taskFile)}`, { error: e.message });
    return false;
  }

  const errors = [];
  let lastPlan = null; let lastOutputs = []; let cycle = 1; let lastErrorTrace = null; let haltReason = null;
  const title = task.title || path.basename(taskFile);

  while (cycle <= MAX_CYCLES) {
    writeState({ cycle, taskId: task.id, taskTitle: title, lastGateStatus: cycle > 1 ? `Retrying with previous error (cycle ${cycle})` : 'Planning…' });
    try {
      const plan = await runPlanner(task, lastErrorTrace);
      lastPlan = plan;
      lastOutputs = await runExecutorSwarm(plan);
      const verification = await runVerifier(plan);
      if (verification.passed) {
        await runCommitter(plan, taskFile);
        finishSession(task, lastPlan, 'COMMITTED', cycle, errors, lastOutputs);
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
  const dest = moveTask(taskFile, DIRS.failed, { haltReason: reason, haltedAt: new Date().toISOString() });
  finishSession(task, lastPlan, phase, usedCycles, errors, lastOutputs);
  writeState({
    phase,
    lastGateStatus: haltReason ? `REJECTED: ${haltReason}` : `HALTED after ${MAX_CYCLES} cycles. Inspect .harness/telemetry.log`,
    history: pushHistory(`✖ ${phase}  ${title} → ${dest ? path.relative(ROOT, dest) : ''}`)
  });
  logTelemetry(phase, reason.slice(0, 4000), { taskId: task.id });
  return false;
}

function finishSession(task, plan, result, cycles, errors, outputs) {
  const mem = config.memory || {};
  const title = task.title || task.id || 'task';
  try {
    if (mem.recordSessions !== false) {
      recordSession({
        taskId: task.id || 'task', title, result, cycles, maxCycles: MAX_CYCLES,
        engine: plan?.engine || task.engine || '-', verifyCmd: plan?.verifyCmd || task.verifyCmd || config.defaultVerifyCmd,
        subtasks: plan?.subtasks || task.subtasks || [], errors, outputs, finishedAt: new Date().toISOString()
      });
    }
    if (mem.autoLessons !== false && errors.length > 0 && !task.id?.startsWith('self-test')) {
      const short = (s) => String(s).replace(/\s+/g, ' ').slice(0, 220);
      if (result === 'COMMITTED') {
        remember(`"${title}": first attempt failed with "${short(errors[0])}" — passed after ${cycles} cycles. Check for this earlier next time.`, FILES.autoLessons);
      } else {
        remember(`"${title}": ${result} — last error "${short(errors[errors.length - 1])}". Needs a human decision before retrying.`, FILES.autoLessons);
      }
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
    const before = new Set(fs.readdirSync(DIRS.completed));
    fs.writeFileSync(`${testTaskFile}.tmp`, JSON.stringify(selfTest, null, 2));
    fs.renameSync(`${testTaskFile}.tmp`, testTaskFile);
    console.log(`Background daemon (PID ${running}) is running — self-test handed to it. Waiting up to 60s…`);
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      if (fs.readdirSync(DIRS.completed).some((f) => !before.has(f) && f.startsWith('self-test-swarm'))) {
        console.log('SELF-TEST PASSED (processed by the background daemon).'); process.exit(0);
      }
      if (fs.readdirSync(DIRS.failed).some((f) => f.startsWith('self-test-swarm'))) break;
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

  writeState({
    phase: 'IDLE_WATCHING', mode: 'SQUARE + SWARM', cycle: 0,
    engine: (() => { try { return resolveProfile(config).name.toUpperCase(); } catch { return '-'; } })(),
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
