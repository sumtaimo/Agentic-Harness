#!/usr/bin/env node
/**
 * .harness/daemon.mjs
 * Unified Background Agentic Controller (Claude Code / Antigravity / Codex)
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
import crypto from 'node:crypto';
import path from 'node:path';
import { exec, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  ROOT, DIRS, FILES, ensureDirs, loadConfig, atomicWriteJson, readJsonSafe, which,
  resolveProfile, memoryContext, recordSession, remember, listLessons, detectVerifyCmd,
  listProjectFiles, safeTarget,
  winQuote, winCommandLine, chooseModelTier, resolveModel, pendingCostReasons, loadApprovals, engineUsable,
} from './lib/common.mjs';

// Autonomous work never moves up to the high (most expensive) tier without the person's OK:
// set while an autonomous task or the PO_ARCHITECT runs, unless that task was approved or "high-model" is always allowed.
let autoTierCap = false;
const highAlwaysAllowed = () => (loadApprovals().alwaysAllow || []).includes('high-model');
import {
  readCharter, loadRoles, loadSkills, matchSkills, computeAllowedTools, computeDisallowedTools,
  matchesAny, withinAll, skillRulesNotGranted, readBacklog, writeBacklog, updateBacklogItem, nextReady, backlogCounts, itemToJob,
  loadTeam, validateTeam
} from './lib/governance.mjs';
import {
  isRepoWithCommits, branchSha, ensureBranch, protectedShas, ensureWorkerWorktree, commitScoped,
  buildCandidate, advanceBranch, removeWorktree, deleteBranch, safeRef
} from './lib/integration.mjs';

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
let lastFinished = null; // { autonomous, backlogId, title, ok } of the last job

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

/** Plain-text live feed (no colours) that anything can follow: `tail -f`, the editor chat's Monitor, watch.mjs. */
function liveLog(line) {
  try { fs.appendFileSync(FILES.live, `${new Date().toISOString().slice(11, 19)} ${String(line).replace(/\x1b\[[0-9;]*m/g, '')}\n`); } catch { /* feed is best effort */ }
}

function logTelemetry(phase, message, meta = {}) {
  const entry = JSON.stringify({ ts: new Date().toISOString(), phase, message, ...meta });
  fs.appendFileSync(FILES.log, entry + '\n');
}

// ───────────────────────────── 4-corner live HUD ─────────────────────────────

const W = 76;
let lastCompact = '';
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
  if ((s.autonomous || {}).paused) return `Autonomous mode PAUSED: ${s.autonomous.paused}. Fix it, then restart the controller.`;
  if (p.startsWith('3')) return 'Checking the work with the verify command…';
  if (p.startsWith('2')) return 'AI workers are working. Their files are locked so they cannot collide.';
  if (p === '0_PO_ARCHITECT') return 'Acting as PO_ARCHITECT: reading charter.md and writing the next backlog tasks…';
  if (p === '1_AI_PLANNER') return 'The AI planner is splitting your goal into parallel workers…';
  if (p.startsWith('1')) return 'Reading the task and checking which files each worker owns…';
  return 'Ready. Run task "Harness: 2. New task" (Ctrl/Cmd+Shift+P > Run Task) or ask your AI chat.';
}

const engineList = () => Object.entries(config.profiles)
  .map(([k, p]) => `${k.toUpperCase()}${which(p.binary) ? '✓' : '·'}`).join(' ');

function renderHUD(s) {
  if (process.env.HARNESS_SILENT === '1') return;
  const p = s.phase || 'IDLE';
  // Non-TTY logs, or a task running with live agent output: one line per change instead of a redraw,
  // so the agents' streamed activity stays readable on screen.
  if (!process.stdout.isTTY || (liveOn() && draining)) {
    const line = `${p} | ${s.engine || '-'} | cycle ${s.cycle || 0}/${MAX_CYCLES} | ${s.taskTitle || ''} | ${s.workerSummary || ''} | ${s.lastGateStatus || ''}`;
    if (line !== lastCompact) { lastCompact = line; liveLog(`[harness] ${line}`); console.log(`${process.stdout.isTTY ? C.bold : ''}[harness]${process.stdout.isTTY ? C.reset : ''} ${line}`); }
    return;
  }
  const color = p.startsWith('HALT') || p.includes('FAIL') || p === 'REJECTED' ? C.red
    : p.startsWith('4') || p.startsWith('3_VERIFIED') ? C.green
      : p.startsWith('IDLE') ? C.cyan : C.yellow;
  const taught = listLessons(FILES.lessons).length;
  const autoL = listLessons(FILES.autoLessons).length;
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
    row(`QUEUE:   ${queue.length} waiting  |  MEMORY: ${taught} taught rule(s), ${autoL} auto lesson(s)`),
    row(`AUTO:    ${s.autoStatus || 'off'}`),
    row(`GIT:     ${s.gitSummary || ((config.git || {}).integrationBranch && (config.git || {}).integrationMode !== 'off' ? `${config.git.integrationBranch} for ${config.git.integrationMode === 'always' ? 'every task' : 'autonomous tasks'}; other tasks edit your folder` : 'tasks edit your working folder')}`),
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

/**
 * Build the engine command line. The prompt is delivered according to profile.promptVia:
 *   "stdin" (default) — piped to the engine's standard input (robust: no flag can swallow it)
 *   "arg"             — substituted where "{prompt}" appears in args
 *   "after--"         — appended after a "--" separator
 */
/** Live agent output in the terminal: HARNESS_LIVE=1/0 overrides config.liveAgentOutput (default on). */
const liveOn = () => (process.env.HARNESS_LIVE === '1' ? true : process.env.HARNESS_LIVE === '0' ? false : config.liveAgentOutput !== false);

function buildArgs(profile, prompt, allowedTools, disallowedTools = [], stream = false, model = null) {
  const allowed = (allowedTools || profile.allowedTools || []).join(',');
  const disallowed = (disallowedTools || []).join(',');
  const via = profile.promptVia || ((profile.args || []).includes('{prompt}') ? 'arg' : 'stdin');
  const args = [];
  for (const a of profile.args || []) {
    if (a === '{prompt}') { if (via === 'arg') args.push(prompt); continue; }
    if (a === '{output}') { args.push(...((stream ? profile.output?.stream : profile.output?.batch) || [])); continue; }
    const v = a.replace('{allowedTools}', allowed).replace('{disallowedTools}', disallowed);
    // A placeholder that expands to nothing drops itself AND the flag before it (e.g. "--disallowedTools" "").
    if (v === '' && a !== '' && /^-/.test(args[args.length - 1] || '')) { args.pop(); continue; }
    args.push(v);
  }
  // Model tier: only when the tier maps to an alias; otherwise no flag, so the CLI uses its own newest default.
  // "name@effort" (e.g. a codex model with "@low") also fills {effort}; without an effort, an {effort} arg and its flag are dropped.
  if (model && Array.isArray(profile.modelArgs)) {
    const [name, effort] = String(model).split('@');
    for (const a of profile.modelArgs) {
      if (a.includes('{effort}') && !effort) { if (/^-/.test(args[args.length - 1] || '')) args.pop(); continue; }
      args.push(a.replace('{model}', name).replace('{effort}', effort || ''));
    }
  }
  const mcpFile = profile.mcpConfigPath && path.join(ROOT, profile.mcpConfigPath);
  if (profile.useMcp && mcpFile && fs.existsSync(mcpFile)) {
    args.push(...(profile.mcpArgs || []).map((a) => a.replace('{mcpConfig}', mcpFile)));
  }
  if (via === 'after--') args.push('--', prompt);
  return { args, viaStdin: via === 'stdin' };
}

// ── live rendering of agent activity (stream-json events → one readable line each) ──
const LIVE_COLORS = ['\x1b[36m', '\x1b[35m', '\x1b[33m', '\x1b[32m', '\x1b[34m', '\x1b[91m'];
const liveColor = new Map();
function livePrint(id, text) {
  if (!liveColor.has(id)) liveColor.set(id, LIVE_COLORS[liveColor.size % LIVE_COLORS.length]);
  const tty = process.stdout.isTTY;
  const label = `[${id}]`.padEnd(18);
  liveLog(`  ${label} ${text}`);
  process.stdout.write(`${tty ? liveColor.get(id) : ''}  ${label}${tty ? '\x1b[0m' : ''} ${text}\n`);
}
const oneLine = (t, n = 160) => { const x = String(t ?? '').replace(/\s+/g, ' ').trim(); return x.length > n ? `${x.slice(0, n - 1)}…` : x; };
function toolLabel(c, cwd) {
  const i = c.input || {};
  const p = i.file_path || i.notebook_path || i.path;
  const rel = p ? (path.isAbsolute(p) ? path.relative(cwd, p) || '.' : p).split(path.sep).join('/') : '';
  const what = rel || (i.command ? `$ ${i.command}` : '') || i.pattern || i.url || i.description || '';
  return `${c.name}${what ? ` ${oneLine(what, 120)}` : ''}`;
}
function renderStreamEvent(id, ev, cwd) {
  if (ev.type === 'system' && ev.subtype === 'init') livePrint(id, `▶ agent started${ev.model ? ` (${ev.model})` : ''} in ${path.relative(ROOT, cwd) || '.'}`);
  else if (ev.type === 'assistant') {
    for (const c of ev.message?.content || []) {
      if (c.type === 'text' && c.text.trim()) livePrint(id, `💬 ${oneLine(c.text)}`);
      else if (c.type === 'tool_use') livePrint(id, `🔧 ${toolLabel(c, cwd)}`);
    }
  } else if (ev.type === 'user') {
    for (const c of ev.message?.content || []) {
      if (c.type === 'tool_result' && c.is_error) {
        const t = Array.isArray(c.content) ? c.content.map((x) => x.text || '').join(' ') : c.content;
        livePrint(id, `⚠ ${oneLine(t, 140)}`);
      }
    }
  } else if (ev.type === 'result') {
    const denied = (ev.permission_denials || []).map((d) => oneLine(`${d.tool_name} ${d.tool_input?.file_path ? path.relative(cwd, d.tool_input.file_path).split(path.sep).join('/') : d.tool_input?.command || ''}`, 90));
    livePrint(id, `${ev.is_error ? '✖ failed' : '✔ finished'}${ev.duration_ms ? ` in ${(ev.duration_ms / 1000).toFixed(1)}s` : ''}${ev.total_cost_usd ? ` · $${ev.total_cost_usd.toFixed(3)}` : ''}${denied.length ? ` · ⛔ denied: ${denied.join(', ')}` : ''}`);
  }
}

/**
 * config.dailyLimits = { <engine>: { calls?, tokens?, usd? } }: today's (UTC) AGENT_USAGE for that engine is summed from the
 * log; returns a short reason when a cap is reached (the agent is then not started), else null. No entry = no cap.
 */
function dailyLimitReached(engine) {
  const cap = (config.dailyLimits || {})[engine];
  if (!cap || typeof cap !== 'object') return null;
  const day = new Date().toISOString().slice(0, 10);
  let calls = 0; let tokens = 0; let usd = 0;
  try {
    for (const line of fs.readFileSync(FILES.log, 'utf8').split('\n')) {
      if (!line.includes('"AGENT_USAGE"') || !line.startsWith(`{"ts":"${day}`)) continue;
      const e = JSON.parse(line); if (e.engine !== engine) continue;
      calls++; tokens += Number(e.tokens) || 0; usd += Number(e.usd) || 0;
    }
  } catch { return null; }
  if (typeof cap.calls === 'number' && calls >= cap.calls) return `${calls}/${cap.calls} calls today`;
  if (typeof cap.tokens === 'number' && tokens >= cap.tokens) return `${tokens}/${cap.tokens} tokens today`;
  if (typeof cap.usd === 'number' && usd >= cap.usd) return `${usd.toFixed(2)}/${cap.usd} today`;
  return null;
}

/** Usage / quota limits only (not login problems): the account is fine, it is just out of quota for now. */
const QUOTA_LIMIT_RE = /hit your .{0,40}limit|session limit|usage limit|quota (exceeded|exhausted)|rate.?limit|resource.?exhausted|credit balance/i;

/**
 * Spawn an AI engine; if it stops on a usage/quota limit and config.quotaFallback names another engine for it
 * (e.g. claude → antigravity, using agy's Claude models), the same agent retries ONCE there, on the model for the
 * same tier. Only an engine the person already allowed is used. Shown live and logged as QUOTA_FALLBACK.
 */
function spawnEngine(opts) {
  return spawnEngineOnce(opts).catch((e) => {
    const fb = e.quotaLimit && !opts.noQuotaFallback ? (config.quotaFallback || {})[e.engineName] : null;
    if (!fb || !fb.engine || fb.engine === e.engineName) throw e;
    const u = engineUsable(config, fb.engine);
    if (!u.ok) {
      logTelemetry('QUOTA_FALLBACK_UNAVAILABLE', `${opts.id}: ${e.engineName} hit its usage limit, and ${fb.engine} cannot take over: ${u.why}`, { worker: opts.id });
      throw e;
    }
    const model = fb.models?.[e.tierUsed] || null;
    logTelemetry('QUOTA_FALLBACK', `${opts.id}: ${e.engineName} hit its usage limit → retrying on ${fb.engine}${model ? ` (${model})` : ''}`, { worker: opts.id, from: e.engineName, to: fb.engine, tier: e.tierUsed, model });
    if (liveOn()) livePrint(opts.id, `⇄ ${e.engineName} usage limit → continuing on ${fb.engine}${model ? ` (${model})` : ''}`);
    writeState({ history: pushHistory(`⇄ ${e.engineName} limit → ${fb.engine} for ${opts.id}`) });
    return spawnEngineOnce({ ...opts, engine: fb.engine, model: model || opts.model || null, noQuotaFallback: true });
  });
}

/** Spawn an AI engine with a prompt. Resolves { engine, output, denials }. Streams activity live when enabled. */
function spawnEngineOnce({ id, engine, prompt, cwd, timeoutMs, allowedTools, disallowedTools, tier = null, model: modelOverride = null }) {
  return new Promise((resolve, reject) => {
    let profile;
    try { profile = resolveProfile(config, engine); } catch (e) { return reject(e); }
    let t = tier || { tier: 'medium', reasons: ['no complexity info'] };
    if (autoTierCap && t.tier === 'high' && !modelOverride) {
      t = { tier: 'medium', reasons: [...(t.reasons || []), 'capped high → medium: autonomous run, the high model needs your OK (node .harness/backlog.mjs approve <id>)'] };
      logTelemetry('AUTO_TIER_CAPPED', `${id}: high tier capped to medium (autonomous; high model not approved)`, { worker: id });
    }
    const pick = resolveModel(profile, { tier: t.tier, override: modelOverride });
    const over = dailyLimitReached(profile.name);
    if (over) {
      logTelemetry('DAILY_LIMIT', `${id}: ${profile.name} reached its daily cap (${over}); not started`, { worker: id, engine: profile.name });
      return reject(Object.assign(new Error(`${id} (${profile.name}): daily cap reached (${over}). It resets tomorrow (UTC); raise "dailyLimits" in config.json only if you accept the use.`), { fatal: true, engineName: profile.name, tierUsed: pick.tier, quotaLimit: true }));
    }
    const startedAt = Date.now();
    logTelemetry('MODEL_TIER', `${id}: ${pick.tier} tier → ${pick.model || `${profile.name} default (no --model)`}${pick.source === 'auto' ? '' : ` (${pick.source})`}`, { worker: id, engine: profile.name, tier: pick.tier, model: pick.model, source: pick.source, reasons: t.reasons });
    if (profile.fallbackFrom) {
      logTelemetry('ENGINE_FALLBACK', `Engine '${profile.fallbackFrom}' unavailable (${profile.fallbackReason}); using '${profile.name}'`, { worker: id });
      writeState({ engine: profile.name.toUpperCase(), history: pushHistory(`! ${profile.fallbackFrom} unavailable → using ${profile.name}`) });
    }
    const live = liveOn();
    const stream = live && Array.isArray(profile.output?.stream);
    const binPath = which(profile.binary);
    const { args, viaStdin } = buildArgs(profile, prompt, allowedTools, disallowedTools, stream, pick.model);
    const isWin = process.platform === 'win32';
    const env = { ...process.env, HARNESS_WORKER: '1', HARNESS_WORKER_ID: id };
    const child = isWin
      ? spawn(winCommandLine(binPath, args), { cwd, env, shell: true, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(binPath, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    logTelemetry('ENGINE_SPAWN', `Spawned ${profile.name} for ${id}`, { engine: profile.name, binary: binPath, args: args.map((a) => (a === prompt ? '<prompt>' : a)), promptVia: viaStdin ? 'stdin' : 'args', live: live ? (stream ? 'stream-json' : 'raw') : 'off', cwd });
    if (live && !stream) livePrint(id, `▶ ${profile.name} started on ${pick.model || "the CLI's default model (no model names set)"} [${pick.tier}] (raw output follows)`);

    let stdout = ''; let stderr = ''; let settled = false; let pending = '';
    const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
    const ms = timeoutMs || config.workerTimeoutMs || 300000;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      done(reject, new Error(`${id} (${profile.name}) timed out after ${ms}ms`));
    }, ms);

    child.stdout.on('data', (c) => {
      const chunk = c.toString(); stdout += chunk;
      if (!live) return;
      pending += chunk;
      const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        if (stream) { try { renderStreamEvent(id, JSON.parse(line), cwd); } catch { livePrint(id, oneLine(line)); } } else livePrint(id, oneLine(line, 200));
      }
    });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.stdin.on('error', () => {}); // engine may close stdin early
    if (viaStdin) child.stdin.write(prompt);
    child.stdin.end();

    child.on('error', (err) => done(reject, Object.assign(new Error(`Failed to start '${profile.binary}': ${err.message}`), { fatal: err.code === 'ENOENT' })));
    child.on('close', (code) => {
      let usage = null; try { usage = summarizeOutput(stdout); } catch { /* error output: no usage */ }
      logTelemetry('AGENT_USAGE', `${id}: ${profile.name} ${pick.model || 'default'} [${pick.tier}] ${code === 0 ? 'ok' : `exit ${code}`}`, { worker: id, engine: profile.name, model: pick.model, tier: pick.tier, ok: code === 0, tokens: usage?.tokens ?? null, usd: usage?.cost || 0, ms: Date.now() - startedAt });
      if (live && pending.trim() && !stream) livePrint(id, oneLine(pending, 200));
      if (code !== 0) {
        // The engine's own error (e.g. Claude's JSON {"is_error":true,"result":"You've hit your limit"}) is on stdout;
        // stderr may only hold unrelated warnings, so prefer the engine's message when there is one.
        try { summarizeOutput(stdout); } catch (e) {
          if (e.engineError) return done(reject, Object.assign(new Error(`${id} (${profile.name}) exited with code ${code}: ${e.message}`), { fatal: e.fatal, engineName: profile.name, tierUsed: pick.tier, quotaLimit: QUOTA_LIMIT_RE.test(e.message) }));
        }
        const raw = `${stderr}\n${stdout}`.trim();
        const fatal = engineErrorIsFatal(raw);
        return done(reject, Object.assign(new Error(`${id} (${profile.name}) exited with code ${code}: ${(stderr || stdout).trim().slice(0, 4000)}${fatal ? ' (account/login problem: retrying cannot fix it)' : ''}`), { fatal, engineName: profile.name, tierUsed: pick.tier, quotaLimit: QUOTA_LIMIT_RE.test(raw) }));
      }
      try {
        const r = summarizeOutput(stdout);
        if (r.denials.length) logTelemetry('PERMISSION_DENIED', `${id}: engine denied ${r.denials.length} action(s) outside its role`, { worker: id, denials: r.denials });
        trackCost(id, r.cost);
        done(resolve, { engine: profile.name, output: r.text, denials: r.denials, costUsd: r.cost });
      } catch (e) { done(reject, e); }
    });
  });
}

/**
 * Engine output → { text, denials }.
 *  - Claude --output-format json: one object {result, is_error, permission_denials}
 *  - Claude --output-format stream-json: JSON lines; the last {"type":"result"} line carries the same fields
 *  - other engines: plain text
 */
/**
 * Account-level engine errors that retrying (or a stronger model) cannot fix: usage/quota limits, not logged in,
 * bad credentials. They stop the task at once with the engine's own message instead of burning 3 cycles.
 */
function engineErrorIsFatal(text, status) {
  if ([401, 402, 403, 429].includes(Number(status))) return true;
  return /hit your .{0,40}limit|usage limit|quota (exceeded|exhausted)|rate.?limit|resource.?exhausted|credit balance|not logged in|please (run .{0,30})?log ?in|login required|unauthori[sz]ed|authentication (failed|required|error)|invalid api key/i.test(String(text || ''));
}

function summarizeOutput(stdout) {
  const text = stdout.trim();
  let j = null;
  try { j = JSON.parse(text); } catch {
    const lines = text.split('\n').filter((l) => l.trim().startsWith('{'));
    for (let i = lines.length - 1; i >= 0 && !j; i--) { try { const o = JSON.parse(lines[i]); if (o.type === 'result') j = o; } catch { /* not JSON */ } }
  }
  if (j && typeof j === 'object' && 'result' in j) {
    if (j.is_error) {
      const msg = String(j.result).slice(0, 2000);
      throw Object.assign(new Error(`Engine reported an error: ${msg}`), { fatal: engineErrorIsFatal(msg, j.api_error_status), engineError: true });
    }
    const denials = (j.permission_denials || []).map((d) => ({ tool: d.tool_name, target: d.tool_input?.file_path || d.tool_input?.command || '' }));
    const u = j.usage || {};
    const tokens = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].reduce((n, k) => n + (Number(u[k]) || 0), 0) || null;
    return { text: String(j.result), denials, cost: Number(j.total_cost_usd) || 0, tokens };
  }
  return { text, denials: [], cost: 0, tokens: null };
}

// ── cost accounting + budget guardrails (deterministic: the controller counts, the agent cannot) ──
const taskCost = { usd: 0, agents: {} };
const resetCost = () => { taskCost.usd = 0; taskCost.agents = {}; };
function trackCost(id, usd) {
  const c = Number(usd) || 0;
  taskCost.usd += c; taskCost.agents[id] = (taskCost.agents[id] || 0) + c;
  if (c > 0) logTelemetry('AGENT_COST', `${id}: $${c.toFixed(4)} (task total $${taskCost.usd.toFixed(4)})`, { agent: id, usd: c, total: taskCost.usd });
  writeState({ costUsd: Math.round(taskCost.usd * 10000) / 10000 });
}
/** Cost cap for a task: its own maxCostUsd, else (hierarchy) the orchestrator's budget, else config.budget.maxTaskCostUsd. */
function budgetCap(task) {
  if (typeof task.maxCostUsd === 'number') return task.maxCostUsd;
  if (task.hierarchy) { const o = (loadTeam()?.members || []).find((m) => m.level === 'orchestrator'); if (typeof o?.budget?.maxCostUsd === 'number') return o.budget.maxCostUsd; }
  return typeof config.budget?.maxTaskCostUsd === 'number' ? config.budget.maxTaskCostUsd : null;
}
function enforceBudget(task, where) {
  const cap = budgetCap(task);
  if (cap !== null && taskCost.usd > cap + 1e-9) {
    logTelemetry('BUDGET_EXCEEDED', `Task spent $${taskCost.usd.toFixed(4)} > cap $${cap} after ${where}`, { cap, spent: taskCost.usd, agents: taskCost.agents });
    throw fatal(`BUDGET_EXCEEDED: the task has spent $${taskCost.usd.toFixed(3)} against its cap of $${cap} (after ${where}). The controller stopped it; raise "maxCostUsd" only if you accept the cost.`);
  }
}

/** Which memory parts the engine already loads itself (e.g. CLAUDE.md "@.harness/memory/lessons.md"). */
function autoLoadedMemory(profile, cwd) {
  if (!profile.instructionFile || config.useGitWorktrees || path.resolve(cwd) !== ROOT) return []; // worktrees see the last commit, maybe stale
  let text = '';
  try { text = fs.readFileSync(path.join(cwd, profile.instructionFile), 'utf8'); } catch { return []; }
  const skip = [];
  if (/^@\.harness\/memory\/profile\.md\s*$/m.test(text)) skip.push('profile');
  if (/^@\.harness\/memory\/lessons\.md\s*$/m.test(text)) skip.push('lessons');
  return skip;
}

function buildWorkerPrompt(subtask, profileName, cwd, errorContext, gov = {}) {
  let skip = [];
  try { skip = autoLoadedMemory(config.profiles[profileName] || {}, cwd); } catch { /* inject everything */ }
  const memory = memoryContext(config, { skip });
  const scoped = (subtask.targetFiles || []).length > 0;
  const role = gov.role;
  const ac = subtask.acceptanceCriteria;
  return [
    `[HARNESS WORKER ID: ${subtask.id} | ENGINE: ${String(profileName).toUpperCase()}${role ? ` | ROLE: ${role.name}` : ''}]`,
    '[YOU ARE A HARNESS WORKER: do the task below directly. Do NOT dispatch new harness tasks.]',
    role ? `[ROLE PERSONA — ${role.name}]:\n${role.mission || role.description || ''}` : '',
    scoped
      ? `[SCOPED TARGET FILES: ${subtask.targetFiles.join(', ')}]\n[STRICT CONSTRAINT: Only modify your scoped target files. Do not touch unrelated files.${role ? ' Your engine permissions are limited to these paths; other edits will be denied.' : ''}]`
      : '[SCOPE: whole project — change only what the task needs.]',
    gov.skills?.length ? `[INJECTED SKILL CONTRACTS — mandatory rules for this task]:\n${gov.skills.map((s) => `### Skill: ${s.name}\n${s.body}`).join('\n\n')}` : '',
    memory ? `[USER MEMORY — follow these preferences and rules]:\n${memory}` : '',
    subtask.goal ? `[OVERALL GOAL (other workers handle the other parts in parallel)]:\n${subtask.goal}` : '',
    subtask.interfaceContract ? `[SHARED INTERFACE CONTRACT — other workers build against exactly this; do not deviate]:\n${subtask.interfaceContract}` : '',
    Array.isArray(ac) && ac.length ? `[ACCEPTANCE CRITERIA]:\n${ac.map((c) => `- ${c}`).join('\n')}` : '',
    errorContext ? `[PREVIOUS VERIFIER ERROR TO FIX]:\n${String(errorContext).slice(0, 6000)}` : '',
    `[TASK INSTRUCTIONS]:\n${subtask.prompt}`
  ].filter(Boolean).join('\n\n');
}

/**
 * Node 1 helper: attach role persona, matched skills and the engine tool lists to a subtask.
 * Writes resolvedRole / resolvedSkills / resolvedTools / deniedTools (kept in the job archive = audit trail).
 */
function resolveGovernance(sub, gov) {
  const roleName = sub.role ? String(sub.role).toUpperCase() : null;
  const role = roleName ? gov.roles[roleName] : null;
  const m = matchSkills(sub, roleName || 'NONE', gov.skills);
  if (m.unknown.length) throw fatal(`Worker '${sub.id}' asks for unknown skill(s): ${m.unknown.join(', ')} (installed: ${Object.keys(gov.skills).join(', ') || 'none'}).`);
  if (m.mismatched.length) logTelemetry('SKILL_ROLE_MISMATCH', `Skill(s) ${m.mismatched.join(', ')} not allowed for role ${roleName || '(none)'}; not injected`, { worker: sub.id });
  sub.resolvedRole = role ? role.name : null;
  sub.resolvedSkills = m.chosen.map((s) => s.name);
  sub.resolvedTools = role ? computeAllowedTools(role, m.chosen, sub.targetFiles) : (sub.allowedTools || null);
  if (role) {
    const notGranted = skillRulesNotGranted(role, m.chosen);
    if (notGranted.length) logTelemetry('SKILL_RULE_NOT_GRANTED', `${sub.id}: skill asked for tools the role ${role.name} does not allow: ${notGranted.join('; ')}`, { worker: sub.id, notGranted });
  }
  sub.deniedTools = computeDisallowedTools(gov.charter);
  if (role || m.chosen.length) {
    logTelemetry('1_ROLE_SKILL_MATCH', `${sub.id}: role ${sub.resolvedRole || '-'}, skills [${sub.resolvedSkills.join(', ')}]`, { worker: sub.id, role: sub.resolvedRole, skills: sub.resolvedSkills, allowedTools: sub.resolvedTools });
  }
  return sub;
}

function runWorker(subtask, cwd, errorContext, { cycle = 1, model = null } = {}) {
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
  const roles = loadRoles(); const skills = loadSkills();
  const gov = {
    role: subtask.resolvedRole ? roles[subtask.resolvedRole] : null,
    skills: (subtask.resolvedSkills || []).map((n) => skills[n]).filter(Boolean)
  };
  const prompt = buildWorkerPrompt(subtask, profileName, cwd, errorContext, gov);
  return spawnEngine({
    id: subtask.id, engine: subtask.engine, prompt, cwd, timeoutMs,
    allowedTools: subtask.resolvedTools || subtask.allowedTools, disallowedTools: subtask.deniedTools,
    // complexity is judged on the task itself (files, its own prompt, role, retry), not on the harness boilerplate around it
    tier: chooseModelTier({ kind: 'work', role: subtask.resolvedRole || subtask.role, targetFiles: subtask.targetFiles || [], prompt: subtask.prompt || '', cycle }),
    model: model || subtask.model || null
  }).then((r) => ({ id: subtask.id, role: subtask.resolvedRole, ...r }));
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

// ───────────────────────────── git integration branch (e.g. uat) ─────────────────────────────

/** Which integration branch a task uses (null = classic in-place mode). */
function integrationFor(task) {
  const g = config.git || {};
  if (task.integrationBranch) return task.integrationBranch;
  const mode = g.integrationMode || 'off';
  if (!g.integrationBranch || mode === 'off') return null;
  if (mode === 'autonomous' && !task.autonomous) return null;
  return g.integrationBranch;
}

async function startIntegration(task, branch) {
  const g = config.git || {};
  if (!(await isRepoWithCommits(ROOT))) throw fatal(`Integration branch '${branch}' needs a git repository with at least one commit (run: git init && git add -A && git commit -m start).`);
  const protectedList = g.protectedBranches || ['main', 'master'];
  if (protectedList.includes(branch)) throw fatal(`Refusing to integrate into protected branch '${branch}' (git.protectedBranches). Use an integration branch such as 'uat'.`);
  const created = await ensureBranch(branch, g.integrationBase || 'HEAD', ROOT);
  if (created) logTelemetry('GIT_BRANCH_CREATED', `Created integration branch '${branch}' from ${g.integrationBase || 'HEAD'}`);
  const baseSha = await branchSha(branch, ROOT);
  const tag = safeRef(task.id || `job-${Date.now()}`);
  const ctx = {
    branch, baseSha, tag, link: g.linkIntoWorktrees || ['node_modules'],
    dir: path.join(DIRS.worktrees, tag), workers: {}, protectedBefore: await protectedShas(protectedList, ROOT), mergedSha: null
  };
  ctx.intPath = path.join(ctx.dir, '_integration');
  logTelemetry('GIT_INTEGRATION', `Workers branch from '${branch}' @ ${baseSha.slice(0, 8)}; candidate is verified before '${branch}' moves`, { branch, baseSha, protected: ctx.protectedBefore });
  writeState({ gitSummary: `${branch} @ ${baseSha.slice(0, 8)} ← harness/${tag}/* (your folder + ${protectedList.join('/')} untouched)` });
  return ctx;
}

async function finishIntegration(ctx, ok) {
  if (!ctx) return null;
  const keep = !ok && (config.git || {}).keepFailedBranches !== false;
  for (const w of Object.values(ctx.workers)) {
    await removeWorktree(w.path, ROOT);
    if (!keep) await deleteBranch(w.branch, ROOT);
  }
  await removeWorktree(ctx.intPath, ROOT);
  try { fs.rmSync(ctx.dir, { recursive: true, force: true }); } catch { /* ignore */ }
  const after = await protectedShas(Object.keys(ctx.protectedBefore), ROOT);
  const changed = Object.keys(after).filter((b) => after[b] !== ctx.protectedBefore[b]);
  if (changed.length) logTelemetry('PROTECTED_BRANCH_CHANGED', `WARNING: ${changed.join(', ')} moved during the task (not by the harness merge path)`, { before: ctx.protectedBefore, after });
  else logTelemetry('PROTECTED_BRANCHES_UNCHANGED', `${Object.keys(after).filter((b) => after[b]).join(', ') || '(none exist)'} unchanged`, { shas: after });
  return {
    branch: ctx.branch, baseSha: ctx.baseSha, mergedSha: ctx.mergedSha, protectedUnchanged: changed.length === 0,
    workerBranches: Object.values(ctx.workers).map((w) => w.branch), keptBranches: keep
  };
}

// ───────────────────────────── Node 1: planner ─────────────────────────────

/**
 * Validate subtasks: safe paths, unique ids, and the Swarm Conflict Invariant
 *   LockedFiles(A) ∩ LockedFiles(B) = ∅  (a folder also conflicts with any file inside it).
 */
function validateSubtasks(subtasks, { source = 'task', allowed = [], requireScope = false, gov = null, autonomous = false } = {}) {
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
    if (gov) { // v2 governance: charter + role write-scopes
      const forbidden = sub.targetFiles.filter((f) => matchesAny(f, gov.charter.forbiddenPaths));
      if (forbidden.length) throw fatal(`${source}: worker '${sub.id}' targets ${forbidden.join(', ')}, which charter.md forbids (forbiddenPaths: ${gov.charter.forbiddenPaths.join(', ')}).`);
      if (autonomous && gov.charter.allowedPaths.length) {
        const outside = sub.targetFiles.filter((f) => !withinAll(f, gov.charter.allowedPaths));
        if (outside.length) throw fatal(`${source}: autonomous worker '${sub.id}' targets ${outside.join(', ')}, outside charter allowedPaths (${gov.charter.allowedPaths.join(', ')}).`);
      }
      if (autonomous && sub.prompt && sub.targetFiles.length === 0) throw fatal(`${source}: autonomous worker '${sub.id}' must declare targetFiles.`);
      if (sub.role) {
        const role = gov.roles[String(sub.role).toUpperCase()];
        if (!role) throw fatal(`${source}: worker '${sub.id}' has unknown role '${sub.role}' (known: ${Object.keys(gov.roles).join(', ') || 'none — add .harness/roles/*.json'}).`);
        const wp = role.writablePaths || [];
        const notAllowed = sub.targetFiles.filter((f) => !withinAll(f, wp));
        if (notAllowed.length) throw fatal(`${source}: role ${role.name} may only own ${wp.join(', ') || 'no files (read-only role)'}, but worker '${sub.id}' targets ${notAllowed.join(', ')}.`);
      }
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
/** Charter + roles + skills, loaded fresh for every task so edits apply without a restart. */
function loadGov() {
  return { charter: readCharter(), roles: loadRoles(), skills: loadSkills() };
}

/** Text block listing roles (with what they may own) and skills — shown to the AI planner and PO. */
function catalog(gov) {
  const roles = Object.values(gov.roles).filter((r) => (r.writablePaths || []).length)
    .map((r) => `- ${r.name}: ${r.description} May own files matching: ${r.writablePaths.join(', ')}`);
  const skills = Object.values(gov.skills).map((s) => `- ${s.name} (roles: ${s.roles.join(', ') || 'any'}): ${s.description}`);
  return [
    roles.length ? `[WORKER ROLES — give every worker one "role"]:\n${roles.join('\n')}` : '',
    skills.length ? `[SKILLS — optional "skills" list per worker, only for the listed roles]:\n${skills.join('\n')}` : '',
    gov.charter.forbiddenPaths.length ? `[FORBIDDEN PATHS — never target]: ${gov.charter.forbiddenPaths.join(', ')}` : ''
  ].filter(Boolean).join('\n');
}

/** Ask the AI to split a goal into parallel workers with disjoint files. Re-asks once on an invalid plan. */
async function aiDecompose(task, gov) {
  const pc = config.planner || {};
  const maxWorkers = pc.maxWorkers || 4;
  const allowed = (task.targetFiles || []).map(safeTarget).filter(Boolean);
  const { files, total } = listProjectFiles(ROOT, pc.maxFilesListed || 400);
  const scripts = readJsonSafe(path.join(ROOT, 'package.json'), null)?.scripts;
  const memory = memoryContext(config);
  const hasRoles = Object.keys(gov.roles).length > 0;
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
      '- Each worker prompt must be self-contained. Put the exact names/exports/signatures/return values that workers share in "interfaceContract"; every worker receives it.',
      hasRoles ? '- Give each worker a "role" whose allowed paths cover its targetFiles, and the "skills" that apply.' : '',
      'Reply with ONLY this JSON object, no other text:',
      `{"interfaceContract":"shared names, signatures, return values","subtasks":[{"id":"short-kebab-id",${hasRoles ? '"role":"DEV_ENGINEER","skills":[],' : ''}"targetFiles":["path/file.ext"],"prompt":"instructions"}],"verifySuggestion":"optional shell command that would prove the goal works"}`,
      hasRoles ? `\n${catalog(gov)}` : '',
      `\n[GOAL]:\n${task.goal || task.prompt || task.title}`,
      `\n[PROJECT FILES (${files.length} of ${total})]:\n${files.join('\n') || '(empty project)'}`,
      scripts ? `\n[package.json scripts]:\n${JSON.stringify(scripts, null, 2)}` : '',
      memory ? `\n[USER MEMORY]:\n${memory}` : '',
      feedback ? `\n[YOUR PREVIOUS PLAN WAS REJECTED — fix this]:\n${feedback}` : ''
    ].filter(Boolean).join('\n');

    logTelemetry('1_AI_PLANNER', `AI planner attempt ${attempt}/${attempts}`, { goal: (task.goal || '').slice(0, 300) });
    const { output, engine } = await spawnEngine({
      id: 'ai-planner', engine: task.engine, prompt, cwd: ROOT,
      timeoutMs: pc.timeoutMs || config.workerTimeoutMs, allowedTools: pc.allowedTools || ['Read', 'Glob', 'Grep'],
      disallowedTools: computeDisallowedTools(gov.charter),
      tier: chooseModelTier({ kind: 'plan', level: 'orchestrator' }), model: task.model || null
    });
    try {
      let plan;
      try { plan = extractJson(output); } catch { throw new Error(`Reply was not valid JSON: ${output.slice(0, 300)}`); }
      if (!Array.isArray(plan.subtasks) || plan.subtasks.length === 0) throw new Error('JSON has no "subtasks" list.');
      if (plan.subtasks.length > maxWorkers) throw new Error(`Too many workers (${plan.subtasks.length}); the maximum is ${maxWorkers}.`);
      const subtasks = plan.subtasks.map((s) => ({
        id: s.id, role: s.role || undefined, skills: Array.isArray(s.skills) ? s.skills : undefined,
        targetFiles: s.targetFiles, prompt: String(s.prompt || '').trim(), engine: task.engine, goal: task.goal
      }));
      validateSubtasks(subtasks, { source: 'AI planner', allowed, requireScope: true, gov, autonomous: !!task.autonomous });
      subtasks.forEach((sub) => resolveGovernance(sub, gov)); // unknown skills are a plan error too
      logTelemetry('1_AI_PLANNED', `AI planner produced ${subtasks.length} worker(s)`, { engine, subtasks: subtasks.map((s) => ({ id: s.id, role: s.resolvedRole, targetFiles: s.targetFiles })) });
      return {
        subtasks,
        interfaceContract: typeof plan.interfaceContract === 'string' ? plan.interfaceContract.slice(0, 4000) : '',
        verifySuggestion: typeof plan.verifySuggestion === 'string' ? plan.verifySuggestion.slice(0, 300) : ''
      };
    } catch (e) {
      feedback = e.message;
      logTelemetry('1_AI_PLAN_INVALID', e.message, { attempt });
    }
  }
  throw fatal(`AI planner could not produce a valid plan after ${attempts} attempt(s): ${feedback}`);
}

// ───────────────────────────── hierarchy: orchestrator → leads → workers ─────────────────────────────
// Level 1 (orchestrator, read-only) splits the goal between leads; level 2 (each lead, read-only) splits its
// slice into workers; level 3 (workers) do the work in parallel. The controller validates every level
// deterministically (team.json guardrails, scopes, no overlaps, worker limits) before the next one starts, and
// counts the cost of every agent against the budget. An invalid lead plan is escalated to the human.

const stripSlash = (f) => String(f).replace(/\/$/, '');
const minutesToMs = (m, dflt) => (typeof m === 'number' && m > 0 ? Math.round(m * 60000) : dflt);

async function hierDecompose(task, gov) {
  const team = loadTeam();
  if (!team) throw fatal('This task asks for the team hierarchy, but .harness/team.json does not exist.');
  const pc = config.planner || {};
  const { errors } = validateTeam(team, { roles: gov.roles, charter: gov.charter, plannerMaxWorkers: pc.maxWorkers || 4, engines: Object.keys(config.profiles || {}) });
  if (errors.length) throw fatal(`team.json is invalid, nothing was started: ${errors.join('; ')}`);
  const orch = team.members.find((m) => m.level === 'orchestrator');
  const leads = team.members.filter((m) => m.level === 'lead');
  const delegable = new Set(orch.canDelegateTo?.length ? orch.canDelegateTo : leads.map((l) => l.id));
  const attempts = pc.maxAttempts || 2;
  const goalText = task.goal || task.prompt || task.title;
  const userAllowed = (task.targetFiles || []).map(safeTarget).filter(Boolean);
  const { files, total } = listProjectFiles(ROOT, pc.maxFilesListed || 400);
  const scripts = readJsonSafe(path.join(ROOT, 'package.json'), null)?.scripts;
  const memory = memoryContext(config);
  const readOnly = ['Read', 'Glob', 'Grep'];
  const deny = computeDisallowedTools(gov.charter);
  const persona = (m) => { const r = gov.roles[String(m.role).toUpperCase()]; return r?.mission || r?.description || m.role; };
  const context = [
    `\n[PROJECT FILES (${files.length} of ${total})]:\n${files.join('\n') || '(empty project)'}`,
    scripts ? `\n[package.json scripts]:\n${JSON.stringify(scripts, null, 2)}` : '',
    memory ? `\n[USER MEMORY]:\n${memory}` : ''
  ];
  const leadLine = (l) => `- ${l.id} (role ${l.role}; may own: ${l.scope.join(', ')}; up to ${l.maxWorkers ?? 3} workers)`;

  // ── level 1: the orchestrator delegates the goal to leads
  const validateAssignments = (plan) => {
    if (!Array.isArray(plan.assignments) || !plan.assignments.length) throw new Error('JSON has no "assignments" list.');
    const seenLeads = new Set(); const claimed = [];
    for (const a of plan.assignments) {
      const lead = leads.find((l) => l.id === a.lead);
      if (!lead || !delegable.has(lead.id)) throw new Error(`assignment to "${a.lead}": that is not a lead you may delegate to (${[...delegable].join(', ')}).`);
      if (seenLeads.has(lead.id)) throw new Error(`lead "${lead.id}" is assigned twice; use each lead at most once.`);
      seenLeads.add(lead.id);
      if (typeof a.goal !== 'string' || !a.goal.trim()) throw new Error(`assignment to "${lead.id}" has no goal.`);
      if (!Array.isArray(a.files) || !a.files.length) throw new Error(`assignment to "${lead.id}" has no files.`);
      a.files = a.files.map((f) => { const s = safeTarget(f); if (!s) throw new Error(`assignment to "${lead.id}" has an unsafe path "${f}".`); const base = s.replace(/\/+$/, ''); return String(f).endsWith('/') ? `${base}/` : base; });
      for (const f of a.files) {
        if (!withinAll(f, lead.scope)) throw new Error(`file "${f}" is outside lead "${lead.id}"'s scope (${lead.scope.join(', ')}).`);
        if (userAllowed.length && !inScope(stripSlash(f), userAllowed)) throw new Error(`file "${f}" is outside the files the user allowed (${userAllowed.join(', ')}).`);
        for (const [other, by] of claimed) if (by !== lead.id && (stripSlash(f) === stripSlash(other) || stripSlash(f).startsWith(`${stripSlash(other)}/`) || stripSlash(other).startsWith(`${stripSlash(f)}/`))) throw new Error(`Swarm Lock Collision: "${f}" (${lead.id}) overlaps "${other}" (${by}).`);
        claimed.push([f, lead.id]);
      }
    }
    return plan;
  };

  let plan = null; let feedback = '';
  for (let attempt = 1; attempt <= attempts && !plan; attempt++) {
    writeState({ phase: '1_ORCHESTRATOR', planSummary: `${orch.id} is delegating the goal to the leads (attempt ${attempt}/${attempts})…` });
    const prompt = [
      '[HARNESS ORCHESTRATOR]',
      `You are ${orch.id}, the ORCHESTRATOR (level 1) of an agent team. Persona: ${persona(orch)}`,
      'You only PLAN. Do NOT create, edit or delete any file. You may read files to understand the project.',
      'Split the GOAL between the team leads below. Each lead plans its own slice and starts its own workers, so give every lead a clear goal for its slice and the exact files its team will own.',
      'Rules (the controller checks every one and rejects the plan otherwise):',
      '- Use each lead at most once; skip leads that have nothing to do.',
      '- Every file you assign must be inside that lead\'s scope, files must not overlap between leads, and never use absolute paths, "..", ".git/" or ".harness/".',
      userAllowed.length ? `- The user only allows files inside: ${userAllowed.join(', ')}` : '',
      '- Put the exact names, signatures and return values that teams share into "interfaceContract"; every worker receives it.',
      'Reply with ONLY this JSON object, no other text:',
      '{"interfaceContract":"shared names, signatures, return values","assignments":[{"lead":"lead-id","goal":"what this lead\'s team must achieve","files":["path/file.ext"]}],"verifySuggestion":"optional"}',
      `\n[TEAM LEADS]:\n${leads.filter((l) => delegable.has(l.id)).map(leadLine).join('\n')}`,
      `\n[GOAL]:\n${goalText}`,
      ...context,
      feedback ? `\n[YOUR PREVIOUS PLAN WAS REJECTED — fix this]:\n${feedback}` : ''
    ].filter(Boolean).join('\n');
    logTelemetry('1_ORCHESTRATOR', `${orch.id} delegation attempt ${attempt}/${attempts}`, { goal: String(goalText).slice(0, 300) });
    const { output } = await spawnEngine({ id: orch.id, engine: task.engine || orch.engine, prompt, cwd: ROOT, timeoutMs: minutesToMs(orch.budget?.maxMinutes, config.workerTimeoutMs), allowedTools: readOnly, disallowedTools: deny, tier: chooseModelTier({ kind: 'plan', level: 'orchestrator', role: orch.role }), model: task.model || orch.model || null });
    try {
      let parsed;
      try { parsed = extractJson(output); } catch { throw new Error(`Reply was not valid JSON: ${output.slice(0, 300)}`); }
      plan = validateAssignments(parsed);
    } catch (e) { feedback = e.message; plan = null; logTelemetry('1_ORCHESTRATOR_INVALID', e.message, { attempt }); }
  }
  if (!plan) throw fatal(`The orchestrator could not produce a valid delegation after ${attempts} attempt(s): ${feedback}. Escalated to you.`);
  enforceBudget(task, 'the orchestrator');
  const contract = typeof plan.interfaceContract === 'string' ? plan.interfaceContract.slice(0, 4000) : '';
  logTelemetry('1_ORCHESTRATED', `${orch.id} delegated to ${plan.assignments.length} lead(s)`, { assignments: plan.assignments.map((a) => ({ lead: a.lead, files: a.files })) });

  // ── level 2: every lead splits its slice into workers (in parallel)
  const planLead = async (a) => {
    const lead = leads.find((l) => l.id === a.lead);
    const maxW = lead.maxWorkers ?? 3;
    let fb = '';
    for (let attempt = 1; attempt <= attempts; attempt++) {
      writeState({ phase: '1_LEADS', planSummary: `${plan.assignments.length} lead(s) planning their teams (attempt ${attempt}/${attempts})…` });
      const prompt = [
        `[HARNESS LEAD ${lead.id}]`,
        `You are ${lead.id}, a TEAM LEAD (level 2) reporting to ${orch.id}. Persona: ${persona(lead)}`,
        'You only PLAN for your team. Do NOT create, edit or delete any file. You may read files to understand the project.',
        `Split your ASSIGNMENT into 1 to ${maxW} workers that will run IN PARALLEL. Rules (the controller checks every one and rejects the plan otherwise):`,
        '- Every worker owns a list of targetFiles, each one inside your assigned files; no file may appear in two workers.',
        '- Each worker prompt must be self-contained and must follow the shared interface contract exactly.',
        'Reply with ONLY this JSON object, no other text:',
        '{"subtasks":[{"id":"short-kebab-id","targetFiles":["path/file.ext"],"prompt":"instructions for this worker"}]}',
        `\n[ASSIGNMENT from ${orch.id}]:\n${a.goal}\n[YOUR ASSIGNED FILES]: ${a.files.join(', ')}`,
        contract ? `\n[SHARED INTERFACE CONTRACT]:\n${contract}` : '',
        `\n[OVERALL GOAL]:\n${goalText}`,
        ...context,
        fb ? `\n[YOUR PREVIOUS PLAN WAS REJECTED — fix this]:\n${fb}` : ''
      ].filter(Boolean).join('\n');
      logTelemetry('1_LEAD', `${lead.id} planning attempt ${attempt}/${attempts}`, { lead: lead.id });
      const { output } = await spawnEngine({ id: lead.id, engine: task.engine || lead.engine, prompt, cwd: ROOT, timeoutMs: minutesToMs(lead.budget?.maxMinutes, config.workerTimeoutMs), allowedTools: readOnly, disallowedTools: deny, tier: chooseModelTier({ kind: 'plan', level: 'lead', role: lead.role }), model: task.model || lead.model || null });
      try {
        let parsed;
        try { parsed = extractJson(output); } catch { throw new Error(`Reply was not valid JSON: ${output.slice(0, 300)}`); }
        const subs = parsed.subtasks;
        if (!Array.isArray(subs) || !subs.length) throw new Error('JSON has no "subtasks" list.');
        if (subs.length > maxW) throw new Error(`too many workers (${subs.length}); your limit is ${maxW}.`);
        for (const s of subs) {
          if (typeof s.prompt !== 'string' || !s.prompt.trim()) throw new Error(`worker "${s.id}" has no prompt.`);
          if (!Array.isArray(s.targetFiles) || !s.targetFiles.length) throw new Error(`worker "${s.id}" has no targetFiles.`);
          for (const f of s.targetFiles) {
            const safe = safeTarget(f);
            if (!safe) throw new Error(`worker "${s.id}" has an unsafe path "${f}".`);
            if (!a.files.some((af) => inScope(stripSlash(safe), [stripSlash(af)]))) throw new Error(`worker "${s.id}" targets "${f}", outside your assigned files (${a.files.join(', ')}).`);
          }
        }
        return subs;
      } catch (e) { fb = e.message; logTelemetry('1_LEAD_INVALID', `${lead.id}: ${e.message}`, { lead: lead.id, attempt }); }
    }
    throw fatal(`Lead '${lead.id}' could not produce a valid team plan after ${attempts} attempt(s): ${fb}. Escalated to you; the orchestrator cannot fix another level's plan.`);
  };
  const settled = await Promise.allSettled(plan.assignments.map(planLead));
  const failed = settled.find((r) => r.status === 'rejected');
  enforceBudget(task, 'the leads'); // money already spent counts even when a lead failed
  if (failed) throw failed.reason;

  // ── level 3: workers (created from the lead plans), checked once more as one swarm
  const subtasks = [];
  const teamPlan = { orchestrator: orch.id, assignments: [] };
  plan.assignments.forEach((a, i) => {
    const lead = leads.find((l) => l.id === a.lead);
    const mine = settled[i].value.map((s) => ({
      id: `${lead.id}.${s.id}`, lead: lead.id, role: lead.role, skills: Array.isArray(s.skills) ? s.skills : (lead.skills && lead.skills.length ? lead.skills : undefined),
      targetFiles: s.targetFiles, prompt: String(s.prompt).trim(), engine: task.engine || lead.engine, model: lead.model, goal: a.goal,
      timeoutMs: minutesToMs(lead.budget?.maxMinutes, undefined), maxCostUsd: lead.budget?.maxCostUsd
    }));
    subtasks.push(...mine);
    teamPlan.assignments.push({ lead: lead.id, goal: a.goal.slice(0, 300), files: a.files, workers: [] });
  });
  validateSubtasks(subtasks, { source: 'hierarchy', allowed: userAllowed, requireScope: true, gov, autonomous: !!task.autonomous });
  subtasks.forEach((sub) => resolveGovernance(sub, gov));
  for (const sub of subtasks) teamPlan.assignments.find((x) => x.lead === sub.lead).workers.push({ id: sub.id, files: sub.targetFiles });
  logTelemetry('1_HIERARCHY_PLANNED', `${orch.id} → ${plan.assignments.length} lead(s) → ${subtasks.length} worker(s)`, { team: teamPlan });
  return { subtasks, interfaceContract: contract, verifySuggestion: typeof plan.verifySuggestion === 'string' ? plan.verifySuggestion.slice(0, 300) : '', team: teamPlan };
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

  const gov = loadGov();
  const given = Array.isArray(task.subtasks) && task.subtasks.length > 0;
  writeState({ phase: '1_PLANNER', engine: engineLabel(given ? task.subtasks : [{ prompt: 'x' }]), taskTitle: task.title, planSummary: given ? `${task.subtasks.length} worker(s) given by the task` : 'single worker' });
  logTelemetry('1_PLANNER', 'Validating task and checking file-lock boundaries', { engine: task.engine || 'auto', errorTrace, autonomous: !!task.autonomous, backlogId: task.backlogId });

  let subtasks; let planSummary; let verifySuggestion = task.verifySuggestion || ''; let interfaceContract = task.interfaceContract || ''; let teamPlan = null;
  const vOpts = { gov, autonomous: !!task.autonomous, requireScope: !!task.autonomous };
  if (given) {
    subtasks = task.subtasks.map((s) => ({ ...s, engine: s.engine || task.engine }));
    validateSubtasks(subtasks, vOpts);
    subtasks.forEach((sub) => resolveGovernance(sub, gov));
    planSummary = `${subtasks.length} worker(s) given by the task`;
  } else if (task.hierarchy) {
    const r = await hierDecompose(task, gov);
    subtasks = r.subtasks; verifySuggestion = r.verifySuggestion || verifySuggestion; teamPlan = r.team;
    interfaceContract = [interfaceContract, r.interfaceContract].filter(Boolean).join('\n');
    planSummary = `hierarchy ${r.team.orchestrator} → ${r.team.assignments.length} lead(s) → ${subtasks.length} worker(s): ${r.team.assignments.map((a) => `${a.lead}[${a.workers.length}]`).join(' ')}`;
  } else if (task.autoPlan) {
    const r = await aiDecompose(task, gov);
    subtasks = r.subtasks; verifySuggestion = r.verifySuggestion || verifySuggestion;
    interfaceContract = [interfaceContract, r.interfaceContract].filter(Boolean).join('\n');
    planSummary = `AI planner → ${subtasks.length} worker(s): ${subtasks.map((s) => `${s.resolvedRole ? `${s.resolvedRole}:` : ''}${s.id}[${s.targetFiles.join(',')}]`).join('  ')}`;
  } else {
    subtasks = validateSubtasks([{
      id: 'worker-primary', engine: task.engine, role: task.role, skills: task.skills, targetFiles: task.targetFiles || [],
      prompt: task.goal || task.prompt || null, cliCommand: task.cliCommand || (task.goal || task.prompt ? null : 'node -v')
    }], vOpts);
    subtasks.forEach((sub) => resolveGovernance(sub, gov));
    planSummary = 'single worker';
  }
  for (const sub of subtasks) { // task-level contract + acceptance criteria reach every worker
    if (interfaceContract && !sub.interfaceContract) sub.interfaceContract = interfaceContract;
    if (task.acceptanceCriteria && !sub.acceptanceCriteria) sub.acceptanceCriteria = task.acceptanceCriteria;
  }
  if (subtasks.some((s) => s.resolvedRole)) planSummary += `  | roles: ${subtasks.map((s) => s.resolvedRole || '-').join(', ')}`;

  let verifyCmd = task.verifyCmd; let verifySource = 'given by task'; let verifyReal = !!task.verifyCmd;
  if (!verifyCmd) { const d = detectVerifyCmd(ROOT, config); verifyCmd = d.cmd; verifySource = d.source; verifyReal = d.real; }
  if (task.autonomous && gov.charter.requireRealCheck && !verifyReal) {
    throw fatal('Autonomous task has no real check (charter requireRealCheck). Add a "test" script to package.json or a human-approved "verifyCmd" to the backlog item.');
  }
  const mode = subtasks.length > 1 ? `SWARM-MESH (${subtasks.length}W)` : 'SQUARE-4-NODE';
  writeState({ engine: engineLabel(subtasks), mode, planSummary, lastGateStatus: `Check: ${verifyCmd}  (${verifySource})` });
  return {
    taskId: task.id || `job-${Date.now()}`,
    title: task.title || 'Unnamed Harness Task',
    engine: engineLabel(subtasks), mode, subtasks, verifyCmd, verifySource, verifySuggestion, planSummary, interfaceContract, team: teamPlan,
    errorContext: errorTrace
  };
}

// ───────────────────────────── Node 2: executor swarm ─────────────────────────────

async function runExecutorSwarm(plan, gitCtx = null) {
  writeState({ phase: '2_EXECUTOR_SWARM', mode: plan.mode, workerSummary: `Spawning ${plan.subtasks.length} parallel worker(s): ${plan.subtasks.map((s) => `${s.resolvedRole ? `${s.resolvedRole}:` : ''}${s.id}`).join(' | ')}` });
  logTelemetry('2_EXECUTOR', `Dispatching ${plan.subtasks.length} worker(s)`, { mode: plan.mode, engine: plan.engine });

  const useWorktrees = !gitCtx && config.useGitWorktrees && plan.subtasks.some((s) => s.prompt);
  if (useWorktrees && !(await isGitRepo())) throw fatal('useGitWorktrees is on, but this folder is not a git repository with at least one commit.');

  let finished = 0;
  const workerPromises = plan.subtasks.map(async (sub) => {
    for (const f of sub.targetFiles) activeFileLocks.add(f);
    writeState({ phase: '2_EXECUTOR_SWARM' });
    let workerCwd = ROOT;
    const wtPath = path.join(DIRS.worktrees, `${plan.taskId}-${sub.id}`.replace(/[^\w.-]/g, '_'));
    try {
      if (gitCtx) { // integration mode: own branch + worktree from the integration branch, kept across cycles
        const w = gitCtx.workers[sub.id] || (gitCtx.workers[sub.id] = {
          branch: `harness/${gitCtx.tag}/${safeRef(sub.id)}`, path: path.join(gitCtx.dir, safeRef(sub.id))
        });
        if (await ensureWorkerWorktree({ wtPath: w.path, branch: w.branch, baseSha: gitCtx.baseSha, root: ROOT, link: gitCtx.link })) {
          logTelemetry('GIT_WORKTREE', `Worker ${sub.id} works on branch ${w.branch}`, { worker: sub.id, path: w.path });
        }
        workerCwd = w.path;
      } else if (useWorktrees) {
        await execFileAsync('git', ['worktree', 'add', '--detach', wtPath, 'HEAD'], { cwd: ROOT });
        workerCwd = wtPath;
      }
      const result = await runWorker(sub, workerCwd, plan.errorContext, { cycle: plan.cycle || 1, model: plan.model || null });
      // per-agent budget (a running agent cannot be stopped by cost, so this is checked when it reports back)
      if (typeof sub.maxCostUsd === 'number' && (taskCost.agents[sub.id] || 0) > sub.maxCostUsd + 1e-9) {
        logTelemetry('BUDGET_AGENT_EXCEEDED', `${sub.id} cost $${(taskCost.agents[sub.id] || 0).toFixed(4)} > its cap $${sub.maxCostUsd}`, { agent: sub.id });
        throw fatal(`BUDGET_AGENT_EXCEEDED: worker ${sub.id} cost $${(taskCost.agents[sub.id] || 0).toFixed(3)}, over its cap of $${sub.maxCostUsd}.`);
      }
      if (useWorktrees) result.sync = await syncWorktree(wtPath, sub);
      if (gitCtx && sub.prompt) {
        const c = await commitScoped({
          wtPath: workerCwd, targets: sub.targetFiles, inScope, root: ROOT, ignore: gitCtx.link,
          message: `harness(${plan.taskId}): ${sub.resolvedRole ? `${sub.resolvedRole} ` : ''}${sub.id}\n\n${String(sub.prompt).slice(0, 400)}`
        });
        if (c.discarded.length) logTelemetry('2_SCOPE_VIOLATION', `Worker ${sub.id} changed files outside its scope; discarded before commit`, { worker: sub.id, blocked: c.discarded });
        logTelemetry('GIT_WORKER_COMMIT', `${sub.id}: ${c.sha ? `committed ${c.kept.length} file(s) @ ${c.sha.slice(0, 8)}` : 'no in-scope changes'}`, { worker: sub.id, kept: c.kept, sha: c.sha });
        result.git = c;
      }
      finished++;
      writeState({ workerSummary: `${finished}/${plan.subtasks.length} worker(s) finished (last: ${sub.resolvedRole ? `${sub.resolvedRole}:` : ''}${sub.id})` });
      logTelemetry('2_WORKER_DONE', `Worker ${sub.id} finished`, { worker: sub.id, role: sub.resolvedRole });
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
  if (gitCtx) { // merge every worker branch into a candidate on top of the integration branch
    const workerBranches = Object.entries(gitCtx.workers).map(([id, w]) => ({ id, branch: w.branch }));
    const { tip, candidate } = await buildCandidate({
      intPath: gitCtx.intPath, integrationBranch: gitCtx.branch, workerBranches, root: ROOT, link: gitCtx.link,
      messageFor: (b) => `harness(${plan.taskId}): merge ${b.id} into ${gitCtx.branch}`
    });
    gitCtx.tipAtCandidate = tip; gitCtx.candidate = candidate;
    plan.verifyCwd = gitCtx.intPath;
    logTelemetry('GIT_CANDIDATE', `Candidate ${candidate.slice(0, 8)} = ${gitCtx.branch} @ ${tip.slice(0, 8)} + ${workerBranches.length} worker branch(es); verifying it before ${gitCtx.branch} moves`, { tip, candidate });
    writeState({ gitSummary: `candidate ${candidate.slice(0, 8)} on ${gitCtx.branch} @ ${tip.slice(0, 8)} — verifying (not merged yet)` });
  }
  return results.map((r) => r.value);
}

// ───────────────────────────── Node 3: verifier ─────────────────────────────

async function runVerifier(plan) {
  writeState({ phase: '3_VERIFIER', lastGateStatus: `Running: ${plan.verifyCmd}` });
  logTelemetry('3_VERIFIER', `Executing verification command: ${plan.verifyCmd}`, { source: plan.verifySource, cwd: plan.verifyCwd ? path.relative(ROOT, plan.verifyCwd) : '.' });
  try {
    const { stdout } = await execAsync(plan.verifyCmd, { cwd: plan.verifyCwd || ROOT, timeout: config.verifyTimeoutMs || 600000, maxBuffer: 32 * 1024 * 1024 });
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

async function runCommitter(plan, task, taskFile, gitCtx = null) {
  let gitNote = '';
  if (gitCtx) { // the verified candidate becomes the new integration branch tip
    const how = await advanceBranch({ branch: gitCtx.branch, newSha: gitCtx.candidate, expectedOld: gitCtx.tipAtCandidate, root: ROOT });
    gitCtx.mergedSha = gitCtx.candidate;
    gitNote = ` → ${gitCtx.branch} @ ${gitCtx.candidate.slice(0, 8)}`;
    logTelemetry('GIT_INTEGRATED', `${gitCtx.branch} moved ${gitCtx.tipAtCandidate.slice(0, 8)} → ${gitCtx.candidate.slice(0, 8)} (${how})`, { branch: gitCtx.branch, from: gitCtx.tipAtCandidate, to: gitCtx.candidate });
    writeState({ gitSummary: `${gitCtx.branch} @ ${gitCtx.candidate.slice(0, 8)} (verified merge) — your folder untouched` });
  } else if (config.autoGitCommit && (await isGitRepo())) {
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
  archiveTask(taskFile, task, DIRS.completed, {
    result: 'COMMITTED', plan: plan.subtasks, verifyCmd: plan.verifyCmd, completedAt: new Date().toISOString(),
    ...(plan.team ? { team: plan.team } : {}), costUsd: Math.round(taskCost.usd * 10000) / 10000, costByAgent: taskCost.agents,
    ...(gitCtx ? { git: { branch: gitCtx.branch, from: gitCtx.tipAtCandidate, to: gitCtx.candidate, workerBranches: Object.values(gitCtx.workers).map((w) => w.branch) } } : {})
  });
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
  const integration = integrationFor(task); let gitCtx = null; let gitResult = null;
  const title = task.title || path.basename(taskFile);
  resetCost();
  writeState({ planSummary: '-', workerSummary: '-', currentTaskFile: taskFile, costUsd: 0 });
  lastFinished = { autonomous: !!task.autonomous, backlogId: task.backlogId, title, ok: false };
  autoTierCap = !!task.autonomous && task.costApproved !== true && !highAlwaysAllowed();
  if (task.backlogId) {
    const item = updateBacklogItem(task.backlogId, { status: 'IN_PROGRESS', startedAt: new Date().toISOString(), lastJobId: task.id });
    if (!item) logTelemetry('BACKLOG_ITEM_MISSING', `Job references backlog item ${task.backlogId}, which is not in backlog.json`);
  }

  while (cycle <= MAX_CYCLES) {
    writeState({ cycle, taskId: task.id, taskTitle: title, lastGateStatus: cycle > 1 ? `Retrying with previous error (cycle ${cycle})` : 'Planning…' });
    try {
      plan = await runPlanner(task, lastErrorTrace, plan);
      plan.cycle = cycle; plan.model = task.model || null; // model tier: retries escalate; --model on the task overrides
      if (integration && !gitCtx) gitCtx = await startIntegration(task, integration);
      if (cycle === 1 && !backup && !gitCtx) backup = backupScope(plan);
      if (cycle > 1) enforceBudget(task, `cycle ${cycle - 1}`); // never start another cycle once over budget
      outputs = await runExecutorSwarm(plan, gitCtx);
      enforceBudget(task, `cycle ${cycle} workers`);
      const verification = await runVerifier(plan);
      if (verification.passed) {
        await runCommitter(plan, task, taskFile, gitCtx);
        gitResult = await finishIntegration(gitCtx, true);
        discardBackup(backup);
        finishSession(task, plan, 'COMMITTED', cycle, errors, outputs, null, gitResult);
        if (task.backlogId) updateBacklogItem(task.backlogId, { status: 'DONE', completedAt: new Date().toISOString(), result: 'COMMITTED', cyclesUsed: cycle, ...(gitResult ? { integratedInto: `${gitResult.branch}@${gitResult.mergedSha.slice(0, 8)}` } : {}) });
        lastFinished.ok = true;
        writeState({ history: pushHistory(`✔ COMMITTED  ${title} (cycle ${cycle}/${MAX_CYCLES})`), currentTaskFile: null });
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
  try { gitResult = await finishIntegration(gitCtx, false); } catch (e) { logTelemetry('GIT_CLEANUP_FAILED', e.message); }
  if (gitResult) rollback = `${gitCtx.branch} unchanged (candidate discarded)${gitResult.keptBranches ? `; worker branches kept for review: ${gitResult.workerBranches.join(', ')}` : ''}`;
  const dest = archiveTask(taskFile, task, DIRS.failed, {
    result: phase, haltReason: reason, haltedAt: new Date().toISOString(), cyclesUsed: usedCycles, rollback, errors, git: gitResult,
    costUsd: Math.round(taskCost.usd * 10000) / 10000, costByAgent: taskCost.agents
  }, errors.map((e, i) => `===== cycle ${i + 1} =====\n${e}`).join('\n\n'));
  finishSession(task, plan, phase, usedCycles, errors, outputs, rollback, gitResult);
  writeState({
    phase,
    lastGateStatus: haltReason ? `REJECTED: ${haltReason}` : `HALTED after ${MAX_CYCLES} cycles${rollback ? `; files ${rollback}` : ''}. Inspect .harness/failed/`,
    history: pushHistory(`✖ ${phase}  ${title} → ${path.relative(ROOT, dest)}`)
  });
  logTelemetry(phase, reason.slice(0, 4000), { taskId: task.id, rollback, deadLetter: path.relative(ROOT, dest) });
  if (task.backlogId) updateBacklogItem(task.backlogId, { status: 'BLOCKED', blockedReason: `${phase}: ${reason.slice(0, 500)}`, deadLetter: path.relative(ROOT, dest) });
  writeState({ currentTaskFile: null });
  return false;
}

function finishSession(task, plan, result, cycles, errors, outputs, rollback = null, gitResult = null) {
  const mem = config.memory || {};
  const title = task.title || task.id || 'task';
  try {
    if (mem.recordSessions !== false) {
      recordSession({
        taskId: task.id || 'task', title, result, cycles, maxCycles: MAX_CYCLES, goal: task.goal,
        engine: plan?.engine || task.engine || '-', verifyCmd: plan?.verifyCmd || task.verifyCmd || '-', verifySource: plan?.verifySource,
        verifySuggestion: plan?.verifySuggestion, planner: plan?.planSummary, rollback, git: gitResult,
        team: plan?.team, costUsd: Math.round(taskCost.usd * 10000) / 10000, costByAgent: { ...taskCost.agents },
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
      if (lastFinished?.autonomous && !lastFinished.ok) {
        auto.paused = `autonomous task "${lastFinished.title}" failed — human decision needed`;
        logTelemetry('AUTO_PAUSED', auto.paused, { backlogId: lastFinished.backlogId });
      }
    }
  } finally {
    draining = false;
    if (auto.enabled) { refreshAutoStatus(); setTimeout(() => autonomousTick('queue-empty').catch((e) => logTelemetry('AUTO_ERROR', e.message)), 1000); }
    if (!onceMode && !selfTestMode) setTimeout(() => !draining && !auto.ticking && writeState({ phase: 'IDLE_WATCHING', mode: 'SQUARE + SWARM', cycle: 0, workerSummary: 'Idle — waiting for the next task', activeLocks: [] }), 1500);
  }
}

const scanInbox = () => fs.readdirSync(DIRS.inbox).filter((f) => f.endsWith('.json')).sort().forEach((f) => enqueue(path.join(DIRS.inbox, f)));

function daemonAlive() {
  const pid = Number(fs.existsSync(FILES.pid) && fs.readFileSync(FILES.pid, 'utf8'));
  if (!pid || pid === process.pid) return 0;
  try { process.kill(pid, 0); return pid; } catch { return 0; }
}

// ───────────────────────────── autonomous controller ("act as me") ─────────────────────────────
// Wakes on an interval or when the queue empties. Acting as PO_ARCHITECT inside charter.md limits:
//   READY backlog item → promote highest priority into the inbox
//   no READY item      → ask the PO_ARCHITECT (read-only AI) for the next tasks (≤ budget), then promote
// Budget: at most charter maxAutoTasksPerRun dispatches per run (a run = one --autonomous session or one --tick).
// Any autonomous task that fails pauses autonomy for the rest of the run: a human decides.

const AUTO_STATE_FILE = path.join(path.dirname(FILES.state), 'auto-state.json'); // survives restarts and separate --tick runs
const auto = { enabled: false, intervalSec: 300, used: 0, paused: null, ticking: false, lastTick: null, lastResult: '-' };

function inboxCount() { return fs.readdirSync(DIRS.inbox).filter((f) => f.endsWith('.json')).length; }

function refreshAutoStatus(note) {
  if (note) auto.lastResult = note;
  const charter = readCharter();
  const c = backlogCounts(readBacklog());
  const mode = !auto.enabled ? 'off (start with --autonomous)' : !charter.autonomous ? 'OFF in charter.md' : auto.paused ? 'PAUSED' : `ON every ${auto.intervalSec}s`;
  writeState({
    autoStatus: `${mode} | budget ${auto.used}/${charter.maxAutoTasksPerRun} | backlog R${c.READY} P${c.IN_PROGRESS} D${c.DONE} B${c.BLOCKED} | ${auto.lastResult}`,
    autonomous: { enabled: auto.enabled, charterAllows: charter.autonomous, intervalSec: auto.intervalSec, used: auto.used, max: charter.maxAutoTasksPerRun, paused: auto.paused, lastTick: auto.lastTick, lastResult: auto.lastResult, backlog: c }
  });
}

/**
 * The version of the project autonomous work builds on. In integration mode that is the tip of the
 * integration branch (a detached worktree, removed afterwards) — NOT the user's folder, which may be
 * on another branch. Returns { dir, tip, cleanup }.
 */
async function projectView() {
  const branch = integrationFor({ autonomous: true });
  if (!branch || !(await isRepoWithCommits(ROOT))) return { dir: ROOT, tip: null, cleanup: async () => {} };
  const g = config.git || {};
  const tip = (await branchSha(branch, ROOT)) || (await branchSha(g.integrationBase && g.integrationBase !== 'HEAD' ? g.integrationBase : 'HEAD', ROOT).catch(() => null))
    || (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: ROOT })).stdout.trim();
  const dir = path.join(DIRS.worktrees, '_view');
  await removeWorktree(dir, ROOT);
  fs.rmSync(dir, { recursive: true, force: true });
  await execFileAsync('git', ['worktree', 'add', '-q', '--detach', dir, tip], { cwd: ROOT });
  for (const n of g.linkIntoWorktrees || ['node_modules']) {
    const src = path.join(ROOT, n); const dest = path.join(dir, n);
    if (fs.existsSync(src) && !fs.existsSync(dest)) { try { fs.symlinkSync(src, dest, 'dir'); } catch { /* best effort */ } }
  }
  return { dir, tip, cleanup: async () => { await removeWorktree(dir, ROOT); fs.rmSync(dir, { recursive: true, force: true }); } };
}

/** PO_ARCHITECT: read charter + repo + backlog, propose ≤ max tasks, validate, add them as READY. */
async function poGenerate(gov, max) {
  const po = gov.roles.PO_ARCHITECT || { name: 'PO_ARCHITECT', description: 'Product Owner and System Architect.', allowedTools: ['Read', 'Glob', 'Grep'] };
  const b = readBacklog();
  const view = await projectView();
  const { files, total } = listProjectFiles(view.dir, (config.planner || {}).maxFilesListed || 400);
  const scripts = readJsonSafe(path.join(view.dir, 'package.json'), null)?.scripts;
  const maxWorkers = (config.planner || {}).maxWorkers || 4;
  const prompt = [
    '[HARNESS PO_ARCHITECT]',
    `[ROLE PERSONA — PO_ARCHITECT]:\n${po.mission || po.description}`,
    'You act on behalf of the project owner, strictly inside the CHARTER below. Do NOT create, edit or delete any file — only read. The harness writes the backlog for you.',
    `Propose AT MOST ${max} next task(s) that move the charter objectives forward, most important first. Rules:`,
    '- Each task is small, independently verifiable by the project\'s existing check (package.json scripts), and does not repeat a DONE or IN_PROGRESS task.',
    `- Each task has 1 to ${maxWorkers} parallel workers; every worker has a "role", explicit "targetFiles" inside the charter allowedPaths and its role's paths, and no file/folder overlap with another worker of the same task.`,
    '- Write "acceptanceCriteria" a reviewer can check, and an "interfaceContract" (exact names, signatures, return values) whenever workers must agree.',
    '- If the objectives are already met, return {"tasks":[]}.',
    'Reply with ONLY this JSON, no other text:',
    '{"tasks":[{"title":"...","priority":1,"goal":"...","acceptanceCriteria":["..."],"interfaceContract":"...","subtasks":[{"id":"short-id","role":"DEV_ENGINEER","skills":[],"targetFiles":["src/x.js"],"prompt":"..."}],"verifySuggestion":"optional"}]}',
    `\n${catalog(gov)}`,
    gov.charter.allowedPaths.length ? `[ALLOWED PATHS for autonomous work]: ${gov.charter.allowedPaths.join(', ')}` : '',
    `\n[CHARTER]:\n${gov.charter.text}`,
    `\n[CURRENT BACKLOG]:\n${b.tasks.map((t) => `- ${t.id} [${t.status}] ${t.title || t.goal}`).join('\n') || '(empty)'}`,
    `\n[PROJECT FILES (${files.length} of ${total})${view.tip ? ` — the '${integrationFor({ autonomous: true })}' branch @ ${view.tip.slice(0, 8)}, which is what autonomous work builds on` : ''}]:\n${files.join('\n') || '(empty project)'}`,
    scripts ? `\n[package.json scripts]:\n${JSON.stringify(scripts, null, 2)}` : '',
    memoryContext(config) ? `\n[USER MEMORY]:\n${memoryContext(config)}` : ''
  ].filter(Boolean).join('\n');

  writeState({ phase: '0_PO_ARCHITECT', taskTitle: 'PO_ARCHITECT is grooming the backlog from charter.md', planSummary: `generating ≤ ${max} task(s)` });
  logTelemetry('0_PO_ARCHITECT', `Backlog has no READY items; asking PO_ARCHITECT for up to ${max} task(s)`);
  let parsed = null; let lastErr = '';
  try {
    for (let attempt = 1; attempt <= 2 && !parsed; attempt++) {
      const { output } = await spawnEngine({
        id: 'po-architect', prompt: attempt === 1 ? prompt : `${prompt}\n\n[YOUR PREVIOUS REPLY WAS NOT VALID JSON — reply with the JSON object only]: ${lastErr}`,
        cwd: view.dir, timeoutMs: config.workerTimeoutMs,
        allowedTools: computeAllowedTools(po, [], []), disallowedTools: computeDisallowedTools(gov.charter),
        tier: chooseModelTier({ kind: 'plan', role: 'PO_ARCHITECT' })
      });
      try { parsed = extractJson(output); if (!Array.isArray(parsed.tasks)) throw new Error('no "tasks" list'); } catch (e) { parsed = null; lastErr = `${e.message}: ${output.slice(0, 200)}`; }
    }
  } finally { await view.cleanup(); }
  if (!parsed) { logTelemetry('0_PO_INVALID', `PO_ARCHITECT reply unusable: ${lastErr}`); throw fatal(`PO_ARCHITECT reply was not valid JSON twice: ${lastErr}`); }

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const norm = (t) => String(t || '').toLowerCase().replace(/\W+/g, ' ').trim();
  const existing = new Set(b.tasks.map((t) => norm(t.title || t.goal)));
  const added = [];
  for (const [i, t] of parsed.tasks.slice(0, max).entries()) {
    const subs = Array.isArray(t.subtasks) && t.subtasks.length ? t.subtasks
      : [{ id: 'worker-main', role: t.role, skills: t.skills, targetFiles: t.targetFiles || [], prompt: t.goal || t.title }];
    const item = {
      id: `AUTO-${stamp}-${i + 1}`, title: String(t.title || t.goal || '').slice(0, 200), priority: Number(t.priority) || i + 1,
      status: 'READY', source: 'PO_ARCHITECT', createdAt: new Date().toISOString(), goal: t.goal || t.title,
      acceptanceCriteria: Array.isArray(t.acceptanceCriteria) ? t.acceptanceCriteria.map(String) : [],
      interfaceContract: typeof t.interfaceContract === 'string' ? t.interfaceContract : '',
      // AI-invented checks are recorded only — never executed (approved v1.0 decision).
      verifySuggestion: typeof t.verifySuggestion === 'string' ? t.verifySuggestion.slice(0, 300) : '',
      subtasks: subs.map((s) => ({ id: s.id, role: s.role, skills: Array.isArray(s.skills) ? s.skills : [], targetFiles: s.targetFiles, prompt: String(s.prompt || '') }))
    };
    try {
      if (!item.title) throw new Error('task has no title');
      if (existing.has(norm(item.title))) throw new Error('duplicate of an existing backlog item');
      if (item.subtasks.length > maxWorkers) throw new Error(`more than ${maxWorkers} workers`);
      const probe = JSON.parse(JSON.stringify(item.subtasks));
      validateSubtasks(probe, { source: 'PO_ARCHITECT', requireScope: true, gov, autonomous: true });
      probe.forEach((sub) => resolveGovernance(sub, gov));
      item.subtasks = probe.map(({ resolvedRole, resolvedSkills, resolvedTools, deniedTools, ...rest }) => rest);
      added.push(item); existing.add(norm(item.title));
    } catch (e) {
      logTelemetry('0_PO_TASK_REJECTED', `PO_ARCHITECT task "${item.title}" rejected: ${e.message}`);
    }
  }
  if (added.length) { const fresh = readBacklog(); fresh.tasks.push(...added); writeBacklog(fresh); }
  logTelemetry('0_PO_GENERATED', `PO_ARCHITECT added ${added.length} READY task(s)`, { ids: added.map((t) => t.id), proposed: parsed.tasks.length });
  return added;
}

/** Fingerprint of everything the PO's answer depends on: charter, backlog, and the integration branch tip. */
async function poFingerprint(gov) {
  const branch = integrationFor({ autonomous: true });
  const tip = branch ? (await branchSha(branch, ROOT).catch(() => null)) || '' : '';
  return crypto.createHash('sha1').update(gov.charter.text).update(JSON.stringify(readBacklog().tasks)).update(tip).digest('hex');
}

/** One controller tick. Returns a short result code. */
async function autonomousTick(reason = 'interval') {
  if (auto.ticking) return 'busy';
  auto.ticking = true; auto.lastTick = new Date().toISOString();
  try {
    if (draining || queue.length || inboxCount() > 0) return 'busy';
    const gov = loadGov();
    if (!gov.charter.autonomous) { refreshAutoStatus('charter says autonomous: off'); return 'off'; }
    if (auto.paused) { refreshAutoStatus(`paused: ${auto.paused}`); return 'paused'; }
    const remaining = gov.charter.maxAutoTasksPerRun - auto.used;
    if (remaining <= 0) { refreshAutoStatus('run budget used — restart to continue'); logTelemetry('AUTO_BUDGET_USED', `maxAutoTasksPerRun (${gov.charter.maxAutoTasksPerRun}) reached`); return 'budget'; }

    // A READY item that may use a lot of quota is held (BLOCKED, "needs your OK"), and autopilot moves on to the next one.
    const pickReady = () => {
      for (let it = nextReady(); it; it = nextReady()) {
        const pending = pendingCostReasons(config, it);
        if (!pending.length) return it;
        const why = `Needs your OK (may use a lot of quota): ${pending.map((p) => p.text).join('; ')}. Approve: node .harness/backlog.mjs approve ${it.id}`;
        updateBacklogItem(it.id, { status: 'BLOCKED', blockedReason: why, needsApproval: true });
        logTelemetry('AUTO_HELD', `Held ${it.id}: ${why}`, { backlogId: it.id, kinds: pending.map((p) => p.kind) });
        writeState({ history: pushHistory(`⏸ HELD  ${it.id} needs your OK (big run)`) });
      }
      return null;
    };
    let item = pickReady();
    if (!item) {
      // "autonomous: on" never means planning from nothing: with the placeholder objectives there is no AI call and no spend.
      if (/\(describe your product goals here/.test(gov.charter.text)) {
        refreshAutoStatus('idle: no READY task, and the charter objectives are not filled in, so nothing to plan (no AI call)');
        return 'idle';
      }
      const checkView = await projectView();
      const realCheck = detectVerifyCmd(checkView.dir, config).real; await checkView.cleanup();
      if (gov.charter.requireRealCheck && !realCheck) {
        auto.paused = 'no real check for PO-generated tasks (add a package.json test script)';
        logTelemetry('AUTO_PAUSED', auto.paused); refreshAutoStatus(); return 'paused';
      }
      const fp = await poFingerprint(gov);
      const saved = readJsonSafe(AUTO_STATE_FILE, {});
      if (saved.poIdleFp === fp && !process.argv.includes('--force')) { refreshAutoStatus('idle: PO found nothing to do and nothing changed since (no AI call; --tick --force asks again)'); return 'idle'; }
      let added = [];
      autoTierCap = !highAlwaysAllowed();
      try { added = await poGenerate(gov, remaining); } catch (e) {
        auto.paused = `PO_ARCHITECT failed: ${e.message.slice(0, 120)}`; logTelemetry('AUTO_PAUSED', auto.paused); refreshAutoStatus(); return 'paused';
      } finally { autoTierCap = false; }
      if (!added.length) { atomicWriteJson(AUTO_STATE_FILE, { poIdleFp: fp, at: new Date().toISOString() }); refreshAutoStatus('PO_ARCHITECT: nothing left to do for the charter'); return 'empty'; }
      if (fs.existsSync(AUTO_STATE_FILE)) fs.rmSync(AUTO_STATE_FILE, { force: true });
      item = pickReady();
    }
    if (!item) { refreshAutoStatus('no READY items'); return 'empty'; }

    const job = itemToJob(item, { autonomous: true });
    const file = path.join(DIRS.inbox, `${job.id}.json`);
    updateBacklogItem(item.id, { status: 'IN_PROGRESS', startedAt: new Date().toISOString(), lastJobId: job.id });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(job, null, 2));
    fs.renameSync(`${file}.tmp`, file);
    auto.used++;
    logTelemetry('AUTO_DISPATCH', `Promoted backlog ${item.id} → inbox (${auto.used}/${gov.charter.maxAutoTasksPerRun})`, { backlogId: item.id, jobId: job.id, trigger: reason });
    refreshAutoStatus(`dispatched ${item.id}`);
    writeState({ history: pushHistory(`▶ AUTO  ${item.id} ${item.title || ''}`) });
    if (!process.argv.includes('--tick') || !daemonAlive()) enqueue(file);
    return 'dispatched';
  } finally { auto.ticking = false; }
}

// ───────────────────────────── entry point ─────────────────────────────

if (process.env.HARNESS_WORKER === '1') { console.error('Harness workers must not start the controller.'); process.exit(2); }
const args = process.argv.slice(2);
const selfTestMode = args.includes('--self-test');
if (args.includes('--status')) { // convenience alias for status.mjs (read-only)
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [path.join(ROOT, '.harness', 'status.mjs'), '--log', '8'], { stdio: 'inherit' });
  process.exit(r.status ?? 0);
}
const tickMode = args.includes('--tick');
const onceMode = args.includes('--once') || tickMode;
const argVal = (flag) => { const i = args.indexOf(flag); return i > -1 ? args[i + 1] : undefined; };
auto.enabled = args.includes('--autonomous') && !tickMode;
auto.intervalSec = Number(argVal('--interval')) || (Number(argVal('--schedule')) * 60) || config.heartbeatIntervalSeconds || (config.autonomous || {}).intervalSeconds || 60;

if (selfTestMode) {
  const testTaskFile = path.join(DIRS.inbox, 'self-test-swarm.json');
  const selfTest = {
    id: 'self-test-001',
    engine: 'antigravity',
    title: 'Antigravity & Codex Square + 2-Worker Swarm Self-Test',
    verifyCmd: 'node -e "const fs=require(\'fs\'); if(!fs.existsSync(\'.harness/state.json\')) process.exit(1);"',
    subtasks: [
      { id: 'antigravity-worker-1', engine: 'antigravity', targetFiles: ['src/module-a.lock'], cliCommand: 'node -e "console.log(\'Antigravity worker 1 executed\')"' },
      { id: 'codex-worker-2', engine: 'codex', targetFiles: ['src/module-b.lock'], cliCommand: 'node -e "console.log(\'Codex worker 2 executed\')"' }
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
  if (tickMode && other) {
    // A daemon owns the inbox: this tick only promotes/generates one task; the daemon runs it.
    const r = await autonomousTick('manual-tick');
    console.log(`Autonomous tick: ${r}. ${auto.lastResult}. The running daemon (PID ${other}) will process it.`);
    process.exit(0);
  }
  if (other) {
    console.log(`Another harness daemon is already running for this folder (PID ${other}). Not starting a second one.`);
    process.exit(0);
  }
  fs.writeFileSync(FILES.pid, String(process.pid));
  try { fs.writeFileSync(FILES.live, ''); } catch { /* ignore */ }
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
    if (tickMode) {
      const r = await autonomousTick('manual-tick');
      while (draining || queue.length) await new Promise((res) => setTimeout(res, 100));
      const c = backlogCounts(readBacklog());
      console.log(`Autonomous tick: ${r} — ${auto.lastResult}. Backlog now: READY ${c.READY}, IN_PROGRESS ${c.IN_PROGRESS}, DONE ${c.DONE}, BLOCKED ${c.BLOCKED}.`);
    }
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
  if (auto.enabled) {
    logTelemetry('AUTO_START', `Autonomous controller on, every ${auto.intervalSec}s`);
    writeState({ mode: 'AUTONOMOUS CONTROLLER' });
    refreshAutoStatus('starting');
    setTimeout(() => autonomousTick('startup').catch((e) => logTelemetry('AUTO_ERROR', e.message)), 500);
    setInterval(() => { if (!draining) autonomousTick('interval').catch((e) => logTelemetry('AUTO_ERROR', e.message)); }, auto.intervalSec * 1000);
  } else refreshAutoStatus();
}
