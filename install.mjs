#!/usr/bin/env node
/**
 * install.mjs — copy this harness into another project, without overwriting that project's files.
 *
 *   node install.mjs /path/to/your/project [--autonomous off] [--no-auto-assign] [--no-adapt-scopes] [--with-skills | --no-skills]
 *     default: once, also installs Skill Foundry's default skills (it decides the set); --with-skills all of them; --no-skills none; skipped with HARNESS_OFFLINE=1
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
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const ARGS = process.argv.slice(2);
const RESET = ARGS.includes('--reset');
const positional = ARGS.filter((a, i) => !a.startsWith('--') && ARGS[i - 1] !== '--autonomous');
const target = (positional[0] || (RESET ? '.' : '')) && path.resolve(positional[0] || '.');
if (!target) { console.error('Usage: node install.mjs /path/to/your/project [--autonomous off]\n       node install.mjs --reset [/path/to/your/project] [--autonomous off]'); process.exit(1); }
if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) { console.error(`Not a folder: ${target}`); process.exit(1); }
if (!RESET && path.resolve(target) === path.resolve(SRC)) { console.error('Target is this template itself. (To clear its owner settings, use --reset.)'); process.exit(1); }
// Any copy of the template (a clone, a worktree, the lab) is never a target either, whichever installer copy runs
// (e.g. the one npx downloads): installing there would add a project's MANIFEST, deny rules and pointer sections to
// the template's own files.
{
  const isTemplateCopy = fs.existsSync(path.join(target, 'install.mjs')) && fs.existsSync(path.join(target, 'docs', 'MAINTAINING.md'))
    && /"name":\s*"agentic-harness"/.test((() => { try { return fs.readFileSync(path.join(target, 'package.json'), 'utf8'); } catch { return ''; } })());
  if (!RESET && isTemplateCopy) { console.error(`Target is a copy of the harness template (${target}), not a project. Nothing was installed. (To clear owner settings in a template copy, use --reset.)`); process.exit(1); }
}

const report = [];
// Runtime + personal history never travels to another project.
// approvals.json is per person (which AI tools THEY allowed): copying it would silently allow the template owner's tools.
// MANIFEST.json is written fresh for each install below.
const RUNTIME = new Set(['state.json', 'telemetry.log', 'daemon.pid', 'engine-probe.json', 'auto-lessons.md', 'live.log', 'auto-state.json', 'approvals.json', 'MANIFEST.json']);
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

Rules here are read by every AI (editor chats, terminal CLIs, cloud sessions) and
injected into every harness worker prompt.
Add permanent rule (git-tracked):         node .harness/memory.mjs remember "..."
Save local/technical lesson (git-ignored): node .harness/memory.mjs learn "..."
Remove rule:                               node .harness/memory.mjs forget L3
`;
const OBJECTIVES_PLACEHOLDER = '- Project objectives: (describe your product goals here to customize for your own app)';
const KEEP_IF_PRESENT = /^\.harness[\\/](memory[\\/]|inbox[\\/]|completed[\\/]|failed[\\/]|roles[\\/]|skills[\\/]|config\.json$|charter\.md$|backlog\.json$|team\.json$)/;

// Clean defaults for a new project (used by a normal install and by --reset), so both follow the same rules.
const REMOVED_PROFILES = ['gemini', 'orca']; // engines the harness no longer supports (see docs/ENGINES.md)
function cleanCharter(text) {
  return text.replace(/^- Project objectives:[\s\S]*?(?=\n\n|\n## |(?![\s\S]))/m, OBJECTIVES_PLACEHOLDER)
    .replace(/^- autonomous: off$/m, '- autonomous: on'); // template default (use --autonomous off to opt out)
}
/** Returns the config text without removed engines (profiles and autoOrder), or null if it cannot be parsed or has no profiles. */
function cleanConfig(text) {
  let cfg = null; try { cfg = JSON.parse(text); } catch { return null; }
  if (!cfg || !cfg.profiles || typeof cfg.profiles !== 'object') return null;
  for (const k of REMOVED_PROFILES) delete cfg.profiles[k];
  if (Array.isArray(cfg.autoOrder)) cfg.autoOrder = cfg.autoOrder.filter((k) => !REMOVED_PROFILES.includes(k));
  if (REMOVED_PROFILES.includes(String(cfg.activeProfile).toLowerCase())) cfg.activeProfile = 'auto';
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
    if (relPath === path.join('.harness', 'config.json')) { // removed engines never travel
      const cleaned = cleanConfig(fs.readFileSync(s, 'utf8')); // broken or unexpected config: copy it unchanged
      if (cleaned) {
        fs.writeFileSync(d, cleaned);
        report.push(`wrote  ${relPath}`); continue;
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
    ['config.json', (t) => cleanConfig(t), 'removed engines (gemini, orca) dropped'],
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

// Fingerprint of the harness core code, so doctor can tell when a project (or an AI in it) edited the template's files.
const { hashCore, winCommandLine } = await import(pathToFileURL(path.join(target, '.harness', 'lib', 'common.mjs')).href);
{
  const version = (() => { try { return JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8')).version; } catch { return null; } })();
  // installing the same version again must change nothing: keep the first installedAt while version and fingerprints are identical
  const files = hashCore(target);
  const before = (() => { try { return JSON.parse(fs.readFileSync(path.join(target, '.harness', 'MANIFEST.json'), 'utf8')); } catch { return null; } })();
  const same = before && before.template === 'agentic-harness' && before.version === version && JSON.stringify(before.files) === JSON.stringify(files) && typeof before.installedAt === 'string';
  fs.writeFileSync(path.join(target, '.harness', 'MANIFEST.json'), `${JSON.stringify({ template: 'agentic-harness', version, installedAt: same ? before.installedAt : new Date().toISOString(), note: 'Fingerprints of the harness core code from the template. Do not edit: doctor compares them; re-install to update.', files }, null, 2)}
`);
  report.push('wrote  .harness/MANIFEST.json (fingerprints of the harness core)');
}

const MARK = '<!-- agentic-harness -->';
const POINTER = `${MARK}\n## Agentic harness\n\nThis project has an agentic harness in \`.harness/\`. Read and follow \`AGENTS.md\` (section "Agentic harness" or the whole file) and the user's memory in \`.harness/memory/profile.md\`, \`.harness/memory/lessons.md\`, and \`.harness/memory/auto-lessons.md\` (or \`node .harness/memory.mjs context --goal "..." --files "..."\`) before working. Save permanent user rules with \`node .harness/memory.mjs remember "<rule>"\` and local technical pitfalls with \`node .harness/memory.mjs learn "<lesson>"\`. Never edit the harness core (\`.harness/*.mjs\`, \`.harness/lib/**\`): it comes from the template; report harness bugs instead of patching them here.\n`;
const OLD_POINTER_RE = /<!-- agentic-harness -->\r?\n## Agentic harness\r?\n+This project has an agentic harness in `\.harness\/`\.[^\n]*report harness bugs instead of patching them here\.\r?\n?/;
const LEGACY_STOCK_POINTERS = {
  'CLAUDE.md': '# CLAUDE.md\n\nAll instructions for this project live in AGENTS.md. The imports below load it and the\nuser\'s memory into every Claude Code session automatically.\n\n@AGENTS.md\n@.harness/memory/profile.md\n@.harness/memory/lessons.md',
  'GEMINI.md': '# GEMINI.md (Antigravity)\n\nRead and follow `AGENTS.md` in this folder before doing anything — it explains the\n`.harness/` agentic harness and the user\'s memory in `.harness/memory/`.\n\n@AGENTS.md\n@.harness/memory/profile.md\n@.harness/memory/lessons.md',
  '.github/copilot-instructions.md': '# Copilot instructions\n\nBefore answering, read and follow `AGENTS.md` at the repository root. It explains the\n`.harness/` agentic harness and requires you to read the user\'s memory first:\n`.harness/memory/profile.md` and `.harness/memory/lessons.md`. When the user corrects you or\nstates a preference, save it with `node .harness/memory.mjs remember "<rule>"`.',
  '.cursor/rules/harness.mdc': '---\ndescription: Agentic harness + user memory — read AGENTS.md first\nalwaysApply: true\n---\n\nBefore answering, read and follow `AGENTS.md` at the project root. It explains the\n`.harness/` agentic harness and requires you to read the user\'s memory first:\n`.harness/memory/profile.md` and `.harness/memory/lessons.md`. When the user corrects you or\nstates a preference, save it with `node .harness/memory.mjs remember "<rule>"`.',
  '.windsurfrules': 'Before answering, read and follow `AGENTS.md` at the project root. It explains the\n`.harness/` agentic harness and requires you to read the user\'s memory first:\n`.harness/memory/profile.md` and `.harness/memory/lessons.md`. When the user corrects you or\nstates a preference, save it with `node .harness/memory.mjs remember "<rule>"`.'
};

for (const rel of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.github/copilot-instructions.md', '.cursor/rules/harness.mdc', '.windsurfrules']) {
  const d = path.join(target, rel); const s = path.join(SRC, rel);
  fs.mkdirSync(path.dirname(d), { recursive: true });
  if (!fs.existsSync(d)) { fs.copyFileSync(s, d); report.push(`wrote  ${rel}`); continue; }
  const body = fs.readFileSync(d, 'utf8');
  if (body.includes(MARK)) {
    if (rel !== 'AGENTS.md' && !body.includes('auto-lessons.md') && OLD_POINTER_RE.test(body)) {
      fs.writeFileSync(d, body.replace(OLD_POINTER_RE, POINTER));
      report.push(`updated harness pointer in ${rel}`);
    } else {
      report.push(`kept   ${rel} (harness section already present)`);
    }
    continue;
  }
  if (rel !== 'AGENTS.md' && LEGACY_STOCK_POINTERS[rel] && body.replace(/\r\n/g, '\n').trim() === LEGACY_STOCK_POINTERS[rel]) {
    fs.copyFileSync(s, d);
    report.push(`updated ${rel} (cross-tool rule parity)`);
    continue;
  }
  // Copies written by an earlier install (the template's own files carry no marker) or by a release before the marker
  // existed: they already hold the harness instructions, so appending again would duplicate them.
  const legacy = rel === 'AGENTS.md'
    ? /This project contains an \*\*Agentic Harness\*\*|^# Agentic harness\s*$/m.test(body)
    : /\.harness\/memory\/profile\.md/.test(body) && /agentic harness|AGENTS\.md/i.test(body);
  if (legacy) { report.push(`kept   ${rel} (harness instructions already present)`); continue; }
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
        for (const entry of mine.hooks.SessionStart) {
          for (const h of entry?.hooks || []) {
            if (typeof h?.command === 'string' && h.command.includes('$CLAUDE_PROJECT_DIR/.harness/hook-session.mjs')) h.command = cmd;
          }
        }
        const present = JSON.stringify(mine.hooks.SessionStart).includes('hook-session.mjs');
        if (!present) mine.hooks.SessionStart.push(srcSet.hooks.SessionStart[0]);
        // PreToolUse guard (hook-guard.mjs): added once; a project's own PreToolUse hooks stay
        mine.hooks.PreToolUse = mine.hooks.PreToolUse || [];
        const guardPresent = JSON.stringify(mine.hooks.PreToolUse).includes('hook-guard.mjs');
        if (!guardPresent && srcSet.hooks.PreToolUse?.[0]) mine.hooks.PreToolUse.push(srcSet.hooks.PreToolUse[0]);
        fs.writeFileSync(setPath, JSON.stringify(mine, null, 2) + '\n');
        report.push(`merged harness rules${present ? '' : ' + SessionStart hook'}${guardPresent ? '' : ' + PreToolUse guard'} into existing .claude/settings.json`);
      } catch {
        fs.writeFileSync(path.join(target, '.claude', 'settings.harness.json'), JSON.stringify(srcSet, null, 2) + '\n');
        report.push('! .claude/settings.json is not valid JSON — wrote .claude/settings.harness.json; merge it by hand');
      }
    }
  }
}

// In a PROJECT the harness core is read-only for Claude Code (people and agents use the harness, they do not edit it;
// a fix belongs in the template). The template repository itself has no such rule, so maintainers can work on it.
{
  const setPath = path.join(target, '.claude', 'settings.json');
  // Only Edit(path) rules exist for files: Claude Code applies them to every file-editing tool (Edit, Write, ...). A Write(path) rule is reported as invalid.
  const CORE_DENY = ['Edit(.harness/*.mjs)', 'Edit(.harness/lib/**)', 'Edit(.harness/MANIFEST.json)'];
  try {
    const s = JSON.parse(fs.readFileSync(setPath, 'utf8'));
    s.permissions = s.permissions || {};
    // Releases 1.0.1-1.0.3 also wrote invalid Write(.harness/...) rules (Claude Code reports them): remove those when re-installing.
    const OLD_INVALID = ['Write(.harness/*.mjs)', 'Write(.harness/lib/**)', 'Write(.harness/MANIFEST.json)'];
    const deny = new Set((s.permissions.deny || []).filter((r) => !OLD_INVALID.includes(r)));
    const removed = (s.permissions.deny || []).length - deny.size;
    const before = deny.size; CORE_DENY.forEach((r) => deny.add(r));
    if (deny.size !== before || removed) { s.permissions.deny = [...deny]; fs.writeFileSync(setPath, JSON.stringify(s, null, 2) + '\n'); report.push('added  .claude/settings.json deny rules: the harness core is read-only in this project'); }
  } catch { /* no or invalid settings.json: reported above */ }
}

const gi = path.join(target, '.gitignore');
// npm leaves .gitignore out of packages (npx installs), so fall back to this copy. A test keeps it equal to .gitignore.
const GITIGNORE_BLOCK = "# agentic-harness runtime (machine-specific or personal; never commit to a public template)\n.harness/state.json\n.harness/*.tmp\n.harness/telemetry.log\n.harness/daemon.pid\n.harness/engine-probe.json\n.harness/foundry-check.json\n.harness/auto-state.json\n.harness/approvals.json\n.harness/live.log\n.harness/inbox/*\n.harness/completed/*\n.harness/failed/*\n.harness/staging/*\n.harness/releases/*\n.harness/visible/*\n.harness/worktrees/*\n.harness/memory/sessions/*\n.harness/memory/auto-lessons.md\n# The folder/* form (instead of folder/) keeps each folder's .gitkeep, so the folders exist in the template.\n!.harness/**/.gitkeep\n\n# charter.md, backlog.json, roles/ and skills/ ARE committed (they define the project's governance).\n# profile.md and lessons.md ARE committed (the template ships generic starter versions).\n# In your own PUBLIC project, if they hold personal details, uncomment these two lines:\n# .harness/memory/profile.md\n# .harness/memory/lessons.md\n\n# Personal Claude Code overrides (never commit)\n.claude/settings.local.json\n# Personal profile and rules for this checkout (Claude Code loads it automatically)\nCLAUDE.local.md\n\n# A demo project created by `npm run demo` (examples/make-demo.mjs) lives next to the template, not in it\n/demo-project/\n\n# Per-person state and secrets (never commit)\n.agent-state/\n.env\n.env.*\n!.env.example\n";
const giSrc = path.join(SRC, '.gitignore');
const giBlock = fs.existsSync(giSrc) ? fs.readFileSync(giSrc, 'utf8') : GITIGNORE_BLOCK;
const existing = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
if (!existing.includes('# agentic-harness runtime')) { fs.writeFileSync(gi, `${existing.replace(/\s*$/, '')}${existing ? '\n\n' : ''}${giBlock}`); report.push('updated .gitignore'); }

// Line endings: the harness parses its own files (charter.md, team.json, slash commands…) with LF-based rules. On Windows
// with core.autocrlf=true a teammate's clone would get CRLF and those rules could misread them, so pin LF for the files
// the harness owns. Only these paths: the project's own code keeps whatever line endings it already uses.
const GA_MARK = '# agentic-harness: keep its files LF on every OS';
const GA_BLOCK = `${GA_MARK} (its scripts parse them; CRLF from core.autocrlf would break that)\n.harness/** text eol=lf\n.claude/** text eol=lf\nAGENTS.md text eol=lf\nCLAUDE.md text eol=lf\nGEMINI.md text eol=lf\n`;
{
  const ga = path.join(target, '.gitattributes');
  const have = fs.existsSync(ga) ? fs.readFileSync(ga, 'utf8') : '';
  if (!have.includes(GA_MARK)) {
    fs.writeFileSync(ga, `${have.replace(/\s*$/, '')}${have ? '\n\n' : ''}${GA_BLOCK}`);
    report.push(have ? 'added  harness line-ending rules to existing .gitattributes' : 'wrote  .gitattributes (LF for the harness files)');
  }
}

// Smart engine routing: a freshly installed team.json gets each role routed to an AI CLI that is actually usable on
// this machine (team.mjs auto-assign). A team.json the project already had is never touched. --no-auto-assign skips it.
if (!ARGS.includes('--no-auto-assign') && report.some((r) => r.replaceAll('\\', '/').startsWith('wrote  .harness/team.json'))) {
  const r = spawnSync(process.execPath, [path.join(target, '.harness', 'team.mjs'), 'auto-assign'], { cwd: target, encoding: 'utf8', env: { ...process.env, HARNESS_ROOT: target } });
  const found = /Usable AI engines on this machine: (.*)/.exec(r.stdout || '');
  const routed = r.status === 0 && /Wrote the "engine"/.test(r.stdout || '');
  report.push(routed
    ? `routed team roles to your engines (${found ? found[1] : '?'}); see them with  node .harness/team.mjs show`
    : `! no AI engine allowed yet${found ? ` (${found[1]})` : ''}: team members use "auto". Log in to one, allow it with  node .harness/engines.mjs  then run  node .harness/team.mjs auto-assign`);
}

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

// Adaptive project layout scopes: for newly written .harness/team.json or .harness/charter.md, widen scopes additively
// to cover non-template project folders (app/, components/, styles/, cmd/, e2e/, etc.) and Go/Python test conventions.
// Existing team.json, charter.md, roles/*.json, or custom .claude/agents/*.md in the project are never modified.
if (!ARGS.includes('--no-adapt-scopes')) {
  const wroteFile = (rel) => report.some((r) => r.replaceAll('\\', '/').startsWith(`wrote  ${rel}`));
  const allowTeam = wroteFile('.harness/team.json');
  const allowCharter = wroteFile('.harness/charter.md');
  if (allowTeam || allowCharter) {
    const { applyAdaptedScopes } = await import(pathToFileURL(path.join(target, '.harness', 'lib', 'governance.mjs')).href);
    const allowSyncAgents = !report.some((r) => /^kept +\.claude\/agents\//.test(r.replaceAll('\\', '/')));
    const res = applyAdaptedScopes(target, {
      allowTeam,
      allowCharter,
      allowRoles: {
        UX_DESIGNER: wroteFile('.harness/roles/ux-designer.json'),
        QA_AUDITOR: wroteFile('.harness/roles/qa-auditor.json'),
        BA_ANALYST: wroteFile('.harness/roles/ba-analyst.json')
      },
      allowSyncAgents
    });
    if (res.applied) {
      const sig = [...res.layout.extraCodeDirs, ...res.layout.extraStyleDirs, ...res.layout.extraTestDirs, ...res.layout.extraDocDirs].slice(0, 6).join(', ');
      report.push(`adapted scopes in ${res.writtenFiles.join(', ')} for detected project layout (${sig || 'Go/Python test files'})`);
    }
  }
}

// Skill Foundry (github:sumtaimo/Skill-Foundry), owner decisions:
//  - every NEW install gets Skill Foundry's DEFAULT skills (`add --default`: Skill Foundry decides the set). A Skill Foundry that
//    does not know `--default` yet answers with its usage line and we install FALLBACK_SKILLS (one fitting script-free skill per
//    role) instead. --with-skills installs all of them, --no-skills none; anyone who wants more uses Skill Foundry's own npx.
//  - the default is installed ONCE: .harness/foundry-default.json remembers it, so a skill the user removed on purpose is never
//    put back by a later install (and a project that already had Skill Foundry skills counts as done).
//  - skills that are installed but not wired to the harness yet (Skill Foundry installed first) are wired with
//    `update <those names> --quiet`, which keeps the user's own edits.
//  It never fails the install (offline, no npx, network error). HARNESS_OFFLINE=1 skips the network (tests set it);
//  HARNESS_FOUNDRY_CMD=<script.mjs> runs a local foundry CLI instead of npx (offline tests, forks).
const FOUNDRY = 'npx github:sumtaimo/Skill-Foundry';
const FALLBACK_SKILLS = ['spec-writer', 'copy-tight', 'test-planner', 'changelog-writer', 'ux-review'];
{
  const all = ARGS.includes('--with-skills');
  const local = process.env.HARNESS_FOUNDRY_CMD;
  const mark = path.join(target, '.harness', 'foundry-default.json');
  const csk = path.join(target, '.claude', 'skills');
  const stamped = () => (fs.existsSync(csk) ? fs.readdirSync(csk).filter((n) => fs.existsSync(path.join(csk, n, '.foundry.json'))) : []);
  const remember = () => { try { fs.writeFileSync(mark, `${JSON.stringify({ note: 'The Skill Foundry default skills were set up once for this project; a skill you remove stays removed. To get the defaults again: npx github:sumtaimo/Skill-Foundry add --default', at: new Date().toISOString().slice(0, 10) }, null, 2)}\n`); } catch { /* read-only: asked again next time */ } };
  const network = !ARGS.includes('--no-skills') && (local || process.env.HARNESS_OFFLINE !== '1');
  const win = process.platform === 'win32';
  const go = (what) => {
    if (local) return spawnSync(process.execPath, [path.resolve(local), ...what], { cwd: target, encoding: 'utf8', timeout: 180000 });
    const npxArgs = ['--yes', 'github:sumtaimo/Skill-Foundry', ...what];
    return win
      ? spawnSync(winCommandLine('npx.cmd', npxArgs), { cwd: target, encoding: 'utf8', timeout: 180000, shell: true })
      : spawnSync('npx', npxArgs, { cwd: target, encoding: 'utf8', timeout: 180000 });
  };
  const why = (r) => (r.error?.message || r.stderr || `exit ${r.status}`).trim().split('\n').pop();
  const hadSkills = stamped().length > 0;
  if (!ARGS.includes('--no-skills') && !all && !fs.existsSync(mark) && hadSkills) remember(); // the project chose its own skills
  else if (network && (all || !fs.existsSync(mark))) {
    let r = go(all ? ['add', '--all', '--quiet'] : ['add', '--default', '--quiet']);
    let how = all ? 'all Skill Foundry skills' : 'the default Skill Foundry skills';
    if (!all && r.status !== 0 && /usage:/i.test(`${r.stderr}${r.stdout}`)) { r = go(['add', ...FALLBACK_SKILLS, '--quiet']); how = `skills ${FALLBACK_SKILLS.join(', ')}`; }
    if (r.status === 0) { report.push(`added  ${how} (.claude/skills/ + .harness/skills/ pointers)`); remember(); }
    else report.push(`! Skill Foundry skill not installed (${why(r)}); the harness itself is installed`);
  }
  // Skill Foundry installed before the harness: its skills have no harness pointers yet, so workers do not get them.
  // A skill is wired when .harness/skills/<name>/SKILL.md exists AND is not the harness's own starter stub (Skill Foundry replaces
  // a starter stub and keeps the original as SKILL.md.orig; a skill of the user's own with that name is never touched).
  const STUB_SHA = new Set(['7fb11973a154c1caa78e5451d023eeb203a62208d6c0066a22d8195319546ebd', 'f14d673bad4efe2ef816f55dd6f894a06603d7805eeec73dde88aa902ff6ca21']);
  const isStub = (f) => { try { const t = fs.readFileSync(f, 'utf8'); return t.includes('starter-stub: agentic-harness') || STUB_SHA.has(crypto.createHash('sha256').update(t.replace(/\r\n?/g, '\n').trim()).digest('hex')); } catch { return false; } };
  const unwired = () => stamped().filter((n) => { const f = path.join(target, '.harness', 'skills', n, 'SKILL.md'); return !fs.existsSync(f) || isStub(f); });
  const pending = unwired();
  if (pending.length && network) {
    const r = go(['update', ...pending, '--quiet']);
    if (r.status === 0 && !unwired().length) report.push(`added  harness pointers for ${pending.join(', ')} (your own edits to the skills are kept)`);
    else report.push(`! ${pending.length} Skill Foundry skill(s) are not wired to harness workers yet (${pending.join(', ')}; ${why(r)}). Run:  ${FOUNDRY} update`);
  } else if (pending.length) report.push(`! ${pending.length} Skill Foundry skill(s) are not wired to harness workers yet (${pending.join(', ')}). Run:  ${FOUNDRY} update`);
}

console.log(`Installed the agentic harness into ${target}\n`);
report.forEach((l) => console.log(`  ${l}`));
console.log(`
Done. Your project now has the agentic harness. The workflow:
  human -> controller (task, charter, backlog, team) -> orchestrator (your editor session) -> named agents -> verify -> report to you
Next steps:
  1. Open the menu:    node .harness/start.mjs       (interactive launcher + live status)
     Check setup:      node .harness/doctor.mjs      (needs Node 18+ and one AI engine, e.g. Claude Code, logged in)
     Allow your AI tools once (headless runs use only allowed ones):  node .harness/engines.mjs     usage later:  node .harness/usage.mjs
                       several engines (claude, agy, codex)? see docs/MULTI-MODEL-SETUP.md in the harness repo, then  node .harness/team.mjs auto-assign
  2. Fill the charter: describe your project goals in .harness/charter.md ("Project objectives"); see the team with  node .harness/team.mjs show
  3. Prompt it:
       in Claude Code:  open the folder, accept the trust dialog once, restart the session so it loads the agents, then type
                        /harness:run <what you want done>     (the named agents appear working in your session; you get a report)
                        /harness:auto                         (autonomous: works through the READY backlog by itself)
       in Antigravity / Cursor / VS Code:  run  node .harness/hook-session.mjs --brief  or Tasks: Run Task -> Harness: Start Menu (interactive)
       in a terminal:   node .harness/start.mjs                   (numbered menu) or  node .harness/daemon.mjs  (watch live screen)
                        node .harness/dispatch.mjs --goal "<what you want>" --hierarchy --max-cost 2 --wait
  Autonomous mode is ON by default; it only acts on READY tasks you add. Turn it off: set "- autonomous: off" in .harness/charter.md
  (or install with  --autonomous off ). Every file above is plain text in your project; nothing is installed globally.`);
