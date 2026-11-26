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
import { ROOT, FILES, DIRS, ensureDirs, loadConfig, resolveProfile, engineUsable, listLessons, probeEngine, profileFlags, engineConsent, usesCliDefault, winCommandLine, needsWinShell, findAllOnPath, checkCore, detectVerifyCmd, listProjectFiles, which, helpIfAsked, REMOVED_ENGINES, personStatus, ME_SETUP_CMD, meFile, readPeople, listAvailableModels, pickModelFromAvailable } from './lib/common.mjs';
helpIfAsked(import.meta.url);
import { SKILL_MATCH, SKILL_SCHEMA_MAX, unsupportedSkillPointers, readCharter, loadRoles, loadSkills, skillRulesNotGranted, skillToolsFor, readBacklog, backlogCounts, validateBacklog, listReleases, loadTeam, validateTeam, syncAgents, planScopeAdaptation } from './lib/governance.mjs';

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
  // An engine the harness dropped (kept only because an older config.json still lists it): never probed, never used.
  if (REMOVED_ENGINES[name]) { warn(`${name.padEnd(12)} no longer supported (${REMOVED_ENGINES[name]}); the harness never uses it. Remove "${name}" from "profiles" and "autoOrder" in .harness/config.json.`); continue; }
  const probe = probeEngine(p, { force: true });
  const flags = profileFlags(p);
  const preferred = name === config.activeProfile || (config.activeProfile === 'auto' && (config.autoOrder || [])[0] === name);
  if (!probe.installed) {
    // agy is often installed but not on PATH (the Antigravity app puts it in %LOCALAPPDATA%\agy\bin or ~/.gemini/bin): say exactly how to fix it.
    const hidden = name === 'antigravity' && process.env.HARNESS_ENGINES === undefined && [
      ...(process.env.LOCALAPPDATA ? ['agy.exe', 'agy'].map((b) => path.join(process.env.LOCALAPPDATA, 'agy', 'bin', b)) : []),
      ...['agy.exe', 'agy'].map((b) => path.join(os.homedir(), '.gemini', 'bin', b))
    ].find((f) => fs.existsSync(f));
    const hiddenDir = hidden ? path.dirname(hidden) : path.join(os.homedir(), '.gemini', 'bin');
    const pathFix = process.platform === 'win32'
      ? `[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ";${hiddenDir}", 'User')   (PowerShell, then open a new terminal)`
      : `echo 'export PATH="$HOME/.gemini/bin:$PATH"' >> ~/.zshrc   (or ~/.bashrc, then open a new terminal)`;
    if (hidden) { warn(`${name.padEnd(12)} agy is installed at ${hidden} but that folder is not on your PATH, so the harness cannot use it. Fix:  ${pathFix}`); continue; }
    // Missing first choice is only a warning when nothing else can stand in; otherwise "auto" simply uses the next engine.
    const others = Object.keys(config.profiles).filter((k) => k !== name && probeEngine(config.profiles[k]).installed);
    if (preferred && !others.length) warn(`${name.padEnd(12)} not installed, and it is your first-choice engine (${config.activeProfile === 'auto' ? 'first in "autoOrder"' : '"activeProfile"'}). Install '${p.binary}' or another engine.`);
    else if (preferred) note(`${name.padEnd(12)} not installed (first in your order); the next one is used: ${others.join(', ')}`);
    else console.log(`  · ${name.padEnd(12)} not installed`);
    continue;
  }
  if (name === 'antigravity' && process.env.HARNESS_ENGINES === undefined) {
    const agyHits = findAllOnPath(p.binary);
    if (agyHits.length > 1) warn(`${name.padEnd(12)} multiple '${p.binary}' binaries on PATH — using #1 (${agyHits[0]}), shadowing: ${agyHits.slice(1).join(', ')}. Keep one copy on PATH to avoid version mismatches.`);
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
if (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY) {
  note('Note: Paid API key is active in shell env—unset it if you intend to use your personal subscription');
}

// Model-name drift: Antigravity uses exact model IDs (no aliases). If Google renames one, every run on that tier fails;
// catch it here by comparing config.json with what 'agy models' lists now (only when agy is installed and allowed).
{
  const ag = config.profiles?.antigravity;
  const agProbe = ag ? probeEngine(ag) : null;
  if (ag && agProbe?.installed && engineConsent('antigravity') === true) {
    const wanted = new Set([...Object.values(ag.models || {}), ...Object.values(config.quotaFallback || {}).filter((f) => f?.engine === 'antigravity').flatMap((f) => Object.values(f.models || {}))].filter(Boolean));
    const live = listAvailableModels(ag, { force: true });
    console.log('\nAntigravity model names (config.json vs. "agy models")');
    if (!live.models?.length) warn(`could not list agy models (${live.error || 'no output'}); model names not checked`);
    else {
      const listed = new Set(live.models);
      const gone = [...wanted].filter((m) => !listed.has(m));
      if (gone.length) {
        const tierFor = (id) => Object.entries(ag.models || {}).find(([, v]) => v === id)?.[0] || Object.values(config.quotaFallback || {}).filter((f) => f?.engine === 'antigravity').flatMap((f) => Object.entries(f.models || {})).find(([, v]) => v === id)?.[0] || 'medium';
        const hints = gone.map((m) => { const alt = pickModelFromAvailable(live.models, { tier: tierFor(m), preferred: m }); return alt ? `${m} → runtime auto-fallback: ${alt.model}` : m; });
        warn(`model ID(s) no longer offered by agy: ${hints.join('; ')}. Run  agy models  and update profiles.antigravity.models (and quotaFallback) in config.json.`);
      } else ok(`all ${wanted.size} configured model IDs exist in agy (${[...wanted].join(', ')})`);
    }
  }
}

// Harness core integrity: in a project, the harness code is the template's. Editing it locally (by a person or an AI)
// is how projects drift apart and fixes get lost; doctor says so. The template repository itself is where it IS edited.
const isTemplate = fs.existsSync(path.join(ROOT, 'install.mjs')) && /"name":\s*"agentic-harness"/.test((() => { try { return fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'); } catch { return ''; } })());
{
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
    // Is there a newer release? (inline here; one HTTPS GET of the release's package.json, nothing about you is sent)
    try {
      const { updateCheck } = await import('./lib/update-check.mjs');
      const u = await updateCheck({ root: ROOT, sync: true });
      if (u.lines.length) for (const l of u.lines) warn(l);
      else if (u.source === 'off') note('update check is off (HARNESS_OFFLINE=1, HARNESS_UPDATE_CHECK=0 or "updateCheck": false)');
      else if (u.latest) ok(`harness ${u.installed} is the latest release`);
      else note(`could not reach the release to check for a newer harness (offline?). To update by hand: npx github:sumtaimo/Agentic-Harness#release .`);
    } catch { /* a courtesy: never fail the doctor */ }
  }
}

console.log('\nAutomatic check (used when a task has no --check)');
const v = detectVerifyCmd(ROOT, config);
v.real ? ok(`${v.cmd}  (${v.source})`) : warn(`${v.source}. Add a "test" / "check" script (package.json, Makefile, pytest/go/cargo) or always pass --check.`);
if (v.real) {
  const firstTok = v.cmd.trim().split(/\s+/)[0].replace(/^["']|["']$/g, '');
  if (firstTok && !firstTok.includes('/') && !firstTok.includes('\\') && !which(firstTok)) {
    warn(`detected check runner '${firstTok}' is not on PATH — install it or pass --check "<command>"`);
  }
}

// A project with UI files needs a real browser in its check, or a broken page script or layout still passes.
// The doctor only looks and suggests; it never installs anything (that adds a dependency to YOUR project).
const UI_FILE = /\.(html?|css|scss|sass|less|svg|jsx|tsx|vue|svelte|astro)$/i;
const uiFiles = listProjectFiles(ROOT, 2000).files.filter((f) => UI_FILE.test(f) && !f.replace(/\\/g, '/').startsWith('.claude/'));
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
  // Workers can drive a browser themselves only through the playwright MCP preset (QA and UX may not run node scripts).
  // Off by default (owner's decision: a download per project); say how to turn it on, never turn it on here.
  try {
    const mcp = JSON.parse(fs.readFileSync(path.join(ROOT, '.harness', 'mcp.json'), 'utf8'));
    const prof = (config.profiles || {})[config.activeProfile && config.activeProfile !== 'auto' ? config.activeProfile : (config.autoOrder || ['claude'])[0]] || {};
    if (mcp.mcpServers?.playwright && prof.useMcp) ok('workers can open the app in a browser (playwright MCP preset is on)');
    else note(`Workers (QA, UX, DEV) cannot open the app in a browser themselves: the playwright MCP preset is off. To turn it on: copy "playwright" from "_optionalPresets" into "mcpServers" in .harness/mcp.json and set "useMcp": true for your engine in .harness/config.json (each run then downloads a browser once).`);
  } catch (e) { note(`could not read .harness/mcp.json (${e.message})`); }
}

console.log('\nGovernance (v2: charter, backlog, roles, skills)');
const charter = readCharter();
if (!charter.exists) warn('No .harness/charter.md — autonomous mode is off. Copy it from the template to enable it.');
else {
  ok(`charter.md: autonomous ${charter.autonomous ? 'ON' : 'off'}, maxAutoTasksPerRun ${charter.maxAutoTasksPerRun}, requireRealCheck ${charter.requireRealCheck ? 'yes' : 'no'}`);
  ok(`allowedPaths: ${charter.allowedPaths.join(', ') || '(any)'} | forbiddenPaths: ${charter.forbiddenPaths.join(', ')}`);
  if (charter.autonomous && charter.requireRealCheck && !v.real) { bad('Autonomous is ON but the project has no real check: the controller will pause. Add a project test/check script or --verify command.'); problems++; }
  if (charter.autonomous && /\(describe your product goals here/.test(charter.text)) note('charter.md objectives are still the placeholder. Autonomous mode is on but plans nothing by itself until you describe your goals (section 1 of .harness/charter.md); it still runs any READY task you add.');
}
const roles = loadRoles();
const roleNames = Object.keys(roles);
roleNames.length ? ok(`roles: ${roleNames.join(', ')}`) : warn('No roles in .harness/roles/ — workers run without personas or per-role tool limits.');
const skills = loadSkills();
for (const u of unsupportedSkillPointers()) warn(`skill ${u.name}: pointer schema_version ${u.schemaVersion} is newer than this harness understands (${SKILL_SCHEMA_MAX}), so it is skipped. Fix: update the harness (npx github:sumtaimo/Agentic-Harness#release .)`);
for (const s of Object.values(skills)) {
  for (const r of s.roles) if (roles[r]) { const ng = skillRulesNotGranted(roles[r], [s]); if (ng.length) warn(`skill ${s.name} asks for tool rules role ${r} does not allow (ignored): ${ng.map((x) => x.split(': ')[1]).join(', ')}`); }
  const badRoles = s.roles.filter((r) => !roles[r]);
  badRoles.length ? warn(`skill ${s.name}: unknown role(s) ${badRoles.join(', ')}`) : ok(`skill ${s.name} → roles ${s.roles.join(', ') || 'any'}${s.roles.filter((r) => roles[r]).map((r) => { const t = skillToolsFor(s, r); return t.length ? `; ${r}: ${t.join(', ')}` : ''; }).join('')}`);
}
// Skill Foundry (github:sumtaimo/Skill-Foundry) installs skills into .claude/skills/<name>/ with a .foundry.json stamp
// and a pointer in .harness/skills/<name>/SKILL.md. Check that the two halves agree and that the roles can run them.
{
  const csk = path.join(ROOT, '.claude', 'skills');
  const stamps = fs.existsSync(csk) ? fs.readdirSync(csk, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(csk, d.name, '.foundry.json'))).map((d) => d.name) : [];
  if (stamps.length) {
    const FCLI = 'npx github:sumtaimo/Skill-Foundry';
    let issues = 0;
    for (const n of stamps) {
      let st = {}; try { st = JSON.parse(fs.readFileSync(path.join(csk, n, '.foundry.json'), 'utf8')); } catch { warn(`Skill Foundry: .claude/skills/${n}/.foundry.json is not valid JSON. Fix: ${FCLI} update ${n}`); issues++; continue; }
      if (st.scope === 'factory') continue;
      const p = skills[n];
      if (!p) { warn(`Skill Foundry: ${n} is installed but has no pointer .harness/skills/${n}/SKILL.md, so harness workers never get it. Fix: ${FCLI} update ${n}`); issues++; continue; }
      if (!p.installedBy.startsWith('skill-foundry')) { warn(`Skill Foundry: .harness/skills/${n}/SKILL.md is the project's own skill, not the foundry pointer, so the foundry skill is not wired. Fix: ${FCLI} update ${n} --sync-harness (keeps yours as SKILL.md.orig) or keep yours`); issues++; continue; }
      const pv = p.installedBy.split(/\s+/)[1];
      if (st.version && pv && pv !== st.version) { warn(`Skill Foundry: ${n} pointer is for ${pv} but ${st.version} is installed. Fix: ${FCLI} update ${n}`); issues++; }
      // With SKILL_MATCH keywords inject for every member, so autoApply off is normal; only a pointer with no keywords is stuck.
      if (!p.autoApply && (!SKILL_MATCH || !p.keywords.length)) { warn(`Skill Foundry: ${n} pointer has autoApply off${SKILL_MATCH ? ' and no keywords' : ''}, so it reaches only members that list it in team.json "skills". Fix: ${FCLI} update ${n}`); issues++; }
      const engine = fs.existsSync(path.join(csk, n, 'engine'));
      for (const r of p.roles) {
        const role = roles[r]; if (!role) continue;
        const ng = skillRulesNotGranted(role, [p]);
        if (ng.length) { warn(`Skill Foundry: ${n} asks role ${r} for ${ng.map((x) => x.split(': ')[1]).join(', ')}, which the role does not allow (ignored).`); issues++; }
        if (engine && !(role.allowedTools || []).some((t) => t === 'Bash(node:*)' || t === 'Bash(*)' || t === 'Bash')) {
          // The skill declares in its pointer (data, never by name) whether it works without its scripts: `engine: optional` is a note, anything else a warning.
          if (p.engine === 'optional') note(`Skill Foundry: ${n} works for role ${r} without its engine/ scripts (its documented fallback, less detailed); give the engine step to DEV_ENGINEER for the full result.`);
          else { warn(`Skill Foundry: ${n} ${p.engine === 'required' ? 'needs' : 'runs'} engine/*.mjs scripts, but role ${r} may not run node. Let DEV_ENGINEER run that step, or (project owner's choice) add "Bash(node:*)" to .harness/roles/${role.file}`); issues++; }
        }
      }
    }
    // the doctor is run on purpose, so it may wait for the answer (sync); a session start never does
    try { const { foundryCheck } = await import('./lib/foundry-check.mjs'); for (const l of foundryCheck({ root: ROOT, sync: true }).lines) note(l); } catch { /* the check is a courtesy: never fail the doctor */ }
    issues ? note(`Skill Foundry: ${stamps.length} skill(s), ${issues} finding(s) above. Deeper check: ${FCLI} doctor`) : ok(`Skill Foundry: ${stamps.length} skill(s) wired to the harness (${stamps.join(', ')})`);
  }
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
        // One engine for the whole team is a single point of failure: a usage limit / HTTP 429 stops every member at once.
        const engines = [...new Set(team.members.map((m) => m.engine || 'auto'))];
        if (engines.length === 1 && engines[0] !== 'auto' && team.members.length > 1) {
          const spare = Object.keys(config.profiles).filter((k) => k !== engines[0] && !REMOVED_ENGINES[k] && engineUsable(config, k).ok);
          if (spare.length) note(`every team member is routed to ${engines[0]}: if it hits a usage limit (HTTP 429), agents retry on ${spare.join(', ')} (QUOTA_FALLBACK). To spread the load: node .harness/team.mjs auto-assign`);
          else warn(`every team member is routed to ${engines[0]} and no other engine is usable: one usage limit (HTTP 429) stops the whole team. Install/allow a second engine (node .harness/engines.mjs), then: node .harness/team.mjs auto-assign`);
        }
      }
      const ag = syncAgents(team, roles, { check: true });
      if (ag.stale.length) warn(`editor agents out of sync with team.json (${ag.stale.join(', ')}): run  node .harness/team.mjs sync-agents  and restart the Claude Code session`);
      else ok(`editor agents in sync: ${leads.map((l) => l.id).join(', ')} are named agents in .claude/agents/ (visible when the orchestrator delegates in Claude Code)`);
      if (!isTemplate) {
        const adapt = planScopeAdaptation(ROOT, { team, roles, charter });
        if (adapt.changed && adapt.uncoveredDirs.length) {
          note(`project folders outside team/charter scopes (${adapt.uncoveredDirs.join(', ')}) — preview: node .harness/team.mjs adapt-scopes`);
        }
      }
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
if (!fs.existsSync(FILES.profile) || !profile.trim()) note('memory/profile.md is missing or empty. Run node install.mjs <project> or create .harness/memory/profile.md');
else if (/^- .*\(fill me/im.test(profile)) note('memory/profile.md still has "(fill me)" placeholders. Optional: tell your AI "Read AGENTS.md and fill in the project profile" (it describes the project; your own preferences go in me.md).');
else ok('memory/profile.md is filled in');
{
  // The person at this machine: me.md is git-ignored, one per person (hats are human focus, never AI roles).
  const p = personStatus();
  if (p.kind === 'me') ok(`memory/me.md (yours, git-ignored): ${p.me.fields.find((f) => f.key === 'name')?.value || 'no name'}${p.me.hats.length ? `, hats ${p.me.hats.join(', ')}` : ''}${p.me.skills.length ? `, ${p.me.skills.length} personal skill(s) for your chat AI only` : ''}`);
  else if (p.kind === 'other-person') note(`memory/profile.md names ${p.name}, but the git user here is ${p.gitName}. A teammate keeps their own preferences in memory/me.md (git-ignored): ${ME_SETUP_CMD}`);
  else if (p.kind === 'missing') note(`no memory/me.md on this machine (optional, git-ignored: your name, language, answer style and hats). Create it: ${ME_SETUP_CMD}`);
  if (p.kind === 'me' && path.resolve(meFile()) !== path.resolve(FILES.me)) ok(`memory/me.md comes from the main checkout (${path.dirname(path.dirname(path.dirname(meFile())))}): one me.md for all your worktrees`);
  // Personal skills: the person's own Claude skills folder (~/.claude/skills/<name>/SKILL.md). A project skill of the same
  // name is shared, not personal; a name found nowhere is probably a typo.
  for (const s of p.kind === 'me' ? p.me.skills : []) {
    const personal = path.join(os.homedir(), '.claude', 'skills', s, 'SKILL.md');
    const shared = path.join(ROOT, '.claude', 'skills', s, 'SKILL.md');
    if (fs.existsSync(personal)) continue;
    if (fs.existsSync(shared)) note(`me.md lists "${s}" as a personal skill, but it is a shared project skill (.claude/skills/${s}); everyone has it already, so it does not need to be in me.md`);
    else note(`me.md lists personal skill "${s}", but ${personal} does not exist. Check the name, or install it into your own skills folder`);
  }
  if (fs.existsSync(FILES.me) && fs.existsSync(path.join(ROOT, '.git')) && spawnSync('git', ['check-ignore', '-q', '.harness/memory/me.md'], { cwd: ROOT, stdio: 'ignore' }).status === 1) warn('memory/me.md is NOT git-ignored, so personal preferences could be committed. Fix: add ".harness/memory/me.md" to .gitignore (re-installing the harness adds it).');
  // The team page (people.md, committed): only what people chose to share, no contact details, one section each.
  if (fs.existsSync(FILES.people)) {
    const people = readPeople();
    const raw = fs.readFileSync(FILES.people, 'utf8');
    const names = people.map((x) => x.name.toLowerCase());
    const dup = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
    if (dup.length) warn(`memory/people.md lists ${dup.join(', ')} more than once. Keep one section per person (each person runs: node .harness/memory.mjs me share).`);
    if (/[^\s@]+@[^\s@]+\.[a-z]{2,}|\+?\d[\d\s().-]{7,}\d/i.test(raw)) warn('memory/people.md contains what looks like an e-mail address or phone number. It is committed: remove contact details from it.');
    const mine = p.kind === 'me' ? people.find((x) => x.name.toLowerCase() === String(p.me.fields.find((f) => f.key === 'name')?.value || '').toLowerCase()) : null;
    if (mine && mine.hats.join(',') !== p.me.hats.join(',')) note(`memory/people.md shows your hats as "${mine.hats.join(', ') || 'none'}", your me.md says "${p.me.hats.join(', ') || 'none'}". Update the team page: node .harness/memory.mjs me share`);
    ok(`memory/people.md (team page, committed): ${people.length} person(s)${people.length ? `: ${people.map((x) => x.name).join(', ')}` : ''}`);
  }
}
if (!fs.existsSync(FILES.lessons)) note('memory/lessons.md is missing');
ok(`${listLessons(FILES.lessons).length} taught rule(s), ${listLessons(FILES.autoLessons).length} auto lesson(s)`);

console.log('\nEditor & cross-tool rules');
{
  const RULE_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.github/copilot-instructions.md', '.cursor/rules/harness.mdc', '.windsurfrules'];
  const missing = [];
  const stale = [];
  for (const rel of RULE_FILES) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) { missing.push(rel); continue; }
    const txt = fs.readFileSync(abs, 'utf8');
    if (rel === 'AGENTS.md') {
      const hasMem = /profile\.md/.test(txt) && /lessons\.md/.test(txt) && /auto-lessons\.md/.test(txt);
      const hasHarness = /Agentic Harness|Agentic harness/i.test(txt);
      if (!hasMem || !hasHarness) stale.push(rel);
    } else {
      const hasAgents = /AGENTS\.md/.test(txt);
      const hasMem = /profile\.md/.test(txt) && /lessons\.md/.test(txt) && /auto-lessons\.md/.test(txt);
      const hasAutoImports = !['CLAUDE.md', 'GEMINI.md'].includes(rel)
        || (/^@AGENTS\.md\s*$/m.test(txt) && /^@\.harness\/memory\/profile\.md\s*$/m.test(txt) && /^@\.harness\/memory\/lessons\.md\s*$/m.test(txt))
        || txt.includes('<!-- agentic-harness -->');
      if (!hasAgents || !hasMem || !hasAutoImports) stale.push(rel);
    }
  }
  if (!missing.length && !stale.length) {
    ok(`cross-tool rules in sync (${RULE_FILES.length} files point to AGENTS.md + memory)`);
  } else {
    if (missing.length) note(`missing cross-tool rule file(s): ${missing.join(', ')} (optional — re-run install.mjs to add them for those editors/CLIs)`);
    if (stale.length) note(`cross-tool rule file(s) need memory/AGENTS.md parity: ${stale.join(', ')} (make sure they reference AGENTS.md, profile.md, lessons.md, and auto-lessons.md)`);
  }
}

console.log('\nRuntime guards & hooks (Claude Code + Antigravity)');
{
  // 1. Claude Code (.claude/settings.json)
  const claudeSet = path.join(ROOT, '.claude', 'settings.json');
  if (!fs.existsSync(claudeSet)) {
    note('no .claude/settings.json (Claude Code SessionStart / PreToolUse / Stop hooks not wired; re-run install.mjs to add)');
  } else {
    try {
      const s = JSON.parse(fs.readFileSync(claudeSet, 'utf8'));
      const hooks = s.hooks || {};
      const missingH = [];
      if (!JSON.stringify(hooks.SessionStart || []).includes('hook-session.mjs')) missingH.push('SessionStart (hook-session.mjs)');
      if (!JSON.stringify(hooks.PreToolUse || []).includes('hook-guard.mjs')) missingH.push('PreToolUse (hook-guard.mjs)');
      if (!JSON.stringify(hooks.Stop || []).includes('hook-stop.mjs')) missingH.push('Stop (hook-stop.mjs)');
      if (missingH.length) warn(`.claude/settings.json is missing hook(s): ${missingH.join(', ')}. Re-install from the template to restore runtime guards.`);
      else ok('.claude/settings.json hooks active: SessionStart, PreToolUse (hook-guard.mjs), Stop (hook-stop.mjs)');
      if (!isTemplate && fs.existsSync(path.join(ROOT, '.harness', 'MANIFEST.json'))) {
        const deny = s.permissions?.deny || [];
        const needDeny = ['Edit(.harness/*.mjs)', 'Edit(.harness/lib/**)', 'Edit(.claude/settings.json)', 'Edit(.agents/hooks.json)'];
        const missingDeny = needDeny.filter((r) => !deny.includes(r));
        if (missingDeny.length) warn(`.claude/settings.json is missing core/hook deny rule(s): ${missingDeny.join(', ')}. Re-install to harden.`);
      }
    } catch (e) {
      warn(`.claude/settings.json is not valid JSON (${e.message}); Claude Code runtime hooks will not run`);
    }
  }

  // 2. Antigravity (.agents/hooks.json)
  const agyHooks = path.join(ROOT, '.agents', 'hooks.json');
  if (!fs.existsSync(agyHooks)) {
    note('no .agents/hooks.json (Antigravity SessionStart / PreToolUse / Stop hooks not wired; re-run install.mjs to add)');
  } else {
    try {
      const raw = JSON.parse(fs.readFileSync(agyHooks, 'utf8'));
      const activeEntries = Object.values(raw || {}).filter((v) => v && typeof v === 'object' && v.enabled !== false);
      const blob = (ev) => JSON.stringify(activeEntries.flatMap((e) => (Array.isArray(e[ev]) ? e[ev] : [])));
      const missingA = [];
      if (!blob('SessionStart').includes('hook-session.mjs')) missingA.push('SessionStart (hook-session.mjs)');
      if (!blob('PreToolUse').includes('hook-guard.mjs')) missingA.push('PreToolUse (hook-guard.mjs)');
      if (!blob('Stop').includes('hook-stop.mjs')) missingA.push('Stop (hook-stop.mjs)');
      if (missingA.length) warn(`.agents/hooks.json is missing or has disabled hook(s): ${missingA.join(', ')}. Re-install from the template to restore Antigravity guards.`);
      else ok('.agents/hooks.json hooks active: SessionStart, PreToolUse (hook-guard.mjs), Stop (hook-stop.mjs)');
    } catch (e) {
      warn(`.agents/hooks.json is not valid JSON (${e.message}); Antigravity runtime hooks will not run`);
    }
  }
}

console.log('\nDaemon');
try {
  const pid = Number(fs.readFileSync(FILES.pid, 'utf8')); process.kill(pid, 0);
  ok(`Background daemon is running (PID ${pid})`);
} catch { note('The background controller is not running (normal when idle). To start it: task "Harness: 1. Start", /harness:run in Claude Code, or: node .harness/daemon.mjs'); }
const leftovers = fs.readdirSync(DIRS.staging).filter((d) => !d.startsWith('.'));
if (leftovers.length) warn(`Backups from interrupted tasks in .harness/staging/: ${leftovers.join(', ')} — restore by hand if needed, then delete.`);

console.log(`\n${problems ? `${problems} problem(s) to fix above.` : 'All required checks passed.'}  Failures: ${problems} · Warnings: ${warnings} · Notes: ${notes}`);
process.exit(problems ? 1 : 0);
