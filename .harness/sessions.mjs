#!/usr/bin/env node
/**
 * .harness/sessions.mjs — the session board: one main session (Session A) runs up to 4 child sessions, one task each,
 * follows them up, and cleans up only what is safely finished.
 *
 *   node .harness/sessions.mjs new "Login page" [--type feat|bug|task]   register a child task → ID, clear name, branch, brief
 *   node .harness/sessions.mjs start <ID>                                 (in the CHILD session) put this worktree on the task branch
 *   node .harness/sessions.mjs checkpoint <ID> [--message "…"]            commit uncommitted WIP (Harness-Wip) without marking done
 *   node .harness/sessions.mjs handoff [ID] [--checkpoint] [--prompt|--json]   inspect child task + print cross-engine resume prompt / --cwd cmd
 *   node .harness/sessions.mjs report <ID> done --summary "…"            (in the CHILD session) record "done" as a commit on the branch
 *   node .harness/sessions.mjs board [--json]                             every task: status, last activity, HIGH RISK flags
 *   node .harness/sessions.mjs merge <ID>                                 (Session A, after the owner said yes) check + merge into the base
 *   node .harness/sessions.mjs cleanup                                    remove worktrees and branches of tasks already merged
 *
 * Rules (the owner's): a task counts as finished only when its branch is MERGED into the base branch (the check passed);
 * only then are its worktree and local branch removed. An unfinished or abandoned task is never deleted: it is shown as
 * HIGH RISK until the owner decides. Merging is never automatic: Session A asks the owner first.
 * Status comes from git (branches, commits, "Harness-Session: <ID> done" and "Harness-Wip: <ID>"), so it works for local
 * worktrees and for cloud sessions that push their branch. The board itself is kept in the repository's shared git folder,
 * so every worktree of the project sees the same board.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { ROOT, loadConfig, readJsonSafe, atomicWriteJson, detectVerifyCmd, helpIfAsked, isSecretFile } from './lib/common.mjs';
import { usableEngines } from './lib/handoff.mjs';
import { removeLink } from './lib/integration.mjs';
helpIfAsked(import.meta.url);

const config = (() => { try { return loadConfig(); } catch { return {}; } })();
const S = { maxActive: 4, staleHours: 24, notStartedHours: 2, ...(config.sessions || {}) };
const args = process.argv.slice(2);
const cmd = args[0] || 'board';
const hasCheckpointFlag = args.includes('--checkpoint');
const VALUE_FLAGS = new Set(['--type', '--summary', '--message', '--msg']);
const flag = (n, ...aliases) => {
  const names = [n, ...aliases];
  for (let i = 0; i < args.length; i++) {
    for (const name of names) {
      if (args[i] === name) {
        const val = args[i + 1];
        return val !== undefined && !val.startsWith('--') ? val : '';
      }
      if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1);
    }
  }
  return undefined;
};
const positional = (() => {
  const out = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (VALUE_FLAGS.has(a)) {
      if (args[i + 1] !== undefined && !args[i + 1].startsWith('--')) i++;
      continue;
    }
    if (a.startsWith('--')) continue;
    out.push(a);
  }
  return out;
})();
const die = (m, code = 1) => { console.error(m); process.exit(code); };

const MUTATING = new Set(['new', 'start', 'report', 'checkpoint', 'merge', 'cleanup']);
if (process.env.HARNESS_WORKER === '1' && (MUTATING.has(cmd) || (cmd === 'handoff' && hasCheckpointFlag))) {
  die('Refusing to mutate the session board from inside a harness worker.', 2);
}

const git = (a, cwd = ROOT) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitOk = (a, cwd = ROOT) => { try { return git(a, cwd); } catch { return null; } };
if (gitOk(['rev-parse', '--git-dir']) === null) die('Not a git repository: the session board needs git (each child task is a branch).');

const commonDir = path.resolve(ROOT, git(['rev-parse', '--git-common-dir']));
const BOARD = path.join(commonDir, 'harness-sessions.json');
const load = () => { const b = readJsonSafe(BOARD, null); return b && Array.isArray(b.tasks) ? b : { version: 1, tasks: [] }; };
const save = (b) => atomicWriteJson(BOARD, b);
const worktrees = () => (gitOk(['worktree', 'list', '--porcelain']) || '')
  .replace(/\r\n/g, '\n')
  .split(/\n\n+/)
  .map((blk) => ({ path: (blk.match(/^worktree (.+)$/m) || [])[1], branch: (blk.match(/^branch refs\/heads\/(.+)$/m) || [])[1] }))
  .filter((w) => w.path);
const activeWorktreeFor = (t) => worktrees().find((w) => w.branch === t.branch && fs.existsSync(w.path)) || null;
const primary = () => worktrees()[0];
const baseBranch = () => S.baseBranch || primary()?.branch || gitOk(['symbolic-ref', '--short', 'HEAD']) || 'main';
const hasRemote = () => !!gitOk(['remote', 'get-url', 'origin']);
const slug = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task';
const hoursAgo = (iso) => (Date.now() - new Date(iso).getTime()) / 3600000;
const quoteShell = (p) => (/[\s"]/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p);

function porcelainEntries(cwd) {
  const r = spawnSync('git', ['status', '--porcelain', '-uall', '-z'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.status !== 0 || !r.stdout) return [];
  const entries = r.stdout.split('\0').filter(Boolean);
  const out = [];
  for (let i = 0; i < entries.length; i++) {
    const xy = entries[i].slice(0, 2);
    const file = entries[i].slice(3);
    if (xy.startsWith('R') || xy.startsWith('C')) i++;
    if (file) out.push({ status: xy.trim() || 'M', file });
  }
  return out;
}

/** The branch as seen locally or on origin (cloud sessions push theirs): { ref, tip, time, log } or null. */
function branchInfo(t) {
  for (const ref of [`refs/heads/${t.branch}`, `refs/remotes/origin/${t.branch}`]) {
    const tip = gitOk(['rev-parse', '--verify', '-q', ref]);
    if (tip) return { ref, tip, time: gitOk(['log', '-1', '--format=%cI', ref]), log: gitOk(['log', '--format=%B', `${t.base || baseBranch()}..${ref}`]) || '' };
  }
  return null;
}

/** Commits on the task branch ahead of base, newest first. */
function branchCommits(t, info) {
  if (!info) return [];
  const base = t.base || baseBranch();
  const raw = gitOk(['log', '--format=%H%x00%s%x00%B%x1e', `${base}..${info.ref}`]) || '';
  if (!raw) return [];
  return raw.split('\x1e').map((rec) => rec.replace(/^\r?\n/, '')).filter(Boolean).map((rec) => {
    const [sha = '', subject = '', ...rest] = rec.split('\x00');
    return { sha: sha.trim(), subject: subject.trim(), body: rest.join('\x00') };
  });
}

/** Status of one task, from git. */
function statusOf(t) {
  if (t.cleanedAt) return { status: 'CLEANED', risk: false, note: `merged and cleaned ${t.cleanedAt.slice(0, 10)}` };
  if (t.mergedAt) return t.cleanupLeftover ? { status: 'MERGED', risk: true, note: `merged into ${t.base || baseBranch()}, but NOT cleaned: ${t.cleanupLeftover}` } : { status: 'MERGED', risk: false, note: `in ${t.base || baseBranch()}; ready for cleanup` };
  const b = branchInfo(t);
  if (!b) {
    const late = hoursAgo(t.createdAt) > S.notStartedHours;
    return { status: 'NOT STARTED', risk: late, note: late ? `HIGH RISK: no branch ${Math.round(hoursAgo(t.createdAt))}h after it was created (was the child session started?)` : 'waiting for the child session to start' };
  }
  const commits = branchCommits(t, b);
  const ahead = commits.length || Number(gitOk(['rev-list', '--count', `${t.base || baseBranch()}..${b.ref}`]) || 0);
  const wt = activeWorktreeFor(t);
  const dirty = wt ? porcelainEntries(wt.path) : [];
  const dirtyNote = dirty.length ? `; ${dirty.length} uncommitted file(s)` : '';
  const extra = { dirtyFiles: dirty.map((d) => d.file), worktree: wt?.path || null, ...(t.lastCheckpoint ? { lastCheckpoint: t.lastCheckpoint } : {}) };

  if (t.checkFailed && t.checkFailed.tip === b.tip) {
    return { status: 'CHECK FAILED', risk: true, note: `HIGH RISK: ${t.checkFailed.reason} when merging; send it back to the child session to fix, then it reports done again${dirtyNote}`, ...extra };
  }
  const doneLine = `Harness-Session: ${t.id} done`;
  const wipLine = `Harness-Wip: ${t.id}`;
  const hasLine = (c, needle) => c.body.split(/\r?\n/).some((l) => l.trim() === needle);
  const lastDoneIdx = commits.findIndex((c) => hasLine(c, doneLine));
  const lastWipIdx = commits.findIndex((c) => hasLine(c, wipLine));
  const lastDone = lastDoneIdx > -1 ? commits[lastDoneIdx] : null;
  const hasNewerWip = lastWipIdx > -1 && (lastDoneIdx === -1 || lastWipIdx < lastDoneIdx);

  if (!hasNewerWip && lastDone && (!t.checkFailed || lastDone.sha !== t.checkFailed.tip)) {
    return { status: 'DONE', risk: false, note: `reported done (${ahead} commit(s)): ask the owner, then: node .harness/sessions.mjs merge ${t.id}${dirtyNote}`, ...extra };
  }
  if (!hasNewerWip && t.checkFailed && lastDone && lastDone.sha === t.checkFailed.tip) {
    return { status: 'CHECK FAILED', risk: true, note: `HIGH RISK: ${t.checkFailed.reason} when merging; finish fixing and report done again${dirtyNote}`, ...extra };
  }

  const idle = b.time ? hoursAgo(b.time) : 0;
  if (idle > S.staleHours) {
    return { status: 'STALE', risk: true, note: `HIGH RISK: unfinished, no commit for ${Math.round(idle)}h (${ahead} commit(s) so far)${dirtyNote}. Never deleted automatically: continue it or decide to drop it.`, ...extra };
  }
  return { status: 'WORKING', risk: false, note: `${ahead} commit(s), last ${b.time ? `${Math.max(0, Math.round(idle * 60))} min ago` : 'unknown'}${dirtyNote}`, ...extra };
}

const isOpen = (t) => !t.cleanedAt && !t.mergedAt;
const find = (b, id) => b.tasks.find((t) => t.id.toLowerCase() === String(id || '').toLowerCase()) || die(`No task "${id}" on the board. See: node .harness/sessions.mjs board`);

function resolveTaskForHandoff(b, idArg) {
  if (idArg) return find(b, idArg);
  const open = b.tasks.filter(isOpen);
  if (!open.length) die('No open child tasks on the session board. See: node .harness/sessions.mjs board');
  const curBranch = gitOk(['symbolic-ref', '--short', 'HEAD'], process.cwd()) || gitOk(['symbolic-ref', '--short', 'HEAD'], ROOT);
  if (curBranch) {
    const match = open.find((t) => t.branch === curBranch);
    if (match) return match;
  }
  if (open.length === 1) return open[0];
  die(`${open.length} open child tasks on the board (${open.map((t) => t.id).join(', ')}). Specify a task ID: node .harness/sessions.mjs handoff <ID>`);
}

function createWipCheckpoint(b, t, wt, msg) {
  const cur = gitOk(['symbolic-ref', '--short', 'HEAD'], wt.path);
  if (cur !== t.branch) die(`Worktree ${wt.path} is on ${cur || '(detached)'}, expected ${t.branch}.`);
  const dirty = porcelainEntries(wt.path);
  if (!dirty.length) {
    const tip = gitOk(['rev-parse', '--verify', '-q', `refs/heads/${t.branch}`], wt.path) || null;
    return { committed: false, tip, files: [] };
  }
  const identity = gitOk(['config', 'user.email'], wt.path)
    ? []
    : ['-c', 'user.name=Agentic Harness', '-c', 'user.email=harness@localhost'];
  git(['add', '-A'], wt.path);
  // A WIP commit must never carry secrets: a cloud session pushes this branch, and --no-verify below skips any
  // secret-scanning hook. Files that look like secrets (and are not git-ignored) are un-staged and stay in the worktree.
  const heldBack = (gitOk(['diff', '--cached', '--name-only', '-z'], wt.path) || '').split('\0').filter((f) => f && isSecretFile(f));
  if (heldBack.length) {
    if (gitOk(['rev-parse', '--verify', '-q', 'HEAD'], wt.path)) git(['reset', '-q', 'HEAD', '--', ...heldBack], wt.path);
    else git(['rm', '-r', '--cached', '-q', '--ignore-unmatch', '--', ...heldBack], wt.path);
  }
  const staged = gitOk(['diff', '--cached', '--name-only'], wt.path);
  if (!staged) {
    const tip = gitOk(['rev-parse', '--verify', '-q', `refs/heads/${t.branch}`], wt.path) || null;
    return { committed: false, tip, files: [], heldBack };
  }
  git([...identity, 'commit', '--no-verify', '-q', '-m', `${t.id}: wip - ${msg}`, '-m', `Harness-Wip: ${t.id}`], wt.path);
  const tip = git(['rev-parse', 'HEAD'], wt.path);
  const files = dirty.map((d) => d.file).filter((f) => !heldBack.includes(f));
  t.lastCheckpoint = { at: new Date().toISOString(), tip, message: msg, files, ...(heldBack.length ? { heldBack } : {}) };
  save(b);
  return { committed: true, tip, files, heldBack };
}

function brief(t) {
  return [
    `You are the child session for task ${t.id} ("${t.title}") of this project's agentic harness.`,
    `1. First run: node .harness/sessions.mjs start ${t.id}   (puts this worktree on the task branch ${t.branch})`,
    `2. Do only this task. Keep every change on ${t.branch}; commit as you go. Run the project's tests before you finish.`,
    `3. When it is complete and the tests pass, run: node .harness/sessions.mjs report ${t.id} done --summary "<one line: what you did>"`,
    hasRemote() ? `4. Only in a cloud session (not on the owner's computer): push the branch so the main session can see it: git push -u origin ${t.branch}` : '4. (Local session: no push needed; the main session sees the branch directly.)',
    'Never merge into the base branch and never delete branches yourself: the main session does that after the owner says yes.',
  ].join('\n');
}

function inspectSessionHandoff(t, { checkpointResult = null } = {}) {
  const st = statusOf(t);
  const base = t.base || baseBranch();
  const info = branchInfo(t);
  const commits = branchCommits(t, info).map((c) => ({
    sha: c.sha.slice(0, 7),
    subject: c.subject,
    isWip: c.body.split(/\r?\n/).some((l) => l.trim() === `Harness-Wip: ${t.id}`),
    isDone: c.body.split(/\r?\n/).some((l) => l.trim() === `Harness-Session: ${t.id} done`)
  }));
  const diffStat = info ? (gitOk(['diff', '--stat', `${base}...${info.ref}`]) || '') : '';
  const changedFiles = info ? (gitOk(['diff', '--name-only', `${base}...${info.ref}`]) || '').split(/\r?\n/).filter(Boolean) : [];
  const wt = activeWorktreeFor(t);
  const uncommitted = wt ? porcelainEntries(wt.path) : [];
  const verifyDir = wt ? wt.path : ROOT;
  const check = (() => {
    try { return detectVerifyCmd(verifyDir, config); }
    catch { return { cmd: config.defaultVerifyCmd || '(none)', source: 'default', real: false }; }
  })();
  const readyHeadlessEngines = usableEngines(config);
  const suggestedEngine = readyHeadlessEngines[0] || null;
  const checkpointNeededForWorktrees = Boolean(wt && uncommitted.some((u) => !isSecretFile(u.file)) && config.useGitWorktrees);
  const engArg = suggestedEngine ? ` --engine ${suggestedEngine}` : '';
  const resumeCmd = (isOpen(t) && wt)
    ? `node .harness/dispatch.mjs --cwd ${quoteShell(wt.path)} --goal "Finish ${t.id} (${t.title}) on branch ${t.branch}"${engArg} --wait`
    : null;

  const promptLines = [
    `[HARNESS SESSION HANDOFF: ${t.id} | STATUS: ${st.status} | BRANCH: ${t.branch} (base ${base})]`,
    `Continue child task ${t.id}: "${t.title}".`,
    wt ? `Working folder (worktree): ${wt.path}` : `No local worktree found; check out branch "${t.branch}" (e.g. git fetch origin ${t.branch} && git checkout ${t.branch}).`,
    `Verify command: ${check.cmd}  [${check.source}]`,
    '',
    'Progress so far on the branch:',
    commits.length
      ? commits.slice(0, 12).map((c) => `- ${c.sha} ${c.subject}${c.isWip ? ' [WIP]' : c.isDone ? ' [DONE MARKER]' : ''}`).join('\n')
      : '- No commits ahead of base branch yet.',
    changedFiles.length ? `Committed files vs ${base} (${changedFiles.length}): ${changedFiles.slice(0, 15).join(', ')}${changedFiles.length > 15 ? ', …' : ''}` : `Committed files vs ${base}: none`,
    uncommitted.length
      ? `Uncommitted files in worktree (${uncommitted.length}): ${uncommitted.slice(0, 15).map((u) => `${u.status} ${u.file}`).join(', ')}${uncommitted.length > 15 ? ', …' : ''}`
      : 'Uncommitted files in worktree: clean',
    ...(t.lastCheckpoint ? [`Last WIP checkpoint: ${t.lastCheckpoint.tip ? t.lastCheckpoint.tip.slice(0, 7) : 'none'} (${t.lastCheckpoint.at}) — ${t.lastCheckpoint.message}`] : []),
    ...(t.checkFailed ? ['', `Last merge/check failure (${t.checkFailed.at}): ${t.checkFailed.reason}`] : []),
    '',
    'How to finish cleanly:',
    wt
      ? `1. Inspect the existing commits/changes in ${wt.path} on branch ${t.branch} and finish any remaining requirements.`
      : `1. Open a worktree on branch ${t.branch} (e.g. node .harness/sessions.mjs start ${t.id}) and inspect existing commits.`,
    `2. Run the check: ${check.cmd}`,
    `3. Commit your changes on ${t.branch}, then run: node .harness/sessions.mjs report ${t.id} done --summary "<one line: what you did>"`,
    hasRemote() ? `4. Only in a cloud session (not on the owner's computer): git push -u origin ${t.branch}` : '',
    `Never merge into ${base} or delete ${t.branch} yourself: Session A merges after verification and owner approval.`
  ].filter((x, i, a) => !(x === '' && a[i - 1] === ''));

  const prompt = promptLines.join('\n');
  const data = {
    task: t,
    status: st.status,
    risk: st.risk,
    note: st.note,
    base,
    worktree: wt?.path || null,
    branchRef: info?.ref || null,
    branchTip: info?.tip || null,
    ahead: commits.length,
    commits,
    changedFiles,
    diffStat,
    uncommitted,
    checkpointResult,
    lastCheckpoint: t.lastCheckpoint || null,
    lastCheckFailure: t.checkFailed || null,
    check,
    readyHeadlessEngines,
    suggestedEngine,
    checkpointNeededForWorktrees,
    resumeCmd,
    prompt
  };
  return data;
}

function formatSessionHandoffText(d) {
  const lines = [
    `SESSION HANDOFF — ${d.task.id} (${d.status})`,
    '',
    `Title:    ${d.task.title}`,
    `Branch:   ${d.task.branch}  (base: ${d.base}${d.branchTip ? `, tip: ${d.branchTip.slice(0, 7)}` : ''})`,
    `Worktree: ${d.worktree || 'none locally (remote/cloud or not started)'}`,
    `Status:   ${d.note}`,
    `Check:    ${d.check.cmd}  (${d.check.source})`,
    ...(d.checkpointResult?.committed
      ? [`Checkpoint: committed ${d.checkpointResult.files.length} WIP file(s) @ ${d.checkpointResult.tip.slice(0, 7)}`]
      : d.checkpointResult?.heldBack?.length
        ? ['Checkpoint: nothing safe to commit — only secret-looking file(s) changed']
        : []),
    ...(d.checkpointResult?.heldBack?.length
      ? [`Held back:  ${d.checkpointResult.heldBack.join(', ')} (looks like a secret, not committed, still in the worktree)`]
      : []),
    ...(d.lastCheckFailure ? [`Last fail: ${d.lastCheckFailure.reason} (${d.lastCheckFailure.at})`] : [])
  ];

  lines.push('', `Commits ahead of ${d.base} (${d.ahead}):`);
  if (d.commits.length) {
    for (const c of d.commits.slice(0, 10)) lines.push(`  • ${c.sha} ${c.subject}${c.isWip ? ' [WIP]' : c.isDone ? ' [DONE]' : ''}`);
    if (d.commits.length > 10) lines.push(`  … (${d.commits.length - 10} more commit(s))`);
  } else {
    lines.push('  • none yet');
  }

  if (d.diffStat) {
    lines.push('', 'Diff stat vs base:');
    for (const l of d.diffStat.split(/\r?\n/).slice(0, 12)) lines.push(`  ${l}`);
  }

  lines.push('', `Uncommitted WIP in worktree (${d.uncommitted.length}): ${d.uncommitted.length ? d.uncommitted.slice(0, 12).map((u) => `${u.status} ${u.file}`).join(', ') : 'clean'}`);
  if (d.checkpointNeededForWorktrees) {
    lines.push(`  ⚠ useGitWorktrees is true: run \`node .harness/sessions.mjs checkpoint ${d.task.id}\` first so detached worker worktrees see uncommitted WIP.`);
  }

  lines.push('', 'Headless engines ready on this machine: ' + (d.readyHeadlessEngines.length ? d.readyHeadlessEngines.join(', ') : 'none allowed yet (run: node .harness/engines.mjs)'));
  lines.push('', 'Ways to continue:');
  if (d.resumeCmd) {
    lines.push('  1. Run headless workers directly inside the child worktree:');
    lines.push(`       ${d.resumeCmd}`);
    if (d.readyHeadlessEngines.length > 1) {
      lines.push(`     (or auto-route across ready engines: node .harness/dispatch.mjs --cwd ${quoteShell(d.worktree)} --goal "Finish ${d.task.id} (${d.task.title}) on branch ${d.task.branch}" --wait)`);
    }
    lines.push(`     After it passes, commit/checkpoint and run: node .harness/sessions.mjs report ${d.task.id} done`);
  } else if (isOpen(d.task)) {
    lines.push(`  1. Start/open a worktree on ${d.task.branch}: node .harness/sessions.mjs start ${d.task.id}`);
  } else {
    lines.push(`  • Task ${d.task.id} is ${d.status} (already merged).`);
  }
  lines.push('  2. Or paste the prompt below into another editor session (Claude, Antigravity, Cursor, Codex).');
  if (d.worktree && d.uncommitted.length && isOpen(d.task)) {
    lines.push(`  3. Save uncommitted WIP before switching tools: node .harness/sessions.mjs checkpoint ${d.task.id}`);
  }

  lines.push('', '----- [HANDOFF PROMPT FOR NEXT SESSION] -----', d.prompt, '----- [END HANDOFF PROMPT] -----');
  return lines.join('\n');
}

/** Remove the worktree and local branch of tasks that are MERGED into the base. Never touches anything unmerged. */
function cleanup(b, only = null) {
  let n = 0;
  for (const t of b.tasks) {
    if ((only && t.id !== only) || t.cleanedAt || statusOf(t).status !== 'MERGED') continue;
    const base = t.base || baseBranch();
    const tip = gitOk(['rev-parse', '--verify', '-q', `refs/heads/${t.branch}`]);
    if (tip && gitOk(['merge-base', '--is-ancestor', tip, base]) === null) { console.log(`  kept ${t.id}: its branch has commits that are not in ${base}`); continue; }
    const notes = []; let leftover = false;
    for (const w of worktrees().slice(1).filter((x) => x.branch === t.branch)) {
      const r = spawnSync('git', ['worktree', 'remove', w.path], { cwd: ROOT, encoding: 'utf8' });
      if (r.status !== 0) leftover = true;
      notes.push(r.status === 0 ? `worktree removed (${w.path})` : `worktree NOT removed (${w.path}): ${(r.stderr || '').trim().split('\n')[0]}; it has changes or is in use, check it and remove it by hand`);
    }
    if (tip) {
      if (gitOk(['branch', '-D', t.branch]) /* safe: checked above that every commit of it is in the base */ !== null) notes.push(`branch ${t.branch} deleted`);
      else { leftover = true; notes.push(`branch ${t.branch} NOT deleted (still checked out, or not merged)`); }
    }
    // Something is left (uncommitted files in its worktree, a branch still in use): keep the task on the board as
    // HIGH RISK, never hide it as cleaned.
    if (leftover) { t.cleanupLeftover = notes.join('; '); console.log(`  NOT cleaned ${t.id} (HIGH RISK, work may not be in ${base}): ${notes.join('; ')}`); continue; }
    delete t.cleanupLeftover;
    if (hasRemote() && gitOk(['rev-parse', '--verify', '-q', `refs/remotes/origin/${t.branch}`])) notes.push(`remote branch kept; with the owner's OK: git push origin --delete ${t.branch}`);
    t.cleanedAt = new Date().toISOString(); n++;
    console.log(`  cleaned ${t.id}: ${notes.join('; ') || 'nothing left to remove'}`);
  }
  save(b);
  if (!only) console.log(n ? `Cleaned ${n} merged task(s).` : 'Nothing to clean: no merged task left over. Unfinished tasks are never removed.');
}

switch (cmd) {
  case 'new': {
    const type = String(flag('--type') || 'task').toLowerCase();
    const title = positional.join(' ').trim();
    if (!title) die('Usage: node .harness/sessions.mjs new "<what to build or fix>" [--type feat|bug|task]');
    if (!['feat', 'bug', 'task'].includes(type)) die('--type must be feat, bug or task');
    const b = load();
    const open = b.tasks.filter(isOpen);
    if (open.length >= S.maxActive) die(`LIMIT: ${open.length}/${S.maxActive} child sessions are still open (${open.map((t) => t.id).join(', ')}). Finish, merge or decide on one first (node .harness/sessions.mjs board).`, 3);
    const prefix = type.toUpperCase();
    const id = `${prefix}-${1 + b.tasks.filter((t) => t.id.startsWith(`${prefix}-`)).length}`;
    const t = { id, title, name: `${id} ${title}`, branch: `task/${id.toLowerCase()}-${slug(title)}`, base: baseBranch(), createdAt: new Date().toISOString() };
    b.tasks.push(t); save(b);
    console.log(`NEW TASK ${t.id}: ${t.title}\n  session name: ${t.name}\n  branch:       ${t.branch} (from ${t.base})\n  open now:     ${open.length + 1}/${S.maxActive}\n`);
    console.log(`Start a child session named "${t.name}" with this brief:\n----- brief -----\n${brief(t)}\n-----------------`);
    break;
  }
  case 'start': {
    const b = load(); const t = find(b, positional[0]);
    const here = gitOk(['rev-parse', '--show-toplevel'], process.cwd()) || ROOT;
    const cur = gitOk(['symbolic-ref', '--short', 'HEAD'], here);
    if (cur !== t.branch) {
      if (gitOk(['rev-parse', '--verify', '-q', `refs/heads/${t.branch}`], here)) git(['checkout', '-q', t.branch], here);
      else if (cur && cur !== t.base && cur !== primary()?.branch) git(['branch', '-m', t.branch], here); // this session's own branch becomes the task branch
      else git(['checkout', '-q', '-b', t.branch], here);
    }
    t.startedAt = t.startedAt || new Date().toISOString(); save(b);
    console.log(`Task ${t.id} started on branch ${t.branch}.`);
    break;
  }
  case 'checkpoint': {
    const idArg = positional[0];
    if (!idArg) die('Usage: node .harness/sessions.mjs checkpoint <ID> [--message "<note>"]');
    const b = load(); const t = find(b, idArg);
    if (!isOpen(t)) die(`${t.id} is already ${t.cleanedAt ? 'CLEANED' : 'MERGED'}; cannot create a WIP checkpoint.`);
    const wt = activeWorktreeFor(t);
    if (!wt) die(`No active local worktree found for ${t.id} (${t.branch}). Start or check out the branch in a worktree first.`);
    const msg = String(flag('--message', '--msg') || '').trim() || 'checkpoint';
    const cp = createWipCheckpoint(b, t, wt, msg);
    if (!cp.committed) {
      if (cp.heldBack?.length) {
        console.log(`CHECKPOINT ${t.id}: nothing safe to commit at ${wt.path}${cp.tip ? ` (tip ${cp.tip.slice(0, 7)})` : ''} — only secret-looking file(s) changed.`);
        console.log(`  HELD BACK (looks like a secret, not committed, still in the worktree): ${cp.heldBack.join(', ')}`);
      } else {
        console.log(`CHECKPOINT ${t.id}: worktree is already clean at ${wt.path}${cp.tip ? ` (tip ${cp.tip.slice(0, 7)})` : ''}.`);
      }
    } else {
      console.log(`CHECKPOINT ${t.id}: committed ${cp.files.length} WIP file(s) on ${t.branch} @ ${cp.tip.slice(0, 7)} in ${wt.path}`);
      if (cp.heldBack?.length) console.log(`  HELD BACK (looks like a secret, not committed, still in the worktree): ${cp.heldBack.join(', ')}`);
      if (hasRemote()) console.log(`  Only in a cloud session: git push -u origin ${t.branch}`);
    }
    break;
  }
  case 'handoff': {
    const b = load();
    const t = resolveTaskForHandoff(b, positional[0]);
    let cpResult = null;
    if (hasCheckpointFlag) {
      if (!isOpen(t)) die(`${t.id} is already ${t.cleanedAt ? 'CLEANED' : 'MERGED'}; cannot create a WIP checkpoint.`);
      const wt = activeWorktreeFor(t);
      if (!wt) die(`No active local worktree found for ${t.id} (${t.branch}); cannot --checkpoint.`);
      const msg = String(flag('--message', '--msg') || '').trim() || 'handoff checkpoint';
      cpResult = createWipCheckpoint(b, t, wt, msg);
    }
    const data = inspectSessionHandoff(t, { checkpointResult: cpResult });
    if (args.includes('--json')) { console.log(JSON.stringify(data, null, 2)); break; }
    if (args.includes('--prompt')) { console.log(data.prompt); break; }
    console.log(formatSessionHandoffText(data));
    break;
  }
  case 'report': {
    const b = load(); const t = find(b, positional[0]);
    if (positional[1] !== 'done') die('Usage: node .harness/sessions.mjs report <ID> done --summary "<what you did>"');
    const here = gitOk(['rev-parse', '--show-toplevel'], process.cwd()) || ROOT;
    const cur = gitOk(['symbolic-ref', '--short', 'HEAD'], here);
    if (cur !== t.branch) die(`Run this in the child session on ${t.branch} (this folder is on ${cur}).`);
    if (git(['status', '--porcelain'], here)) die('Commit your work first: "done" marks the tip of the branch.');
    const summary = String(flag('--summary') || '').trim() || 'done';
    const idArgs = gitOk(['config', 'user.email'], here) ? [] : ['-c', 'user.name=Agentic Harness', '-c', 'user.email=harness@localhost'];
    git([...idArgs, 'commit', '--allow-empty', '-q', '-m', `${t.id}: done, ${summary}`, '-m', `Harness-Session: ${t.id} done`], here);
    t.doneAt = new Date().toISOString(); t.summary = summary; delete t.checkFailed; save(b);
    console.log(`Reported ${t.id} done.${hasRemote() ? ` Only in a cloud session: git push -u origin ${t.branch}` : ''}`);
    break;
  }
  case 'merge': {
    const b = load(); const t = find(b, positional[0]); const st = statusOf(t);
    if (st.status !== 'DONE') die(`${t.id} is ${st.status}, not DONE: only a task its child reported done can be merged. ${st.note}`);
    const base = t.base || baseBranch(); const p = primary(); const info = branchInfo(t);
    const failed = (reason, detail) => { t.checkFailed = { at: new Date().toISOString(), tip: info.tip, reason }; save(b); console.error(detail); process.exitCode = 1; };
    // Merge and check in a separate temporary worktree, so a conflict or a failing check never touches the base branch.
    const tmp = path.join(os.tmpdir(), `harness-merge-${t.id.toLowerCase()}-${Date.now()}`);
    const links = config.git?.linkIntoWorktrees || ['node_modules'];
    // Remember where the base is NOW: the merge is built on this commit, and the base only moves if it is still here
    // (compare-and-swap), so a commit that lands on the base while the check runs is never dropped.
    const baseTip = git(['rev-parse', `refs/heads/${base}`]);
    git(['worktree', 'add', '-q', '--detach', tmp, baseTip]);
    try {
      for (const d of links) { const src = path.join(p.path, d); if (fs.existsSync(src) && !fs.existsSync(path.join(tmp, d))) { try { fs.symlinkSync(src, path.join(tmp, d), 'junction'); } catch { /* the check may need its own install */ } } }
      const m = spawnSync('git', ['-c', 'user.name=harness', '-c', 'user.email=harness@local', 'merge', '--no-ff', '--no-edit', '-m', `merge ${t.id}: ${t.title}`, info.ref], { cwd: tmp, encoding: 'utf8' });
      if (m.status !== 0) { failed('a merge conflict', `MERGE CONFLICT: ${t.id} does not merge cleanly into ${base}. Nothing changed. Ask the child session to update its branch from ${base}.\n${(m.stdout + m.stderr).slice(0, 600)}`); }
      else {
        const v = detectVerifyCmd(tmp, config);
        if (!v.real && !process.argv.includes('--allow-no-check')) {
          // Not the child's fault: report it without marking the task CHECK FAILED, so it can merge once a check exists.
          process.exitCode = 1; console.error(`NO REAL CHECK: ${base} has no test or check command, so nothing would check ${t.id} before it lands. Nothing changed. Add a test script, or (owner's choice) run: node .harness/sessions.mjs merge ${t.id} --allow-no-check`);
          throw Object.assign(new Error('no real check'), { handled: true });
        }
        const chk = spawnSync(v.cmd, { cwd: tmp, shell: true, encoding: 'utf8', timeout: config.verifyTimeoutMs || 600000 });
        if (chk.status !== 0) failed(`the check (${v.cmd}) failed`, `CHECK FAILED after merging ${t.id} (${v.cmd}). Nothing changed in ${base}. Send this back to the child session:\n${(chk.stdout + chk.stderr).slice(-1500)}`);
        else {
          const sha = git(['rev-parse', 'HEAD'], tmp);
          if (p.branch === base && git(['status', '--porcelain'], p.path)) { console.error(`The main folder (${p.path}) has uncommitted changes on ${base}; commit them first. Nothing changed.`); process.exitCode = 1; }
          else {
            // The base branch may be checked out in ANOTHER worktree: moving the ref under it would make that folder's
            // next commit silently undo the merge. Fast-forward it there when it is clean, otherwise refuse.
            const other = p.branch === base ? null : worktrees().slice(1).find((w) => w.branch === base && fs.existsSync(w.path));
            if (other && git(['status', '--porcelain'], other.path)) {
              console.error(`${base} is checked out in ${other.path}, which has uncommitted changes; commit them there first. Nothing changed.`);
              process.exitCode = 1; throw Object.assign(new Error('dirty base worktree'), { handled: true });
            }
            const ff = (dir) => { if (gitOk(['merge', '--ff-only', '-q', sha], dir) === null) { console.error(`${base} moved while ${t.id} was being checked. Nothing changed. Run the merge again.`); process.exitCode = 1; throw Object.assign(new Error('base moved'), { handled: true }); } };
            if (p.branch === base) ff(p.path);
            else if (other) ff(other.path);
            else if (gitOk(['update-ref', `refs/heads/${base}`, sha, baseTip]) === null) {
              console.error(`${base} moved while ${t.id} was being checked (it is no longer at ${baseTip.slice(0, 7)}). Nothing changed. Run the merge again.`);
              process.exitCode = 1; throw Object.assign(new Error('base moved'), { handled: true });
            }
            t.mergedAt = new Date().toISOString(); delete t.checkFailed; save(b);
            console.log(`MERGED ${t.id} into ${base} (${sha.slice(0, 7)}); check passed: ${v.cmd}${v.real ? '' : ' (WARNING: not a real check)'}`);
          }
        }
      }
    } catch (e) { if (!e.handled) throw e; } finally {
      for (const d of links) removeLink(path.join(tmp, d)); // never let `worktree remove --force` follow a junction into the project
      gitOk(['worktree', 'remove', '--force', tmp]); gitOk(['worktree', 'prune']);
    }
    if (t.mergedAt) cleanup(load(), t.id);
    break;
  }
  case 'cleanup': cleanup(load()); break;
  case 'board': {
    const b = load();
    const rows = b.tasks.map((t) => ({ ...t, ...statusOf(t) }));
    if (args.includes('--json')) { console.log(JSON.stringify({ base: baseBranch(), maxActive: S.maxActive, tasks: rows }, null, 2)); break; }
    const open = rows.filter((r) => !['MERGED', 'CLEANED'].includes(r.status));
    const risky = rows.filter((r) => r.risk);
    console.log(`Session board: base ${baseBranch()} · open ${open.length}/${S.maxActive}${risky.length ? ` · ${risky.length} HIGH RISK` : ''}\n`);
    if (!rows.length) { console.log('No child tasks yet. Add one: node .harness/sessions.mjs new "<what to build or fix>" --type feat'); break; }
    for (const r of rows.filter((x) => x.status !== 'CLEANED')) console.log(`  ${r.risk ? '!!' : '  '} ${r.id.padEnd(8)} ${r.status.padEnd(12)} ${r.title.slice(0, 40).padEnd(40)} ${r.note}`);
    const cleaned = rows.filter((r) => r.status === 'CLEANED').length;
    if (cleaned) console.log(`\n  (${cleaned} finished task(s) merged and cleaned)`);
    break;
  }
  default: die('Usage: node .harness/sessions.mjs new | start | checkpoint | handoff | report | board | merge | cleanup   (--help for details)');
}
