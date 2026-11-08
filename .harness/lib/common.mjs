/**
 * .harness/lib/common.mjs
 * Shared helpers for the harness: paths, config, engine detection, memory store.
 * Zero dependencies — Node.js 18+ standard library only.
 */

import fs from 'node:fs';
import path from 'node:path';
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
  worktrees: path.join(HARNESS_DIR, 'worktrees'),
  memory: path.join(HARNESS_DIR, 'memory'),
  sessions: path.join(HARNESS_DIR, 'memory', 'sessions')
};
export const FILES = {
  config: path.join(HARNESS_DIR, 'config.json'),
  state: path.join(HARNESS_DIR, 'state.json'),
  log: path.join(HARNESS_DIR, 'telemetry.log'),
  pid: path.join(HARNESS_DIR, 'daemon.pid'),
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
 * Resolve which engine profile to use.
 * Order: explicit name -> HARNESS_AGENT env -> config.activeProfile.
 * "auto" picks the first engine in config.autoOrder that is installed on this machine.
 */
export function resolveProfile(config, requested) {
  let key = requested || process.env.HARNESS_AGENT || config.activeProfile || 'auto';
  key = String(key).toLowerCase();
  if (key === 'auto') {
    const order = config.autoOrder || Object.keys(config.profiles);
    key = order.find((k) => config.profiles[k] && which(config.profiles[k].binary)) || order[0];
  }
  const profile = config.profiles[key];
  if (!profile) {
    const known = Object.keys(config.profiles).join(', ');
    throw Object.assign(new Error(`Unknown engine '${key}'. Known engines: ${known}`), { fatal: true });
  }
  return { name: key, ...profile };
}

// ───────────────────────────── Memory store ─────────────────────────────
// Memory is plain Markdown so BOTH the harness and any editor AI can read/edit it.
//   profile.md       — who the user is and how they like to work (edited by hand or by AI)
//   lessons.md       — rules the user taught explicitly ("remember ...")  [highest priority]
//   auto-lessons.md  — things the harness learned automatically from failed/retried tasks
//   sessions/*.md    — one record per task the harness ran

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

export function remember(text, file = FILES.lessons) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('Nothing to remember (empty text).');
  ensureDirs();
  const existing = listLessons(file);
  const dup = existing.find((l) => l.text.toLowerCase() === clean.toLowerCase());
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
  const body = readText(file);
  const lines = body.split('\n');
  const kept = lines.filter((line) => !(line.match(LESSON_RE) || [])[1]?.match(new RegExp(`^${id}$`, 'i')));
  if (kept.length === lines.length) return false;
  fs.writeFileSync(file, kept.join('\n'));
  return true;
}

/** Build the memory block injected into every worker prompt (size-bounded). */
export function memoryContext(config) {
  const mem = config.memory || {};
  if (mem.enabled === false) return '';
  const max = mem.maxContextChars || 6000;
  const parts = [];
  const profile = readText(FILES.profile).trim();
  if (profile) parts.push(`## User profile\n${profile}`);
  const taught = listLessons(FILES.lessons);
  if (taught.length) parts.push(`## Rules the user taught (always follow)\n${taught.map((l) => `- ${l.text}`).join('\n')}`);
  const auto = listLessons(FILES.autoLessons).slice(-(mem.maxAutoLessons || 10));
  if (auto.length) parts.push(`## Lessons from earlier harness runs\n${auto.map((l) => `- ${l.text}`).join('\n')}`);
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
    `- Verify command: \`${record.verifyCmd}\``,
    `- Finished: ${record.finishedAt}`,
    '',
    '## What was asked',
    ...record.subtasks.map((s) => `- **${s.id}** (files: ${(s.targetFiles || []).join(', ') || 'unscoped'}): ${s.prompt || s.cliCommand || ''}`),
    ''
  ];
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

`;
