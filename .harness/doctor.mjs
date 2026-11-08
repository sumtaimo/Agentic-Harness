#!/usr/bin/env node
/**
 * .harness/doctor.mjs — check this machine is ready, in plain language.
 *   node .harness/doctor.mjs
 */

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { ROOT, FILES, ensureDirs, loadConfig, which, resolveProfile, listLessons } from './lib/common.mjs';

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

console.log('\nAI engines (✔ = installed on this machine)');
for (const [name, p] of Object.entries(config.profiles)) {
  const found = which(p.binary);
  const tag = p.verified ? '' : '  [flags unverified — see "note" in config.json]';
  found ? ok(`${name.padEnd(12)} ${found}${tag}`) : console.log(`  · ${name.padEnd(12)} not installed`);
}
try {
  const active = resolveProfile(config);
  if (which(active.binary)) ok(`Active engine: ${active.name} (config "activeProfile": "${config.activeProfile}")`);
  else { bad(`Active engine '${active.name}' is not installed. Install one engine, e.g. Claude Code: npm install -g @anthropic-ai/claude-code  then run  claude  once to log in.`); problems++; }
} catch (e) { bad(e.message); problems++; }

console.log('\nMemory');
const profile = fs.existsSync(FILES.profile) ? fs.readFileSync(FILES.profile, 'utf8') : '';
/\(fill me\)/i.test(profile) ? warn('memory/profile.md still has "(fill me)" placeholders — tell your AI about yourself so it can fill them') : ok('memory/profile.md is filled in');
ok(`${listLessons(FILES.lessons).length} taught rule(s), ${listLessons(FILES.autoLessons).length} auto lesson(s)`);

console.log('\nDaemon');
try {
  const pid = Number(fs.readFileSync(FILES.pid, 'utf8')); process.kill(pid, 0);
  ok(`Background daemon is running (PID ${pid})`);
} catch { warn('Background daemon is not running. Start it with task "Harness: 1. Start" or: node .harness/daemon.mjs'); }

console.log(problems ? `\n${problems} problem(s) to fix above.` : '\nAll required checks passed.');
process.exit(problems ? 1 : 0);
