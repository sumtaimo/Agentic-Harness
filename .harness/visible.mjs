#!/usr/bin/env node
/**
 * .harness/visible.mjs — the controller's side of the EDITOR workflow, where the agents are visible:
 *
 *   human ──► controller ──► orchestrator (your editor session) ──► named agents (lead-dev, lead-qa, …) ──► verify ──► report ──► human
 *
 * The controller holds the task, the charter, the backlog and the team, and enforces the rules deterministically:
 * it briefs the orchestrator, validates the delegation BEFORE any agent starts, then (after the agents finish) checks
 * that every changed file belongs to an assigned lead, reverts anything outside, runs the real check, and writes
 * the report for the human. The orchestrator and the agents only do the thinking and the work.
 *
 *   node .harness/visible.mjs brief  --goal "<what to build>" [--files "src/,docs/"] [--check "<cmd>"] [--editor <name>]
 *   node .harness/visible.mjs brief  --next [--auto-session <id>] [--editor <name>]   take the highest-priority READY backlog item
 *   node .harness/visible.mjs assign <run> '<delegation json>' [--editor <name>]       validate delegation, print each agent's prompt
 *   node .harness/visible.mjs verify <run> [--reports '<json {lead: "one-line report"}>']
 *   node .harness/visible.mjs handoff [run] [--prompt] [--json]      inspect an unfinished run & print a continuation prompt/command
 *   node .harness/visible.mjs rollback <run>                          restore every file to how it was before the run
 *   node .harness/visible.mjs propose <auto-session> '<tasks json>'   (autonomous mode) add READY tasks to the backlog
 *   node .harness/visible.mjs status | report <run>
 *
 * Exit codes: 0 ok · 1 error/rejected · 2 escalated to the human · 3 auto budget used · 4 paused (unfinished/failed run)
 *             5 charter objectives not filled · 6 nothing READY · 7 daily usage cap reached
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, FILES, ensureDirs, loadConfig, readJsonSafe, atomicWriteJson, listProjectFiles, detectVerifyCmd, memoryContext, recordSession, remember, normalizeTarget, helpIfAsked, pendingCostReasons, aiUsageSince, usageTodayLine } from './lib/common.mjs';
helpIfAsked(import.meta.url);
import { readCharter, loadRoles, loadSkills, matchSkills, loadTeam, validateTeam, validateDelegation, matchesAny, withinAll, readBacklog, writeBacklog, updateBacklogItem, nextReady, leadOwns, editorModelFor } from './lib/governance.mjs';
import { VISIBLE_DIR, VISIBLE_TERMINAL, MAX_VISIBLE_FILES, normalizeEditor, editorDisplayName, editorUsageKey, visibleRunDir, stripSlash, insideTargets, captureSnapshot, diffSnapshots, restoreVisibleFiles, findDefaultHandoffRun, inspectVisibleRun, buildHandoffPrompt, formatHandoffText } from './lib/handoff.mjs';

if (process.env.HARNESS_WORKER === '1') { console.error('Harness workers must not use the editor workflow.'); process.exit(2); }
ensureDirs();

const VIS = VISIBLE_DIR;
const TERMINAL = VISIBLE_TERMINAL;
const MAX_FILES = MAX_VISIBLE_FILES;
const MAX_BASELINE_BYTES = 25 * 1024 * 1024;
const PLACEHOLDER = /\(describe your product goals here/;

const config = loadConfig();
const argv = process.argv.slice(2);
const [cmd = 'status', ...rest] = argv;
const BOOLEAN_FLAGS = new Set(['--next', '--force', '--prompt', '--json']);
const flag = (n) => {
  const eq = rest.find((a) => a.startsWith(`${n}=`));
  if (eq !== undefined) return eq.slice(n.length + 1);
  const i = rest.indexOf(n);
  return i > -1 ? rest[i + 1] : undefined;
};
const has = (n) => rest.includes(n);
const positional = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--') && !rest[i - 1].includes('=') && !BOOLEAN_FLAGS.has(rest[i - 1])));

const die = (msg, code = 1) => { console.error(msg); process.exit(code); };
const runDir = visibleRunDir;
const strip = stripSlash;
const inside = insideTargets;

function loadRun(id) {
  const f = path.join(runDir(String(id || '')), 'run.json');
  if (!id || !fs.existsSync(f)) die(`No such run: ${id || '(none given)'}. See: node .harness/visible.mjs status`);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
const saveRun = (r) => { fs.mkdirSync(runDir(r.id), { recursive: true }); atomicWriteJson(path.join(runDir(r.id), 'run.json'), r); };
function allRuns() {
  try { return fs.readdirSync(VIS).map((d) => readJsonSafe(path.join(VIS, d, 'run.json'), null)).filter(Boolean).sort((a, b) => a.id.localeCompare(b.id)); } catch { return []; }
}

function snapshot(scope = [], baseFiles = null) {
  try { return captureSnapshot(scope, baseFiles, { maxFiles: MAX_FILES }); }
  catch (e) { die(e.message); }
}
const restoreFiles = restoreVisibleFiles;

// ───────────────────────────── helpers: team, prompts, reports ─────────────────────────────

function teamOrDie() {
  const team = loadTeam();
  if (!team) die('No .harness/team.json: the editor workflow needs the agent team. Copy it from the template.');
  const roles = loadRoles(); const charter = readCharter();
  const { errors } = validateTeam(team, { roles, charter, plannerMaxWorkers: (config.planner || {}).maxWorkers || 4 });
  if (errors.length) die(`team.json is invalid, nothing was started:\n  - ${errors.join('\n  - ')}`);
  const orch = team.members.find((m) => m.level === 'orchestrator');
  const leads = team.members.filter((m) => m.level === 'lead');
  const skills = loadSkills();
  for (const l of leads) for (const s of l.skills || []) if (!skills[s]) die(`team.json: lead "${l.id}" lists the unknown skill "${s}".`);
  return { team, roles, charter, orch, leads, skills };
}

function leadPrompt(run, lead, a, roles, skills) {
  const role = roles[String(lead.role).toUpperCase()] || {};
  const sk = matchSkills({ skills: lead.skills || [] }, String(lead.role).toUpperCase(), skills).chosen;
  const memory = memoryContext(config);
  return [
    `You are ${lead.id} (role ${lead.role}), a lead on the agent team. The orchestrator delegated this to you in run ${run.id}. Work ONLY inside the project folder ${ROOT}.`,
    `\nYour assignment: ${a.goal}`,
    `\nYou may create or change ONLY these files/folders: ${a.files.join(', ')}.`,
    'Do not touch anything else: the controller compares every changed file against the assignments after all agents finish, reverts anything outside your files, and the run fails.',
    run.interfaceContract ? `\nShared interface contract (the other leads are building against exactly this, in parallel):\n${run.interfaceContract}` : '',
    run.acceptanceCriteria?.length ? `\nAcceptance criteria:\n${run.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}` : '',
    `\nTask overall: ${run.goal}`,
    sk.length ? `\nMandatory skill rules for you:\n${sk.map((s) => `### ${s.name}\n${s.body}`).join('\n\n')}` : '',
    memory ? `\nRules the user taught (follow them):\n${memory}` : '',
    (role.allowedTools || []).some((r) => /^Bash\((npm|node)/.test(r)) ? '\nYou may check your work with `npm test` or `node --test`; do not run other commands.' : '\nYou have no shell; use the file tools only.',
    '\nWhen done, reply with a short report (at most 5 lines): files changed, what you did, what you checked, anything unresolved. Do not claim you tested something you did not run.'
  ].filter(Boolean).join('\n');
}

function reportText(run, v) {
  const L = [];
  const head = { PASSED: 'PASSED ✔', FAILED: 'NOT PASSED YET ✖ (can be fixed and re-verified)', HALTED_HITL_REQUIRED: 'STOPPED ✖ — a human decision is needed', ROLLED_BACK: 'ROLLED BACK', ESCALATED: 'ESCALATED — a human decision is needed' }[v.status] || v.status;
  const visual = v.status === 'PASSED' && v.uiFiles?.length;
  const sessionLabel = run.editor && run.editor !== 'claude-code' ? `${editorDisplayName(run.editor)} editor session` : 'editor session';
  L.push(`HARNESS REPORT — run ${run.id} — ${head}${visual ? ' — NEEDS A VISUAL REVIEW' : ''}`, '', `Task:    ${run.title}`, `Source:  ${run.source === 'backlog' ? `backlog item ${run.backlogId}` : 'goal given by the human'}${run.autonomous ? ' (autonomous mode)' : ''}`,
    `Flow:    controller → orchestrator (${sessionLabel}) → ${run.assignments.map((a) => a.lead).join(', ')} → controller verify → this report`, '');
  L.push('What each agent did:');
  const leads = run.leads || [];
  for (const a of run.assignments) {
    const lead = leads.find((l) => l.id === a.lead);
    const mine = v.changes.filter((f) => { const p = f.replace(/^[+~-] /, ''); return inside(p, a.files) && (!lead || !leads.length || leadOwns(lead, p, leads)); });
    L.push(`  • ${a.lead}: ${mine.length ? mine.join(', ') : 'no file changes'}${v.reports?.[a.lead] ? `\n      says: ${v.reports[a.lead]}` : ''}`);
  }
  L.push('', `Check:   ${run.check.cmd}  (${run.check.source})`, `         → ${v.checkResult}`);
  if (v.testsChangedAfterFail?.length) L.push(`  ⚠ After the last failed check, ${v.testsChangedAfterFail.length} test file(s) were changed (${v.testsChangedAfterFail.slice(0, 4).join(', ')}${v.testsChangedAfterFail.length > 4 ? ', …' : ''}).`,
    '    Look at that diff: the tests must have been FIXED, not weakened until they passed.');
  if (v.testsDeleted?.length) L.push(`  ⚠ ${v.testsDeleted.length} test file(s) that existed before this run were DELETED (${v.testsDeleted.slice(0, 4).join(', ')}${v.testsDeleted.slice(0, 4).length < v.testsDeleted.length ? ', …' : ''}). Make sure that was intended.`);
  if (v.skipped) L.push(`  ⚠ ${v.skipped} test(s) were SKIPPED. A skipped test proves nothing: find out why (for example a missing browser) before trusting this result.`);
  if (visual) L.push('', `Visual review needed: ${v.uiFiles.length} UI file(s) changed (${v.uiFiles.slice(0, 6).join(', ')}${v.uiFiles.length > 6 ? ', …' : ''}).`,
    `  Passing tests do not prove a page looks right${v.browserCheck ? '' : ', and this check never opened a browser (a broken page script would still pass)'}.`,
    '  Open it at desktop and phone width, in light and dark, and compare it with the spec before you commit.');
  if (v.checkCreated?.length) L.push('', `⚠ The check created ${v.checkCreated.length} file(s) that git does not ignore (${v.checkCreated.slice(0, 4).join(', ')}${v.checkCreated.length > 4 ? ', …' : ''}).`,
    '  Add them (for example dist/) to .gitignore, or they will be committed by accident and counted as out-of-scope changes next time.');
  if (v.violations.length) L.push('', 'Violations (changes outside the assigned files):', ...v.violations.map((x) => `  ✖ ${x}`));
  if (v.reverted.length) L.push(`         The controller reverted ${v.reverted.length} out-of-scope change(s): ${v.reverted.join(', ')}`);
  if (v.revertFailed?.length) L.push(`  ⚠ COULD NOT be reverted automatically (secrets are never copied): ${v.revertFailed.join(', ')} — check and restore them by hand before anything else.`);
  if (v.status === 'PASSED' && run.acceptanceCriteria?.length) L.push('', 'Acceptance criteria — confirm each one yourself (a passing check does not prove them by itself):', ...run.acceptanceCriteria.map((c) => `  ☐ ${c}`));
  L.push('', `Cycle ${run.cycles}/${config.maxCycles ?? 3}.`);
  if (v.status === 'PASSED') L.push('', 'Next for you: review the changes (git diff) and commit them when you are happy. Cost: not measured in the editor workflow (see the agent panel for tokens).');
  else if (v.status === 'FAILED') L.push('', `Next: send the failure to the responsible lead(s), then run: node .harness/visible.mjs verify ${run.id}`);
  else L.push('', `Files were ${v.autoRolledBack ? 'restored to how they were before the run' : 'left as they are (no baseline copy)'}. Decide: fix the task, then run it again. To undo by hand: node .harness/visible.mjs rollback ${run.id}`);
  return L.join('\n');
}

const sessionRuns = (sid) => allRuns().filter((r) => r.autoSession === sid);

// ───────────────────────────── commands ─────────────────────────────

function brief() {
  const { team, roles, charter, orch, leads } = teamOrDie();
  const sid = flag('--auto-session');
  const wantNext = has('--next');
  const goalArg = flag('--goal');
  if (!wantNext && !flag('--item') && !goalArg) die('Give --goal "<what to build>", or --item <backlog id>, or --next.');
  const editorFlag = flag('--editor');
  if ((has('--editor') || rest.some((a) => a.startsWith('--editor='))) && !editorFlag) {
    die('Give an editor name after --editor (for example: --editor antigravity or --editor cursor).');
  }
  let editor = 'claude-code';
  if (editorFlag !== undefined) {
    try { editor = normalizeEditor(editorFlag) || 'claude-code'; } catch (e) { die(e.message); }
  }

  const open = allRuns().filter((r) => !TERMINAL.has(r.status));
  if (open.length && !has('--force')) die(`Run ${open[0].id} ("${open[0].title}") is not finished (${open[0].status}). Verify or roll it back first: node .harness/visible.mjs verify ${open[0].id} | rollback ${open[0].id}`, 4);

  let item = null; const auto = wantNext || !!sid;
  if (auto) {
    if (!charter.autonomous) die('Autonomous mode is off in .harness/charter.md ("- autonomous: off"). Use --goal, or ask the owner to turn it on.', 1);
    if (sid) {
      const runs = sessionRuns(sid);
      if (runs.length >= charter.maxAutoTasksPerRun) die(`Auto budget used: ${runs.length}/${charter.maxAutoTasksPerRun} task(s) in this session (charter maxAutoTasksPerRun). Report to the human.`, 3);
      const last = runs[runs.length - 1];
      if (last && last.status !== 'PASSED') die(`Autonomy is paused: the previous run ${last.id} ended ${last.status}. A human must decide before the next task.`, 4);
    }
  }
  if (wantNext) {
    // Same rule as the headless autopilot: a READY item that may use a lot of quota is held ("Needs your OK"), not started.
    const held = [];
    for (item = nextReady(); item; item = nextReady()) {
      const pending = pendingCostReasons(config, item);
      if (!pending.length) break;
      updateBacklogItem(item.id, { status: 'BLOCKED', needsApproval: true, blockedReason: `Needs your OK (may use a lot of quota): ${pending.map((p) => p.text).join('; ')}. Approve: node .harness/backlog.mjs approve ${item.id}` });
      held.push(`${item.id} ("${item.title || item.goal}")`);
    }
    if (held.length) console.log(`HELD for the human's OK (big runs; tell the user, approve only after a clear yes): ${held.join(', ')}. Approve one with: node .harness/backlog.mjs approve <id>`);
    if (!item) die('Nothing is READY in the backlog.', 6);
  }
  if (flag('--item')) { item = readBacklog().tasks.find((t) => t.id === flag('--item')); if (!item) die(`No backlog item ${flag('--item')}.`); if (item.status !== 'READY') die(`Backlog item ${item.id} is ${item.status}, not READY.`); }

  const goal = item ? (item.goal || item.title) : goalArg;
  const userAllowed = (flag('--files') || '').split(',').map((s) => normalizeTarget(s)).filter(Boolean);
  let check = flag('--check') ? { cmd: flag('--check'), source: 'given by the human', real: true } : item?.verifyCmd ? { cmd: item.verifyCmd, source: `backlog item ${item.id}`, real: true } : (() => { const d = detectVerifyCmd(ROOT, config); return { cmd: d.cmd, source: d.source, real: d.real }; })();
  if (!check.real && (auto || charter.requireRealCheck) && auto) die('This project has no real check (add a "test" script to package.json or a "verifyCmd" to the task). Autonomous work needs one (charter requireRealCheck).', 1);

  const id = `V-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 5)}`;
  const scopeGlobs = userAllowed.length ? userAllowed : charter.allowedPaths;
  const snap = snapshot(scopeGlobs);
  const rollbackAvailable = snap.bytes <= MAX_BASELINE_BYTES;
  const baseDirRel = path.posix.join('.harness', 'visible', id, 'baseline');
  // secrets (.env*) are compared by hash only: they are never copied into the baseline
  if (rollbackAvailable) for (const f of Object.keys(snap.map).filter((k) => !/^\.env/.test(k))) { const dest = path.join(ROOT, baseDirRel, f); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(path.join(ROOT, f), dest); }
  const run = {
    id, status: 'BRIEFED', editor, createdAt: new Date().toISOString(), source: item ? 'backlog' : 'goal', backlogId: item?.id || null, autonomous: auto, autoSession: sid || null,
    title: item?.title || String(goal).slice(0, 80), goal, userAllowed, acceptanceCriteria: item?.acceptanceCriteria || [], interfaceContract: item?.interfaceContract || '',
    check, cycles: 0, assignAttempts: 0, assignments: [],
    charter: { allowedPaths: charter.allowedPaths, forbiddenPaths: charter.forbiddenPaths },
    orchestrator: orch.id, delegable: orch.canDelegateTo?.length ? orch.canDelegateTo : leads.map((l) => l.id),
    leads: leads.map((l) => ({ id: l.id, role: l.role, scope: l.scope, maxWorkers: l.maxWorkers ?? 3, skills: l.skills || [] })),
    baseline: { files: snap.map, bytes: snap.bytes, scoped: snap.scoped, rollbackAvailable, dir: rollbackAvailable ? baseDirRel : null }
  };
  saveRun(run);
  if (item) updateBacklogItem(item.id, { status: 'IN_PROGRESS', startedAt: new Date().toISOString(), visibleRun: id });
  const { files } = listProjectFiles(ROOT, 60);
  const memory = memoryContext(config);
  console.log(`RUN_ID=${id}`);
  console.log(`\nORCHESTRATOR BRIEF — run ${id}${auto ? ' (autonomous mode)' : ''}`);
  if (editor !== 'claude-code') console.log(`Editor: ${editorDisplayName(editor)}`);
  console.log(`\nTask: ${run.title}\nGoal: ${goal}`);
  if (run.acceptanceCriteria.length) console.log(`Acceptance criteria:\n${run.acceptanceCriteria.map((c) => `  - ${c}`).join('\n')}`);
  if (run.interfaceContract) console.log(`Interface contract:\n${run.interfaceContract}`);
  console.log(`\nCheck (run by the controller after the agents finish): ${check.cmd}  [${check.source}]${check.real ? '' : '\n  ⚠ NO REAL CHECK: any result would pass. Tell the human and propose a check.'}`);
  if (check.real && !BROWSER_CHECK.test(check.cmd) && Object.keys(snap.map).some((f) => UI_FILE.test(f))) console.log('  ⚠ This project has UI files but the check never opens a browser: a page with a broken script or layout can still pass. If this task changes UI, tell the human and suggest a browser smoke test; the report will ask for a visual review.');
  console.log('\nTeam — delegate ONLY to these named agents, each at most once (their scope is enforced):');
  for (const l of run.leads) console.log(`  - ${l.id} (${l.role}) may own: ${l.scope.join(', ')}`);
  if (userAllowed.length) console.log(`The human only allows files inside: ${userAllowed.join(', ')}`);
  console.log(`Never allowed: ${charter.forbiddenPaths.join(', ')}${auto && charter.allowedPaths.length ? `\nAutonomous work stays inside: ${charter.allowedPaths.join(', ')}` : ''}`);
  console.log(`\nHow to proceed, as the orchestrator (you only plan; the agents do the work):\n  1. Decide which lead gets which files. Write the delegation as JSON:\n     {"interfaceContract":"exact names/signatures/formats the agents share","assignments":[{"lead":"lead-dev","goal":"…","files":["src/x.js"]}]}\n  2. Validate it: node .harness/visible.mjs assign ${id} '<json>'   (it prints each agent's ready-made prompt)\n  3. Start ALL assigned agents in ONE message with the Agent tool (subagent_type = the lead's id) so they run in parallel and are visible.\n  4. When they have reported: node .harness/visible.mjs verify ${id} --reports '{"lead-dev":"<their one-line report>"}'\n  5. Report to the human in plain words, from the controller's report.`);
  if (memory) console.log(`\nRules the user taught:\n${memory}`);
  console.log(`\nProject files (first ${files.length}):\n${files.join('\n') || '(empty project)'}`);
}

function assign() {
  const id = positional[0];
  const run = loadRun(id);
  if (!['BRIEFED', 'DELEGATED'].includes(run.status)) die(`Run ${id} is ${run.status}; it cannot be (re)assigned.`);
  const { roles, leads, skills } = teamOrDie();
  let raw = positional[1];
  if (flag('--file')) raw = fs.readFileSync(flag('--file'), 'utf8');
  if (raw === '-' || raw === undefined) raw = fs.readFileSync(0, 'utf8');
  run.assignAttempts += 1;
  let plan;
  try {
    try { plan = JSON.parse(raw); } catch { throw new Error('The delegation is not valid JSON.'); }
    validateDelegation(plan, { leads, delegable: new Set(run.delegable), userAllowed: run.userAllowed });
    if (run.autonomous) for (const a of plan.assignments) for (const f of a.files) {
      if (matchesAny(f, run.charter.forbiddenPaths)) throw new Error(`file "${f}" is forbidden by the charter.`);
      if (run.charter.allowedPaths.length && !withinAll(f, run.charter.allowedPaths)) throw new Error(`file "${f}" is outside the charter's allowed paths for autonomous work (${run.charter.allowedPaths.join(', ')}).`);
    }
  } catch (e) {
    if (run.assignAttempts >= 3) { run.status = 'ESCALATED'; run.reason = `The orchestrator could not produce a valid delegation in 3 attempts: ${e.message}`; saveRun(run); if (run.backlogId) updateBacklogItem(run.backlogId, { status: 'BLOCKED', blockedReason: `ESCALATED: ${run.reason}` }); die(`REJECTED (attempt ${run.assignAttempts}/3): ${e.message}\nESCALATED to the human: ${run.reason}`, 2); }
    saveRun(run);
    die(`REJECTED (attempt ${run.assignAttempts}/3): ${e.message}\nFix the delegation and run assign again. Nothing was started.`, 1);
  }
  const editorFlag = flag('--editor');
  if ((has('--editor') || rest.some((a) => a.startsWith('--editor='))) && !editorFlag) {
    die('Give an editor name after --editor (for example: --editor antigravity or --editor cursor).');
  }
  let editor = run.editor || 'claude-code';
  if (editorFlag !== undefined) {
    try { editor = normalizeEditor(editorFlag) || editor; } catch (e) { die(e.message); }
  }
  run.editor = editor;

  // Editor session agents count too: each started lead is one call of `usageEngine` in the usage log, checked
  // against dailyLimits[usageEngine].calls. Tokens stay inside the editor session and are kept separate from headless CLI quotas.
  {
    const usageEngine = editorUsageKey(editor, config);
    const editorName = editorDisplayName(editor);
    const cap = (config.dailyLimits || {})[usageEngine];
    const today = (aiUsageSince(`${new Date().toISOString().slice(0, 10)}T00:00:00`)[usageEngine] || { calls: 0 }).calls;
    if (cap && typeof cap.calls === 'number' && today + plan.assignments.length > cap.calls) {
      saveRun(run);
      die(`DAILY_LIMIT: ${editorName} session agents used ${today}/${cap.calls} call(s) today; this delegation needs ${plan.assignments.length} more. Nothing was started. Raise "dailyLimits" → "${usageEngine}" in config.json only if the user accepts the use.`, 7);
    }
    const ts = new Date().toISOString();
    const useClaudeModel = usageEngine === 'claude-code';
    const lines = plan.assignments.map((a) => {
      const lead = leads.find((l) => l.id === a.lead);
      const m = useClaudeModel ? editorModelFor(lead, config) : null;
      return JSON.stringify({ ts, phase: 'AGENT_USAGE', message: `${a.lead}: ${usageEngine} ${m || 'session model'} (editor run ${id})`, worker: a.lead, engine: usageEngine, model: m, tier: null, ok: true, tokens: null, usd: 0, ms: 0, run: id });
    });
    fs.appendFileSync(FILES.log, `${lines.join('\n')}\n`);
    const t = usageTodayLine(config);
    console.log(`AI: ${plan.assignments.length} ${editorName} agent(s) for this run · today: ${t}\n`);
  }
  run.interfaceContract = [run.interfaceContract, typeof plan.interfaceContract === 'string' ? plan.interfaceContract.slice(0, 4000) : ''].filter(Boolean).join('\n');
  run.assignments = plan.assignments.map((a) => ({ lead: a.lead, goal: a.goal.trim(), files: a.files }));
  run.status = 'DELEGATED'; run.delegatedAt = new Date().toISOString();
  saveRun(run);
  console.log(`DELEGATION OK for run ${id}: ${run.assignments.map((a) => `${a.lead} → ${a.files.join(', ')}`).join('  |  ')}\n`);
  console.log(`Start these ${run.assignments.length} agent(s) NOW, all in ONE message (Agent tool, parallel). Use exactly these prompts:\n`);
  for (const a of run.assignments) {
    const lead = leads.find((l) => l.id === a.lead);
    console.log(`===== agent: ${a.lead}   (subagent_type: "${a.lead}", description: "${a.lead}: ${a.goal.replace(/\s+/g, ' ').slice(0, 50)}") =====`);
    console.log(leadPrompt(run, lead, a, roles, skills));
    console.log('');
  }
}

/**
 * How many tests the check skipped, read from the common test reporters (node:test TAP and spec, Jest, Vitest,
 * Playwright, Mocha). A skipped test is not a passed test: a visual test that skips because a browser is missing
 * proves nothing, so the report says so.
 */
function countSkipped(out) {
  let n = 0;
  for (const re of [/^# (?:skipped|todo) (\d+)/gm, /^ℹ (?:skipped|todo) (\d+)/gm, /(\d+) (?:skipped|pending|todo)\b/gi]) {
    for (const m of String(out).matchAll(re)) n += Number(m[1]);
    if (n) return n;
  }
  return 0;
}

/** Changed files that render as UI: tests passing does not mean they look right. */
/** Test files, by the usual conventions (a tests/ or __tests__/ folder, or a .test. / .spec. name). */
const TEST_FILE = /(^|\/)(tests?|__tests__|specs?)\/|\.(test|spec)\.[a-z0-9]+$/i;
const UI_FILE = /\.(html?|css|scss|sass|less|svg|jsx|tsx|vue|svelte|astro)$/i;
/** A check that opens a real browser (so a broken page script or layout can fail it). */
const BROWSER_CHECK = /playwright|puppeteer|cypress|webdriver|selenium|e2e|visual|screenshot|lighthouse/i;

function runCheck(run) {
  const r = spawnSync(run.check.cmd, { cwd: ROOT, shell: true, encoding: 'utf8', timeout: config.verifyTimeoutMs || 600000, maxBuffer: 32 * 1024 * 1024 });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  const skipped = countSkipped(out);
  return { ok: r.status === 0, skipped, text: r.status === 0 ? `PASS (exit 0)${skipped ? `, ${skipped} test(s) SKIPPED` : ''}` : `FAIL (exit ${r.status ?? 'timeout'})\n${out.split('\n').slice(-25).join('\n')}` };
}

function verify() {
  const run = loadRun(positional[0]);
  if (!['DELEGATED', 'FAILED'].includes(run.status)) die(`Run ${run.id} is ${run.status}; it can only be verified after assign (DELEGATED) or after a failed verify.`);
  let reports = {}; try { reports = flag('--reports') ? JSON.parse(flag('--reports')) : {}; } catch { /* ignore a malformed summary */ }
  run.cycles += 1;
  const scopeGlobs = run.userAllowed?.length ? run.userAllowed : (run.charter?.allowedPaths || []);
  const snap = () => snapshot(scopeGlobs, run.baseline.files).map;
  const cur = snap();
  const d = diffSnapshots(run.baseline.files, cur);
  const violations = []; const violating = [];
  const leads = run.leads || [];
  for (const f of d.all) {
    const owner = run.assignments.find((a) => {
      if (!inside(f, a.files)) return false;
      const lead = leads.find((l) => l.id === a.lead);
      return !lead || !leads.length || leadOwns(lead, f, leads);
    });
    if (!owner) { violations.push(`${f}: not inside any lead's assigned files`); violating.push(f); continue; }
    if (matchesAny(f, run.charter.forbiddenPaths)) { violations.push(`${f}: forbidden by the charter`); violating.push(f); continue; }
    if (run.autonomous && run.charter.allowedPaths.length && !matchesAny(f, run.charter.allowedPaths)) { violations.push(`${f}: outside the charter's allowed paths`); violating.push(f); }
  }
  const reverted = []; const revertFailed = [];
  if (violating.length) { const r = restoreFiles(run, violating); reverted.push(...r.restored); revertFailed.push(...r.failed); }
  const changes = d.all.filter((f) => !violating.includes(f) || revertFailed.includes(f)).map((f) => `${d.added.includes(f) ? '+' : d.deleted.includes(f) ? '-' : '~'} ${f}`);
  let check = { ok: false, text: 'not run (fix the violations first)' };
  let checkCreated = [];
  if (!violations.length) {
    const before = snap();
    check = runCheck(run);
    // files the check itself wrote (a build output such as dist/) that git does not ignore: they would be committed
    // by accident, and the next verify would count them as out-of-scope changes
    checkCreated = Object.keys(snap()).filter((f) => !(f in before));
  }
  const uiFiles = d.all.filter((f) => !violating.includes(f) && UI_FILE.test(f));
  // Quality signals a passing check cannot give by itself:
  // - test files changed AFTER the previous failed check (were the tests fixed, or weakened until they passed?)
  // - test files that existed before the run and were deleted during it
  const testsChangedAfterFail = run.cycleSnapshot ? diffSnapshots(run.cycleSnapshot, cur).all.filter((f) => TEST_FILE.test(f) && !violating.includes(f)) : [];
  const testsDeleted = d.deleted.filter((f) => TEST_FILE.test(f) && !violating.includes(f));
  const passed = !violations.length && check.ok;
  const maxCycles = config.maxCycles ?? 3;
  const halted = !passed && run.cycles >= maxCycles;
  let autoRolledBack = false;
  if (halted) { const r = restoreFiles(run, diffSnapshots(run.baseline.files, snap()).all); autoRolledBack = r.failed.length === 0 && run.baseline.rollbackAvailable; }
  run.status = passed ? 'PASSED' : halted ? 'HALTED_HITL_REQUIRED' : 'FAILED';
  delete run.pendingJobId;
  run.lastVerify = { at: new Date().toISOString(), passed, violations, reverted, check: check.text };
  if (passed || halted) delete run.cycleSnapshot; else run.cycleSnapshot = snap(); // what the project looked like when this check failed
  run.lastVerify.skipped = check.skipped || 0; run.lastVerify.needsVisualReview = passed && uiFiles.length > 0;
  const v = { status: run.status, changes, violations, reverted, revertFailed, checkResult: check.text, reports, autoRolledBack, skipped: check.skipped || 0, uiFiles, checkCreated, browserCheck: BROWSER_CHECK.test(run.check.cmd), testsChangedAfterFail, testsDeleted };
  const text = reportText(run, v);
  fs.writeFileSync(path.join(runDir(run.id), 'report.md'), `${text}\n`);
  saveRun(run);

  if (passed && run.backlogId) updateBacklogItem(run.backlogId, { status: 'DONE', completedAt: new Date().toISOString(), result: 'VERIFIED', cyclesUsed: run.cycles, visibleRun: run.id });
  if (halted && run.backlogId) updateBacklogItem(run.backlogId, { status: 'BLOCKED', blockedReason: `HALTED_HITL_REQUIRED after ${run.cycles} cycles: ${violations[0] || check.text.split('\n')[0]}` });
  if (passed || halted) {
    try {
      recordSession({
        taskId: run.id, title: run.title, result: passed ? 'VERIFIED' : 'HALTED_HITL_REQUIRED', cycles: run.cycles, maxCycles, goal: run.goal,
        engine: `${editorDisplayName(run.editor || 'claude-code')} editor agents`, verifyCmd: run.check.cmd, verifySource: run.check.source, planner: `editor workflow: ${run.orchestrator} → ${run.assignments.map((a) => a.lead).join(', ')}`,
        team: { orchestrator: run.orchestrator, assignments: run.assignments.map((a) => ({ lead: a.lead, goal: a.goal, files: a.files, workers: [{ id: a.lead, files: a.files }] })) },
        subtasks: run.assignments.map((a) => ({ id: a.lead, targetFiles: a.files, prompt: a.goal })), errors: passed ? [] : [violations.join('\n') || check.text],
        outputs: Object.entries(reports).map(([id, output]) => ({ id, output })), finishedAt: new Date().toISOString()
      });
      if (!passed && (config.memory || {}).autoLessons !== false && !String(run.id).startsWith('V-test')) remember(`"${run.title}": editor run ${run.status} — ${(violations[0] || check.text.split('\n')[0]).replace(/\s+/g, ' ').slice(0, 200)}. Needs a human decision before retrying.`, FILES.autoLessons);
    } catch { /* memory is best effort */ }
  }
  if (run.baseline.dir && (passed || halted) && fs.existsSync(path.join(ROOT, run.baseline.dir))) fs.rmSync(path.join(ROOT, run.baseline.dir), { recursive: true, force: true });
  console.log(text);
  process.exit(passed ? 0 : 1);
}

function rollback() {
  const run = loadRun(positional[0]);
  const scopeGlobs = run.userAllowed?.length ? run.userAllowed : (run.charter?.allowedPaths || []);
  const d = diffSnapshots(run.baseline.files, snapshot(scopeGlobs, run.baseline.files).map);
  const r = restoreFiles(run, d.all);
  if (r.failed.length || !run.baseline.rollbackAvailable) die(`Could not restore everything (${run.baseline.rollbackAvailable ? `${r.failed.length} file(s) failed` : 'no baseline copy was kept: the project was too large'}). Use git to undo: git status / git checkout -- <file>.`);
  run.status = 'ROLLED_BACK'; run.rolledBackAt = new Date().toISOString(); saveRun(run);
  if (run.backlogId) updateBacklogItem(run.backlogId, { status: 'BLOCKED', blockedReason: 'ROLLED_BACK by a human. Set it READY again when it should be retried.' });
  if (fs.existsSync(path.join(ROOT, run.baseline.dir))) fs.rmSync(path.join(ROOT, run.baseline.dir), { recursive: true, force: true });
  console.log(`Rolled back run ${run.id}: ${r.restored.length} file(s) restored to how they were before the run.`);
}

function propose() {
  const sid = positional[0];
  const { charter, leads } = teamOrDie();
  if (!sid) die('Usage: visible.mjs propose <auto-session> \'<tasks json>\'');
  if (!charter.autonomous) die('Autonomous mode is off in .harness/charter.md.');
  if (PLACEHOLDER.test(charter.text)) die('The charter objectives are still the placeholder text, so there is nothing to base new tasks on. Ask the owner to fill them in (.harness/charter.md, section 1).', 5);
  const runs = sessionRuns(sid);
  const remaining = charter.maxAutoTasksPerRun - runs.length;
  if (remaining <= 0) die(`Auto budget used (${runs.length}/${charter.maxAutoTasksPerRun}). Report to the human.`, 3);
  let raw = positional[1]; if (raw === '-' || raw === undefined) raw = fs.readFileSync(0, 'utf8');
  let plan; try { plan = JSON.parse(raw); } catch { die('The tasks are not valid JSON. Expected {"tasks":[{"title","goal","priority","files":[…],"acceptanceCriteria":[…],"interfaceContract":"…"}]}'); }
  const b = readBacklog(); const norm = (t) => String(t || '').toLowerCase().replace(/\W+/g, ' ').trim();
  const have = new Set(b.tasks.map((t) => norm(t.title || t.goal))); const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const added = []; const rejected = [];
  for (const [i, t] of (plan.tasks || []).entries()) {
    try {
      if (added.length >= remaining) throw new Error(`over the auto budget (${charter.maxAutoTasksPerRun} task(s) per session)`);
      if (!t.title || !String(t.title).trim()) throw new Error('no title');
      if (have.has(norm(t.title))) throw new Error('duplicate of an existing backlog item');
      if (!Array.isArray(t.files) || !t.files.length) throw new Error('no files');
      const files = t.files.map((f) => { const s = normalizeTarget(f); if (!s) throw new Error(`unsafe path "${f}"`); return s; });
      for (const f of files) {
        if (!leads.some((l) => leadOwns(l, f, leads))) throw new Error(`"${f}" is not inside any lead's scope`);
        if (matchesAny(f, charter.forbiddenPaths)) throw new Error(`"${f}" is forbidden by the charter`);
        if (charter.allowedPaths.length && !withinAll(f, charter.allowedPaths)) throw new Error(`"${f}" is outside the charter's allowed paths`);
      }
      added.push({ id: `AUTO-${stamp}-${i + 1}`, title: String(t.title).slice(0, 200), goal: t.goal || t.title, priority: Number(t.priority) || i + 1, status: 'READY', source: 'orchestrator', createdAt: new Date().toISOString(),
        targetFiles: files, acceptanceCriteria: Array.isArray(t.acceptanceCriteria) ? t.acceptanceCriteria.map(String) : [], interfaceContract: typeof t.interfaceContract === 'string' ? t.interfaceContract : '',
        // an AI-suggested check is recorded only, never run (same rule as the headless controller)
        verifySuggestion: typeof t.verifySuggestion === 'string' ? t.verifySuggestion.slice(0, 300) : '' });
      have.add(norm(t.title));
    } catch (e) { rejected.push(`"${t.title || '(untitled)'}": ${e.message}`); }
  }
  if (added.length) { const fresh = readBacklog(); fresh.tasks.push(...added); writeBacklog(fresh); }
  console.log(`Added ${added.length} READY task(s)${added.length ? `: ${added.map((x) => x.id).join(', ')}` : ''}. Budget left in this session: ${remaining - added.length}.`);
  rejected.forEach((r) => console.log(`  rejected ${r}`));
  if (!added.length) process.exit(1);
}

function handoff() {
  const run = positional[0] ? loadRun(positional[0]) : findDefaultHandoffRun();
  if (!run) die('No editor-workflow runs found yet. Start one with: node .harness/visible.mjs brief --goal "…"');
  const info = inspectVisibleRun(run, config);
  if (has('--json')) {
    const { reportMd, ...restInfo } = info;
    console.log(JSON.stringify({
      run: {
        id: run.id,
        status: run.status,
        editor: run.editor || 'claude-code',
        title: run.title,
        goal: run.goal,
        backlogId: run.backlogId || null,
        cycles: run.cycles,
        check: run.check,
        userAllowed: run.userAllowed,
        acceptanceCriteria: run.acceptanceCriteria,
        interfaceContract: run.interfaceContract,
        assignments: run.assignments,
        lastVerify: run.lastVerify || null,
        pendingJobId: run.pendingJobId || null,
        resumedJobId: run.resumedJobId || null,
        baseline: { rollbackAvailable: !!run.baseline?.rollbackAvailable }
      },
      ...restInfo,
      reportMd,
      prompt: buildHandoffPrompt(run, info, config)
    }, null, 2));
    return;
  }
  if (has('--prompt')) {
    console.log(buildHandoffPrompt(run, info, config));
    return;
  }
  console.log(formatHandoffText(run, info, config));
}

function status() {
  const runs = allRuns();
  if (!runs.length) { console.log('No editor-workflow runs yet. Start one with /harness:run in Claude Code (or: node .harness/visible.mjs brief --goal "…").'); return; }
  for (const r of runs.slice(-15)) {
    const ed = r.editor && r.editor !== 'claude-code' ? `  [${editorDisplayName(r.editor)}]` : '';
    const job = r.pendingJobId ? `  [headless: ${r.pendingJobId}]` : '';
    console.log(`${r.id}  ${r.status.padEnd(22)} ${r.title}${r.backlogId ? `  [${r.backlogId}]` : ''}${ed}${job}`);
  }
}

switch (cmd) {
  case 'brief': brief(); break;
  case 'assign': assign(); break;
  case 'verify': verify(); break;
  case 'handoff': handoff(); break;
  case 'rollback': rollback(); break;
  case 'propose': propose(); break;
  case 'report': { const f = path.join(runDir(positional[0] || ''), 'report.md'); if (!fs.existsSync(f)) die(`No report for run ${positional[0] || '(none)'} yet (verify it first).`); console.log(fs.readFileSync(f, 'utf8')); break; }
  case 'status': status(); break;
  default: die(`Unknown command "${cmd}". Use: brief | assign | verify | handoff | rollback | propose | status | report`);
}
