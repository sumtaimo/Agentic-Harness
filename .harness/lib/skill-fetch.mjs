/**
 * .harness/lib/skill-fetch.mjs — fetch a Skill Foundry skill ON DEMAND, when a task needs it (owner's decision: a small
 * core set at install, then "find the skill that matches the task and call it, one by one, not all at the same time",
 * and the harness does it by itself: the user never types the Skill Foundry command).
 *
 * How (controller only, before a task's workers start; never inside a worker):
 *  - the registry is Skill Foundry's `list --json` (every ready skill with its roles and keywords, installed or not),
 *    cached in .harness/skill-registry.json (git-ignored): 24 hours when it worked, 1 hour when it failed;
 *  - a skill is fetched when it is NOT installed, its roles include the worker's role, and one of its keywords appears in
 *    the worker's task as a whole word (the same rule as installed skills, SKILL_KEYWORD_MATCH);
 *  - each worker fetches only what makes ITS OWN top SKILL_LIMIT_PER_WORKER (2) skills; a skill two workers need is
 *    fetched once; a safety cap of 2 per worker, at most MAX_PER_TASK, for the whole task; one `add <names> --quiet`;
 *  - it never blocks or fails a task: offline, no npx, a timeout or a bad answer just means the task runs without them;
 *  - off with HARNESS_OFFLINE=1, HARNESS_SKILL_FETCH=0 or config.json `"skillFetch": false`; workers never fetch.
 * HARNESS_FOUNDRY_CMD=<script.mjs> runs a local Skill Foundry CLI instead of npx (tests, forks), as in install.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, winCommandLine } from './common.mjs';
import { matchSkills } from './governance.mjs';

export const MAX_PER_TASK = 6; // safety cap for a whole task (2 per worker × up to 3 workers' worth); each worker's own limit is SKILL_LIMIT_PER_WORKER
export const ADD_TIMEOUT_MS = 90000; // npx github:… can take 10-60 s cold; the task never waits longer for a skill
export const REGISTRY_OK_MS = 24 * 60 * 60 * 1000;
export const REGISTRY_FAIL_MS = 60 * 60 * 1000;

const cacheFile = (root) => path.join(root, '.harness', 'skill-registry.json');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

/** Is on-demand fetching off here? */
export function skillFetchOff(root = ROOT, env = process.env) {
  if (env.HARNESS_WORKER === '1' || env.HARNESS_SKILL_FETCH === '0') return true;
  if (env.HARNESS_OFFLINE === '1' && !env.HARNESS_FOUNDRY_CMD) return true;
  const cfg = readJson(path.join(root, '.harness', 'config.json'));
  return Boolean(cfg && cfg.skillFetch === false);
}

/** Run the Skill Foundry CLI (local stand-in or npx). */
export function foundryRun(args, { root = ROOT, env = process.env, timeoutMs = 120000 } = {}) {
  const opts = { cwd: root, encoding: 'utf8', timeout: timeoutMs, env, maxBuffer: 4 << 20, windowsHide: true };
  if (env.HARNESS_FOUNDRY_CMD) return spawnSync(process.execPath, [path.resolve(env.HARNESS_FOUNDRY_CMD), ...args], opts);
  const npxArgs = ['--yes', 'github:sumtaimo/Skill-Foundry', ...args];
  return process.platform === 'win32'
    ? spawnSync(winCommandLine('npx.cmd', npxArgs), { ...opts, shell: true })
    : spawnSync('npx', npxArgs, opts);
}

/** Clean registry entries from `list --json`: [{ name, roles[], keywords[], description }]; null when unusable. */
export function parseRegistry(text) {
  let list; try { list = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const e of list) {
    if (!e || typeof e.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/i.test(e.name)) continue;
    out.push({
      name: e.name,
      roles: Array.isArray(e.roles) ? e.roles.map((r) => String(r).toUpperCase()) : [],
      keywords: Array.isArray(e.keywords) ? e.keywords.map(String).filter(Boolean) : [],
      description: typeof e.description === 'string' ? e.description.slice(0, 300) : ''
    });
  }
  return out;
}

/** The registry, from the cache or (when old) from `list --json`. Returns { skills: [] | null, source }. Never throws. */
export function loadRegistry({ root = ROOT, env = process.env, now = Date.now() } = {}) {
  try {
    const c = readJson(cacheFile(root));
    if (c && Number.isFinite(c.at) && now >= c.at && now - c.at < (c.ok ? REGISTRY_OK_MS : REGISTRY_FAIL_MS)) return { skills: c.ok ? c.skills : null, source: 'cache' };
    const r = foundryRun(['list', '--json'], { root, env, timeoutMs: ADD_TIMEOUT_MS });
    const skills = !r.error && r.status === 0 ? parseRegistry(r.stdout) : null;
    try { fs.writeFileSync(cacheFile(root), `${JSON.stringify(skills ? { at: now, ok: true, skills } : { at: now, ok: false })}\n`); } catch { /* read-only */ }
    return { skills, source: skills ? 'live' : 'failed' };
  } catch { return { skills: null, source: 'failed' }; }
}

/**
 * Which not-installed skills the workers need: [{ name, worker, role, hits }], at most `max`, most keyword hits first.
 * Only workers with a role and a task text; only skills whose roles include that role.
 */
export function pickSkills(subtasks, registry, installedSkills, max = taskCap(subtasks)) {
  // Rank installed AND not-installed skills together with the same rule the worker will get (matchSkills: explicit list,
  // then most keyword hits, then longest phrase, at most SKILL_LIMIT_PER_WORKER). Only a not-installed skill that makes
  // that worker's top list is fetched: a better installed skill is never pushed out, and nothing is fetched "just in case".
  const installed = installedSkills instanceof Set ? Object.fromEntries([...installedSkills].map((n) => [n, { name: n, roles: [], keywords: [] }])) : (installedSkills || {});
  const remote = Object.fromEntries((registry || []).filter((s) => !installed[s.name]).map((s) => [s.name, { name: s.name, roles: s.roles, keywords: s.keywords, autoApply: false, remote: true }]));
  const all = { ...installed, ...remote };
  const out = new Map();
  for (const sub of subtasks || []) {
    const role = String(sub.resolvedRole || sub.role || '').toUpperCase();
    if (!role || !sub.prompt) continue;
    const m = matchSkills(sub, role, all);
    for (const s of m.chosen) if (s.remote && !out.has(s.name)) out.set(s.name, { name: s.name, worker: sub.id, role, keyword: m.why.get(s.name) || null });
  }
  return [...out.values()].slice(0, max);
}

/**
 * Fetch what the task needs. Returns { fetched: [names], wanted: [picks], skipped: reason|null }. Never throws.
 * `installedNames`: the skills the harness already has (.harness/skills/*).
 */
/** Safety cap for a task: 2 per worker with a role, never more than MAX_PER_TASK. */
export const taskCap = (subtasks) => Math.min(MAX_PER_TASK, 2 * Math.max(1, (subtasks || []).filter((s) => (s.resolvedRole || s.role) && s.prompt).length));

export function fetchSkillsOnDemand(subtasks, installedNames, { root = ROOT, env = process.env, now = Date.now(), max = taskCap(subtasks) } = {}) {
  try {
    if (skillFetchOff(root, env)) return { fetched: [], wanted: [], skipped: 'off' };
    if (!(subtasks || []).some((s) => (s.resolvedRole || s.role) && s.prompt)) return { fetched: [], wanted: [], skipped: 'no worker with a role' };
    const reg = loadRegistry({ root, env, now });
    if (!reg.skills) return { fetched: [], wanted: [], skipped: 'registry unavailable (offline, or Skill Foundry without list --json)' };
    const wanted = pickSkills(subtasks, reg.skills, installedNames, max);
    if (!wanted.length) return { fetched: [], wanted: [], skipped: null };
    const names = wanted.map((w) => w.name);
    // One fetch at a time per project (a daemon task and an editor run could fetch together): an exclusive lock file,
    // waited for up to ADD_TIMEOUT_MS; a lock older than that is from a dead process and is taken over.
    const lock = path.join(root, '.harness', 'skill-fetch.lock');
    const until = Date.now() + ADD_TIMEOUT_MS;
    let held = false;
    while (!held && Date.now() < until) {
      try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); held = true; } catch {
        try { if (Date.now() - fs.statSync(lock).mtimeMs > ADD_TIMEOUT_MS) fs.rmSync(lock, { force: true }); } catch { /* gone */ }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      }
    }
    if (!held) return { fetched: [], wanted, skipped: 'another fetch was still running' };
    let r;
    try {
      const missing = names.filter((n) => !fs.existsSync(path.join(root, '.harness', 'skills', n, 'SKILL.md'))); // the other fetch may have added it
      r = missing.length ? foundryRun(['add', ...missing, '--quiet'], { root, env, timeoutMs: ADD_TIMEOUT_MS }) : { status: 0 };
    } finally { try { fs.rmSync(lock, { force: true }); } catch { /* ignore */ } }
    const fetched = names.filter((n) => fs.existsSync(path.join(root, '.harness', 'skills', n, 'SKILL.md')));
    const timedOut = r.error && /ETIMEDOUT|timed out/i.test(String(r.error.code || r.error.message));
    return { fetched, wanted, skipped: fetched.length ? null : (timedOut ? `Skill Foundry did not answer within ${ADD_TIMEOUT_MS / 1000} s` : `add failed (${r.error ? r.error.message : `exit ${r.status}`})`) };
  } catch (e) { return { fetched: [], wanted: [], skipped: `error: ${e.message}` }; }
}
