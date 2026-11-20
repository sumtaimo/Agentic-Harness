/**
 * .harness/lib/common.mjs
 * Shared helpers: paths, config, engine detection + flag probing, verify-command detection,
 * project file listing, and the Markdown memory store.
 * Zero dependencies — Node.js 18+ standard library only.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Project root = the folder that contains .harness/ (works no matter where you run from).
export const ROOT = process.env.HARNESS_ROOT
  ? path.resolve(process.env.HARNESS_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const HARNESS_DIR = path.join(ROOT, '.harness');
export const DIRS = {
  inbox: path.join(HARNESS_DIR, 'inbox'),
  completed: path.join(HARNESS_DIR, 'completed'),
  failed: path.join(HARNESS_DIR, 'failed'),
  staging: path.join(HARNESS_DIR, 'staging'),
  releases: path.join(HARNESS_DIR, 'releases'),
  worktrees: path.join(HARNESS_DIR, 'worktrees'),
  memory: path.join(HARNESS_DIR, 'memory'),
  sessions: path.join(HARNESS_DIR, 'memory', 'sessions')
};
export const FILES = {
  config: path.join(HARNESS_DIR, 'config.json'),
  state: path.join(HARNESS_DIR, 'state.json'),
  log: path.join(HARNESS_DIR, 'telemetry.log'),
  pid: path.join(HARNESS_DIR, 'daemon.pid'),
  probe: path.join(HARNESS_DIR, 'engine-probe.json'),
  approvals: path.join(HARNESS_DIR, 'approvals.json'), // per person, git-ignored: which AI tools may be used, "don't ask again" answers
  live: path.join(HARNESS_DIR, 'live.log'),
  profile: path.join(HARNESS_DIR, 'memory', 'profile.md'), // shared project profile (committed)
  me: path.join(HARNESS_DIR, 'memory', 'me.md'), // per person, git-ignored: name, language, style, hats, personal skills
  lessons: path.join(HARNESS_DIR, 'memory', 'lessons.md'),
  autoLessons: path.join(HARNESS_DIR, 'memory', 'auto-lessons.md')
};

export function ensureDirs() {
  for (const dir of [HARNESS_DIR, ...Object.values(DIRS)]) fs.mkdirSync(dir, { recursive: true });
}

export function loadConfig() {
  return JSON.parse(fs.readFileSync(FILES.config, 'utf8'));
}

/** Write JSON atomically: write a temp file, then rename over the target. */
export function atomicWriteJson(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function readJsonSafe(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

const pathDirs = (envPath = process.env.PATH) => String(envPath || '').split(path.delimiter)
  .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
  .filter(Boolean);
const pathExts = (pathExt = process.env.PATHEXT) => (process.platform === 'win32'
  ? [...new Set((pathExt || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean).concat(['']))]
  : ['']);

/** Find an executable on PATH (cross-platform). Returns full path or null. */
export function which(binary, envPath = process.env.PATH, pathExt = process.env.PATHEXT) {
  if (!binary) return null;
  if (binary.includes('/') || binary.includes('\\')) return fs.existsSync(binary) ? binary : null;
  const exts = pathExts(pathExt);
  for (const dir of pathDirs(envPath)) {
    for (const ext of exts) {
      const full = path.join(dir, binary + ext);
      try { if (fs.statSync(full).isFile()) return full; } catch { /* keep looking */ }
    }
  }
  return null;
}

/**
 * Resolve an engine profile's executable: `binary` on PATH first, then each `binaryCandidates` entry
 * (for CLIs that ship inside an app and are not put on PATH, e.g. the Codex desktop app on Windows).
 * A candidate may use %VAR% / $VAR / ${VAR} and `*` inside path segments; with several matches the
 * highest-sorting (newest version folder) wins. A candidate 'appx:<PackageName>/<relative path>' is
 * resolved on Windows through Get-AppxPackage, because Node may not list C:\Program Files\WindowsApps (EPERM).
 * Returns a full path or null.
 */
const appxCache = new Map();
function appxLocation(name) {
  if (process.platform !== 'win32' || !/^[A-Za-z0-9._-]+$/.test(name)) return null;
  if (!appxCache.has(name)) {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-AppxPackage -Name '${name}' | Sort-Object Version -Descending | Select-Object -First 1).InstallLocation`], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    appxCache.set(name, (r.stdout || '').trim() || null);
  }
  return appxCache.get(name);
}

export function engineBinary(profile, env = process.env, locateAppx = appxLocation) {
  if (!profile) return null;
  const onPath = which(profile.binary, env.PATH, env.PATHEXT);
  if (onPath) return onPath;
  for (const raw of [].concat(profile.binaryCandidates || [])) {
    const expanded = String(raw)
      .replace(/%([A-Za-z0-9_]+)%/g, (m, v) => env[v] ?? '\0')
      .replace(/\$\{?([A-Za-z0-9_]+)\}?/g, (m, v) => env[v] ?? '\0');
    if (expanded.includes('\0')) continue; // a variable is not set on this machine
    const appx = /^appx:([^/\\]+)[/\\](.+)$/.exec(expanded);
    if (appx) {
      const loc = locateAppx(appx[1]);
      const f = loc && path.join(loc, appx[2]);
      try { if (f && fs.statSync(f).isFile()) return f; } catch { /* not there */ }
      continue;
    }
    const hit = globFile(expanded);
    if (hit) return hit;
  }
  return null;
}

function globFile(pattern) {
  const parts = pattern.split(/[\\/]+/);
  let bases = [parts[0] === '' ? path.sep : (/^[A-Za-z]:$/.test(parts[0]) ? parts[0] + path.sep : parts[0])];
  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i];
    if (!seg) continue;
    const next = [];
    for (const base of bases) {
      if (!seg.includes('*')) { next.push(path.join(base, seg)); continue; }
      const re = new RegExp(`^${seg.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
      let names = [];
      try { names = fs.readdirSync(base); } catch { /* unreadable */ }
      next.push(...names.filter((n) => re.test(n)).sort().reverse().map((n) => path.join(base, n)));
    }
    bases = next;
  }
  for (const f of bases) { try { if (fs.statSync(f).isFile()) return f; } catch { /* next */ } }
  return null;
}

/**
 * Find every distinct copy of `binary` across PATH directories in search order.
 * Resolves symlinks/junctions to deduplicate identical underlying binaries and picks at most one
 * winning executable per directory (matching `which()` so Windows paired `<bin>` + `<bin>.cmd` shims
 * in the same install folder are not falsely flagged as duplicates).
 */
export function findAllOnPath(binary, envPath = process.env.PATH, pathExt = process.env.PATHEXT) {
  if (!binary) return [];
  if (binary.includes('/') || binary.includes('\\')) {
    try { return fs.statSync(binary).isFile() ? [binary] : []; } catch { return []; }
  }
  const exts = pathExts(pathExt);
  const out = [];
  const seen = new Set();
  for (const dir of pathDirs(envPath)) {
    for (const ext of exts) {
      const full = path.join(dir, binary + ext);
      try {
        if (!fs.statSync(full).isFile()) continue;
        let real = path.resolve(full);
        try { real = fs.realpathSync.native(full); } catch { /* keep resolved path */ }
        const key = process.platform === 'win32' ? real.toLowerCase() : real;
        if (!seen.has(key)) { seen.add(key); out.push(full); }
        break; // One resolved binary per PATH directory (Windows CLIs often ship paired <bin> + <bin>.cmd shims).
      } catch { /* keep looking */ }
    }
  }
  return out;
}

/**
 * Quote one argument for a Windows shell command line (spawn with shell: true).
 * An empty string becomes "" so it is not dropped (e.g. a "-p" "" pair); newlines are collapsed to spaces
 * because cmd.exe truncates the command line at the first literal newline.
 */
export function winQuote(a) {
  const s = String(a).replace(/\r?\n/g, ' ');
  return s === '' || /[\s"&|<>^()]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * On Windows, only .cmd / .bat shims require cmd.exe (shell: true); native .exe binaries (such as agy.exe)
 * must be spawned directly with shell: false so multi-line "-p <prompt>" arguments and "--model" flags are
 * passed intact via CreateProcessW instead of being truncated by cmd.exe at the first newline.
 */
export function needsWinShell(binPath) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(String(binPath || ''));
}

// ───────────────────────────── AI use, in one short line ─────────────────────────────
// A person must always SEE when the harness spends their AI quota, without a long report: one line, no AI call.

/** Sum the AGENT_USAGE log lines since an ISO time → { <engine>: { calls, failed, tokens, usd } }. */
export function aiUsageSince(sinceIso) {
  const out = {};
  try {
    for (const line of fs.readFileSync(FILES.log, 'utf8').split('\n')) {
      if (!line.includes('"AGENT_USAGE"')) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.ts < sinceIso) continue;
      const r = (out[e.engine] ||= { calls: 0, failed: 0, tokens: 0, usd: 0 });
      r.calls++; if (!e.ok) r.failed++; r.tokens += Number(e.tokens) || 0; r.usd += Number(e.usd) || 0;
    }
  } catch { /* no log yet */ }
  return out;
}

/** "agy 5/80 calls · claude 2/60 calls, $0.40/$5" for today (UTC), with the daily caps; '' when nothing was used. */
export function usageTodayLine(config = loadConfig()) {
  const used = aiUsageSince(`${new Date().toISOString().slice(0, 10)}T00:00:00`);
  const name = (k) => (k === 'antigravity' ? 'agy' : k);
  return Object.entries(used).map(([k, r]) => {
    const cap = (config.dailyLimits || {})[k] || {};
    const calls = `${r.calls}${typeof cap.calls === 'number' ? `/${cap.calls}` : ''} call(s)`;
    const usd = r.usd || typeof cap.usd === 'number' ? `, $${r.usd.toFixed(2)}${typeof cap.usd === 'number' ? `/$${cap.usd}` : ''}` : '';
    return `${name(k)} ${calls}${usd}`;
  }).join(' · ');
}

/** "agy 2 call(s) (1 failed) · codex 1 call(s)" for one job, '' when none. */
export function usageLine(used) {
  return Object.entries(used).map(([k, r]) => `${k === 'antigravity' ? 'agy' : k} ${r.calls} call(s)${r.failed ? ` (${r.failed} failed)` : ''}${r.usd ? `, $${r.usd.toFixed(2)}` : ''}`).join(' · ');
}

/**
 * Check today's (UTC) AGENT_USAGE against `config.dailyLimits` and return items at or above `threshold` (default 80%).
 * Returns [{ engine, label, metric, used, limit, pct, remaining, over, fallback }] sorted descending by pct.
 */
export function quotaWarnings(config = loadConfig(), engines = null, threshold = 0.8) {
  const limits = config?.dailyLimits;
  if (!limits || typeof limits !== 'object') return [];
  const usedMap = aiUsageSince(`${new Date().toISOString().slice(0, 10)}T00:00:00`);
  const list = engines ? [...new Set(engines.map((e) => String(e).trim()).filter(Boolean))] : Object.keys(limits).filter((k) => k !== 'note');
  const warnings = [];
  for (const engine of list) {
    const cap = limits[engine];
    if (!cap || typeof cap !== 'object') continue;
    const row = usedMap[engine] || { calls: 0, tokens: 0, usd: 0 };
    const label = engine === 'antigravity' ? 'agy' : engine;
    const fallback = config?.quotaFallback?.[engine]?.engine || null;
    for (const metric of ['calls', 'tokens', 'usd']) {
      const limit = cap[metric];
      if (typeof limit !== 'number' || !(limit > 0)) continue;
      const used = metric === 'usd' ? Math.round((Number(row.usd) || 0) * 1e6) / 1e6 : (Number(row[metric]) || 0);
      const ratio = used / limit;
      if (ratio >= threshold) {
        warnings.push({
          engine,
          label,
          metric,
          used,
          limit,
          pct: Math.round(ratio * 100),
          remaining: Math.max(0, metric === 'usd' ? Number((limit - used).toFixed(2)) : limit - used),
          over: used >= limit,
          fallback
        });
      }
    }
  }
  return warnings.sort((a, b) => b.pct - a.pct || a.engine.localeCompare(b.engine) || a.metric.localeCompare(b.metric));
}

export function formatQuotaWarning(w, config = null) {
  const valStr = w.metric === 'usd'
    ? `$${Number(w.used).toFixed(2)}/$${w.limit}`
    : `${w.used}/${w.limit} ${w.metric}`;
  const fb = w.fallback || config?.quotaFallback?.[w.engine]?.engine || null;
  const fbLabel = fb ? (fb === 'antigravity' ? 'agy' : fb) : '';
  const fbHint = fbLabel ? ` (quotaFallback → ${fbLabel} configured)` : '';
  return `Quota warning: ${w.label} at ${w.pct}% of daily ${w.metric} limit (${valStr})${w.over ? ' — limit reached' : ''}${fbHint}`;
}

// ───────────────────────────── harness core integrity ─────────────────────────────
// The harness CODE (.harness/*.mjs, .harness/lib/*.mjs) belongs to the template. A project uses it but never edits it:
// the installer records a fingerprint of each core file in .harness/MANIFEST.json, and doctor warns when one changed.
// Your own settings (config.json, charter.md, team.json, roles/, skills/, backlog, memory) are yours to edit.

/** Relative paths ("/"-separated) of the harness core code files under a project root. */
export function coreFiles(root = ROOT) {
  const out = [];
  for (const dir of ['.harness', '.harness/lib']) {
    try { for (const f of fs.readdirSync(path.join(root, dir))) if (f.endsWith('.mjs')) out.push(`${dir}/${f}`); } catch { /* missing dir */ }
  }
  return out.sort();
}

/** { "<rel path>": sha256 } of the core files, line endings normalized (a CRLF checkout is not a change). */
export function hashCore(root = ROOT) {
  const out = {};
  for (const rel of coreFiles(root)) out[rel] = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n')).digest('hex');
  return out;
}

/** Compare the core files with .harness/MANIFEST.json → { manifest: object|null, changed: [], missing: [], added: [] }. */
export function checkCore(root = ROOT) {
  const manifest = readJsonSafe(path.join(root, '.harness', 'MANIFEST.json'), null);
  if (!manifest || typeof manifest.files !== 'object') return { manifest: null, changed: [], missing: [], added: [] };
  const now = hashCore(root);
  return {
    manifest,
    changed: Object.keys(manifest.files).filter((f) => now[f] && now[f] !== manifest.files[f]),
    missing: Object.keys(manifest.files).filter((f) => !now[f]),
    added: Object.keys(now).filter((f) => !(f in manifest.files)),
  };
}

/** `--help` / `-h` on any harness command: print the usage comment at the top of that file and exit 0. */
export function helpIfAsked(moduleUrl, argv = process.argv.slice(2)) {
  if (!argv.includes('--help') && !argv.includes('-h')) return;
  const src = fs.readFileSync(new URL(moduleUrl), 'utf8');
  console.log(src.split('*/')[0].replace(/^#!.*\n/, '').replace(/^\/\*\*?/, '').replace(/^ \* ?/gm, '').trim());
  process.exit(0);
}

/**
 * One quoted Windows command line (binary + args) for spawn(line, { shell: true }). Passing an args array together with
 * shell: true only concatenates them unquoted (Node DEP0190), which breaks paths with spaces; this quotes every part.
 */
export function winCommandLine(bin, args = []) {
  return [bin, ...args].map(winQuote).join(' ');
}

// ───────────────────────────── engine flag probe ─────────────────────────────

/** Flags a profile relies on: every arg starting with "-" (placeholders excluded). */
export function profileFlags(profile) {
  // The model flag is only relied on when the profile maps at least one tier to an alias.
  const modelFlags = Object.values(profile.models || {}).some(Boolean) ? (profile.modelArgs || []) : [];
  const all = [...(profile.args || []), ...(profile.output?.batch || []), ...(profile.output?.stream || []), ...modelFlags];
  return [...new Set(all.filter((a) => /^-[\w-]/.test(a) && a !== '--' && !a.includes('{')))];
}

/**
 * Run `<binary> [subcommand] --help` once and check every configured flag appears in the output.
 * Result is cached in .harness/engine-probe.json keyed by probe version + binary path + mtime + verified + flags.
 *   { installed, checked, compatible, missing[], binPath, error? }
 * checked=false means help could not be read; that is treated as "unknown", not "incompatible".
 */
const PROBE_VERSION = 2;

export function probeEngine(profile, { force = false } = {}) {
  const binPath = engineBinary(profile);
  if (!binPath) return { installed: false, checked: false, compatible: false, missing: [], binPath: null };
  const flags = profileFlags(profile);
  if (flags.length === 0) return { installed: true, checked: false, compatible: true, missing: [], binPath };
  let mtime = 0;
  try { mtime = fs.statSync(binPath).mtimeMs; } catch { /* ignore */ }
  // Bump PROBE_VERSION when the probe logic changes; verified is in the key because it decides how unreadable help is treated.
  const key = `v${PROBE_VERSION}|${binPath}|${mtime}|verified=${profile.verified === true}|${flags.join(' ')}`;
  const cache = readJsonSafe(FILES.probe, {});
  if (!force && cache[key]) return cache[key];

  const first = (profile.args || [])[0];
  const sub = first && !first.startsWith('-') && !first.includes('{') ? [first] : [];
  const r = needsWinShell(binPath)
    ? spawnSync(winCommandLine(binPath, [...sub, '--help']), { encoding: 'utf8', timeout: 15000, shell: true, env: { ...process.env, NO_COLOR: '1' } })
    : spawnSync(binPath, [...sub, '--help'], { encoding: 'utf8', timeout: 15000, env: { ...process.env, NO_COLOR: '1' } });
  const help = `${r.stdout || ''}\n${r.stderr || ''}`;
  let result;
  if (!help.trim()) {
    // Unreadable help proves nothing: trust it only for a profile marked verified (tested against the real CLI).
    result = { installed: true, checked: false, compatible: profile.verified === true, missing: [], binPath, error: r.error?.message || `'--help' printed nothing (exit ${r.status})` };
  } else {
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const missing = flags.filter((f) => !new RegExp(`(^|[\\s,\\[(|/])${esc(f)}(?=[\\s,=\\]).|<\\[]|$)`, 'm').test(help));
    result = { installed: true, checked: true, compatible: missing.length === 0, missing, binPath };
  }
  try { cache[key] = { ...result, probedAt: new Date().toISOString() }; atomicWriteJson(FILES.probe, cache); } catch { /* read-only is fine */ }
  return result;
}

// ───────────────────────────── approvals (per person) ─────────────────────────────
// .harness/approvals.json (git-ignored): { engines: { claude: true, antigravity: false }, alwaysAllow: ['team', ...] }

export function loadApprovals() {
  const a = readJsonSafe(FILES.approvals, {});
  return a && typeof a === 'object' && !Array.isArray(a) ? a : {};
}
export function saveApprovals(a) { atomicWriteJson(FILES.approvals, a); }

/** Did this person allow the harness to use this AI tool? true | false | undefined (not asked yet). */
export function engineConsent(k) {
  const e = loadApprovals().engines || {};
  return Object.prototype.hasOwnProperty.call(e, k) ? e[k] === true : undefined;
}
export function setEngineConsent(k, allowed) {
  const a = loadApprovals();
  a.engines = { ...(a.engines || {}), [k]: !!allowed };
  saveApprovals(a);
}

/**
 * Can this engine profile be used right now? { ok, why?, probe?, needsConsent? }
 * Installed + its configured flags pass the probe + the person allowed it once (a logged-in CLI is never used silently).
 */
export function engineUsable(config, k) {
  const p = config.profiles?.[k];
  if (!p) return { ok: false, why: 'unknown engine' };
  const probe = probeEngine(p);
  if (!probe.installed) return { ok: false, why: `'${p.binary}' is not installed` };
  if (!probe.compatible && !probe.checked) return { ok: false, why: `its flags could not be checked (${probe.error}) and the profile is not verified` };
  if (!probe.compatible) return { ok: false, why: `'${p.binary} --help' does not list ${probe.missing.join(', ')}` };
  const consent = engineConsent(k);
  if (consent === false) return { ok: false, probe, why: `you chose not to let the harness use '${k}' (change it: node .harness/engines.mjs allow ${k})` };
  if (consent !== true) return { ok: false, probe, needsConsent: true, why: `'${p.binary}' is installed but you have not allowed the harness to use it yet (it spends your own quota). Run: node .harness/engines.mjs` };
  return { ok: true, probe };
}

/** The real AI CLIs the team can be routed to (profile names in config.json). Supported: Claude Code, Antigravity (agy) and Codex. */
export const ROUTABLE_ENGINES = ['claude', 'antigravity', 'codex'];

/** Engines that were removed, with the reason shown when someone still asks for one. */
export const REMOVED_ENGINES = {
  orca: 'it could not be verified',
  gemini: "Google no longer lets the Gemini CLI run on personal 'Gemini Code Assist for individuals' accounts and points to Antigravity instead; use 'antigravity'",
};

/**
 * Which routable engines are usable on this machine? Returns { usable: [names], skipped: [{ name, why }] }.
 * HARNESS_ENGINES="claude,codex" overrides detection (for tests, or to route only to some engines).
 */
export function detectEngines(config, candidates = ROUTABLE_ENGINES) {
  const known = candidates.filter((k) => config.profiles?.[k]);
  if (process.env.HARNESS_ENGINES !== undefined) {
    const want = process.env.HARNESS_ENGINES.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    return { usable: known.filter((k) => want.includes(k)), skipped: known.filter((k) => !want.includes(k)).map((name) => ({ name, why: 'not listed in HARNESS_ENGINES' })) };
  }
  const usable = []; const skipped = [];
  for (const k of known) { const u = engineUsable(config, k); if (u.ok) usable.push(k); else skipped.push({ name: k, why: u.why }); }
  return { usable, skipped };
}

// ───────────────────────────── model tiers (token-aware) ─────────────────────────────

/** Model tiers, cheapest first. A profile maps them to the CLI's own model ALIASES (never pinned versions) in "models". */
export const MODEL_TIERS = ['fast', 'medium', 'high'];
const PLANNING_ROLES = new Set(['PO_ARCHITECT', 'BA_ANALYST']);
const DOC_FILE = /\.(md|mdx|markdown|txt|rst|adoc)$/i;

/**
 * Pick the cheapest tier that fits the job, so the heavy model is only used where it pays off. Pure.
 *   kind "plan" (orchestrator / lead / AI planner deciding who does what):
 *     orchestrator, PO_ARCHITECT, BA_ANALYST → high (multi-module architecture / research planning)
 *     QA lead → fast; other leads (e.g. lead-dev) → medium
 *   kind "work" (a worker editing files):
 *     PO_ARCHITECT → high
 *     QA_AUDITOR, or docs-only work: ≤ 2 files and a short prompt → fast, else medium
 *     a single-file small edit (1 file, prompt ≤ 600 chars) → fast
 *     anything else (standard / multi-file feature work) → medium
 *   retry after a failed check: one tier up per failed cycle (cycle 2 → +1, cycle 3 → +2), capped at high.
 * Returns { tier, reasons[] }.
 */
export function chooseModelTier({ kind = 'work', level = null, role = null, targetFiles = [], prompt = '', cycle = 1 } = {}) {
  const r = String(role || '').toUpperCase();
  const files = Array.isArray(targetFiles) ? targetFiles.length : 0;
  const size = String(prompt || '').length;
  let tier; let why;
  if (kind === 'plan') {
    // Only planning ACROSS modules needs the high tier; a lead splits its own slice (BA lead: its docs) on medium.
    if (level === 'orchestrator' || (PLANNING_ROLES.has(r) && level !== 'lead')) { tier = 'high'; why = `${level === 'orchestrator' ? 'orchestrator' : r} plans across modules`; }
    else if (r === 'QA_AUDITOR') { tier = 'fast'; why = 'QA lead only splits test work'; }
    else { tier = 'medium'; why = `${r || 'lead'} plans its own slice`; }
  } else if (r === 'PO_ARCHITECT') { tier = 'high'; why = 'architecture work'; }
  else if (r === 'QA_AUDITOR' || (files > 0 && targetFiles.every((f) => DOC_FILE.test(String(f))))) {
    const what = r === 'QA_AUDITOR' ? 'QA / test work' : 'docs-only work';
    if (files <= 2 && size <= 2000) { tier = 'fast'; why = `${what}, ${files} file(s), short prompt`; } else { tier = 'medium'; why = `${what}, ${files} file(s), ${size} chars`; }
  } else if (files <= 1 && size <= 600) { tier = 'fast'; why = 'single-file small edit'; }
  else { tier = 'medium'; why = `standard coding: ${files} file(s), ${size} chars`; }
  const reasons = [why];
  const bump = Math.max(0, (Number(cycle) || 1) - 1);
  if (bump) {
    const from = tier;
    tier = MODEL_TIERS[Math.min(MODEL_TIERS.length - 1, MODEL_TIERS.indexOf(tier) + bump)];
    if (tier !== from) reasons.push(`escalated ${from} → ${tier}: retry ${bump} after a failed check`);
  }
  return { tier, reasons };
}

/**
 * Turn a tier (or an explicit override) into the model for this profile.
 *   override: a tier name ("fast" | "medium" | "high") picks that tier; any other string is passed to the CLI as-is.
 *   No alias configured for the tier → model null: no --model flag, so the CLI uses its own latest default.
 * Returns { tier, model, source: "auto" | "override-tier" | "override" }.
 */
export function resolveModel(profile, { tier = 'medium', override = null } = {}) {
  if (override && MODEL_TIERS.includes(String(override).toLowerCase())) {
    const t = String(override).toLowerCase();
    return nearestModel(profile, t, 'override-tier');
  }
  if (override) return { tier, model: String(override), source: 'override' };
  return nearestModel(profile, tier, 'auto');
}

/**
 * Filter an explicit model override for `targetProfile`: tiers ("fast" | "medium" | "high") work on every engine,
 * while an engine-specific alias from a different `sourceEngine` is dropped unless it also exists in `targetProfile.models`.
 */
export function compatibleModelFor(targetProfile, model, sourceEngine = null) {
  if (!model) return null;
  const s = String(model).trim();
  if (!s) return null;
  if (MODEL_TIERS.includes(s.toLowerCase())) return s;
  const targetName = targetProfile?.name;
  if (!sourceEngine || sourceEngine === 'auto' || !targetName || sourceEngine === targetName) return s;
  const targetModels = Object.values(targetProfile?.models || {}).filter(Boolean);
  return targetModels.includes(s) ? s : null;
}

/**
 * Never fall back to the CLI's default when the engine has a model for ANOTHER tier: an empty tier uses the nearest
 * configured one (cheaper first for fast/medium, then the next one up; high steps down). Only an engine with no
 * models at all (e.g. codex today) gets model null = the CLI's own default (doctor warns about it).
 */
const NEAREST = { fast: ['fast', 'medium', 'high'], medium: ['medium', 'fast', 'high'], high: ['high', 'medium', 'fast'] };
function nearestModel(profile, tier, source) {
  for (const t of NEAREST[tier] || [tier]) {
    const m = profile?.models?.[t];
    if (m) return { tier, model: m, source: t === tier ? source : `${source}, nearest tier ${t}` };
  }
  return { tier, model: null, source };
}

/** True when the engine has no model name for any tier, so every call runs on the CLI's own default. */
export const usesCliDefault = (profile) => !MODEL_TIERS.some((t) => profile?.models?.[t]);

/** A typical job for each role, so the team view can say which model an agent gets (same rules as the controller). */
const TYPICAL_FILES = { BA_ANALYST: ['docs/spec.md'], QA_AUDITOR: ['test/feature.test.js'], DEV_ENGINEER: ['src/a.js', 'src/b.js'], UX_DESIGNER: ['src/app.css', 'src/theme.css'], PO_ARCHITECT: ['docs/plan.md'] };
/**
 * Which model a team member gets: for its own planning call (orchestrator / lead) and for its workers' typical job.
 * engineName null/auto → the first engine of autoOrder. A member "model" (alias, or a tier name) overrides both.
 * Returns { engine, plan: { tier, model }, work: { tier, model } }.
 */
export function memberModels(config, member) {
  const engine = member.engine && member.engine !== 'auto' ? member.engine : (config.autoOrder || Object.keys(config.profiles || {}))[0];
  const profile = config.profiles?.[engine];
  const role = String(member.role || '').toUpperCase();
  const pick = (t) => (member.model ? resolveModel(profile, { tier: t.tier, override: member.model }) : resolveModel(profile, { tier: t.tier }));
  return {
    engine,
    plan: pick(chooseModelTier({ kind: 'plan', level: member.level, role })),
    work: pick(chooseModelTier({ kind: 'work', role, targetFiles: TYPICAL_FILES[role] || ['src/a.js', 'src/b.js'] })),
  };
}

/**
 * Why a run that a person starts may use a lot of tokens or quota. Pure: no files, no probing.
 * Empty list = a normal run, nobody is asked. Each reason has a `kind` (what "don't ask again" saves) and plain `text`.
 *   team         orchestrator + leads plan on the high tier, then several workers
 *   parallel     an AI planner on the high tier, then several workers
 *   many-workers 3 or more hand-written workers at the same time
 *   high-model   every agent forced onto the high tier, or onto a profile's high-tier model by name
 */
export function costlyRunReasons(config, { hierarchy = false, autoPlan = false, workers = 1, model = null } = {}) {
  const out = [];
  if (hierarchy) out.push({ kind: 'team', text: 'team mode: an orchestrator and leads plan on the high tier, then several workers run' });
  else if (autoPlan) out.push({ kind: 'parallel', text: 'parallel mode: an AI planner on the high tier, then several workers run at once' });
  if (Number(workers) >= 3) out.push({ kind: 'many-workers', text: `${workers} workers run at the same time` });
  const m = String(model || '').toLowerCase();
  const highModels = [
    ...Object.values(config?.profiles || {}).map((p) => p?.models?.high),
    ...Object.values(config?.quotaFallback || {}).map((f) => f?.models?.high)
  ].filter(Boolean).map((s) => String(s).toLowerCase());
  if (m && (m === 'high' || highModels.includes(m))) out.push({ kind: 'high-model', text: `every agent is forced onto the most expensive model (--model ${model})` });
  return out;
}

/** costlyRunReasons for a backlog item (what autopilot would run), minus the kinds the person said "don't ask again" for. */
export function pendingCostReasons(config, item, approvals = loadApprovals()) {
  if (!item || item.costApproved === true) return [];
  const subs = Array.isArray(item.subtasks) ? item.subtasks.length : 0;
  const reasons = costlyRunReasons(config, { hierarchy: !!item.hierarchy && !subs, autoPlan: !!item.autoPlan && !subs && !item.hierarchy, workers: subs, model: item.model || null });
  const always = new Set(Array.isArray(approvals.alwaysAllow) ? approvals.alwaysAllow : []);
  return reasons.filter((r) => !always.has(r.kind));
}

/**
 * Resolve which engine profile to use.
 * Order: explicit name -> HARNESS_AGENT env -> config.activeProfile ("auto" by default).
 * "auto" = first engine in config.autoOrder that is installed and whose flags pass the probe.
 * If an explicitly requested engine is not installed or fails the probe, we fall back to "auto"
 * and report why (fallbackFrom / fallbackReason). Unknown names are a configuration error.
 */
export function resolveProfile(config, requested, { allowFallback = true } = {}) {
  const want = String(requested || process.env.HARNESS_AGENT || config.activeProfile || 'auto').toLowerCase();
  const order = config.autoOrder || Object.keys(config.profiles);
  const usable = (k) => engineUsable(config, k);
  const auto = () => {
    for (const k of order) if (usable(k).ok) return k;
    return null;
  };

  if (REMOVED_ENGINES[want]) throw Object.assign(new Error(`Engine '${want}' is no longer supported (${REMOVED_ENGINES[want]}). Use one of: auto, ${Object.keys(config.profiles).join(', ')}`), { fatal: true });
  if (want !== 'auto' && !config.profiles[want]) {
    throw Object.assign(new Error(`Unknown engine '${want}'. Known engines: auto, ${Object.keys(config.profiles).join(', ')}`), { fatal: true });
  }
  if (want !== 'auto') {
    const u = usable(want);
    if (u.ok) return { name: want, ...config.profiles[want] };
    if (!allowFallback) throw Object.assign(new Error(`Engine '${want}' cannot be used: ${u.why}.`), { fatal: true });
    const k = auto();
    if (!k) throw Object.assign(new Error(`Engine '${want}' cannot be used (${u.why}) and no other engine is available. Run "Harness: Doctor".`), { fatal: true });
    return { name: k, ...config.profiles[k], fallbackFrom: want, fallbackReason: u.why };
  }
  const k = auto();
  if (!k) throw Object.assign(new Error('No AI engine is available (none installed, or all failed the flag probe). Run "Harness: Doctor".'), { fatal: true });
  return { name: k, ...config.profiles[k] };
}

// ───────────────────────────── verify-command detection ─────────────────────────────

function readHeadText(file, maxBytes = 32768) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.allocUnsafe(maxBytes);
      const n = fs.readSync(fd, buf, 0, maxBytes, 0);
      return buf.subarray(0, n).toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

function collectWorkspacePackageDirs(root, globs) {
  const dirs = [];
  const seen = new Set();
  const add = (dir) => {
    const abs = path.resolve(root, dir);
    if (seen.has(abs)) return;
    const pkgPath = path.join(abs, 'package.json');
    if (fs.existsSync(pkgPath)) { seen.add(abs); dirs.push(abs); }
  };
  for (const raw of globs || []) {
    const g = String(raw || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (!g || g.startsWith('!')) continue;
    if (g.endsWith('/**') || g.endsWith('/*')) {
      const deep = g.endsWith('/**');
      const base = g.slice(0, deep ? -3 : -2);
      const baseDir = base ? path.join(root, base) : root;
      const walk = (d, depth) => {
        let entries = [];
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
          const sub = path.join(d, e.name);
          add(sub);
          if (deep && depth < 2) walk(sub, depth + 1);
        }
      };
      walk(baseDir, 0);
    } else if (!/[*?]/.test(g)) {
      add(g);
    }
  }
  return dirs;
}

/**
 * Pick the strongest deterministic check across Node/workspaces and polyglot ecosystems:
 *   1. root package.json scripts: "check" > "typecheck" + "test" > "build" > "lint"
 *   2. Node/TS workspaces (npm / pnpm / yarn / bun) when root has no check scripts
 *   3. Python (.venv/venv pytest, uv.lock, pytest config, or unittest discovery)
 *   4. Go (go.mod -> go test ./...)
 *   5. Rust (Cargo.toml -> cargo test)
 *   6. PHP / Laravel / Composer (artisan -> php artisan test, composer scripts.test, phpunit)
 *   7. Makefile / GNUmakefile (check > test)
 * Falls back to config.defaultVerifyCmd (always passes) with real=false.
 */
export function detectVerifyCmd(root, config = {}) {
  const pkg = readJsonSafe(path.join(root, 'package.json'), null);
  const scripts = pkg?.scripts || {};
  // A script that can never fail is no check: the npm-init stub and obvious placeholders ("exit 0", "true", a bare echo).
  const PLACEHOLDER_SCRIPT = /^\s*(?:exit\s+0|true|:|echo\b[^&|;<>]*)\s*;?\s*$/i;
  let placeholderSeen = false;
  const hasScript = (s, n) => {
    const v = s?.[n];
    if (typeof v !== 'string' || !v.trim() || /no test specified/.test(v)) return false;
    if (PLACEHOLDER_SCRIPT.test(v)) { placeholderSeen = true; return false; }
    return true;
  };
  const has = (n) => hasScript(scripts, n);
  const exists = (f) => fs.existsSync(path.join(root, f));
  const pm = (exists('pnpm-lock.yaml') || exists('pnpm-workspace.yaml')) ? 'pnpm'
    : exists('yarn.lock') ? 'yarn'
      : (exists('bun.lockb') || exists('bun.lock')) ? 'bun'
        : 'npm';
  const run = (n) => (n === 'test' && pm !== 'bun' ? `${pm} test` : `${pm} run ${n}`);
  let chosen = has('check') ? ['check'] : ['typecheck', 'test'].filter(has);
  if (!chosen.length) chosen = ['build'].filter(has);
  if (!chosen.length) chosen = ['lint'].filter(has);
  if (chosen.length) return { cmd: chosen.map(run).join(' && '), source: `auto-detected from package.json scripts: ${chosen.join(' + ')}`, real: true };

  // Monorepo / workspace Node projects where root package.json delegates to workspace packages
  const wsGlobs = (() => {
    if (Array.isArray(pkg?.workspaces)) return pkg.workspaces;
    if (Array.isArray(pkg?.workspaces?.packages)) return pkg.workspaces.packages;
    if (exists('pnpm-workspace.yaml')) {
      const yaml = readHeadText(path.join(root, 'pnpm-workspace.yaml'));
      return [...yaml.matchAll(/^\s*-\s*['"]?([^'"#\r\n]+?)['"]?\s*(?:#.*)?$/gm)].map((m) => m[1].trim()).filter(Boolean);
    }
    return [];
  })();
  if (wsGlobs.length) {
    const wsPkgs = collectWorkspacePackageDirs(root, wsGlobs)
      .map((d) => readJsonSafe(path.join(d, 'package.json'), null)?.scripts)
      .filter(Boolean);
    const hasWs = (n) => wsPkgs.some((s) => hasScript(s, n));
    let wsChosen = hasWs('check') ? ['check'] : ['typecheck', 'test'].filter(hasWs);
    if (!wsChosen.length) wsChosen = ['build'].filter(hasWs);
    if (!wsChosen.length) wsChosen = ['lint'].filter(hasWs);
    if (wsChosen.length) {
      const wsRun = (n) => (
        pm === 'pnpm' ? (n === 'test' ? 'pnpm -r --if-present test' : `pnpm -r --if-present run ${n}`)
          : pm === 'yarn' ? `yarn workspaces run ${n}`
            : pm === 'bun' ? `bun --filter '*' run ${n}`
              : (n === 'test' ? 'npm test --workspaces --if-present' : `npm run ${n} --workspaces --if-present`)
      );
      return {
        cmd: wsChosen.map(wsRun).join(' && '),
        source: `auto-detected from workspace package.json scripts (${wsPkgs.length} packages): ${wsChosen.join(' + ')}`,
        real: true
      };
    }
  }

  // Python
  const hasPythonTests = () => {
    try {
      for (const e of fs.readdirSync(root, { withFileTypes: true })) {
        if (e.isFile() && (/^test_.*\.py$/i.test(e.name) || /_test\.py$/i.test(e.name))) return true;
        if (e.isDirectory() && /^(tests?|unit_tests)$/i.test(e.name)) {
          try { if (fs.readdirSync(path.join(root, e.name)).some((f) => /\.py$/i.test(f))) return true; } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
    return false;
  };
  const venvPytest = ['.venv/bin/pytest', 'venv/bin/pytest', '.venv/Scripts/pytest.exe', 'venv/Scripts/pytest.exe'].find((rel) => exists(rel));
  if (venvPytest) {
    return { cmd: venvPytest, source: `auto-detected from Python venv (${venvPytest})`, real: true };
  }
  const pyproject = exists('pyproject.toml') ? readHeadText(path.join(root, 'pyproject.toml')) : '';
  const setupCfg = exists('setup.cfg') ? readHeadText(path.join(root, 'setup.cfg')) : '';
  const reqText = ['requirements.txt', 'requirements-dev.txt', 'dev-requirements.txt']
    .map((f) => (exists(f) ? readHeadText(path.join(root, f)) : ''))
    .join('\n');
  const hasPytestConfig = exists('pytest.ini') || exists('conftest.py')
    || /\[tool\.pytest|\bpytest\b/i.test(pyproject)
    || /\[tool:pytest\]/i.test(setupCfg)
    || /(^|\n)\s*pytest\b/im.test(reqText);
  const pyProject = Boolean(pyproject || setupCfg || reqText.trim() || exists('setup.py') || exists('uv.lock') || exists('pytest.ini') || exists('conftest.py'));
  if (pyProject || hasPythonTests()) {
    if (exists('uv.lock') && (hasPytestConfig || hasPythonTests())) {
      return { cmd: 'uv run pytest', source: 'auto-detected from uv.lock (pytest)', real: true };
    }
    if (hasPytestConfig) {
      return { cmd: 'pytest', source: 'auto-detected from Python pytest configuration', real: true };
    }
    if (hasPythonTests()) {
      const pyBin = which('python3') ? 'python3' : (which('python') ? 'python' : 'python3');
      return { cmd: `${pyBin} -m unittest discover`, source: 'auto-detected from Python tests (unittest)', real: true };
    }
  }

  // Go
  if (exists('go.mod')) {
    return { cmd: 'go test ./...', source: 'auto-detected from go.mod', real: true };
  }

  // Rust
  if (exists('Cargo.toml')) {
    return { cmd: 'cargo test', source: 'auto-detected from Cargo.toml', real: true };
  }

  // PHP / Laravel / Composer
  if (exists('artisan')) {
    return { cmd: 'php artisan test', source: 'auto-detected from Laravel artisan', real: true };
  }
  const composer = readJsonSafe(path.join(root, 'composer.json'), null);
  if (typeof composer?.scripts?.test === 'string' && composer.scripts.test.trim()) {
    return { cmd: 'composer test', source: 'auto-detected from composer.json scripts: test', real: true };
  }
  if ((exists('phpunit.xml') || exists('phpunit.xml.dist')) && exists('vendor/bin/phpunit')) {
    return { cmd: './vendor/bin/phpunit', source: 'auto-detected from phpunit configuration', real: true };
  }

  // Makefile
  const makeFile = ['Makefile', 'makefile', 'GNUmakefile'].find((f) => exists(f));
  if (makeFile) {
    const mk = readHeadText(path.join(root, makeFile));
    if (/^[ \t]*check[ \t]*:(?!=)/m.test(mk)) return { cmd: 'make check', source: `auto-detected from ${makeFile} target: check`, real: true };
    if (/^[ \t]*test[ \t]*:(?!=)/m.test(mk)) return { cmd: 'make test', source: `auto-detected from ${makeFile} target: test`, real: true };
  }

  return { cmd: config.defaultVerifyCmd, source: placeholderSeen ? 'default — NO real check (a placeholder test script that cannot fail was ignored)' : 'default — NO real check (always passes)', real: false };
}

// ───────────────────────────── project file listing ─────────────────────────────

const SKIP_DIRS = new Set(['.git', '.harness', 'node_modules', 'dist', 'build', '.next', '.nuxt', '.svelte-kit', '.astro', 'coverage', '.venv', 'venv', '__pycache__', 'target', 'vendor']);

export function listProjectFiles(root, max = 400) {
  try {
    const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    const files = out.split('\n').filter((f) => f && !f.startsWith('.harness/'));
    return { files: files.slice(0, max), total: files.length };
  } catch { /* not a git repo: walk */ }
  const files = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (files.length > max * 5) return;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name); } else files.push(rel ? `${rel}/${e.name}` : e.name);
    }
  };
  walk(root, '');
  return { files: files.slice(0, max), total: files.length };
}

/**
 * Zero-token repository intelligence summary for planners, orchestrators, and briefs:
 * stack & test tools, top directory counts, key entrypoints/configs, and recent git hotspots.
 */
export function buildRepoMap(root, { maxChars = 1200, maxFiles = 2000 } = {}) {
  const pkg = readJsonSafe(path.join(root, 'package.json'), null);
  const { files, total } = listProjectFiles(root, maxFiles);
  if (!files.length && !pkg) return '';

  const exists = (f) => fs.existsSync(path.join(root, f));
  const stack = [];
  if (pkg) {
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const hasTs = Boolean(deps.typescript || exists('tsconfig.json') || files.some((f) => /\.tsx?$/i.test(f)));
    stack.push(hasTs ? 'Node.js/TypeScript' : 'Node.js');
    const fw = [
      ['next', 'Next.js'], ['nuxt', 'Nuxt'], ['@sveltejs/kit', 'SvelteKit'], ['svelte', 'Svelte'],
      ['astro', 'Astro'], ['react', 'React'], ['vue', 'Vue'],
      ['@nestjs/core', 'NestJS'], ['fastify', 'Fastify'], ['express', 'Express'], ['hono', 'Hono'],
      ['tailwindcss', 'Tailwind'], ['electron', 'Electron']
    ];
    for (const [dep, label] of fw) if (deps[dep]) stack.push(label);
    const testers = [['vitest', 'Vitest'], ['jest', 'Jest'], ['@playwright/test', 'Playwright'], ['playwright', 'Playwright'], ['cypress', 'Cypress'], ['mocha', 'Mocha']];
    for (const [dep, label] of testers) if (deps[dep] && !stack.includes(label)) stack.push(label);
    if (pkg.workspaces || exists('pnpm-workspace.yaml')) stack.push('Workspaces');
  }
  if (exists('pyproject.toml') || exists('requirements.txt') || exists('setup.py') || files.some((f) => /\.py$/i.test(f))) {
    const pyTxt = [
      exists('pyproject.toml') ? readHeadText(path.join(root, 'pyproject.toml'), 8192) : '',
      exists('requirements.txt') ? readHeadText(path.join(root, 'requirements.txt'), 8192) : ''
    ].join('\n');
    const extras = [];
    if (/\bfastapi\b/i.test(pyTxt)) extras.push('FastAPI');
    else if (/\bdjango\b/i.test(pyTxt)) extras.push('Django');
    else if (/\bflask\b/i.test(pyTxt)) extras.push('Flask');
    if (exists('pytest.ini') || /\bpytest\b/i.test(pyTxt)) extras.push('pytest');
    stack.push(extras.length ? `Python (${extras.join(', ')})` : 'Python');
  }
  if (exists('go.mod')) stack.push('Go');
  if (exists('Cargo.toml')) stack.push('Rust');
  if (exists('composer.json') || exists('artisan')) stack.push(exists('artisan') ? 'PHP/Laravel' : 'PHP');

  const dirCounts = new Map();
  for (const f of files) {
    const n = f.replace(/\\/g, '/');
    const seg = n.includes('/') ? `${n.split('/')[0]}/` : '(root)';
    dirCounts.set(seg, (dirCounts.get(seg) || 0) + 1);
  }
  const topDirs = [...dirCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([d, c]) => `${d}(${c})`);

  const ENTRY_RE = /^(?:package\.json|tsconfig\.json|pnpm-workspace\.yaml|Makefile|makefile|pyproject\.toml|go\.mod|Cargo\.toml|composer\.json|artisan|index\.html|(?:next|vite|vitest|astro|svelte|playwright|tailwind)\.config\.[a-z]+|(?:src|app|pages)\/(?:index|main|app|server|layout|page|_app)\.[a-z]+|cmd\/[^/]+\/main\.go)$/i;
  const entrypoints = files.filter((f) => ENTRY_RE.test(f.replace(/\\/g, '/'))).slice(0, 8);

  let hotspots = [];
  try {
    const raw = execFileSync('git', ['log', '-n', '15', '--name-only', '--pretty=format:'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000
    });
    const freq = new Map();
    for (const line of raw.split(/\r?\n/)) {
      const p = line.trim().replace(/\\/g, '/');
      if (!p || p.startsWith('.harness/') || p.startsWith('.git/')) continue;
      if (fs.existsSync(path.join(root, p))) freq.set(p, (freq.get(p) || 0) + 1);
    }
    hotspots = [...freq.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 6)
      .map(([p, c]) => `${p} (${c}x)`);
  } catch { /* non-git or empty history */ }

  const lines = [];
  if (stack.length) lines.push(`Stack: ${stack.join(', ')}`);
  if (topDirs.length) lines.push(`Layout (${total} files): ${topDirs.join(', ')}`);
  if (entrypoints.length) lines.push(`Entrypoints: ${entrypoints.join(', ')}`);
  if (hotspots.length) lines.push(`Hotspots (recent git edits): ${hotspots.join(', ')}`);
  let text = lines.join('\n');
  if (text.length > maxChars) text = `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
  return text;
}

/** Normalise a target path; returns null if it is unsafe (absolute, "..", root, .git, .harness). */
export function safeTarget(p) {
  const n = String(p || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!n || n === '.' || n === '/' || path.isAbsolute(n) || /^[a-zA-Z]:/.test(n)) return null;
  if (n.split('/').includes('..')) return null;
  if (/^(\.git|\.harness)(\/|$)/.test(n)) return null;
  return n;
}

/** Normalise a target path and collapse redundant trailing slashes while keeping a single trailing "/" for folders (incl. Windows "\\"). */
export function normalizeTarget(p) {
  const s = safeTarget(p);
  if (!s) return null;
  const base = s.replace(/\/+$/, '');
  return s.endsWith('/') ? `${base}/` : base;
}

/** File names that look like secrets: never put in an automatic commit (.env.example and the like are fine). */
export const SECRET_FILE_RE = /(^|\/)(\.env(\.(?!example$|sample$|template$|dist$)[^/]*)?|[^/]*\.(pem|key|p12|pfx|keystore|jks)|id_(rsa|dsa|ecdsa|ed25519)|credentials(\.[^/]*)?|secrets?(\.[^/]*)?|\.npmrc|\.netrc|\.pypirc)$/i;
export const isSecretFile = (file) => SECRET_FILE_RE.test(String(file || '').replace(/\\/g, '/'));

export function realNorm(p) {
  let r;
  try { r = fs.realpathSync.native(p); } catch { r = path.resolve(p); }
  return process.platform === 'win32' ? r.toLowerCase() : r;
}
export const isSameDir = (a, b) => realNorm(a) === realNorm(b);

/** Validate an external --cwd / task.cwd folder: must exist as a directory outside .git/.harness and be a git worktree root of this same repository. */
export function validateExternalWorkRoot(dir, root = ROOT, label = '--cwd') {
  const fatalErr = (msg) => Object.assign(new Error(msg), { fatal: true });
  const resolved = path.resolve(root, String(dir));
  let st;
  try { st = fs.statSync(resolved); } catch {
    throw fatalErr(`${label} path is not a folder: ${resolved}`);
  }
  if (!st.isDirectory()) throw fatalErr(`${label} path is not a folder: ${resolved}`);
  let realWork = resolved;
  try { realWork = fs.realpathSync.native(resolved); } catch { /* resolved directory exists */ }
  const blockedSeg = /(?:^|\/)\.(git|harness)(?:\/|$)/;
  if (blockedSeg.test(resolved.replace(/\\/g, '/')) || blockedSeg.test(realWork.replace(/\\/g, '/'))) {
    throw fatalErr(`Refusing ${label} inside .git or .harness: ${realWork}`);
  }
  if (!isSameDir(realWork, root)) {
    const gitCommon = (d) => {
      try {
        const raw = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: d, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        return realNorm(path.resolve(d, raw));
      } catch { return null; }
    };
    const gitTop = (d) => {
      try {
        return realNorm(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: d, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
      } catch { return null; }
    };
    const here = gitCommon(root); const there = gitCommon(realWork); const top = gitTop(realWork);
    if (!here || !there || !isSameDir(here, there)) {
      throw fatalErr(`Refusing ${label} ${realWork}: it is not a git worktree of this project. ${label} only accepts a worktree of the same repository (see: git worktree list).`);
    }
    if (!top || top !== realNorm(realWork)) {
      throw fatalErr(`Refusing ${label} ${realWork}: pass the worktree root folder${top ? ` (${top})` : ''}, not a subfolder inside it.`);
    }
  }
  return realWork;
}

// ───────────────────────────── Memory store ─────────────────────────────
// Memory is plain Markdown so BOTH the harness and any editor AI can read/edit it.
//   profile.md       — who the user is and how they like to work
//   lessons.md       — rules the user taught explicitly ("remember ...")  [highest priority]
//   auto-lessons.md  — things the harness learned from failed/retried tasks (git-ignored)
//   sessions/*.md    — one record per task the harness ran (git-ignored)

const LESSON_RE = /^- \[(L\d+)\] \(([^)]*)\) (.*)$/;

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

export function listLessons(file = FILES.lessons) {
  return readText(file).split('\n')
    .map((line) => line.match(LESSON_RE))
    .filter(Boolean)
    .map(([, id, date, text]) => ({ id, date, text }));
}

const norm = (t) => String(t).toLowerCase().replace(/[-_/\\]+/g, ' ').replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();

const SEEN_SUFFIX_RE = /\s+\(seen (\d+)x(?:;\s*latest:\s*"[^"]*")?\)\s*$/;
const stripSeen = (t) => String(t || '').replace(SEEN_SUFFIX_RE, '').trim();

function extractTaskTitle(t) {
  const m = String(t || '').match(/^(?:Scope violation in |Quality\/root-cause signal in |Patch safety block in )?"([^"\n]+)"/);
  return m ? m[1].trim() : '';
}

function autoLessonSignature(text) {
  const s = stripSeen(text);
  let kind = '';
  let rest = '';
  let m;
  if ((m = s.match(/^Scope violation in "[^"\n]+":\s*(.+)$/))) { kind = 'scope'; rest = m[1]; }
  else if ((m = s.match(/^Quality\/root-cause signal in "[^"\n]+":\s*(.+)$/))) { kind = 'anticheat'; rest = m[1]; }
  else if ((m = s.match(/^Patch safety block in "[^"\n]+":\s*(.+)$/))) { kind = 'safety'; rest = m[1]; }
  else if ((m = s.match(/^"[^"\n]+":\s*first attempt failed(?:\s+with|\s*\()\s*(.+?)(?:\s+—\s+passed|\s*\)\s*—\s+passed)/))) { kind = 'recover'; rest = m[1]; }
  else if ((m = s.match(/^"[^"\n]+":\s*(?:HALTED_HITL_REQUIRED|REJECTED|editor run [A-Z_]+)\s+—\s+(?:last error\s+)?(.+?)(?:\.\s+Needs a human|$)/))) { kind = 'halt'; rest = m[1]; }
  if (!kind || !rest) return '';
  const core = rest
    .replace(/[A-Za-z]:\\[^\s"']+|\/(?:tmp|var|home|Users)\/[^\s"']+/g, '<path>')
    .replace(/\b(?:V-\d{8,14}-[a-z0-9]+|job-\d+|BL-\d+|FEAT-\d+)\b/g, '<id>')
    .replace(/:\d+:\d+/g, ':<pos>')
    .replace(/\d+/g, '#');
  const k = norm(core);
  return k.length >= 20 ? `${kind}:${k}` : '';
}

export function remember(text, file = FILES.lessons) {
  const clean = stripSeen(String(text || '').replace(/\s+/g, ' ').trim());
  if (!clean) throw new Error('Nothing to remember (empty text).');
  ensureDirs();
  const existing = listLessons(file);
  const dup = existing.find((l) => norm(stripSeen(l.text)) === norm(clean));
  if (dup) return { ...dup, duplicate: true };

  if (file === FILES.autoLessons) {
    const sig = autoLessonSignature(clean);
    if (sig) {
      const match = existing.find((l) => autoLessonSignature(l.text) === sig);
      if (match) {
        const seenMatch = match.text.match(SEEN_SUFFIX_RE);
        const count = (seenMatch ? Number(seenMatch[1]) : 1) + 1;
        const base = stripSeen(match.text);
        const latest = extractTaskTitle(clean);
        const today = new Date().toISOString().slice(0, 10);
        const updatedText = `${base} (seen ${count}x${latest && latest !== extractTaskTitle(base) ? `; latest: "${latest.slice(0, 60)}"` : ''})`;
        const lines = readText(file).split('\n').map((line) => {
          const lm = line.match(LESSON_RE);
          return lm && lm[1].toUpperCase() === match.id.toUpperCase() ? `- [${match.id}] (${today}) ${updatedText}` : line;
        });
        fs.writeFileSync(file, lines.join('\n'));
        return { id: match.id, date: today, text: updatedText, duplicate: true, updated: true, seen: count };
      }
    }
  }

  const next = existing.reduce((max, l) => Math.max(max, Number(l.id.slice(1))), 0) + 1;
  const lesson = { id: `L${next}`, date: new Date().toISOString().slice(0, 10), text: clean };
  let body = readText(file);
  if (!body.trim()) body = file === FILES.autoLessons ? AUTO_LESSONS_HEADER : LESSONS_HEADER;
  if (!body.endsWith('\n')) body += '\n';
  fs.writeFileSync(file, `${body}- [${lesson.id}] (${lesson.date}) ${lesson.text}\n`);
  return lesson;
}

export function forget(id, file = FILES.lessons) {
  const lines = readText(file).split('\n');
  const kept = lines.filter((line) => (line.match(LESSON_RE) || [])[1]?.toUpperCase() !== String(id).toUpperCase());
  if (kept.length === lines.length) return false;
  fs.writeFileSync(file, kept.join('\n'));
  return true;
}

/** Promote a learned entry from auto-lessons.md into shared lessons.md and remove it from auto-lessons.md. */
export function promoteLesson(id) {
  const target = String(id || '').trim().toUpperCase();
  if (!target) return null;
  const entry = listLessons(FILES.autoLessons).find((l) => l.id.toUpperCase() === target);
  if (!entry) return null;
  const lesson = remember(stripSeen(entry.text), FILES.lessons);
  forget(entry.id, FILES.autoLessons);
  return { fromId: entry.id, lesson };
}

/** Clip a long verifier error while keeping BOTH the command/exit header and the failing tail stack trace. */
export function clipErrorTrace(trace, limit = 6000) {
  const s = String(trace || '');
  if (s.length <= limit) return s;
  const head = Math.max(400, Math.floor(limit * 0.25));
  const tail = Math.max(400, limit - head - 32);
  return `${s.slice(0, head)}\n…[truncated middle of log]…\n${s.slice(-tail)}`;
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const MEMORY_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'have', 'not', 'are', 'was', 'were', 'been',
  'will', 'can', 'into', 'out', 'all', 'any', 'but', 'use', 'add', 'fix', 'set', 'get', 'put', 'run',
  'file', 'files', 'task', 'tasks', 'work', 'make', 'made', 'when', 'only', 'also', 'must', 'should',
  'could', 'would', 'more', 'most', 'very', 'just', 'than', 'then', 'them', 'they', 'there', 'here',
  'each', 'some', 'such', 'your', 'our', 'their', 'about', 'after', 'before', 'check', 'tests', 'test',
  'code', 'edit', 'edits', 'change', 'changes', 'update', 'updated', 'error', 'errors', 'fail', 'failed',
  'failure', 'pass', 'passed', 'src', 'dist', 'build'
]);
const SHORT_TECH_TOKENS = new Set(['go', 'py', 'ts', 'js', 'ui', 'db', 'ci', 'cd', 'id', 'pr', 'os', 'io', 'kv', 'ip', 'v2', 's3', 'sh']);

function buildMemoryQuery(query) {
  if (!query) return { hasQuery: false, tokens: [], paths: [] };
  const texts = [];
  const rawPaths = [];
  const pushVal = (v) => {
    if (!v) return;
    if (Array.isArray(v)) { for (const x of v) pushVal(x); return; }
    if (typeof v === 'object') {
      pushVal(v.title); pushVal(v.goal); pushVal(v.prompt); pushVal(v.query); pushVal(v.error);
      if (Array.isArray(v.files)) rawPaths.push(...v.files);
      if (Array.isArray(v.targetFiles)) rawPaths.push(...v.targetFiles);
      if (Array.isArray(v.targets)) rawPaths.push(...v.targets);
      return;
    }
    texts.push(String(v));
  };
  pushVal(query);
  const combined = texts.filter(Boolean).join(' ');
  const normRoot = ROOT.replace(/\\/g, '/').toLowerCase();
  for (const p of combined.matchAll(/[A-Za-z0-9_.\-\\/:]+\.[A-Za-z0-9]{1,8}/g)) rawPaths.push(p[0]);
  const paths = new Set();
  for (const rp of rawPaths) {
    let p = String(rp || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();
    if (!p) continue;
    if (p.startsWith(`${normRoot}/`)) p = p.slice(normRoot.length + 1);
    paths.add(p);
  }
  const tokenSet = new Set();
  for (const w of norm(combined).split(' ')) {
    if (!w) continue;
    if ((w.length >= 3 && !MEMORY_STOPWORDS.has(w)) || SHORT_TECH_TOKENS.has(w)) tokenSet.add(w);
  }
  for (const p of paths) {
    for (const seg of norm(p).split(' ')) {
      if ((seg.length >= 3 && !MEMORY_STOPWORDS.has(seg)) || SHORT_TECH_TOKENS.has(seg)) tokenSet.add(seg);
    }
  }
  return { hasQuery: tokenSet.size > 0 || paths.size > 0, tokens: [...tokenSet], paths: [...paths] };
}

function rankAutoLessons(allAuto, query, autoRoom) {
  if (autoRoom <= 0 || !allAuto.length) return [];
  const q = buildMemoryQuery(query);
  if (!q.hasQuery) return allAuto.slice(-autoRoom);

  const n = allAuto.length;
  const scored = allAuto.map((entry, idx) => {
    const clean = stripSeen(entry.text);
    const rawLower = clean.toLowerCase().replace(/\\/g, '/');
    const entryTokens = new Set(norm(clean).split(' ').filter(Boolean));
    let matchedTokens = 0;
    for (const t of q.tokens) if (entryTokens.has(t)) matchedTokens++;
    let pathScore = 0;
    for (const p of q.paths) {
      const base = path.posix.basename(p);
      if (p.includes('/') && rawLower.includes(p)) pathScore += 6;
      else if (base.length >= 3 && rawLower.includes(base)) pathScore += 3;
    }
    const relevance = matchedTokens * 3 + pathScore;
    const seenMatch = entry.text.match(SEEN_SUFFIX_RE);
    const seenCount = seenMatch ? Number(seenMatch[1]) : 1;
    const seenBonus = seenCount > 1 ? Math.min(Math.log2(seenCount) * 0.6, 2.0) : 0;
    const recencyWeight = n > 1 ? (idx / (n - 1)) * 0.5 : 0.5;
    return { entry, idx, relevance, totalScore: relevance + seenBonus + recencyWeight };
  });

  const top = [...scored]
    .sort((a, b) => (b.totalScore - a.totalScore) || (b.idx - a.idx))
    .slice(0, autoRoom);
  const relevant = top.filter((x) => x.relevance > 0).sort((a, b) => (b.totalScore - a.totalScore) || (b.idx - a.idx));
  const fallback = top.filter((x) => x.relevance === 0).sort((a, b) => a.idx - b.idx);
  return [...relevant, ...fallback].map((x) => x.entry);
}

const DIAG_CATEGORIES = [
  ['PATCH_SAFETY', /PATCH_SAFETY|Safety gate BLOCKED|leaked .* in .*\(redacted\)|unresolved merge conflict marker|merge conflict marker/i],
  ['COMMAND_NOT_FOUND', /\bcommand not found\b|is not recognized as an internal or external command|not recognized as the name of a cmdlet|\bspawn\s+\S+\s+ENOENT\b|\bENOENT\b.*(?:spawn|exec)|exit code 127\b/i],
  ['MISSING_DEPENDENCY', /Cannot find module\s+['"]|ERR_MODULE_NOT_FOUND|ModuleNotFoundError:\s*No module named|\bImportError:|Cannot resolve\s+['"]|Module not found:|could not find package|no required module provides package|failed to resolve import/i],
  ['TIMEOUT', /\btimed?\s*out\b|ETIMEDOUT|\bSIGTERM\b|exit code timeout|Command failed after \d+ms/i],
  ['PERMISSION_OR_ENV', /\b(?:EACCES|EPERM)\b|Permission denied|missing environment variable|env(?:ironment)? variable\s+\S+\s+not set|Must set [A-Z0-9_]+|\b(?:401|403)\s+(?:Unauthorized|Forbidden)\b|ECONNREFUSED|\bENOTFOUND\b|\bEAI_AGAIN\b/i],
  ['SYNTAX_OR_PARSE', /\b(?:SyntaxError|IndentationError|TabError)\b|Unexpected token|Unterminated string literal|Unexpected end of JSON input|JSON\.parse\b|\bParse error:|syntax error(?:\s+near|\s+at line|:)/i],
  ['TYPECHECK', /error TS\d{3,5}:|Type ['"][^'"]+['"] is not assignable to|Property ['"][^'"]+['"] does not exist on type|Argument of type ['"][^'"]+['"] is not assignable|\bmypy\b.*\berror:|\bpyright\b.*\berror:|\bcannot use .* as type\b/i],
  ['TEST_ASSERTION', /\bAssertionError\b|\bERR_ASSERTION\b|\bAssertion failed\b|\bnot ok \d+\b|---\s*FAIL:|^\s*✖\s+\S|assert\.(?:equal|strictEqual|deepStrictEqual|ok|throws|rejects)\b|\bFAILED\s+[^\s]+::|\bFAIL\s+\S+\.(?:test|spec)\.|Expected[\s\S]{0,120}(?:Received|Actual|!==|to equal|to be)/m],
  ['RUNTIME_ERROR', /\b(?:ReferenceError|TypeError|RangeError|URIError|RuntimeError|ValueError|KeyError|AttributeError|ZeroDivisionError)\b|\bpanic:|UnhandledPromiseRejection|Uncaught\s+\w*Error/i]
];

const DIAG_HINTS = {
  PATCH_SAFETY: 'Remove leaked credentials/tokens or resolve git conflict markers before re-verifying.',
  COMMAND_NOT_FOUND: 'Check CLI/tool installation, PATH, or the script/check command.',
  MISSING_DEPENDENCY: 'Check module import paths, relative extensions, and installed packages.',
  TIMEOUT: 'Investigate hangs, infinite loops, unclosed handles, or slow setup.',
  PERMISSION_OR_ENV: 'Check file permissions, local env prerequisites, or network mocks without hardcoding secrets.',
  SYNTAX_OR_PARSE: 'Fix the syntax, delimiter, or JSON/config parse error at the referenced location.',
  TYPECHECK: 'Fix the type mismatch or interface signature across callers and definitions.',
  TEST_ASSERTION: 'Inspect the failing assertion and fix the root cause (never skip or weaken assertions).',
  RUNTIME_ERROR: 'Inspect the stack trace, boundary checks, and null/undefined handling at the referenced line.',
  UNKNOWN: 'Read the failing command output carefully before making further changes.'
};

function cleanProjectPath(rawPath) {
  let p = String(rawPath || '').trim().replace(/^["'`]+|["'`,;.)]+$/g, '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!p || p.includes('/node_modules/') || p.startsWith('node_modules/') || p.startsWith('node:')) return '';
  const rootNorm = ROOT.replace(/\\/g, '/').replace(/\/+$/, '');
  if (p.toLowerCase().startsWith(`${rootNorm.toLowerCase()}/`)) p = p.slice(rootNorm.length + 1);
  if (/^(?:[A-Za-z]:)?\//.test(p)) {
    const sub = p.match(/(?:^|\/)((?:src|app|components|lib|tests?|__tests__|spec|docs?|backend|server|cmd|internal|pkg|website|scripts|modules|services|routes|utils)\/.+)$/);
    if (!sub) return '';
    p = sub[1];
  }
  if (p.startsWith('..') || !/\.[A-Za-z0-9]{1,8}$/.test(p)) return '';
  return p;
}

function scopeOverlap(filePath, target) {
  const f = String(filePath || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  const t = String(target || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/\*\*$/, '').replace(/\/\*$/, '').replace(/\/+$/, '');
  if (!f || !t) return false;
  if (f === t || f.startsWith(`${t}/`) || t.startsWith(`${f}/`)) return true;
  if (/[*?]/.test(t)) {
    const re = new RegExp(`^${t.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`);
    return re.test(f);
  }
  return false;
}

/**
 * Deterministic failure triage for verifier & patch-safety output (zero tokens).
 * Classifies error category, extracts referenced project files & failing tests, computes a stable
 * failure signature, detects repeat failures across cycles, and maps likely owning subtasks.
 */
export function diagnoseVerifyFailure(trace, { previousTrace = '', targetFiles = [], subtasks = [], verifyCmd = '' } = {}, _depth = 0) {
  const clean = String(trace || '').replace(ANSI_RE, '').trim();
  const emptyResult = {
    category: 'UNKNOWN',
    headline: 'No failure output captured',
    signature: 'unknown',
    repeat: false,
    files: [],
    tests: [],
    likelyTargets: [],
    likelyOwners: [],
    hint: DIAG_HINTS.UNKNOWN
  };
  if (!clean) return emptyResult;

  let category = 'UNKNOWN';
  for (const [cat, re] of DIAG_CATEGORIES) {
    if (re.test(clean)) { category = cat; break; }
  }

  const lines = clean.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const files = [];
  const filePaths = [];
  const seenFileEntry = new Set();
  const addFile = (raw, lineNo = '') => {
    const rel = cleanProjectPath(raw);
    if (!rel) return;
    const entry = lineNo ? `${rel}:${lineNo}` : rel;
    if (!seenFileEntry.has(entry) && files.length < 8) {
      seenFileEntry.add(entry);
      files.push(entry);
    }
    if (!filePaths.includes(rel) && filePaths.length < 8) filePaths.push(rel);
  };

  for (const l of lines) {
    let m;
    if ((m = l.match(/^File "([^"]+\.py)", line (\d+)/))) addFile(m[1], m[2]);
    for (const tm of l.matchAll(/([^\s(:*?"'<>]+\.(?:tsx?|jsx?|mjs|cjs))\((\d+),\d+\)/g)) addFile(tm[1], tm[2]);
    for (const fm of l.matchAll(/(?:[A-Za-z]:)?(?:\/[^\s:()"'<>]+|[A-Za-z0-9_.\-\\]+\/(?:[A-Za-z0-9_.\-\\]+\/)*[A-Za-z0-9_.-]+)\.(?:js|mjs|cjs|jsx|ts|tsx|py|go|rs|php|rb|java|kt|cs|c|cpp|h|vue|svelte|astro|css|scss|less|html|json|yml|yaml|toml|md)(?::(\d+)(?::\d+)?)?/g)) {
      const full = fm[0];
      const lineMatch = full.match(/^(.+?):(\d+)(?::\d+)?$/);
      if (lineMatch) addFile(lineMatch[1], lineMatch[2]);
      else addFile(full);
    }
  }

  const tests = [];
  const addTest = (name) => {
    const t = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (t && !tests.includes(t) && tests.length < 6) tests.push(t);
  };
  for (const l of lines) {
    let m;
    if ((m = l.match(/^not ok \d+\s*-\s*(.+)$/))) addTest(m[1]);
    else if ((m = l.match(/^✖\s+(.+?)(?:\s+\(\d+(?:\.\d+)?ms\))?$/))) addTest(m[1]);
    else if ((m = l.match(/^---\s*FAIL:\s*(\S+)/))) addTest(m[1]);
    else if ((m = l.match(/^FAILED\s+([^\s]+::[^\s]+|[^\s]+)/))) addTest(m[1]);
    else if ((m = l.match(/^test\s+([A-Za-z0-9_:.-]+)\s+\.\.\.\s+FAILED/))) addTest(m[1]);
    else if ((m = l.match(/^●\s+(.+)$/))) addTest(m[1]);
  }

  const NOISE_LINE = /^(?:exit code\b|FAIL\s*\(exit\b|Command failed:|npm error\b|npm ERR!\b|Node\.js v\d)/i;
  const PRIORITY_LINE = /(?:PATCH_SAFETY|leaked .* in .*\(redacted\)|merge conflict marker|error TS\d+:|(?:Assertion|Syntax|Reference|Type|Range|URI|Runtime|Value|Key|Attribute|ModuleNotFound|Import)Error\b|ERR_ASSERTION|ERR_MODULE_NOT_FOUND|Cannot find module|command not found|not recognized|timed?\s*out|ETIMEDOUT|EACCES|EPERM|ECONNREFUSED)/i;
  const pickLine = lines.find((l) => !NOISE_LINE.test(l) && PRIORITY_LINE.test(l))
    || lines.find((l) => !NOISE_LINE.test(l) && /^(?:Error|FAIL|FAILED|not ok \d+|✖|--- FAIL:|panic:)\b/i.test(l))
    || lines.find((l) => !NOISE_LINE.test(l))
    || lines[0];
  const headline = String(pickLine || verifyCmd || 'Verification failed').replace(/\s+/g, ' ').slice(0, 160);

  const coreHeadline = headline
    .replace(/[A-Za-z]:\\[^\s"']+|\/(?:tmp|var|home|Users)\/[^\s"']+/g, '<path>')
    .replace(/\b\d+\s*ms\b/gi, '#ms')
    .replace(/:\d+(?::\d+)?/g, '')
    .replace(/\(\d+,\s*\d+\)/g, '')
    .replace(/\d+/g, '#')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  const signature = [category, filePaths[0] || '', coreHeadline || (tests[0] ? norm(tests[0]) : '')].filter(Boolean).join('|').slice(0, 160);

  let repeat = false;
  if (_depth === 0 && String(previousTrace || '').trim()) {
    const prev = diagnoseVerifyFailure(previousTrace, { targetFiles, subtasks, verifyCmd }, 1);
    repeat = Boolean(prev && prev.signature && prev.signature === signature && (category !== 'UNKNOWN' || coreHeadline.length >= 12));
  }

  const allTargets = [
    ...(Array.isArray(targetFiles) ? targetFiles : []),
    ...(Array.isArray(subtasks) ? subtasks.flatMap((s) => s?.targetFiles || []) : [])
  ];
  const likelyTargets = filePaths.filter((fp) => allTargets.some((t) => scopeOverlap(fp, t)));
  const finalTargets = likelyTargets.length ? likelyTargets : filePaths.slice(0, 4);
  const likelyOwners = [];
  if (Array.isArray(subtasks)) {
    for (const sub of subtasks) {
      if (!sub?.id || !Array.isArray(sub.targetFiles)) continue;
      if (filePaths.some((fp) => sub.targetFiles.some((t) => scopeOverlap(fp, t)))) likelyOwners.push(sub.id);
    }
  }

  return {
    category,
    headline,
    signature,
    repeat,
    files,
    tests,
    likelyTargets: finalTargets,
    likelyOwners,
    hint: DIAG_HINTS[category] || DIAG_HINTS.UNKNOWN
  };
}

export function formatDiagnosis(diag) {
  if (!diag || !diag.headline) return '';
  const lines = [
    `Category: ${diag.category}${diag.repeat ? ' [REPEAT FAILURE — same error signature as previous cycle; do NOT repeat the same edit, inspect files and change approach]' : ''}`,
    `Summary: ${diag.headline}`,
    ...(diag.files?.length ? [`Files referenced: ${diag.files.join(', ')}`] : []),
    ...(diag.likelyOwners?.length ? [`Likely owner(s): ${diag.likelyOwners.join(', ')}`] : []),
    ...(diag.tests?.length ? [`Failing test(s): ${diag.tests.join('; ')}`] : []),
    ...(diag.hint ? [`Action hint: ${diag.hint}`] : [])
  ];
  return lines.join('\n');
}

// ───────────────────────────── the person (me.md) ─────────────────────────────
// .harness/memory/me.md is git-ignored: one per person and machine. profile.md stays the shared project profile.
// "Hats" are the HUMAN's focus (po, ba, ux, dev, qa; combinable). They are not AI roles (team.json, roles/*.json):
// they shape how an AI talks to and checks with this person, and never change any scope, approval or permission.
export const HATS = ['po', 'ba', 'ux', 'dev', 'qa'];
export const ME_KEYS = [
  ['name', 'Name'],
  ['language', 'Language I want answers in'],
  ['experience', 'Coding experience'],
  ['style', 'How I like answers'],
  ['hats', 'Hats'],
  ['skills', 'Personal skills']
];
const HAT_HINTS = {
  po: 'acceptance criteria, scope and decisions first',
  ba: 'business rules, data and edge cases first',
  ux: 'user flows, states and accessibility first',
  dev: 'file:line references and the technical root cause first',
  qa: 'test evidence, regressions and Given-When-Then checks first'
};
const keyOf = (label) => String(label).toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** "- Label: value" → { key, label, value }; null for other lines and "(fill me" placeholders. */
export function parseProfileLine(line) {
  const m = String(line).match(/^\s*-\s+([^:]+):\s*(.*)$/);
  if (!m || /\(fill me/i.test(m[2])) return null;
  return { key: keyOf(m[1]), label: m[1].trim(), value: m[2].trim() };
}

/** Hats from free text: "PO + QA", "po, qa", "dev/qa" → ['po','qa']; unknown words are dropped. */
export function parseHats(text) {
  const out = [];
  for (const w of String(text || '').toLowerCase().split(/[^a-z]+/)) if (HATS.includes(w) && !out.includes(w)) out.push(w);
  return out;
}

/** Read me.md: { exists, fields: [{key,label,value}], hats: [], skills: [] }. Never throws. */
export function readMe(file = FILES.me) {
  const text = readText(file);
  const fields = text.split('\n').map(parseProfileLine).filter((f) => f && f.value);
  const get = (k) => fields.find((f) => f.key === keyOf(k))?.value || '';
  return {
    exists: fs.existsSync(file),
    fields,
    hats: parseHats(get('Hats')),
    skills: get('Personal skills').split(/[,;]/).map((s) => s.trim()).filter(Boolean)
  };
}

/** Write me.md from { name, language, experience, style, hats, skills } (missing keys keep their current value). */
export function writeMe(values, file = FILES.me) {
  const cur = readMe(file);
  const now = Object.fromEntries(cur.fields.map((f) => [f.key, f.value]));
  const lines = ['# Me (personal, git-ignored)', '',
    'This file is yours only: it is never committed. The shared project profile is profile.md.',
    'Hats (po, ba, ux, dev, qa; combinable) shape how the AI talks to you; they never change permissions.', ''];
  for (const [k, label] of ME_KEYS) {
    let v = values[k] !== undefined ? values[k] : now[keyOf(label)];
    if (k === 'hats' && v !== undefined) v = parseHats(Array.isArray(v) ? v.join(',') : v).join(', ');
    if (k === 'skills' && Array.isArray(v)) v = v.join(', ');
    lines.push(`- ${label}: ${v || ''}`.trimEnd());
  }
  ensureDirs();
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return readMe(file);
}

export const ME_SETUP_CMD = 'node .harness/memory.mjs me set --name "…" --language "…" --experience "…" --style "…" --hats "po,qa"';

/**
 * Who is at this machine, for session start and doctor. Read-only, never asks anything (safe without a terminal).
 *  { me, kind: 'me' | 'missing' | 'other-person' | 'ok', name?, gitName? }
 *  - 'me': this person has me.md;
 *  - 'missing': no me.md and profile.md is not filled in → onboard this person;
 *  - 'other-person': no me.md, profile.md names someone else than the git user → probably a teammate on a new machine;
 *  - 'ok': no me.md but profile.md is filled in and matches (one person working alone: nothing changes).
 */
export function personStatus({ gitName } = {}) {
  const me = readMe();
  if (me.exists && me.fields.length) return { me, kind: 'me' };
  const profileText = readText(FILES.profile);
  const filled = profileText.trim() && !/^- .*\(fill me/im.test(profileText);
  if (!filled) return { me, kind: 'missing' };
  const name = profileText.split('\n').map(parseProfileLine).find((f) => f && f.key === 'name')?.value || '';
  if (gitName === undefined) { try { gitName = spawnSync('git', ['config', 'user.name'], { cwd: ROOT, encoding: 'utf8', timeout: 3000 }).stdout?.trim() || ''; } catch { gitName = ''; } }
  const a = name.toLowerCase(); const b = String(gitName).toLowerCase();
  if (a && b && !a.includes(b) && !b.includes(a)) return { me, kind: 'other-person', name, gitName };
  return { me, kind: 'ok' };
}

/** The person block for worker prompts: me.md without personal skills, plus what the hats mean. '' without me.md. */
export function mePromptBlock(me = readMe()) {
  const lines = me.fields.filter((f) => f.key !== keyOf('Personal skills') && f.key !== keyOf('Hats')).map((f) => `- ${f.label}: ${f.value}`);
  if (me.hats.length) {
    lines.push(`- Hats: ${me.hats.join(', ')} (${me.hats.map((h) => HAT_HINTS[h]).join('; ')})`);
    lines.push('- Hats only shape how you report and what you check first. They never widen your files, tools or permissions.');
  }
  return lines.length ? `## Person who started this run (me.md, overrides the user profile)\n${lines.join('\n')}` : '';
}

/**
 * Build the memory block injected into worker prompts.
 *  - skip: ['profile','lessons'] when the engine already auto-loads them (e.g. CLAUDE.md @imports)
 *  - query: optional task/goal/files/error hint to prioritize relevant auto-lessons
 *  - lesson lines are de-duplicated and capped at memory.maxLessonLines (default 50):
 *    taught rules first (newest kept if over the cap), then relevant or most recent auto lessons.
 */
export function memoryContext(config, { skip = [], query = '' } = {}) {
  const mem = config.memory || {};
  if (mem.enabled === false) return '';
  const maxLines = mem.maxLessonLines ?? 50;
  const parts = [];

  const me = readMe();
  if (!skip.includes('profile')) {
    // Shared profile lines that the person's own me.md answers are left out: the person's value wins.
    const overridden = new Set(me.fields.map((f) => f.key));
    const profile = readText(FILES.profile).split('\n')
      .filter((l) => !/\(fill me/i.test(l))
      .filter((l) => { const f = parseProfileLine(l); return !f || !overridden.has(f.key); })
      .join('\n').trim();
    if (profile && /^- .+:\s*\S/m.test(profile)) parts.push(`## User profile\n${profile}`);
  }
  const meBlock = mePromptBlock(me); // personal skills stay out: they are for the chat AI only
  if (meBlock) parts.push(meBlock);

  const seen = new Set();
  const fresh = (l) => { const k = norm(stripSeen(l.text)); if (seen.has(k)) return false; seen.add(k); return true; };
  const taught = listLessons(FILES.lessons).filter(fresh).slice(-maxLines); // dedupe even if skipped,
  const autoRoom = Math.max(0, Math.min(mem.maxAutoLessons ?? 10, maxLines - (skip.includes('lessons') ? 0 : taught.length)));
  const allAuto = listLessons(FILES.autoLessons).reverse().filter(fresh).reverse(); // newest kept if duplicate exists
  const auto = rankAutoLessons(allAuto, query, autoRoom);

  if (taught.length && !skip.includes('lessons')) parts.push(`## Rules the user taught (always follow)\n${taught.map((l) => `- ${l.text}`).join('\n')}`);
  if (auto.length) parts.push(`## Lessons from earlier harness runs\n${auto.map((l) => `- ${l.text}`).join('\n')}`);
  if (skip.length) parts.push(`(Also follow the ${skip.join(' and ')} memory your engine already loaded from the project instruction file.)`);

  const max = mem.maxContextChars || 6000;
  let text = parts.join('\n\n');
  if (text.length > max) text = `${text.slice(0, max)}\n…[memory truncated to ${max} chars]`;
  return text;
}

export function recordSession(record) {
  ensureDirs();
  const file = path.join(DIRS.sessions, `${record.finishedAt.slice(0, 19).replace(/[:T]/g, '-')}-${record.taskId}.md`);
  const lines = [
    `# ${record.title}`,
    '',
    `- Task ID: ${record.taskId}`,
    `- Result: **${record.result}**`,
    `- Engine: ${record.engine}`,
    ...(record.cwd ? [`- Workdir: ${record.cwd}`] : []),
    `- Cycles used: ${record.cycles}/${record.maxCycles}`,
    `- Verify command: \`${record.verifyCmd}\` (${record.verifySource || 'given by task'})`,
    ...(record.git ? [`- Git: ${record.git.mergedSha ? `merged into **${record.git.branch}** @ ${record.git.mergedSha.slice(0, 8)} (from ${record.git.baseSha.slice(0, 8)})` : `**${record.git.branch}** unchanged`}; worker branches ${record.git.workerBranches.join(', ') || '-'}${record.git.keptBranches ? ' (kept for review)' : ' (deleted)'}; protected branches ${record.git.protectedUnchanged ? 'unchanged' : 'CHANGED — check!'}`] : []),
    ...(record.planner ? [`- Plan: ${record.planner}`] : []),
    ...(record.team ? [`- Team: ${record.team.orchestrator} → ${record.team.assignments.map((a) => `${a.lead} (${a.workers.map((w) => w.id).join(', ')})`).join('; ')}`] : []),
    ...(record.costUsd ? [`- Cost: $${record.costUsd.toFixed(4)} (${Object.entries(record.costByAgent || {}).map(([k, v]) => `${k} $${v.toFixed(4)}`).join(', ')})`] : []),
    ...(record.rollback ? [`- Rollback: ${record.rollback}`] : []),
    `- Finished: ${record.finishedAt}`,
    '',
    '## What was asked',
    ...(record.goal ? [`Goal: ${record.goal}`, ''] : []),
    ...record.subtasks.map((s) => `- **${s.id}** (files: ${(s.targetFiles || []).join(', ') || 'unscoped'}): ${s.prompt || s.cliCommand || ''}`),
    ''
  ];
  if (record.verifySuggestion) lines.push(`AI planner suggested this check (NOT run automatically): \`${record.verifySuggestion}\``, '');
  if (record.errors?.length) {
    lines.push('## Errors seen (per cycle)');
    record.errors.forEach((e, i) => lines.push(`### Cycle ${i + 1}`, '```', String(e).slice(0, 2000), '```'));
    lines.push('');
  }
  if (record.outputs?.length) {
    lines.push('## Worker output (last cycle)');
    record.outputs.forEach((o) => lines.push(`### ${o.id}`, '```', String(o.output).slice(0, 3000), '```'));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

export const LESSONS_HEADER = `# Lessons the user taught

Rules here are read by every AI (editor chats, terminal CLIs, cloud sessions) and
injected into every harness worker prompt.
Add permanent rule (git-tracked):         node .harness/memory.mjs remember "..."
Save local/technical lesson (git-ignored): node .harness/memory.mjs learn "..."
Remove rule:                               node .harness/memory.mjs forget L3

`;

export const AUTO_LESSONS_HEADER = `# Lessons learned automatically (git-ignored)

Written by the harness controller (headless daemon and editor runs) on task failures,
retry recoveries, scope violations, or anti-cheat signals — or via  node .harness/memory.mjs learn "..." .
Most recent entries are injected into worker prompts and skimmed before starting work.
Promote a proven rule to shared lessons.md:  node .harness/memory.mjs promote L2

`;
