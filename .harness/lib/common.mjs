/**
 * .harness/lib/common.mjs
 * Shared helpers: paths, config, engine detection + flag probing, verify-command detection,
 * project file listing, and the Markdown memory store.
 * Zero dependencies — Node.js 18+ standard library only.
 */

import fs from 'node:fs';
import path from 'node:path';
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
  profile: path.join(HARNESS_DIR, 'memory', 'profile.md'),
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

/** Find an executable on PATH (cross-platform). Returns full path or null. */
export function which(binary) {
  if (!binary) return null;
  if (binary.includes('/') || binary.includes('\\')) return fs.existsSync(binary) ? binary : null;
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').concat([''])
    : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, binary + ext);
      try { if (fs.statSync(full).isFile()) return full; } catch { /* keep looking */ }
    }
  }
  return null;
}

/**
 * Quote one argument for a Windows shell command line (spawn with shell: true).
 * An empty string becomes "" so it is not dropped (e.g. a "-p" "" pair).
 */
export function winQuote(a) {
  const s = String(a);
  return s === '' || /[\s"&|<>^()]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
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
  const binPath = which(profile.binary);
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
  const isWin = process.platform === 'win32';
  const r = isWin
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
const TYPICAL_FILES = { BA_ANALYST: ['docs/spec.md'], QA_AUDITOR: ['test/feature.test.js'], DEV_ENGINEER: ['src/a.js', 'src/b.js'], PO_ARCHITECT: ['docs/plan.md'] };
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
  const highModels = Object.values(config?.profiles || {}).map((p) => p?.models?.high).filter(Boolean).map((s) => String(s).toLowerCase());
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

/**
 * Pick the strongest deterministic check from package.json scripts:
 *   "check" (usually an aggregate)  >  "typecheck" + "test"  >  "build"  >  "lint"
 * Falls back to config.defaultVerifyCmd (always passes) with real=false.
 */
export function detectVerifyCmd(root, config) {
  const pkg = readJsonSafe(path.join(root, 'package.json'), null);
  const scripts = pkg?.scripts || {};
  const has = (n) => typeof scripts[n] === 'string' && scripts[n].trim() && !/no test specified/.test(scripts[n]);
  const exists = (f) => fs.existsSync(path.join(root, f));
  const pm = exists('pnpm-lock.yaml') ? 'pnpm' : exists('yarn.lock') ? 'yarn' : (exists('bun.lockb') || exists('bun.lock')) ? 'bun' : 'npm';
  const run = (n) => (n === 'test' && pm !== 'bun' ? `${pm} test` : `${pm} run ${n}`);
  let chosen = has('check') ? ['check'] : ['typecheck', 'test'].filter(has);
  if (!chosen.length) chosen = ['build'].filter(has);
  if (!chosen.length) chosen = ['lint'].filter(has);
  if (chosen.length) return { cmd: chosen.map(run).join(' && '), source: `auto-detected from package.json scripts: ${chosen.join(' + ')}`, real: true };
  return { cmd: config.defaultVerifyCmd, source: 'default — NO real check (always passes)', real: false };
}

// ───────────────────────────── project file listing ─────────────────────────────

const SKIP_DIRS = new Set(['.git', '.harness', 'node_modules', 'dist', 'build', '.next', 'coverage', '.venv', 'venv', '__pycache__', 'target']);

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

/** Normalise a target path; returns null if it is unsafe (absolute, "..", root, .git, .harness). */
export function safeTarget(p) {
  const n = String(p || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!n || n === '.' || n === '/' || path.isAbsolute(n) || /^[a-zA-Z]:/.test(n)) return null;
  if (n.split('/').includes('..')) return null;
  if (/^(\.git|\.harness)(\/|$)/.test(n)) return null;
  return n;
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

const norm = (t) => String(t).toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();

export function remember(text, file = FILES.lessons) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('Nothing to remember (empty text).');
  ensureDirs();
  const existing = listLessons(file);
  const dup = existing.find((l) => norm(l.text) === norm(clean));
  if (dup) return { ...dup, duplicate: true };
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

/**
 * Build the memory block injected into worker prompts.
 *  - skip: ['profile','lessons'] when the engine already auto-loads them (e.g. CLAUDE.md @imports)
 *  - lesson lines are de-duplicated and capped at memory.maxLessonLines (default 50):
 *    taught rules first (newest kept if over the cap), then the most recent auto lessons.
 */
export function memoryContext(config, { skip = [] } = {}) {
  const mem = config.memory || {};
  if (mem.enabled === false) return '';
  const maxLines = mem.maxLessonLines ?? 50;
  const parts = [];

  if (!skip.includes('profile')) {
    const profile = readText(FILES.profile).split('\n').filter((l) => !/\(fill me/i.test(l)).join('\n').trim();
    if (profile && /^- .+:\s*\S/m.test(profile)) parts.push(`## User profile\n${profile}`);
  }

  const seen = new Set();
  const fresh = (l) => { const k = norm(l.text); if (seen.has(k)) return false; seen.add(k); return true; };
  const taught = listLessons(FILES.lessons).filter(fresh).slice(-maxLines); // dedupe even if skipped,
  const autoRoom = Math.max(0, Math.min(mem.maxAutoLessons ?? 10, maxLines - (skip.includes('lessons') ? 0 : taught.length)));
  const auto = listLessons(FILES.autoLessons).reverse().filter(fresh).slice(0, autoRoom).reverse(); // so auto never repeats a rule

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

Rules here are injected into every harness worker prompt and should be read by any
editor AI before it starts work. Add with:  node .harness/memory.mjs remember "..."
Remove with:  node .harness/memory.mjs forget L3

`;

export const AUTO_LESSONS_HEADER = `# Lessons learned automatically

Written by the harness when a task failed verification and then recovered, or halted.
Only the most recent entries are injected into prompts. Promote a good one to
lessons.md with  node .harness/memory.mjs remember "..."  and delete noise freely.
This file is git-ignored (it is about your machine's history, not the template).

`;
