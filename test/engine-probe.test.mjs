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

const {
  probeEngine,
  profileFlags,
  resolveProfile,
  supportsModelListing,
  parseAvailableModels,
  listAvailableModels,
  pickModelFromAvailable,
  isModelUnavailableError,
  FILES
} = await import('../.harness/lib/common.mjs');

const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
function useNodeBin(name, scripts) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, `bin-node-${name}-`));
  for (const [bin, code] of Object.entries(scripts)) {
    const js = path.join(dir, `${bin}.impl.mjs`);
    fs.writeFileSync(js, code);
    const file = path.join(dir, bin);
    if (process.platform === 'win32') {
      fs.writeFileSync(`${file}.cmd`, `@echo off\r\n"${process.execPath}" "${js}" %*\r\n`);
    } else {
      fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`);
      fs.chmodSync(file, 0o755);
    }
  }
  return { dir, env: { ...process.env, [pathKey]: `${dir}${path.delimiter}${nodeDir}` } };
}

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

const CODEX_HELP = `printf '%s\\n' 'Usage: codex exec [options] [PROMPT]' '  -s, --sandbox <SANDBOX_MODE>  Select the sandbox policy' '  -m, --model <MODEL>  Model the agent should use' '  -c, --config <key=value>  Override a configuration value' '  -h, --help           Show help'`;
const AGY_HELP = `printf '%s\\n' 'Usage: agy [options]' '  -p, --prompt <text>  Run one prompt headless and exit' '  --model              Model for the current CLI session' '  -h, --help           Show help'`;

test('profileFlags extracts dash flags from args', () => {
  assert.deepEqual(profileFlags({ args: ['--yolo', 'sub', '--', '--x={p}'] }), ['--yolo']);
  assert.deepEqual(profileFlags(profiles.codex).sort(), ['--model', '--sandbox', '-c'], 'codex 0.169: exec --sandbox workspace-write, model + reasoning effort');
  assert.deepEqual(profileFlags(profiles.antigravity).sort(), ['--model', '-p'], 'agy has model tiers, so --model is probed too');
  assert.equal(profiles.antigravity.binary, 'agy');
  assert.equal(profiles.antigravity.promptVia, 'arg');
  assert.deepEqual(profiles.antigravity.args, ['-p', '{prompt}']);
});

test('fake codex listing --sandbox, --model and -c is compatible and auto picks it', () => {
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
  assert.deepEqual([...probe.missing].sort(), ['--model', '--sandbox', '-c']);
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

// codex is verified since 1.0.24; these tests need an UNVERIFIED profile, so they say so explicitly
const unverifiedCodex = { ...profiles.codex, verified: false };
const unverifiedConfig = { ...config, profiles: { ...profiles, codex: unverifiedCodex } };

test('help printing nothing: an unverified profile is rejected and auto falls through to agy', () => {
  useBin('silent', { codex: 'exit 0', agy: AGY_HELP });
  const probe = probeEngine(unverifiedCodex, { force: true });
  assert.equal(probe.installed, true);
  assert.equal(probe.checked, false);
  assert.equal(probe.compatible, false);
  assert.match(probe.error, /printed nothing/);
  assert.equal(resolveProfile(unverifiedConfig).name, 'antigravity');
  const r = resolveProfile(unverifiedConfig, 'codex');
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
  const oldKey = `${bin}|${fs.statSync(bin).mtimeMs}|${profileFlags(unverifiedCodex).join(' ')}`;
  fs.writeFileSync(FILES.probe, JSON.stringify({ [oldKey]: { installed: true, checked: false, compatible: true, missing: [], binPath: bin } }));
  assert.equal(probeEngine(unverifiedCodex).compatible, false, 'old cache entry must not be reused');
  assert.equal(probeEngine({ ...unverifiedCodex, verified: true }).compatible, true, 'flipping verified must re-probe');
  assert.equal(probeEngine(unverifiedCodex).compatible, false, 'unverified result is cached separately');
});

test('a fresh install has no removed engine (gemini, orca); an update keeps the owner\'s values and drops removed engines (1.0.24)', () => {
  const fresh = fs.mkdtempSync(path.join(tmpRoot, 'inst-fresh-'));
  const own = fs.mkdtempSync(path.join(tmpRoot, 'inst-own-'));
  fs.mkdirSync(path.join(own, '.harness'), { recursive: true });
  const ownCfg = JSON.stringify({ maxCycles: 7, profiles: { gemini: { args: ['--approval-mode', 'yolo', '-p', ''] } } });
  fs.writeFileSync(path.join(own, '.harness', 'config.json'), ownCfg);
  const installer = path.join(here, '..', 'install.mjs');
  spawnSync(process.execPath, [installer, fresh], { encoding: 'utf8' });
  spawnSync(process.execPath, [installer, own], { encoding: 'utf8' });
  const freshCfg = JSON.parse(fs.readFileSync(path.join(fresh, '.harness', 'config.json'), 'utf8'));
  assert.ok(!('gemini' in freshCfg.profiles) && !('orca' in freshCfg.profiles) && !freshCfg.autoOrder.includes('gemini'), 'fresh install must not have a removed engine');
  assert.ok(['claude', 'antigravity', 'codex'].every((e) => e in freshCfg.profiles), 'fresh install has the supported engines');
  const upd = JSON.parse(fs.readFileSync(path.join(own, '.harness', 'config.json'), 'utf8'));
  assert.equal(upd.maxCycles, 7, 'the owner\'s own value must be kept');
  assert.ok(!('gemini' in upd.profiles), 'a removed engine is dropped on update');
  assert.ok(['claude', 'antigravity', 'codex'].every((e) => e in upd.profiles), 'missing supported engines are added on update');
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
  // Since 1.0.26 the reset profile describes only the project; the owner's personal lines are gone (they belong in me.md).
  assert.match(read('memory/profile.md'), /^# Project profile[\s\S]*- What this project is: \(fill me\)/);
  assert.doesNotMatch(read('memory/profile.md'), /^- Name:/m);
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

test('working-method skills stay in this template and are not installed into other projects', () => {
  const dest = fs.mkdtempSync(path.join(tmpRoot, 'inst-skills-'));
  const r = spawnSync(process.execPath, [path.join(here, '..', 'install.mjs'), dest, '--no-skills'], { encoding: 'utf8', env: { ...process.env, HARNESS_OFFLINE: '1' } });
  assert.equal(r.status, 0, r.stderr);
  for (const f of ['.harness/skills/template-leak-check', '.harness/skills/engine-profile-checks']) {
    assert.ok(fs.existsSync(path.join(here, '..', f, 'SKILL.md')), `${f} is missing from this template`);
    assert.ok(!fs.existsSync(path.join(dest, f)), `${f} must not be installed into other projects`);
  }
  assert.ok(fs.existsSync(path.join(here, '..', '.claude', 'skills', 'harness-phased-workflow', 'SKILL.md')), 'template skills are missing');
  assert.ok(!fs.existsSync(path.join(dest, '.claude', 'skills')), '.claude/skills belongs to Skill Foundry in an installed project');
  assert.ok(fs.existsSync(path.join(dest, '.harness', 'skills', 'code-craft', 'SKILL.md')), 'the shipped starter skills are still installed');
});

test('winQuote keeps an empty argument on Windows, collapses newlines for cmd.exe, and needsWinShell only matches .cmd/.bat on Windows', async () => {
  const { winQuote, winCommandLine, needsWinShell } = await import('../.harness/lib/common.mjs');
  assert.equal(winQuote(''), '""');
  assert.equal(winQuote('yolo'), 'yolo');
  assert.equal(winQuote('--approval-mode'), '--approval-mode');
  assert.equal(winQuote('a b'), '"a b"');
  assert.equal(winQuote('say "hi"'), '"say ""hi"""');
  assert.equal(winQuote('line1\n\nline2\r\nline3'), '"line1  line2 line3"');
  assert.equal(winCommandLine('C:\\Users\\x\\agy.exe', ['-p', 'header\n\ngoal', '--model', 'm']), 'C:\\Users\\x\\agy.exe -p "header  goal" --model m');
  assert.deepEqual(['--approval-mode', 'yolo', '-p', ''].map(winQuote), ['--approval-mode', 'yolo', '-p', '""']);
  assert.equal(needsWinShell('C:\\Users\\x\\AppData\\Local\\agy\\bin\\agy.EXE'), false, 'native .exe must never use cmd.exe');
  assert.equal(needsWinShell('C:\\Users\\x\\AppData\\Roaming\\npm\\claude.CMD'), process.platform === 'win32');
});

test('supportsModelListing detects agy and explicit modelsCommand profiles only', () => {
  assert.equal(supportsModelListing(profiles.antigravity), true);
  assert.equal(supportsModelListing({ binary: 'C:\\tools\\agy.exe' }), true);
  assert.equal(supportsModelListing({ binary: 'custom-cli', modelsCommand: ['list-models'] }), true);
  assert.equal(supportsModelListing(profiles.claude), false);
  assert.equal(supportsModelListing(profiles.codex), false);
  assert.equal(supportsModelListing({ binary: 'other' }), false);
  assert.equal(supportsModelListing(null), false);
});

test('parseAvailableModels extracts deduplicated model IDs and skips headers, usage lines, and flags', () => {
  const sample = [
    'Fetching available models...',
    'Available models:',
    '',
    '  gemini-4-carbon-low       Gemini 4 Carbon (Low)',
    '  gemini-4-carbon-medium    Gemini 4 Carbon (Medium)',
    '  gemini-4-hydrogen-high    Gemini 4 Hydrogen (High)',
    '  claude-sonnet-5-5-medium  Claude Sonnet 5.5',
    '  gemini-3.8-flash-medium   Legacy Flash',
    '  gemini-4-carbon-low       duplicate should be ignored',
    '  -p, --prompt <text>       CLI flag',
    '  Usage: agy models',
    '  Error: transient notice',
    '  Warning: deprecated notice',
    '  Models                    single word header',
    '  sonnet                    single word alias'
  ].join('\n');
  assert.deepEqual(parseAvailableModels(sample), [
    'gemini-4-carbon-low',
    'gemini-4-carbon-medium',
    'gemini-4-hydrogen-high',
    'claude-sonnet-5-5-medium',
    'gemini-3.8-flash-medium'
  ]);
  assert.deepEqual(parseAvailableModels('Usage: agy [options]\n  -p, --prompt <text>  Run headless\n  --model  Model\n'), []);
  assert.deepEqual(parseAvailableModels(''), []);
  assert.deepEqual(parseAvailableModels(null), []);
});

test('pickModelFromAvailable keeps available preferred models, picks best tier/family fallback, and respects exclude', () => {
  const listed = [
    'gemini-4-orchestrator-medium',
    'gemini-3.8-flash-medium',
    'gemini-4-carbon-low',
    'gemini-4-carbon-medium',
    'gemini-4-hydrogen-high',
    'claude-sonnet-5-5-medium',
    'claude-opus-5-5-high'
  ];

  assert.deepEqual(pickModelFromAvailable(listed, { tier: 'fast', preferred: 'gemini-4-carbon-low' }), {
    model: 'gemini-4-carbon-low',
    autoPicked: false,
    reason: null
  });
  assert.equal(pickModelFromAvailable([], { tier: 'medium', preferred: 'gemini-4-argon-medium' }), null);
  assert.equal(pickModelFromAvailable(['a-model'], { tier: 'medium', exclude: ['a-model'] }), null);

  const fastPick = pickModelFromAvailable(listed, { tier: 'fast', preferred: 'gemini-3.8-flash-low' });
  assert.equal(fastPick.model, 'gemini-4-carbon-low');
  assert.equal(fastPick.autoPicked, true);
  assert.match(fastPick.reason, /gemini-3\.8-flash-low.*gemini-4-carbon-low.*\[fast\]/);

  const medPick = pickModelFromAvailable(listed, { tier: 'medium', preferred: 'gemini-4-argon-medium' });
  assert.equal(medPick.model, 'gemini-4-carbon-medium');
  assert.equal(medPick.autoPicked, true);

  const highPick = pickModelFromAvailable(listed, { tier: 'high', preferred: 'gemini-4-argon-high' });
  assert.equal(highPick.model, 'gemini-4-hydrogen-high');
  assert.equal(highPick.autoPicked, true);

  const claudeHigh = pickModelFromAvailable(listed, { tier: 'high', preferred: 'claude-opus-4-5-high' });
  assert.equal(claudeHigh.model, 'claude-opus-5-5-high');
  assert.equal(claudeHigh.autoPicked, true);

  const claudeMed = pickModelFromAvailable(listed, { tier: 'medium', preferred: 'claude-sonnet-4-5-medium' });
  assert.equal(claudeMed.model, 'claude-sonnet-5-5-medium');
  assert.equal(claudeMed.autoPicked, true);

  const excludedPick = pickModelFromAvailable(listed, {
    tier: 'medium',
    preferred: 'gemini-4-carbon-medium',
    exclude: ['gemini-4-carbon-medium']
  });
  assert.notEqual(excludedPick.model, 'gemini-4-carbon-medium');
  assert.equal(excludedPick.autoPicked, true);
});

test('listAvailableModels uses fake agy binary, honors 6h cache and force refresh, and returns null gracefully when binary prints help or fails', () => {
  assert.deepEqual(listAvailableModels(profiles.claude), { supported: false, models: null });

  const emptyEnv = { ...process.env, [pathKey]: nodeDir };
  const missing = listAvailableModels(profiles.antigravity, { env: emptyEnv });
  assert.equal(missing.supported, true);
  assert.equal(missing.models, null);
  assert.equal(missing.error, 'not installed');

  const cfgFile = path.join(tmpRoot, 'agy-live-state.json');
  const countFile = path.join(tmpRoot, 'agy-live-count.txt');
  fs.writeFileSync(cfgFile, JSON.stringify({
    mode: 'list',
    models: ['gemini-4-carbon-low', 'gemini-4-carbon-medium', 'gemini-4-hydrogen-high']
  }));
  fs.writeFileSync(countFile, '0');

  const fake = useNodeBin('agy-live', {
    agy: `
import fs from 'node:fs';
const st = JSON.parse(fs.readFileSync(${JSON.stringify(cfgFile)}, 'utf8'));
const c = Number(fs.readFileSync(${JSON.stringify(countFile)}, 'utf8') || '0') + 1;
fs.writeFileSync(${JSON.stringify(countFile)}, String(c));
if (st.mode === 'help') {
  console.log('Usage: agy [options]\\n  -p, --prompt <text>  Run one prompt headless and exit\\n  --model              Model');
  process.exit(0);
}
if (st.mode === 'fail') {
  console.error('models subcommand failed');
  process.exit(1);
}
if (process.argv[2] !== 'models') process.exit(2);
console.log('Available models:\\n' + st.models.map((m) => '  ' + m + '  Desc').join('\\n'));
`
  });

  const first = listAvailableModels(profiles.antigravity, { env: fake.env });
  assert.equal(first.supported, true);
  assert.equal(first.cached, false);
  assert.deepEqual(first.models, ['gemini-4-carbon-low', 'gemini-4-carbon-medium', 'gemini-4-hydrogen-high']);
  assert.equal(fs.readFileSync(countFile, 'utf8'), '1');

  // Within the 6h cache window, updated binary output is not re-queried.
  fs.writeFileSync(cfgFile, JSON.stringify({
    mode: 'list',
    models: ['gemini-4-carbon-low', 'gemini-4-carbon-medium', 'gemini-5-nova-high']
  }));
  const second = listAvailableModels(profiles.antigravity, { env: fake.env });
  assert.equal(second.cached, true);
  assert.deepEqual(second.models, ['gemini-4-carbon-low', 'gemini-4-carbon-medium', 'gemini-4-hydrogen-high']);
  assert.equal(fs.readFileSync(countFile, 'utf8'), '1');

  // After 6h expires, the cache refreshes automatically.
  const probeCache = JSON.parse(fs.readFileSync(FILES.probe, 'utf8'));
  const modelKey = Object.keys(probeCache).find((k) => k.startsWith('models|v1|') && k.includes(fake.dir));
  assert.ok(modelKey, 'model list cache entry should exist in FILES.probe');
  probeCache[modelKey].checkedAt = Date.now() - (6 * 3600 * 1000 + 5000);
  fs.writeFileSync(FILES.probe, JSON.stringify(probeCache, null, 2));

  const expired = listAvailableModels(profiles.antigravity, { env: fake.env });
  assert.equal(expired.cached, false);
  assert.deepEqual(expired.models, ['gemini-4-carbon-low', 'gemini-4-carbon-medium', 'gemini-5-nova-high']);
  assert.equal(fs.readFileSync(countFile, 'utf8'), '2');

  // force: true bypasses a still-fresh 6h cache.
  fs.writeFileSync(cfgFile, JSON.stringify({
    mode: 'list',
    models: ['gemini-5-nova-low', 'gemini-5-nova-high']
  }));
  assert.equal(listAvailableModels(profiles.antigravity, { env: fake.env }).cached, true);
  const forced = listAvailableModels(profiles.antigravity, { force: true, env: fake.env });
  assert.equal(forced.cached, false);
  assert.deepEqual(forced.models, ['gemini-5-nova-low', 'gemini-5-nova-high']);
  assert.equal(fs.readFileSync(countFile, 'utf8'), '3');

  // Graceful null when binary prints help instead of model IDs (and force clears stale cache).
  fs.writeFileSync(cfgFile, JSON.stringify({ mode: 'help' }));
  const helpOut = listAvailableModels(profiles.antigravity, { force: true, env: fake.env });
  assert.equal(helpOut.supported, true);
  assert.equal(helpOut.models, null);
  assert.equal(helpOut.error, 'empty model list');

  // Graceful null when binary exits non-zero.
  fs.writeFileSync(cfgFile, JSON.stringify({ mode: 'fail' }));
  const failOut = listAvailableModels(profiles.antigravity, { force: true, env: fake.env });
  assert.equal(failOut.supported, true);
  assert.equal(failOut.models, null);
  assert.match(failOut.error, /models subcommand failed/);
});

test('isModelUnavailableError matches retired/unknown model errors and ignores quota/auth/generic errors', () => {
  for (const msg of [
    'Error: unknown model gemini-4-argon-medium',
    "Invalid model: 'gemini-3.8-flash-medium'",
    'Model "gemini-4-argon-medium" not found',
    'Model gemini-4-argon-medium is no longer available',
    'Model gemini-3.8-flash-medium has been retired',
    'Cannot find model gemini-4-argon-low',
    'Does not support model gemini-3.8-flash-medium',
    'Unsupported model specified'
  ]) {
    assert.equal(isModelUnavailableError(msg), true, `expected unavailable error match: ${msg}`);
  }
  for (const msg of [
    '',
    null,
    undefined,
    "You've hit your 5-hour limit",
    'ERROR: You exceeded your current quota (RESOURCE_EXHAUSTED)',
    'Error: not logged in. Please log in.',
    'Model gemini-4-argon-medium is available',
    'TypeError: Cannot read properties of undefined'
  ]) {
    assert.equal(isModelUnavailableError(msg), false, `must not match non-model error: ${msg}`);
  }
});

test('install.mjs upgradeConfig migrates retired Antigravity defaults in profiles.antigravity.models and quotaFallback.codex.models while keeping custom owner models', () => {
  const proj = fs.mkdtempSync(path.join(tmpRoot, 'inst-agy-migrate-'));
  fs.mkdirSync(path.join(proj, '.harness'), { recursive: true });
  const existing = {
    maxCycles: 9,
    activeProfile: 'auto',
    autoOrder: ['antigravity', 'claude', 'codex'],
    profiles: {
      claude: realConfig.profiles.claude,
      codex: realConfig.profiles.codex,
      antigravity: {
        ...realConfig.profiles.antigravity,
        models: {
          fast: 'gemini-3.8-flash-medium',
          medium: 'gemini-4-argon-medium',
          high: 'owner-custom-high'
        }
      }
    },
    quotaFallback: {
      claude: realConfig.quotaFallback.claude,
      codex: {
        engine: 'antigravity',
        models: {
          fast: 'gemini-3.8-flash-low',
          medium: 'gemini-4-argon-medium',
          high: 'owner-fallback-high'
        }
      },
      antigravity: realConfig.quotaFallback.antigravity
    }
  };
  fs.writeFileSync(path.join(proj, '.harness', 'config.json'), JSON.stringify(existing, null, 2));

  const installer = path.join(here, '..', 'install.mjs');
  const r = spawnSync(process.execPath, [installer, proj, '--no-skills', '--no-auto-assign'], {
    encoding: 'utf8',
    env: { ...process.env, HARNESS_OFFLINE: '1' }
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /update \.harness[\\/]config\.json/);

  const upgraded = JSON.parse(fs.readFileSync(path.join(proj, '.harness', 'config.json'), 'utf8'));
  assert.equal(upgraded.maxCycles, 9);
  assert.equal(upgraded.profiles.antigravity.models.fast, realConfig.profiles.antigravity.models.fast);
  assert.equal(upgraded.profiles.antigravity.models.medium, realConfig.profiles.antigravity.models.medium);
  assert.equal(upgraded.profiles.antigravity.models.high, 'owner-custom-high', 'custom owner model must stay');
  assert.equal(upgraded.quotaFallback.codex.models.fast, realConfig.quotaFallback.codex.models.fast);
  assert.equal(upgraded.quotaFallback.codex.models.medium, realConfig.quotaFallback.codex.models.medium);
  assert.equal(upgraded.quotaFallback.codex.models.high, 'owner-fallback-high', 'custom owner quotaFallback model must stay');

  // Second install must preserve everything cleanly without touching custom models.
  const again = spawnSync(process.execPath, [installer, proj, '--no-skills', '--no-auto-assign'], {
    encoding: 'utf8',
    env: { ...process.env, HARNESS_OFFLINE: '1' }
  });
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /kept\s+\.harness[\\/]config\.json/);

  // Fully custom Antigravity models (non-retired IDs) are never overwritten.
  const customProj = fs.mkdtempSync(path.join(tmpRoot, 'inst-agy-custom-'));
  fs.mkdirSync(path.join(customProj, '.harness'), { recursive: true });
  const customCfg = JSON.parse(JSON.stringify(realConfig));
  customCfg.profiles.antigravity.models = { fast: 'my-fast', medium: 'my-medium', high: 'my-high' };
  customCfg.quotaFallback.codex.models = { fast: 'fb-fast', medium: 'fb-medium', high: 'fb-high' };
  fs.writeFileSync(path.join(customProj, '.harness', 'config.json'), JSON.stringify(customCfg, null, 2));
  const rc = spawnSync(process.execPath, [installer, customProj, '--no-skills', '--no-auto-assign'], {
    encoding: 'utf8',
    env: { ...process.env, HARNESS_OFFLINE: '1' }
  });
  assert.equal(rc.status, 0, rc.stderr);
  const kept = JSON.parse(fs.readFileSync(path.join(customProj, '.harness', 'config.json'), 'utf8'));
  assert.deepEqual(kept.profiles.antigravity.models, { fast: 'my-fast', medium: 'my-medium', high: 'my-high' });
  assert.deepEqual(kept.quotaFallback.codex.models, { fast: 'fb-fast', medium: 'fb-medium', high: 'fb-high' });
});
