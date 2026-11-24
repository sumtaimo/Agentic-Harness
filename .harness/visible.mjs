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
 *   node .harness/visible.mjs brief  --goal "<what to build>" [--files "src/,docs/"] [--check "<cmd>"] [--bugfix] [--editor <name>]
 *   node .harness/visible.mjs brief  --next [--auto-session <id>] [--editor <name>]   take the highest-priority READY backlog item
 *   node .harness/visible.mjs assign <run> '<delegation json>' [--editor <name>]       validate delegation, print each agent's prompt
 *   node .harness/visible.mjs verify <run> [--reports '<json {lead: "one-line report"}>']
 *   node .harness/visible.mjs judge  <run> --agent reviewer|security (--verdict '<json or report>' | --file <path>)   LLM judge gate after PASSED
 *   node .harness/visible.mjs visual attach  <run> --screenshot <png>[,<png>] --note "<what it shows>"   visual gate (UI changed): attach screenshot evidence
 *   node .harness/visible.mjs visual confirm <run> --by "<name>" [--note "…"]   visual gate: a human looked and said yes (Claude Code asks the human)
 *   node .harness/visible.mjs visual reject  <run> --reason "<what is wrong>"     visual gate: not good enough (REVIEW_BLOCKED, fix, verify again)
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
import { ROOT, FILES, ensureDirs, loadConfig, readJsonSafe, atomicWriteJson, listProjectFiles, detectVerifyCmd, buildRepoMap, memoryContext, recordSession, remember, normalizeTarget, clipErrorTrace, diagnoseVerifyFailure, formatDiagnosis, helpIfAsked, pendingCostReasons, aiUsageSince, usageTodayLine } from './lib/common.mjs';
helpIfAsked(import.meta.url);
import { fetchSkillsOnDemand } from './lib/skill-fetch.mjs';
import { readCharter, loadRoles, loadSkills, matchSkills, loadTeam, validateTeam, validateDelegation, matchesAny, withinAll, readBacklog, writeBacklog, updateBacklogItem, nextReady, leadOwns, editorModelFor, runsNode, ENGINE_SCRIPTS, isTestFilePath, auditPatchSignals, scanPatchSafety } from './lib/governance.mjs';
import { JUDGE_AGENTS, JUDGE_DEFAULT_MIN_SCORE, JUDGE_FORMAT, parseJudgeVerdict, decideJudge, formatJudge, UNTRUSTED_CONTENT_RULE, scanInjection, taskText, injectionHoldReason, isReviewableFile, reviewPolicy, judgeApproved, scanAddedInjection, isUiFile, visualPending, reviewComplete, checkVisualEvidence, checkVisualConfirmOrigin, askVisualConfirm } from './lib/guard.mjs';
import { VISIBLE_TERMINAL, MAX_VISIBLE_FILES, normalizeEditor, editorDisplayName, editorUsageKey, visibleRunDir, listVisibleRuns, stripSlash, insideTargets, captureSnapshot, diffSnapshots, restoreVisibleFiles, findDefaultHandoffRun, inspectVisibleRun, buildHandoffPrompt, formatHandoffText } from './lib/handoff.mjs';

if (process.env.HARNESS_WORKER === '1') { console.error('Harness workers must not use the editor workflow.'); process.exit(2); }
ensureDirs();

const TERMINAL = VISIBLE_TERMINAL;
const MAX_FILES = MAX_VISIBLE_FILES;
const MAX_BASELINE_BYTES = 25 * 1024 * 1024;
const PLACEHOLDER = /\(describe your product goals here/;

const config = loadConfig();
const argv = process.argv.slice(2);
const [cmd = 'status', ...rest] = argv;
const BOOLEAN_FLAGS = new Set(['--next', '--force', '--prompt', '--json', '--bugfix']);
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
  // A run id is a single folder name made by brief (V-…); never a path, so it can never reach outside .harness/visible/.
  if (id && !/^[\w.-]+$/.test(String(id))) die(`Not a run id: ${id}. See: node .harness/visible.mjs status`);
  const f = path.join(runDir(String(id || '')), 'run.json');
  if (!id || !fs.existsSync(f)) die(`No such run: ${id || '(none given)'}. See: node .harness/visible.mjs status`);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
const saveRun = (r) => { fs.mkdirSync(runDir(r.id), { recursive: true }); atomicWriteJson(path.join(runDir(r.id), 'run.json'), r); };
const allRuns = () => listVisibleRuns();

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
  const sk = matchSkills({ skills: lead.skills || [], prompt: a.goal }, String(lead.role).toUpperCase(), skills).chosen; // same rule as headless workers: explicit + autoApply + keywords in this assignment
  const memory = memoryContext(config, {
    query: {
      title: run.title,
      goal: `${a.goal || ''}\n${run.goal || ''}`,
      files: a.files || [],
      error: run.lastVerify && !run.lastVerify.passed ? (run.lastVerify.trace || run.lastVerify.check || '') : ''
    }
  });
  return [
    `You are ${lead.id} (role ${lead.role}), a lead on the agent team. The orchestrator delegated this to you in run ${run.id}. Work ONLY inside the project folder ${ROOT}.`,
    `\nYour assignment: ${a.goal}`,
    `\nYou may create or change ONLY these files/folders: ${a.files.join(', ')}.`,
    'Do not touch anything else: the controller compares every changed file against the assignments after all agents finish, reverts anything outside your files, and the run fails.',
    `\n${UNTRUSTED_CONTENT_RULE}`,
    run.interfaceContract ? `\nShared interface contract (the other leads are building against exactly this, in parallel):\n${run.interfaceContract}` : '',
    run.acceptanceCriteria?.length ? `\nAcceptance criteria:\n${run.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}` : '',
    `\nTask overall: ${run.goal}`,
    sk.length ? `\nMandatory skill rules for you (use only the skills listed here; run a skill's engine/*.mjs script only if your role may run node${runsNode(role) ? ', which yours may' : ', which yours may not: report that step for DEV_ENGINEER instead'}):\n${sk.map((s) => `### ${s.name}\n${s.body}`).join('\n\n')}` : '',
    memory ? `\nRules the user taught (follow them):\n${memory}` : '',
    (role.allowedTools || []).some((r) => /^Bash\((npm|node)/.test(r)) ? `\nYou may check your work with \`npm test\`${runsNode(role) ? ` or \`node --test\`, and run ${ENGINE_SCRIPTS}` : ''}; do not run other commands.` : '\nYou have no shell; use the file tools only.',
    '\nWhen done, reply with a short report (at most 5 lines): files changed, what you did, what you checked, anything unresolved. Do not claim you tested something you did not run.'
  ].filter(Boolean).join('\n');
}

/** How the visual gate is opened (one sentence, used by the report and by the commands). */
function gateHow(run) {
  return `a human confirms it looks right (node .harness/visible.mjs visual confirm ${run.id} --by "<name>", allowed in Claude Code via ask prompt or in a human terminal), or screenshot evidence of the changed UI is attached (node .harness/visible.mjs visual attach ${run.id} --screenshot <file.png>[,<file2.png>] --note "<what it shows: width, theme, state>"; with the Playwright MCP the orchestrator takes it at phone and desktop width). The reviewer should Read the screenshots to score craft and states.`;
}

function reportText(run, v) {
  const L = [];
  const head = { PASSED: 'PASSED ✔', FAILED: 'NOT PASSED YET ✖ (can be fixed and re-verified)', HALTED_HITL_REQUIRED: 'STOPPED ✖ — a human decision is needed', ROLLED_BACK: 'ROLLED BACK', ESCALATED: 'ESCALATED — a human decision is needed' }[v.status] || v.status;
  const visual = v.status === 'PASSED' && v.uiFiles?.length;
  const gated = visual && run.visualRequired;
  const noSignal = v.status === 'PASSED' && run.check?.real === false;
  const sessionLabel = run.editor && run.editor !== 'claude-code' ? `${editorDisplayName(run.editor)} editor session` : 'editor session';
  L.push(`HARNESS REPORT — run ${run.id} — ${head}${noSignal ? ' (NO REAL TEST SIGNAL: the check cannot fail)' : ''}${visual ? ' — NEEDS A VISUAL REVIEW' : ''}`, '', `Task:    ${run.title}`, `Source:  ${run.source === 'backlog' ? `backlog item ${run.backlogId}` : 'goal given by the human'}${run.autonomous ? ' (autonomous mode)' : ''}`,
    `Flow:    controller → orchestrator (${sessionLabel}) → ${run.assignments.map((a) => a.lead).join(', ')} → controller verify → this report`, '');
  if (run.skillsFetched?.length) L.push(`Skills added from Skill Foundry for this task: ${run.skillsFetched.join(' | ')}`, '');
  L.push('What each agent did:');
  const leads = run.leads || [];
  for (const a of run.assignments) {
    const lead = leads.find((l) => l.id === a.lead);
    const mine = v.changes.filter((f) => { const p = f.replace(/^[+~-] /, ''); return inside(p, a.files) && (!lead || !leads.length || leadOwns(lead, p, leads)); });
    // Who did what: the lead, its task in a few words, then its files.
    const job = String(a.goal || '').replace(/\s+/g, ' ').trim();
    L.push(`  • ${a.lead}${job ? ` · ${job.length > 60 ? `${job.slice(0, 57)}…` : job}` : ''}: ${mine.length ? mine.join(', ') : 'no file changes'}${v.reports?.[a.lead] ? `\n      says: ${v.reports[a.lead]}` : ''}`);
  }
  L.push('', `Check:   ${run.check.cmd}  (${run.check.source})`, `         → ${v.checkResult}`);
  if (v.testsChangedAfterFail?.length) L.push(`  ⚠ After the last failed check, ${v.testsChangedAfterFail.length} test file(s) were changed (${v.testsChangedAfterFail.slice(0, 4).join(', ')}${v.testsChangedAfterFail.length > 4 ? ', …' : ''}).`,
    '    Look at that diff: the tests must have been FIXED, not weakened until they passed.');
  if (v.testsDeleted?.length) L.push(`  ⚠ ${v.testsDeleted.length} test file(s) that existed before this run were DELETED (${v.testsDeleted.slice(0, 4).join(', ')}${v.testsDeleted.slice(0, 4).length < v.testsDeleted.length ? ', …' : ''}). Make sure that was intended.`);
  if (v.skipped) L.push(`  ⚠ ${v.skipped} test(s) were SKIPPED. A skipped test proves nothing: find out why (for example a missing browser) before trusting this result.`);
  if (v.patchSafety?.blocking?.length) L.push('', 'Safety gate BLOCKED (remove secrets/conflict markers before passing verify):', ...v.patchSafety.blocking.map((s) => `  ✖ ${s}`));
  if (v.patchSafety?.warnings?.length) L.push('', 'Safety warnings (non-blocking):', ...v.patchSafety.warnings.map((w) => `  ⚠ ${w}`));
  if (v.antiCheatSignals?.length) L.push('', 'Anti-cheat & root-cause signals:', ...v.antiCheatSignals.map((s) => `  ⚠ ${s}`));
  if (v.status !== 'PASSED' && v.diagnosis?.headline) L.push('', 'Failure diagnosis:', ...formatDiagnosis(v.diagnosis).split('\n').map((l) => `  ${l}`));
  if (visual) L.push('', `Visual review needed: ${v.uiFiles.length} UI file(s) changed (${v.uiFiles.slice(0, 6).join(', ')}${v.uiFiles.length > 6 ? ', …' : ''}).`,
    `  Passing tests do not prove a page looks right${v.browserCheck ? '' : ', and this check never opened a browser (a broken page script would still pass)'}.`,
    '  Open it at desktop and phone width, in light and dark, and compare it with the spec before you commit.');
  if (gated) L.push(`  THIS BLOCKS APPROVAL: the run is not DONE until ${gateHow(run)}`);
  if (v.checkCreated?.length) L.push('', `⚠ The check created ${v.checkCreated.length} file(s) that git does not ignore (${v.checkCreated.slice(0, 4).join(', ')}${v.checkCreated.length > 4 ? ', …' : ''}).`,
    '  Add them (for example dist/) to .gitignore, or they will be committed by accident and counted as out-of-scope changes next time.');
  if (v.violations.length) L.push('', 'Violations (changes outside the assigned files):', ...v.violations.map((x) => `  ✖ ${x}`));
  if (v.reverted.length) L.push(`         The controller reverted ${v.reverted.length} out-of-scope change(s): ${v.reverted.join(', ')}`);
  if (v.revertFailed?.length) L.push(`  ⚠ COULD NOT be reverted automatically (secrets are never copied): ${v.revertFailed.join(', ')} — check and restore them by hand before anything else.`);
  if (v.status === 'PASSED' && run.reviewRequired) L.push('', 'JUDGE REQUIRED: this code change is not DONE until the reviewer judge approves it (it must also answer "Done vs Good": the original goal, and what is still weak or missing).',
    `  Start the read-only reviewer (and security when input, auth, files, network or secrets are touched), then: node .harness/visible.mjs judge ${run.id} --agent reviewer --file <report>`);
  if (v.status === 'PASSED' && run.acceptanceCriteria?.length) L.push('', 'Acceptance criteria — confirm each one yourself (a passing check does not prove them by itself):', ...run.acceptanceCriteria.map((c) => `  ☐ ${c}`));
  L.push('', `Cycle ${run.cycles}/${config.maxCycles ?? 3}.`);
  if (v.status === 'PASSED') L.push('', 'Next for you: review the changes (git diff) and commit them when you are happy. Cost: not measured in the editor workflow (see the agent panel for tokens).');
  else if (v.status === 'FAILED') L.push('',
    'Root-cause retry rule: before patching, run Phase 1 Root-Cause Analysis (Symptom, Root Cause, Blast Radius) from the failure trace. Never hardcode returns, disable validation, weaken tests, or swallow errors.',
    `Next: send the failure to the responsible lead(s), then run: node .harness/visible.mjs verify ${run.id}`);
  else if (v.autoRolledBack) L.push('', 'Files were restored to how they were before the run. Decide: fix the task, then run it again.');
  else L.push('', `Files were left as they are (${run.baseline?.rollbackAvailable ? 'some files could not be restored automatically' : 'no baseline copy'}). Decide: fix the task, then run it again.${run.baseline?.rollbackAvailable ? ` To undo by hand: node .harness/visible.mjs rollback ${run.id}` : ''}`);
  return L.join('\n');
}

const sessionRuns = (sid) => allRuns().filter((r) => r.autoSession === sid);

// ───────────────────────────── commands ─────────────────────────────

function brief() {
  const { team, roles, charter, orch, leads } = teamOrDie();
  const sid = flag('--auto-session');
  const wantNext = has('--next');
  const itemArg = flag('--item');
  const goalArg = flag('--goal');
  if (!wantNext && !itemArg && !goalArg) die('Give --goal "<what to build>", or --item <backlog id>, or --next.');
  if (wantNext && itemArg) die('Cannot combine --next and --item: choose either --next or --item <id>.');
  if ((wantNext || itemArg) && goalArg) die('Cannot combine --goal with --next or --item: the backlog item provides the goal.');
  const editorFlag = flag('--editor');
  if ((has('--editor') || rest.some((a) => a.startsWith('--editor='))) && !editorFlag) {
    die('Give an editor name after --editor (for example: --editor antigravity or --editor cursor).');
  }
  let editor = 'claude-code';
  if (editorFlag !== undefined) {
    try { editor = normalizeEditor(editorFlag) || 'claude-code'; } catch (e) { die(e.message); }
  }

  const rawFiles = flag('--files');
  if (has('--files') && !rawFiles) die('Give comma-separated paths after --files (for example: --files "src/,docs/").');
  const userAllowed = [];
  if (rawFiles) {
    for (const part of rawFiles.split(',').map((s) => s.trim()).filter(Boolean)) {
      const norm = normalizeTarget(part);
      if (!norm) die(`Invalid --files entry "${part}": must be a safe relative project path outside .git and .harness.`);
      userAllowed.push(norm);
    }
    if (!userAllowed.length) die('--files gave no valid relative paths.');
  }

  const open = allRuns().filter((r) => !TERMINAL.has(r.status));
  if (open.length && !has('--force')) die(`Run ${open[0].id} ("${open[0].title}") is not finished (${open[0].status}). Verify or roll it back first: node .harness/visible.mjs verify ${open[0].id} | rollback ${open[0].id}`, 4);

  let item = null; const auto = wantNext || !!sid;
  if (auto) {
    if (!charter.autonomous) die('Autonomous mode is off in .harness/charter.md ("- autonomous: off"). Use --goal, or ask the owner to turn it on.', 1);
    const awaiting = allRuns().find((r) => r.status === 'PASSED' && (r.reviewRequired || r.visualRequired) && !reviewComplete(r));
    if (awaiting) die(`Autonomy is paused: run ${awaiting.id} passed its check but its review is not complete. ${awaiting.reviewRequired && !judgeApproved(awaiting) ? `The judge has not approved it yet (run the reviewer, then: node .harness/visible.mjs judge ${awaiting.id} --agent reviewer --file <report>). ` : ''}${visualPending(awaiting) ? `The changed UI still needs a visual review: ${gateHow(awaiting)}` : ''}`.trim(), 4);
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
      const injection = injectionHoldReason(item);
      if (injection) { updateBacklogItem(item.id, { status: 'BLOCKED', needsApproval: true, blockedReason: injection }); held.push(`${item.id} ("${item.title || item.goal}", possible prompt injection)`); continue; }
      const pending = pendingCostReasons(config, item);
      if (!pending.length) break;
      updateBacklogItem(item.id, { status: 'BLOCKED', needsApproval: true, blockedReason: `Needs your OK (may use a lot of quota): ${pending.map((p) => p.text).join('; ')}. Approve: node .harness/backlog.mjs approve ${item.id}` });
      held.push(`${item.id} ("${item.title || item.goal}")`);
    }
    if (held.length) console.log(`HELD for the human's OK (big runs; tell the user, approve only after a clear yes): ${held.join(', ')}. Approve one with: node .harness/backlog.mjs approve <id>`);
    if (!item) {
      const waiting = readBacklog().tasks.filter((t) => t.status === 'READY');
      if (waiting.length || held.length) die(`Nothing can start now, but the backlog is NOT empty: ${waiting.length ? `${waiting.length} READY item(s) wait for other items (${waiting.slice(0, 3).map((t) => `${t.id} after ${(t.dependsOn || []).join('+')}`).join(', ')})` : ''}${waiting.length && held.length ? '; ' : ''}${held.length ? `${held.length} held for the human's OK` : ''}. Do NOT propose new tasks: report to the human.`, 6);
      die('Nothing is READY in the backlog.', 6);
    }
  }
  if (itemArg) { item = readBacklog().tasks.find((t) => t.id === itemArg); if (!item) die(`No backlog item ${itemArg}.`); if (item.status !== 'READY') die(`Backlog item ${item.id} is ${item.status}, not READY.`); }

  const goal = item ? (item.goal || item.title) : goalArg;
  let check = flag('--check') ? { cmd: flag('--check'), source: 'given by the human', real: true } : item?.verifyCmd ? { cmd: item.verifyCmd, source: `backlog item ${item.id}`, real: true } : (() => { const d = detectVerifyCmd(ROOT, config); return { cmd: d.cmd, source: d.source, real: d.real }; })();
  if (auto && charter.requireRealCheck && !check.real) die('This project has no real check (add a project test/check script or a "verifyCmd" to the task). Autonomous work needs one (charter requireRealCheck).', 1);

  const id = `V-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 5)}`;
  // Skill Foundry on demand, BEFORE the baseline: a skill this goal needs for a lead's role is added now (at most 2), so
  // verify never sees the added skill files as an agent's edit. "Automatic, then tell": printed below and in the report.
  const fetchedSkills = (() => {
    const r = fetchSkillsOnDemand(leads.map((l) => ({ id: l.id, role: l.role, prompt: String(goal || '') })), loadSkills(), { root: ROOT });
    const lines = r.wanted.filter((w) => r.fetched.includes(w.name)).map((w) => `${w.name}: the task mentions "${w.keyword || 'its subject'}"; role ${w.role} (${w.worker})`);
    return { lines, failed: !r.fetched.length && r.wanted.length ? `${r.wanted.map((w) => w.name).join(', ')} not added (${r.skipped})` : '' };
  })();
  const scopeGlobs = userAllowed.length ? userAllowed : charter.allowedPaths;
  const snap = snapshot(scopeGlobs);
  const rollbackAvailable = snap.bytes <= MAX_BASELINE_BYTES;
  const baseDirRel = path.posix.join('.harness', 'visible', id, 'baseline');
  // secrets (.env*) are compared by hash only: they are never copied into the baseline
  if (rollbackAvailable) for (const f of Object.keys(snap.map).filter((k) => !/^\.env/.test(k))) { const dest = path.join(ROOT, baseDirRel, f); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(path.join(ROOT, f), dest); }
  const bugfix = Boolean(has('--bugfix') || item?.bugfix);
  const run = {
    id, status: 'BRIEFED', editor, createdAt: new Date().toISOString(), source: item ? 'backlog' : 'goal', backlogId: item?.id || null, autonomous: auto, autoSession: sid || null,
    ...(bugfix ? { bugfix: true } : {}),
    title: item?.title || String(goal).slice(0, 80), goal, userAllowed, acceptanceCriteria: item?.acceptanceCriteria || [], interfaceContract: item?.interfaceContract || '',
    check, cycles: 0, assignAttempts: 0, assignments: [],
    ...(fetchedSkills.lines.length ? { skillsFetched: fetchedSkills.lines } : {}), ...(fetchedSkills.failed ? { skillsFetchFailed: fetchedSkills.failed } : {}),
    charter: { allowedPaths: charter.allowedPaths, forbiddenPaths: charter.forbiddenPaths },
    orchestrator: orch.id, delegable: orch.canDelegateTo?.length ? orch.canDelegateTo : leads.map((l) => l.id),
    leads: leads.map((l) => ({ id: l.id, role: l.role, scope: l.scope, maxWorkers: l.maxWorkers ?? 3, skills: l.skills || [] })),
    baseline: { files: snap.map, bytes: snap.bytes, scoped: snap.scoped, rollbackAvailable, dir: rollbackAvailable ? baseDirRel : null }
  };
  saveRun(run);
  if (item) updateBacklogItem(item.id, { status: 'IN_PROGRESS', startedAt: new Date().toISOString(), visibleRun: id });
  const { files } = listProjectFiles(ROOT, 60);
  const memory = memoryContext(config, { query: { title: run.title, goal, files: userAllowed } });
  const repoMap = buildRepoMap(ROOT, { maxChars: 1200 });
  console.log(`RUN_ID=${id}`);
  console.log(`\nORCHESTRATOR BRIEF — run ${id}${auto ? ' (autonomous mode)' : ''}${run.bugfix ? ' (bugfix)' : ''}`);
  if (editor !== 'claude-code') console.log(`Editor: ${editorDisplayName(editor)}`);
  console.log(`\nTask: ${run.title}\nGoal: ${goal}`);
  if (run.skillsFetched) console.log(`Skills added from Skill Foundry for this task (tell the human): ${run.skillsFetched.join(' | ')}`);
  if (run.skillsFetchFailed) console.log(`Skills not added: ${run.skillsFetchFailed}`);
  if (run.acceptanceCriteria.length) console.log(`Acceptance criteria:\n${run.acceptanceCriteria.map((c) => `  - ${c}`).join('\n')}`);
  if (run.interfaceContract) console.log(`Interface contract:\n${run.interfaceContract}`);
  console.log(`\nCheck (run by the controller after the agents finish): ${check.cmd}  [${check.source}]${check.real ? '' : '\n  ⚠ NO REAL CHECK: any result would pass. Tell the human and propose a check.'}`);
  if (check.real && !BROWSER_CHECK.test(check.cmd) && Object.keys(snap.map).some((f) => isUiFile(f))) console.log('  ⚠ This project has UI files but the check never opens a browser: a page with a broken script or layout can still pass. If this task changes UI, tell the human and suggest a browser smoke test; the report will ask for a visual review.');
  console.log('\nTeam — delegate ONLY to these named agents, each at most once (their scope is enforced):');
  for (const l of run.leads) console.log(`  - ${l.id} (${l.role}) may own: ${l.scope.join(', ')}`);
  const foundStates = ['product.md', 'domain.md', 'brand.md'].map((f) => {
    const p = path.join(ROOT, 'docs', 'foundation', f);
    if (!fs.existsSync(p)) return null;
    const blank = /^- .*\(fill me/im.test(fs.readFileSync(p, 'utf8'));
    return `${f} (${blank ? 'has blanks' : 'filled'})`;
  }).filter(Boolean);
  if (foundStates.length) console.log(`Foundation forms (docs/foundation/, pass by reference for features/UI): ${foundStates.join(', ')}`);
  if (userAllowed.length) console.log(`The human only allows files inside: ${userAllowed.join(', ')}`);
  console.log(`Never allowed: ${charter.forbiddenPaths.join(', ')}${auto && charter.allowedPaths.length ? `\nAutonomous work stays inside: ${charter.allowedPaths.join(', ')}` : ''}`);
  if (run.bugfix) {
    console.log("\nBugfix workflow (Red-Green option): assign lead-qa and lead-dev in ONE assign call (run lead-qa first [Red] to confirm the bug test fails, then run lead-dev [Green] before verify) — or run two separate brief runs — and require Symptom / Root Cause / Blast Radius in lead-dev's report.");
  }
  console.log(`\nHow to proceed, as the orchestrator (you only plan; the agents do the work):\n  1. Decide which lead gets which files. Write the delegation as JSON:\n     {"interfaceContract":"exact names/signatures/formats the agents share","assignments":[{"lead":"lead-dev","goal":"…","files":["src/x.js"]}]}\n  2. Validate it: node .harness/visible.mjs assign ${id} '<json>'   (it prints each agent's ready-made prompt)\n  3. Start ALL assigned agents in ONE message with the Agent tool (subagent_type = the lead's id) so they run in parallel and are visible.\n  4. When they have reported: node .harness/visible.mjs verify ${id} --reports '{"lead-dev":"<their one-line report>"}'\n  5. If code changed after PASSED: run read-only reviewer (Done vs Good) -> visible.mjs judge; if UI changed, attach screenshots (visual attach) or have the human run visual confirm in a terminal; then report to the human in plain words.`);
  if (memory) console.log(`\nRules the user taught:\n${memory}`);
  if (repoMap) console.log(`\nRepo summary:\n${repoMap}`);
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
  const short = (g) => { const t = String(g || '').replace(/\s+/g, ' ').trim(); return t.length > 40 ? `${t.slice(0, 37)}…` : t; };
  console.log(`DELEGATION OK for run ${id}: ${run.assignments.map((a) => `${a.lead}${a.goal ? ` · ${short(a.goal)}` : ''} → ${a.files.join(', ')}`).join('  |  ')}\n`);
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
  if (!['DELEGATED', 'FAILED', 'REVIEW_BLOCKED'].includes(run.status)) die(`Run ${run.id} is ${run.status}; it can only be verified after assign (DELEGATED), after a failed verify, or after the judge blocked it (REVIEW_BLOCKED).`);
  if (run.status === 'REVIEW_BLOCKED') { delete run.reviews; delete run.visual; fs.rmSync(path.join(runDir(run.id), 'judge.md'), { force: true }); } // the code changed: it needs a fresh judge verdict
  const prevTrace = run.lastVerify && !run.lastVerify.passed ? (run.lastVerify.trace || run.lastVerify.check || '') : '';
  let reports = {}; try { reports = flag('--reports') ? JSON.parse(flag('--reports')) : {}; } catch { /* ignore a malformed summary */ }
  run.cycles += 1;
  const scopeGlobs = run.userAllowed?.length ? run.userAllowed : (run.charter?.allowedPaths || []);
  const snap = () => snapshot(scopeGlobs, run.baseline.files).map;
  const cur = snap();
  const d = diffSnapshots(run.baseline.files, cur);
  const violations = []; const violating = [];
  const leads = run.leads || [];
  const hasQaLead = leads.some((l) => String(l.role).toUpperCase() === 'QA_AUDITOR');
  for (const f of d.all) {
    const owner = run.assignments.find((a) => {
      if (!inside(f, a.files)) return false;
      const lead = leads.find((l) => l.id === a.lead);
      return !lead || !leads.length || leadOwns(lead, f, leads);
    });
    if (!owner) { violations.push(`${f}: not inside any lead's assigned files`); violating.push(f); continue; }
    const ownerLead = leads.find((l) => l.id === owner.lead);
    if (ownerLead && hasQaLead && String(ownerLead.role).toUpperCase() !== 'QA_AUDITOR' && isTestFilePath(f)) {
      violations.push(`${f}: test file may only be owned by lead-qa`);
      violating.push(f);
      continue;
    }
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
  // UI that a person can look at: not test files and not docs (isReviewableFile), so a QA-only change to Button.test.tsx never needs a visual review
  const uiFiles = d.all.filter((f) => !violating.includes(f) && isUiFile(f) && isReviewableFile(f));
  // Quality signals a passing check cannot give by itself:
  // - test files changed AFTER the previous failed check (were the tests fixed, or weakened until they passed?)
  // - test files that existed before the run and were deleted during it
  const testsChangedAfterFail = run.cycleSnapshot ? diffSnapshots(run.cycleSnapshot, cur).all.filter((f) => isTestFilePath(f) && !violating.includes(f)) : [];
  const testsDeleted = d.deleted.filter((f) => isTestFilePath(f) && !violating.includes(f));
  const isBugFix = Boolean(run.bugfix || /\b(fix|bug|broken|regress|error|crash|fail)\b/i.test(run.goal || ''));
  const cleanChanged = d.all.filter((f) => !violating.includes(f) && !d.deleted.includes(f));
  const auditBase = Object.fromEntries(cleanChanged.filter((f) => f in run.baseline.files).map((f) => [f, run.baseline.files[f]]));
  const auditCur = Object.fromEntries(cleanChanged.filter((f) => f in cur).map((f) => [f, cur[f]]));
  const baselineDir = run.baseline?.rollbackAvailable && run.baseline?.dir ? path.join(ROOT, run.baseline.dir) : null;
  const devIds = run.assignments.map((a) => a.lead).filter((id) => {
    const l = leads.find((x) => x.id === id);
    const r = String(l?.role || '').toUpperCase();
    return r === 'DEV_ENGINEER' || (!r && id === 'lead-dev');
  });
  const audit = auditPatchSignals({ baseFiles: auditBase, curFiles: auditCur, root: ROOT, baselineDir, testsChangedAfterFail, reports, cycle: run.cycles, isBugFix, devIds });
  const safety = scanPatchSafety({ baseFiles: auditBase, curFiles: auditCur, root: ROOT, baselineDir });
  const passed = !violations.length && check.ok && !safety.blocked;
  // Instructions an agent planted in a file (non-blocking: shown to the judge and the human)
  const planted = scanAddedInjection(cleanChanged.filter((f) => f in cur).map((f) => {
    const read = (p) => { try { const st = fs.statSync(p); return st.size <= 512 * 1024 ? fs.readFileSync(p, 'utf8') : ''; } catch { return ''; } };
    return { file: f, before: baselineDir ? read(path.join(baselineDir, f)) : '', after: read(path.join(ROOT, f)) };
  }));
  // LLM judge gate: a passing code change is not DONE until the reviewer judge approves it (config.review)
  const policy = reviewPolicy(config);
  const needJudge = passed && policy.required && d.all.some((f) => !violating.includes(f) && isReviewableFile(f));
  delete run.reviews; fs.rmSync(path.join(runDir(run.id), 'judge.md'), { force: true });
  run.reviewRequired = needJudge;
  // Visual gate: a passing check cannot show that changed UI looks right. Until a human confirms it, or a screenshot is attached
  // as evidence, the run is not DONE (config.review.visual: false turns the gate off).
  delete run.visual;
  run.uiChanged = passed && uiFiles.length > 0; // the rubric: craft may not be "n/a" on a UI change (even when the gate is off)
  run.uiFiles = run.uiChanged ? uiFiles : [];
  run.visualRequired = run.uiChanged && policy.visual;
  const maxCycles = config.maxCycles ?? 3;
  const halted = !passed && run.cycles >= maxCycles;
  let autoRolledBack = false;
  if (halted) { const r = restoreFiles(run, diffSnapshots(run.baseline.files, snap()).all); autoRolledBack = r.failed.length === 0 && run.baseline.rollbackAvailable; }
  run.status = passed ? 'PASSED' : halted ? 'HALTED_HITL_REQUIRED' : 'FAILED';
  delete run.pendingJobId;
  const rawTrace = !passed ? [
    ...violations,
    ...safety.blocking.map((b) => `PATCH_SAFETY: ${b}`),
    ...(check.ok ? [] : [check.text])
  ].filter(Boolean).join('\n') : '';
  const diagnosis = !passed ? diagnoseVerifyFailure(rawTrace, {
    previousTrace: prevTrace,
    targetFiles: run.assignments.flatMap((a) => a.files || []),
    subtasks: run.assignments.map((a) => ({ id: a.lead, targetFiles: a.files || [] })),
    verifyCmd: run.check?.cmd || ''
  }) : null;
  const failSummary = !passed ? String(violations[0] || safety.blocking[0] || check.text.split('\n')[0]).replace(/\s+/g, ' ').slice(0, 180) : '';
  if (!passed && !run.firstFailureSummary) run.firstFailureSummary = failSummary;
  if (!passed) run.lastFailureSummary = failSummary;
  run.lastVerify = {
    at: new Date().toISOString(),
    passed,
    violations,
    reverted,
    check: check.text,
    antiCheatSignals: audit.signals,
    patchSafety: { blocking: safety.blocking, warnings: safety.warnings },
    plantedInstructions: planted,
    ...(diagnosis ? { diagnosis } : {}),
    ...(rawTrace ? { trace: clipErrorTrace(rawTrace, 4000) } : {})
  };
  if (passed || halted) delete run.cycleSnapshot; else run.cycleSnapshot = snap(); // what the project looked like when this check failed
  run.lastVerify.skipped = check.skipped || 0; run.lastVerify.needsVisualReview = passed && uiFiles.length > 0;
  const v = {
    status: run.status,
    changes,
    violations,
    reverted,
    revertFailed,
    checkResult: check.text,
    reports,
    autoRolledBack,
    skipped: check.skipped || 0,
    uiFiles,
    checkCreated,
    browserCheck: BROWSER_CHECK.test(run.check.cmd),
    testsChangedAfterFail,
    testsDeleted,
    antiCheatSignals: audit.signals,
    patchSafety: { blocking: safety.blocking, warnings: [...safety.warnings, ...planted] },
    diagnosis
  };
  const text = reportText(run, v);
  fs.writeFileSync(path.join(runDir(run.id), 'report.md'), `${text}\n`);
  saveRun(run);

  if (passed && run.backlogId) {
    updateBacklogItem(run.backlogId, needJudge || run.visualRequired
      ? { status: 'IN_PROGRESS', awaitingJudge: needJudge || undefined, awaitingVisual: run.visualRequired || undefined, cyclesUsed: run.cycles, visibleRun: run.id }
      : { status: 'DONE', completedAt: new Date().toISOString(), result: 'VERIFIED', cyclesUsed: run.cycles, visibleRun: run.id, awaitingJudge: undefined, awaitingVisual: undefined });
  }
  if (halted && run.backlogId) updateBacklogItem(run.backlogId, { status: 'BLOCKED', blockedReason: `HALTED_HITL_REQUIRED after ${run.cycles} cycles: ${violations[0] || safety.blocking[0] || check.text.split('\n')[0]}` });
  const recordAuto = (config.memory || {}).autoLessons !== false && !String(run.id).startsWith('V-test');
  if (recordAuto) {
    try {
      if (violations.length) remember(`Scope violation in "${run.title}": ${violations.slice(0, 2).join('; ').replace(/\s+/g, ' ').slice(0, 180)} — keep edits inside assigned files (tests belong to lead-qa).`, FILES.autoLessons);
      if (safety.blocking.length) remember(`Patch safety block in "${run.title}": ${safety.blocking[0].replace(/\s+/g, ' ').slice(0, 180)} — remove secrets or conflict markers before verifying.`, FILES.autoLessons);
      if (audit.signals.length) remember(`Quality/root-cause signal in "${run.title}": ${audit.signals[0].replace(/\s+/g, ' ').slice(0, 180)} — fix root cause cleanly without skipped tests or empty catches.`, FILES.autoLessons);
    } catch { /* memory is best effort */ }
  }
  if (passed || halted) {
    try {
      recordSession({
        taskId: run.id, title: run.title, result: passed ? 'VERIFIED' : 'HALTED_HITL_REQUIRED', cycles: run.cycles, maxCycles, goal: run.goal,
        engine: `${editorDisplayName(run.editor || 'claude-code')} editor agents`, verifyCmd: run.check.cmd, verifySource: run.check.source, planner: `editor workflow: ${run.orchestrator} → ${run.assignments.map((a) => a.lead).join(', ')}`,
        team: { orchestrator: run.orchestrator, assignments: run.assignments.map((a) => ({ lead: a.lead, goal: a.goal, files: a.files, workers: [{ id: a.lead, files: a.files }] })) },
        subtasks: run.assignments.map((a) => ({ id: a.lead, targetFiles: a.files, prompt: a.goal })), errors: passed ? [] : [rawTrace || violations.join('\n') || check.text],
        outputs: Object.entries(reports).map(([id, output]) => ({ id, output })), finishedAt: new Date().toISOString()
      });
      if (recordAuto && passed && run.cycles > 1) remember(`"${run.title}": first attempt failed (${run.firstFailureSummary || run.lastFailureSummary || 'earlier check failure'}) — passed after ${run.cycles} cycles. Check for this earlier next time.`, FILES.autoLessons);
      if (recordAuto && !passed) remember(`"${run.title}": editor run ${run.status} — ${(violations[0] || safety.blocking[0] || check.text.split('\n')[0]).replace(/\s+/g, ' ').slice(0, 200)}. Needs a human decision before retrying.`, FILES.autoLessons);
    } catch { /* memory is best effort */ }
  }
  if (run.baseline.dir && ((passed && !needJudge && !run.visualRequired) || (halted && autoRolledBack)) && fs.existsSync(path.join(ROOT, run.baseline.dir))) {
    fs.rmSync(path.join(ROOT, run.baseline.dir), { recursive: true, force: true });
    if (halted && autoRolledBack) { run.baseline.rollbackAvailable = false; run.baseline.autoRolledBack = true; saveRun(run); }
  }
  console.log(text);
  process.exit(passed ? 0 : 1);
}

/**
 * LLM judge gate: record a reviewer/security verdict for a PASSED run. The controller validates the JSON against the
 * rubric and decides (lib/guard.mjs decideJudge); a block turns the run into REVIEW_BLOCKED and the backlog item BLOCKED.
 */
function judge() {
  const run = loadRun(positional[0]);
  if (!['PASSED', 'REVIEW_BLOCKED'].includes(run.status)) die(`Run ${run.id} is ${run.status}; the judge only reviews a run the controller verified (PASSED).`);
  const agent = flag('--agent') || 'reviewer';
  if (!JUDGE_AGENTS.includes(agent)) die(`--agent must be one of: ${JUDGE_AGENTS.join(', ')}`);
  let raw = flag('--verdict');
  if (flag('--file')) { try { raw = fs.readFileSync(path.resolve(flag('--file')), 'utf8'); } catch (e) { die(`Cannot read --file: ${e.message}`); } }
  if (raw === '-') raw = fs.readFileSync(0, 'utf8');
  if (!raw) die(`Give the judge's verdict with --verdict '<json or full report>' or --file <path>.\n${JUDGE_FORMAT}`);
  const { verdict, errors } = parseJudgeVerdict(raw, { agent });
  if (!verdict) die(`INVALID VERDICT from ${agent} (nothing recorded; ask the agent to answer in the required format):\n  - ${errors.join('\n  - ')}\n${JUDGE_FORMAT}`);
  const minScore = Number.isInteger(config.review?.minScore) ? config.review.minScore : JUDGE_DEFAULT_MIN_SCORE;
  const decision = decideJudge(verdict, { minScore, ui: Boolean(run.uiChanged), agent });
  run.reviews = { ...(run.reviews || {}), [agent]: { at: new Date().toISOString(), ...verdict, approved: decision.approved, reasons: decision.reasons } };
  const blockedBy = Object.entries(run.reviews).filter(([, r]) => !r.approved).map(([a]) => a);
  run.status = blockedBy.length ? 'REVIEW_BLOCKED' : 'PASSED';
  saveRun(run);
  const text = Object.entries(run.reviews).map(([a, r]) => formatJudge(a, r, { approved: r.approved, reasons: r.reasons })).join('\n\n');
  fs.writeFileSync(path.join(runDir(run.id), 'judge.md'), `${text}\n`);
  if (run.backlogId) {
    if (blockedBy.length) updateBacklogItem(run.backlogId, { status: 'BLOCKED', blockedReason: `REVIEW_BLOCKED by ${blockedBy.join(', ')}: ${run.reviews[blockedBy[0]].reasons[0]}. Fix, then verify run ${run.id} again.` });
    else if (judgeApproved(run)) updateBacklogItem(run.backlogId, { awaitingJudge: undefined, blockedReason: undefined });
  }
  if (!blockedBy.length) completeIfReviewed(run);
  if (!decision.approved && (config.memory || {}).autoLessons !== false && !String(run.id).startsWith('V-test')) {
    try { remember(`Judge (${agent}) blocked "${run.title}": ${decision.reasons[0]}${verdict.findings[0] ? ` — ${verdict.findings[0].issue.slice(0, 120)}` : ''}.`, FILES.autoLessons); } catch { /* memory is best effort */ }
  }
  console.log(text);
  console.log(blockedBy.length
    ? `\nREVIEW_BLOCKED: send the findings to the responsible lead, then run: node .harness/visible.mjs verify ${run.id} (and judge it again).`
    : judgeApproved(run) && visualPending(run) ? `\nJUDGE APPROVED, but the run is NOT DONE: the changed UI still needs a visual review. ${gateHow(run)}`
    : judgeApproved(run) ? '\nJUDGE APPROVED: the human reviews the diff and decides whether to commit.' : '\nRecorded. The reviewer verdict is still needed: node .harness/visible.mjs judge ' + run.id + ' --agent reviewer --file <report>');
  process.exit(blockedBy.length ? 1 : 0);
}

/** A run is DONE once the judge (when required) approved and the visual gate (when UI changed) is open: close the backlog item and drop the baseline copy. */
function completeIfReviewed(run) {
  if (!reviewComplete(run)) return false;
  if (run.backlogId) updateBacklogItem(run.backlogId, { status: 'DONE', completedAt: new Date().toISOString(), result: run.reviewRequired ? 'VERIFIED+JUDGED' : 'VERIFIED', awaitingJudge: undefined, awaitingVisual: undefined, blockedReason: undefined });
  if (run.baseline?.dir && fs.existsSync(path.join(ROOT, run.baseline.dir))) fs.rmSync(path.join(ROOT, run.baseline.dir), { recursive: true, force: true });
  return true;
}

function loadVisualRun() {
  const run = loadRun(positional[0]);
  if (run.status !== 'PASSED') die(`Run ${run.id} is ${run.status}; a visual review applies to a run the controller verified (PASSED).`);
  if (!run.visualRequired) die(`Run ${run.id} changed no UI files (or the visual gate is off: config.review.visual), so there is nothing to confirm.`);
  return run;
}

function afterVisual(run, how) {
  saveRun(run);
  fs.writeFileSync(path.join(runDir(run.id), 'visual.md'), `${how}\n`);
  const done = completeIfReviewed(run);
  if (!done && run.backlogId) updateBacklogItem(run.backlogId, { awaitingVisual: undefined });
  console.log(how);
  console.log(done ? '\nVISUAL REVIEW OK and nothing else is pending: the run is DONE. The human reviews the diff and decides whether to commit.'
    : `\nVisual review recorded. Still needed before the run is DONE: ${run.reviewRequired && !judgeApproved(run) ? `the reviewer judge (node .harness/visible.mjs judge ${run.id} --agent reviewer --file <report>; pass the screenshots to the reviewer so it can score craft and states).` : 'nothing else.'}`);
}

/** Visual gate: `visual attach|confirm|reject <run> …` (UI files changed, so a passing check is not enough). */
async function visual() {
  const action = positional.shift();
  if (action === 'attach') return visualAttach();
  if (action === 'confirm') return await visualConfirm();
  if (action === 'reject') return visualReject();
  die('Usage: visible.mjs visual attach <run> --screenshot <png>[,<png>] --note "<what it shows>"  |  visual confirm <run> --by "<name>"  |  visual reject <run> --reason "<what is wrong>"');
}

/** Evidence path: attach screenshots of the changed UI (taken with the Playwright MCP, or by a person). */
function visualAttach() {
  const run = loadVisualRun();
  const files = String(flag('--screenshot') || '').split(',').map((x) => x.trim()).filter(Boolean);
  const note = String(flag('--note') || '').replace(/\s+/g, ' ').trim();
  if (!files.length || note.length < 10) die(`Give the evidence: --screenshot <file.png>[,<file2.png>] (PNG, JPEG or WebP taken AFTER the change) and --note "<what it shows: width, theme, state>" (at least 10 characters).\nOr, when a human has looked at it and said yes: node .harness/visible.mjs visual confirm ${run.id} --by "<name>".`);
  // evidence must be newer than the run and than the last change to any changed UI file: a screenshot of the old look proves nothing
  const newestUi = Math.max(0, ...(run.uiFiles || []).map((f) => { try { return fs.statSync(path.join(ROOT, f)).mtimeMs; } catch { return 0; } }));
  const since = Math.max(Date.parse(run.createdAt) || 0, newestUi);
  const checked = files.map((f) => ({ f, r: checkVisualEvidence(path.resolve(f), { since }) }));
  const bad = checked.filter((c) => !c.r.ok);
  if (bad.length) die(`Screenshot evidence refused (nothing recorded):\n  - ${bad.map((c) => c.r.reason).join('\n  - ')}`);
  const dir = path.join(runDir(run.id), 'visual'); fs.mkdirSync(dir, { recursive: true });
  const kept = checked.map((c, i) => {
    const to = path.join(dir, `${i + 1}-${path.basename(c.f).replace(/[^\w.-]/g, '_')}`);
    fs.copyFileSync(path.resolve(c.f), to);
    return { file: path.relative(ROOT, to).split(path.sep).join('/'), type: c.r.type, bytes: c.r.bytes, sha256: c.r.sha256, ...(c.r.width ? { width: c.r.width, height: c.r.height } : {}) };
  });
  run.visual = { ok: true, how: 'screenshot', at: new Date().toISOString(), note: note.slice(0, 300), screenshots: kept };
  afterVisual(run, `VISUAL EVIDENCE attached to run ${run.id}: ${kept.length} screenshot(s) — "${note.slice(0, 120)}"\n${kept.map((k) => `  ${k.file} (${k.type}${k.width ? `, ${k.width}x${k.height}` : ''}, ${k.bytes} bytes)`).join('\n')}`);
}

/** Visual gate, human path: requires Claude Code ask protection or an interactive human terminal (never silent orchestrator self-approval). */
async function visualConfirm() {
  const run = loadVisualRun();
  const by = String(flag('--by') || '').replace(/\s+/g, ' ').trim();
  if (by.length < 2) die(`Say who looked at it: node .harness/visible.mjs visual confirm ${run.id} --by "<name>" [--note "<what they checked>"]. Run this only after the human said yes.`);
  const origin = checkVisualConfirmOrigin({ root: ROOT, run });
  if (!origin.ok) die(origin.reason);
  if (origin.needsPrompt && !(await askVisualConfirm(run.id, run.title))) die('Visual review confirmation cancelled (human did not confirm).');
  run.visual = { ok: true, how: 'human', confirmMethod: origin.how, at: new Date().toISOString(), by: by.slice(0, 80), note: String(flag('--note') || '').replace(/\s+/g, ' ').trim().slice(0, 300) };
  afterVisual(run, `VISUAL REVIEW CONFIRMED by ${run.visual.by} for run ${run.id}${run.visual.note ? ` — "${run.visual.note}"` : ''}.`);
}

/** Visual gate, rejection: the UI is not good enough. Same road as a judge block: the item is BLOCKED, fix, then verify again. */
function visualReject() {
  const run = loadVisualRun();
  const reason = String(flag('--reason') || '').replace(/\s+/g, ' ').trim();
  if (reason.length < 10) die(`Say what is wrong: node .harness/visible.mjs visual reject ${run.id} --reason "<what looks wrong or is missing>" (at least 10 characters).`);
  run.status = 'REVIEW_BLOCKED'; delete run.visual;
  run.visualRejected = { at: new Date().toISOString(), reason: reason.slice(0, 400) };
  saveRun(run);
  fs.writeFileSync(path.join(runDir(run.id), 'visual.md'), `VISUAL REVIEW REJECTED for run ${run.id}: ${reason}\n`);
  if (run.backlogId) updateBacklogItem(run.backlogId, { status: 'BLOCKED', awaitingVisual: undefined, blockedReason: `VISUAL REVIEW REJECTED: ${reason.slice(0, 200)}. Fix, then verify run ${run.id} again.` });
  console.log(`VISUAL REVIEW REJECTED for run ${run.id}: ${reason}\n\nREVIEW_BLOCKED: send this to the responsible lead (lead-ux for look and feel, lead-dev for behavior), then run: node .harness/visible.mjs verify ${run.id}`);
  process.exit(1);
}

function rollback() {
  const run = loadRun(positional[0]);
  // Decide BEFORE touching any file: a restore without the baseline copy cannot bring changed files back, but it would
  // still delete every file created since the run (newer human work included).
  if (run.status === 'ROLLED_BACK') die(`Run ${run.id} was already rolled back (${run.rolledBackAt || 'earlier'}). Nothing to do.`);
  if (run.baseline?.autoRolledBack) die(`Run ${run.id} was already restored automatically when it halted. Nothing to do.`);
  if (run.status === 'PASSED') die(`Run ${run.id} PASSED, so its baseline copy was removed and newer work may be on top of it. Rolling back now could delete files. Undo it with git instead: git status / git log / git checkout -- <file>.`);
  if (!run.baseline?.rollbackAvailable || !run.baseline.dir || !fs.existsSync(path.join(ROOT, run.baseline.dir))) die(`Run ${run.id} has no baseline copy (${run.baseline?.rollbackAvailable ? 'it was removed' : 'the project was too large to copy'}). Nothing was changed. Use git to undo: git status / git checkout -- <file>.`);
  const scopeGlobs = run.userAllowed?.length ? run.userAllowed : (run.charter?.allowedPaths || []);
  const d = diffSnapshots(run.baseline.files, snapshot(scopeGlobs, run.baseline.files).map);
  const r = restoreFiles(run, d.all);
  if (r.failed.length || !run.baseline.rollbackAvailable) die(`Could not restore everything (${run.baseline.rollbackAvailable ? `${r.failed.length} file(s) failed` : 'no baseline copy was kept: the project was too large'}). Use git to undo: git status / git checkout -- <file>.`);
  run.status = 'ROLLED_BACK'; run.rolledBackAt = new Date().toISOString(); saveRun(run);
  if (run.backlogId) updateBacklogItem(run.backlogId, { status: 'BLOCKED', blockedReason: 'ROLLED_BACK by a human. Set it READY again when it should be retried.' });
  if (fs.existsSync(path.join(ROOT, run.baseline.dir))) fs.rmSync(path.join(ROOT, run.baseline.dir), { recursive: true, force: true });
  run.baseline.rollbackAvailable = false; saveRun(run);
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
      const inj = scanInjection(taskText(t));
      if (inj.length) throw new Error(`possible prompt injection (${inj.map((h) => h.reason).join('; ')})`);
      const files = t.files.map((f) => { const s = normalizeTarget(f); if (!s) throw new Error(`unsafe path "${f}"`); return s; });
      for (const f of files) {
        if (!leads.some((l) => leadOwns(l, f, leads))) throw new Error(`"${f}" is not inside any lead's scope`);
        if (matchesAny(f, charter.forbiddenPaths)) throw new Error(`"${f}" is forbidden by the charter`);
        if (charter.allowedPaths.length && !withinAll(f, charter.allowedPaths)) throw new Error(`"${f}" is outside the charter's allowed paths`);
      }
      const prio = t.priority !== undefined && t.priority !== null && t.priority !== '' && Number.isFinite(Number(t.priority)) ? Number(t.priority) : i + 1;
      added.push({ id: `AUTO-${stamp}-${i + 1}`, title: String(t.title).slice(0, 200), goal: t.goal || t.title, priority: prio, status: 'READY', source: 'orchestrator', createdAt: new Date().toISOString(),
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
    const diag = r.lastVerify && !r.lastVerify.passed
      ? (r.lastVerify.diagnosis?.category
        ? `  [${r.lastVerify.diagnosis.category}${r.lastVerify.diagnosis.repeat ? ' REPEAT' : ''}]`
        : r.lastVerify.patchSafety?.blocking?.length ? '  [PATCH_SAFETY]' : '')
      : '';
    const job = r.pendingJobId ? `  [headless: ${r.pendingJobId}]` : '';
    const awaiting = `${r.status === 'PASSED' && r.reviewRequired && !judgeApproved(r) ? '  [AWAITING JUDGE]' : ''}${r.status === 'PASSED' && visualPending(r) ? '  [AWAITING VISUAL REVIEW]' : ''}`;
    console.log(`${r.id}  ${r.status.padEnd(22)} ${r.title}${r.backlogId ? `  [${r.backlogId}]` : ''}${ed}${diag}${job}${awaiting}`);
  }
}

switch (cmd) {
  case 'brief': brief(); break;
  case 'assign': assign(); break;
  case 'verify': verify(); break;
  case 'judge': judge(); break;
  case 'visual': await visual(); break;
  case 'handoff': handoff(); break;
  case 'rollback': rollback(); break;
  case 'propose': propose(); break;
  case 'report': { const f = path.join(runDir(positional[0] || ''), 'report.md'); if (!fs.existsSync(f)) die(`No report for run ${positional[0] || '(none)'} yet (verify it first).`); console.log(fs.readFileSync(f, 'utf8')); const j = path.join(runDir(positional[0]), 'judge.md'); if (fs.existsSync(j)) console.log(fs.readFileSync(j, 'utf8')); break; }
  case 'status': status(); break;
  default: die(`Unknown command "${cmd}". Use: brief | assign | verify | judge | visual | handoff | rollback | propose | status | report`);
}
