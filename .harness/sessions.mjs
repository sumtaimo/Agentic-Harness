#!/usr/bin/env node
/**
 * .harness/sessions.mjs — the session board: one main session (Session A) runs up to 4 child sessions, one task each,
 * follows them up, and cleans up only what is safely finished.
 *
 *   node .harness/sessions.mjs new "Login page" [--type feat|bug|task]   register a child task → ID, clear name, branch, brief
 *   node .harness/sessions.mjs start <ID>                                 (in the CHILD session) put this worktree on the task branch
 *   node .harness/sessions.mjs report <ID> done --summary "…"            (in the CHILD session) record "done" as a commit on the branch
 *   node .harness/sessions.mjs board [--json]                             every task: status, last activity, HIGH RISK flags
 *   node .harness/sessions.mjs merge <ID>                                 (Session A, after the owner said yes) check + merge into the base
 *   node .harness/sessions.mjs cleanup                                    remove worktrees and branches of tasks already merged
 *
 * Rules (the owner's): a task counts as finished only when its branch is MERGED into the base branch (the check passed);
 * only then are its worktree and local branch removed. An unfinished or abandoned task is never deleted: it is shown as
 * HIGH RISK until the owner decides. Merging is never automatic: Session A asks the owner first.
 * Status comes from git (branches, commits, "Harness-Session: <ID> done" in a commit message), so it works for local
 * worktrees and for cloud sessions that push their branch. The board itself is kept in the repository's shared git folder,
 * so every worktree of the project sees the same board.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { ROOT, loadConfig, readJsonSafe, atomicWriteJson, detectVerifyCmd, helpIfAsked } from './lib/common.mjs';
helpIfAsked(import.meta.url);

const config = (() => { try { return loadConfig(); } catch { return {}; } })();
const S = { maxActive: 4, staleHours: 24, notStartedHours: 2, ...(config.sessions || {}) };
const args = process.argv.slice(2);
const cmd = args[0] || 'board';
const flag = (n) => { const i = args.indexOf(n); return i > -1 ? args[i + 1] : undefined; };
const die = (m, code = 1) => { console.error(m); process.exit(code); };

const git = (a, cwd = ROOT) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitOk = (a, cwd = ROOT) => { try { return git(a, cwd); } catch { return null; } };
if (gitOk(['rev-parse', '--git-dir']) === null) die('Not a git repository: the session board needs git (each child task is a branch).');

const commonDir = path.resolve(ROOT, git(['rev-parse', '--git-common-dir']));
const BOARD = path.join(commonDir, 'harness-sessions.json');
const load = () => { const b = readJsonSafe(BOARD, null); return b && Array.isArray(b.tasks) ? b : { version: 1, tasks: [] }; };
const save = (b) => atomicWriteJson(BOARD, b);
const worktrees = () => (gitOk(['worktree', 'list', '--porcelain']) || '').split(/\n\n+/).map((blk) => ({ path: (blk.match(/^worktree (.+)$/m) || [])[1], branch: (blk.match(/^branch refs\/heads\/(.+)$/m) || [])[1] })).filter((w) => w.path);
const primary = () => worktrees()[0];
const baseBranch = () => S.baseBranch || primary()?.branch || gitOk(['symbolic-ref', '--short', 'HEAD']) || 'main';
const hasRemote = () => !!gitOk(['remote', 'get-url', 'origin']);
const slug = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task';
const hoursAgo = (iso) => (Date.now() - new Date(iso).getTime()) / 3600000;

/** The branch as seen locally or on origin (cloud sessions push theirs): { ref, tip, time, log } or null. */
function branchInfo(t) {
  for (const ref of [`refs/heads/${t.branch}`, `refs/remotes/origin/${t.branch}`]) {
    const tip = gitOk(['rev-parse', '--verify', '-q', ref]);
    if (tip) return { ref, tip, time: gitOk(['log', '-1', '--format=%cI', ref]), log: gitOk(['log', '--format=%B', `${t.base || baseBranch()}..${ref}`]) || '' };
  }
  return null;
}

/** Status of one task, from git. */
function statusOf(t) {
  if (t.cleanedAt) return { status: 'CLEANED', risk: false, note: `merged and cleaned ${t.cleanedAt.slice(0, 10)}` };
  if (t.mergedAt) return { status: 'MERGED', risk: false, note: `in ${t.base || baseBranch()}; ready for cleanup` };
  const b = branchInfo(t);
  if (!b) {
    const late = hoursAgo(t.createdAt) > S.notStartedHours;
    return { status: 'NOT STARTED', risk: late, note: late ? `HIGH RISK: no branch ${Math.round(hoursAgo(t.createdAt))}h after it was created (was the child session started?)` : 'waiting for the child session to start' };
  }
  const ahead = Number(gitOk(['rev-list', '--count', `${t.base || baseBranch()}..${b.ref}`]) || 0);
  if (t.checkFailed && t.checkFailed.tip === b.tip) return { status: 'CHECK FAILED', risk: true, note: `HIGH RISK: ${t.checkFailed.reason} when merging; send it back to the child session to fix, then it reports done again` };
  const doneLine = `Harness-Session: ${t.id} done`;
  if (b.log.split(/\r?\n/).some((l) => l.trim() === doneLine)) return { status: 'DONE', risk: false, note: `reported done (${ahead} commit(s)): ask the owner, then: node .harness/sessions.mjs merge ${t.id}` };
  const idle = b.time ? hoursAgo(b.time) : 0;
  if (idle > S.staleHours) return { status: 'STALE', risk: true, note: `HIGH RISK: unfinished, no commit for ${Math.round(idle)}h (${ahead} commit(s) so far). Never deleted automatically: continue it or decide to drop it.` };
  return { status: 'WORKING', risk: false, note: `${ahead} commit(s), last ${b.time ? `${Math.max(0, Math.round(idle * 60))} min ago` : 'unknown'}` };
}

const isOpen = (t) => !t.cleanedAt && !t.mergedAt;
const find = (b, id) => b.tasks.find((t) => t.id.toLowerCase() === String(id || '').toLowerCase()) || die(`No task "${id}" on the board. See: node .harness/sessions.mjs board`);

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

/** Remove the worktree and local branch of tasks that are MERGED into the base. Never touches anything unmerged. */
function cleanup(b, only = null) {
  let n = 0;
  for (const t of b.tasks) {
    if ((only && t.id !== only) || t.cleanedAt || statusOf(t).status !== 'MERGED') continue;
    const base = t.base || baseBranch();
    const tip = gitOk(['rev-parse', '--verify', '-q', `refs/heads/${t.branch}`]);
    if (tip && gitOk(['merge-base', '--is-ancestor', tip, base]) === null) { console.log(`  kept ${t.id}: its branch has commits that are not in ${base}`); continue; }
    const notes = [];
    for (const w of worktrees().slice(1).filter((x) => x.branch === t.branch)) {
      const r = spawnSync('git', ['worktree', 'remove', w.path], { cwd: ROOT, encoding: 'utf8' });
      notes.push(r.status === 0 ? `worktree removed (${w.path})` : `worktree NOT removed (${w.path}): ${(r.stderr || '').trim().split('\n')[0]}; it has changes or is in use, check it and remove it by hand`);
    }
    if (tip && gitOk(['branch', '-d', t.branch]) !== null) notes.push(`branch ${t.branch} deleted`);
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
    const title = args.slice(1).filter((a, i, all) => !a.startsWith('--') && all[i] !== flag('--type')).join(' ').trim();
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
    const b = load(); const t = find(b, args[1]);
    const cur = gitOk(['symbolic-ref', '--short', 'HEAD']);
    if (cur !== t.branch) {
      if (gitOk(['rev-parse', '--verify', '-q', `refs/heads/${t.branch}`])) git(['checkout', '-q', t.branch]);
      else if (cur && cur !== t.base && cur !== primary()?.branch) git(['branch', '-m', t.branch]); // this session's own branch becomes the task branch
      else git(['checkout', '-q', '-b', t.branch]);
    }
    t.startedAt = t.startedAt || new Date().toISOString(); save(b);
    console.log(`Task ${t.id} started on branch ${t.branch}.`);
    break;
  }
  case 'report': {
    const b = load(); const t = find(b, args[1]);
    if (args[2] !== 'done') die('Usage: node .harness/sessions.mjs report <ID> done --summary "<what you did>"');
    const cur = gitOk(['symbolic-ref', '--short', 'HEAD']);
    if (cur !== t.branch) die(`Run this in the child session on ${t.branch} (this folder is on ${cur}).`);
    if (git(['status', '--porcelain'])) die('Commit your work first: "done" marks the tip of the branch.');
    const summary = String(flag('--summary') || '').trim() || 'done';
    git(['commit', '--allow-empty', '-q', '-m', `${t.id}: done, ${summary}`, '-m', `Harness-Session: ${t.id} done`]);
    t.doneAt = new Date().toISOString(); t.summary = summary; save(b);
    console.log(`Reported ${t.id} done.${hasRemote() ? ` Only in a cloud session: git push -u origin ${t.branch}` : ''}`);
    break;
  }
  case 'merge': {
    const b = load(); const t = find(b, args[1]); const st = statusOf(t);
    if (st.status !== 'DONE') die(`${t.id} is ${st.status}, not DONE: only a task its child reported done can be merged. ${st.note}`);
    const base = t.base || baseBranch(); const p = primary(); const info = branchInfo(t);
    const failed = (reason, detail) => { t.checkFailed = { at: new Date().toISOString(), tip: info.tip, reason }; save(b); console.error(detail); process.exitCode = 1; };
    // Merge and check in a separate temporary worktree, so a conflict or a failing check never touches the base branch.
    const tmp = path.join(os.tmpdir(), `harness-merge-${t.id.toLowerCase()}-${Date.now()}`);
    const links = config.git?.linkIntoWorktrees || ['node_modules'];
    git(['worktree', 'add', '-q', '--detach', tmp, base]);
    try {
      for (const d of links) { const src = path.join(p.path, d); if (fs.existsSync(src) && !fs.existsSync(path.join(tmp, d))) { try { fs.symlinkSync(src, path.join(tmp, d), 'junction'); } catch { /* the check may need its own install */ } } }
      const m = spawnSync('git', ['-c', 'user.name=harness', '-c', 'user.email=harness@local', 'merge', '--no-ff', '--no-edit', '-m', `merge ${t.id}: ${t.title}`, info.ref], { cwd: tmp, encoding: 'utf8' });
      if (m.status !== 0) { failed('a merge conflict', `MERGE CONFLICT: ${t.id} does not merge cleanly into ${base}. Nothing changed. Ask the child session to update its branch from ${base}.\n${(m.stdout + m.stderr).slice(0, 600)}`); }
      else {
        const v = detectVerifyCmd(tmp, config);
        const chk = spawnSync(v.cmd, { cwd: tmp, shell: true, encoding: 'utf8', timeout: config.verifyTimeoutMs || 600000 });
        if (chk.status !== 0) failed(`the check (${v.cmd}) failed`, `CHECK FAILED after merging ${t.id} (${v.cmd}). Nothing changed in ${base}. Send this back to the child session:\n${(chk.stdout + chk.stderr).slice(-1500)}`);
        else {
          const sha = git(['rev-parse', 'HEAD'], tmp);
          if (p.branch === base && git(['status', '--porcelain'], p.path)) { console.error(`The main folder (${p.path}) has uncommitted changes on ${base}; commit them first. Nothing changed.`); process.exitCode = 1; }
          else {
            if (p.branch === base) git(['merge', '--ff-only', '-q', sha], p.path);
            else git(['update-ref', `refs/heads/${base}`, sha, git(['rev-parse', base])]);
            t.mergedAt = new Date().toISOString(); delete t.checkFailed; save(b);
            console.log(`MERGED ${t.id} into ${base} (${sha.slice(0, 7)}); check passed: ${v.cmd}${v.real ? '' : ' (WARNING: not a real check)'}`);
          }
        }
      }
    } finally {
      for (const d of links) { try { fs.unlinkSync(path.join(tmp, d)); } catch { /* not linked */ } }
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
  default: die('Usage: node .harness/sessions.mjs new | start | report | board | merge | cleanup   (--help for details)');
}
