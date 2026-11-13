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
 * - .claude/: slash commands copied if missing, settings.json merged (your rules stay, nothing is loosened).
 * - Your own charter, backlog, team, roles, skills and memory are never overwritten. Re-running is safe.
 * - Local runtime files (live feed, state, logs) are never copied from this template.
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
const RUNTIME = new Set(['state.json', 'telemetry.log', 'daemon.pid', 'engine-probe.json', 'auto-lessons.md', 'live.log', 'auto-state.json']);
// The target project's own data wins: memory, config, charter, backlog, roles, skills, team.
// A new project gets a blank profile, never the profile of whoever owns this template copy.
const PROFILE_TEMPLATE = `# User profile

This file tells every AI (the editor chat AND the harness workers) who you are and how you
like to work. Replace each "(fill me)". You can also just tell your editor AI:
"Read AGENTS.md and fill in my profile" — it will ask you a few questions and write this file.

- Name: (fill me)
- Role / what I do: (fill me)
- Coding experience: (fill me — e.g. "I don't code; explain everything in plain words")
- Language I want answers in: (fill me)
- What this project is: (fill me)
- How I like answers: (fill me — e.g. "short, step by step, one command at a time")
- Things the AI must always ask me before doing: (fill me — e.g. "deleting files, pushing to GitHub, paying for anything")
`;
// A new project starts with no taught rules, never the rules of whoever owns this template copy.
const LESSONS_TEMPLATE = `# Lessons the user taught

Rules here are injected into every harness worker prompt and should be read by any
editor AI before it starts work. Add with:  node .harness/memory.mjs remember "..."
Remove with:  node .harness/memory.mjs forget L3
`;
const OBJECTIVES_PLACEHOLDER = '- Project objectives: (describe your product goals here to customize for your own app)';
const KEEP_IF_PRESENT = /^\.harness[\\/](memory[\\/]|inbox[\\/]|completed[\\/]|failed[\\/]|roles[\\/]|skills[\\/]|config\.json$|charter\.md$|backlog\.json$|team\.json$)/;

function copyDir(from, to, rel = '.harness') {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const relPath = path.join(rel, entry.name);
    const s = path.join(from, entry.name); const d = path.join(to, entry.name);
    if (entry.isDirectory()) {
      if (['worktrees', 'staging', 'releases', 'visible'].includes(entry.name)) { fs.mkdirSync(d, { recursive: true }); continue; } // never copy history or open runs
      if (entry.name === 'sessions') { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, '.gitkeep'), ''); continue; }
      copyDir(s, d, relPath); continue;
    }
    if (RUNTIME.has(entry.name) || (/^(inbox|completed|failed)$/.test(path.basename(from)) && entry.name !== '.gitkeep')) continue;
    if (fs.existsSync(d) && KEEP_IF_PRESENT.test(relPath)) { report.push(`kept   ${relPath} (already existed)`); continue; }
    if (relPath === path.join('.harness', 'memory', 'lessons.md')) { // the template owner's taught rules never travel
      fs.writeFileSync(d, LESSONS_TEMPLATE);
      report.push(`wrote  ${relPath} (no rules yet)`); continue;
    }
    if (relPath === path.join('.harness', 'memory', 'profile.md')) { // the template owner's personal profile never travels
      fs.writeFileSync(d, PROFILE_TEMPLATE);
      report.push(`wrote  ${relPath} (blank profile to fill in)`); continue;
    }
    if (relPath === path.join('.harness', 'charter.md')) { // the template owner's project objectives never travel
      const text = fs.readFileSync(s, 'utf8').replace(/^- Project objectives:[\s\S]*?(?=\n\n|\n## |(?![\s\S]))/m, OBJECTIVES_PLACEHOLDER)
        .replace(/^- autonomous: off$/m, '- autonomous: on'); // template default (use --autonomous off to opt out)
      fs.writeFileSync(d, text);
      report.push(`wrote  ${relPath} (objectives left for you to fill in)`); continue;
    }
    if (relPath === path.join('.harness', 'config.json')) { // the owner's per-project auto-approve choice never travels
      let cfg = null; try { cfg = JSON.parse(fs.readFileSync(s, 'utf8')); } catch { /* broken source config: copy it unchanged */ }
      const g = cfg && cfg.profiles && cfg.profiles.gemini;
      if (g && Array.isArray(g.args)) {
        const i = g.args.indexOf('--approval-mode');
        if (i > -1 && g.args[i + 1] === 'yolo') g.args.splice(i, 2);
        g.note = "UNVERIFIED (confirm with 'gemini --help'). Headless: '-p' with the prompt piped on stdin. Auto-approve is OFF in a new project: Gemini will not run tools that need approval, so file edits are blocked. To allow it for THIS project only, add '--approval-mode', 'yolo' to args below (it approves every tool; use only in a project you trust).";
        fs.writeFileSync(d, JSON.stringify(cfg, null, 2) + '\n');
        report.push(`wrote  ${relPath} (Gemini auto-approve OFF for this project)`); continue;
      }
    }
    if (relPath === path.join('.harness', 'backlog.json')) { // the template's own tasks never travel: a new project starts with an empty backlog
      let src = {}; try { src = JSON.parse(fs.readFileSync(s, 'utf8')); } catch { /* broken source backlog: use defaults */ }
      fs.writeFileSync(d, JSON.stringify({ version: src.version || '2.0.0', project: '', maxAutoTasksPerRun: src.maxAutoTasksPerRun ?? 3, tasks: [] }, null, 2) + '\n');
      report.push(`wrote  ${relPath} (empty backlog)`); continue;
    }
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

// Claude Code project config: slash commands are copied if missing; settings.json is MERGED (union of
// permission rules, hook added once), never overwritten. A project's own rules and hooks stay.
{
  const srcClaude = path.join(SRC, '.claude');
  if (fs.existsSync(srcClaude)) {
    const walk = (dir, rel = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name), path.join(rel, e.name)) : [path.join(rel, e.name)]));
    for (const rel of walk(srcClaude).filter((f) => f !== 'settings.json' && !f.startsWith('settings.local'))) {
      const d = path.join(target, '.claude', rel);
      fs.mkdirSync(path.dirname(d), { recursive: true });
      if (fs.existsSync(d)) report.push(`kept   .claude/${rel} (already existed)`);
      else { fs.copyFileSync(path.join(srcClaude, rel), d); report.push(`wrote  .claude/${rel}`); }
    }
    const srcSet = JSON.parse(fs.readFileSync(path.join(srcClaude, 'settings.json'), 'utf8'));
    const setPath = path.join(target, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(setPath), { recursive: true });
    if (!fs.existsSync(setPath)) { fs.writeFileSync(setPath, JSON.stringify(srcSet, null, 2) + '\n'); report.push('wrote  .claude/settings.json'); }
    else {
      try {
        const mine = JSON.parse(fs.readFileSync(setPath, 'utf8'));
        mine.permissions = mine.permissions || {};
        for (const k of ['allow', 'ask', 'deny']) {
          // a rule the project already puts in a stricter list is not added to a looser one
          const stricter = { allow: ['ask', 'deny'], ask: ['deny'], deny: [] }[k];
          const have = new Set([...(mine.permissions[k] || [])]);
          for (const r of srcSet.permissions[k] || []) if (!stricter.some((o) => (mine.permissions[o] || []).includes(r))) have.add(r);
          mine.permissions[k] = [...have];
        }
        mine.hooks = mine.hooks || {};
        mine.hooks.SessionStart = mine.hooks.SessionStart || [];
        const cmd = (srcSet.hooks.SessionStart[0].hooks[0] || {}).command;
        const present = JSON.stringify(mine.hooks.SessionStart).includes('hook-session.mjs');
        if (!present) mine.hooks.SessionStart.push(srcSet.hooks.SessionStart[0]);
        fs.writeFileSync(setPath, JSON.stringify(mine, null, 2) + '\n');
        report.push(`merged harness rules${present ? '' : ' + SessionStart hook'} into existing .claude/settings.json`);
      } catch {
        fs.writeFileSync(path.join(target, '.claude', 'settings.harness.json'), JSON.stringify(srcSet, null, 2) + '\n');
        report.push('! .claude/settings.json is not valid JSON — wrote .claude/settings.harness.json; merge it by hand');
      }
    }
  }
}

const gi = path.join(target, '.gitignore');
const giBlock = fs.readFileSync(path.join(SRC, '.gitignore'), 'utf8');
const existing = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
if (!existing.includes('# agentic-harness runtime')) { fs.writeFileSync(gi, `${existing.replace(/\s*$/, '')}${existing ? '\n\n' : ''}${giBlock}`); report.push('updated .gitignore'); }

// Autonomous mode ships ON (it only acts on READY tasks you add, and plans new ones only once the charter objectives
// are filled in). `--autonomous off` writes a freshly installed charter with it switched off. A charter that already
// existed in the project is never touched.
const optI = process.argv.indexOf('--autonomous');
if (optI > -1) {
  const want = String(process.argv[optI + 1] || '').toLowerCase();
  if (!['on', 'off'].includes(want)) { console.error('--autonomous takes "on" or "off".'); process.exit(1); }
  const cp = path.join(target, '.harness', 'charter.md');
  if (want === 'off' && report.some((r) => r.startsWith('wrote  .harness/charter.md')) && fs.existsSync(cp)) {
    fs.writeFileSync(cp, fs.readFileSync(cp, 'utf8').replace(/^- autonomous: on$/m, '- autonomous: off'));
    report.push('set   autonomous mode OFF in the new .harness/charter.md');
  }
}

console.log(`Installed the agentic harness into ${target}\n`);
report.forEach((l) => console.log(`  ${l}`));
console.log(`
Done. Your project now has the agentic harness. The workflow:
  human -> controller (task, charter, backlog, team) -> orchestrator (your editor session) -> named agents -> verify -> report to you
Next steps:
  1. Check it:        node .harness/doctor.mjs        (needs Node 18+ and one AI engine, e.g. Claude Code, logged in)
  2. Fill the charter: describe your project goals in .harness/charter.md ("Project objectives"); see the team with  node .harness/team.mjs show
  3. Prompt it:
       in Claude Code:  open the folder, accept the trust dialog once, restart the session so it loads the agents, then type
                        /harness:run <what you want done>     (the named agents appear working in your session; you get a report)
                        /harness:auto                         (autonomous: works through the READY backlog by itself)
       in a terminal:   node .harness/daemon.mjs                  (leave it running; watch the agents work)
                        node .harness/dispatch.mjs --goal "<what you want>" --hierarchy --max-cost 2 --wait
  Autonomous mode is ON by default; it only acts on READY tasks you add. Turn it off: set "- autonomous: off" in .harness/charter.md
  (or install with  --autonomous off ). Every file above is plain text in your project; nothing is installed globally.`);
