#!/usr/bin/env node
/**
 * .harness/hook-session.mjs — Claude Code SessionStart hook (wired in .claude/settings.json).
 * Whatever this prints is added to the editor AI's context when a session starts, so it knows the
 * harness exists, whether the controller is running, and how to work through it.
 * Silent for harness workers (HARNESS_WORKER=1) and on any problem: a hook must never block a session.
 */

import fs from 'node:fs';
import path from 'node:path';

try {
  if (process.env.HARNESS_WORKER === '1') process.exit(0);
  const { FILES, DIRS, ROOT, readJsonSafe, loadConfig, listLessons } = await import('./lib/common.mjs');
  const { readCharter, readBacklog, backlogCounts } = await import('./lib/governance.mjs');

  let pid = 0;
  try { pid = Number(fs.readFileSync(FILES.pid, 'utf8')); process.kill(pid, 0); } catch { pid = 0; }
  const st = readJsonSafe(FILES.state, {});
  const c = backlogCounts(readBacklog());
  const charter = readCharter();
  const cfg = loadConfig();
  const count = (d) => { try { return fs.readdirSync(d).filter((f) => f.endsWith('.json')).length; } catch { return 0; } };
  const profile = (() => { try { return fs.readFileSync(FILES.profile, 'utf8'); } catch { return ''; } })();
  const git = cfg.git || {};

  const lines = [
    '[Agentic Harness] This folder has an agentic harness (.harness/). Instructions: AGENTS.md.',
    `- Controller: ${pid ? `running (PID ${pid}), phase ${st.phase || '?'}${st.taskTitle ? `, task "${st.taskTitle}"` : ''}` : 'NOT running (start it in the background to work through the harness; see /harness:run)'}`,
    `- Backlog: READY ${c.READY}, IN_PROGRESS ${c.IN_PROGRESS}, DONE ${c.DONE}, BLOCKED ${c.BLOCKED} | inbox ${count(DIRS.inbox)} | failed jobs ${count(DIRS.failed)}`,
    `- Autonomous mode: charter says ${charter.autonomous ? 'ON' : 'off'}${git.integrationBranch && git.integrationMode !== 'off' ? `; autonomous work lands on the '${git.integrationBranch}' branch, never main` : ''}`,
    `- Memory: ${listLessons(FILES.lessons).length} taught rule(s) (already loaded via CLAUDE.md)`
  ];
  if (/\(fill me/i.test(profile)) lines.push('- profile.md is not filled in yet: ask the user a few simple questions and fill it (see AGENTS.md section 1).');
  lines.push('- To run work visibly in this chat: use /harness:run <goal>. Status: /harness:status. Health check: /harness:doctor. One autonomous step: /harness:tick. Teach a rule: /harness:teach <rule>.');
  console.log(lines.join('\n'));
} catch { /* never block the session */ }
