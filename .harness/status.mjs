#!/usr/bin/env node
/**
 * .harness/status.mjs — show what the harness is doing right now, in plain language.
 *   node .harness/status.mjs          one-shot summary (works even before daemon starts)
 *   node .harness/status.mjs --log 20 also print the last 20 telemetry events
 *   node .harness/status.mjs --json   print collected status summary as JSON
 *   node .harness/status.mjs --full   everything in one go: status + last 15 events, then doctor, usage and team
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  ROOT, HARNESS_DIR, FILES, DIRS, readJsonSafe, loadConfig, detectVerifyCmd,
  usageTodayLine, quotaWarnings, formatQuotaWarning, checkCore, helpIfAsked
} from './lib/common.mjs';
helpIfAsked(import.meta.url);
import { readCharter, readBacklog, backlogCounts, loadRoles, loadTeam, validateTeam, syncAgents } from './lib/governance.mjs';
import { listVisibleRuns, VISIBLE_TERMINAL, editorDisplayName } from './lib/handoff.mjs';
import { needsYou, formatNeedsYou } from './lib/waiting.mjs';

const args = process.argv.slice(2);
const wantJson = args.includes('--json');
const wantFull = args.includes('--full') && !wantJson;

let logCount = wantFull ? 15 : 0;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--log' || a.startsWith('--log=')) {
    const raw = a.includes('=') ? a.slice('--log='.length) : (args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : undefined);
    if (a.includes('=') && !raw) { console.error('Invalid --log value: expected a positive integer.'); process.exit(1); }
    if (raw === undefined) { logCount = 20; continue; }
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) {
      console.error(`Invalid --log "${raw}": expected a positive integer (e.g. --log 20).`);
      process.exit(1);
    }
    logCount = parsed;
  }
}

const count = (d) => {
  try { return fs.readdirSync(d).filter((f) => f.endsWith('.json')).length; } catch { return 0; }
};

let pid = 0;
try {
  const rawPid = Number(fs.readFileSync(FILES.pid, 'utf8').trim());
  if (Number.isInteger(rawPid) && rawPid > 0) { process.kill(rawPid, 0); pid = rawPid; }
} catch { pid = 0; }
const alive = pid > 0;

const s = readJsonSafe(FILES.state, null);
let cfg = {};
let configError = null;
try { cfg = loadConfig(); } catch (e) { configError = e.message; }

const charter = (() => { try { return readCharter(); } catch { return { exists: false, autonomous: false, maxAutoTasksPerRun: 3, requireRealCheck: true, text: '' }; } })();
const bl = (() => { try { return readBacklog(); } catch { return { tasks: [] }; } })();
const c = backlogCounts(bl);
const inboxCount = count(DIRS.inbox);
const completedCount = count(DIRS.completed);
const failedCount = count(DIRS.failed);

const verify = (() => {
  try { return cfg && Object.keys(cfg).length ? detectVerifyCmd(ROOT, cfg) : { cmd: '(none)', source: 'unavailable', real: false }; }
  catch { return { cmd: '(none)', source: 'unavailable', real: false }; }
})();

const allRuns = listVisibleRuns();
const openRuns = allRuns.filter((r) => !VISIBLE_TERMINAL.has(r.status)).reverse();
const stoppedRuns = allRuns.filter((r) => r.status === 'HALTED_HITL_REQUIRED' || r.status === 'ESCALATED').reverse();

const sessions = (() => {
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 }).trim();
    if (!common || !fs.existsSync(path.resolve(ROOT, common, 'harness-sessions.json'))) return null;
    const raw = execFileSync(process.execPath, [path.join(HARNESS_DIR, 'sessions.mjs'), 'board', '--json'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 });
    const data = JSON.parse(raw);
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    const open = tasks.filter((t) => !['MERGED', 'CLEANED'].includes(t.status));
    return { maxActive: data.maxActive || 4, open, done: open.filter((t) => t.status === 'DONE'), highRisk: open.filter((t) => t.risk) };
  } catch { return null; }
})();

const stagingLeftovers = (() => {
  try { return fs.readdirSync(DIRS.staging).filter((d) => !d.startsWith('.')); } catch { return []; }
})();
const staleInProgress = (!alive && inboxCount === 0)
  ? (bl.tasks || []).filter((t) => t.status === 'IN_PROGRESS').map((t) => t.id)
  : [];

const core = (() => { try { return checkCore(ROOT); } catch { return { manifest: null, changed: [], missing: [], added: [] }; } })();
const coreModified = [...(core.changed || []), ...(core.missing || []), ...(core.added || [])];
const teamInfo = (() => {
  try {
    const team = loadTeam();
    if (!team) return null;
    const roles = loadRoles();
    const { errors, warnings } = validateTeam(team, { roles, charter, plannerMaxWorkers: (cfg.planner || {}).maxWorkers || 4, engines: Object.keys(cfg.profiles || {}) });
    const ag = syncAgents(team, roles, { check: true });
    return { valid: errors.length === 0, errors, warnings, staleAgents: ag.stale || [] };
  } catch { return null; }
})();

const todayQuota = (() => { try { return usageTodayLine(cfg) || ''; } catch { return ''; } })();
const qWarns = (() => { try { return quotaWarnings(cfg); } catch { return []; } })();

const events = [];
if (logCount > 0 && fs.existsSync(FILES.log)) {
  try {
    for (const line of fs.readFileSync(FILES.log, 'utf8').trim().split(/\r?\n/).slice(-logCount)) {
      if (!line.trim()) continue;
      try { const e = JSON.parse(line); if (e && typeof e === 'object') events.push(e); } catch { /* skip malformed line */ }
    }
  } catch { /* ignore */ }
}

if (wantJson) {
  const visSummary = (r) => {
    const lv = r.lastVerify;
    const failed = lv && !lv.passed;
    const failureCategory = failed ? (lv.diagnosis?.category || (lv.patchSafety?.blocking?.length ? 'PATCH_SAFETY' : '')) : '';
    return {
      id: r.id, status: r.status, title: r.title, editor: r.editor || 'claude-code',
      ...(failureCategory ? { failureCategory, repeatFailure: Boolean(lv.diagnosis?.repeat) } : {})
    };
  };
  console.log(JSON.stringify({
    root: ROOT,
    daemon: { running: alive, pid: pid || null, hasStateFile: Boolean(s) },
    state: s || null,
    charter: {
      exists: charter.exists,
      autonomous: charter.autonomous,
      maxAutoTasksPerRun: charter.maxAutoTasksPerRun,
      requireRealCheck: charter.requireRealCheck
    },
    verify,
    queues: { inbox: inboxCount, completed: completedCount, failed: failedCount },
    backlog: { counts: c, held: (bl.tasks || []).filter((t) => t.status === 'BLOCKED' && t.needsApproval).map((t) => t.id), staleInProgress },
    visible: {
      open: openRuns.map(visSummary),
      stopped: stoppedRuns.map(visSummary)
    },
    sessions: sessions ? { open: sessions.open.length, maxActive: sessions.maxActive, done: sessions.done.map((t) => t.id), highRisk: sessions.highRisk.map((t) => t.id) } : null,
    team: teamInfo,
    quotaToday: todayQuota || null,
    quotaWarnings: qWarns,
    coreModified,
    stagingLeftovers,
    configError,
    needsYou: (() => { try { return needsYou(); } catch { return []; } })(),
    ...(logCount > 0 ? { events } : {})
  }, null, 2));
  process.exit(0);
}

const phaseLabel = !s
  ? 'idle (no state.json recorded yet)'
  : (!alive && /^[0123]_/.test(String(s.phase || '')))
    ? `${s.phase} (stale — controller stopped)`
    : (s.phase || 'idle');

console.log(`Daemon:     ${alive ? `running (PID ${s.pid ?? pid})` : 'NOT running'}`);
console.log(`Phase:      ${phaseLabel}${s ? `   (cycle ${s.cycle || 0}/${s.maxCycles || 3})` : ''}`);
if (s) {
  console.log(`Engine:     ${s.engine || '-'}   Topology: ${s.mode || '-'}`);
  console.log(`Task:       ${s.taskTitle || '-'}`);
  console.log(`Workers:    ${s.workerSummary || '-'}`);
  console.log(`Check:      ${s.lastGateStatus || '-'}   (default: ${verify.real ? verify.cmd : `${verify.cmd} [NO real check]`})`);
} else {
  console.log(`Check:      ${verify.real ? verify.cmd : `${verify.cmd} (NO real check)`}`);
}
console.log(`Inbox: ${inboxCount} waiting | Completed: ${completedCount} | Failed/halted: ${failedCount}`);
console.log(`Backlog:    READY ${c.READY} | IN_PROGRESS ${c.IN_PROGRESS} | DONE ${c.DONE} | BLOCKED ${c.BLOCKED} | BACKLOG ${c.BACKLOG}`);
{ let w = []; try { w = needsYou(); } catch (e) { w = [{ kind: 'failed', id: 'backlog', text: `backlog unreadable: ${e.message}`, next: 'node .harness/doctor.mjs' }]; } for (const l of formatNeedsYou(w)) console.log(l); }

const visDiagText = (lv) => {
  if (!lv || lv.passed) return '';
  if (lv.diagnosis?.category) return `, ${lv.diagnosis.category}${lv.diagnosis.repeat ? ' REPEAT' : ''}`;
  if (lv.patchSafety?.blocking?.length) return ', PATCH_SAFETY';
  return '';
};
if (openRuns.length) {
  const r = openRuns[0];
  console.log(`Editor:     Open run ${r.id} ("${r.title}", ${r.status}, ${editorDisplayName(r.editor || 'claude-code')}${visDiagText(r.lastVerify)})${openRuns.length > 1 ? ` (+${openRuns.length - 1} more)` : ''}`);
} else if (stoppedRuns.length) {
  const sr = stoppedRuns[0];
  console.log(`Editor:     Stopped run ${sr.id} ("${sr.title}", ${sr.status}${visDiagText(sr.lastVerify)})`);
} else {
  console.log('Editor:     none open');
}

if (sessions) {
  const bits = [`${sessions.open.length}/${sessions.maxActive} open`];
  if (sessions.done.length) bits.push(`DONE to merge: ${sessions.done.map((t) => t.id).join(', ')}`);
  if (sessions.highRisk.length) bits.push(`HIGH RISK: ${sessions.highRisk.map((t) => t.id).join(', ')}`);
  console.log(`Sessions:   ${bits.join(' · ')}`);
}

const autoText = `${charter.autonomous ? 'ON' : 'off'}${s?.autoStatus && s.autoStatus !== 'off' ? ` (${s.autoStatus})` : ''}`;
console.log(`Autonomous: ${autoText}   (maxAutoTasks: ${charter.maxAutoTasksPerRun}, requireRealCheck: ${charter.requireRealCheck ? 'yes' : 'no'})`);
console.log(`Quota:      ${todayQuota || 'none logged today'}`);
if (s?.updatedAt) console.log(`Updated:    ${s.updatedAt}`);

if (configError) console.log(`! Config error: ${configError}`);
if (coreModified.length) console.log(`! Core edited: ${coreModified.join(', ')}`);
if (teamInfo && (!teamInfo.valid || teamInfo.staleAgents.length)) {
  if (!teamInfo.valid) console.log(`! Team invalid: ${teamInfo.errors[0]}`);
  if (teamInfo.staleAgents.length) console.log(`! Editor agents out of sync: ${teamInfo.staleAgents.join(', ')} (run: node .harness/team.mjs sync-agents)`);
}
if (stagingLeftovers.length) console.log(`! Staging leftovers (.harness/staging/): ${stagingLeftovers.join(', ')}`);
if (staleInProgress.length) console.log(`! Stale IN_PROGRESS task(s): ${staleInProgress.join(', ')} (reset with: node .harness/backlog.mjs ready <id>)`);
for (const w of qWarns) console.log(`! ${formatQuotaWarning(w, cfg)}`);
if (!s) console.log('Tip: start background controller with `node .harness/daemon.mjs` or open interactive menu with `node .harness/start.mjs`.');

if (logCount > 0 && fs.existsSync(FILES.log)) {
  console.log(`\nLast ${logCount} events (.harness/telemetry.log):`);
  if (!events.length) console.log('  (none)');
  for (const e of events) {
    const tsStr = typeof e.ts === 'string' && e.ts.length >= 19 ? e.ts.slice(11, 19) : '??:??:??';
    const phStr = String(e.phase || '-').padEnd(20);
    console.log(`  ${tsStr}  ${phStr} ${String(e.message || '').replace(/\s+/g, ' ').slice(0, 110)}`);
  }
}

// --full: one command instead of four (status, doctor, usage, team show). Each part still works on its own.
if (wantFull) {
  for (const [title, script, extra] of [['Setup check (doctor)', 'doctor.mjs', []], ['Usage', 'usage.mjs', []], ['Team', 'team.mjs', ['show']]]) {
    console.log(`\n── ${title} ──`);
    try { execFileSync(process.execPath, [path.join(HARNESS_DIR, script), ...extra], { cwd: ROOT, stdio: 'inherit', timeout: 120000 }); }
    catch (e) { console.log(`! ${script} exited with ${e.status ?? e.message}`); }
  }
}
