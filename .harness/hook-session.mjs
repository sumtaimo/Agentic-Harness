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
  if (/^- .*\(fill me/im.test(profile)) lines.push('- profile.md is not filled in yet: ask the user a few simple questions and fill it (see AGENTS.md section 1).');

  // Editor workflow state: unfinished runs need a decision; AUTO MODE starts the workflow by itself.
  const VIS = path.join(path.dirname(FILES.state), 'visible');
  let runs = [];
  try { runs = fs.readdirSync(VIS).map((d) => readJsonSafe(path.join(VIS, d, 'run.json'), null)).filter(Boolean); } catch { /* no runs yet */ }
  const open = runs.filter((r) => !['PASSED', 'HALTED_HITL_REQUIRED', 'ROLLED_BACK', 'ESCALATED'].includes(r.status));
  const stopped = runs.filter((r) => ['HALTED_HITL_REQUIRED', 'ESCALATED'].includes(r.status)).slice(-1);
  if (open.length) lines.push(`- UNFINISHED editor run ${open[0].id} ("${open[0].title}", ${open[0].status}). Ask the user whether to finish it (node .harness/visible.mjs verify ${open[0].id}) or undo it (node .harness/visible.mjs rollback ${open[0].id}). Do not start another task first.`);
  else if (charter.autonomous && c.READY > 0) {
    const { nextReady } = await import('./lib/governance.mjs');
    const next = nextReady();
    lines.push(`- AUTO MODE IS ON (the owner enabled it in .harness/charter.md) and ${c.READY} task(s) are READY${next ? `; next: "${next.title || next.goal}"` : ''}. Start the autonomous workflow now with /harness:auto: you act as the orchestrator, the named agents work visibly, the controller verifies, and you report to the user at the end. If the user's message is about something else, answer it first and then offer to run the READY task(s).`);
  } else if (charter.autonomous && /\(describe your product goals here/.test(charter.text)) {
    lines.push('- Auto mode is ON but there is nothing READY and the charter objectives are not filled in, so the harness will not plan anything by itself. Add a task (node .harness/backlog.mjs add "<title>" --status READY) or fill in the objectives in .harness/charter.md.');
  }
  // Waiting for the human: big runs held by autopilot, and AI tools nobody allowed yet (headless runs need one).
  const held = readBacklog().tasks.filter((t) => t.status === 'BLOCKED' && t.needsApproval);
  if (held.length) lines.push(`- ${held.length} task(s) wait for the user's OK because they may use a lot of quota: ${held.slice(0, 3).map((t) => `${t.id} ("${t.title || t.goal}")`).join(', ')}. Tell the user; run  node .harness/backlog.mjs approve <id>  only after a clear yes for that task.`);
  const { loadApprovals } = await import('./lib/common.mjs');
  if (!Object.values(loadApprovals().engines || {}).some((v) => v === true)) lines.push('- No AI tool is allowed yet for headless runs (dispatch / daemon). The user allows each one once in a terminal: node .harness/engines.mjs. Never run "engines.mjs allow" for them.');
  // Fresh start: a new session's worktree is cut from the main folder's branch, which can be behind the remote.
  // A brand-new session worktree (clean, no commits of its own) is fast-forwarded; the main folder is only reported.
  try {
    const { execFileSync } = await import('node:child_process');
    const g = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 }).trim();
    const trees = g('worktree', 'list', '--porcelain').split('\n\n').map((b) => ({ path: (b.match(/^worktree (.+)$/m) || [])[1], branch: ((b.match(/^branch refs\/heads\/(.+)$/m) || [])[1]) }));
    const primary = trees[0];
    const upstreamOf = (br) => { try { return g('rev-parse', '--abbrev-ref', `${br}@{upstream}`); } catch { return ''; } };
    const base = primary?.branch && upstreamOf(primary.branch);
    if (base) {
      try { g('fetch', '--quiet', base.split('/')[0]); } catch { /* offline: compare with what we have */ }
      const behindMain = Number(g('rev-list', '--count', `${primary.branch}..${base}`));
      const here = g('rev-parse', '--show-toplevel').replace(/\\/g, '/');
      const isPrimary = here.toLowerCase() === String(primary.path).replace(/\\/g, '/').toLowerCase();
      if (!isPrimary) {
        const behind = Number(g('rev-list', '--count', `HEAD..${base}`));
        const ahead = Number(g('rev-list', '--count', `${base}..HEAD`));
        const clean = g('status', '--porcelain') === '';
        if (behind && !ahead && clean) { g('merge', '--ff-only', '--quiet', base); lines.push(`- This session's worktree was ${behind} commit(s) behind ${base}; fast-forwarded to it (it had no changes of its own).`); }
        else if (behind) lines.push(`- WARNING: this session is ${behind} commit(s) behind ${base} and has its own changes. Tell the user before working; update with: git merge --ff-only ${base} (or merge/rebase).`);
      }
      if (behindMain) lines.push(`- The main folder's branch "${primary.branch}" is ${behindMain} commit(s) behind ${base}, so new sessions start from old code. Tell the user; update it (in ${primary.path}): git pull --ff-only`);
    }
  } catch { /* not a git repo, or git missing: nothing to check */ }

  const { checkCore, usageTodayLine } = await import('./lib/common.mjs');
  const today = usageTodayLine(cfg);
  if (today) lines.push(`- AI quota used by the harness today: ${today}. Mention it to the user in one short line when you run harness work.`);
  const core = checkCore();
  if (core.manifest) {
    lines.push('- This project USES the harness: never edit .harness/*.mjs or .harness/lib/** (the template owns them). A harness bug is reported to the template, not patched here.');
    if (core.changed.length || core.missing.length) lines.push(`- WARNING: the harness core was edited in this project (${[...core.changed, ...core.missing].join(', ')}). Tell the user; re-installing from the template restores it.`);
  }
  if (stopped.length && !open.length) lines.push(`- A previous editor run stopped and needs a human decision: ${stopped[0].id} ("${stopped[0].title}", ${stopped[0].status}). Report it to the user if they have not seen it.`);
  lines.push('- To run work with visible named agents: use /harness:run <goal>. Autonomous: /harness:auto. Team: /harness:team. Status: /harness:status. Health check: /harness:doctor. Teach a rule: /harness:teach <rule>.');
  console.log(lines.join('\n'));
} catch { /* never block the session */ }
