/**
 * .harness/lib/handoff.mjs
 * Cross-editor handoff & headless resume helpers for editor-workflow ("visible") runs.
 * Zero dependencies — Node.js 18+ standard library only.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ROOT, HARNESS_DIR, atomicWriteJson, readJsonSafe, listProjectFiles, engineUsable, ROUTABLE_ENGINES, formatDiagnosis } from './common.mjs';
import { matchesAny, leadOwns } from './governance.mjs';

export const VISIBLE_DIR = path.join(HARNESS_DIR, 'visible');
export const VISIBLE_TERMINAL = new Set(['PASSED', 'HALTED_HITL_REQUIRED', 'ROLLED_BACK', 'ESCALATED']);
export const RESUMABLE_STATUSES = new Set(['BRIEFED', 'DELEGATED', 'FAILED']);
export const MAX_VISIBLE_FILES = 20000;

const EDITOR_LABELS = {
  'claude-code': 'Claude Code',
  claude: 'Claude Code',
  antigravity: 'Antigravity',
  agy: 'Antigravity',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  vscode: 'VS Code',
  copilot: 'Copilot'
};

export function normalizeEditor(raw) {
  if (raw === undefined || raw === null) return '';
  const s = String(raw).trim().toLowerCase();
  if (!s) return '';
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(s)) {
    throw new Error(`Invalid --editor "${raw}". Use letters, digits, "-" or "_" (for example: claude-code, antigravity, cursor).`);
  }
  return s;
}

export function editorDisplayName(editor = 'claude-code') {
  const k = String(editor || 'claude-code').trim().toLowerCase();
  return EDITOR_LABELS[k] || String(editor || 'claude-code');
}

/** Telemetry / dailyLimits key for an editor session, kept distinct from headless CLI engine names. */
export function editorUsageKey(editor = 'claude-code', config = null) {
  const k = String(editor || 'claude-code').trim().toLowerCase();
  if (!k || k === 'claude' || k === 'claude-code') return 'claude-code';
  if (k === 'agy' || k === 'antigravity') return 'antigravity-editor';
  if (k === 'codex' || config?.profiles?.[k]) return `${k}-editor`;
  return k;
}

export const visibleRunDir = (id) => path.join(VISIBLE_DIR, String(id || ''));
export const stripSlash = (f) => String(f).replace(/\/$/, '').replace(/\/\*\*$/, '');
const normRel = (f) => String(f || '').replace(/\\/g, '/').replace(/^\.\//, '');
export const insideTargets = (file, targets) => {
  const fn = normRel(file);
  return (targets || []).some((t) => {
    const raw = normRel(t);
    const n = stripSlash(raw);
    if (fn === n || fn.startsWith(`${n}/`)) return true;
    return /[*?]/.test(raw) && matchesAny(fn, [raw]);
  });
};

export function readVisibleRun(id) {
  if (!id) return null;
  const f = path.join(visibleRunDir(id), 'run.json');
  return fs.existsSync(f) ? readJsonSafe(f, null) : null;
}

export function writeVisibleRun(run) {
  const dir = visibleRunDir(run.id);
  fs.mkdirSync(dir, { recursive: true });
  atomicWriteJson(path.join(dir, 'run.json'), run);
}

/** True when `run` still has its pre-run baseline directory on disk for rollback. */
export function hasVisibleBaseline(run) {
  return Boolean(run?.baseline?.rollbackAvailable && run.baseline.dir && fs.existsSync(path.join(ROOT, run.baseline.dir)));
}

export function compareVisibleRuns(a, b) {
  const ta = String(a?.createdAt || '');
  const tb = String(b?.createdAt || '');
  if (ta && tb && ta !== tb) return ta.localeCompare(tb);
  return String(a?.id || '').localeCompare(String(b?.id || ''));
}

export function listVisibleRuns() {
  try {
    return fs.readdirSync(VISIBLE_DIR)
      .map((d) => readJsonSafe(path.join(VISIBLE_DIR, d, 'run.json'), null))
      .filter(Boolean)
      .sort(compareVisibleRuns);
  } catch {
    return [];
  }
}

export function findDefaultHandoffRun() {
  const runs = listVisibleRuns();
  if (!runs.length) return null;
  const open = runs.filter((r) => !VISIBLE_TERMINAL.has(r.status));
  if (open.length) return open[open.length - 1];
  const stopped = runs.filter((r) => r.status === 'HALTED_HITL_REQUIRED' || r.status === 'ESCALATED');
  if (stopped.length) return stopped[stopped.length - 1];
  return runs[runs.length - 1];
}

// ───────────────────────────── project snapshot & diff ─────────────────────────────

const sha = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

const WATCHED_RULES = ['.harness/charter.md', '.harness/team.json', '.harness/config.json', '.harness/roles', '.harness/skills'];
export function watchedRuleFiles() {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(ROOT, rel);
    let st; try { st = fs.statSync(abs); } catch { return; }
    if (st.isDirectory()) for (const e of fs.readdirSync(abs)) walk(`${rel}/${e}`); else out.push(rel);
  };
  WATCHED_RULES.forEach(walk);
  try { for (const e of fs.readdirSync(ROOT)) if (/^\.env/.test(e) && fs.statSync(path.join(ROOT, e)).isFile()) out.push(e); } catch { /* none */ }
  return out;
}

export function dirtyGitFiles() {
  const r = spawnSync('git', ['status', '--porcelain', '-uall', '-z'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.status !== 0 || !r.stdout) return [];
  const entries = r.stdout.split('\0').filter(Boolean);
  const out = [];
  for (let i = 0; i < entries.length; i++) {
    const status = entries[i].slice(0, 2);
    const file = entries[i].slice(3);
    if (status.startsWith('R') || status.startsWith('C')) i++; // next NUL entry is the previous path
    if (file && !file.startsWith('.harness/')) out.push(file);
  }
  return out;
}

export function captureSnapshot(scope = [], baseFiles = null, { maxFiles = MAX_VISIBLE_FILES } = {}) {
  let { files: projectFiles, total } = listProjectFiles(ROOT, maxFiles);
  let scopedMode = false;
  if (total > maxFiles && scope.length) {
    const scoped = listProjectFiles(ROOT, total).files.filter((f) => insideTargets(f, scope) || matchesAny(f, scope));
    const dirty = dirtyGitFiles();
    const merged = [...new Set([...scoped, ...(dirty.length <= maxFiles ? dirty : dirty.filter((f) => insideTargets(f, scope) || matchesAny(f, scope)))])];
    if (merged.length <= maxFiles) { projectFiles = merged; total = merged.length; scopedMode = true; }
    if (baseFiles) {
      for (const f of dirty) {
        if (!(f in baseFiles) && !fs.existsSync(path.join(ROOT, f)) && spawnSync('git', ['cat-file', '-e', `HEAD:${f}`], { cwd: ROOT, stdio: 'ignore' }).status === 0) {
          baseFiles[f] = 'HEAD';
        }
      }
    }
  }
  if (total > maxFiles) {
    throw Object.assign(
      new Error(`This project has ${total} files; the editor workflow can verify up to ${maxFiles} (pass --files to scope a smaller folder, or use node .harness/dispatch.mjs for larger runs).`),
      { code: 'TOO_MANY_FILES', total }
    );
  }
  const files = [...new Set([...projectFiles, ...watchedRuleFiles()])];
  const map = {}; let bytes = 0;
  for (const f of files) {
    const p = path.join(ROOT, f);
    try { const st = fs.statSync(p); if (!st.isFile()) continue; map[f] = sha(fs.readFileSync(p)); bytes += st.size; } catch { /* vanished */ }
  }
  return { map, bytes, scoped: scopedMode };
}

export function diffSnapshots(base = {}, cur = {}) {
  const added = []; const modified = []; const deleted = [];
  for (const f of Object.keys(cur)) { if (!(f in base)) added.push(f); else if (base[f] !== cur[f]) modified.push(f); }
  for (const f of Object.keys(base)) if (!(f in cur)) deleted.push(f);
  return { added: added.sort(), modified: modified.sort(), deleted: deleted.sort(), all: [...added, ...modified, ...deleted].sort() };
}

export function restoreVisibleFiles(run, files) {
  const dir = run.baseline?.dir ? path.join(ROOT, run.baseline.dir) : null;
  if (!run.baseline?.rollbackAvailable || !dir || !fs.existsSync(dir)) return { restored: [], failed: files };
  const restored = []; const failed = [];
  for (const f of files) {
    try {
      const dest = path.join(ROOT, f);
      if (/^\.env/.test(f)) { failed.push(f); continue; } // never copied, so it cannot be restored automatically
      if (f in run.baseline.files && run.baseline.files[f] !== 'HEAD') {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(dir, f), dest);
      } else if (run.baseline.scoped && spawnSync('git', ['cat-file', '-e', `HEAD:${f}`], { cwd: ROOT, stdio: 'ignore' }).status === 0) {
        const co = spawnSync('git', ['checkout', 'HEAD', '--', f], { cwd: ROOT, stdio: 'ignore' });
        if (co.status !== 0) { failed.push(f); continue; }
      } else {
        fs.rmSync(dest, { force: true });
      }
      restored.push(f);
    } catch { failed.push(f); }
  }
  return { restored, failed };
}

// ───────────────────────────── handoff inspection & formatting ─────────────────────────────

export function usableEngines(config) {
  const order = [...new Set([...(config.autoOrder || []), ...ROUTABLE_ENGINES])];
  return order.filter((k) => config.profiles?.[k] && engineUsable(config, k).ok);
}

function readGitDiffStat() {
  const r = spawnSync('git', ['diff', '--stat'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return r.status === 0 ? (r.stdout || '').trim() : '';
}

export function inspectVisibleRun(run, config) {
  const scopeGlobs = run.userAllowed?.length ? run.userAllowed : (run.charter?.allowedPaths || []);
  const baseFiles = run.baseline?.files ? { ...run.baseline.files } : {};
  let diff = { added: [], modified: [], deleted: [], all: [] };
  let snapshotNote = null;
  try {
    const cur = captureSnapshot(scopeGlobs, baseFiles).map;
    diff = diffSnapshots(baseFiles, cur);
  } catch (e) {
    snapshotNote = e.message;
  }

  const leads = run.leads || [];
  const assignments = run.assignments || [];
  const prefixOf = (f) => (diff.added.includes(f) ? '+ ' : diff.deleted.includes(f) ? '- ' : '~ ');

  const byLead = assignments.map((a) => {
    const lead = leads.find((l) => l.id === a.lead);
    const mine = diff.all.filter((f) => insideTargets(f, a.files) && (!lead || !leads.length || leadOwns(lead, f, leads)));
    const changed = mine.map((f) => `${prefixOf(f)}${f}`);
    const explicit = a.files.map(normRel).filter((t) => !t.endsWith('/') && !t.includes('*'));
    const missingFiles = explicit.filter((t) => !fs.existsSync(path.join(ROOT, t)));
    const untouchedFiles = explicit.filter((t) => fs.existsSync(path.join(ROOT, t)) && !mine.includes(t));
    return {
      lead: a.lead,
      role: lead?.role || null,
      goal: a.goal,
      files: a.files,
      changedFiles: mine,
      changed,
      missingFiles,
      untouchedFiles,
      status: mine.length > 0 ? 'edited' : 'pending'
    };
  });

  const outOfScope = [];
  const forbiddenEdits = [];
  for (const f of diff.all) {
    const forbidden = /^\.env/.test(f) || matchesAny(f, run.charter?.forbiddenPaths || []);
    const outsideUser = run.userAllowed?.length && !insideTargets(f, run.userAllowed);
    const outsideAutoCharter = run.autonomous && run.charter?.allowedPaths?.length && !matchesAny(f, run.charter.allowedPaths);
    if (assignments.length) {
      const owned = assignments.some((a) => {
        if (!insideTargets(f, a.files)) return false;
        const lead = leads.find((l) => l.id === a.lead);
        return !lead || !leads.length || leadOwns(lead, f, leads);
      });
      if (!owned || forbidden || outsideUser || outsideAutoCharter) outOfScope.push(f);
      if (forbidden) forbiddenEdits.push(f);
    } else if (forbidden || outsideUser || outsideAutoCharter) {
      outOfScope.push(f);
      if (forbidden) forbiddenEdits.push(f);
    }
  }

  const reportPath = path.join(visibleRunDir(run.id), 'report.md');
  const reportMd = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, 'utf8').trim() : '';
  const readyHeadlessEngines = usableEngines(config);
  const originEditor = run.editor || 'claude-code';
  // Prefer an alternate ready engine when the origin editor shares a provider quota (e.g. Claude Code -> antigravity, Antigravity -> claude).
  const originKey = editorUsageKey(originEditor, config);
  const avoidEngine = originKey === 'claude-code' ? 'claude' : originKey.endsWith('-editor') ? originKey.slice(0, -7) : null;
  const suggestedEngine = avoidEngine
    ? (readyHeadlessEngines.find((e) => e !== avoidEngine) || readyHeadlessEngines[0] || null)
    : (readyHeadlessEngines[0] || null);

  return {
    diff,
    snapshotNote,
    byLead,
    outOfScope,
    forbiddenEdits,
    reportMd,
    readyHeadlessEngines,
    suggestedEngine,
    resumable: RESUMABLE_STATUSES.has(run.status),
    gitDiffStat: readGitDiffStat()
  };
}

export function buildHandoffPrompt(run, info, config) {
  const maxCycles = config.maxCycles ?? 3;
  const lines = [
    `[HARNESS RUN HANDOFF: ${run.id} | STATUS: ${run.status} | ORIGIN: ${editorDisplayName(run.editor || 'claude-code')}]`,
    `Continue this existing Agentic Harness run in ${ROOT}. Do NOT create a new run (no \`visible.mjs brief --force\`).`,
    '',
    `Task: ${run.title}`,
    `Goal: ${run.goal}`,
    ...(run.backlogId ? [`Backlog ID: ${run.backlogId}`] : []),
    `Check command: ${run.check?.cmd || '(default)'}  [${run.check?.source || 'unknown'}]`,
    `Cycles used so far: ${run.cycles || 0}/${maxCycles}`,
  ];
  if (run.interfaceContract) lines.push('', 'Shared interface contract (follow exact names/signatures/formats):', run.interfaceContract);
  if (run.acceptanceCriteria?.length) lines.push('', 'Acceptance criteria:', ...run.acceptanceCriteria.map((c) => `- ${c}`));

  lines.push('', 'Progress already on disk since this run began:');
  if (info.byLead.length) {
    for (const s of info.byLead) {
      const bits = [];
      if (s.changed.length) bits.push(`already changed: ${s.changed.join(', ')}`);
      else bits.push('no edits recorded yet');
      if (s.missingFiles.length) bits.push(`still missing: ${s.missingFiles.join(', ')}`);
      lines.push(`- ${s.lead}${s.role ? ` (${s.role})` : ''} [${s.files.join(', ')}]: ${s.goal}`, `    ${bits.join(' | ')}`);
    }
  } else {
    lines.push('- No lead delegation saved yet (run stopped while in BRIEFED state).');
    if (run.userAllowed?.length) lines.push(`- Allowed files from user: ${run.userAllowed.join(', ')}`);
    if (run.leads?.length) lines.push('- Available leads:', ...run.leads.map((l) => `  • ${l.id} (${l.role}): ${l.scope.join(', ')}`));
  }

  if (info.diff.all.length && !info.byLead.length) {
    lines.push(`Changed files since brief: ${info.diff.all.slice(0, 12).join(', ')}${info.diff.all.length > 12 ? ', …' : ''}`);
  }
  if (info.outOfScope.length) {
    lines.push('', `WARNING — Out-of-scope edits detected on disk (revert or clean up before verify): ${info.outOfScope.join(', ')}`);
  }
  if (run.lastVerify && !run.lastVerify.passed) {
    lines.push('', `Last verification error (${run.lastVerify.at || 'recent'}):`);
    if (run.lastVerify.violations?.length) lines.push(...run.lastVerify.violations.map((v) => `- ${v}`));
    if (run.lastVerify.patchSafety?.blocking?.length) lines.push(...run.lastVerify.patchSafety.blocking.map((b) => `- PATCH_SAFETY: ${b}`));
    if (run.lastVerify.diagnosis?.headline) lines.push('Diagnosis:', ...formatDiagnosis(run.lastVerify.diagnosis).split('\n').map((l) => `  ${l}`));
    if (run.lastVerify.check) lines.push(String(run.lastVerify.check).slice(0, 2500));
  }

  lines.push('', 'How to finish this run:');
  if (run.status === 'BRIEFED') {
    lines.push(`1. Delegate to the leads with: node .harness/visible.mjs assign ${run.id} '<json>'  (add --editor <your-editor> if not Claude Code).`);
    lines.push(`2. Implement inside each lead's assigned files, then verify: node .harness/visible.mjs verify ${run.id}`);
  } else if (run.status === 'DELEGATED' || run.status === 'FAILED') {
    lines.push('1. Inspect the partial work already on disk and preserve valid changes; finish only what is missing or failing.');
    lines.push('2. Edit ONLY the assigned files listed above (do not touch .harness/, .env*, or unassigned paths).');
    lines.push(`3. When done, run: node .harness/visible.mjs verify ${run.id}`);
    lines.push(`   (Or hand off to terminal workers: node .harness/dispatch.mjs --resume-visible ${run.id}${info.suggestedEngine ? ` --engine ${info.suggestedEngine}` : ''} --wait)`);
  } else {
    lines.push(`- This run is in terminal status ${run.status}. Review status or start a new run when ready.`);
  }
  if (hasVisibleBaseline(run)) lines.push(`To discard all edits from this run and restore pre-run files: node .harness/visible.mjs rollback ${run.id}`);
  return lines.join('\n');
}

export function formatHandoffText(run, info, config) {
  const maxCycles = config.maxCycles ?? 3;
  const prompt = buildHandoffPrompt(run, info, config);
  const canRollback = hasVisibleBaseline(run);
  const resumeCmd = `node .harness/dispatch.mjs --resume-visible ${run.id}${info.suggestedEngine ? ` --engine ${info.suggestedEngine}` : ''} --wait`;
  const lines = [
    `HANDOFF — run ${run.id} (${run.status})`,
    '',
    `Task:    ${run.title}`,
    `Origin:  ${editorDisplayName(run.editor || 'claude-code')} editor session${run.backlogId ? `  [backlog ${run.backlogId}]` : ''}`,
    `Goal:    ${run.goal}`,
    `Check:   ${run.check?.cmd || '(default)'}  (${run.check?.source || 'unknown'})`,
    `Cycle:   ${run.cycles || 0}/${maxCycles}${run.pendingJobId ? `  (pending headless job: ${run.pendingJobId})` : ''}`,
    `Undo:    ${canRollback ? 'pre-run baseline snapshot available (rollback possible)' : 'no baseline snapshot on disk (auto-restored or inspect git status)'}`
  ];
  if (run.interfaceContract) lines.push('', 'Interface contract:', ...run.interfaceContract.split('\n').map((l) => `  ${l}`));

  lines.push('', 'Assignments & partial work on disk:');
  if (info.byLead.length) {
    for (const s of info.byLead) {
      lines.push(`  • ${s.lead}${s.role ? ` [${s.role}]` : ''} owns ${s.files.join(', ')}`);
      lines.push(`      goal: ${s.goal}`);
      lines.push(`      disk: ${s.changed.length ? s.changed.join(', ') : 'no changes yet'}${s.missingFiles.length ? `  | missing: ${s.missingFiles.join(', ')}` : ''}`);
    }
  } else {
    lines.push('  • No delegation yet (stopped in BRIEFED before assign).');
  }

  lines.push('', `Changed files vs baseline (${info.diff.all.length}): ${info.diff.all.length ? [...info.diff.added.map((f) => `+ ${f}`), ...info.diff.modified.map((f) => `~ ${f}`), ...info.diff.deleted.map((f) => `- ${f}`)].join(', ') : 'none'}`);
  if (info.outOfScope.length) lines.push(`  ⚠ Out-of-scope changes: ${info.outOfScope.join(', ')}`);
  if (info.snapshotNote) lines.push(`  ⚠ Snapshot note: ${info.snapshotNote}`);

  if (run.lastVerify && !run.lastVerify.passed) {
    lines.push('', 'Last verify failure:');
    if (run.lastVerify.violations?.length) for (const v of run.lastVerify.violations) lines.push(`  ✖ ${v}`);
    if (run.lastVerify.patchSafety?.blocking?.length) for (const b of run.lastVerify.patchSafety.blocking) lines.push(`  ✖ PATCH_SAFETY: ${b}`);
    if (run.lastVerify.diagnosis?.headline) for (const l of formatDiagnosis(run.lastVerify.diagnosis).split('\n')) lines.push(`  ${l}`);
    if (run.lastVerify.check) for (const l of String(run.lastVerify.check).split('\n').slice(0, 12)) lines.push(`  ${l}`);
  }

  lines.push('', 'Headless engines ready on this machine: ' + (info.readyHeadlessEngines.length ? info.readyHeadlessEngines.join(', ') : 'none allowed yet (run: node .harness/engines.mjs)'));
  lines.push('', 'Ways to continue:');
  if (info.resumable) {
    lines.push(`  1. Finish in terminal / headless controller:`);
    lines.push(`       ${resumeCmd}`);
    if (info.readyHeadlessEngines.length > 1) {
      lines.push(`     (or auto-route across ready engines: node .harness/dispatch.mjs --resume-visible ${run.id} --wait)`);
    }
    lines.push(`  2. Or paste the prompt below into another editor session (Antigravity, Cursor, new Claude session), then run:`);
    lines.push(`       node .harness/visible.mjs ${run.status === 'BRIEFED' ? 'assign' : 'verify'} ${run.id}`);
  } else {
    lines.push(`  • Run is ${run.status} (terminal) and cannot be resumed directly.`);
  }
  if (canRollback) {
    lines.push(`  3. Or undo everything to how it was before the run:`);
    lines.push(`       node .harness/visible.mjs rollback ${run.id}`);
  } else {
    lines.push(`  3. Undo snapshot unavailable (check git status / git checkout if needed).`);
  }

  lines.push('', '----- [HANDOFF PROMPT FOR NEXT SESSION] -----', prompt, '----- [END HANDOFF PROMPT] -----');
  return lines.join('\n');
}

/**
 * Keep .harness/visible/<id>/ consistent when a headless `--resume-visible` job finishes in daemon.mjs:
 *  - On COMMITTED (passed): mark visible run PASSED, remove its pending baseline directory, write report.md.
 *  - On HALTED / REJECTED (!passed): daemon already restored files back to pre-resume partial state;
 *    keep visible run open (FAILED / BRIEFED) and keep baseline intact so pre-handoff edits & full rollback are both preserved.
 */
export function syncVisibleRunAfterDaemon(task, plan, result) {
  if (!task?.visibleRunId) return;
  const run = readVisibleRun(task.visibleRunId);
  if (!run) return;
  const now = new Date().toISOString();
  const originEditor = editorDisplayName(run.editor || 'claude-code');
  delete run.pendingJobId;
  run.resumedJobId = task.id;
  run.resumedAt = run.resumedAt || result.startedAt || now;
  run.resumedCycles = result.cycle;

  if (result.passed) {
    run.status = 'PASSED';
    run.completedAt = now;
    run.lastVerify = {
      at: now,
      passed: true,
      violations: [],
      reverted: [],
      check: `PASS (Exit 0 via headless resume ${task.id}: ${plan?.verifyCmd || task.verifyCmd || run.check?.cmd})`,
      skipped: 0,
      needsVisualReview: false,
      resumedByEngine: plan?.engine || task.engine || '-'
    };
    delete run.cycleSnapshot;
    const lines = [
      `HARNESS REPORT — run ${run.id} — PASSED ✔ (completed via headless resume)`,
      '',
      `Task:    ${run.title}`,
      `Origin:  ${originEditor} editor session → resumed headlessly as ${task.id} (${plan?.engine || 'AUTO'})`,
      `Check:   ${plan?.verifyCmd || run.check?.cmd}  (${plan?.verifySource || run.check?.source || 'given'})`,
      '         → PASS (Exit 0)',
      `Cycles:  ${result.cycle} (headless resume)`,
      ...(result.gitResult?.mergedSha ? [`Git:     merged into ${result.gitResult.branch} @ ${result.gitResult.mergedSha.slice(0, 8)}`] : []),
      ...(plan?.subtasks?.length ? ['', 'Workers finished:', ...plan.subtasks.map((s) => `  • ${s.id}: ${(s.targetFiles || []).join(', ') || 'unscoped'}`)] : [])
    ];
    fs.mkdirSync(visibleRunDir(run.id), { recursive: true });
    fs.writeFileSync(path.join(visibleRunDir(run.id), 'report.md'), `${lines.join('\n')}\n`);
    writeVisibleRun(run);
    const baseDir = run.baseline?.dir && path.join(ROOT, run.baseline.dir);
    if (baseDir && fs.existsSync(baseDir)) fs.rmSync(baseDir, { recursive: true, force: true });
    return;
  }

  // Failed or rejected headless resume: preserve partial edits & pre-run baseline so human can retry OR rollback completely.
  run.status = (run.assignments && run.assignments.length > 0) ? 'FAILED' : 'BRIEFED';
  run.lastVerify = {
    at: now,
    passed: false,
    violations: [],
    reverted: [],
    resumedJobId: task.id,
    check: `HEADLESS RESUME ${result.phase || 'FAILED'}: ${String(result.reason || result.errors?.[result.errors.length - 1] || 'unknown error').slice(0, 2000)}`
  };
  const failLines = [
    `HARNESS REPORT — run ${run.id} — HEADLESS RESUME ${result.phase || 'FAILED'} ✖`,
    '',
    `Task:    ${run.title}`,
    `Origin:  ${originEditor} editor session → resume job ${task.id} stopped (${result.phase || 'FAILED'})`,
    `Reason:  ${String(result.reason || 'see .harness/failed/').slice(0, 800)}`,
    ...(result.rollback ? [`Restore: headless edits rolled back to pre-resume state (${result.rollback})`] : []),
    '',
    `Next: inspect .harness/failed/, fix the blocker, then retry: node .harness/dispatch.mjs --resume-visible ${run.id} --wait`,
    `      or undo all the way to pre-run files: node .harness/visible.mjs rollback ${run.id}`
  ];
  fs.mkdirSync(visibleRunDir(run.id), { recursive: true });
  fs.writeFileSync(path.join(visibleRunDir(run.id), 'report.md'), `${failLines.join('\n')}\n`);
  writeVisibleRun(run);
}
