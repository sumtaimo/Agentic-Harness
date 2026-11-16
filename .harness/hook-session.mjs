#!/usr/bin/env node
/**
 * .harness/hook-session.mjs — Claude Code SessionStart hook (wired in .claude/settings.json).
 * Whatever this prints is added to the editor AI's context when a session starts, so it knows the
 * harness exists, whether the controller is running, and how to work through it.
 *
 *   node .harness/hook-session.mjs          full SessionStart context for Claude Code
 *   node .harness/hook-session.mjs --brief  4–8 line summary for Antigravity, Cursor, VS Code, or terminal (read-only)
 *
 * Silent for harness workers (HARNESS_WORKER=1) and on any problem: a hook must never block a session.
 */

import fs from 'node:fs';
import path from 'node:path';

try {
  if (process.env.HARNESS_WORKER === '1') process.exit(0);
  const brief = process.argv.includes('--brief');
  const {
    FILES, DIRS, ROOT, readJsonSafe, loadConfig, listLessons, loadApprovals,
    probeEngine, engineConsent, ROUTABLE_ENGINES, checkCore, usageTodayLine
  } = await import('./lib/common.mjs');
  const { readCharter, readBacklog, backlogCounts, nextReady } = await import('./lib/governance.mjs');

  let pid = 0;
  try {
    const rawPid = Number(fs.readFileSync(FILES.pid, 'utf8').trim());
    if (Number.isInteger(rawPid) && rawPid > 0) { process.kill(rawPid, 0); pid = rawPid; }
  } catch { pid = 0; }
  const st = readJsonSafe(FILES.state, {});
  const bl = readBacklog();
  const c = backlogCounts(bl);
  const charter = readCharter();
  const cfg = loadConfig();
  const count = (d) => { try { return fs.readdirSync(d).filter((f) => f.endsWith('.json')).length; } catch { return 0; } };
  const profile = (() => { try { return fs.readFileSync(FILES.profile, 'utf8'); } catch { return ''; } })();
  const git = cfg.git || {};

  const VIS = path.join(path.dirname(FILES.state), 'visible');
  let runs = [];
  try { runs = fs.readdirSync(VIS).map((d) => readJsonSafe(path.join(VIS, d, 'run.json'), null)).filter(Boolean); } catch { /* no runs yet */ }
  const open = runs.filter((r) => !['PASSED', 'HALTED_HITL_REQUIRED', 'ROLLED_BACK', 'ESCALATED'].includes(r.status));
  const stopped = runs.filter((r) => ['HALTED_HITL_REQUIRED', 'ESCALATED'].includes(r.status)).slice(-1);
  const held = bl.tasks.filter((t) => t.status === 'BLOCKED' && t.needsApproval);
  const today = usageTodayLine(cfg);
  const core = checkCore();
  const taughtCount = listLessons(FILES.lessons).length;

  if (brief) {
    const briefLines = [
      `[Agentic Harness] Controller: ${pid ? `running (PID ${pid}, ${st.phase || '?'})` : 'NOT running'} | Backlog: READY ${c.READY}, IN_PROGRESS ${c.IN_PROGRESS}, BLOCKED ${c.BLOCKED}, DONE ${c.DONE} | Autopilot: ${charter.autonomous ? 'ON' : 'off'}`
    ];

    if (open.length) {
      const r = open[0];
      const ed = r.editor && r.editor !== 'claude-code' ? `, ${r.editor}` : '';
      briefLines.push(`! Open run ${r.id} ("${r.title}", ${r.status}${ed}): node .harness/visible.mjs handoff ${r.id} | node .harness/dispatch.mjs --resume-visible ${r.id} --wait`);
    } else if (stopped.length) {
      const s = stopped[0];
      briefLines.push(`! Stopped run ${s.id} ("${s.title}", ${s.status}): node .harness/visible.mjs handoff ${s.id} | rollback: node .harness/visible.mjs rollback ${s.id}`);
    } else if (charter.autonomous && c.READY > 0) {
      const next = nextReady(bl);
      briefLines.push(`> Autopilot next: "${next?.title || next?.goal || ''}" (${c.READY} READY) — run /harness:auto or node .harness/daemon.mjs --tick`);
    } else {
      briefLines.push(`- Status: idle, no unfinished editor runs (${taughtCount} taught rule(s) in memory)`);
    }

    if (held.length) {
      briefLines.push(`! Needs OK (${held.length} held): ${held.slice(0, 3).map((t) => `${t.id} ("${t.title || t.goal}")`).join(', ')} — approve: node .harness/backlog.mjs approve ${held[0].id}`);
    }

    try {
      const { execFileSync: run } = await import('node:child_process');
      const common = run('git', ['rev-parse', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 }).trim();
      if (fs.existsSync(path.resolve(ROOT, common, 'harness-sessions.json'))) {
        const bj = JSON.parse(run(process.execPath, [path.join(ROOT, '.harness', 'sessions.mjs'), 'board', '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }));
        const openSess = bj.tasks.filter((t) => !['MERGED', 'CLEANED'].includes(t.status));
        if (openSess.length) {
          const doneIds = openSess.filter((t) => t.status === 'DONE').map((t) => t.id);
          const risky = openSess.filter((t) => t.risk);
          const parts = [`! Sessions ${openSess.length}/${bj.maxActive} open`];
          if (doneIds.length) parts.push(`DONE to merge: ${doneIds.join(', ')}`);
          if (risky.length) parts.push(`HIGH RISK: ${risky.map((t) => `${t.id} (${t.status})`).join(', ')}`);
          briefLines.push(`${parts.join(' · ')} — node .harness/sessions.mjs board`);
        }
      }
    } catch { /* no board yet, or not a git repository */ }

    try {
      const { execFileSync } = await import('node:child_process');
      const g = (a, timeout = 4000) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout }).trim();
      const trees = g(['worktree', 'list', '--porcelain']).split('\n\n').map((b) => ({ path: (b.match(/^worktree (.+)$/m) || [])[1], branch: (b.match(/^branch refs\/heads\/(.+)$/m) || [])[1] }));
      const primary = trees[0];
      const upstreamOf = (br) => { try { return g(['rev-parse', '--abbrev-ref', `${br}@{upstream}`]); } catch { return ''; } };
      const base = primary?.branch && upstreamOf(primary.branch);
      if (base) {
        try { g(['fetch', '--quiet', base.split('/')[0]], 2000); } catch { /* offline: compare existing tracking ref */ }
        const behindMain = Number(g(['rev-list', '--count', `${primary.branch}..${base}`]));
        const curBranch = (() => { try { return g(['symbolic-ref', '--short', 'HEAD']); } catch { return ''; } })();
        const curBase = (curBranch && upstreamOf(curBranch)) || base;
        const behindHead = Number(g(['rev-list', '--count', `HEAD..${curBase}`]));
        const gitMsgs = [];
        if (behindHead > 0 && curBranch !== primary.branch) gitMsgs.push(`HEAD ${behindHead} behind ${curBase}`);
        if (behindMain > 0) gitMsgs.push(`main folder "${primary.branch}" ${behindMain} behind ${base}`);
        if (gitMsgs.length) briefLines.push(`! Git behind remote: ${gitMsgs.join(' · ')} — git pull --ff-only`);
      }
    } catch { /* not a git repo, or git missing */ }

    const envEngines = process.env.HARNESS_ENGINES !== undefined
      ? process.env.HARNESS_ENGINES.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
      : null;
    const readyTools = [];
    const awaitingTools = [];
    for (const k of ROUTABLE_ENGINES.filter((x) => cfg.profiles?.[x])) {
      const label = k === 'antigravity' ? 'agy' : k;
      if (envEngines && envEngines.length) {
        if (envEngines.includes(k) && engineConsent(k) !== false) readyTools.push(label);
        continue;
      }
      const probe = probeEngine(cfg.profiles[k]);
      if (!probe.installed || !probe.compatible) continue;
      const cState = engineConsent(k);
      if (cState === true) readyTools.push(label);
      else if (cState === undefined) awaitingTools.push(label);
    }
    const toolsStr = readyTools.length
      ? `ready (${readyTools.join(', ')})${awaitingTools.length ? `; awaiting consent (${awaitingTools.join(', ')})` : ''}`
      : awaitingTools.length
        ? `awaiting consent (${awaitingTools.join(', ')}) — node .harness/engines.mjs`
        : 'none allowed yet (node .harness/engines.mjs)';
    briefLines.push(`- AI tools: ${toolsStr} | Quota today: ${today || 'none logged'}`);

    const notes = [];
    if (core.manifest && (core.changed.length || core.missing.length)) notes.push(`harness core edited (${[...core.changed, ...core.missing].join(', ')})`);
    if (stopped.length && open.length) notes.push(`stopped run ${stopped[0].id} awaits decision`);
    if (/^- .*\(fill me/im.test(profile)) notes.push('profile.md incomplete');
    if (notes.length) briefLines.push(`! Notice: ${notes.join(' | ')}`);

    briefLines.push('- Menu: npm start (or node .harness/start.mjs) · Health: node .harness/doctor.mjs · Rules: AGENTS.md');
    console.log(briefLines.join('\n'));
    process.exit(0);
  }

  const lines = [
    '[Agentic Harness] This folder has an agentic harness (.harness/). Instructions: AGENTS.md.',
    `- Controller: ${pid ? `running (PID ${pid}), phase ${st.phase || '?'}${st.taskTitle ? `, task "${st.taskTitle}"` : ''}` : 'NOT running (start it in the background to work through the harness; see /harness:run)'}`,
    `- Backlog: READY ${c.READY}, IN_PROGRESS ${c.IN_PROGRESS}, DONE ${c.DONE}, BLOCKED ${c.BLOCKED} | inbox ${count(DIRS.inbox)} | failed jobs ${count(DIRS.failed)}`,
    `- Autonomous mode: charter says ${charter.autonomous ? 'ON' : 'off'}${git.integrationBranch && git.integrationMode !== 'off' ? `; autonomous work lands on the '${git.integrationBranch}' branch, never main` : ''}`,
    `- Memory: ${taughtCount} taught rule(s) (already loaded via CLAUDE.md)`
  ];
  if (/^- .*\(fill me/im.test(profile)) lines.push('- profile.md is not filled in yet: ask the user a few simple questions and fill it (see AGENTS.md section 1).');

  // Editor workflow state: unfinished runs need a decision; AUTO MODE starts the workflow by itself.
  if (open.length) {
    const r = open[0];
    const ed = r.editor && r.editor !== 'claude-code' ? `, from ${r.editor}` : '';
    lines.push(`- UNFINISHED editor run ${r.id} ("${r.title}", ${r.status}${ed}). Ask the user whether to finish it (node .harness/visible.mjs verify ${r.id}), hand off or continue in another AI/terminal (node .harness/visible.mjs handoff ${r.id} or node .harness/dispatch.mjs --resume-visible ${r.id} --wait), or undo it (node .harness/visible.mjs rollback ${r.id}). Do not start another task first.`);
  } else if (charter.autonomous && c.READY > 0) {
    const next = nextReady();
    lines.push(`- AUTO MODE IS ON (the owner enabled it in .harness/charter.md) and ${c.READY} task(s) are READY${next ? `; next: "${next.title || next.goal}"` : ''}. Start the autonomous workflow now with /harness:auto: you act as the orchestrator, the named agents work visibly, the controller verifies, and you report to the user at the end. If the user's message is about something else, answer it first and then offer to run the READY task(s).`);
  } else if (charter.autonomous && /\(describe your product goals here/.test(charter.text)) {
    lines.push('- Auto mode is ON but there is nothing READY and the charter objectives are not filled in, so the harness will not plan anything by itself. Add a task (node .harness/backlog.mjs add "<title>" --status READY) or fill in the objectives in .harness/charter.md.');
  }
  // Waiting for the human: big runs held by autopilot, and AI tools nobody allowed yet (headless runs need one).
  if (held.length) lines.push(`- ${held.length} task(s) wait for the user's OK because they may use a lot of quota: ${held.slice(0, 3).map((t) => `${t.id} ("${t.title || t.goal}")`).join(', ')}. Tell the user; run  node .harness/backlog.mjs approve <id>  only after a clear yes for that task.`);
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
      const { realpathSync } = await import('node:fs');
      const real = (p) => { try { return realpathSync.native(p).replace(/\\/g, '/').toLowerCase(); } catch { return String(p).replace(/\\/g, '/').toLowerCase(); } };
      const isPrimary = real(g('rev-parse', '--show-toplevel')) === real(primary.path); // real paths: short names and symlinks are the same folder
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

  // Session board (Session A + child sessions): one line, plus every HIGH RISK task, so nothing unfinished goes unnoticed.
  try {
    const { execFileSync: run } = await import('node:child_process');
    const common = run('git', ['rev-parse', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (fs.existsSync(path.resolve(ROOT, common, 'harness-sessions.json'))) {
      const bj = JSON.parse(run(process.execPath, [path.join(ROOT, '.harness', 'sessions.mjs'), 'board', '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }));
      const openSess = bj.tasks.filter((t) => !['MERGED', 'CLEANED'].includes(t.status));
      if (openSess.length) {
        const done = openSess.filter((t) => t.status === 'DONE').map((t) => t.id);
        lines.push(`- Session board: ${openSess.length}/${bj.maxActive} child task(s) open (${openSess.map((t) => `${t.id} ${t.status}`).join(', ')}).${done.length ? ` Ready to merge after the user's yes: ${done.join(', ')}.` : ''} Coordinate with /harness:sessions.`);
        for (const t of openSess.filter((x) => x.risk)) lines.push(`- HIGH RISK ${t.id} "${t.title}": ${t.note}. Tell the user.`);
      }
    }
  } catch { /* no board yet, or not a git repository */ }

  if (today) lines.push(`- AI quota used by the harness today: ${today}. Mention it to the user in one short line when you run harness work.`);
  if (core.manifest) {
    lines.push('- This project USES the harness: never edit .harness/*.mjs or .harness/lib/** (the template owns them). A harness bug is reported to the template, not patched here.');
    if (core.changed.length || core.missing.length) lines.push(`- WARNING: the harness core was edited in this project (${[...core.changed, ...core.missing].join(', ')}). Tell the user; re-installing from the template restores it.`);
  }
  if (stopped.length && !open.length) lines.push(`- A previous editor run stopped and needs a human decision: ${stopped[0].id} ("${stopped[0].title}", ${stopped[0].status}). Report it to the user if they have not seen it.`);
  lines.push('- To run work with visible named agents: use /harness:run <goal>. Autonomous: /harness:auto. Team: /harness:team. Status: /harness:status. Health check: /harness:doctor. Teach a rule: /harness:teach <rule>. Several sessions at once (Session A + up to 4 child sessions): /harness:sessions.');
  console.log(lines.join('\n'));
} catch { /* never block the session */ }
