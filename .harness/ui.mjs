#!/usr/bin/env node
/**
 * .harness/ui.mjs — read-only local web dashboard for the Agentic Harness (127.0.0.1 only).
 *
 *   npm run ui                         start dashboard on http://127.0.0.1:4173/ (auto-opens browser)
 *   node .harness/ui.mjs               same (default port 4173)
 *   node .harness/ui.mjs --port 8080   listen on a custom port (0 picks a free port automatically)
 *   node .harness/ui.mjs --no-open     start the server without launching a browser window
 *   node .harness/ui.mjs --help        print this help and exit 0
 *
 * Zero dependencies, completely offline (no external CDN scripts or styles), strictly read-only
 * (non-GET/HEAD requests return 405), and bound exclusively to 127.0.0.1.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ROOT, HARNESS_DIR, FILES, loadConfig, readJsonSafe, aiUsageSince,
  quotaWarnings, formatQuotaWarning, helpIfAsked
} from './lib/common.mjs';
import { readBacklog, backlogCounts, nextReady } from './lib/governance.mjs';
import { needsYou } from './lib/waiting.mjs';
import { featureProgress } from './lib/feature.mjs';
import { huntProgress } from './lib/hunt.mjs';
import { listVisibleRuns, editorDisplayName } from './lib/handoff.mjs';
import { collectStatus } from './start.mjs';

const DEFAULT_PORT = 4173;

function safeLoadConfig() {
  try { return loadConfig(); } catch { return {}; }
}

export function readStatusData({ skipSessions = false } = {}) {
  const status = collectStatus({ skipSessions });
  const state = readJsonSafe(FILES.state, {});
  return {
    ts: new Date().toISOString(),
    ...status,
    state: {
      phase: state.phase || null,
      cycle: state.cycle ?? null,
      maxCycles: state.maxCycles ?? null,
      engine: state.engine || null,
      mode: state.mode || null,
      workerSummary: state.workerSummary || null,
      lastGateStatus: state.lastGateStatus || null,
      autoStatus: state.autoStatus || null,
      updatedAt: state.updatedAt || null
    }
  };
}

export function readLogsData(limit = 100) {
  let allLive = [];
  try {
    allLive = fs.readFileSync(FILES.live, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0);
  } catch { /* no live log yet */ }

  const telemetry = [];
  try {
    const lines = fs.readFileSync(FILES.log, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object') telemetry.push(parsed);
      } catch { /* skip malformed line */ }
    }
  } catch { /* no telemetry log yet */ }

  return {
    ts: new Date().toISOString(),
    liveTotal: allLive.length,
    live: allLive.slice(-limit),
    telemetryTotal: telemetry.length,
    telemetry: telemetry.slice(-limit)
  };
}

export function readUsageData(days = 7) {
  const cfg = safeLoadConfig();
  const todayIso = `${new Date().toISOString().slice(0, 10)}T00:00:00`;
  const today = aiUsageSince(todayIso);
  for (const row of Object.values(today)) row.usd = Math.round((Number(row.usd) || 0) * 1e6) / 1e6;

  const spanDays = Math.max(1, Math.min(365, Number(days) || 7));
  const since = new Date(Date.now() - (spanDays - 1) * 86400000).toISOString().slice(0, 10);
  const rows = [];
  try {
    for (const line of fs.readFileSync(FILES.log, 'utf8').split(/\r?\n/)) {
      if (!line.includes('"AGENT_USAGE"')) continue;
      try {
        const e = JSON.parse(line);
        if (e && typeof e.ts === 'string' && e.ts.slice(0, 10) >= since) rows.push(e);
      } catch { /* skip malformed line */ }
    }
  } catch { /* no log yet */ }

  const byDay = {};
  const totals = {};
  for (const e of rows) {
    const day = e.ts.slice(0, 10);
    const engine = e.engine || 'unknown';
    const model = e.model || 'CLI default';
    const key = `${engine}|${model}`;
    const d = (byDay[day] ||= {});
    const item = (d[key] ||= { engine, model, calls: 0, failed: 0, tokens: 0, tokensKnown: 0, usd: 0, minutes: 0 });
    item.calls += 1;
    if (!e.ok) item.failed += 1;
    if (typeof e.tokens === 'number') { item.tokens += e.tokens; item.tokensKnown += 1; }
    item.usd = Math.round((item.usd + (Number(e.usd) || 0)) * 1e6) / 1e6;
    item.minutes = Math.round((item.minutes + (Number(e.ms) || 0) / 60000) * 100) / 100;

    const tot = (totals[engine] ||= { calls: 0, failed: 0, tokens: 0, usd: 0, minutes: 0 });
    tot.calls += 1;
    if (!e.ok) tot.failed += 1;
    if (typeof e.tokens === 'number') tot.tokens += e.tokens;
    tot.usd = Math.round((tot.usd + (Number(e.usd) || 0)) * 1e6) / 1e6;
    tot.minutes = Math.round((tot.minutes + (Number(e.ms) || 0) / 60000) * 100) / 100;
  }

  const dailyLimits = {};
  if (cfg.dailyLimits && typeof cfg.dailyLimits === 'object') {
    for (const [k, v] of Object.entries(cfg.dailyLimits)) {
      if (k !== 'note' && v && typeof v === 'object') dailyLimits[k] = v;
    }
  }

  const warnings = (() => {
    try {
      return quotaWarnings(cfg).map((w) => ({ ...w, message: formatQuotaWarning(w, cfg) }));
    } catch { return []; }
  })();

  return {
    ts: new Date().toISOString(),
    rangeDays: spanDays,
    dailyLimits,
    today,
    days7: { since, days: spanDays, byDay, totals },
    warnings
  };
}

export function readBacklogData() {
  const b = (() => {
    try { return readBacklog(); } catch { return { version: '2.0.0', project: '', tasks: [] }; }
  })();
  const tasks = Array.isArray(b.tasks) ? b.tasks : [];
  return {
    ts: new Date().toISOString(),
    project: b.project || '',
    maxAutoTasksPerRun: b.maxAutoTasksPerRun ?? 3,
    counts: backlogCounts(b),
    next: nextReady(b),
    tasks,
    // read-only views of the same backlog file: what waits for the owner, and how far features and bug hunts got
    needsYou: (() => { try { return needsYou(b); } catch { return []; } })(),
    features: (() => { try { return featureProgress(b); } catch { return []; } })(),
    hunts: (() => { try { return huntProgress(b); } catch { return []; } })()
  };
}

export function readSessionsData() {
  const ts = new Date().toISOString();
  let common = '';
  try {
    common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000
    }).trim();
  } catch {
    return { ts, status: 'unavailable', reason: 'Not a git repository (or git unavailable).', base: null, maxActive: 4, tasks: [] };
  }
  if (!common) {
    return { ts, status: 'unavailable', reason: 'Git common dir unavailable.', base: null, maxActive: 4, tasks: [] };
  }

  const boardFile = path.resolve(ROOT, common, 'harness-sessions.json');
  if (!fs.existsSync(boardFile)) {
    return { ts, status: 'ok', base: null, maxActive: 4, tasks: [] };
  }

  try {
    const raw = execFileSync(process.execPath, [path.join(HARNESS_DIR, 'sessions.mjs'), 'board', '--json'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000
    });
    const data = JSON.parse(raw);
    return {
      ts,
      status: 'ok',
      base: data.base || null,
      maxActive: data.maxActive || 4,
      tasks: Array.isArray(data.tasks) ? data.tasks : []
    };
  } catch {
    return { ts, status: 'unavailable', reason: 'Unable to read git session board.', base: null, maxActive: 4, tasks: [] };
  }
}

export function readVisibleData() {
  const runs = listVisibleRuns().map((r) => ({
    ...r,
    editorLabel: editorDisplayName(r.editor || 'claude-code')
  }));
  return {
    ts: new Date().toISOString(),
    runs
  };
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agentic Harness — Local Dashboard</title>
<style>
  :root {
    --bg: #0f172a;
    --panel: #1e293b;
    --panel-alt: #0b1220;
    --border: #334155;
    --text: #e2e8f0;
    --muted: #94a3b8;
    --accent: #38bdf8;
    --ok: #22c55e;
    --warn: #f59e0b;
    --err: #ef4444;
    --pill-bg: #334155;
    --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    --sans: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f8fafc;
      --panel: #ffffff;
      --panel-alt: #f1f5f9;
      --border: #cbd5e1;
      --text: #0f172a;
      --muted: #475569;
      --accent: #0284c7;
      --ok: #15803d;
      --warn: #b45309;
      --err: #b91c1c;
      --pill-bg: #e2e8f0;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: var(--sans);
    background: var(--bg);
    color: var(--text);
    line-height: 1.45;
  }
  header {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    padding: 14px 20px;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    z-index: 10;
  }
  .brand { display: flex; flex-direction: column; gap: 2px; }
  .brand-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  h1 { margin: 0; font-size: 1.1rem; font-weight: 700; }
  .root-path { font-family: var(--mono); font-size: 0.78rem; color: var(--muted); word-break: break-all; }
  .controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  button {
    background: var(--panel-alt);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 6px 12px;
    font-size: 0.85rem;
    cursor: pointer;
  }
  button:hover { border-color: var(--accent); }
  button.active { border-color: var(--accent); color: var(--accent); font-weight: 600; }
  .seg-btn { padding: 3px 8px; font-size: 0.75rem; }
  .pill-group { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .pill {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 0.74rem;
    font-weight: 600;
    background: var(--pill-bg);
    color: var(--text);
    font-family: var(--mono);
  }
  .pill.ok { background: rgba(34, 197, 94, 0.18); color: var(--ok); border: 1px solid rgba(34, 197, 94, 0.4); }
  .pill.warn { background: rgba(245, 158, 11, 0.18); color: var(--warn); border: 1px solid rgba(245, 158, 11, 0.4); }
  .pill.err { background: rgba(239, 68, 68, 0.18); color: var(--err); border: 1px solid rgba(239, 68, 68, 0.4); }
  .pill.info { background: rgba(56, 189, 248, 0.15); color: var(--accent); border: 1px solid rgba(56, 189, 248, 0.4); }
  main { max-width: 1360px; margin: 0 auto; padding: 16px 20px 36px; display: flex; flex-direction: column; gap: 16px; }
  .alerts { display: flex; flex-direction: column; gap: 8px; }
  .alert {
    padding: 10px 14px;
    border-radius: 8px;
    font-size: 0.88rem;
    border: 1px solid var(--warn);
    background: rgba(245, 158, 11, 0.12);
  }
  .alert.err { border-color: var(--err); background: rgba(239, 68, 68, 0.12); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 16px; }
  .card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
  }
  .card h2 {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 700;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .kv { display: grid; grid-template-columns: 120px 1fr; gap: 6px 10px; font-size: 0.86rem; }
  .kv .k { color: var(--muted); }
  .kv .v { font-family: var(--mono); word-break: break-word; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; white-space: nowrap; }
  td.mono, th.mono { font-family: var(--mono); }
  .badge-row { display: flex; flex-wrap: wrap; gap: 6px; }
  pre.log-box {
    margin: 0;
    background: var(--panel-alt);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 12px;
    font-family: var(--mono);
    font-size: 0.78rem;
    max-height: 290px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .muted { color: var(--muted); font-size: 0.84rem; }
  .full { grid-column: 1 / -1; }
  @media (max-width: 600px) {
    .grid { grid-template-columns: 1fr; }
    .kv { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<header>
  <div class="brand">
    <div class="brand-row">
      <h1>Agentic Harness</h1>
      <span id="version-pill" class="pill">--</span>
      <span class="pill info">READ-ONLY · 127.0.0.1</span>
      <span id="conn-pill" class="pill ok">Live</span>
    </div>
    <div id="root-path" class="root-path">Loading workspace...</div>
  </div>
  <div class="controls">
    <span id="updated-at" class="muted">--</span>
    <button id="toggle-live" type="button">Pause refresh</button>
    <button id="refresh-now" type="button">Refresh now</button>
  </div>
</header>

<main>
  <section id="alerts" class="alerts"></section>

  <div class="grid">
    <section class="card">
      <h2><span>Controller &amp; Verification</span><span id="ctrl-pill" class="pill">--</span></h2>
      <div id="ctrl-kv" class="kv"></div>
    </section>

    <section class="card">
      <h2><span>AI Engines &amp; Daily Quota</span><span id="engines-pill" class="pill">--</span></h2>
      <div id="engines-badges" class="badge-row"></div>
      <div id="usage-today" class="kv"></div>
    </section>

    <section class="card">
      <h2><span>Governance, Team &amp; Git</span><span id="mem-pill" class="pill">--</span></h2>
      <div id="gov-kv" class="kv"></div>
    </section>

    <section class="card">
      <h2><span>Backlog</span><span id="backlog-pill" class="pill">--</span></h2>
      <div id="backlog-counts" class="badge-row"></div>
      <div id="backlog-body" class="table-wrap"></div>
    </section>

    <section class="card">
      <h2><span>Needs you · Features · Bug hunts</span><span id="needs-pill" class="pill">--</span></h2>
      <div id="needs-body" class="table-wrap"></div>
      <div id="features-body" class="table-wrap"></div>
    </section>

    <section class="card">
      <h2>
        <span id="usage-title">7-Day Quota &amp; Usage</span>
        <span class="pill-group">
          <button id="usage-7d" type="button" class="seg-btn active">7d</button>
          <button id="usage-30d" type="button" class="seg-btn">30d</button>
          <span id="usage-since" class="pill">--</span>
        </span>
      </h2>
      <div id="usage-body" class="table-wrap"></div>
    </section>

    <section class="card">
      <h2><span>Editor Runs (Visible)</span><span id="visible-pill" class="pill">--</span></h2>
      <div id="visible-body" class="table-wrap"></div>
    </section>

    <section class="card">
      <h2><span>Session Board (Git Worktrees)</span><span id="sessions-pill" class="pill">--</span></h2>
      <div id="sessions-body" class="table-wrap"></div>
    </section>

    <section class="card">
      <h2><span>Live Feed (.harness/live.log)</span><span id="live-count" class="pill">0 lines</span></h2>
      <pre id="live-log" class="log-box">Loading...</pre>
    </section>

    <section class="card">
      <h2><span>Recent Telemetry (.harness/telemetry.log)</span><span id="tel-count" class="pill">0 events</span></h2>
      <div id="tel-body" class="table-wrap"></div>
    </section>
  </div>
</main>

<script>
(() => {
  const el = (tag, attrs, children) => {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'className') node.className = v;
        else if (v !== undefined && v !== null) node.setAttribute(k, String(v));
      }
    }
    const list = Array.isArray(children) ? children : children !== undefined ? [children] : [];
    for (const child of list) {
      if (child === undefined || child === null) continue;
      node.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
    }
    return node;
  };

  const pillClassForStatus = (s) => {
    const val = String(s || '').toUpperCase();
    if (['READY', 'PASSED', 'DONE', 'OK', 'MERGED', 'CLEANED', 'RUNNING'].includes(val)) return 'pill ok';
    if (['BLOCKED', 'FAILED', 'ERROR', 'CHECK FAILED', 'HALTED_HITL_REQUIRED', 'ESCALATED', 'DENIED', 'INCOMPATIBLE'].includes(val)) return 'pill err';
    if (['IN_PROGRESS', 'WORKING', 'BRIEFED', 'DELEGATED', 'AWAITING CONSENT'].includes(val)) return 'pill warn';
    return 'pill';
  };

  const makeTable = (headers, rows) => {
    const thead = el('thead', null, el('tr', null, headers.map((h) => el('th', null, h))));
    const tbody = el('tbody', null, rows.map((r) => el('tr', null, r.map((cell) => el('td', cell && cell.mono ? { className: 'mono' } : null, cell && cell.node ? cell.node : cell)))));
    return el('table', null, [thead, tbody]);
  };

  let liveRefresh = true;
  let inFlight = false;
  let selectedDays = 7;
  const connPill = document.getElementById('conn-pill');
  const toggleBtn = document.getElementById('toggle-live');
  const refreshBtn = document.getElementById('refresh-now');
  const usage7dBtn = document.getElementById('usage-7d');
  const usage30dBtn = document.getElementById('usage-30d');

  toggleBtn.addEventListener('click', () => {
    liveRefresh = !liveRefresh;
    toggleBtn.textContent = liveRefresh ? 'Pause refresh' : 'Resume refresh';
    connPill.className = liveRefresh ? 'pill ok' : 'pill warn';
    connPill.textContent = liveRefresh ? 'Live' : 'Paused';
  });

  usage7dBtn.addEventListener('click', () => {
    if (selectedDays === 7) return;
    selectedDays = 7;
    usage7dBtn.classList.add('active');
    usage30dBtn.classList.remove('active');
    refresh();
  });

  usage30dBtn.addEventListener('click', () => {
    if (selectedDays === 30) return;
    selectedDays = 30;
    usage30dBtn.classList.add('active');
    usage7dBtn.classList.remove('active');
    refresh();
  });

  async function fetchJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(url + ' -> HTTP ' + res.status);
    return res.json();
  }

  function renderAlerts(status, usage, sessions) {
    const box = document.getElementById('alerts');
    const items = [];
    if (status.configError) {
      items.push(el('div', { className: 'alert err' }, 'Config error: ' + status.configError));
    }
    if (Array.isArray(status.coreModified) && status.coreModified.length) {
      items.push(el('div', { className: 'alert err' }, 'Harness core files differ from MANIFEST.json: ' + status.coreModified.join(', ')));
    }
    if (status.team && !status.team.valid) {
      items.push(el('div', { className: 'alert err' }, 'Team configuration invalid: ' + (status.team.errors || []).join('; ')));
    } else if (status.team && Array.isArray(status.team.staleAgents) && status.team.staleAgents.length) {
      items.push(el('div', { className: 'alert' }, 'Editor agent files out of sync with team.json: ' + status.team.staleAgents.join(', ') + ' — run: node .harness/team.mjs sync-agents'));
    }
    for (const w of (usage.warnings || status.quotaWarnings || [])) {
      items.push(el('div', { className: w.over ? 'alert err' : 'alert' }, w.message || ('Quota warning: ' + w.label + ' at ' + w.pct + '%')));
    }
    if (status.backlog && Array.isArray(status.backlog.held) && status.backlog.held.length) {
      const desc = status.backlog.held.map((h) => h.id + ' ("' + h.title + '") — run: node .harness/backlog.mjs approve ' + h.id).join(' | ');
      items.push(el('div', { className: 'alert' }, 'Needs your OK (' + status.backlog.held.length + ' held): ' + desc));
    }
    if (status.visible && Array.isArray(status.visible.open) && status.visible.open.length) {
      const desc = status.visible.open.slice(0, 3).map((r) => r.id + ' (' + r.status + ': "' + r.title + '")').join(', ');
      const firstId = status.visible.open[0].id;
      items.push(el('div', { className: 'alert' }, 'Open editor run(s): ' + desc + ' — inspect: node .harness/visible.mjs handoff ' + firstId + ' | resume: node .harness/dispatch.mjs --resume-visible ' + firstId + ' --wait'));
    }
    if (status.visible && Array.isArray(status.visible.stopped) && status.visible.stopped.length) {
      const desc = status.visible.stopped.slice(0, 3).map((r) => r.id + ' (' + r.status + ': "' + r.title + '")').join(', ');
      const firstId = status.visible.stopped[0].id;
      items.push(el('div', { className: 'alert err' }, 'Stopped editor run(s) need human decision: ' + desc + ' — inspect: node .harness/visible.mjs handoff ' + firstId));
    }
    if (sessions && sessions.status === 'ok' && Array.isArray(sessions.tasks)) {
      const active = sessions.tasks.filter((t) => !['MERGED', 'CLEANED'].includes(t.status));
      const risky = active.filter((t) => t.risk);
      const done = active.filter((t) => t.status === 'DONE' && !t.risk);
      if (risky.length) {
        const desc = risky.map((t) => t.id + ' (' + t.status + ': ' + (t.note || t.title || '') + ')').join(' | ');
        items.push(el('div', { className: 'alert err' }, 'Child session HIGH RISK: ' + desc + ' — run: node .harness/sessions.mjs handoff ' + risky[0].id));
      }
      if (done.length) {
        items.push(el('div', { className: 'alert' }, 'Child session(s) DONE and waiting for your merge approval: ' + done.map((t) => t.id).join(', ') + ' — run: node .harness/sessions.mjs merge ' + done[0].id));
      }
    }
    const warns = status.warnings || {};
    if (Array.isArray(warns.stagingLeftovers) && warns.stagingLeftovers.length) {
      items.push(el('div', { className: 'alert' }, 'Staging backup leftovers in .harness/staging/: ' + warns.stagingLeftovers.join(', ')));
    }
    if (Array.isArray(warns.staleInProgress) && warns.staleInProgress.length) {
      items.push(el('div', { className: 'alert' }, 'Stale IN_PROGRESS backlog task(s) with no active controller: ' + warns.staleInProgress.join(', ') + ' — reset: node .harness/backlog.mjs ready ' + warns.staleInProgress[0]));
    }
    box.replaceChildren(...items);
  }

  function renderStatus(status) {
    document.getElementById('root-path').textContent = status.root || '';
    const vPill = document.getElementById('version-pill');
    if (status.version) {
      vPill.textContent = 'v' + status.version;
      vPill.style.display = 'inline-block';
    } else {
      vPill.style.display = 'none';
    }

    const ctrlPill = document.getElementById('ctrl-pill');
    const c = status.controller || {};
    ctrlPill.className = c.running ? 'pill ok' : 'pill';
    ctrlPill.textContent = c.running ? ('Running PID ' + c.pid) : 'Stopped';

    const verifyStr = status.verify
      ? (status.verify.cmd + (status.verify.real ? ' (' + status.verify.source + ')' : ' (NO real check)'))
      : '(unknown)';
    const st = status.state || {};
    const q = status.queues || {};
    const cycleInfo = st.cycle ? ' (cycle ' + st.cycle + '/' + (st.maxCycles || 3) + ')' : '';
    const rawPhase = c.phase || st.phase || 'idle';
    const phaseText = c.running
      ? (rawPhase + cycleInfo)
      : (st.phase ? ('Stopped (last: ' + st.phase + ')' + cycleInfo) : 'Stopped / idle');
    const rows = [
      ['Phase', phaseText],
      ['Task', c.taskTitle || '(none)'],
      ['Engine / Mode', (st.engine || '-') + ' / ' + (st.mode || '-')],
      ['Workers', st.workerSummary || '-'],
      ['Autopilot', status.autonomous ? ('ON' + (st.autoStatus && st.autoStatus !== 'off' ? ' (' + st.autoStatus + ')' : '')) : 'off'],
      ['Verify cmd', verifyStr],
      ['Last gate', st.lastGateStatus || '-'],
      ['Queues', 'inbox ' + (q.inbox || 0) + ' · completed ' + (q.completed || 0) + ' · failed ' + (q.failed || 0)],
      ['Updated', st.updatedAt || '-']
    ];
    const kv = document.getElementById('ctrl-kv');
    kv.replaceChildren(...rows.flatMap(([k, v]) => [
      el('div', { className: 'k' }, k),
      el('div', { className: 'v' }, v)
    ]));

    const engines = status.engines || [];
    const readyCount = engines.filter((e) => e.status === 'ready').length;
    const engPill = document.getElementById('engines-pill');
    engPill.className = readyCount > 0 ? 'pill ok' : 'pill warn';
    engPill.textContent = readyCount + '/' + engines.length + ' ready';

    const engBox = document.getElementById('engines-badges');
    engBox.replaceChildren(...(engines.length
      ? engines.map((e) => el('span', { className: pillClassForStatus(e.status) }, e.name + ': ' + e.status))
      : [el('span', { className: 'muted' }, 'No engines configured')]));

    const todayBox = document.getElementById('usage-today');
    todayBox.replaceChildren(
      el('div', { className: 'k' }, 'Today summary'),
      el('div', { className: 'v' }, status.usageToday || 'No AI calls logged today (UTC)')
    );

    const warns = status.warnings || {};
    document.getElementById('mem-pill').textContent = (status.taughtCount || 0) + ' taught · ' + (warns.autoLessonsCount || 0) + ' auto';
    const ch = status.charter || {};
    const chStr = ch.exists
      ? ('autonomous: ' + (ch.autonomous ? 'ON' : 'off') + ', maxAuto: ' + (ch.maxAutoTasksPerRun ?? 3) + ', realCheck: ' + (ch.requireRealCheck !== false ? 'yes' : 'no') + (ch.hasPlaceholder ? ' [placeholder goals]' : ''))
      : 'not found';
    const tm = status.team;
    const tmStr = !tm
      ? 'no team.json'
      : tm.valid
        ? ('valid (' + tm.leadCount + ' leads, ' + tm.routedCount + ' routed; agents ' + (tm.agentsInSync ? 'in sync' : tm.staleAgents.length + ' stale') + ')')
        : ('INVALID (' + tm.errorCount + ' err)');
    const gt = status.git || {};
    const gtStr = !gt.isRepo
      ? 'not a git repository'
      : (gt.branch + (gt.dirtyCount ? ' (' + gt.dirtyCount + ' dirty)' : ' (clean)') + (gt.uatExists ? ' · ' + (gt.integrationBranch || 'uat') + '@' + gt.uatTip : '') + (gt.workerBranches ? ' · ' + gt.workerBranches + ' worker branch(es)' : ''));
    const govRows = [
      ['Charter', chStr],
      ['Team', tmStr],
      ['Git', gtStr],
      ['Profile', warns.profileIncomplete ? 'not set up (node .harness/memory.mjs me set …)' : warns.otherPerson ? ('profile.md belongs to ' + warns.otherPerson.profileName + ': create your own me.md') : 'ready']
    ];
    document.getElementById('gov-kv').replaceChildren(...govRows.flatMap(([k, v]) => [
      el('div', { className: 'k' }, k),
      el('div', { className: 'v' }, v)
    ]));
  }

  function renderBacklog(bl) {
    const c = bl.counts || {};
    const allTasks = Array.isArray(bl.tasks) ? bl.tasks : [];
    const total = allTasks.length;
    document.getElementById('backlog-pill').textContent = total + ' task(s)';
    const countsBox = document.getElementById('backlog-counts');
    countsBox.replaceChildren(
      el('span', { className: 'pill ok' }, 'READY ' + (c.READY || 0)),
      el('span', { className: 'pill warn' }, 'IN_PROGRESS ' + (c.IN_PROGRESS || 0)),
      el('span', { className: 'pill err' }, 'BLOCKED ' + (c.BLOCKED || 0)),
      el('span', { className: 'pill' }, 'DONE ' + (c.DONE || 0)),
      el('span', { className: 'pill' }, 'BACKLOG ' + (c.BACKLOG || 0))
    );
    const body = document.getElementById('backlog-body');
    const rank = { IN_PROGRESS: 0, READY: 1, BLOCKED: 2, BACKLOG: 3, DONE: 4 };
    const tasks = [...allTasks].sort((a, b) => {
      const ra = rank[a.status || 'BACKLOG'] ?? 3;
      const rb = rank[b.status || 'BACKLOG'] ?? 3;
      if (ra !== rb) return ra - rb;
      return (a.priority ?? 99) - (b.priority ?? 99);
    }).slice(0, 25);
    if (!tasks.length) {
      body.replaceChildren(el('div', { className: 'muted' }, 'Backlog is empty.'));
      return;
    }
    const table = makeTable(
      ['ID', 'Status', 'Role', 'Title'],
      tasks.map((t) => [
        { mono: true, node: el('span', null, t.id) },
        { node: el('span', { className: pillClassForStatus(t.status) }, t.status || 'BACKLOG') },
        { mono: true, node: el('span', null, t.role || '-') },
        el('span', null, (t.title || t.goal || '-') + (t.blockedReason ? ' [' + t.blockedReason + ']' : ''))
      ])
    );
    const nodes = [table];
    if (allTasks.length > 25) nodes.push(el('div', { className: 'muted' }, 'Showing top 25 of ' + allTasks.length + ' tasks.'));
    body.replaceChildren(...nodes);
  }

  function renderNeeds(bl) {
    const list = Array.isArray(bl.needsYou) ? bl.needsYou : [];
    const pill = document.getElementById('needs-pill');
    pill.textContent = list.length ? list.length + ' need you' : 'nothing waiting';
    pill.className = list.length ? 'pill warn' : 'pill ok';
    document.getElementById('needs-body').replaceChildren(list.length
      ? makeTable(['What', 'Waiting for you', 'Next command'], list.slice(0, 12).map((w) => [
        { mono: true, node: el('span', null, w.id) }, el('span', null, w.text), { mono: true, node: el('span', null, w.next) }]))
      : el('div', { className: 'muted' }, 'Nothing waits for you.'));
    const rows = [...(bl.features || []).map((f) => [f.id, 'feature', f.goal, f.status, f.kept ? f.done + '/' + f.kept + ' done' + (f.blocked ? ', ' + f.blocked + ' blocked' : '') : f.steps + ' step(s)']),
      ...(bl.hunts || []).map((h) => [h.id, 'bug hunt', h.scope, h.status, h.kept ? h.done + '/' + h.kept + ' fixed' + (h.blocked ? ', ' + h.blocked + ' blocked' : '') : h.findings + ' finding(s), ' + h.confirmed + ' confirmed'])]
      .filter((r) => r[3] !== 'CANCELLED').slice(-12);
    document.getElementById('features-body').replaceChildren(rows.length
      ? makeTable(['ID', 'Kind', 'Goal / area', 'Status', 'Progress'], rows.map((r) => [
        { mono: true, node: el('span', null, r[0]) }, el('span', null, r[1]), el('span', null, String(r[2]).slice(0, 80)),
        { node: el('span', { className: pillClassForStatus(r[3] === 'DRAFT' || r[3] === 'APPROVED' ? 'IN_PROGRESS' : r[3]) }, r[3]) }, el('span', null, r[4])]))
      : el('div', { className: 'muted' }, 'No features or bug hunts yet (npm run feature -- "login", npm run hunt -- "checkout").'));
  }

  function renderUsage(usage) {
    const d7 = usage.days7 || {};
    const span = usage.rangeDays || d7.days || 7;
    document.getElementById('usage-title').textContent = span + '-Day Quota & Usage';
    document.getElementById('usage-since').textContent = 'Since ' + (d7.since || '-');
    const body = document.getElementById('usage-body');
    const todayMap = usage.today || {};
    const limits = usage.dailyLimits || {};
    const periodTotals = d7.totals || {};
    const engines = [...new Set([...Object.keys(periodTotals), ...Object.keys(todayMap), ...Object.keys(limits)])];
    if (!engines.length) {
      body.replaceChildren(el('div', { className: 'muted' }, 'No AI usage or daily limits configured yet.'));
      return;
    }
    body.replaceChildren(makeTable(
      ['Engine', 'Today Calls / Cap', 'Today USD', span + 'd Calls', span + 'd Tokens', span + 'd USD'],
      engines.map((eng) => {
        const row = periodTotals[eng] || { calls: 0, failed: 0, tokens: 0, usd: 0 };
        const td = todayMap[eng] || { calls: 0, usd: 0 };
        const cap = limits[eng] || {};
        const capStr = td.calls + (typeof cap.calls === 'number' ? ' / ' + cap.calls : '');
        const usdStr = '$' + Number(td.usd || 0).toFixed(2) + (typeof cap.usd === 'number' ? ' / $' + cap.usd : '');
        return [
          { mono: true, node: el('span', null, eng) },
          { mono: true, node: el('span', null, capStr) },
          { mono: true, node: el('span', null, usdStr) },
          { mono: true, node: el('span', null, row.calls + (row.failed ? ' (' + row.failed + ' fail)' : '')) },
          { mono: true, node: el('span', null, row.tokens ? String(row.tokens) : '-') },
          { mono: true, node: el('span', null, '$' + Number(row.usd || 0).toFixed(2)) }
        ];
      })
    ));
  }

  function renderVisible(vis) {
    const runs = vis.runs || [];
    document.getElementById('visible-pill').textContent = runs.length + ' run(s)';
    const body = document.getElementById('visible-body');
    if (!runs.length) {
      body.replaceChildren(el('div', { className: 'muted' }, 'No editor workflow runs recorded in .harness/visible/.'));
      return;
    }
    const recent = runs.slice(-12).reverse();
    body.replaceChildren(makeTable(
      ['Run ID', 'Status', 'Editor', 'Cycle', 'Goal / Title'],
      recent.map((r) => {
        const lv = r.lastVerify;
        const failed = lv && !lv.passed;
        const diag = failed && lv.diagnosis && lv.diagnosis.category
          ? (' [' + lv.diagnosis.category + (lv.diagnosis.repeat ? ' REPEAT' : '') + ']')
          : (failed && lv.patchSafety && lv.patchSafety.blocking && lv.patchSafety.blocking.length ? ' [PATCH_SAFETY]' : '');
        const head = failed && lv.diagnosis && lv.diagnosis.headline ? (' — ' + lv.diagnosis.headline) : '';
        return [
          { mono: true, node: el('span', null, r.id) },
          { node: el('span', { className: pillClassForStatus(r.status) }, (r.status || '-') + diag) },
          el('span', null, r.editorLabel || r.editor || 'claude-code'),
          { mono: true, node: el('span', null, String(r.cycles ?? r.cycle ?? 0)) },
          el('span', null, (r.title || r.goal || '-') + head)
        ];
      })
    ));
  }

  function renderSessions(sess) {
    const pill = document.getElementById('sessions-pill');
    const body = document.getElementById('sessions-body');
    if (sess.status === 'unavailable') {
      pill.className = 'pill';
      pill.textContent = 'Unavailable';
      body.replaceChildren(el('div', { className: 'muted' }, sess.reason || 'Unavailable (not a git repository).'));
      return;
    }
    const tasks = (sess.tasks || []).filter((t) => t.status !== 'CLEANED');
    const openCount = tasks.filter((t) => t.status !== 'MERGED').length;
    const riskCount = tasks.filter((t) => t.risk).length;
    pill.className = riskCount ? 'pill err' : 'pill ok';
    pill.textContent = openCount + '/' + (sess.maxActive || 4) + ' open' + (riskCount ? ' · ' + riskCount + ' HIGH RISK' : '');
    if (!tasks.length) {
      body.replaceChildren(el('div', { className: 'muted' }, 'No active child sessions.'));
      return;
    }
    body.replaceChildren(makeTable(
      ['ID', 'Status', 'Title', 'Risk / Note'],
      tasks.map((t) => [
        { mono: true, node: el('span', null, t.id) },
        { node: el('span', { className: t.risk ? 'pill err' : pillClassForStatus(t.status) }, t.status + (t.risk ? ' · HIGH RISK' : '')) },
        el('span', null, t.title || '-'),
        el('span', null, t.note || (typeof t.risk === 'string' ? t.risk : t.risk ? 'HIGH RISK' : '-'))
      ])
    ));
  }

  function renderLogs(logs) {
    const live = logs.live || [];
    const liveTotal = logs.liveTotal ?? live.length;
    document.getElementById('live-count').textContent = liveTotal > live.length
      ? (live.length + ' of ' + liveTotal + ' line(s)')
      : (live.length + ' line(s)');
    const pre = document.getElementById('live-log');
    const atBottom = Math.abs(pre.scrollHeight - pre.clientHeight - pre.scrollTop) < 24;
    pre.textContent = live.length ? live.join('\\n') : 'No live events yet (.harness/live.log).';
    if (atBottom) pre.scrollTop = pre.scrollHeight;

    const telAll = logs.telemetry || [];
    const telTotal = logs.telemetryTotal ?? telAll.length;
    const tel = telAll.slice(-40).reverse();
    document.getElementById('tel-count').textContent = telTotal > tel.length
      ? (tel.length + ' of ' + telTotal + ' event(s)')
      : (telAll.length + ' event(s)');
    const telBody = document.getElementById('tel-body');
    if (!tel.length) {
      telBody.replaceChildren(el('div', { className: 'muted' }, 'No telemetry events logged yet.'));
      return;
    }
    telBody.replaceChildren(makeTable(
      ['Time (UTC)', 'Phase', 'Detail'],
      tel.map((e) => [
        { mono: true, node: el('span', null, String(e.ts || '').slice(11, 19)) },
        { mono: true, node: el('span', null, e.phase || '-') },
        el('span', null, (e.engine ? '[' + e.engine + '] ' : '') + (e.message || ''))
      ])
    ));
  }

  async function refresh() {
    if (inFlight) return;
    inFlight = true;
    try {
      const [status, logs, usage, backlog, visible, sessions] = await Promise.all([
        fetchJson('/api/status?skipSessions=1'),
        fetchJson('/api/logs'),
        fetchJson('/api/usage?days=' + selectedDays),
        fetchJson('/api/backlog'),
        fetchJson('/api/visible'),
        fetchJson('/api/sessions')
      ]);
      renderAlerts(status, usage, sessions);
      renderStatus(status);
      renderBacklog(backlog);
      renderNeeds(backlog);
      renderUsage(usage);
      renderVisible(visible);
      renderSessions(sessions);
      renderLogs(logs);
      document.getElementById('updated-at').textContent = 'Updated ' + new Date().toLocaleTimeString();
      if (liveRefresh) {
        connPill.className = 'pill ok';
        connPill.textContent = 'Live';
      }
    } catch (err) {
      connPill.className = 'pill err';
      connPill.textContent = 'Offline';
      document.getElementById('updated-at').textContent = 'Error: ' + err.message;
    } finally {
      inFlight = false;
    }
  }

  refreshBtn.addEventListener('click', refresh);
  refresh();
  setInterval(() => { if (liveRefresh) refresh(); }, 3000);
})();
</script>
</body>
</html>
`;

function sendJson(res, statusCode, payload, headOnly = false, extraHeaders = {}) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
    ...extraHeaders
  });
  res.end(headOnly ? undefined : body);
}

/**
 * Only the dashboard's own address may talk to it. A web page you visit can point its own domain at 127.0.0.1
 * ("DNS rebinding") and then read this local server; its requests carry THAT domain in the Host header, so any Host
 * other than 127.0.0.1 / localhost / [::1] on this server's port is refused.
 */
export function hostAllowed(hostHeader, port) {
  const h = String(hostHeader || '').toLowerCase().trim();
  const p = Number(port);
  if (!h || !Number.isInteger(p) || p <= 0 || p > 65535) return false;
  const allowed = [`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`];
  if (p === 80) allowed.push('127.0.0.1', 'localhost', '[::1]');
  return allowed.includes(h);
}

export function createUiHandler() {
  return (req, res) => {
    if (!hostAllowed(req.headers && req.headers.host, req.socket && req.socket.localPort)) {
      sendJson(res, 403, { error: 'Forbidden: this dashboard only answers requests addressed to 127.0.0.1 or localhost' });
      return;
    }
    const method = String(req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(res, 405, { error: 'Read-only dashboard: only GET and HEAD requests are allowed' }, false, { Allow: 'GET, HEAD' });
      return;
    }
    const headOnly = method === 'HEAD';
    let parsedUrl;
    try {
      parsedUrl = new URL(req.url || '/', 'http://127.0.0.1');
    } catch {
      sendJson(res, 400, { error: 'Invalid request URL' }, headOnly);
      return;
    }
    const pathname = parsedUrl.pathname;

    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(DASHBOARD_HTML),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        // The page loads nothing from outside, may not be framed, and may only call its own address.
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        'X-Frame-Options': 'DENY',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Referrer-Policy': 'no-referrer'
      });
      res.end(headOnly ? undefined : DASHBOARD_HTML);
      return;
    }

    if (pathname === '/api/status') {
      const skipSessions = parsedUrl.searchParams.get('skipSessions') === '1';
      sendJson(res, 200, readStatusData({ skipSessions }), headOnly);
      return;
    }
    if (pathname === '/api/logs') { sendJson(res, 200, readLogsData(), headOnly); return; }
    if (pathname === '/api/usage') {
      const rawDays = parsedUrl.searchParams.get('days');
      let days = 7;
      if (rawDays !== null) {
        if (!/^\d+$/.test(rawDays) || Number(rawDays) < 1 || Number(rawDays) > 365) {
          sendJson(res, 400, { error: `Invalid days "${rawDays}": expected integer 1..365` }, headOnly);
          return;
        }
        days = Number(rawDays);
      }
      sendJson(res, 200, readUsageData(days), headOnly);
      return;
    }
    if (pathname === '/api/backlog') { sendJson(res, 200, readBacklogData(), headOnly); return; }
    if (pathname === '/api/sessions') { sendJson(res, 200, readSessionsData(), headOnly); return; }
    if (pathname === '/api/visible') { sendJson(res, 200, readVisibleData(), headOnly); return; }

    sendJson(res, 404, { error: 'Not found', path: pathname }, headOnly);
  };
}

export function openBrowser(url) {
  try {
    let child;
    if (process.platform === 'win32') {
      child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true });
    } else if (process.platform === 'darwin') {
      child = spawn('open', [url], { detached: true, stdio: 'ignore' });
    } else {
      child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    }
    child.on('error', () => {});
    child.unref();
  } catch { /* opening the browser is best-effort */ }
}

export function parsePortArg(argv = process.argv.slice(2)) {
  let port = DEFAULT_PORT;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a.startsWith('--port=')) {
      const raw = a.includes('=') ? a.slice('--port='.length) : argv[++i];
      if (raw === undefined || !/^\d+$/.test(raw)) {
        throw new Error(`Invalid --port "${raw ?? ''}". Expected an integer from 0 to 65535.`);
      }
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > 65535) {
        throw new Error(`Invalid --port "${raw}". Expected an integer from 0 to 65535.`);
      }
      port = n;
    }
  }
  return port;
}

export function startUiServer({ port = DEFAULT_PORT, open = true } = {}) {
  const server = http.createServer(createUiHandler());
  return new Promise((resolve, reject) => {
    server.once('error', (err) => reject(err));
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      const url = `http://127.0.0.1:${actualPort}/`;
      console.log(`Agentic Harness Web UI (read-only): ${url}`);
      console.log('Press Ctrl+C to stop.');
      if (open) openBrowser(url);
      resolve({ server, url, port: actualPort });
    });
  });
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
})();

if (isMain) {
  helpIfAsked(import.meta.url);
  if (process.env.HARNESS_WORKER === '1') {
    console.error('Refusing to start the local web dashboard inside a harness worker.');
    process.exit(2);
  }
  const argv = process.argv.slice(2);
  let port;
  try {
    port = parsePortArg(argv);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const shouldOpen = !argv.includes('--no-open') && process.env.HARNESS_SILENT !== '1';
  try {
    const { server } = await startUiServer({ port, open: shouldOpen });
    const shutdown = () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 500).unref();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use on 127.0.0.1. Run with --port 0 or choose another port.`);
    } else {
      console.error(`Failed to start local web dashboard: ${err?.message || err}`);
    }
    process.exit(1);
  }
}
