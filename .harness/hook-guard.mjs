#!/usr/bin/env node
/**
 * .harness/hook-guard.mjs — Claude Code PreToolUse guard: blocks a few unsafe actions BEFORE they happen, instead of
 * only reverting them afterwards. It reads the tool call (JSON on stdin) and exits 2 with a reason to block it.
 *
 *   Blocked file edits (Edit / Write / MultiEdit / NotebookEdit):
 *     .env and .env.* (not .env.example) · .git/** · .harness/releases/**
 *     and, in a project that installed the harness (.harness/MANIFEST.json exists): the harness core
 *     (.harness/*.mjs, .harness/lib/**, .harness/MANIFEST.json)
 *   Blocked shell commands (Bash / PowerShell):
 *     git reset --hard · git clean -f… · git push --force / -f · git push to a protected branch
 *     (config.json git.protectedBranches + git.integrationBranch, e.g. main, master, prod, uat)
 *
 * It checks real command invocations: text a program only reads (a quoted `node -e "…"` argument, a heredoc fed to
 * node) is data and is not matched; quoted shell code (`bash -c "…"`, `powershell -Command "…"`) and git's own
 * arguments still are.
 *
 * The owner runs those themselves in a terminal. Anything the guard cannot parse is allowed (exit 0): the permission
 * rules in .claude/settings.json and the controller's verify still apply. Zero dependencies.
 *   node .harness/hook-guard.mjs --help
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('hook-guard.mjs — Claude Code PreToolUse guard (configured in .claude/settings.json). Reads a tool call as JSON on stdin; exit 2 = blocked, 0 = allowed.\nBlocks: edits to .env*, .git/**, .harness/releases/** (and the harness core in installed projects); git reset --hard, git clean -f, force pushes, pushes to protected branches.');
  process.exit(0);
}

const ROOT = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const block = (why) => { process.stderr.write(`[harness guard] BLOCKED: ${why}\nAsk the owner; they run this themselves if it is really wanted.\n`); process.exit(2); };

function protectedBranches() {
  try {
    const g = JSON.parse(fs.readFileSync(path.join(ROOT, '.harness', 'config.json'), 'utf8')).git || {};
    return [...new Set([...(g.protectedBranches || ['main', 'master']), g.integrationBranch].filter((b) => typeof b === 'string' && /^[\w./-]+$/.test(b)))];
  } catch { return ['main', 'master', 'production', 'prod', 'uat']; }
}

/** Reason to block a file path, or an empty string. */
function fileBlockReason(file, root = ROOT) {
  if (typeof file !== 'string' || !file) return '';
  const rel = path.relative(root, path.resolve(root, file)).split(path.sep).join('/');
  if (rel.startsWith('../') || rel === '..' || path.isAbsolute(rel)) return ''; // outside the project: not ours to guard
  const low = rel.toLowerCase();
  const base = low.split('/').pop();
  if ((base === '.env' || base.startsWith('.env.')) && base !== '.env.example') return `${rel} holds secrets (.env files are never edited by an agent)`;
  if (low === '.git' || low.startsWith('.git/')) return `${rel} is inside .git/`;
  if (low.startsWith('.harness/releases/')) return `${rel} is a release snapshot (never edited)`;
  if (fs.existsSync(path.join(root, '.harness', 'MANIFEST.json')) && (/^\.harness\/[^/]+\.mjs$/.test(low) || low.startsWith('.harness/lib/') || low === '.harness/manifest.json')) {
    return `${rel} is harness core code in an installed project (report the gap to the template instead)`;
  }
  return '';
}

/** Reason to block a shell command, or ''. */
/** Drop heredoc bodies that are data for a program (node - <<'EOF' …), keep those fed into a shell (bash <<EOF …). */
function stripDataHeredocs(cmd) {
  return cmd.replace(/(^|[^\n]*?)<<-?\s*(['"]?)(\w+)\2[^\n]*\n[\s\S]*?\n\s*\3\s*(?=\n|$)/g, (all, before) =>
    (/\b(?:sh|bash|zsh|dash|pwsh|powershell|cmd)\b\s*(?:-\w+\s*)*$/.test(String(before).trim()) ? all : `${before}<<HEREDOC_DATA`));
}

/**
 * Drop quoted arguments that are data for a program (node -e "…", python -c '…', echo "…", grep "…"). A quoted
 * argument is kept (still checked) when it runs as shell code (bash -c "…", powershell -Command "…", cmd /c "…",
 * eval "…") or is an argument of git push (git push origin "main").
 */
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
    const gitArg = gitCmd('push', `[^"']*$`).test(segment); // a quoted branch name still counts; a commit message does not
    out += runsAsShell || gitArg ? ` ${quoted.slice(1, -1)} ` : '""'; // checked without its quote marks: git push "main" = git push main
    i = j + 1;
  }
  return out;
}

/** The branch checked out in the project (for a push that names no branch); '' when unknown or detached. */
function currentBranch(root = ROOT) {
  try {
    const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 3000 });
    const b = r.status === 0 ? r.stdout.trim() : '';
    return b === 'HEAD' ? '' : b;
  } catch { return ''; }
}

function commandBlockReason(cmd, branches = protectedBranches(), current = currentBranch) {
  const c = stripDataQuotes(stripDataHeredocs(String(cmd || '')));
  if (gitCmd('reset', String.raw`[^;&|\n]*--hard\b`).test(c)) return 'git reset --hard throws away work';
  if (gitCmd('clean', String.raw`[^;&|\n]*\s-[a-z]*f`, 'i').test(c)) return 'git clean -f deletes untracked files';
  for (const m of c.matchAll(gitCmd('push', String.raw`([^;&|\n]*)`, 'g'))) {
    const args = m[1];
    // No branch named (git push, git push origin, git push origin HEAD): git pushes the CURRENT branch.
    const positional = args.trim().split(/\s+/).filter((a) => a && !a.startsWith('-'));
    if (positional.length <= 1 || positional.slice(1).every((r) => r === 'HEAD')) {
      const cur = current();
      if (cur && branches.includes(cur)) return `push of the current branch '${cur}', which is protected`;
    }
    if (/(?:^|\s)(?:--force(?:-with-lease)?|-f|-[a-z]*f[a-z]*)(?=\s|=|$)/.test(args) || /(?:^|\s)\+\S/.test(args)) return 'force push';
    if (/(?:^|\s)--(?:all|mirror)\b/.test(args)) return 'git push --all/--mirror reaches protected branches';
    for (const b of branches) {
      const esc = b.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      if (new RegExp(`(?:\\s|:|refs/heads/)${esc}(?=\\s|$)`).test(args)) return `push to the protected branch '${b}'`;
    }
  }
  return '';
}

let input = '';
try { input = fs.readFileSync(0, 'utf8'); } catch { process.exit(0); }
let call; try { call = JSON.parse(input); } catch { process.exit(0); }
const tool = String(call?.tool_name || '');
const ti = call?.tool_input || {};
if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) {
  const why = fileBlockReason(ti.file_path || ti.notebook_path);
  if (why) block(why);
} else if (/^(Bash|PowerShell)$/.test(tool)) {
  const why = commandBlockReason(ti.command);
  if (why) block(why);
}
process.exit(0);
