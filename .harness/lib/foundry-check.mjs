/**
 * .harness/lib/foundry-check.mjs — tell the user when their installed Skill Foundry skills are outdated or were edited.
 *
 * It only REPORTS. Skill Foundry owns skill content; the harness owns what is shown at session start. Nothing is ever
 * updated here, and the AI is told not to run `update` or `add` itself (the deny rules forbid it as well).
 *
 * Rules (all of them keep a session from ever being blocked or delayed):
 *  - only when `.claude/skills/<name>/.foundry.json` exists (a project that uses Skill Foundry);
 *  - HARNESS_OFFLINE=1 skips the check entirely;
 *  - a session start only READS the cache. `check --json` through npx takes 2-7 seconds (measured), so when the cache is
 *    missing or old a detached background process refreshes it (up to 60 s) and the answer shows at the next session;
 *    HARNESS_FOUNDRY_CMD=<script.mjs> runs a local Skill Foundry CLI instead of npx (offline tests, forks);
 *  - exit code 0 or 2 with valid JSON is a normal answer (2 = something is outdated or edited); any failure (no npx, no
 *    network, timeout, any other exit code, invalid JSON) says nothing;
 *  - the answer is cached in .harness/foundry-check.json (git-ignored): 24 hours when it worked, 1 hour when it failed.
 *    The cache is dropped as soon as the installed skills change (an `update` or a local edit), so the notice never lingers
 *    after the user acted on it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, winCommandLine } from './common.mjs';

export const FOUNDRY_CLI = 'npx github:sumtaimo/Skill-Foundry';
export const CACHE_OK_MS = 24 * 60 * 60 * 1000;
export const CACHE_FAIL_MS = 60 * 60 * 1000;
export const REFRESH_LOCK_MS = 2 * 60 * 1000;
const MAX_LINES = 3;

const cachePath = (root) => path.join(root, '.harness', 'foundry-check.json');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

/** One string that changes whenever an installed skill is added, updated, removed or edited; null when there is none. */
export function foundrySignature(root = ROOT) {
  const dir = path.join(root, '.claude', 'skills');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => fs.existsSync(path.join(dir, n, '.foundry.json'))).sort(); } catch { return null; }
  if (!names.length) return null;
  return JSON.stringify(names.map((n) => {
    const st = readJson(path.join(dir, n, '.foundry.json')) || {};
    let edited = 0; try { edited = Math.max(...fs.readdirSync(path.join(dir, n)).map((f) => { try { return fs.statSync(path.join(dir, n, f)).mtimeMs; } catch { return 0; } })); } catch { /* unreadable */ }
    return [n, st.version || '', st.hash || '', Math.round(edited)];
  }));
}

/** [{name, installed, latest, current, modified[]}] from `check --json` → at most 3 short lines (empty when all is fine). */
export function foundryLines(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const outdated = list.filter((e) => e && e.current === false).map((e) => e.name);
  const edited = list.filter((e) => e && Array.isArray(e.modified) && e.modified.length);
  const lines = [];
  if (outdated.length) lines.push(`Skill Foundry: ${outdated.length} skill(s) have an update (${outdated.join(', ')}). To update, ask the user to run: ${FOUNDRY_CLI} update`);
  const room = MAX_LINES - lines.length;
  const one = (e) => `Skill Foundry: skill ${e.name} was edited in .claude/skills (modified files: ${e.modified.slice(0, 4).join(', ')}${e.modified.length > 4 ? ', …' : ''}). Tell the user; do not edit skills.`;
  if (edited.length <= room) lines.push(...edited.map(one));
  else {
    lines.push(...edited.slice(0, room - 1).map(one));
    const rest = edited.slice(room - 1);
    lines.push(`Skill Foundry: ${rest.length} more skill(s) were edited in .claude/skills (${rest.map((e) => e.name).join(', ')}). Tell the user; do not edit skills.`);
  }
  return lines;
}

/**
 * Run `check --json` now and write the cache. Returns the entries, or null on any failure (also cached, for 1 hour).
 * `check --json` through npx takes 2-7 seconds (npx asks GitHub every time), so this is NEVER called from a session start
 * (see foundryCheck): only from the background refresher and from the doctor.
 */
export function refreshFoundryCache({ root = ROOT, env = process.env, now = Date.now(), timeoutMs = 60000 } = {}) {
  const sig = foundrySignature(root);
  if (!sig) return null;
  const local = env.HARNESS_FOUNDRY_CMD;
  const win = process.platform === 'win32';
  const limit = Number(env.HARNESS_FOUNDRY_TIMEOUT_MS) > 0 ? Number(env.HARNESS_FOUNDRY_TIMEOUT_MS) : timeoutMs;
  const npxArgs = ['--yes', 'github:sumtaimo/Skill-Foundry', 'check', '--json'];
  const opts = { cwd: root, encoding: 'utf8', timeout: limit, env, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 20 };
  const r = local
    ? spawnSync(process.execPath, [path.resolve(local), 'check', '--json'], opts)
    : win
      ? spawnSync(winCommandLine('npx.cmd', npxArgs), { ...opts, shell: true })
      : spawnSync('npx', npxArgs, opts);
  let entries = null;
  // `check --json` exits 0 when all is current and 2 when a skill is outdated or was edited; both print the JSON. Any other code is a failure.
  if (!r.error && (r.status === 0 || r.status === 2)) {
    try {
      const parsed = JSON.parse(r.stdout);
      if (Array.isArray(parsed) && parsed.every((e) => e && typeof e === 'object' && typeof e.name === 'string')) {
        entries = parsed.map((e) => ({ name: e.name, installed: e.installed, latest: e.latest, current: e.current, modified: Array.isArray(e.modified) ? e.modified.map(String) : [] }));
      }
    } catch { /* invalid JSON: treated as a failure */ }
  }
  try { fs.writeFileSync(cachePath(root), `${JSON.stringify(entries ? { at: now, sig, ok: true, entries } : { at: now, sig, ok: false })}\n`); } catch { /* read-only folder: no cache */ }
  return entries;
}

/**
 * The session-start check. NEVER waits for the network: it reads the cache and, when the cache is missing or old, starts
 * ONE detached background process (this file with --refresh) that refreshes it, so the answer shows at the next session.
 * An old cache of the SAME installed skills is still shown while it refreshes; after an update or edit (the signature
 * changed) the old answer is dropped at once. `sync: true` (doctor, tests via HARNESS_FOUNDRY_SYNC=1) runs the check inline.
 * Returns { lines: string[], source: 'none' | 'offline' | 'cache' | 'stale' | 'refreshing' | 'live' | 'failed' }. Never throws.
 */
export function foundryCheck({ root = ROOT, env = process.env, now = Date.now(), sync = false } = {}) {
  try {
    if (env.HARNESS_OFFLINE === '1') return { lines: [], source: 'offline' };
    const sig = foundrySignature(root);
    if (!sig) return { lines: [], source: 'none' };
    const cache = readJson(cachePath(root));
    const mine = cache && cache.sig === sig && Number.isFinite(cache.at) && now >= cache.at;
    if (mine && now - cache.at < (cache.ok ? CACHE_OK_MS : CACHE_FAIL_MS)) return { lines: cache.ok ? foundryLines(cache.entries) : [], source: 'cache' };
    if (sync || env.HARNESS_FOUNDRY_SYNC === '1') {
      const entries = refreshFoundryCache({ root, env, now, timeoutMs: 30000 });
      return entries ? { lines: foundryLines(entries), source: 'live' } : { lines: [], source: 'failed' };
    }
    const shown = mine && cache.ok ? foundryLines(cache.entries) : [];
    // one refresher at a time: a marker in the cache says one was started less than 2 minutes ago
    if (cache && cache.sig === sig && Number.isFinite(cache.refreshingAt) && now - cache.refreshingAt >= 0 && now - cache.refreshingAt < REFRESH_LOCK_MS) return { lines: shown, source: mine ? 'stale' : 'refreshing' };
    try { fs.writeFileSync(cachePath(root), `${JSON.stringify({ ...(mine ? cache : { sig, at: 0, ok: false }), sig, refreshingAt: now })}\n`); } catch { return { lines: shown, source: 'stale' }; }
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--refresh', root], { cwd: root, env, detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {}); child.unref();
    return { lines: shown, source: mine ? 'stale' : 'refreshing' };
  } catch { return { lines: [], source: 'failed' }; }
}

// background refresher: `node foundry-check.mjs --refresh <root>`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--refresh') {
  try { refreshFoundryCache({ root: path.resolve(process.argv[3] || ROOT), env: process.env }); } catch { /* nothing to report */ }
  process.exit(0);
}
