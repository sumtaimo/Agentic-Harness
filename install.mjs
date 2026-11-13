#!/usr/bin/env node
/**
 * install.mjs — copy this harness into another project, without overwriting that project's files.
 *
 *   node install.mjs /path/to/your/project [--autonomous off]
 *   node install.mjs --reset [/path/to/your/project] [--autonomous off]   (clean a "Use this template" copy)
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
const ARGS = process.argv.slice(2);
const RESET = ARGS.includes('--reset');
const positional = ARGS.filter((a, i) => !a.startsWith('--') && ARGS[i - 1] !== '--autonomous');
const target = (positional[0] || (RESET ? '.' : '')) && path.resolve(positional[0] || '.');
if (!target) { console.error('Usage: node install.mjs /path/to/your/project [--autonomous off]\n       node install.mjs --reset [/path/to/your/project] [--autonomous off]'); process.exit(1); }
if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) { console.error(`Not a folder: ${target}`); process.exit(1); }
if (!RESET && path.resolve(target) === path.resolve(SRC)) { console.error('Target is this template itself. (To clear its owner settings, use --reset.)'); process.exit(1); }

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

// Clean defaults for a new project (used by a normal install and by --reset), so both follow the same rules.
const GEMINI_SAFE_NOTE = "UNVERIFIED (confirm with 'gemini --help'). Headless: '-p' with the prompt piped on stdin. Auto-approve is OFF in a new project: Gemini will not run tools that need approval, so file edits are blocked. To allow it for THIS project only, add '--approval-mode', 'yolo' to args below (it approves every tool; use only in a project you trust).";
function cleanCharter(text) {
  return text.replace(/^- Project objectives:[\s\S]*?(?=\n\n|\n## |(?![\s\S]))/m, OBJECTIVES_PLACEHOLDER)
    .replace(/^- autonomous: off$/m, '- autonomous: on'); // template default (use --autonomous off to opt out)
}
/** Returns the cleaned config text, or null if the config cannot be parsed or has no gemini profile. */
function cleanConfig(text) {
  let cfg = null; try { cfg = JSON.parse(text); } catch { return null; }
  const g = cfg && cfg.profiles && cfg.profiles.gemini;
  if (!g || !Array.isArray(g.args)) return null;
  const i = g.args.indexOf('--approval-mode');
  if (i > -1 && g.args[i + 1] === 'yolo') g.args.splice(i, 2);
  g.note = GEMINI_SAFE_NOTE;
  return JSON.stringify(cfg, null, 2) + '\n';
}
function cleanBacklog(text) {
  let src = {}; try { src = JSON.parse(text); } catch { /* broken backlog: use defaults */ }
  return JSON.stringify({ version: src.version || '2.0.0', project: '', maxAutoTasksPerRun: src.maxAutoTasksPerRun ?? 3, tasks: [] }, null, 2) + '\n';
}

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
      fs.writeFileSync(d, cleanCharter(fs.readFileSync(s, 'utf8')));
      report.push(`wrote  ${relPath} (objectives left for you to fill in)`); continue;
    }
    if (relPath === path.join('.harness', 'config.json')) { // the owner's per-project auto-approve choice never travels
      const cleaned = cleanConfig(fs.readFileSync(s, 'utf8')); // broken or unexpected config: copy it unchanged
      if (cleaned) {
        fs.writeFileSync(d, cleaned);
        report.push(`wrote  ${relPath} (Gemini auto-approve OFF for this project)`); continue;
      }
    }
    if (relPath === path.join('.harness', 'backlog.json')) { // the template's own tasks never travel: a new project starts with an empty backlog
      fs.writeFileSync(d, cleanBacklog(fs.readFileSync(s, 'utf8')));
      report.push(`wrote  ${relPath} (empty backlog)`); continue;
    }
    fs.copyFileSync(s, d);
    report.push(`wrote  ${relPath}`);
  }
}
// --reset: for a copy made with GitHub "Use this template" (or any project that has the harness), put the
// owner-specific files back to the clean defaults a new install gets. Nothing else is touched; git can undo it.
if (RESET) {
  const H = path.join(target, '.harness');
  if (!fs.existsSync(H)) { console.error(`No .harness/ folder in ${target}: nothing to reset. To install the harness, run without --reset.`); process.exit(1); }
  const off = (() => { const i = ARGS.indexOf('--autonomous'); return i > -1 && String(ARGS[i + 1]).toLowerCase() === 'off'; })();
  const steps = [
    ['memory/profile.md', () => PROFILE_TEMPLATE, 'blank profile to fill in'],
    ['memory/lessons.md', () => LESSONS_TEMPLATE, 'no taught rules'],
    ['charter.md', (t) => { const c = cleanCharter(t); return off ? c.replace(/^- autonomous: on$/m, '- autonomous: off') : c; }, `placeholder objectives, autonomous ${off ? 'off' : 'on'}`],
    ['config.json', (t) => cleanConfig(t), 'Gemini auto-approve off'],
    ['backlog.json', (t) => cleanBacklog(t), 'empty backlog'],
  ];
  const done = [];
  for (const [rel, make, what] of steps) {
    const f = path.join(H, rel);
    if (!fs.existsSync(f)) { console.log(`  skip   .harness/${rel} (not found)`); continue; }
    const before = fs.readFileSync(f, 'utf8');
    const after = make(before);
    if (after == null) { console.log(`  skip   .harness/${rel} (could not read it as expected; left unchanged)`); continue; }
    if (after === before) { console.log(`  ok     .harness/${rel} (already clean)`); continue; }
    fs.writeFileSync(f, after);
    console.log(`  reset  .harness/${rel} (${what})`); done.push(`.harness/${rel}`);
  }
  console.log(done.length
    ? `\nReset ${done.length} file(s) in ${target}. Undo (if this folder is in git): git checkout -- ${done.join(' ')}\nNext: fill in .harness/memory/profile.md and the "Project objectives" in .harness/charter.md, then run: node .harness/doctor.mjs`
    : `\nNothing to reset in ${target}: it already has the clean defaults.`);
  process.exit(0);
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
// npm leaves .gitignore out of packages (npx installs), so fall back to this copy. A test keeps it equal to .gitignore.
const GITIGNORE_BLOCK = "# agentic-harness runtime (machine-specific or personal; never commit to a public template)\n.harness/state.json\n.harness/*.tmp\n.harness/telemetry.log\n.harness/daemon.pid\n.harness/engine-probe.json\n.harness/auto-state.json\n.harness/live.log\n.harness/inbox/*\n.harness/completed/*\n.harness/failed/*\n.harness/staging/*\n.harness/releases/*\n.harness/visible/*\n.harness/worktrees/*\n.harness/memory/sessions/*\n.harness/memory/auto-lessons.md\n# The folder/* form (instead of folder/) keeps each folder's .gitkeep, so the folders exist in the template.\n!.harness/**/.gitkeep\n\n# charter.md, backlog.json, roles/ and skills/ ARE committed (they define the project's governance).\n# profile.md and lessons.md ARE committed (the template ships generic starter versions).\n# In your own PUBLIC project, if they hold personal details, uncomment these two lines:\n# .harness/memory/profile.md\n# .harness/memory/lessons.md\n\n# Personal Claude Code overrides (never commit)\n.claude/settings.local.json\n\n# A demo project created by `npm run demo` (examples/make-demo.mjs) lives next to the template, not in it\n/demo-project/\n\n# Per-person state and secrets (never commit)\n.agent-state/\n.env\n.env.*\n!.env.example\n";
const giSrc = path.join(SRC, '.gitignore');
const giBlock = fs.existsSync(giSrc) ? fs.readFileSync(giSrc, 'utf8') : GITIGNORE_BLOCK;
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
  if (want === 'off' && report.some((r) => r.replaceAll('\\', '/').startsWith('wrote  .harness/charter.md')) && fs.existsSync(cp)) {
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
