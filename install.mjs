#!/usr/bin/env node
/**
 * install.mjs — copy this harness into another project, without overwriting that project's files.
 *
 *   node install.mjs /path/to/your/project
 *
 * - .harness/ is copied (your existing memory, inbox and logs are kept if already there).
 * - AGENTS.md / CLAUDE.md / GEMINI.md / copilot / cursor / windsurf files: created if missing;
 *   if they exist, a short "harness" section is appended once (never replaced).
 * - .vscode/tasks.json: created if missing; if it exists, the Harness tasks are merged in
 *   (if it cannot be parsed, e.g. it has comments, they go to .vscode/tasks.harness.json instead).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] && path.resolve(process.argv[2]);
if (!target) { console.error('Usage: node install.mjs /path/to/your/project'); process.exit(1); }
if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) { console.error(`Not a folder: ${target}`); process.exit(1); }
if (path.resolve(target) === path.resolve(SRC)) { console.error('Target is this template itself.'); process.exit(1); }

const report = [];
// Runtime + personal history never travels to another project.
const RUNTIME = new Set(['state.json', 'telemetry.log', 'daemon.pid', 'engine-probe.json', 'auto-lessons.md']);
const KEEP_IF_PRESENT = /^\.harness[\\/](memory[\\/]|inbox[\\/]|completed[\\/]|failed[\\/]|config\.json$)/;

function copyDir(from, to, rel = '.harness') {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const relPath = path.join(rel, entry.name);
    const s = path.join(from, entry.name); const d = path.join(to, entry.name);
    if (entry.isDirectory()) {
      if (['worktrees', 'staging'].includes(entry.name)) { fs.mkdirSync(d, { recursive: true }); continue; }
      if (entry.name === 'sessions') { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, '.gitkeep'), ''); continue; }
      copyDir(s, d, relPath); continue;
    }
    if (RUNTIME.has(entry.name) || (/^(inbox|completed|failed)$/.test(path.basename(from)) && entry.name !== '.gitkeep')) continue;
    if (fs.existsSync(d) && KEEP_IF_PRESENT.test(relPath)) { report.push(`kept   ${relPath} (already existed)`); continue; }
    fs.copyFileSync(s, d);
    report.push(`wrote  ${relPath}`);
  }
}
copyDir(path.join(SRC, '.harness'), path.join(target, '.harness'));

const MARK = '<!-- agentic-harness -->';
const POINTER = `${MARK}\n## Agentic harness\n\nThis project has an agentic harness in \`.harness/\`. Read and follow \`AGENTS.md\` (section "Agentic harness" or the whole file) and the user's memory in \`.harness/memory/profile.md\` and \`.harness/memory/lessons.md\` before working. Save user corrections/preferences with \`node .harness/memory.mjs remember "<rule>"\`.\n`;

for (const rel of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.github/copilot-instructions.md', '.cursor/rules/harness.mdc', '.windsurfrules']) {
  const d = path.join(target, rel); const s = path.join(SRC, rel);
  fs.mkdirSync(path.dirname(d), { recursive: true });
  if (!fs.existsSync(d)) { fs.copyFileSync(s, d); report.push(`wrote  ${rel}`); continue; }
  const body = fs.readFileSync(d, 'utf8');
  if (body.includes(MARK)) { report.push(`kept   ${rel} (harness section already present)`); continue; }
  // Their AGENTS.md exists: append the full harness instructions; others just get the pointer.
  const add = rel === 'AGENTS.md' ? `${MARK}\n${fs.readFileSync(s, 'utf8').replace(/^# .*\n/, '# Agentic harness\n')}` : POINTER;
  fs.writeFileSync(d, `${body.replace(/\s*$/, '')}\n\n${add}`);
  report.push(`added  harness section to existing ${rel}`);
}

const srcTasks = JSON.parse(fs.readFileSync(path.join(SRC, '.vscode', 'tasks.json'), 'utf8'));
const tasksPath = path.join(target, '.vscode', 'tasks.json');
fs.mkdirSync(path.dirname(tasksPath), { recursive: true });
if (!fs.existsSync(tasksPath)) { fs.writeFileSync(tasksPath, JSON.stringify(srcTasks, null, 2)); report.push('wrote  .vscode/tasks.json'); }
else {
  try {
    const theirs = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
    theirs.tasks = [...(theirs.tasks || []).filter((t) => !String(t.label).startsWith('Harness:')), ...srcTasks.tasks];
    const ids = new Set(srcTasks.inputs.map((i) => i.id));
    theirs.inputs = [...(theirs.inputs || []).filter((i) => !ids.has(i.id)), ...srcTasks.inputs];
    fs.writeFileSync(tasksPath, JSON.stringify(theirs, null, 2));
    report.push('merged Harness tasks into existing .vscode/tasks.json');
  } catch {
    fs.writeFileSync(path.join(target, '.vscode', 'tasks.harness.json'), JSON.stringify(srcTasks, null, 2));
    report.push('! .vscode/tasks.json has comments or is invalid JSON — wrote .vscode/tasks.harness.json; copy its tasks in by hand');
  }
}

const gi = path.join(target, '.gitignore');
const giBlock = fs.readFileSync(path.join(SRC, '.gitignore'), 'utf8');
const existing = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
if (!existing.includes('# agentic-harness runtime')) { fs.writeFileSync(gi, `${existing.replace(/\s*$/, '')}${existing ? '\n\n' : ''}${giBlock}`); report.push('updated .gitignore'); }

console.log(`Installed the agentic harness into ${target}\n`);
report.forEach((l) => console.log(`  ${l}`));
console.log(`\nNext: open that folder in your editor, then run task "Harness: Doctor (check my setup)".`);
