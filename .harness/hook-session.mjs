#!/usr/bin/env node
/**
 * .harness/hook-session.mjs — Claude Code SessionStart hook (wired in .claude/settings.json).
 * Whatever this prints is added to the editor AI's context when a session starts, so it knows the
 * harness exists, whether the controller is running, and how to work through it.
 *
 *   node .harness/hook-session.mjs          full SessionStart context for Claude Code
 *   node .harness/hook-session.mjs --brief  4–8 line summary for Antigravity, Cursor, VS Code, or terminal (read-only)
 *   node .harness/hook-session.mjs --help   print this help and exit 0
 *
 * Silent for harness workers (HARNESS_WORKER=1) and on any problem: a hook must never block a session.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

try {
  const {
    FILES, DIRS, ROOT, readJsonSafe, loadConfig, listLessons, loadApprovals,
    probeEngine, engineConsent, ROUTABLE_ENGINES, checkCore, usageTodayLine, helpIfAsked, personStatus, ME_SETUP_CMD, HATS, teamLine
  } = await import('./lib/common.mjs');
  // More than one git author: people work together here, so the team page is worth offering. Cheap and never blocks.
  const gitIsShared = () => {
    try {
      const r = spawnSync('git', ['log', '-n', '200', '--format=%an'], { cwd: ROOT, encoding: 'utf8', timeout: 3000 });
      return r.status === 0 && new Set(r.stdout.split('\n').map((s) => s.trim()).filter((s) => s && s !== 'Agentic Harness')).size > 1;
    } catch { return false; }
  };
  helpIfAsked(import.meta.url);
  if (process.env.HARNESS_WORKER === '1') process.exit(0);
  const brief = process.argv.includes('--brief');
  const noFetch = process.argv.includes('--no-fetch') || process.env.HARNESS_NO_FETCH === '1';
  const { readCharter, readBacklog, backlogCounts, nextReady } = await import('./lib/governance.mjs');
  const { listVisibleRuns } = await import('./lib/handoff.mjs');

  let pid = 0;
  try {
    const rawPid = Number(fs.readFileSync(FILES.pid, 'utf8').trim());
    if (Number.isInteger(rawPid) && rawPid > 0) { process.kill(rawPid, 0); pid = rawPid; }
  } catch { pid = 0; }
  const st = readJsonSafe(FILES.state, {});
  let configError = null;
  const bl = (() => { try { return readBacklog(); } catch { return { tasks: [] }; } })();
  const c = backlogCounts(bl);
  const charter = (() => { try { return readCharter(); } catch { return { autonomous: false, text: '' }; } })();
  const cfg = (() => { try { return loadConfig(); } catch (e) { configError = e.message; return {}; } })();
  const count = (d) => { try { return fs.readdirSync(d).filter((f) => f.endsWith('.json')).length; } catch { return 0; } };
  const git = cfg.git || {};
  const person = (() => { try { return personStatus(); } catch { return { kind: 'ok', me: { fields: [], hats: [], skills: [] } }; } })();

  const runs = listVisibleRuns();
  const open = runs.filter((r) => !['PASSED', 'HALTED_HITL_REQUIRED', 'ROLLED_BACK', 'ESCALATED'].includes(r.status));
  const stopped = runs.filter((r) => ['HALTED_HITL_REQUIRED', 'ESCALATED'].includes(r.status));
  const newestOpen = open.length ? open[open.length - 1] : null;
  const newestStopped = stopped.length ? stopped[stopped.length - 1] : null;
  const held = bl.tasks.filter((t) => t.status === 'BLOCKED' && t.needsApproval);
  const inboxWaiting = count(DIRS.inbox);
  const stagingLeftovers = (() => { try { return fs.readdirSync(DIRS.staging).filter((d) => !d.startsWith('.')); } catch { return []; } })();
  const staleInProgress = (!pid && inboxWaiting === 0)
    ? (bl.tasks || []).filter((t) => t.status === 'IN_PROGRESS').map((t) => t.id)
    : [];
  const today = (() => { try { return usageTodayLine(cfg); } catch { return ''; } })();
  const core = (() => { try { return checkCore(); } catch { return { manifest: null, changed: [], missing: [], added: [] }; } })();
  const coreEdited = [...(core.changed || []), ...(core.missing || [])];
  const coreAdded = core.added || [];
  const taughtCount = (() => { try { return listLessons(FILES.lessons).length; } catch { return 0; } })();
  const autoLessonsCount = (() => { try { return listLessons(FILES.autoLessons).length; } catch { return 0; } })();
  // Installed Skill Foundry skills that are outdated or were edited: report only (never updates anything). Silent when all is fine.
  const foundryLines = await (async () => { try { return (await import('./lib/foundry-check.mjs')).foundryCheck({ root: ROOT }).lines; } catch { return []; } })();

  if (brief) {
    const briefLines = [
      `[Agentic Harness] Controller: ${pid ? `running (PID ${pid}, ${st.phase || '?'})` : 'NOT running'} | Backlog: READY ${c.READY}, IN_PROGRESS ${c.IN_PROGRESS}, BLOCKED ${c.BLOCKED}, DONE ${c.DONE} | Autopilot: ${charter.autonomous ? 'ON' : 'off'}`
    ];

    if (newestOpen) {
      const r = newestOpen;
      const ed = r.editor && r.editor !== 'claude-code' ? `, ${r.editor}` : '';
      const diag = r.lastVerify && !r.lastVerify.passed
        ? (r.lastVerify.diagnosis?.category
          ? `, ${r.lastVerify.diagnosis.category}${r.lastVerify.diagnosis.repeat ? ' REPEAT' : ''}`
          : r.lastVerify.patchSafety?.blocking?.length ? ', PATCH_SAFETY' : '')
        : '';
      briefLines.push(`! Open run ${r.id} ("${r.title}", ${r.status}${ed}${diag}): node .harness/visible.mjs handoff ${r.id} | node .harness/dispatch.mjs --resume-visible ${r.id} --wait`);
    } else if (newestStopped) {
      const s = newestStopped;
      const diag = s.lastVerify && !s.lastVerify.passed
        ? (s.lastVerify.diagnosis?.category
          ? `, ${s.lastVerify.diagnosis.category}${s.lastVerify.diagnosis.repeat ? ' REPEAT' : ''}`
          : s.lastVerify.patchSafety?.blocking?.length ? ', PATCH_SAFETY' : '')
        : '';
      briefLines.push(`! Stopped run ${s.id} ("${s.title}", ${s.status}${diag}): node .harness/visible.mjs handoff ${s.id} | rollback: node .harness/visible.mjs rollback ${s.id}`);
    } else if (charter.autonomous && c.READY > 0) {
      const next = nextReady(bl);
      briefLines.push(`> Autopilot next: "${next?.title || next?.goal || ''}" (${c.READY} READY) — run /harness:auto or node .harness/daemon.mjs --tick`);
    } else {
      briefLines.push(`- Status: idle, no unfinished editor runs (${taughtCount} taught rule(s), ${autoLessonsCount} auto-lesson(s) in memory)`);
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
        if (!noFetch) {
          try { g(['fetch', '--quiet', base.split('/')[0]], 2000); } catch { /* offline: compare existing tracking ref */ }
        }
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

    const rawEnvEngines = process.env.HARNESS_ENGINES;
    const explicitNoneEngines = rawEnvEngines !== undefined && rawEnvEngines.trim().toLowerCase() === 'none';
    const envEngines = rawEnvEngines !== undefined && !explicitNoneEngines
      ? rawEnvEngines.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
      : null;
    const readyTools = [];
    const awaitingTools = [];
    for (const k of ROUTABLE_ENGINES.filter((x) => cfg.profiles?.[x])) {
      const label = k === 'antigravity' ? 'agy' : k;
      if (explicitNoneEngines) continue;
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
    const toolsStr = configError
      ? 'unavailable (config.json invalid)'
      : readyTools.length
        ? `ready (${readyTools.join(', ')})${awaitingTools.length ? `; awaiting consent (${awaitingTools.join(', ')})` : ''}`
        : awaitingTools.length
          ? `awaiting consent (${awaitingTools.join(', ')}) — node .harness/engines.mjs`
          : 'none allowed yet (node .harness/engines.mjs)';
    briefLines.push(`- AI tools: ${toolsStr} | Quota today: ${today || 'none logged'}`);

    const notes = [];
    if (configError) notes.push(`config.json invalid (${configError.slice(0, 60)})`);
    if (core.manifest && coreEdited.length) notes.push(`harness core edited (${coreEdited.join(', ')})`);
    if (core.manifest && coreAdded.length) notes.push(`extra core file(s): ${coreAdded.slice(0, 3).join(', ')}${coreAdded.length > 3 ? ` (+${coreAdded.length - 3})` : ''}`);
    if (stagingLeftovers.length) notes.push(`staging leftovers (${stagingLeftovers.slice(0, 3).join(', ')})`);
    if (staleInProgress.length) notes.push(`stale IN_PROGRESS (${staleInProgress.slice(0, 3).join(', ')})`);
    if (newestStopped && newestOpen) notes.push(`stopped run ${newestStopped.id} awaits decision`);
    if (person.kind === 'missing') notes.push('no personal profile (me.md) on this machine');
    if (person.kind === 'other-person') notes.push(`profile.md is ${person.name}'s; git user is ${person.gitName}: create your own me.md`);
    if (notes.length) briefLines.push(`! Notice: ${notes.join(' | ')}`);

    for (const l of foundryLines) briefLines.push(`! ${l}`);
    briefLines.push('- Menu: node .harness/start.mjs (template: npm start) · Web UI: node .harness/ui.mjs · Health: node .harness/doctor.mjs · Rules: AGENTS.md');
    console.log(briefLines.join('\n'));
    process.exit(0);
  }

  const lines = [
    '[Agentic Harness] This folder has an agentic harness (.harness/). Instructions: AGENTS.md.',
    `- Controller: ${pid ? `running (PID ${pid}), phase ${st.phase || '?'}${st.taskTitle ? `, task "${st.taskTitle}"` : ''}` : 'NOT running (start it in the background to work through the harness; see /harness:run)'}`,
    `- Backlog: READY ${c.READY}, IN_PROGRESS ${c.IN_PROGRESS}, DONE ${c.DONE}, BLOCKED ${c.BLOCKED} | inbox ${inboxWaiting} | failed jobs ${count(DIRS.failed)}`,
    `- Autonomous mode: charter says ${charter.autonomous ? 'ON' : 'off'}${git.integrationBranch && git.integrationMode !== 'off' ? `; autonomous work lands on the '${git.integrationBranch}' branch, never main` : ''}`,
    `- Memory: ${taughtCount} taught rule(s) (already loaded via CLAUDE.md), ${autoLessonsCount} auto-lesson(s) (task-ranked via memory.mjs context)`
  ];
  if (configError) lines.push(`- WARNING: .harness/config.json is invalid (${configError}); fix its JSON syntax before running tasks.`);
  // The person at this machine (me.md, git-ignored). Onboarding happens in chat, never as a prompt here.
  if (person.kind === 'me') {
    const nm = person.me.fields.find((f) => f.key === 'name')?.value;
    lines.push(`- You: ${nm || '(no name)'}${person.me.hats.length ? ` | hats: ${person.me.hats.join(', ')}` : ''} (from .harness/memory/me.md; it overrides profile.md). Hats shape how you talk to this person and what you check first; they never change any permission.`);
    // The editor does not load me.md by itself (CLAUDE.md imports only profile.md), so give the chat AI every line here.
    for (const f of person.me.fields) if (!['name', 'hats', 'personal skills'].includes(f.key)) lines.push(`  - ${f.label}: ${f.value}`);
    if (person.me.skills.length) lines.push(`- Personal skills of this person (chat only, never for harness workers): ${person.me.skills.join(', ')}`);
  } else if (person.kind === 'missing') {
    lines.push(`- No personal profile on this machine yet (.harness/memory/me.md, git-ignored). Ask the user, a few at a time in simple words: name, what they do, language for answers, coding experience, how they like answers, and their hats (${HATS.join(', ')}; combinable, e.g. "po, qa"). Then save: ${ME_SETUP_CMD}`);
  } else if (person.kind === 'other-person') {
    lines.push(`- profile.md describes ${person.name}, but the git user here is ${person.gitName}${person.known ? ` (${person.known} on the team page)` : ''}. If this is a different person, ask their name, language, answer style and hats (${HATS.join(', ')}) and save them in their own me.md: ${ME_SETUP_CMD}. Do not edit profile.md for this.`);
  }
  // Older projects keep personal lines in the shared profile.md. Offer once per session to move them (owner's yes).
  if (person.legacy && person.kind !== 'other-person') lines.push('- profile.md still holds personal lines (name, language, answer style…). Since 1.0.26 it describes only the project and each person keeps those in their own me.md. Offer to move them (ask first; it edits the shared profile.md): node .harness/memory.mjs me from-profile');
  // The shared team page (people.md, committed): who wears which hat. Only what each person chose to share.
  const team = (() => { try { return teamLine(); } catch { return ''; } })();
  if (team) lines.push(`- Team (people.md): ${team}. When a decision needs a hat this person does not wear, say who to ask.`);
  else if (person.kind === 'me' && gitIsShared()) lines.push('- No team page yet. To let teammates see your name, hats and what to ask you about, offer: node .harness/memory.mjs me share --ask "…" --language --git (it never shares answer style, experience or personal skills).');

  // Editor workflow state: unfinished runs need a decision; AUTO MODE starts the workflow by itself.
  if (newestOpen) {
    const r = newestOpen;
    const ed = r.editor && r.editor !== 'claude-code' ? `, from ${r.editor}` : '';
    const diag = r.lastVerify && !r.lastVerify.passed
      ? (r.lastVerify.diagnosis?.category
        ? `, last failure: ${r.lastVerify.diagnosis.category}${r.lastVerify.diagnosis.repeat ? ' REPEAT' : ''}`
        : r.lastVerify.patchSafety?.blocking?.length ? ', last failure: PATCH_SAFETY' : '')
      : '';
    lines.push(`- UNFINISHED editor run ${r.id} ("${r.title}", ${r.status}${ed}${diag}). Ask the user whether to finish it (node .harness/visible.mjs verify ${r.id}), hand off or continue in another AI/terminal (node .harness/visible.mjs handoff ${r.id} or node .harness/dispatch.mjs --resume-visible ${r.id} --wait), or undo it (node .harness/visible.mjs rollback ${r.id}). Do not start another task first.`);
  } else if (charter.autonomous && c.READY > 0) {
    const next = nextReady();
    lines.push(`- AUTO MODE IS ON (the owner enabled it in .harness/charter.md) and ${c.READY} task(s) are READY${next ? `; next: "${next.title || next.goal}"` : ''}. Start the autonomous workflow now with /harness:auto: you act as the orchestrator, the named agents work visibly, the controller verifies, and you report to the user at the end. If the user's message is about something else, answer it first and then offer to run the READY task(s).`);
  } else if (charter.autonomous && /\(describe your product goals here/.test(charter.text)) {
    lines.push('- Auto mode is ON but there is nothing READY and the charter objectives are not filled in, so the harness will not plan anything by itself. Add a task (node .harness/backlog.mjs add "<title>" --status READY) or fill in the objectives in .harness/charter.md.');
  }
  // Waiting for the human: big runs held by autopilot, and AI tools nobody allowed yet (headless runs need one).
  if (held.length) lines.push(`- ${held.length} task(s) wait for the user's OK because they may use a lot of quota: ${held.slice(0, 3).map((t) => `${t.id} ("${t.title || t.goal}")`).join(', ')}. Tell the user; run  node .harness/backlog.mjs approve <id>  only after a clear yes for that task.`);
  if (staleInProgress.length) lines.push(`- WARNING: ${staleInProgress.length} backlog task(s) still marked IN_PROGRESS with no controller running (${staleInProgress.join(', ')}). Reset with: node .harness/backlog.mjs ready <id>`);
  if (stagingLeftovers.length) lines.push(`- WARNING: .harness/staging/ still has backup folder(s) from an interrupted run (${stagingLeftovers.join(', ')}). Inspect or clean them if no run is active.`);
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
      if (!noFetch) {
        try { g('fetch', '--quiet', base.split('/')[0]); } catch { /* offline: compare with what we have */ }
      }
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
        for (const t of openSess.filter((x) => x.risk)) lines.push(`- HIGH RISK ${t.id} "${t.title}": ${t.note} (inspect: node .harness/sessions.mjs handoff ${t.id}). Tell the user.`);
      }
    }
  } catch { /* no board yet, or not a git repository */ }

  if (today) lines.push(`- AI quota used by the harness today: ${today}. Mention it to the user in one short line when you run harness work.`);
  if (core.manifest) {
    lines.push('- This project USES the harness: never edit .harness/*.mjs or .harness/lib/** (the template owns them). A harness bug is reported to the template, not patched here.');
    if (coreEdited.length) lines.push(`- WARNING: the harness core was edited in this project (${coreEdited.join(', ')}). Tell the user; re-installing from the template restores it.`);
    if (coreAdded.length) lines.push(`- WARNING: unmanifested core file(s) found in .harness/ (${coreAdded.join(', ')}). Tell the user; core files belong to the template.`);
  }
  if (newestStopped && !newestOpen) {
    const s = newestStopped;
    const diag = s.lastVerify && !s.lastVerify.passed
      ? (s.lastVerify.diagnosis?.category
        ? `, ${s.lastVerify.diagnosis.category}${s.lastVerify.diagnosis.repeat ? ' REPEAT' : ''}`
        : s.lastVerify.patchSafety?.blocking?.length ? ', PATCH_SAFETY' : '')
      : '';
    lines.push(`- A previous editor run stopped and needs a human decision: ${s.id} ("${s.title}", ${s.status}${diag}). Report it to the user if they have not seen it.`);
  }
  for (const l of foundryLines) lines.push(`- ${l}`);
  lines.push('- To run work with visible named agents: use /harness:run <goal>. Autonomous: /harness:auto. Team: /harness:team. Status: /harness:status. Health check: /harness:doctor. Teach a rule: /harness:teach <rule>. Several sessions at once (Session A + up to 4 child sessions): /harness:sessions.');
  console.log(lines.join('\n'));
} catch { /* never block the session */ }
