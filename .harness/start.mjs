#!/usr/bin/env node
/**
 * .harness/start.mjs — interactive launcher and live status overview for the Agentic Harness.
 *
 *   node .harness/start.mjs           open the numbered menu (live banner + [1]..[6])
 *   npm start                         alias for the launcher when configured (e.g. template repo)
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
  probeEngine, engineConsent, ROUTABLE_ENGINES, usageTodayLine, quotaWarnings, formatQuotaWarning, checkCore, listLessons, helpIfAsked
} from './lib/common.mjs';
import { readCharter, readBacklog, backlogCounts, nextReady, loadRoles, loadTeam, validateTeam, syncAgents } from './lib/governance.mjs';
import { listVisibleRuns, VISIBLE_TERMINAL, RESUMABLE_STATUSES, editorDisplayName, hasVisibleBaseline, visibleRunDir } from './lib/handoff.mjs';

const ENGINE_NAME = { claude: 'claude', antigravity: 'antigravity (agy)', codex: 'codex' };
const normalizeEngineArg = (raw) => {
  const k = String(raw || '').trim().toLowerCase();
  if (!k || k === 'auto') return '';
  return k === 'agy' ? 'antigravity' : k;
};

function readHarnessVersion(core) {
  if (core?.manifest?.version) return String(core.manifest.version);
  const pkg = readJsonSafe(path.join(ROOT, 'package.json'), null);
  return pkg?.name === 'agentic-harness' && pkg.version ? String(pkg.version) : '';
}

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

export function collectStatus({ skipSessions = false } = {}) {
  let cfg = {};
  let configError = null;
  try { cfg = loadConfig(); } catch (e) { configError = e.message; }

  let pid = 0;
  try {
    const rawPid = Number(fs.readFileSync(FILES.pid, 'utf8').trim());
    if (Number.isInteger(rawPid) && rawPid > 0) { process.kill(rawPid, 0); pid = rawPid; }
  } catch { pid = 0; }

  const state = readJsonSafe(FILES.state, {});
  const charter = (() => { try { return readCharter(); } catch { return { exists: false, autonomous: false, maxAutoTasksPerRun: 3, requireRealCheck: true, text: '' }; } })();
  const bl = (() => { try { return readBacklog(); } catch { return { tasks: [] }; } })();
  const bCounts = backlogCounts(bl);
  const held = (bl.tasks || []).filter((t) => t.status === 'BLOCKED' && t.needsApproval);

  const allRuns = listVisibleRuns();
  const openRuns = allRuns.filter((r) => !VISIBLE_TERMINAL.has(r.status)).reverse();
  const stoppedRuns = allRuns.filter((r) => r.status === 'HALTED_HITL_REQUIRED' || r.status === 'ESCALATED').reverse();

  let verify = { cmd: cfg.defaultVerifyCmd || '(none)', source: 'unavailable', real: false };
  try { if (cfg && Object.keys(cfg).length) verify = detectVerifyCmd(ROOT, cfg); } catch { /* ignore */ }

  const rawEnvEngines = process.env.HARNESS_ENGINES;
  const explicitNoneEngines = rawEnvEngines !== undefined && rawEnvEngines.trim().toLowerCase() === 'none';
  const envEngines = rawEnvEngines !== undefined && !explicitNoneEngines
    ? rawEnvEngines.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : null;
  const engines = ROUTABLE_ENGINES.filter((k) => cfg.profiles?.[k]).map((k) => {
    let status = 'not installed';
    if (explicitNoneEngines) {
      status = 'not installed';
    } else if (envEngines && envEngines.length) {
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

  const sessions = skipSessions ? null : readSessionsSummary();
  const usageToday = (() => { try { return usageTodayLine(cfg) || ''; } catch { return ''; } })();
  const quotaWarnList = (() => { try { return quotaWarnings(cfg); } catch { return []; } })();
  const taughtCount = (() => { try { return listLessons(FILES.lessons).length; } catch { return 0; } })();
  const autoLessonsCount = (() => { try { return listLessons(FILES.autoLessons).length; } catch { return 0; } })();
  const core = (() => { try { return checkCore(ROOT); } catch { return { manifest: null, changed: [], missing: [], added: [] }; } })();
  const inboxCount = safeCountJson(DIRS.inbox);

  const teamInfo = (() => {
    try {
      const team = loadTeam();
      if (!team) return null;
      const roles = loadRoles();
      const { errors, warnings } = validateTeam(team, { roles, charter, plannerMaxWorkers: (cfg.planner || {}).maxWorkers || 4, engines: Object.keys(cfg.profiles || {}) });
      const ag = syncAgents(team, roles, { check: true });
      const members = Array.isArray(team.members) ? team.members : [];
      const orch = members.find((m) => m.level === 'orchestrator');
      const leads = members.filter((m) => m.level === 'lead');
      return {
        configured: true,
        valid: errors.length === 0,
        errorCount: errors.length,
        warningCount: warnings.length,
        errors,
        warnings,
        agentsInSync: (ag.stale || []).length === 0,
        staleAgents: ag.stale || [],
        orchestrator: orch ? { id: orch.id, engine: orch.engine || 'auto' } : null,
        leadCount: leads.length,
        routedCount: members.filter((m) => Boolean(m.engine)).length
      };
    } catch {
      return null;
    }
  })();

  const gitInfo = (() => {
    const g = (a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 }).trim();
    try {
      if (g(['rev-parse', '--is-inside-work-tree']) !== 'true') return { isRepo: false };
      const branch = (() => { try { return g(['symbolic-ref', '--short', 'HEAD']); } catch { return '(detached)'; } })();
      const dirtyCount = (() => { try { const st = g(['status', '--porcelain']); return st ? st.split(/\r?\n/).filter(Boolean).length : 0; } catch { return 0; } })();
      const integrationBranch = cfg.git?.integrationBranch || 'uat';
      const uatTip = (() => { try { return g(['rev-parse', '--short', integrationBranch]); } catch { return null; } })();
      const workerBranches = (() => {
        try {
          const out = g(['branch', '--list', 'harness/*']);
          return out ? out.split(/\r?\n/).map((s) => s.replace(/^\*?\s+/, '').trim()).filter(Boolean).length : 0;
        } catch { return 0; }
      })();
      return { isRepo: true, branch, dirtyCount, integrationBranch, uatExists: Boolean(uatTip), uatTip, workerBranches };
    } catch {
      return { isRepo: false };
    }
  })();

  const stagingLeftovers = (() => { try { return fs.readdirSync(DIRS.staging).filter((d) => !d.startsWith('.')); } catch { return []; } })();
  const staleInProgress = (pid === 0 && inboxCount === 0)
    ? (bl.tasks || []).filter((t) => t.status === 'IN_PROGRESS').map((t) => t.id)
    : [];
  const profileIncomplete = /^- .*\(fill me/im.test((() => { try { return fs.readFileSync(FILES.profile, 'utf8'); } catch { return ''; } })());

  return {
    root: ROOT,
    version: readHarnessVersion(core),
    configError,
    controller: {
      running: pid > 0,
      pid: pid || null,
      phase: state.phase || null,
      taskTitle: state.taskTitle || null
    },
    autonomous: !!charter.autonomous,
    charter: {
      exists: Boolean(charter.exists),
      autonomous: Boolean(charter.autonomous),
      maxAutoTasksPerRun: charter.maxAutoTasksPerRun ?? 3,
      requireRealCheck: charter.requireRealCheck !== false,
      hasPlaceholder: /\(describe your product goals here/.test(charter.text || '')
    },
    team: teamInfo,
    git: gitInfo,
    verify,
    backlog: {
      counts: bCounts,
      held: held.map((t) => ({ id: t.id, title: t.title || t.goal || t.id, blockedReason: t.blockedReason || '' }))
    },
    queues: {
      inbox: inboxCount,
      completed: safeCountJson(DIRS.completed),
      failed: safeCountJson(DIRS.failed)
    },
    visible: {
      open: openRuns.map((r) => ({ id: r.id, title: r.title, status: r.status, editor: r.editor || 'claude-code', resumable: RESUMABLE_STATUSES.has(r.status), hasBaseline: hasVisibleBaseline(r), hasReport: fs.existsSync(path.join(visibleRunDir(r.id), 'report.md')) })),
      stopped: stoppedRuns.map((r) => ({ id: r.id, title: r.title, status: r.status, editor: r.editor || 'claude-code', resumable: RESUMABLE_STATUSES.has(r.status), hasBaseline: hasVisibleBaseline(r), hasReport: fs.existsSync(path.join(visibleRunDir(r.id), 'report.md')) }))
    },
    engines,
    sessions,
    usageToday,
    quotaWarnings: quotaWarnList,
    taughtCount,
    warnings: {
      stagingLeftovers,
      staleInProgress,
      profileIncomplete,
      autoLessonsCount
    },
    coreModified: [...(core.changed || []), ...(core.missing || []), ...(core.added || [])]
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
    const s = info.visible.stopped[0];
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

  const teamStr = !info.team
    ? 'no team.json'
    : !info.team.valid
      ? `INVALID (${info.team.errorCount} err)`
      : !info.team.agentsInSync
        ? `valid (${info.team.leadCount} leads; ${info.team.staleAgents.length} agent(s) out of sync)`
        : `valid (${info.team.leadCount} leads, agents in sync)`;
  const gitStr = info.git?.isRepo
    ? `git: ${info.git.branch}${info.git.dirtyCount ? ` (${info.git.dirtyCount} uncommitted)` : ' (clean)'}${info.git.uatExists ? ` · ${info.git.integrationBranch}@${info.git.uatTip}` : ''}`
    : 'git: not a repo';

  const lines = [
    '============================================================================',
    `AGENTIC HARNESS${info.version ? ` v${info.version}` : ''} — Start Menu & Status   (${info.root})`,
    '----------------------------------------------------------------------------',
    `Controller:    ${ctrl}   |   Autopilot: ${auto}`,
    `Verify cmd:    ${verifyStr}`,
    `Backlog:       ${blStr}   (inbox ${info.queues.inbox} · failed ${info.queues.failed})`,
    `Editor run:    ${editorStr}`,
    `Needs OK:      ${heldStr}`,
    `AI tools:      ${toolStr}`,
    `Session board: ${sessStr}`,
    `Team & Git:    ${teamStr}   |   ${gitStr}`,
    `Quota today:   ${info.usageToday || 'none logged yet'}   |   Memory: ${info.taughtCount} taught · ${info.warnings?.autoLessonsCount ?? 0} auto`,
    `Quick tools:   Web UI: npm run ui (node .harness/ui.mjs)   |   Health: node .harness/doctor.mjs`
  ];
  if (info.configError) lines.push(`! Config error: ${info.configError}`);
  if (info.coreModified.length) lines.push(`! Core warning: edited files in this project: ${info.coreModified.join(', ')}`);
  if (info.charter?.hasPlaceholder) lines.push('! Charter note: "Project objectives" still has placeholder text in .harness/charter.md');
  if (info.team && !info.team.valid) lines.push(`! Team error: ${info.team.errors[0]}`);
  if (info.team && info.team.valid && info.team.staleAgents.length) lines.push(`! Team warning: editor agent(s) out of sync: ${info.team.staleAgents.join(', ')} (use [3] -> [5] or sync-agents)`);
  if (info.warnings?.stagingLeftovers?.length) lines.push(`! Staging leftovers (.harness/staging/): ${info.warnings.stagingLeftovers.join(', ')}`);
  if (info.warnings?.staleInProgress?.length) lines.push(`! Stale IN_PROGRESS backlog item(s): ${info.warnings.staleInProgress.join(', ')} (use [4] -> [6] to reset READY)`);
  if (info.warnings?.profileIncomplete) lines.push('! Profile incomplete: .harness/memory/profile.md still has "(fill me)" placeholders');
  for (const w of info.quotaWarnings || []) lines.push(`! ${formatQuotaWarning(w)}`);
  lines.push('============================================================================');
  return lines.join('\n');
}

export function runScript(scriptName, scriptArgs = [], { extraEnv = {}, allowInput = false, output = process.stdout } = {}) {
  const scriptPath = path.join(HARNESS_DIR, scriptName);
  output.write(`\n> node .harness/${scriptName}${scriptArgs.length ? ` ${scriptArgs.join(' ')}` : ''}\n\n`);
  const res = spawnSync(process.execPath, [scriptPath, ...scriptArgs], {
    cwd: ROOT,
    stdio: [allowInput ? 'inherit' : 'ignore', 'inherit', 'inherit'],
    env: { ...process.env, ...extraEnv }
  });
  return res.status ?? 1;
}

const isBack = (raw) => {
  if (raw === null) return true;
  const s = raw.trim().toLowerCase();
  return !s || s === '0' || s === 'b' || s === 'back' || s === 'q';
};

const isBackCmd = (raw) => {
  if (raw === null) return true;
  const s = raw.trim().toLowerCase();
  return s === '0' || s === 'b' || s === 'back' || s === 'q';
};

async function confirm(ask, prompt, defaultYes = false) {
  const raw = await ask(prompt);
  if (raw === null) return false;
  const s = raw.trim().toLowerCase();
  if (!s) return defaultYes;
  return s === 'y' || s === 'yes';
}

export async function menuContinue(_rl, ask, info, run = runScript, say = console.log) {
  const candidates = [...info.visible.open, ...info.visible.stopped];
  if (!candidates.length) {
    say('\nNo open or stopped editor runs found in .harness/visible/.');
    return;
  }
  say('\nUnfinished / stopped editor runs:');
  candidates.forEach((r, i) => {
    say(`  ${i === 0 ? '*' : ' '} ${r.id}  [${r.status}]  ${r.title}  (${editorDisplayName(r.editor)})`);
  });

  let target = candidates[0];
  if (candidates.length > 1) {
    const pick = await ask(`Run ID to manage (Enter = ${candidates[0].id}): `);
    if (pick === null || isBackCmd(pick)) return;
    if (pick.trim()) {
      const found = candidates.find((r) => r.id.toLowerCase() === pick.trim().toLowerCase());
      if (!found) { say(`Unknown run ID "${pick.trim()}".`); return; }
      target = found;
    }
  }

  const canResume = target.resumable !== false && RESUMABLE_STATUSES.has(target.status);
  const canVerify = target.status === 'DELEGATED' || target.status === 'FAILED';
  const canRollback = typeof target.hasBaseline === 'boolean' ? target.hasBaseline : true;
  const canReport = target.hasReport !== false;

  say(`\nRun ${target.id} (${target.status}):`);
  say('  [1] View handoff report & continuation prompt (visible.mjs handoff)');
  say('  [2] Print continuation prompt only (copy-paste to another editor)');
  say(`  [3] Resume in terminal until done (dispatch.mjs --resume-visible --wait)${canResume ? '' : `  [unavailable: ${target.status}]`}`);
  say(`  [4] Verify now (visible.mjs verify)${canVerify ? '' : `  [unavailable: ${target.status} — needs DELEGATED/FAILED]`}`);
  say(`  [5] Rollback all changes to pre-run snapshot (visible.mjs rollback)${canRollback ? '' : '  [unavailable: no baseline snapshot]'}`);
  say(`  [6] View last verification report (visible.mjs report)${canReport ? '' : '  [unavailable: verify first]'}`);
  say('  [0] Back');

  const sub = await ask('Choose [0-6]: ');
  if (isBack(sub)) return;
  const choice = sub.trim();

  if (choice === '1') { run('visible.mjs', ['handoff', target.id]); return; }
  if (choice === '2') { run('visible.mjs', ['handoff', target.id, '--prompt']); return; }
  if (choice === '3') {
    if (!canResume) {
      say(`Cannot resume run ${target.id}: status is ${target.status} (resumable: ${[...RESUMABLE_STATUSES].join(', ')}).`);
      return;
    }
    const readyList = info.engines.filter((e) => e.status === 'ready').map((e) => e.name);
    const engRaw = await ask(`AI engine (auto, claude, antigravity/agy, codex${readyList.length ? `; ready: ${readyList.join(', ')}` : ''}) [auto]: `);
    if (engRaw === null || isBackCmd(engRaw)) return;
    const eng = normalizeEngineArg(engRaw);
    const knownEngines = new Set(info.engines.map((e) => e.name));
    if (eng && knownEngines.size && !knownEngines.has(eng)) {
      say(`Unknown engine "${engRaw.trim()}". Use auto, ${[...knownEngines].join(', ')} (agy = antigravity).`);
      return;
    }
    const args = ['--resume-visible', target.id, ...(eng ? ['--engine', eng] : []), '--wait'];
    say(`Preview: node .harness/dispatch.mjs ${args.join(' ')}`);
    if (!await confirm(ask, 'Start headless resume now? [Y/n] ', true)) { say('Cancelled.'); return; }
    run('dispatch.mjs', args, { extraEnv: { HARNESS_YES: '1' }, allowInput: true });
    return;
  }
  if (choice === '4') {
    if (!canVerify) {
      say(`Cannot verify run ${target.id}: status is ${target.status}; verify requires DELEGATED or FAILED.`);
      return;
    }
    run('visible.mjs', ['verify', target.id]);
    return;
  }
  if (choice === '5') {
    if (!canRollback) {
      say(`No baseline snapshot on disk for run ${target.id}. Use git status / git checkout if needed.`);
      return;
    }
    say(`WARNING: rollback discards all uncommitted changes made during run ${target.id}.`);
    if (!await confirm(ask, `Rollback run ${target.id}? [y/N] `, false)) { say('Rollback cancelled.'); return; }
    run('visible.mjs', ['rollback', target.id]);
    return;
  }
  if (choice === '6') {
    if (!canReport) {
      say(`No verification report for run ${target.id} yet (verify it first).`);
      return;
    }
    run('visible.mjs', ['report', target.id]);
    return;
  }
  say(`Unknown option "${choice}".`);
}

export async function menuDispatch(_rl, ask, info, run = runScript, say = console.log) {
  say('\nStart a new task (headless dispatch):');
  if (info.engines.length && !info.engines.some((e) => e.status === 'ready')) {
    say('Note: no AI tool is allowed yet (use [3] Setup -> [3] to allow one, or continue in an interactive terminal to be prompted).');
  }
  const goalRaw = await ask('Goal (what should the AI do? Enter cancels): ');
  if (goalRaw === null || !goalRaw.trim() || isBackCmd(goalRaw)) { say('Cancelled.'); return; }
  const goal = goalRaw.trim();

  say('Execution mode:');
  say('  [1] normal   — 1 direct worker (fastest, lowest quota)');
  say('  [2] parallel — AI planner splits into parallel workers');
  say('  [3] team     — orchestrator -> BA/DEV/QA leads -> workers');
  const modeRaw = await ask('Choose mode [1]: ');
  if (modeRaw === null || isBackCmd(modeRaw)) return;
  const mTrim = modeRaw.trim().toLowerCase();
  const mode = (!mTrim || mTrim === '1' || mTrim === 'normal') ? 'normal'
    : (mTrim === '2' || mTrim === 'parallel') ? 'parallel'
    : (mTrim === '3' || mTrim === 'team') ? 'team'
    : null;
  if (!mode) { say(`Unknown mode "${modeRaw.trim()}"; cancelled.`); return; }

  let maxCost = '';
  if (mode === 'team') {
    const costRaw = await ask('Max cost cap in USD (--max-cost, optional, e.g. 2): ');
    if (costRaw === null) return;
    const ct = costRaw.trim();
    if (['b', 'back', 'q'].includes(ct.toLowerCase())) return;
    if (ct && (!Number.isFinite(Number(ct)) || Number(ct) < 0)) { say('Invalid --max-cost number; cancelled.'); return; }
    maxCost = ct;
  }

  const filesRaw = await ask('Allowed files/folders (comma-separated, e.g. src/,tests/ — recommended for undo; Enter = unrestricted): ');
  if (filesRaw === null || isBackCmd(filesRaw)) return;
  const files = filesRaw.trim();

  const checkRaw = await ask(`Verify command (Enter = auto "${info.verify.cmd}"): `);
  if (checkRaw === null || isBackCmd(checkRaw)) return;
  const check = checkRaw.trim();

  const readyEngines = info.engines.filter((e) => e.status === 'ready').map((e) => e.name);
  const engRaw = await ask(`AI engine (auto, claude, antigravity/agy, codex${readyEngines.length ? `; ready: ${readyEngines.join(', ')}` : ''}) [auto]: `);
  if (engRaw === null || isBackCmd(engRaw)) return;
  const eng = normalizeEngineArg(engRaw);
  const knownEngines = new Set(info.engines.map((e) => e.name));
  if (eng && knownEngines.size && !knownEngines.has(eng)) {
    say(`Unknown engine "${engRaw.trim()}"; cancelled. Use auto, ${[...knownEngines].join(', ')} (agy = antigravity).`);
    return;
  }

  const targetRaw = await ask('Delivery target (Enter = working folder, "uat" = --branch uat, or "cwd:<path>" = child/external folder): ');
  if (targetRaw === null || isBackCmd(targetRaw)) return;
  const tVal = targetRaw.trim();
  let branch = '';
  let cwd = '';
  if (/^(uat|--branch\s+uat)$/i.test(tVal)) {
    branch = 'uat';
  } else if (/^cwd:/i.test(tVal)) {
    const dir = tVal.slice(4).trim();
    const abs = dir ? path.resolve(ROOT, dir) : '';
    if (!dir || !fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      say(`Directory not found for cwd "${dir}"; cancelled.`);
      return;
    }
    cwd = dir;
  } else if (tVal) {
    const abs = path.resolve(ROOT, tVal);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) cwd = tVal;
    else { say(`Unknown delivery target "${tVal}"; cancelled. Use Enter, "uat", or "cwd:<folder>".`); return; }
  }

  const modelRaw = await ask('Model tier override (Enter = automatic, or fast / medium / high): ');
  if (modelRaw === null || isBackCmd(modelRaw)) return;
  const model = modelRaw.trim().toLowerCase();
  if (model && !['fast', 'medium', 'high'].includes(model)) {
    say(`Unknown model tier "${modelRaw.trim()}"; cancelled. Use fast, medium, or high.`);
    return;
  }

  const args = ['--goal', goal, '--mode', mode];
  if (files) args.push('--files', files);
  if (check) args.push('--check', check);
  if (eng) args.push('--engine', eng);
  if (model) args.push('--model', model);
  if (maxCost) args.push('--max-cost', maxCost);
  if (branch) args.push('--branch', branch);
  if (cwd) args.push('--cwd', cwd);
  args.push('--wait');

  const quote = (s) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
  say(`\nCommand preview:\n  node .harness/dispatch.mjs ${args.map(quote).join(' ')}`);
  if (mode !== 'normal') say(`Note: '${mode}' mode uses planning + multi-worker calls (extra AI quota).`);
  if (!await confirm(ask, 'Run this task now? [Y/n] ', true)) { say('Cancelled.'); return; }
  run('dispatch.mjs', args, { extraEnv: { HARNESS_YES: '1' }, allowInput: true });
}

export async function menuSetup(_rl, ask, _info, run = runScript, say = console.log) {
  say('\nSetup & AI tool permissions:');
  say('  [1] Health check (doctor.mjs)');
  say('  [2] Deep health check with live CLI probes (doctor.mjs --deep)');
  say('  [3] List, allow, or deny AI tools (engines.mjs)');
  say('  [4] Auto-assign team engines to installed CLIs (team.mjs auto-assign)');
  say('  [5] Sync editor named agents (team.mjs sync-agents)');
  say('  [6] Show agent team & budgets (team.mjs show)');
  say('  [7] Validate team guardrails (team.mjs validate)');
  say('  [0] Back');

  const sub = await ask('Choose [0-7]: ');
  if (isBack(sub)) return;
  const choice = sub.trim();

  if (choice === '1') { run('doctor.mjs'); return; }
  if (choice === '2') { run('doctor.mjs', ['--deep']); return; }
  if (choice === '3') {
    run('engines.mjs', ['list']);
    const ans = await ask('Change permission? Enter "allow <tool>" or "deny <tool>" (claude, agy, codex), or Enter to go back: ');
    if (ans === null || !ans.trim() || isBackCmd(ans)) return;
    const parts = ans.trim().split(/\s+/);
    const verb = parts[0]?.toLowerCase();
    const tool = parts[1]?.toLowerCase();
    if ((verb === 'allow' || verb === 'deny') && tool) {
      run('engines.mjs', [verb, tool]);
    } else {
      say('Expected: allow <tool> or deny <tool> (for example: allow claude).');
    }
    return;
  }
  if (choice === '4') {
    run('team.mjs', ['auto-assign', '--dry-run']);
    if (!await confirm(ask, 'Write this engine routing to .harness/team.json? [y/N] ', false)) { say('Not changed.'); return; }
    run('team.mjs', ['auto-assign']);
    return;
  }
  if (choice === '5') { run('team.mjs', ['sync-agents']); return; }
  if (choice === '6') { run('team.mjs', ['show']); return; }
  if (choice === '7') { run('team.mjs', ['validate']); return; }
  say(`Unknown option "${choice}".`);
}

export async function menuBacklog(_rl, ask, info, run = runScript, say = console.log) {
  say('\nBacklog & Autopilot:');
  say('  [1] View backlog & release snapshots (backlog.mjs overview)');
  say(`  [2] Approve held big item ("Needs OK" -> READY)${info.backlog.held.length ? ` [${info.backlog.held.length} waiting]` : ''}`);
  say('  [3] Add a new backlog task (backlog.mjs add)');
  say('  [4] Run one Autopilot step now (daemon.mjs --tick)');
  say('  [5] Start Autopilot loop on uat branch (daemon.mjs --autonomous)');
  say('  [6] Mark a BLOCKED or BACKLOG item READY (backlog.mjs ready <id>)');
  say('  [7] Mark an item BLOCKED (backlog.mjs block <id> "reason")');
  say('  [8] Promote next READY item to inbox now (backlog.mjs pop)');
  say('  [9] List release snapshots (backlog.mjs releases)');
  say('  [0] Back');

  const sub = await ask('Choose [0-9]: ');
  if (isBack(sub)) return;
  const choice = sub.trim();

  if (choice === '1') { run('backlog.mjs', ['overview']); return; }
  if (choice === '2') {
    if (!info.backlog.held.length) { say('No backlog items are waiting for approval ("Needs OK").'); return; }
    say('\nHeld items waiting for your OK:');
    for (const h of info.backlog.held) {
      say(`  - ${h.id}: ${h.title}${h.blockedReason ? ` (${h.blockedReason})` : ''}`);
    }
    const defId = info.backlog.held[0].id;
    const rawId = await ask(`Backlog ID to approve [${defId}]: `);
    if (rawId === null || isBackCmd(rawId)) return;
    const id = rawId.trim() || defId;
    if (!await confirm(ask, `Approve ${id} for team/parallel or high-tier execution? [y/N] `, false)) { say('Not approved.'); return; }
    run('backlog.mjs', ['approve', id]);
    return;
  }
  if (choice === '3') {
    const titleRaw = await ask('Task title (Enter cancels): ');
    if (titleRaw === null || !titleRaw.trim() || isBackCmd(titleRaw)) { say('Cancelled.'); return; }
    const goalRaw = await ask('Detailed goal (Enter = same as title): ');
    if (goalRaw === null || isBackCmd(goalRaw)) return;
    const filesRaw = await ask('Target files/folders (comma-separated, optional): ');
    if (filesRaw === null || isBackCmd(filesRaw)) return;
    const checkRaw = await ask('Verify command (optional, e.g. npm test): ');
    if (checkRaw === null || isBackCmd(checkRaw)) return;
    const roleRaw = await ask('Role (Enter = default, "auto-plan", DEV_ENGINEER, BA_ANALYST, QA_AUDITOR, UX_DESIGNER): ');
    if (roleRaw === null || isBackCmd(roleRaw)) return;
    const skillsRaw = await ask('Skills (comma-separated, e.g. code-craft,test-champion — Enter = auto): ');
    if (skillsRaw === null || isBackCmd(skillsRaw)) return;
    const prioRaw = await ask('Priority (1 = highest .. 9 = lowest) [5]: ');
    if (prioRaw === null || isBackCmd(prioRaw)) return;
    const prio = prioRaw.trim();
    if (prio && (!/^\d+$/.test(prio) || Number(prio) < 1)) { say(`Invalid priority "${prio}"; cancelled.`); return; }
    const statusRaw = await ask('Initial status ([1] READY / [2] BACKLOG) [1]: ');
    if (statusRaw === null || isBackCmd(statusRaw)) return;
    const isBacklog = statusRaw.trim() === '2' || /^backlog$/i.test(statusRaw.trim());
    const args = ['add', titleRaw.trim()];
    if (goalRaw.trim()) args.push('--goal', goalRaw.trim());
    if (filesRaw.trim()) args.push('--files', filesRaw.trim());
    if (checkRaw.trim()) args.push('--check', checkRaw.trim());
    const roleTrim = roleRaw.trim();
    if (/^auto-plan$/i.test(roleTrim)) args.push('--auto-plan');
    else if (roleTrim) {
      const knownRoles = Object.keys((() => { try { return loadRoles(); } catch { return {}; } })());
      const up = roleTrim.toUpperCase();
      if (knownRoles.length && !knownRoles.includes(up)) { say(`Unknown role "${roleTrim}". Known: ${knownRoles.join(', ')}, auto-plan.`); return; }
      args.push('--role', up);
    }
    if (skillsRaw.trim()) args.push('--skills', skillsRaw.trim());
    if (prio) args.push('--priority', prio);
    if (!isBacklog) args.push('--ready');
    run('backlog.mjs', args);
    return;
  }
  if (choice === '4') { run('daemon.mjs', ['--tick'], { allowInput: true }); return; }
  if (choice === '5') {
    if (!info.autonomous) say('Note: .harness/charter.md currently has "- autonomous: off".');
    if (!await confirm(ask, 'Start Autopilot loop in this terminal (builds onto branch uat; Ctrl+C stops)? [y/N] ', false)) { say('Cancelled.'); return; }
    run('daemon.mjs', ['--autonomous'], { allowInput: true });
    return;
  }
  if (choice === '6') {
    const bl = (() => { try { return readBacklog(); } catch { return { tasks: [] }; } })();
    const cands = (bl.tasks || []).filter((t) => t.status !== 'READY' && t.status !== 'DONE');
    if (cands.length) {
      say('\nItems not currently READY:');
      for (const t of cands.slice(0, 12)) say(`  - ${t.id} [${t.status}] ${t.title || t.goal}`);
    }
    const defId = cands.length === 1 ? cands[0].id : '';
    const idRaw = await ask(`Backlog ID to set READY${defId ? ` [${defId}]` : ''}: `);
    if (idRaw === null || isBackCmd(idRaw)) return;
    const id = idRaw.trim() || defId;
    if (!id) { say('Cancelled.'); return; }
    run('backlog.mjs', ['ready', id]);
    return;
  }
  if (choice === '7') {
    const bl = (() => { try { return readBacklog(); } catch { return { tasks: [] }; } })();
    const cands = (bl.tasks || []).filter((t) => t.status !== 'DONE' && t.status !== 'BLOCKED');
    if (cands.length) {
      say('\nActive / planned items:');
      for (const t of cands.slice(0, 12)) say(`  - ${t.id} [${t.status}] ${t.title || t.goal}`);
    }
    const defId = cands.length === 1 ? cands[0].id : '';
    const idRaw = await ask(`Backlog ID to mark BLOCKED${defId ? ` [${defId}]` : ''}: `);
    if (idRaw === null || isBackCmd(idRaw)) return;
    const id = idRaw.trim() || defId;
    if (!id) { say('Cancelled.'); return; }
    const reasonRaw = await ask('Reason (Enter = "blocked by a human"): ');
    if (reasonRaw === null || isBackCmd(reasonRaw)) return;
    run('backlog.mjs', ['block', id, ...(reasonRaw.trim() ? [reasonRaw.trim()] : [])]);
    return;
  }
  if (choice === '8') {
    const next = (() => { try { return nextReady(); } catch { return null; } })();
    if (!next) { say('No READY item in .harness/backlog.json to promote.'); return; }
    say(`Next READY item: ${next.id} — ${next.title || next.goal}`);
    if (!await confirm(ask, `Promote ${next.id} into .harness/inbox/ now? [y/N] `, false)) { say('Cancelled.'); return; }
    run('backlog.mjs', ['pop']);
    return;
  }
  if (choice === '9') { run('backlog.mjs', ['releases']); return; }
  say(`Unknown option "${choice}".`);
}

export async function menuSessions(_rl, ask, info, run = runScript, say = console.log) {
  say('\nSession board (child sessions):');
  say('  [1] View session board (sessions.mjs board)');
  say('  [2] Create new child task & branch brief (sessions.mjs new)');
  say('  [3] Inspect / handoff child task (sessions.mjs handoff)');
  say('  [4] Save WIP checkpoint commit on child branch (sessions.mjs checkpoint)');
  say('  [5] Merge a DONE task into base after checks (sessions.mjs merge)');
  say('  [6] Cleanup merged worktrees & branches (sessions.mjs cleanup)');
  say('  [7] Run headless worker inside a child worktree (dispatch.mjs --cwd)');
  say('  [0] Back');

  const sub = await ask('Choose [0-7]: ');
  if (isBack(sub)) return;
  const choice = sub.trim();

  const openIds = (info.sessions?.open || []).map((x) => x.id);
  const pickOpenId = async (label) => {
    if (openIds.length) say(`Open child tasks: ${openIds.join(', ')}`);
    const idRaw = await ask(`${label}${openIds.length === 1 ? ` [${openIds[0]}]` : ''}: `);
    if (idRaw === null || isBackCmd(idRaw)) return null;
    return idRaw.trim() || (openIds.length === 1 ? openIds[0] : '');
  };

  if (choice === '1') { run('sessions.mjs', ['board']); return; }
  if (choice === '2') {
    const titleRaw = await ask('Child task title (Enter cancels): ');
    if (titleRaw === null || !titleRaw.trim() || isBackCmd(titleRaw)) { say('Cancelled.'); return; }
    const typeRaw = await ask('Type ([1] feat / [2] bug / [3] task) [1]: ');
    if (typeRaw === null || isBackCmd(typeRaw)) return;
    const t = typeRaw.trim().toLowerCase();
    const type = (t === '2' || t === 'bug') ? 'bug' : (t === '3' || t === 'task') ? 'task' : 'feat';
    run('sessions.mjs', ['new', titleRaw.trim(), '--type', type]);
    return;
  }
  if (choice === '3') {
    const id = await pickOpenId('Task ID to inspect/handoff (Enter = auto-detect)');
    if (id === null) return;
    const saveWip = await confirm(ask, 'Commit uncommitted WIP first (--checkpoint)? [y/N] ', false);
    const args = ['handoff', ...(id ? [id] : []), ...(saveWip ? ['--checkpoint'] : [])];
    run('sessions.mjs', args);
    return;
  }
  if (choice === '4') {
    const id = await pickOpenId('Task ID to checkpoint');
    if (!id) { say('Cancelled.'); return; }
    const msgRaw = await ask('WIP checkpoint note (Enter = "checkpoint"): ');
    if (msgRaw === null || isBackCmd(msgRaw)) return;
    const args = ['checkpoint', id, ...(msgRaw.trim() ? ['--message', msgRaw.trim()] : [])];
    run('sessions.mjs', args);
    return;
  }
  if (choice === '5') {
    const doneIds = (info.sessions?.done || []).map((x) => x.id);
    if (doneIds.length) say(`Tasks reported DONE: ${doneIds.join(', ')}`);
    const idRaw = await ask(`Task ID to merge${doneIds.length ? ` [${doneIds[0]}]` : ''}: `);
    if (idRaw === null || isBackCmd(idRaw)) return;
    const id = idRaw.trim() || doneIds[0];
    if (!id) { say('Cancelled.'); return; }
    if (!await confirm(ask, `Run verify check and merge ${id} into base branch? [y/N] `, false)) { say('Merge cancelled.'); return; }
    run('sessions.mjs', ['merge', id]);
    return;
  }
  if (choice === '6') { run('sessions.mjs', ['cleanup']); return; }
  if (choice === '7') {
    const id = await pickOpenId('Open child task ID to run inside its worktree');
    if (!id) { say('Cancelled.'); return; }
    let data = null;
    try {
      const raw = execFileSync(process.execPath, [path.join(HARNESS_DIR, 'sessions.mjs'), 'handoff', id, '--json'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
      data = JSON.parse(raw);
    } catch (e) {
      say(`Unable to inspect child task "${id}": ${(e?.stderr || e?.message || '').toString().trim() || 'failed'}`);
      return;
    }
    if (!data?.worktree) {
      say(`No active local worktree found for ${id} (${data?.task?.branch || 'branch unknown'}). Start it first with: node .harness/sessions.mjs start ${id}`);
      return;
    }
    say(`Child worktree: ${data.worktree} (branch ${data.task.branch}; uncommitted: ${data.uncommitted?.length || 0})`);
    if (data.checkpointNeededForWorktrees) say('Note: useGitWorktrees is true; run [4] checkpoint first if uncommitted WIP must be visible to detached worker worktrees.');
    const defGoal = `Finish ${id}: ${data.task.title}`;
    const goalRaw = await ask(`Goal [${defGoal}]: `);
    if (goalRaw === null || isBackCmd(goalRaw)) return;
    const goal = goalRaw.trim() || defGoal;
    const readyList = info.engines.filter((e) => e.status === 'ready').map((e) => e.name);
    const knownEngines = new Set(info.engines.map((e) => e.name));
    const defEng = data.suggestedEngine && knownEngines.has(data.suggestedEngine) ? data.suggestedEngine : 'auto';
    const engRaw = await ask(`AI engine (auto, claude, antigravity/agy, codex${readyList.length ? `; ready: ${readyList.join(', ')}` : ''}) [${defEng}]: `);
    if (engRaw === null || isBackCmd(engRaw)) return;
    const eng = normalizeEngineArg(engRaw.trim() || defEng);
    if (eng && knownEngines.size && !knownEngines.has(eng)) {
      say(`Unknown engine "${engRaw.trim()}"; cancelled.`);
      return;
    }
    const args = ['--cwd', data.worktree, '--goal', goal, ...(eng ? ['--engine', eng] : []), '--wait'];
    say(`Preview: node .harness/dispatch.mjs ${args.join(' ')}`);
    if (!await confirm(ask, `Run headless worker in ${id} worktree now? [Y/n] `, true)) { say('Cancelled.'); return; }
    run('dispatch.mjs', args, { extraEnv: { HARNESS_YES: '1' }, allowInput: true });
    return;
  }
  say(`Unknown option "${choice}".`);
}

export async function menuUsageAndStatus(_rl, ask, _info, run = runScript, say = console.log) {
  say('\nUsage, status, memory & Web UI:');
  say('  [1] AI usage / quota — last 7 days (usage.mjs)');
  say('  [2] AI usage / quota — last 30 days (usage.mjs --days 30)');
  say('  [3] Controller status & last 20 events (status.mjs --log 20)');
  say('  [4] Editor workflow runs (visible.mjs status)');
  say('  [5] Memory rules, auto-lessons, prompt context & task sessions');
  say('  [6] Short workspace summary (hook-session.mjs --brief)');
  say('  [7] Start local read-only Web UI dashboard (ui.mjs)');
  say('  [0] Back');

  const sub = await ask('Choose [0-7]: ');
  if (isBack(sub)) return;
  const choice = sub.trim();

  if (choice === '1') { run('usage.mjs'); return; }
  if (choice === '2') { run('usage.mjs', ['--days', '30']); return; }
  if (choice === '3') { run('status.mjs', ['--log', '20']); return; }
  if (choice === '4') { run('visible.mjs', ['status']); return; }
  if (choice === '5') {
    run('memory.mjs', ['list']);
    const ans = await ask('Action — type rule to teach, "forget <id>", "forget-auto <id>", "context", "sessions [n]", or Enter to go back: ');
    if (ans === null || !ans.trim() || isBackCmd(ans)) return;
    const t = ans.trim();
    let m;
    if (/^context$/i.test(t)) run('memory.mjs', ['context']);
    else if ((m = t.match(/^sessions(?:\s+(\d+))?$/i))) run('memory.mjs', ['sessions', ...(m[1] ? [m[1]] : [])]);
    else if ((m = t.match(/^forget\s+(\S+)$/i))) run('memory.mjs', ['forget', m[1]]);
    else if ((m = t.match(/^forget-auto\s+(\S+)$/i))) run('memory.mjs', ['forget-auto', m[1]]);
    else run('memory.mjs', ['remember', t]);
    return;
  }
  if (choice === '6') { run('hook-session.mjs', ['--brief']); return; }
  if (choice === '7') {
    const portRaw = await ask('Port for local Web UI (Enter = 4173, 0 = free port, b = back) [4173]: ');
    if (portRaw === null) return;
    const pTrim = portRaw.trim();
    if (['b', 'back', 'q'].includes(pTrim.toLowerCase())) return;
    if (pTrim && (!/^\d+$/.test(pTrim) || Number(pTrim) < 0 || Number(pTrim) > 65535)) {
      say(`Invalid port "${pTrim}". Expected 0..65535.`);
      return;
    }
    run('ui.mjs', pTrim ? ['--port', pTrim] : [], { allowInput: true });
    return;
  }
  say(`Unknown option "${choice}".`);
}

function printMainMenu(info, say = console.log) {
  const openHint = info.visible.open.length ? `  [${info.visible.open.length} open: ${info.visible.open[0].id}]` : info.visible.stopped.length ? `  [stopped: ${info.visible.stopped[0].id}]` : '';
  const heldHint = info.backlog.held.length ? `  [${info.backlog.held.length} Needs OK!]` : '';
  const riskHint = info.sessions?.highRisk?.length ? `  [${info.sessions.highRisk.length} HIGH RISK!]` : '';

  say('\nActions:');
  say(`  [1] Continue unfinished work      handoff / resume / verify / rollback / report${openHint}`);
  say('  [2] Start a new task              dispatch (normal, parallel, or team; --branch uat / --cwd)');
  say('  [3] Setup & AI tool permissions   doctor, allow/deny AI tools, team validate & routing');
  say(`  [4] Backlog & Autopilot           overview, approve, add, ready/block/pop, tick, auto${heldHint}`);
  say(`  [5] Session board                 child sessions, new, handoff, checkpoint, cwd, merge${riskHint}`);
  say('  [6] Usage, status, memory & UI    quota (7d/30d), logs, memory, --brief, Web UI');
  say('  [0] Exit');
}

export async function runMenu({ input = process.stdin, output = process.stdout } = {}) {
  const isTty = Boolean(input.isTTY);
  const canInheritStdin = input === process.stdin && isTty;
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
  const say = (s = '') => { output.write(`${s}\n`); };
  const ask = (prompt) => {
    if (queue.length) { output.write(prompt); return Promise.resolve(queue.shift()); }
    if (closed) return Promise.resolve(null);
    if (isTty) { rl.setPrompt(prompt); rl.prompt(); }
    else output.write(prompt);
    return new Promise((resolve) => waiters.push(resolve));
  };
  const runChild = (scriptName, scriptArgs = [], opts = {}) => {
    if (!isTty) return runScript(scriptName, scriptArgs, { ...opts, output });
    const { allowInput = false } = opts;
    const holdSigint = () => {};
    rl.pause();
    try { if (typeof input.setRawMode === 'function') input.setRawMode(false); } catch { /* ignore */ }
    if (canInheritStdin) process.on('SIGINT', holdSigint);
    try {
      return runScript(scriptName, scriptArgs, { ...opts, allowInput: Boolean(allowInput && canInheritStdin), output });
    } finally {
      if (canInheritStdin) process.off('SIGINT', holdSigint);
      if (!closed) {
        try { if (typeof input.setRawMode === 'function') input.setRawMode(true); } catch { /* ignore */ }
        rl.resume();
      }
    }
  };

  try {
    for (;;) {
      const info = collectStatus();
      say(`\n${formatSummary(info)}`);
      printMainMenu(info, say);
      const ans = await ask('\nSelect [0-6]: ');
      if (ans === null) break;
      const choice = ans.trim().toLowerCase();
      if (choice === '0' || choice === 'q' || choice === 'quit' || choice === 'exit') {
        say('Bye!');
        break;
      }
      if (choice === '1') await menuContinue(rl, ask, info, runChild, say);
      else if (choice === '2') await menuDispatch(rl, ask, info, runChild, say);
      else if (choice === '3') await menuSetup(rl, ask, info, runChild, say);
      else if (choice === '4') await menuBacklog(rl, ask, info, runChild, say);
      else if (choice === '5') await menuSessions(rl, ask, info, runChild, say);
      else if (choice === '6') await menuUsageAndStatus(rl, ask, info, runChild, say);
      else if (choice === '') continue;
      else say(`Unknown choice "${ans.trim()}". Enter a number from 0 to 6.`);
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
