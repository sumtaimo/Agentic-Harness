#!/usr/bin/env node
/**
 * .harness/start.mjs — interactive launcher and live status overview for the Agentic Harness.
 *
 *   npm start                         open the numbered menu (live banner + [1]..[6])
 *   node .harness/start.mjs           same interactive launcher
 *   node .harness/start.mjs --summary print the live overview banner and exit 0
 *   node .harness/start.mjs --json    print the collected status summary as JSON and exit 0
 *   node .harness/start.mjs --help    print this help and exit 0
 *
 * Read-only until you choose an action; asks before running dispatches, approvals, rollbacks, or merges.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ROOT, HARNESS_DIR, DIRS, FILES, ensureDirs, loadConfig, readJsonSafe, detectVerifyCmd,
  probeEngine, engineConsent, ROUTABLE_ENGINES, usageTodayLine, checkCore, listLessons, helpIfAsked
} from './lib/common.mjs';
import { readCharter, readBacklog, backlogCounts } from './lib/governance.mjs';
import { listVisibleRuns, VISIBLE_TERMINAL, RESUMABLE_STATUSES, editorDisplayName } from './lib/handoff.mjs';

const ENGINE_NAME = { claude: 'claude', antigravity: 'antigravity (agy)', codex: 'codex' };
const normalizeEngineArg = (raw) => {
  const k = String(raw || '').trim().toLowerCase();
  if (!k || k === 'auto') return '';
  return k === 'agy' ? 'antigravity' : k;
};

function safeCountJson(dir) {
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length; } catch { return 0; }
}

function readSessionsSummary() {
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 }).trim();
    if (!fs.existsSync(path.resolve(ROOT, common, 'harness-sessions.json'))) return null;
    const raw = execFileSync(process.execPath, [path.join(HARNESS_DIR, 'sessions.mjs'), 'board', '--json'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 });
    const data = JSON.parse(raw);
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    const open = tasks.filter((t) => !['MERGED', 'CLEANED'].includes(t.status));
    const done = open.filter((t) => t.status === 'DONE');
    const highRisk = open.filter((t) => t.risk);
    return { base: data.base || 'main', maxActive: data.maxActive || 4, tasks, open, done, highRisk };
  } catch {
    return null;
  }
}

export function collectStatus() {
  let cfg = {};
  let configError = null;
  try { cfg = loadConfig(); } catch (e) { configError = e.message; }

  let pid = 0;
  try {
    const rawPid = Number(fs.readFileSync(FILES.pid, 'utf8').trim());
    if (Number.isInteger(rawPid) && rawPid > 0) { process.kill(rawPid, 0); pid = rawPid; }
  } catch { pid = 0; }

  const state = readJsonSafe(FILES.state, {});
  const charter = (() => { try { return readCharter(); } catch { return { autonomous: false, text: '' }; } })();
  const bl = (() => { try { return readBacklog(); } catch { return { tasks: [] }; } })();
  const bCounts = backlogCounts(bl);
  const held = (bl.tasks || []).filter((t) => t.status === 'BLOCKED' && t.needsApproval);

  const allRuns = listVisibleRuns();
  const openRuns = allRuns.filter((r) => !VISIBLE_TERMINAL.has(r.status));
  const stoppedRuns = allRuns.filter((r) => r.status === 'HALTED_HITL_REQUIRED' || r.status === 'ESCALATED');

  let verify = { cmd: cfg.defaultVerifyCmd || '(none)', source: 'unavailable', real: false };
  try { if (cfg && Object.keys(cfg).length) verify = detectVerifyCmd(ROOT, cfg); } catch { /* ignore */ }

  const envEngines = process.env.HARNESS_ENGINES !== undefined
    ? process.env.HARNESS_ENGINES.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : null;
  const engines = ROUTABLE_ENGINES.filter((k) => cfg.profiles?.[k]).map((k) => {
    let status = 'not installed';
    if (envEngines && envEngines.length) {
      status = !envEngines.includes(k) ? 'not installed' : engineConsent(k) === false ? 'denied' : 'ready';
    } else {
      const probe = probeEngine(cfg.profiles[k]);
      const consent = engineConsent(k);
      if (!probe.installed) status = 'not installed';
      else if (!probe.compatible) status = 'incompatible';
      else if (consent === true) status = 'ready';
      else if (consent === false) status = 'denied';
      else status = 'awaiting consent';
    }
    return { name: k, label: ENGINE_NAME[k] || k, status };
  });

  const sessions = readSessionsSummary();
  const usageToday = (() => { try { return usageTodayLine(cfg) || ''; } catch { return ''; } })();
  const taughtCount = (() => { try { return listLessons(FILES.lessons).length; } catch { return 0; } })();
  const core = (() => { try { return checkCore(ROOT); } catch { return { manifest: null, changed: [], missing: [], added: [] }; } })();

  return {
    root: ROOT,
    configError,
    controller: {
      running: pid > 0,
      pid: pid || null,
      phase: state.phase || null,
      taskTitle: state.taskTitle || null
    },
    autonomous: !!charter.autonomous,
    verify,
    backlog: {
      counts: bCounts,
      held: held.map((t) => ({ id: t.id, title: t.title || t.goal || t.id, blockedReason: t.blockedReason || '' }))
    },
    queues: {
      inbox: safeCountJson(DIRS.inbox),
      completed: safeCountJson(DIRS.completed),
      failed: safeCountJson(DIRS.failed)
    },
    visible: {
      open: openRuns.map((r) => ({ id: r.id, title: r.title, status: r.status, editor: r.editor || 'claude-code', resumable: RESUMABLE_STATUSES.has(r.status) })),
      stopped: stoppedRuns.map((r) => ({ id: r.id, title: r.title, status: r.status, editor: r.editor || 'claude-code' }))
    },
    engines,
    sessions,
    usageToday,
    taughtCount,
    coreModified: [...(core.changed || []), ...(core.missing || [])]
  };
}

export function formatSummary(info) {
  const c = info.backlog.counts;
  const ctrl = info.controller.running
    ? `running (PID ${info.controller.pid}${info.controller.phase ? `, ${info.controller.phase}` : ''}${info.controller.taskTitle ? `: "${info.controller.taskTitle}"` : ''})`
    : 'NOT running';
  const auto = info.autonomous ? 'ON' : 'off';
  const verifyStr = info.verify.real ? info.verify.cmd : `${info.verify.cmd} (NO real check)`;
  const blStr = `READY ${c.READY} · IN_PROGRESS ${c.IN_PROGRESS} · BLOCKED ${c.BLOCKED} · DONE ${c.DONE} · BACKLOG ${c.BACKLOG}`;

  let editorStr = 'none open';
  if (info.visible.open.length) {
    const r = info.visible.open[0];
    const ed = r.editor ? `, ${editorDisplayName(r.editor)}` : '';
    const extra = info.visible.open.length > 1 ? ` (+${info.visible.open.length - 1} more)` : '';
    editorStr = `Open run ${r.id} ("${r.title}", ${r.status}${ed})${extra}`;
  } else if (info.visible.stopped.length) {
    const s = info.visible.stopped[info.visible.stopped.length - 1];
    editorStr = `Stopped run ${s.id} ("${s.title}", ${s.status})`;
  }

  const heldStr = info.backlog.held.length
    ? `${info.backlog.held.length} held item(s): ${info.backlog.held.slice(0, 3).map((t) => `${t.id} ("${t.title}")`).join(', ')}`
    : 'none';

  const toolStr = info.engines.length
    ? info.engines.map((e) => `${e.name}: ${e.status}`).join(' · ')
    : 'none configured';

  let sessStr = 'none active (use [5] to coordinate child sessions)';
  if (info.sessions) {
    const s = info.sessions;
    const parts = [`${s.open.length}/${s.maxActive} open`];
    if (s.done.length) parts.push(`${s.done.length} DONE (${s.done.map((t) => t.id).join(', ')})`);
    if (s.highRisk.length) parts.push(`${s.highRisk.length} HIGH RISK (${s.highRisk.map((t) => t.id).join(', ')})`);
    sessStr = parts.join(' · ');
  }

  const lines = [
    '============================================================================',
    `AGENTIC HARNESS — Start Menu & Status   (${info.root})`,
    '----------------------------------------------------------------------------',
    `Controller:    ${ctrl}   |   Autopilot: ${auto}`,
    `Verify cmd:    ${verifyStr}`,
    `Backlog:       ${blStr}   (inbox ${info.queues.inbox} · failed ${info.queues.failed})`,
    `Editor run:    ${editorStr}`,
    `Needs OK:      ${heldStr}`,
    `AI tools:      ${toolStr}`,
    `Session board: ${sessStr}`,
    `Quota today:   ${info.usageToday || 'none logged yet'}   |   Memory: ${info.taughtCount} taught rule(s)`
  ];
  if (info.configError) lines.push(`! Config error: ${info.configError}`);
  if (info.coreModified.length) lines.push(`! Core warning: edited files in this project: ${info.coreModified.join(', ')}`);
  lines.push('============================================================================');
  return lines.join('\n');
}

export function runScript(scriptName, scriptArgs = [], { extraEnv = {} } = {}) {
  const scriptPath = path.join(HARNESS_DIR, scriptName);
  console.log(`\n> node .harness/${scriptName}${scriptArgs.length ? ` ${scriptArgs.join(' ')}` : ''}\n`);
  const res = spawnSync(process.execPath, [scriptPath, ...scriptArgs], {
    cwd: ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, ...extraEnv }
  });
  return res.status ?? 1;
}

async function confirm(ask, prompt, defaultYes = false) {
  const raw = await ask(prompt);
  if (raw === null) return false;
  const s = raw.trim().toLowerCase();
  if (!s) return defaultYes;
  return s === 'y' || s === 'yes';
}

export async function menuContinue(_rl, ask, info) {
  const candidates = info.visible.open.length ? info.visible.open : info.visible.stopped;
  if (!candidates.length) {
    console.log('\nNo open or stopped editor runs found in .harness/visible/.');
    return;
  }
  console.log('\nUnfinished / stopped editor runs:');
  candidates.forEach((r, i) => {
    console.log(`  ${i === 0 ? '*' : ' '} ${r.id}  [${r.status}]  ${r.title}  (${editorDisplayName(r.editor)})`);
  });

  let target = candidates[0];
  if (candidates.length > 1) {
    const pick = await ask(`Run ID to manage (Enter = ${candidates[0].id}): `);
    if (pick === null) return;
    if (pick.trim()) {
      const found = candidates.find((r) => r.id.toLowerCase() === pick.trim().toLowerCase());
      if (!found) { console.log(`Unknown run ID "${pick.trim()}".`); return; }
      target = found;
    }
  }

  console.log(`\nRun ${target.id} (${target.status}):`);
  console.log('  [1] View handoff report & continuation prompt (visible.mjs handoff)');
  console.log('  [2] Print continuation prompt only (copy-paste to another editor)');
  console.log('  [3] Resume in terminal until done (dispatch.mjs --resume-visible --wait)');
  console.log('  [4] Verify now (visible.mjs verify)');
  console.log('  [5] Rollback all changes to pre-run snapshot (visible.mjs rollback)');
  console.log('  [0] Back');

  const sub = await ask('Choose [0-5]: ');
  if (sub === null) return;
  const choice = sub.trim();
  if (!choice || choice === '0') return;

  if (choice === '1') { runScript('visible.mjs', ['handoff', target.id]); return; }
  if (choice === '2') { runScript('visible.mjs', ['handoff', target.id, '--prompt']); return; }
  if (choice === '3') {
    const readyList = info.engines.filter((e) => e.status === 'ready').map((e) => e.name);
    const engRaw = await ask(`AI engine (auto, claude, antigravity/agy, codex${readyList.length ? `; ready: ${readyList.join(', ')}` : ''}) [auto]: `);
    if (engRaw === null) return;
    const eng = normalizeEngineArg(engRaw);
    const args = ['--resume-visible', target.id, ...(eng ? ['--engine', eng] : []), '--wait'];
    console.log(`Preview: node .harness/dispatch.mjs ${args.join(' ')}`);
    if (!await confirm(ask, 'Start headless resume now? [Y/n] ', true)) { console.log('Cancelled.'); return; }
    runScript('dispatch.mjs', args, { extraEnv: { HARNESS_YES: '1' } });
    return;
  }
  if (choice === '4') { runScript('visible.mjs', ['verify', target.id]); return; }
  if (choice === '5') {
    console.log(`WARNING: rollback discards all uncommitted changes made during run ${target.id}.`);
    if (!await confirm(ask, `Rollback run ${target.id}? [y/N] `, false)) { console.log('Rollback cancelled.'); return; }
    runScript('visible.mjs', ['rollback', target.id]);
    return;
  }
  console.log(`Unknown option "${choice}".`);
}

export async function menuDispatch(_rl, ask, info) {
  console.log('\nStart a new task (headless dispatch):');
  const goalRaw = await ask('Goal (what should the AI do? Enter cancels): ');
  if (goalRaw === null || !goalRaw.trim()) { console.log('Cancelled.'); return; }
  const goal = goalRaw.trim();

  console.log('Execution mode:');
  console.log('  [1] normal   — 1 direct worker (fastest, lowest quota)');
  console.log('  [2] parallel — AI planner splits into parallel workers');
  console.log('  [3] team     — orchestrator -> BA/DEV/QA leads -> workers');
  const modeRaw = await ask('Choose mode [1]: ');
  if (modeRaw === null) return;
  const mTrim = modeRaw.trim().toLowerCase();
  const mode = (mTrim === '2' || mTrim === 'parallel') ? 'parallel' : (mTrim === '3' || mTrim === 'team') ? 'team' : 'normal';

  let maxCost = '';
  if (mode === 'team') {
    const costRaw = await ask('Max cost cap in USD (--max-cost, optional, e.g. 2): ');
    if (costRaw === null) return;
    const ct = costRaw.trim();
    if (ct && (!Number.isFinite(Number(ct)) || Number(ct) < 0)) { console.log('Invalid --max-cost number; cancelled.'); return; }
    maxCost = ct;
  }

  const filesRaw = await ask('Allowed files/folders (comma-separated, e.g. src/,tests/ — recommended for undo; Enter = unrestricted): ');
  if (filesRaw === null) return;
  const files = filesRaw.trim();

  const checkRaw = await ask(`Verify command (Enter = auto "${info.verify.cmd}"): `);
  if (checkRaw === null) return;
  const check = checkRaw.trim();

  const engRaw = await ask('AI engine (auto, claude, antigravity/agy, codex) [auto]: ');
  if (engRaw === null) return;
  const eng = normalizeEngineArg(engRaw);

  const args = ['--goal', goal, '--mode', mode];
  if (files) args.push('--files', files);
  if (check) args.push('--check', check);
  if (eng) args.push('--engine', eng);
  if (maxCost) args.push('--max-cost', maxCost);
  args.push('--wait');

  const quote = (s) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
  console.log(`\nCommand preview:\n  node .harness/dispatch.mjs ${args.map(quote).join(' ')}`);
  if (mode !== 'normal') console.log(`Note: '${mode}' mode uses planning + multi-worker calls (extra AI quota).`);
  if (!await confirm(ask, 'Run this task now? [Y/n] ', true)) { console.log('Cancelled.'); return; }
  runScript('dispatch.mjs', args, { extraEnv: { HARNESS_YES: '1' } });
}

export async function menuSetup(_rl, ask) {
  console.log('\nSetup & AI tool permissions:');
  console.log('  [1] Health check (doctor.mjs)');
  console.log('  [2] Deep health check with live CLI probes (doctor.mjs --deep)');
  console.log('  [3] List, allow, or deny AI tools (engines.mjs)');
  console.log('  [4] Auto-assign team engines to installed CLIs (team.mjs auto-assign)');
  console.log('  [5] Sync editor named agents (team.mjs sync-agents)');
  console.log('  [6] Show agent team & budgets (team.mjs show)');
  console.log('  [0] Back');

  const sub = await ask('Choose [0-6]: ');
  if (sub === null) return;
  const choice = sub.trim();
  if (!choice || choice === '0') return;

  if (choice === '1') { runScript('doctor.mjs'); return; }
  if (choice === '2') { runScript('doctor.mjs', ['--deep']); return; }
  if (choice === '3') {
    runScript('engines.mjs', ['list']);
    const ans = await ask('Change permission? Enter "allow <tool>" or "deny <tool>" (claude, agy, codex), or Enter to go back: ');
    if (ans === null || !ans.trim()) return;
    const parts = ans.trim().split(/\s+/);
    const verb = parts[0]?.toLowerCase();
    const tool = parts[1]?.toLowerCase();
    if ((verb === 'allow' || verb === 'deny') && tool) {
      runScript('engines.mjs', [verb, tool]);
    } else {
      console.log('Expected: allow <tool> or deny <tool> (for example: allow claude).');
    }
    return;
  }
  if (choice === '4') {
    runScript('team.mjs', ['auto-assign', '--dry-run']);
    if (!await confirm(ask, 'Write this engine routing to .harness/team.json? [y/N] ', false)) { console.log('Not changed.'); return; }
    runScript('team.mjs', ['auto-assign']);
    return;
  }
  if (choice === '5') { runScript('team.mjs', ['sync-agents']); return; }
  if (choice === '6') { runScript('team.mjs', ['show']); return; }
  console.log(`Unknown option "${choice}".`);
}

export async function menuBacklog(_rl, ask, info) {
  console.log('\nBacklog & Autopilot:');
  console.log('  [1] View backlog & release snapshots (backlog.mjs overview)');
  console.log(`  [2] Approve held big item ("Needs OK" -> READY)${info.backlog.held.length ? ` [${info.backlog.held.length} waiting]` : ''}`);
  console.log('  [3] Add a new backlog task (backlog.mjs add)');
  console.log('  [4] Run one Autopilot step now (daemon.mjs --tick)');
  console.log('  [5] Start Autopilot loop on uat branch (daemon.mjs --autonomous)');
  console.log('  [6] Mark a BLOCKED or BACKLOG item READY (backlog.mjs ready <id>)');
  console.log('  [0] Back');

  const sub = await ask('Choose [0-6]: ');
  if (sub === null) return;
  const choice = sub.trim();
  if (!choice || choice === '0') return;

  if (choice === '1') { runScript('backlog.mjs', ['overview']); return; }
  if (choice === '2') {
    if (!info.backlog.held.length) { console.log('No backlog items are waiting for approval ("Needs OK").'); return; }
    console.log('\nHeld items waiting for your OK:');
    for (const h of info.backlog.held) {
      console.log(`  - ${h.id}: ${h.title}${h.blockedReason ? ` (${h.blockedReason})` : ''}`);
    }
    const defId = info.backlog.held[0].id;
    const rawId = await ask(`Backlog ID to approve [${defId}]: `);
    if (rawId === null) return;
    const id = rawId.trim() || defId;
    if (!await confirm(ask, `Approve ${id} for team/parallel or high-tier execution? [y/N] `, false)) { console.log('Not approved.'); return; }
    runScript('backlog.mjs', ['approve', id]);
    return;
  }
  if (choice === '3') {
    const titleRaw = await ask('Task title (Enter cancels): ');
    if (titleRaw === null || !titleRaw.trim()) { console.log('Cancelled.'); return; }
    const goalRaw = await ask('Detailed goal (Enter = same as title): ');
    if (goalRaw === null) return;
    const filesRaw = await ask('Target files/folders (comma-separated, optional): ');
    if (filesRaw === null) return;
    const checkRaw = await ask('Verify command (optional, e.g. npm test): ');
    if (checkRaw === null) return;
    const statusRaw = await ask('Initial status ([1] READY / [2] BACKLOG) [1]: ');
    if (statusRaw === null) return;
    const isBacklog = statusRaw.trim() === '2' || /^backlog$/i.test(statusRaw.trim());
    const args = ['add', titleRaw.trim()];
    if (goalRaw.trim()) args.push('--goal', goalRaw.trim());
    if (filesRaw.trim()) args.push('--files', filesRaw.trim());
    if (checkRaw.trim()) args.push('--check', checkRaw.trim());
    if (!isBacklog) args.push('--ready');
    runScript('backlog.mjs', args);
    return;
  }
  if (choice === '4') { runScript('daemon.mjs', ['--tick']); return; }
  if (choice === '5') {
    if (!info.autonomous) console.log('Note: .harness/charter.md currently has "- autonomous: off".');
    if (!await confirm(ask, 'Start Autopilot loop in this terminal (builds onto branch uat; Ctrl+C stops)? [y/N] ', false)) { console.log('Cancelled.'); return; }
    runScript('daemon.mjs', ['--autonomous']);
    return;
  }
  if (choice === '6') {
    const idRaw = await ask('Backlog ID to set READY: ');
    if (idRaw === null || !idRaw.trim()) return;
    runScript('backlog.mjs', ['ready', idRaw.trim()]);
    return;
  }
  console.log(`Unknown option "${choice}".`);
}

export async function menuSessions(_rl, ask, info) {
  console.log('\nSession board (child sessions):');
  console.log('  [1] View session board (sessions.mjs board)');
  console.log('  [2] Create new child task & branch brief (sessions.mjs new)');
  console.log('  [3] Merge a DONE task into base after checks (sessions.mjs merge)');
  console.log('  [4] Cleanup merged worktrees & branches (sessions.mjs cleanup)');
  console.log('  [0] Back');

  const sub = await ask('Choose [0-4]: ');
  if (sub === null) return;
  const choice = sub.trim();
  if (!choice || choice === '0') return;

  if (choice === '1') { runScript('sessions.mjs', ['board']); return; }
  if (choice === '2') {
    const titleRaw = await ask('Child task title (Enter cancels): ');
    if (titleRaw === null || !titleRaw.trim()) { console.log('Cancelled.'); return; }
    const typeRaw = await ask('Type ([1] feat / [2] bug / [3] task) [1]: ');
    if (typeRaw === null) return;
    const t = typeRaw.trim().toLowerCase();
    const type = (t === '2' || t === 'bug') ? 'bug' : (t === '3' || t === 'task') ? 'task' : 'feat';
    runScript('sessions.mjs', ['new', titleRaw.trim(), '--type', type]);
    return;
  }
  if (choice === '3') {
    const doneIds = (info.sessions?.done || []).map((x) => x.id);
    if (doneIds.length) console.log(`Tasks reported DONE: ${doneIds.join(', ')}`);
    const idRaw = await ask(`Task ID to merge${doneIds.length ? ` [${doneIds[0]}]` : ''}: `);
    if (idRaw === null) return;
    const id = idRaw.trim() || doneIds[0];
    if (!id) { console.log('Cancelled.'); return; }
    if (!await confirm(ask, `Run verify check and merge ${id} into base branch? [y/N] `, false)) { console.log('Merge cancelled.'); return; }
    runScript('sessions.mjs', ['merge', id]);
    return;
  }
  if (choice === '4') { runScript('sessions.mjs', ['cleanup']); return; }
  console.log(`Unknown option "${choice}".`);
}

export async function menuUsageAndStatus(_rl, ask) {
  console.log('\nUsage, status & memory:');
  console.log('  [1] AI usage / quota — last 7 days (usage.mjs)');
  console.log('  [2] AI usage / quota — last 30 days (usage.mjs --days 30)');
  console.log('  [3] Controller status & last 20 events (status.mjs --log 20)');
  console.log('  [4] Editor workflow runs (visible.mjs status)');
  console.log('  [5] Memory rules & auto-lessons (or teach a new rule)');
  console.log('  [6] Short workspace summary (hook-session.mjs --brief)');
  console.log('  [0] Back');

  const sub = await ask('Choose [0-6]: ');
  if (sub === null) return;
  const choice = sub.trim();
  if (!choice || choice === '0') return;

  if (choice === '1') { runScript('usage.mjs'); return; }
  if (choice === '2') { runScript('usage.mjs', ['--days', '30']); return; }
  if (choice === '3') { runScript('status.mjs', ['--log', '20']); return; }
  if (choice === '4') { runScript('visible.mjs', ['status']); return; }
  if (choice === '5') {
    runScript('memory.mjs', ['list']);
    const rule = await ask('Teach AI a new rule? (type rule or Enter to skip): ');
    if (rule !== null && rule.trim()) runScript('memory.mjs', ['remember', rule.trim()]);
    return;
  }
  if (choice === '6') { runScript('hook-session.mjs', ['--brief']); return; }
  console.log(`Unknown option "${choice}".`);
}

function printMainMenu(info) {
  const openHint = info.visible.open.length ? `  [${info.visible.open.length} open: ${info.visible.open[0].id}]` : info.visible.stopped.length ? `  [stopped: ${info.visible.stopped[info.visible.stopped.length - 1].id}]` : '';
  const heldHint = info.backlog.held.length ? `  [${info.backlog.held.length} Needs OK!]` : '';
  const riskHint = info.sessions?.highRisk?.length ? `  [${info.sessions.highRisk.length} HIGH RISK!]` : '';

  console.log('\nActions:');
  console.log(`  [1] Continue unfinished work      handoff / resume / verify / rollback${openHint}`);
  console.log('  [2] Start a new task              dispatch (normal, parallel, or team)');
  console.log('  [3] Setup & AI tool permissions   doctor, allow/deny AI tools, team routing');
  console.log(`  [4] Backlog & Autopilot           overview, approve, add, tick, auto${heldHint}`);
  console.log(`  [5] Session board                 child sessions, new, merge, cleanup${riskHint}`);
  console.log('  [6] Usage, status & memory        quota (7d/30d), logs, memory, --brief');
  console.log('  [0] Exit');
}

export async function runMenu({ input = process.stdin, output = process.stdout } = {}) {
  const isTty = Boolean(input.isTTY);
  const rl = readline.createInterface({ input, output, terminal: isTty });
  const queue = [];
  const waiters = [];
  let closed = false;
  rl.on('line', (line) => {
    if (waiters.length) waiters.shift()(line);
    else queue.push(line);
  });
  rl.on('close', () => {
    closed = true;
    while (waiters.length) waiters.shift()(null);
  });
  rl.on('SIGINT', () => rl.close());
  const ask = (prompt) => {
    if (queue.length) { output.write(prompt); return Promise.resolve(queue.shift()); }
    if (closed) return Promise.resolve(null);
    if (isTty) { rl.setPrompt(prompt); rl.prompt(); }
    else output.write(prompt);
    return new Promise((resolve) => waiters.push(resolve));
  };

  try {
    for (;;) {
      const info = collectStatus();
      console.log(`\n${formatSummary(info)}`);
      printMainMenu(info);
      const ans = await ask('\nSelect [0-6]: ');
      if (ans === null) break;
      const choice = ans.trim().toLowerCase();
      if (choice === '0' || choice === 'q' || choice === 'quit' || choice === 'exit') {
        console.log('Bye!');
        break;
      }
      if (choice === '1') await menuContinue(rl, ask, info);
      else if (choice === '2') await menuDispatch(rl, ask, info);
      else if (choice === '3') await menuSetup(rl, ask, info);
      else if (choice === '4') await menuBacklog(rl, ask, info);
      else if (choice === '5') await menuSessions(rl, ask, info);
      else if (choice === '6') await menuUsageAndStatus(rl, ask, info);
      else if (choice === '') continue;
      else console.log(`Unknown choice "${ans.trim()}". Enter a number from 0 to 6.`);
    }
  } finally {
    rl.close();
  }
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
})();

if (isMain) {
  helpIfAsked(import.meta.url);
  if (process.env.HARNESS_WORKER === '1') {
    console.error('Refusing to open the interactive harness launcher inside a harness worker.');
    process.exit(2);
  }
  const argv = process.argv.slice(2);
  if (argv.includes('--json')) {
    console.log(JSON.stringify(collectStatus(), null, 2));
    process.exit(0);
  }
  if (argv.includes('--summary')) {
    console.log(formatSummary(collectStatus()));
    process.exit(0);
  }
  ensureDirs();
  await runMenu();
}
