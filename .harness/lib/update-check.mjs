/**
 * .harness/lib/update-check.mjs — tell the people of an installed project when a newer harness has been released.
 *
 * Projects installed from an old release never learned about fixes (some of them data-loss fixes), so this reads the
 * version of the `release` branch and compares it with .harness/MANIFEST.json. It only REPORTS: updating stays the
 * person's decision (`npx github:sumtaimo/Agentic-Harness#release .`), and the AI is told to ask first.
 *
 * Rules (a session must never be blocked or slowed down):
 *  - only in an installed project (it has .harness/MANIFEST.json); never in the template repository itself;
 *  - HARNESS_OFFLINE=1, HARNESS_UPDATE_CHECK=0 or config.json `"updateCheck": false` switch it off; workers never run it;
 *  - a session start only READS the cache. When it is missing or old, one detached background process fetches the
 *    release version (a single HTTPS GET of a public file, nothing about the user or project is sent) and the answer
 *    shows at the next session. doctor checks inline;
 *  - the answer is cached in .harness/update-check.json (git-ignored): 12 hours when it worked, 1 hour when it failed.
 *    Updating changes MANIFEST.json, so the cached "update available" disappears at once.
 */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT } from './common.mjs';

export const RELEASE_URL = 'https://raw.githubusercontent.com/sumtaimo/Agentic-Harness/release/package.json';
export const UPDATE_CMD = 'npx github:sumtaimo/Agentic-Harness#release .';
export const CACHE_OK_MS = 12 * 60 * 60 * 1000;
export const CACHE_FAIL_MS = 60 * 60 * 1000;
const REFRESH_LOCK_MS = 2 * 60 * 1000;

const cachePath = (root) => path.join(root, '.harness', 'update-check.json');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

/** The installed harness version (MANIFEST.json), or null outside an installed project. */
export function installedVersion(root = ROOT) {
  const m = readJson(path.join(root, '.harness', 'MANIFEST.json'));
  return m && typeof m.version === 'string' && /^\d+\.\d+\.\d+/.test(m.version) ? m.version : null;
}

/** -1 / 0 / 1 for semantic versions like 1.0.30 (pre-release parts are ignored). */
export function compareVersions(a, b) {
  const p = (v) => String(v).split(/[.+-]/).slice(0, 3).map((x) => Number(x) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/** Is the check off for this project / environment? */
export function updateCheckOff(root = ROOT, env = process.env) {
  if (env.HARNESS_OFFLINE === '1' || env.HARNESS_UPDATE_CHECK === '0' || env.HARNESS_WORKER === '1') return true;
  const cfg = readJson(path.join(root, '.harness', 'config.json'));
  return Boolean(cfg && cfg.updateCheck === false);
}

/** The lines to show for an installed and a latest version (empty when up to date). */
export function updateLines(installed, latest) {
  if (!installed || !latest || compareVersions(installed, latest) >= 0) return [];
  return [`Harness update available: this project has ${installed}, the latest release is ${latest} (it may contain safety and data-loss fixes; what changed: CHANGELOG.md in the template). Tell the user and ask before updating; to update: ${UPDATE_CMD} (keeps config, charter, team, backlog and memory).`];
}

/** Fetch the latest released version. HARNESS_UPDATE_URL may point to a local file (tests, mirrors). Resolves null on any failure. */
export function fetchLatest({ env = process.env, timeoutMs = 8000 } = {}) {
  const url = env.HARNESS_UPDATE_URL || RELEASE_URL;
  const pick = (text) => { try { const v = JSON.parse(text).version; return typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v) ? v : null; } catch { return null; } };
  if (!/^https:\/\//.test(url)) { try { return Promise.resolve(pick(fs.readFileSync(url.replace(/^file:\/\//, ''), 'utf8'))); } catch { return Promise.resolve(null); } }
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: timeoutMs, headers: { 'user-agent': 'agentic-harness-update-check' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
      let body = ''; res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
      res.on('end', () => resolve(pick(body)));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

/** Fetch now and write the cache. Returns the latest version or null. */
export async function refreshUpdateCache({ root = ROOT, env = process.env, now = Date.now() } = {}) {
  const latest = await fetchLatest({ env });
  try { fs.writeFileSync(cachePath(root), `${JSON.stringify(latest ? { at: now, ok: true, latest } : { at: now, ok: false })}\n`); } catch { /* read-only folder */ }
  return latest;
}

/**
 * The session-start / menu / dashboard check: reads the cache, never waits for the network. A missing or old cache
 * starts ONE detached refresher. `sync: true` (doctor) fetches inline. Returns { lines, installed, latest, source }.
 * Never throws.
 */
export async function updateCheck({ root = ROOT, env = process.env, now = Date.now(), sync = false } = {}) {
  try {
    const installed = installedVersion(root);
    if (!installed) return { lines: [], installed: null, latest: null, source: 'not-installed' };
    if (updateCheckOff(root, env)) return { lines: [], installed, latest: null, source: 'off' };
    const cache = readJson(cachePath(root));
    const fresh = cache && Number.isFinite(cache.at) && now >= cache.at && now - cache.at < (cache.ok ? CACHE_OK_MS : CACHE_FAIL_MS);
    if (fresh) return { lines: cache.ok ? updateLines(installed, cache.latest) : [], installed, latest: cache.latest || null, source: 'cache' };
    if (sync || env.HARNESS_UPDATE_SYNC === '1') {
      const latest = await refreshUpdateCache({ root, env, now });
      return { lines: updateLines(installed, latest), installed, latest, source: latest ? 'live' : 'failed' };
    }
    const shown = cache && cache.ok ? updateLines(installed, cache.latest) : []; // an old answer is better than none
    if (cache && Number.isFinite(cache.refreshingAt) && now - cache.refreshingAt >= 0 && now - cache.refreshingAt < REFRESH_LOCK_MS) return { lines: shown, installed, latest: cache.latest || null, source: 'refreshing' };
    try { fs.writeFileSync(cachePath(root), `${JSON.stringify({ ...(cache || { at: 0, ok: false }), refreshingAt: now })}\n`); } catch { return { lines: shown, installed, latest: null, source: 'stale' }; }
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--refresh', root], { cwd: root, env, detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {}); child.unref();
    return { lines: shown, installed, latest: cache?.latest || null, source: 'refreshing' };
  } catch { return { lines: [], installed: null, latest: null, source: 'failed' }; }
}

/** Cache only, synchronous (menu banner, dashboard): the lines from the last answer, or []. Never fetches. */
export function cachedUpdateLines(root = ROOT, env = process.env) {
  try {
    const installed = installedVersion(root);
    if (!installed || updateCheckOff(root, env)) return [];
    const cache = readJson(cachePath(root));
    return cache && cache.ok ? updateLines(installed, cache.latest) : [];
  } catch { return []; }
}

// background refresher: `node update-check.mjs --refresh <root>`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--refresh') {
  refreshUpdateCache({ root: path.resolve(process.argv[3] || ROOT), env: process.env }).catch(() => {}).finally(() => process.exit(0));
}
