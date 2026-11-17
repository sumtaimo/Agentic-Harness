/**
 * .harness/lib/foundry-check.mjs — tell the user when their installed Skill Foundry skills are outdated or were edited.
 *
 * It only REPORTS. Skill Foundry owns skill content; the harness owns what is shown at session start. Nothing is ever
 * updated here, and the AI is told not to run `update` or `add` itself (the deny rules forbid it as well).
 *
 * Rules (all of them keep a session from ever being blocked):
 *  - only when `.claude/skills/<name>/.foundry.json` exists (a project that uses Skill Foundry);
 *  - HARNESS_OFFLINE=1 skips the check entirely;
 *  - runs `npx --yes github:sumtaimo/Skill-Foundry check --json` with a ~5 second timeout (HARNESS_FOUNDRY_TIMEOUT_MS overrides, for tests)
 *    (HARNESS_FOUNDRY_CMD=<script.mjs> runs a local Skill Foundry CLI instead: offline tests, forks);
 *  - exit code 0 or 2 with valid JSON is a normal answer (2 = something is outdated or edited); any failure (no npx, no network,
 *    timeout, any other exit code, invalid JSON) says nothing;
 *  - the answer is cached in .harness/foundry-check.json (git-ignored): 24 hours when it worked, 1 hour when it failed
 *    (so an offline machine does not wait 5 seconds at every session start). The cache is dropped as soon as the installed
 *    skills change (an `update` or a local edit), so the notice never lingers after the user acted on it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './common.mjs';

export const FOUNDRY_CLI = 'npx github:sumtaimo/Skill-Foundry';
export const CACHE_OK_MS = 24 * 60 * 60 * 1000;
export const CACHE_FAIL_MS = 60 * 60 * 1000;
export const CHECK_TIMEOUT_MS = 5000;
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
 * The check. Returns { lines: string[], source: 'none' | 'offline' | 'cache' | 'live' | 'failed' }.
 * `none`: no Skill Foundry skills in this project (no call). Never throws.
 */
export function foundryCheck({ root = ROOT, env = process.env, now = Date.now() } = {}) {
  try {
    if (env.HARNESS_OFFLINE === '1') return { lines: [], source: 'offline' };
    const sig = foundrySignature(root);
    if (!sig) return { lines: [], source: 'none' };
    const cache = readJson(cachePath(root));
    if (cache && cache.sig === sig && Number.isFinite(cache.at) && now >= cache.at && now - cache.at < (cache.ok ? CACHE_OK_MS : CACHE_FAIL_MS)) {
      return { lines: cache.ok ? foundryLines(cache.entries) : [], source: 'cache' };
    }
    const local = env.HARNESS_FOUNDRY_CMD;
    const win = process.platform === 'win32';
    const [cmd, args] = local
      ? [process.execPath, [path.resolve(local), 'check', '--json']]
      : [win ? 'npx.cmd' : 'npx', ['--yes', 'github:sumtaimo/Skill-Foundry', 'check', '--json']];
    const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', timeout: Number(env.HARNESS_FOUNDRY_TIMEOUT_MS) > 0 ? Number(env.HARNESS_FOUNDRY_TIMEOUT_MS) : CHECK_TIMEOUT_MS, env, shell: win && !local, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 20 });
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
    return entries ? { lines: foundryLines(entries), source: 'live' } : { lines: [], source: 'failed' };
  } catch { return { lines: [], source: 'failed' }; }
}
