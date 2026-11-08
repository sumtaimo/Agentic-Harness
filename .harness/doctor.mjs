#!/usr/bin/env node
/**
 * .harness/doctor.mjs — check this machine is ready, in plain language.
 *   node .harness/doctor.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, FILES, DIRS, ensureDirs, loadConfig, resolveProfile, listLessons, probeEngine, profileFlags, detectVerifyCmd } from './lib/common.mjs';
import { readCharter, loadRoles, loadSkills, skillRulesNotGranted, readBacklog, backlogCounts, validateBacklog, listReleases } from './lib/governance.mjs';

ensureDirs();
const ok = (m) => console.log(`  ✔ ${m}`);
const warn = (m) => console.log(`  ! ${m}`);
const bad = (m) => console.log(`  ✖ ${m}`);
let problems = 0;

console.log(`Agentic Harness — doctor\nProject folder: ${ROOT}\n`);

console.log('Basics');
const major = Number(process.versions.node.split('.')[0]);
major >= 18 ? ok(`Node.js ${process.versions.node}`) : (bad(`Node.js ${process.versions.node} is too old — install Node 18 or newer from https://nodejs.org`), problems++);
let config;
try { config = loadConfig(); ok('.harness/config.json is valid'); } catch (e) { bad(`.harness/config.json is broken: ${e.message}`); process.exit(1); }
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
  try { execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: ROOT, stdio: 'ignore' }); ok('Git repository with commits (undo is possible)'); }
  catch { warn('This folder is not a git repository yet. Recommended so you can undo AI changes: run  git init && git add -A && git commit -m start'); }
} catch { warn('Git is not installed. The harness works without it, but you cannot easily undo AI changes. Install from https://git-scm.com'); }

console.log('\nAI engines — installed? and does "<engine> --help" list every flag in config.json?');
for (const [name, p] of Object.entries(config.profiles)) {
  const probe = probeEngine(p, { force: true });
  const flags = profileFlags(p);
  if (!probe.installed) { console.log(`  · ${name.padEnd(12)} not installed`); continue; }
  if (!probe.checked) { warn(`${name.padEnd(12)} ${probe.binPath} — flags not checked${flags.length ? ` (${probe.error})` : ' (none configured)'}`); continue; }
  if (probe.compatible) ok(`${name.padEnd(12)} ${probe.binPath} — all ${flags.length} flag(s) found: ${flags.join(' ')}`);
  else bad(`${name.padEnd(12)} ${probe.binPath} — --help does NOT list: ${probe.missing.join(' ')}  → will fall back to "auto". Fix "args" in config.json.`);
}
try {
  const active = resolveProfile(config);
  ok(`Engine that will be used: ${active.name}${active.fallbackFrom ? ` (fallback from '${active.fallbackFrom}': ${active.fallbackReason})` : ''}  (config "activeProfile": "${config.activeProfile}")`);
} catch (e) {
  bad(`${e.message} Install one engine, e.g. Claude Code: npm install -g @anthropic-ai/claude-code  then run  claude  once to log in.`); problems++;
}

console.log('\nAutomatic check (used when a task has no --check)');
const v = detectVerifyCmd(ROOT, config);
v.real ? ok(`${v.cmd}  (${v.source})`) : warn(`${v.source}. Add a "test" (or "check") script to package.json, or always pass --check.`);

console.log('\nGovernance (v2: charter, backlog, roles, skills)');
const charter = readCharter();
if (!charter.exists) warn('No .harness/charter.md — autonomous mode is off. Copy it from the template to enable it.');
else {
  ok(`charter.md: autonomous ${charter.autonomous ? 'ON' : 'off'}, maxAutoTasksPerRun ${charter.maxAutoTasksPerRun}, requireRealCheck ${charter.requireRealCheck ? 'yes' : 'no'}`);
  ok(`allowedPaths: ${charter.allowedPaths.join(', ') || '(any)'} | forbiddenPaths: ${charter.forbiddenPaths.join(', ')}`);
  if (charter.autonomous && charter.requireRealCheck && !v.real) { bad('Autonomous is ON but the project has no real check: the controller will pause. Add a "test" script to package.json.'); problems++; }
  if (charter.autonomous && /\(describe your product goals here/.test(charter.text)) warn('charter.md still has the placeholder objectives — the PO_ARCHITECT will have little to go on.');
}
const roles = loadRoles();
const roleNames = Object.keys(roles);
roleNames.length ? ok(`roles: ${roleNames.join(', ')}`) : warn('No roles in .harness/roles/ — workers run without personas or per-role tool limits.');
const skills = loadSkills();
for (const s of Object.values(skills)) {
  for (const r of s.roles) if (roles[r]) { const ng = skillRulesNotGranted(roles[r], [s]); if (ng.length) warn(`skill ${s.name} asks for tool rules role ${r} does not allow (ignored): ${ng.map((x) => x.split(': ')[1]).join(', ')}`); }
  const badRoles = s.roles.filter((r) => !roles[r]);
  badRoles.length ? warn(`skill ${s.name}: unknown role(s) ${badRoles.join(', ')}`) : ok(`skill ${s.name} → roles ${s.roles.join(', ') || 'any'}${s.allowedTools.length ? `; narrows tools to ${s.allowedTools.join(', ')}` : ''}`);
}
try {
  validateBacklog(JSON.parse(fs.readFileSync(path.join(ROOT, '.harness', 'backlog.json'), 'utf8')));
  const c = backlogCounts(readBacklog());
  ok(`backlog.json: READY ${c.READY}, IN_PROGRESS ${c.IN_PROGRESS}, DONE ${c.DONE}, BLOCKED ${c.BLOCKED}, BACKLOG ${c.BACKLOG}`);
  if (c.IN_PROGRESS) warn(`${c.IN_PROGRESS} item(s) IN_PROGRESS — if no task is running, an interrupted run left them; set them READY with: node .harness/backlog.mjs ready <id>`);
} catch (e) { if (fs.existsSync(path.join(ROOT, '.harness', 'backlog.json'))) { bad(`backlog.json is invalid: ${e.message}`); problems++; } else warn('No backlog.json yet.'); }
ok(`${listReleases().length} release snapshot(s) in .harness/releases/`);

console.log('\nGit integration branch (where autonomous work lands)');
{
  const g = config.git || {};
  const sh = (args) => { try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
  const repo = !!sh(['rev-parse', '--verify', 'HEAD']);
  const mode = g.integrationBranch ? (g.integrationMode || 'off') : 'off';
  if (mode === 'off') ok('integration branch off: every task edits your working folder (with backup + rollback).');
  else {
    ok(`'${g.integrationBranch}' for ${mode === 'always' ? 'every task' : 'autonomous tasks (manual ones too with dispatch --branch)'}; protected: ${(g.protectedBranches || []).join(', ')}`);
    if ((g.protectedBranches || []).includes(g.integrationBranch)) { bad(`integrationBranch '${g.integrationBranch}' is in protectedBranches — tasks will be refused.`); problems++; }
    if (!repo) {
      if (charter.autonomous) { bad('Autonomous is ON but this folder is not a git repository with a commit: autonomous tasks will be refused. Run: git init && git add -A && git commit -m start'); problems++; }
      else warn('Not a git repository yet — needed before autonomous work. Run: git init && git add -A && git commit -m start');
    } else {
      const tip = sh(['rev-parse', '--short', `refs/heads/${g.integrationBranch}`]);
      ok(tip ? `'${g.integrationBranch}' exists @ ${tip}. See its work with: git log --oneline ${g.integrationBranch}` : `'${g.integrationBranch}' does not exist yet; it will be created from ${g.integrationBase || 'HEAD'} on the first task.`);
      const left = (sh(['branch', '--list', 'harness/*']) || '').split('\n').map((b) => b.replace(/^[*+\s]+/, '').trim()).filter(Boolean);
      if (left.length) warn(`${left.length} worker branch(es) kept from failed tasks for review: ${left.slice(0, 5).join(', ')}${left.length > 5 ? ' …' : ''} (delete with: git branch -D <name>)`);
      const wts = (sh(['worktree', 'list', '--porcelain']) || '').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));
      const stray = wts.filter((w) => path.resolve(w) !== path.resolve(ROOT));
      stray.length ? warn(`${stray.length} extra git worktree(s) still registered (a task may be running, or one was interrupted): ${stray.join(', ')}. Clean with: git worktree prune`) : ok('git worktrees clean: only your own folder');
      const dirty = sh(['status', '--porcelain', '--untracked-files=no', '--', '.', ':(exclude).harness']);
      dirty ? warn('Your folder has uncommitted changes (the harness never touches them; it only refuses to fast-forward a checked-out uat over them).') : ok('your folder has no uncommitted changes');
      const prot = (g.protectedBranches || []).map((b) => [b, sh(['rev-parse', '--short', `refs/heads/${b}`])]).filter(([, sha]) => sha);
      if (prot.length) ok(`protected branches (never written by the harness): ${prot.map(([b, sha]) => `${b}@${sha}`).join(', ')}`);
      if (!sh(['config', 'user.email'])) warn('git has no user.email: harness commits will use "Agentic Harness <harness@localhost>".');
    }
  }
  ok(`live agent output: ${config.liveAgentOutput === false ? 'off' : 'on (agents stream their actions into the terminal)'}; heartbeat every ${config.heartbeatIntervalSeconds || config.autonomous?.intervalSeconds || 60}s`);
}

console.log('\nMemory');
const profile = fs.existsSync(FILES.profile) ? fs.readFileSync(FILES.profile, 'utf8') : '';
/\(fill me\)/i.test(profile) ? warn('memory/profile.md still has "(fill me)" placeholders — tell your AI about yourself so it can fill them') : ok('memory/profile.md is filled in');
ok(`${listLessons(FILES.lessons).length} taught rule(s), ${listLessons(FILES.autoLessons).length} auto lesson(s)`);

console.log('\nDaemon');
try {
  const pid = Number(fs.readFileSync(FILES.pid, 'utf8')); process.kill(pid, 0);
  ok(`Background daemon is running (PID ${pid})`);
} catch { warn('Background daemon is not running. Start it with task "Harness: 1. Start" or: node .harness/daemon.mjs'); }
const leftovers = fs.readdirSync(DIRS.staging).filter((d) => !d.startsWith('.'));
if (leftovers.length) warn(`Backups from interrupted tasks in .harness/staging/: ${leftovers.join(', ')} — restore by hand if needed, then delete.`);

console.log(problems ? `\n${problems} problem(s) to fix above.` : '\nAll required checks passed.');
process.exit(problems ? 1 : 0);
