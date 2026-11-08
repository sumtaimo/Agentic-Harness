/**
 * .harness/lib/integration.mjs
 * Git integration-branch mode (e.g. "uat"): every worker gets its own branch + worktree cut from
 * the integration branch; their scoped commits are merged into a CANDIDATE in a separate
 * integration worktree; the verifier runs there; only if it passes does the integration branch
 * move forward. The user's own working folder and checked-out branch are never touched, and
 * protected branches (main, master, …) are never written.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function git(args, cwd) {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}
/** Raw git output, NOT trimmed — required for `status --porcelain`, whose first column can be a space (" M path"). */
async function gitRaw(args, cwd) {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}
const tryGit = (args, cwd) => git(args, cwd).catch(() => null);

/** Branch names git accepts: keep [A-Za-z0-9._/-], no "..", no leading "-" or trailing ".lock". */
export const safeRef = (s) => String(s).replace(/[^A-Za-z0-9._/-]+/g, '-').replace(/\.{2,}/g, '.').replace(/^[-/.]+|[/.]+$/g, '').replace(/\.lock$/, '-lock') || 'x';

export async function isRepoWithCommits(root) { return !!(await tryGit(['rev-parse', '--verify', 'HEAD'], root)); }
export async function branchSha(name, root) { return tryGit(['rev-parse', '--verify', `refs/heads/${name}`], root); }

/** Git needs an identity to commit; containers and fresh machines often have none. */
export async function identityArgs(root) {
  const email = await tryGit(['config', 'user.email'], root);
  return email ? [] : ['-c', 'user.name=Agentic Harness', '-c', 'user.email=harness@localhost'];
}

/** Create the integration branch from `base` if it does not exist. Returns true if created. */
export async function ensureBranch(name, base, root) {
  if (await branchSha(name, root)) return false;
  await git(['branch', name, base || 'HEAD'], root);
  return true;
}

/** Path of the worktree that has `branch` checked out (the user's folder counts), or null. */
export async function worktreeForBranch(branch, root) {
  const out = (await tryGit(['worktree', 'list', '--porcelain'], root)) || '';
  let current = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice(9);
    if (line === `branch refs/heads/${branch}`) return current;
  }
  return null;
}

/** Uncommitted changes to tracked files, ignoring .harness/ (the harness updates backlog.json itself). */
export async function isDirty(dir) { return !!(await git(['status', '--porcelain', '--untracked-files=no', '--', '.', ':(exclude).harness'], dir)); }

/** Symlink shared, git-ignored folders (node_modules…) from the project into a worktree so checks can run. */
export function linkShared(wtPath, names, root) {
  for (const n of names || []) {
    const src = path.join(root, n); const dest = path.join(wtPath, n);
    if (fs.existsSync(src) && !fs.existsSync(dest)) {
      try { fs.symlinkSync(src, dest, process.platform === 'win32' ? 'junction' : 'dir'); } catch { /* best effort */ }
    }
  }
}

/** Snapshot of protected branch tips, to prove afterwards that nothing wrote to them. */
export async function protectedShas(names, root) {
  const out = {};
  for (const n of names || []) out[n] = await branchSha(n, root);
  return out;
}

/** Worker worktree on its own branch, cut from `baseSha`. Re-used across retry cycles. */
export async function ensureWorkerWorktree({ wtPath, branch, baseSha, root, link }) {
  if (fs.existsSync(path.join(wtPath, '.git'))) return false;
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  await git(['worktree', 'add', '-B', branch, wtPath, baseSha], root);
  linkShared(wtPath, link, root);
  return true;
}

/**
 * Commit ONLY the worker's scoped files on its branch; discard everything else it changed.
 * inScope(file, targets) decides; .harness/ and linked folders are always ignored.
 */
export async function commitScoped({ wtPath, targets, inScope, message, root, ignore = [] }) {
  const raw = await gitRaw(['status', '--porcelain', '-uall', '-z'], wtPath);
  const entries = raw.split('\0').filter(Boolean);
  const kept = []; const discarded = [];
  for (let i = 0; i < entries.length; i++) {
    const status = entries[i].slice(0, 2); const file = entries[i].slice(3);
    if (status.startsWith('R')) i++;
    if (file.startsWith('.harness/') || ignore.some((n) => file === n || file.startsWith(`${n}/`))) continue;
    (inScope(file, targets) ? kept : discarded).push(file);
  }
  let sha = null;
  if (kept.length) {
    await git(['add', '-A', '--', ...kept], wtPath);
    await git([...(await identityArgs(root)), 'commit', '--no-verify', '-q', '-m', message], wtPath);
    sha = await git(['rev-parse', 'HEAD'], wtPath);
  }
  // Drop out-of-scope edits so they can never reach the integration branch.
  await git(['reset', '-q', '--hard', 'HEAD'], wtPath);
  await git(['clean', '-q', '-fd', ...ignore.flatMap((n) => ['-e', n])], wtPath);
  return { kept, discarded, sha };
}

/** (Re)build the candidate: integration worktree detached at the branch tip, then merge workers. */
export async function buildCandidate({ intPath, integrationBranch, workerBranches, messageFor, root, link }) {
  const tip = await branchSha(integrationBranch, root);
  if (fs.existsSync(path.join(intPath, '.git'))) {
    await git(['checkout', '-q', '--detach', '-f', tip], intPath);
    await git(['reset', '-q', '--hard', tip], intPath);
    await git(['clean', '-q', '-fd', ...(link || []).flatMap((n) => ['-e', n])], intPath);
  } else {
    fs.mkdirSync(path.dirname(intPath), { recursive: true });
    await git(['worktree', 'add', '-q', '--detach', intPath, tip], root);
  }
  linkShared(intPath, link, root);
  const id = await identityArgs(root);
  for (const b of workerBranches) {
    try {
      await git([...id, 'merge', '-q', '--no-ff', '--no-edit', '-m', messageFor(b), b.branch], intPath);
    } catch (e) {
      await tryGit(['merge', '--abort'], intPath);
      throw Object.assign(new Error(`Merging ${b.branch} into the ${integrationBranch} candidate failed: ${String(e.stderr || e.message).trim().slice(0, 500)}`), { fatal: true });
    }
  }
  return { tip, candidate: await git(['rev-parse', 'HEAD'], intPath) };
}

/**
 * Move the integration branch to the verified candidate. If the branch is checked out somewhere
 * (maybe the user's folder) it is fast-forwarded there — refused if that folder has uncommitted
 * changes. Otherwise the ref is updated atomically, only if it still points at `expectedOld`.
 */
export async function advanceBranch({ branch, newSha, expectedOld, root }) {
  const where = await worktreeForBranch(branch, root);
  if (where) {
    if (await isDirty(where)) throw Object.assign(new Error(`'${branch}' is checked out in ${where} with uncommitted changes; not moving it. Commit or stash there, then retry.`), { fatal: true });
    await git(['merge', '-q', '--ff-only', newSha], where);
    return `fast-forwarded in ${where}`;
  }
  await git(['update-ref', `refs/heads/${branch}`, newSha, expectedOld], root);
  return 'ref updated';
}

export async function removeWorktree(p, root) {
  if (fs.existsSync(p)) await tryGit(['worktree', 'remove', '--force', p], root);
}
export async function deleteBranch(name, root) { await tryGit(['branch', '-D', name], root); }
