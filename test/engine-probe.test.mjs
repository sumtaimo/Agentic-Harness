/**
 * Engine flag probe tests (probeEngine / profileFlags / resolveProfile) using fake CLIs on PATH.
 * @governed-by PO_ARCHITECT
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const realConfig = JSON.parse(fs.readFileSync(path.join(here, '..', '.harness', 'config.json'), 'utf8'));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-probe-'));
fs.mkdirSync(path.join(tmpRoot, '.harness'), { recursive: true });
// The probe is what these tests check: the person has already allowed both tools once.
fs.writeFileSync(path.join(tmpRoot, '.harness', 'approvals.json'), JSON.stringify({ engines: { codex: true, antigravity: true } }));
process.env.HARNESS_ROOT = tmpRoot;
delete process.env.HARNESS_AGENT;
const nodeDir = path.dirname(process.execPath);

const { probeEngine, profileFlags, resolveProfile } = await import('../.harness/lib/common.mjs');

/**
 * Create a bin dir holding fake executables and restrict PATH to it plus the node dir.
 * @param {string} name case name
 * @param {Record<string,string>} scripts binary name -> shell script body
 */
function useBin(name, scripts) {
  if (typeof name !== 'string' || !scripts || typeof scripts !== 'object') throw new TypeError('bad useBin args');
  const dir = fs.mkdtempSync(path.join(tmpRoot, `bin-${name}-`));
  for (const [bin, body] of Object.entries(scripts)) {
    const file = path.join(dir, bin);
    if (process.platform === 'win32') {
      // Windows cannot run a #!/bin/sh script: emulate it with a .cmd that prints the same lines (or prints nothing).
      // Only the two body shapes used below are supported: `exit 0` and `printf '%s\n' 'line' 'line' ...`.
      const lines = body.startsWith('printf') ? [...body.matchAll(/'([^']*)'/g)].slice(1).map((m) => m[1]) : [];
      fs.writeFileSync(`${file}.help.txt`, lines.map((l) => `${l}\r\n`).join(''));
      fs.writeFileSync(`${file}.cmd`, lines.length ? `@type "%~dp0${bin}.help.txt"\r\n` : '@exit /b 0\r\n');
      continue;
    }
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(file, 0o755);
  }
  process.env.PATH = `${dir}${path.delimiter}${nodeDir}`;
  return dir;
}

const profiles = { codex: realConfig.profiles.codex, antigravity: realConfig.profiles.antigravity };
const config = { profiles, autoOrder: ['codex', 'antigravity'], activeProfile: 'auto' };
const originalPath = process.env.PATH;

before(() => {
  assert.ok(profiles.codex && profiles.antigravity, 'config.json must define codex and antigravity');
});
after(() => {
  process.env.PATH = originalPath;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const CODEX_HELP = `printf '%s\\n' 'Usage: codex exec [options] [PROMPT]' '  --full-auto          Run without asking for approval in the workspace' '  -h, --help           Show help'`;
const AGY_HELP = `printf '%s\\n' 'Usage: agy [options]' '  -p, --prompt <text>  Run one prompt headless and exit' '  --model              Model for the current CLI session' '  -h, --help           Show help'`;

test('profileFlags extracts dash flags from args', () => {
  assert.deepEqual(profileFlags({ args: ['--yolo', 'sub', '--', '--x={p}'] }), ['--yolo']);
  assert.deepEqual(profileFlags(profiles.codex), ['--full-auto']);
  assert.deepEqual(profileFlags(profiles.antigravity).sort(), ['--model', '-p'], 'agy has model tiers, so --model is probed too');
  assert.equal(profiles.antigravity.binary, 'agy');
  assert.equal(profiles.antigravity.promptVia, 'arg');
  assert.deepEqual(profiles.antigravity.args, ['-p', '{prompt}']);
});

test('fake codex listing --full-auto is compatible and auto picks it', () => {
  useBin('codex-ok', { codex: CODEX_HELP });
  const probe = probeEngine(profiles.codex, { force: true });
  assert.equal(probe.installed, true);
  assert.equal(probe.checked, true);
  assert.equal(probe.compatible, true);
  assert.deepEqual(probe.missing, []);
  assert.equal(resolveProfile(config).name, 'codex');
});

test('an old codex that only lists --yolo is incompatible and auto falls through to agy', () => {
  useBin('codex-old', { codex: `printf '%s\\n' '  -y, --yolo   Auto-approve'`, agy: AGY_HELP });
  const probe = probeEngine(profiles.codex, { force: true });
  assert.equal(probe.compatible, false);
  assert.deepEqual([...probe.missing], ['--full-auto']);
  assert.equal(resolveProfile(config).name, 'antigravity');
});

test('fake agy listing -p is compatible', () => {
  useBin('agy-ok', { agy: AGY_HELP });
  const probe = probeEngine(profiles.antigravity, { force: true });
  assert.equal(probe.installed, true);
  assert.equal(probe.compatible, true);
  assert.equal(resolveProfile(config, 'antigravity').name, 'antigravity');
});

test('agy whose help lacks -p is incompatible and falls back to codex', () => {
  useBin('agy-bad', { codex: CODEX_HELP, agy: `printf '%s\\n' 'Usage: agy [options] [paths...]' '  -n --new-window   Open a new window'` });
  const probe = probeEngine(profiles.antigravity, { force: true });
  assert.equal(probe.compatible, false);
  assert.deepEqual([...probe.missing].sort(), ['--model', '-p']);
  const r = resolveProfile(config, 'antigravity');
  assert.equal(r.fallbackFrom, 'antigravity');
  assert.equal(r.name, 'codex');
  assert.match(r.fallbackReason, /-p/);
});

test('no codex or agy on PATH gives installed=false', () => {
  useBin('none', {});
  for (const p of [profiles.codex, profiles.antigravity]) {
    const probe = probeEngine(p, { force: true });
    assert.equal(probe.installed, false);
    assert.equal(probe.binPath, null);
  }
});

test('help printing nothing: an unverified profile is rejected and auto falls through to agy', () => {
  useBin('silent', { codex: 'exit 0', agy: AGY_HELP });
  const probe = probeEngine(profiles.codex, { force: true });
  assert.equal(probe.installed, true);
  assert.equal(probe.checked, false);
  assert.equal(probe.compatible, false);
  assert.match(probe.error, /printed nothing/);
  assert.equal(resolveProfile(config).name, 'antigravity');
  const r = resolveProfile(config, 'codex');
  assert.equal(r.fallbackFrom, 'codex');
  assert.match(r.fallbackReason, /could not be checked/);
});

test('help printing nothing: a verified profile is still trusted', () => {
  useBin('silent-verified', { codex: 'exit 0' });
  const verified = { ...profiles.codex, verified: true };
  const probe = probeEngine(verified, { force: true });
  assert.equal(probe.checked, false);
  assert.equal(probe.compatible, true);
  assert.equal(resolveProfile({ ...config, profiles: { ...profiles, codex: verified } }).name, 'codex');
});

test('an old-format cache entry claiming compatible is ignored, and a verified change re-probes', async () => {
  const { FILES } = await import('../.harness/lib/common.mjs');
  const dir = useBin('stale-cache', { codex: 'exit 0' });
  const bin = path.join(dir, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  const oldKey = `${bin}|${fs.statSync(bin).mtimeMs}|${profileFlags(profiles.codex).join(' ')}`;
  fs.writeFileSync(FILES.probe, JSON.stringify({ [oldKey]: { installed: true, checked: false, compatible: true, missing: [], binPath: bin } }));
  assert.equal(probeEngine(profiles.codex).compatible, false, 'old cache entry must not be reused');
  assert.equal(probeEngine({ ...profiles.codex, verified: true }).compatible, true, 'flipping verified must re-probe');
  assert.equal(probeEngine(profiles.codex).compatible, false, 'unverified result is cached separately');
});

test('a fresh install has no removed engine (gemini, orca); an existing config is kept as it is', () => {
  const fresh = fs.mkdtempSync(path.join(tmpRoot, 'inst-fresh-'));
  const own = fs.mkdtempSync(path.join(tmpRoot, 'inst-own-'));
  fs.mkdirSync(path.join(own, '.harness'), { recursive: true });
  const ownCfg = JSON.stringify({ profiles: { gemini: { args: ['--approval-mode', 'yolo', '-p', ''] } } });
  fs.writeFileSync(path.join(own, '.harness', 'config.json'), ownCfg);
  const installer = path.join(here, '..', 'install.mjs');
  spawnSync(process.execPath, [installer, fresh], { encoding: 'utf8' });
  spawnSync(process.execPath, [installer, own], { encoding: 'utf8' });
  const freshCfg = JSON.parse(fs.readFileSync(path.join(fresh, '.harness', 'config.json'), 'utf8'));
  assert.ok(!('gemini' in freshCfg.profiles) && !('orca' in freshCfg.profiles) && !freshCfg.autoOrder.includes('gemini'), 'fresh install must not have a removed engine');
  assert.ok(['claude', 'antigravity', 'codex'].every((e) => e in freshCfg.profiles), 'fresh install has the supported engines');
  assert.equal(fs.readFileSync(path.join(own, '.harness', 'config.json'), 'utf8'), ownCfg, 'existing config must be kept');
});

test('the installer\'s embedded .gitignore copy (used by npx installs) matches .gitignore', () => {
  const src = fs.readFileSync(path.join(here, '..', 'install.mjs'), 'utf8');
  const m = src.match(/^const GITIGNORE_BLOCK = (".*");$/m);
  assert.ok(m, 'GITIGNORE_BLOCK not found in install.mjs');
  assert.equal(JSON.parse(m[1]), fs.readFileSync(path.join(here, '..', '.gitignore'), 'utf8'), 'update GITIGNORE_BLOCK in install.mjs after editing .gitignore');
});

test('install.mjs --reset cleans a template copy: owner profile, rules, objectives, autonomy, removed engines, backlog', () => {
  const copy = fs.mkdtempSync(path.join(tmpRoot, 'tpl-copy-'));
  const H = path.join(copy, '.harness');
  fs.mkdirSync(path.join(H, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(H, 'memory', 'profile.md'), '# User profile\n- Name: Owner\n');
  fs.writeFileSync(path.join(H, 'memory', 'lessons.md'), '# Lessons\n- [L1] owner rule\n');
  fs.writeFileSync(path.join(H, 'charter.md'), '# Charter\n- autonomous: off\n\n## 1. Identity\n- Project objectives:\n  1. Owner goal.\n\n## 2. Next\n');
  fs.writeFileSync(path.join(H, 'config.json'), JSON.stringify({ activeProfile: 'gemini', autoOrder: ['gemini', 'claude'], profiles: { gemini: { args: ['-p', ''] }, claude: { args: ['-p'] } } }));
  fs.writeFileSync(path.join(H, 'backlog.json'), JSON.stringify({ version: '2.0.0', tasks: [{ id: 'X' }] }));
  fs.writeFileSync(path.join(H, 'team.json'), '{"keep":true}');
  const installer = path.join(here, '..', 'install.mjs');
  const r = spawnSync(process.execPath, [installer, '--reset'], { cwd: copy, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const read = (f) => fs.readFileSync(path.join(H, f), 'utf8');
  assert.match(read('memory/profile.md'), /- Name: \(fill me\)/);
  assert.doesNotMatch(read('memory/lessons.md'), /\[L1\]/);
  assert.match(read('charter.md'), /^- autonomous: on$/m);
  assert.match(read('charter.md'), /describe your product goals here/);
  assert.doesNotMatch(read('charter.md'), /Owner goal/);
  assert.match(read('charter.md'), /## 2\. Next/);
  const cfg = JSON.parse(read('config.json'));
  assert.deepEqual(Object.keys(cfg.profiles), ['claude'], 'an old gemini profile is dropped');
  assert.deepEqual(cfg.autoOrder, ['claude']);
  assert.equal(cfg.activeProfile, 'auto');
  assert.equal(JSON.parse(read('backlog.json')).tasks.length, 0);
  assert.equal(read('team.json'), '{"keep":true}', 'other files are not touched');
  const again = spawnSync(process.execPath, [installer, '--reset', copy, '--autonomous', 'off'], { encoding: 'utf8' });
  assert.equal(again.status, 0, again.stderr);
  assert.match(read('charter.md'), /^- autonomous: off$/m);
  const none = spawnSync(process.execPath, [installer, '--reset', fs.mkdtempSync(path.join(tmpRoot, 'no-harness-'))], { encoding: 'utf8' });
  assert.notEqual(none.status, 0, 'a folder without .harness/ is refused');
});

test('winQuote keeps an empty argument on Windows and quotes special characters', async () => {
  const { winQuote } = await import('../.harness/lib/common.mjs');
  assert.equal(winQuote(''), '""');
  assert.equal(winQuote('yolo'), 'yolo');
  assert.equal(winQuote('--approval-mode'), '--approval-mode');
  assert.equal(winQuote('a b'), '"a b"');
  assert.equal(winQuote('say "hi"'), '"say ""hi"""');
  assert.deepEqual(['--approval-mode', 'yolo', '-p', ''].map(winQuote), ['--approval-mode', 'yolo', '-p', '""']);
});
