#!/usr/bin/env node
/**
 * .harness/hook-guard.mjs — Multi-editor PreToolUse guard (Claude Code `.claude/settings.json` & Antigravity `.agents/hooks.json`).
 * Blocks unsafe actions BEFORE they happen, instead of only reverting them afterwards.
 *
 *   Protocols supported:
 *     - Claude Code (default): stdin `{ tool_name, tool_input }`, exit 2 + stderr to block, exit 0 to allow.
 *     - Antigravity (`--agy` or camelCase `toolCall` stdin): stdout JSON `{ decision: "allow" | "deny" | "force_ask", reason? }`, exit 0.
 *
 *   File edits guarded (`Edit|Write|MultiEdit|NotebookEdit|write_file|edit_file|write_to_file|replace_file_content|multi_replace_file_content`):
 *     - Hard deny always: `.env` / `.env.*` (not `.env.example`), `.git/**`, `.harness/releases/**`, and charter `forbiddenPaths` (excl. `.harness/**`).
 *     - Hard deny in installed projects (`.harness/MANIFEST.json` exists): harness core (`.harness/*.mjs`, `.harness/lib/**`, `.harness/MANIFEST.json`)
 *       and runtime hook configs (`.claude/settings.json`, `.agents/hooks.json`).
 *     - Headless worker (`HARNESS_WORKER=1`): enforces `HARNESS_WORKER_READONLY=1` (blocks all writes) and `HARNESS_WORKER_FILES` target scope.
 *     - Antigravity `force_ask` parity: `.harness/charter.md`, `.harness/config.json`, `.harness/team.json`, `.claude/agents/**`, `.claude/commands/**`,
 *       `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`.
 *     - Controller-First Gate (installed projects, opt-out via `"guard": {"controllerFirst": false}` in `config.json`):
 *       requires an active delegated `visible.mjs` run (`.harness/visible/<id>/run.json` in `DELEGATED|FAILED|REVIEW_BLOCKED`) and enforces that the file
 *       is inside `run.assignments` (and the specific lead's slice when agent identity is provided). Records attribution to `.harness/visible/<id>/edits.jsonl`.
 *
 *   Shell commands guarded (`Bash|PowerShell|run_command`):
 *     - Hard deny: `git reset --hard`, `git clean -f`, force pushes, pushes to protected branches, charter `forbiddenTools` (`rm -rf`, `npm publish`,
 *       mutating `git remote`), read-only worker mutations, and shell-based file writes/deletes targeting protected or un-delegated paths.
 *     - Antigravity `force_ask` parity for human-approval commands (`visible.mjs rollback|visual confirm`, `sessions.mjs merge|cleanup`,
 *       `backlog.mjs approve|import|ready|block`, `feature.mjs approve|cancel`, `hunt.mjs approve|cancel`, `team.mjs auto-assign|adapt-scopes --apply`,
 *       `daemon.mjs --autonomous`, `memory.mjs forget|forget-auto|promote`, and non-protected `git push`).
 *
 *   node .harness/hook-guard.mjs --help
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readCharter, matchesAny, leadOwns, isTestFilePath } from './lib/governance.mjs';
import { VISIBLE_TERMINAL, insideTargets } from './lib/handoff.mjs';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('hook-guard.mjs — PreToolUse guard for Claude Code (.claude/settings.json) and Antigravity (.agents/hooks.json). Reads a tool call JSON on stdin.\nBlocks: edits to .env*, .git/**, .harness/releases/**, charter forbiddenPaths, harness core + hook configs in installed projects; Controller-First Gate (active delegated visible.mjs run + assigned files); headless worker read-only/scope bounds; shell-write bypasses; git reset --hard, git clean -f, force/protected pushes, charter forbiddenTools (rm -rf, npm publish, git remote); plus Antigravity force_ask parity for human-approval commands.');
  process.exit(0);
}

const AGY_FLAG = process.argv.includes('--agy');

function readJsonSafe(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function resolveRoot(call) {
  const fromEnv = process.env.CLAUDE_PROJECT_DIR || process.env.HARNESS_ROOT;
  if (fromEnv) return path.resolve(fromEnv);
  const fromCall = call?.cwd || (Array.isArray(call?.workspacePaths) && call.workspacePaths[0]);
  if (fromCall && typeof fromCall === 'string') return path.resolve(fromCall);
  const cwd = process.cwd();
  if (path.basename(cwd).toLowerCase() === '.agents' && fs.existsSync(path.join(cwd, '..', '.harness'))) {
    return path.resolve(cwd, '..');
  }
  return path.resolve(cwd);
}

function loadProjectConfig(root) {
  return readJsonSafe(path.join(root, '.harness', 'config.json'), {}) || {};
}

function protectedBranches(root) {
  try {
    const g = loadProjectConfig(root).git || {};
    return [...new Set([...(g.protectedBranches || ['main', 'master']), g.integrationBranch].filter((b) => typeof b === 'string' && /^[\w./-]+$/.test(b)))];
  } catch { return ['main', 'master', 'production', 'prod', 'uat']; }
}

function listOpenVisibleRuns(root) {
  const dir = path.join(root, '.harness', 'visible');
  try {
    return fs.readdirSync(dir)
      .map((d) => readJsonSafe(path.join(dir, d, 'run.json'), null))
      .filter((r) => r && !VISIBLE_TERMINAL.has(r.status))
      .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.id || '').localeCompare(String(b.id || '')));
  } catch { return []; }
}

function governedGlobs(root, charter) {
  const out = new Set(charter.allowedPaths?.length ? charter.allowedPaths : ['src/**', 'docs/**', 'tests/**', 'test/**', '__tests__/**']);
  const team = readJsonSafe(path.join(root, '.harness', 'team.json'), null);
  for (const m of team?.members || []) {
    if (m?.level === 'lead' && Array.isArray(m.scope)) {
      for (const s of m.scope) if (typeof s === 'string' && s.trim()) out.add(s.trim());
    }
  }
  return [...out];
}

function recordAttribution(root, runId, entry) {
  try {
    const file = path.join(root, '.harness', 'visible', String(runId), 'edits.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
  } catch { /* attribution is best-effort and must never break tool calls */ }
}

const GOVERNANCE_ASK_FILES = new Set([
  '.harness/charter.md',
  '.harness/config.json',
  '.harness/team.json',
  'agents.md',
  'claude.md',
  'gemini.md'
]);

/**
 * Evaluate a target file path.
 * Returns { decision: 'allow' | 'deny' | 'ask', reason: string, activeRun?: object }.
 */
export function fileGuardDecision(file, root, { isAgy = false, agentId = '', env = process.env } = {}) {
  if (typeof file !== 'string' || !file) return { decision: 'allow', reason: '' };
  if (env.HARNESS_WORKER === '1' && env.HARNESS_WORKER_READONLY === '1') {
    return { decision: 'deny', reason: `read-only harness worker (${env.HARNESS_WORKER_ID || 'worker'}) may not edit files (${file})` };
  }
  const rel = path.relative(root, path.resolve(root, file)).split(path.sep).join('/');
  if (rel.startsWith('../') || rel === '..' || path.isAbsolute(rel)) return { decision: 'allow', reason: '' };
  const low = rel.toLowerCase();
  const base = low.split('/').pop();
  const installed = fs.existsSync(path.join(root, '.harness', 'MANIFEST.json'));

  // 1. Always-blocked critical paths
  if ((base === '.env' || base.startsWith('.env.')) && base !== '.env.example') {
    return { decision: 'deny', reason: `${rel} holds secrets (.env files are never edited by an agent)` };
  }
  if (low === '.git' || low.startsWith('.git/')) {
    return { decision: 'deny', reason: `${rel} is inside .git/` };
  }
  if (low.startsWith('.harness/releases/')) {
    return { decision: 'deny', reason: `${rel} is a release snapshot (never edited)` };
  }

  // 2. Installed-project core & hook-config immutability
  if (installed) {
    if (/^\.harness\/[^/]+\.mjs$/.test(low) || low.startsWith('.harness/lib/') || low === '.harness/manifest.json') {
      return { decision: 'deny', reason: `${rel} is harness core code in an installed project (report the gap to the template instead)` };
    }
    if (low === '.claude/settings.json' || low === '.agents/hooks.json') {
      return { decision: 'deny', reason: `${rel} configures harness runtime hooks/permissions (never edited by an agent in an installed project)` };
    }
  }

  // 3. Charter forbiddenPaths (excluding .harness/** which has tiered rules above/below, and preserving .env.example)
  const charter = readCharter(path.join(root, '.harness', 'charter.md'));
  const extraForbidden = (charter.forbiddenPaths || []).filter((g) => {
    const s = String(g).trim().replace(/\\/g, '/');
    if (/^\.?\/?\.harness(?:\/|$)/.test(s)) return false;
    if (base === '.env.example' && /^\.env\*?$/i.test(s)) return false;
    return true;
  });
  if (extraForbidden.length && matchesAny(rel, extraForbidden)) {
    return { decision: 'deny', reason: `${rel} is forbidden by .harness/charter.md (forbiddenPaths)` };
  }

  // 4. Headless daemon worker scope enforcement (HARNESS_WORKER=1)
  if (env.HARNESS_WORKER === '1') {
    if (env.HARNESS_WORKER_FILES) {
      let allowed = null;
      try { allowed = JSON.parse(env.HARNESS_WORKER_FILES); } catch { allowed = null; }
      if (Array.isArray(allowed) && allowed.length && !insideTargets(rel, allowed)) {
        return { decision: 'deny', reason: `${rel} is outside worker ${env.HARNESS_WORKER_ID || ''} targetFiles (${allowed.join(', ')})` };
      }
    }
    return { decision: 'allow', reason: '' };
  }

  // 5. Governance & rule files: require owner confirmation (Claude uses permissions.ask; Antigravity uses force_ask here)
  if (GOVERNANCE_ASK_FILES.has(low) || low.startsWith('.claude/agents/') || low.startsWith('.claude/commands/')) {
    return { decision: 'ask', reason: `${rel} changes harness governance or agent rules; confirm with the owner first` };
  }

  // 6. Controller-First Gate (active in installed projects by default, or when config.guard.controllerFirst === true)
  const cfg = loadProjectConfig(root);
  const controllerFirst = cfg.guard?.controllerFirst !== undefined ? Boolean(cfg.guard.controllerFirst) : installed;
  if (controllerFirst && !low.startsWith('.harness/') && !low.startsWith('.agent-state/') && !low.startsWith('.claude/') && !low.startsWith('.agents/')) {
    const governed = governedGlobs(root, charter);
    if (matchesAny(rel, governed)) {
      const open = listOpenVisibleRuns(root);
      const active = open.length ? open[open.length - 1] : null;
      if (!active) {
        return {
          decision: 'deny',
          reason: `Controller-First Gate: no active harness run (.harness/visible/<id>/run.json) for editing ${rel}. Start a run first: node .harness/visible.mjs brief --goal "<task>"${isAgy ? ' --editor antigravity' : ''} && node .harness/visible.mjs assign <RUN_ID> '<json>' (or set "guard": {"controllerFirst": false} in .harness/config.json to opt out)`
        };
      }
      if (active.status === 'BRIEFED' || !Array.isArray(active.assignments) || !active.assignments.length) {
        return {
          decision: 'deny',
          reason: `Controller-First Gate: run ${active.id} is ${active.status} (not yet delegated). Run: node .harness/visible.mjs assign ${active.id} '<delegation json>' before editing ${rel}`
        };
      }
      const leads = active.leads || [];
      const hasQaLead = leads.some((l) => String(l.role).toUpperCase() === 'QA_AUDITOR');
      const owner = active.assignments.find((a) => {
        if (!insideTargets(rel, a.files)) return false;
        const lead = leads.find((l) => l.id === a.lead);
        return !lead || !leads.length || leadOwns(lead, rel, leads);
      });
      if (!owner) {
        const assignedList = active.assignments.flatMap((a) => a.files || []).join(', ');
        return {
          decision: 'deny',
          reason: `Controller-First Gate: ${rel} is outside the assigned files of active run ${active.id} (${assignedList || 'none'})`
        };
      }
      const ownerLead = leads.find((l) => l.id === owner.lead);
      if (ownerLead && hasQaLead && String(ownerLead.role).toUpperCase() !== 'QA_AUDITOR' && isTestFilePath(rel)) {
        return {
          decision: 'deny',
          reason: `Controller-First Gate: ${rel} is a test file and may only be owned by lead-qa (run ${active.id})`
        };
      }
      if (agentId) {
        const callerAssign = active.assignments.find((a) => a.lead.toLowerCase() === agentId.toLowerCase());
        if (callerAssign && callerAssign.lead !== owner.lead) {
          return {
            decision: 'deny',
            reason: `Controller-First Gate: ${rel} belongs to ${owner.lead}, not ${callerAssign.lead} (run ${active.id})`
          };
        }
      }
      return { decision: 'allow', reason: '', activeRun: active };
    }
  }

  return { decision: 'allow', reason: '' };
}

/** Drop heredoc bodies that are data for a program (node - <<'EOF' …), keep those fed into a shell (bash <<EOF …). */
function stripDataHeredocs(cmd) {
  return cmd.replace(/(^|[^\n]*?)<<-?\s*(['"]?)(\w+)\2[^\n]*\n[\s\S]*?\n\s*\3\s*(?=\n|$)/g, (all, before) =>
    (/\b(?:sh|bash|zsh|dash|pwsh|powershell|cmd)\b\s*(?:-\w+\s*)*$/.test(String(before).trim()) ? all : `${before}<<HEREDOC_DATA`));
}

// git's own options may come before the subcommand: git -C dir push, git -c k=v reset, git --git-dir=x push.
const GIT = String.raw`\bgit(?:\.exe)?(?:\s+(?:-C\s+\S+|-c\s+\S+|--(?:git-dir|work-tree|namespace|exec-path)(?:=\S+|\s+\S+)|--no-pager|--paginate|--bare|--no-replace-objects|-P|-p))*\s+`;
const gitCmd = (sub, rest = '', flags = '') => new RegExp(`${GIT}${sub}\\b${rest}`, flags);

function stripDataQuotes(cmd) {
  let out = ''; let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i];
    if (ch !== '"' && ch !== "'") { out += ch; i++; continue; }
    let j = i + 1;
    while (j < cmd.length && cmd[j] !== ch) { if (ch === '"' && cmd[j] === '\\') j++; j++; }
    const quoted = cmd.slice(i, j + 1);
    const segment = out.slice(Math.max(out.lastIndexOf(';'), out.lastIndexOf('&'), out.lastIndexOf('|'), out.lastIndexOf('\n')) + 1);
    const runsAsShell = /\b(?:sh|bash|zsh|dash|pwsh|powershell|cmd)(?:\.exe)?\b[^"']*(?:\s-c|\s-Command|\s\/c|\s-EncodedCommand)\b[^"']*$|\beval\s*$|\bInvoke-Expression\s*$|\biex\s*$/i.test(segment);
    const gitArg = gitCmd('push', `[^"']*$`).test(segment);
    out += runsAsShell || gitArg ? ` ${quoted.slice(1, -1)} ` : '""';
    i = j + 1;
  }
  return out;
}

function currentBranch(root) {
  try {
    const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 3000 });
    const b = r.status === 0 ? r.stdout.trim() : '';
    return b === 'HEAD' ? '' : b;
  } catch { return ''; }
}

const cleanTok = (t) => String(t || '').trim().replace(/^["']|["']$/g, '').replace(/[;,\)]+$/, '');
const looksLikePath = (t) => Boolean(t) && !t.startsWith('-') && !/^https?:\/\//i.test(t) && !/^\/dev\/null$/i.test(t) && t !== 'NUL' && !/^\d+$/.test(t);

/** Extract candidate file paths being written/deleted by shell redirections, file commands, or inline scripts. */
function extractShellWriteTargets(rawCmd, strippedCmd) {
  const targets = new Set();
  const add = (tok) => { const c = cleanTok(tok); if (looksLikePath(c)) targets.add(c); };

  // 1. Redirections (> file, >> file, 1> file) and `| tee [-a] file` on stripped command (ignores quotes in echo/node data)
  const noFdDup = strippedCmd.replace(/\d*>&\d+/g, '');
  for (const m of noFdDup.matchAll(/(?:^|[\s;|&])(?:\d?>>?|\|>)\s*([^\s;&|<>]+)/g)) {
    const tok = m[1];
    if (tok !== '""') add(tok);
  }
  // Also catch quoted redirection targets in raw command (e.g. `echo x > ".env"`)
  const rawNoHeredoc = stripDataHeredocs(rawCmd).replace(/\d*>&\d+/g, '');
  for (const m of rawNoHeredoc.matchAll(/(?:^|[\s;|&])(?:\d?>>?)\s*(['"])([^'"]+)\1/g)) add(m[2]);
  for (const m of rawNoHeredoc.matchAll(/\|\s*tee(?:\s+-[a-z]+)*\s+(['"]?)([^\s;&|'"]+)\1/gi)) add(m[2]);

  // 2. Shell file-mutating commands per segment
  for (const seg of rawNoHeredoc.split(/[;&|\n]+/)) {
    const s = seg.trim();
    if (!s) continue;
    // PowerShell Set-Content / Add-Content / Out-File / Remove-Item / New-Item / Move-Item / Copy-Item
    const ps = s.match(/^(?:Set-Content|Add-Content|Out-File|Remove-Item|New-Item|sc|ac|ri|ni|del|erase)\b([\s\S]*)$/i);
    if (ps) {
      const rest = ps[1];
      const named = rest.match(/(?:-(?:Literal)?Path|-FilePath|-Destination)\s+(['"]?)([^\s'"]+)\1/i);
      if (named) add(named[2]);
      else {
        const firstPos = rest.trim().match(/^(['"]?)([^\s'"-]+[^\s'"]*)\1/);
        if (firstPos) add(firstPos[2]);
      }
    }
    // POSIX rm / unlink / truncate / touch
    const rm = s.match(/^(?:rm|unlink|truncate|touch)\b([\s\S]*)$/);
    if (rm) {
      for (const tok of rm[1].matchAll(/(?:^|\s)(?:(['"])([^'"]+)\1|([^\s'"]+))/g)) {
        const v = tok[2] ?? tok[3];
        if (looksLikePath(v)) add(v);
      }
    }
    // mv / cp / Move-Item / Copy-Item: last path argument is the destination; for mv source is also removed
    const mvcp = s.match(/^(?:mv|cp|Move-Item|Copy-Item)\b([\s\S]*)$/i);
    if (mvcp) {
      const args = [...mvcp[1].matchAll(/(?:^|\s)(?:(['"])([^'"]+)\1|([^\s'"]+))/g)].map((m) => m[2] ?? m[3]).filter(looksLikePath);
      if (args.length >= 2) {
        add(args[args.length - 1]);
        if (/^(?:mv|Move-Item)/i.test(s)) add(args[0]);
      }
    }
    // sed -i / perl -i in-place edit (last non-flag arg is target file)
    if (/^(?:sed|perl)\b[^\n]*\s-[a-z]*i/i.test(s)) {
      const args = [...s.matchAll(/(?:^|\s)(?:(['"])([^'"]+)\1|([^\s'"]+))/g)].slice(1).map((m) => m[2] ?? m[3]).filter(looksLikePath);
      if (args.length) add(args[args.length - 1]);
    }
  }

  // 3. Inline script writes (node -e / python -c) targeting file paths via known write/delete APIs
  if (/\b(?:node|python3?|py)\b/i.test(rawCmd) && /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|rmSync|unlinkSync|renameSync|copyFileSync|truncateSync|write_text|write_bytes|unlink|rmtree|open)\b/.test(rawCmd)) {
    for (const m of rawCmd.matchAll(/\b(?:writeFileSync|writeFile|appendFileSync|appendFile|rmSync|unlinkSync|renameSync|copyFileSync|truncateSync|rmtree)\s*\(\s*(['"`])([^'"`]+)\1/g)) {
      add(m[2]);
    }
    for (const m of rawCmd.matchAll(/\b(?:copyFileSync|renameSync)\s*\([^,]+,\s*(['"`])([^'"`]+)\1/g)) {
      add(m[2]);
    }
    for (const m of rawCmd.matchAll(/\bopen\s*\(\s*(['"])([^'"]+)\1\s*,\s*['"][wax+]/g)) {
      add(m[2]);
    }
    for (const m of rawCmd.matchAll(/\bPath\s*\(\s*(['"])([^'"]+)\1\s*\)\s*\.\s*(?:write_text|write_bytes|unlink)/g)) {
      add(m[2]);
    }
  }

  return [...targets];
}

const HUMAN_APPROVAL_CMD_RULES = [
  [/\bnode(?:\.exe)?\s+["']?(?:\.\/)?\.harness\/visible\.mjs["']?\s+rollback\b/i, 'visible.mjs rollback restores files and requires owner confirmation'],
  [/\bnode(?:\.exe)?\s+["']?(?:\.\/)?\.harness\/visible\.mjs["']?\s+visual\s+confirm\b/i, 'visible.mjs visual confirm requires the human to inspect the UI and confirm'],
  [/\bnode(?:\.exe)?\s+["']?(?:\.\/)?\.harness\/sessions\.mjs["']?\s+merge\b/i, 'sessions.mjs merge lands a branch and requires owner confirmation'],
  [/\bnode(?:\.exe)?\s+["']?(?:\.\/)?\.harness\/sessions\.mjs["']?\s+cleanup\b/i, 'sessions.mjs cleanup deletes worktrees/branches and requires owner confirmation'],
  [/\bnode(?:\.exe)?\s+["']?(?:\.\/)?\.harness\/backlog\.mjs["']?\s+(?:approve|import|ready|block)\b/i, 'mutating backlog approval/status requires owner confirmation'],
  [/\bnode(?:\.exe)?\s+["']?(?:\.\/)?\.harness\/feature\.mjs["']?\s+(?:approve|cancel)\b/i, 'feature.mjs approve/cancel requires owner confirmation'],
  [/\bnode(?:\.exe)?\s+["']?(?:\.\/)?\.harness\/hunt\.mjs["']?\s+(?:approve|cancel)\b/i, 'hunt.mjs approve/cancel requires owner confirmation'],
  [/\bnode(?:\.exe)?\s+["']?(?:\.\/)?\.harness\/team\.mjs["']?\s+(?:auto-assign|adapt-scopes\b[^\n]*--apply)/i, 'modifying team.json/scopes requires owner confirmation'],
  [/\bnode(?:\.exe)?\s+["']?(?:\.\/)?\.harness\/daemon\.mjs["']?[^\n]*--autonomous\b/i, 'starting autonomous daemon requires owner confirmation'],
  [/\bnode(?:\.exe)?\s+["']?(?:\.\/)?\.harness\/memory\.mjs["']?\s+(?:forget|forget-auto|promote)\b/i, 'deleting or promoting memory rules requires owner confirmation']
];

export function commandGuardDecision(cmd, root, { branches = protectedBranches(root), current = () => currentBranch(root), isAgy = false, agentId = '', env = process.env } = {}) {
  const raw = String(cmd || '');
  const c = stripDataQuotes(stripDataHeredocs(raw));

  // 1. Read-only headless worker shell restriction
  if (env.HARNESS_WORKER === '1' && env.HARNESS_WORKER_READONLY === '1') {
    const writeTargets = extractShellWriteTargets(raw, c);
    if (writeTargets.length) {
      return { decision: 'deny', reason: `read-only harness worker (${env.HARNESS_WORKER_ID || 'worker'}) may not write/delete files via shell (${writeTargets.join(', ')})` };
    }
    if (gitCmd('(?:add|commit|checkout|switch|reset|clean|merge|rebase|cherry-pick|push|tag|branch\\s+-[dDmM])').test(c)) {
      return { decision: 'deny', reason: `read-only harness worker (${env.HARNESS_WORKER_ID || 'worker'}) may not mutate git state` };
    }
  }

  // 2. Destructive git guards (always hard deny)
  if (gitCmd('reset', String.raw`[^;&|\n]*--hard\b`).test(c)) return { decision: 'deny', reason: 'git reset --hard throws away work' };
  if (gitCmd('clean', String.raw`[^;&|\n]*\s-[a-z]*f`, 'i').test(c)) return { decision: 'deny', reason: 'git clean -f deletes untracked files' };
  let hasNonProtectedPush = false;
  for (const m of c.matchAll(gitCmd('push', String.raw`([^;&|\n]*)`, 'g'))) {
    const args = m[1];
    const positional = args.trim().split(/\s+/).filter((a) => a && !a.startsWith('-'));
    if (positional.length <= 1 || positional.slice(1).every((r) => r === 'HEAD')) {
      const cur = current();
      if (cur && branches.includes(cur)) return { decision: 'deny', reason: `push of the current branch '${cur}', which is protected` };
    }
    if (/(?:^|\s)(?:--force(?:-with-lease)?|-f|-[a-z]*f[a-z]*)(?=\s|=|$)/.test(args) || /(?:^|\s)\+\S/.test(args)) return { decision: 'deny', reason: 'force push' };
    if (/(?:^|\s)--(?:all|mirror)\b/.test(args)) return { decision: 'deny', reason: 'git push --all/--mirror reaches protected branches' };
    for (const b of branches) {
      const esc = b.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      if (new RegExp(`(?:\\s|:|refs/heads/)${esc}(?=\\s|$)`).test(args)) return { decision: 'deny', reason: `push to the protected branch '${b}'` };
    }
    hasNonProtectedPush = true;
  }

  // 3. Charter forbiddenTools enforcement (rm -rf, npm publish, mutating git remote)
  const charter = readCharter(path.join(root, '.harness', 'charter.md'));
  const ft = (charter.forbiddenTools || []).map((t) => String(t).toLowerCase());
  if (ft.some((t) => t.includes('rm -rf'))) {
    if (/\brm\s+(?:-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-[a-z]*r\s+-[a-z]*f|-[a-z]*f\s+-[a-z]*r)\b/i.test(c)
      || /\bRemove-Item\b[^\n;&|]*(?:-Recurse[^\n;&|]*-Force|-Force[^\n;&|]*-Recurse)\b/i.test(c)
      || /\brmdir\b[^\n;&|]*(?:\/s[^\n;&|]*\/q|\/q[^\n;&|]*\/s)\b/i.test(c)) {
      return { decision: 'deny', reason: 'recursive force-delete (rm -rf) is forbidden by .harness/charter.md' };
    }
  }
  if (ft.some((t) => t.includes('npm publish')) && /\b(?:npm|pnpm|yarn)\s+publish\b/i.test(c)) {
    return { decision: 'deny', reason: 'npm publish is forbidden by .harness/charter.md' };
  }
  if (ft.some((t) => t.includes('git remote')) && gitCmd('remote', String.raw`\s+(?:add|set-url|remove|rm|rename|prune|set-head|set-branches)\b`).test(c)) {
    return { decision: 'deny', reason: 'modifying git remotes is forbidden by .harness/charter.md' };
  }

  // 4. Shell-write bypass check against fileGuardDecision
  let askReason = '';
  for (const target of extractShellWriteTargets(raw, c)) {
    const res = fileGuardDecision(target, root, { isAgy, agentId, env });
    if (res.decision === 'deny') {
      return { decision: 'deny', reason: `shell command writes/deletes guarded path — ${res.reason}` };
    }
    if (res.decision === 'ask' && !askReason) askReason = `shell command modifies guarded path — ${res.reason}`;
  }
  if (askReason) return { decision: 'ask', reason: askReason };

  // 5. Human-approval CLI commands & non-protected git push (Antigravity force_ask parity)
  for (const [re, reason] of HUMAN_APPROVAL_CMD_RULES) {
    if (re.test(c)) return { decision: 'ask', reason };
  }
  if (hasNonProtectedPush) return { decision: 'ask', reason: 'git push requires explicit owner confirmation' };

  return { decision: 'allow', reason: '' };
}

// ───────────────────────────── CLI entrypoint ─────────────────────────────
const normScript = (p) => {
  try { p = fs.realpathSync.native(p); } catch { p = path.resolve(p); }
  return process.platform === 'win32' ? p.toLowerCase() : p;
};
const isMain = Boolean(process.argv[1]) && normScript(process.argv[1]) === normScript(fileURLToPath(import.meta.url));
if (isMain) {
  let input = '';
  try { input = fs.readFileSync(0, 'utf8'); } catch {
    if (AGY_FLAG) console.log(JSON.stringify({ decision: 'allow' }));
    process.exit(0);
  }
  let call;
  try { call = JSON.parse(input); } catch {
    if (AGY_FLAG) console.log(JSON.stringify({ decision: 'allow' }));
    process.exit(0);
  }

  const isAgy = AGY_FLAG || Boolean(call?.toolCall || call?.hookEventName === 'PreToolUse');
  const root = resolveRoot(call);
  const tool = String(isAgy ? (call?.toolCall?.name || call?.tool_name || '') : (call?.tool_name || call?.toolCall?.name || ''));
  const ti = (isAgy ? (call?.toolCall?.args || call?.tool_input) : (call?.tool_input || call?.toolCall?.args)) || {};
  const agentId = String(call?.agent_name || call?.subagent_type || call?.agentName || call?.agent || '').trim();

  const emitAllow = () => {
    if (isAgy) console.log(JSON.stringify({ decision: 'allow' }));
    process.exit(0);
  };
  const emitDeny = (why) => {
    if (isAgy) {
      console.log(JSON.stringify({ decision: 'deny', reason: `[harness guard] BLOCKED: ${why}` }));
      process.exit(0);
    }
    process.stderr.write(`[harness guard] BLOCKED: ${why}\nAsk the owner; they run this themselves if it is really wanted.\n`);
    process.exit(2);
  };
  const emitAsk = (why) => {
    if (isAgy) {
      console.log(JSON.stringify({ decision: 'force_ask', reason: `[harness guard] CONFIRM REQUIRED: ${why}` }));
      process.exit(0);
    }
    // Claude Code enforces ask rules declaratively in .claude/settings.json
    process.exit(0);
  };

  if (/^(Edit|Write|MultiEdit|NotebookEdit|write_file|edit_file|write_to_file|replace_file_content|multi_replace_file_content)$/i.test(tool)) {
    const targetFile = ti.file_path || ti.notebook_path || ti.Path || ti.TargetFile || ti.AbsolutePath || ti.path || ti.filePath;
    const res = fileGuardDecision(targetFile, root, { isAgy, agentId });
    if (res.decision === 'deny') emitDeny(res.reason);
    if (res.decision === 'ask') emitAsk(res.reason);
    if (res.activeRun && targetFile) {
      const rel = path.relative(root, path.resolve(root, targetFile)).split(path.sep).join('/');
      recordAttribution(root, res.activeRun.id, { agent: agentId || 'orchestrator-or-unknown', editor: isAgy ? 'antigravity' : 'claude-code', tool, file: rel });
    }
    emitAllow();
  } else if (/^(Bash|PowerShell|run_command)$/i.test(tool)) {
    const cmdStr = ti.command || ti.CommandLine || ti.cmd;
    const res = commandGuardDecision(cmdStr, root, { isAgy, agentId });
    if (res.decision === 'deny') emitDeny(res.reason);
    if (res.decision === 'ask') emitAsk(res.reason);
    emitAllow();
  }
  emitAllow();
}
