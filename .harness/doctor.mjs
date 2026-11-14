#!/usr/bin/env node
/**
 * .harness/doctor.mjs — check this machine is ready, in plain language.
 *   node .harness/doctor.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT, FILES, DIRS, ensureDirs, loadConfig, resolveProfile, engineUsable, listLessons, probeEngine, profileFlags, engineConsent, usesCliDefault, winCommandLine, checkCore, detectVerifyCmd, listProjectFiles, helpIfAsked } from './lib/common.mjs';
helpIfAsked(import.meta.url);
import { readCharter, loadRoles, loadSkills, skillRulesNotGranted, skillToolsFor, readBacklog, backlogCounts, validateBacklog, listReleases, loadTeam, validateTeam, syncAgents } from './lib/governance.mjs';

ensureDirs();
const ok = (m) => console.log(`  ✔ ${m}`);
let warnings = 0; let notes = 0;
const warn = (m) => { warnings++; console.log(`  ! ${m}`); };
// A note is information, not a problem: something you may want to do, but the setup is valid without it.
const note = (m) => { notes++; console.log(`  ℹ ${m}`); };
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
  const preferred = name === config.activeProfile || (config.activeProfile === 'auto' && (config.autoOrder || [])[0] === name);
  if (!probe.installed) {
    // agy is often installed but not on PATH (the Antigravity app puts it in ~/.gemini/bin): say exactly how to fix it.
    const hidden = name === 'antigravity' && process.env.HARNESS_ENGINES === undefined && ['agy.exe', 'agy'].map((b) => path.join(os.homedir(), '.gemini', 'bin', b)).find((f) => fs.existsSync(f));
    const pathFix = process.platform === 'win32'
      ? `[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ";$HOME\\.gemini\\bin", 'User')   (PowerShell, then open a new terminal)`
      : `echo 'export PATH="$HOME/.gemini/bin:$PATH"' >> ~/.zshrc   (or ~/.bashrc, then open a new terminal)`;
    if (hidden) { warn(`${name.padEnd(12)} agy is installed at ${hidden} but that folder is not on your PATH, so the harness cannot use it. Fix:  ${pathFix}`); continue; }
    // Missing first choice is only a warning when nothing else can stand in; otherwise "auto" simply uses the next engine.
    const others = Object.keys(config.profiles).filter((k) => k !== name && probeEngine(config.profiles[k]).installed);
    if (preferred && !others.length) warn(`${name.padEnd(12)} not installed, and it is your first-choice engine (${config.activeProfile === 'auto' ? 'first in "autoOrder"' : '"activeProfile"'}). Install '${p.binary}' or another engine.`);
    else if (preferred) note(`${name.padEnd(12)} not installed (first in your order); the next one is used: ${others.join(', ')}`);
    else console.log(`  · ${name.padEnd(12)} not installed`);
    continue;
  }
  if (!probe.checked && !flags.length) { ok(`${name.padEnd(12)} ${probe.binPath} — no command-line flags to check`); continue; }
  if (!probe.checked) { warn(`${name.padEnd(12)} ${probe.binPath} — flags not checked (${probe.error})${probe.compatible ? ' — used anyway (verified profile)' : ' → will NOT be used (unverified profile); fix the CLI or its "args" in config.json'}`); continue; }
  if (usesCliDefault(p)) warn(`${name.padEnd(12)} has no model names in config.json, so every job runs on the CLI's own default model (no job-fit, may waste quota). Set profiles.${name}.models (fast / medium / high) from '${p.binary} --help' or its model list.`);
  const consent = engineConsent(name);
  const allowed = consent === true ? 'ALLOWED' : consent === false ? 'you chose NOT to allow it' : 'not allowed yet: run  node .harness/engines.mjs';
  if (probe.compatible) (consent === true ? ok : note)(`${name.padEnd(12)} ${probe.binPath} — all ${flags.length} flag(s) found: ${flags.join(' ')} — ${allowed}`);
  else bad(`${name.padEnd(12)} ${probe.binPath} — --help does NOT list: ${probe.missing.join(' ')}  → will fall back to "auto". Fix "args" in config.json.`);
}
try {
  const active = resolveProfile(config);
  ok(`Engine that will be used: ${active.name}${active.fallbackFrom ? ` (fallback from '${active.fallbackFrom}': ${active.fallbackReason})` : ''}  (config "activeProfile": "${config.activeProfile}")`);
} catch (e) {
  const waiting = Object.keys(config.profiles).filter((k) => { const pr = probeEngine(config.profiles[k]); return pr.installed && pr.compatible && engineConsent(k) === undefined; });
  if (waiting.length) note(`No AI tool is allowed yet. Installed and waiting for your OK: ${waiting.join(', ')}. Allow one (it spends your own quota):  node .harness/engines.mjs`);
  else { bad(`${e.message} Install one engine, e.g. Claude Code: npm install -g @anthropic-ai/claude-code  then run  claude  once to log in, then  node .harness/engines.mjs  to allow it.`); problems++; }
}

// Model-name drift: Antigravity uses exact model IDs (no aliases). If Google renames one, every run on that tier fails;
// catch it here by comparing config.json with what 'agy models' lists now (only when agy is installed and allowed).
{
  const ag = config.profiles?.antigravity;
  const agProbe = ag ? probeEngine(ag) : null;
  if (ag && agProbe?.installed && engineConsent('antigravity') === true) {
    const wanted = new Set([...Object.values(ag.models || {}), ...Object.values(config.quotaFallback || {}).filter((f) => f?.engine === 'antigravity').flatMap((f) => Object.values(f.models || {}))].filter(Boolean));
    const r = process.platform === 'win32'
      ? spawnSync(winCommandLine(agProbe.binPath, ['models']), { encoding: 'utf8', timeout: 30000, shell: true })
      : spawnSync(agProbe.binPath, ['models'], { encoding: 'utf8', timeout: 30000 });
    const listed = new Set(String(r.stdout || '').split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((x) => /^[a-z0-9][\w.-]+$/i.test(x || '')));
    console.log('\nAntigravity model names (config.json vs. "agy models")');
    if (r.status !== 0 || !listed.size) warn(`could not list agy models (${(r.stderr || r.error?.message || 'no output').toString().trim().slice(0, 120)}); model names not checked`);
    else {
      const gone = [...wanted].filter((m) => !listed.has(m));
      if (gone.length) warn(`model ID(s) no longer offered by agy: ${gone.join(', ')}. Runs on that tier would fail. Run  agy models  and update profiles.antigravity.models (and quotaFallback) in config.json.`);
      else ok(`all ${wanted.size} configured model IDs exist in agy (${[...wanted].join(', ')})`);
    }
  }
}

// Harness core integrity: in a project, the harness code is the template's. Editing it locally (by a person or an AI)
// is how projects drift apart and fixes get lost; doctor says so. The template repository itself is where it IS edited.
{
  const isTemplate = fs.existsSync(path.join(ROOT, 'install.mjs')) && /"name":\s*"agentic-harness"/.test((() => { try { return fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'); } catch { return ''; } })());
  console.log('\nHarness core (the template\'s code in .harness/*.mjs)');
  if (isTemplate) note('this is the template repository itself: the core is maintained here (see docs/MAINTAINING.md)');
  else {
    const c = checkCore();
    if (!c.manifest) note('no .harness/MANIFEST.json (installed before fingerprints existed). Re-install from the template to add it.');
    else if (!c.changed.length && !c.missing.length && !c.added.length) ok(`unchanged since install (template ${c.manifest.version || '?'}, ${Object.keys(c.manifest.files).length} files)`);
    else {
      const list = [...c.changed.map((f) => `${f} (edited)`), ...c.missing.map((f) => `${f} (deleted)`), ...c.added.map((f) => `${f} (new)`)];
      warn(`harness core differs from the template: ${list.join(', ')}. The core belongs to the template: do not fix the harness inside a project. Report the gap to the template (docs/MAINTAINING.md), then re-install to get the fix: npx github:sumtaimo/Agentic-Harness#release .`);
    }
  }
}

console.log('\nAutomatic check (used when a task has no --check)');
const v = detectVerifyCmd(ROOT, config);
v.real ? ok(`${v.cmd}  (${v.source})`) : warn(`${v.source}. Add a "test" (or "check") script to package.json, or always pass --check.`);

// A project with UI files needs a real browser in its check, or a broken page script or layout still passes.
// The doctor only looks and suggests; it never installs anything (that adds a dependency to YOUR project).
const UI_FILE = /\.(html?|css|scss|sass|less|svg|jsx|tsx|vue|svelte|astro)$/i;
const uiFiles = listProjectFiles(ROOT, 2000).files.filter((f) => UI_FILE.test(f));
if (uiFiles.length) {
  console.log('\nBrowser testing (this project has UI files)');
  const req = createRequire(path.join(ROOT, 'package.json'));
  const candidates = (process.env.HARNESS_BROWSER_MODULES || 'playwright,@playwright/test,playwright-core,puppeteer').split(',').map((x) => x.trim()).filter(Boolean);
  const found = candidates.find((m) => { try { req.resolve(m); return true; } catch { return false; } });
  if (!found) {
    note(`${uiFiles.length} UI file(s) (${uiFiles.slice(0, 3).join(', ')}${uiFiles.length > 3 ? ', …' : ''}) but no browser testing tool is installed, so visual and page-script tests will be SKIPPED, and a broken page can still pass. To add one (this installs a dev dependency in YOUR project, so it is your decision):\n      npm install -D playwright && npx playwright install chromium`);
  } else {
    ok(`browser testing tool found: ${found}`);
    if (process.argv.includes('--deep')) {
      // launch a real browser for a moment: the tool can be installed while the browser itself is missing
      const code = `const m=require(${JSON.stringify(req.resolve(found))});const t=m.chromium||m;(async()=>{const b=await t.launch({args:['--no-sandbox']});await b.close();})().then(()=>process.exit(0),(e)=>{console.error(String(e.message).split('\\n')[0]);process.exit(1);});`;
      const r = spawnSync(process.execPath, ['-e', code], { cwd: ROOT, encoding: 'utf8', timeout: 45000 });
      r.status === 0 ? ok('a real browser launches') : warn(`${found} is installed but the browser did not launch (${(r.stderr || 'timeout').trim().split('\n')[0]}). Try: npx playwright install chromium`);
    } else note('To prove a real browser launches (takes a few seconds): node .harness/doctor.mjs --deep');
  }
}

console.log('\nGovernance (v2: charter, backlog, roles, skills)');
const charter = readCharter();
if (!charter.exists) warn('No .harness/charter.md — autonomous mode is off. Copy it from the template to enable it.');
else {
  ok(`charter.md: autonomous ${charter.autonomous ? 'ON' : 'off'}, maxAutoTasksPerRun ${charter.maxAutoTasksPerRun}, requireRealCheck ${charter.requireRealCheck ? 'yes' : 'no'}`);
  ok(`allowedPaths: ${charter.allowedPaths.join(', ') || '(any)'} | forbiddenPaths: ${charter.forbiddenPaths.join(', ')}`);
  if (charter.autonomous && charter.requireRealCheck && !v.real) { bad('Autonomous is ON but the project has no real check: the controller will pause. Add a "test" script to package.json.'); problems++; }
  if (charter.autonomous && /\(describe your product goals here/.test(charter.text)) note('charter.md objectives are still the placeholder. Autonomous mode is on but plans nothing by itself until you describe your goals (section 1 of .harness/charter.md); it still runs any READY task you add.');
}
const roles = loadRoles();
const roleNames = Object.keys(roles);
roleNames.length ? ok(`roles: ${roleNames.join(', ')}`) : warn('No roles in .harness/roles/ — workers run without personas or per-role tool limits.');
const skills = loadSkills();
for (const s of Object.values(skills)) {
  for (const r of s.roles) if (roles[r]) { const ng = skillRulesNotGranted(roles[r], [s]); if (ng.length) warn(`skill ${s.name} asks for tool rules role ${r} does not allow (ignored): ${ng.map((x) => x.split(': ')[1]).join(', ')}`); }
  const badRoles = s.roles.filter((r) => !roles[r]);
  badRoles.length ? warn(`skill ${s.name}: unknown role(s) ${badRoles.join(', ')}`) : ok(`skill ${s.name} → roles ${s.roles.join(', ') || 'any'}${s.roles.filter((r) => roles[r]).map((r) => { const t = skillToolsFor(s, r); return t.length ? `; ${r}: ${t.join(', ')}` : ''; }).join('')}`);
}
try {
  validateBacklog(JSON.parse(fs.readFileSync(path.join(ROOT, '.harness', 'backlog.json'), 'utf8')));
  const c = backlogCounts(readBacklog());
  ok(`backlog.json: READY ${c.READY}, IN_PROGRESS ${c.IN_PROGRESS}, DONE ${c.DONE}, BLOCKED ${c.BLOCKED}, BACKLOG ${c.BACKLOG}`);
  if (c.IN_PROGRESS) warn(`${c.IN_PROGRESS} item(s) IN_PROGRESS — if no task is running, an interrupted run left them; set them READY with: node .harness/backlog.mjs ready <id>`);
} catch (e) { if (fs.existsSync(path.join(ROOT, '.harness', 'backlog.json'))) { bad(`backlog.json is invalid: ${e.message}`); problems++; } else warn('No backlog.json yet.'); }
ok(`${listReleases().length} release snapshot(s) in .harness/releases/`);

console.log('\nAgent team (hierarchy: orchestrator → leads → workers)');
{
  const team = loadTeam();
  if (!team) note('No .harness/team.json, so "dispatch --hierarchy" is not set up. Copy it from the template if you want the team mode.');
  else {
    const { errors, warnings: tw } = validateTeam(team, { roles, charter, plannerMaxWorkers: (config.planner || {}).maxWorkers || 4, engines: Object.keys(config.profiles || {}) });
    errors.forEach((e) => { bad(`team.json: ${e}`); problems++; });
    tw.forEach((w) => warn(`team.json: ${w}`));
    if (!errors.length) {
      const orch = team.members.find((m) => m.level === 'orchestrator'); const leads = team.members.filter((m) => m.level === 'lead');
      ok(`team.json valid: ${orch.id} → ${leads.length} lead(s): ${leads.map((l) => `${l.id} [${l.role}] owns ${l.scope.join(', ')}`).join(' | ')}`);
      const routed = team.members.filter((m) => m.engine);
      if (!routed.length) note('engine routing: none set, every member uses "auto". Route roles to your installed engines with  node .harness/team.mjs auto-assign');
      else {
        ok(`engine routing (headless --hierarchy): ${team.members.map((m) => `${m.id}→${m.engine || 'auto'}`).join(', ')}`);
        const down = [...new Set(routed.map((m) => m.engine))].filter((e) => !engineUsable(config, e).ok);
        if (down.length) warn(`routed engine(s) not usable now: ${down.join(', ')} → those members fall back to "auto". Re-run  node .harness/team.mjs auto-assign`);
      }
      const ag = syncAgents(team, roles, { check: true });
      if (ag.stale.length) warn(`editor agents out of sync with team.json (${ag.stale.join(', ')}): run  node .harness/team.mjs sync-agents  and restart the Claude Code session`);
      else ok(`editor agents in sync: ${leads.map((l) => l.id).join(', ')} are named agents in .claude/agents/ (visible when the orchestrator delegates in Claude Code)`);
      ok(`workflow: human → controller → orchestrator (editor session) → named agents → controller verify → report. Autonomous mode: ${charter.autonomous ? 'ON' : 'off'} (${charter.autonomous ? 'acts on READY tasks; plans new ones only once the charter objectives are filled in' : 'set "- autonomous: on" in charter.md to enable'})`);
    }
  }
}

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
      // Same folder, different spelling (Windows short names like RUNNER~1, symlinks, drive-letter case): compare real paths.
      const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
      const norm = (p) => (process.platform === 'win32' ? real(p).toLowerCase() : real(p));
      const stray = wts.filter((w) => norm(w) !== norm(ROOT));
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
/^- .*\(fill me/im.test(profile) ? note('memory/profile.md still has "(fill me)" placeholders. Optional: tell your AI "Read AGENTS.md and fill in my profile". The shared template keeps it generic on purpose.') : ok('memory/profile.md is filled in');
ok(`${listLessons(FILES.lessons).length} taught rule(s), ${listLessons(FILES.autoLessons).length} auto lesson(s)`);

console.log('\nDaemon');
try {
  const pid = Number(fs.readFileSync(FILES.pid, 'utf8')); process.kill(pid, 0);
  ok(`Background daemon is running (PID ${pid})`);
} catch { note('The background controller is not running (normal when idle). To start it: task "Harness: 1. Start", /harness:run in Claude Code, or: node .harness/daemon.mjs'); }
const leftovers = fs.readdirSync(DIRS.staging).filter((d) => !d.startsWith('.'));
if (leftovers.length) warn(`Backups from interrupted tasks in .harness/staging/: ${leftovers.join(', ')} — restore by hand if needed, then delete.`);

console.log(`\n${problems ? `${problems} problem(s) to fix above.` : 'All required checks passed.'}  Failures: ${problems} · Warnings: ${warnings} · Notes: ${notes}`);
process.exit(problems ? 1 : 0);
