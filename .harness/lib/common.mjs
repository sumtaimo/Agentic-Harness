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
 * An empty string becomes "" so it is not dropped (e.g. gemini -p "").
 */
export function winQuote(a) {
  const s = String(a);
  return s === '' || /[\s"&|<>^()]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ───────────────────────────── engine flag probe ─────────────────────────────

/** Flags a profile relies on: every arg starting with "-" (placeholders excluded). */
export function profileFlags(profile) {
  const all = [...(profile.args || []), ...(profile.output?.batch || []), ...(profile.output?.stream || [])];
  return [...new Set(all.filter((a) => /^-[\w-]/.test(a) && a !== '--' && !a.includes('{')))];
}

/**
 * Run `<binary> [subcommand] --help` once and check every configured flag appears in the output.
 * Result is cached in .harness/engine-probe.json keyed by binary path + mtime + flags.
 *   { installed, checked, compatible, missing[], binPath, error? }
 * checked=false means help could not be read; that is treated as "unknown", not "incompatible".
 */
export function probeEngine(profile, { force = false } = {}) {
  const binPath = which(profile.binary);
  if (!binPath) return { installed: false, checked: false, compatible: false, missing: [], binPath: null };
  const flags = profileFlags(profile);
  if (flags.length === 0) return { installed: true, checked: false, compatible: true, missing: [], binPath };
  let mtime = 0;
  try { mtime = fs.statSync(binPath).mtimeMs; } catch { /* ignore */ }
  const key = `${binPath}|${mtime}|${flags.join(' ')}`;
  const cache = readJsonSafe(FILES.probe, {});
  if (!force && cache[key]) return cache[key];

  const first = (profile.args || [])[0];
  const sub = first && !first.startsWith('-') && !first.includes('{') ? [first] : [];
  const isWin = process.platform === 'win32';
  const r = spawnSync(binPath, [...sub, '--help'], { encoding: 'utf8', timeout: 15000, shell: isWin, env: { ...process.env, NO_COLOR: '1' } });
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
  const usable = (k) => {
    const p = config.profiles[k];
    if (!p) return { ok: false, why: 'unknown engine' };
    const probe = probeEngine(p);
    if (!probe.installed) return { ok: false, why: `'${p.binary}' is not installed` };
    if (!probe.compatible && !probe.checked) return { ok: false, why: `its flags could not be checked (${probe.error}) and the profile is not verified` };
    if (!probe.compatible) return { ok: false, why: `'${p.binary} --help' does not list ${probe.missing.join(', ')}` };
    return { ok: true, probe };
  };
  const auto = () => {
    for (const k of order) if (usable(k).ok) return k;
    return null;
  };

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
