#!/usr/bin/env node
/**
 * .harness/doctor.mjs — check this machine is ready, in plain language.
 *   node .harness/doctor.mjs
 */

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { ROOT, FILES, DIRS, ensureDirs, loadConfig, resolveProfile, listLessons, probeEngine, profileFlags, detectVerifyCmd } from './lib/common.mjs';

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
