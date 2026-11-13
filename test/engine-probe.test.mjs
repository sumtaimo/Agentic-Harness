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

const here = path.dirname(fileURLToPath(import.meta.url));
const realConfig = JSON.parse(fs.readFileSync(path.join(here, '..', '.harness', 'config.json'), 'utf8'));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-probe-'));
fs.mkdirSync(path.join(tmpRoot, '.harness'), { recursive: true });
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
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(file, 0o755);
  }
  process.env.PATH = `${dir}${path.delimiter}${nodeDir}`;
  return dir;
}

const profiles = { gemini: realConfig.profiles.gemini, antigravity: realConfig.profiles.antigravity };
const config = { profiles, autoOrder: ['gemini', 'antigravity'], activeProfile: 'auto' };
const originalPath = process.env.PATH;

before(() => {
  assert.ok(profiles.gemini && profiles.antigravity, 'config.json must define gemini and antigravity');
});
after(() => {
  process.env.PATH = originalPath;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const GEMINI_HELP = `printf '%s\\n' 'Usage: gemini [options]' '  -p, --prompt         Prompt; runs non-interactively' '  --approval-mode      default | auto_edit | yolo' '  -h, --help           Show help'`;
const AGY_HELP = `printf '%s\\n' 'Usage: agy [options]' '  -p, --prompt <text>  Run one prompt headless and exit' '  -h, --help           Show help'`;

test('profileFlags extracts dash flags from args', () => {
  assert.deepEqual(profileFlags({ args: ['--yolo', 'sub', '--', '--x={p}'] }), ['--yolo']);
  assert.deepEqual(profileFlags(profiles.gemini).sort(), ['--approval-mode', '-p']);
  assert.deepEqual(profileFlags(profiles.antigravity), ['-p']);
  assert.equal(profiles.antigravity.binary, 'agy');
  assert.equal(profiles.antigravity.promptVia, 'stdin');
  assert.deepEqual(profiles.antigravity.args, ['-p', '']);
});

test('fake gemini listing -p and --approval-mode is compatible and auto picks it', () => {
  useBin('gemini-ok', { gemini: GEMINI_HELP });
  const probe = probeEngine(profiles.gemini, { force: true });
  assert.equal(probe.installed, true);
  assert.equal(probe.checked, true);
  assert.equal(probe.compatible, true);
  assert.deepEqual(probe.missing, []);
  assert.equal(resolveProfile(config).name, 'gemini');
});

test('an old gemini that only lists --yolo is incompatible and auto falls through to agy', () => {
  useBin('gemini-old', { gemini: `printf '%s\\n' '  -y, --yolo   Auto-approve'`, agy: AGY_HELP });
  const probe = probeEngine(profiles.gemini, { force: true });
  assert.equal(probe.compatible, false);
  assert.deepEqual([...probe.missing].sort(), ['--approval-mode', '-p']);
  assert.equal(resolveProfile(config).name, 'antigravity');
});

test('fake agy listing -p is compatible', () => {
  useBin('agy-ok', { agy: AGY_HELP });
  const probe = probeEngine(profiles.antigravity, { force: true });
  assert.equal(probe.installed, true);
  assert.equal(probe.compatible, true);
  assert.equal(resolveProfile(config, 'antigravity').name, 'antigravity');
});

test('agy whose help lacks -p is incompatible and falls back to gemini', () => {
  useBin('agy-bad', { gemini: GEMINI_HELP, agy: `printf '%s\\n' 'Usage: agy [options] [paths...]' '  -n --new-window   Open a new window'` });
  const probe = probeEngine(profiles.antigravity, { force: true });
  assert.equal(probe.compatible, false);
  assert.deepEqual(probe.missing, ['-p']);
  const r = resolveProfile(config, 'antigravity');
  assert.equal(r.fallbackFrom, 'antigravity');
  assert.equal(r.name, 'gemini');
  assert.match(r.fallbackReason, /-p/);
});

test('no gemini or agy on PATH gives installed=false', () => {
  useBin('none', {});
  for (const p of [profiles.gemini, profiles.antigravity]) {
    const probe = probeEngine(p, { force: true });
    assert.equal(probe.installed, false);
    assert.equal(probe.binPath, null);
  }
});

test('help printing nothing: an unverified profile is rejected and auto falls through to agy', () => {
  useBin('silent', { gemini: 'exit 0', agy: AGY_HELP });
  const probe = probeEngine(profiles.gemini, { force: true });
  assert.equal(probe.installed, true);
  assert.equal(probe.checked, false);
  assert.equal(probe.compatible, false);
  assert.match(probe.error, /printed nothing/);
  assert.equal(resolveProfile(config).name, 'antigravity');
  const r = resolveProfile(config, 'gemini');
  assert.equal(r.fallbackFrom, 'gemini');
  assert.match(r.fallbackReason, /could not be checked/);
});

test('help printing nothing: a verified profile is still trusted', () => {
  useBin('silent-verified', { gemini: 'exit 0' });
  const verified = { ...profiles.gemini, verified: true };
  const probe = probeEngine(verified, { force: true });
  assert.equal(probe.checked, false);
  assert.equal(probe.compatible, true);
  assert.equal(resolveProfile({ ...config, profiles: { ...profiles, gemini: verified } }).name, 'gemini');
});

test('an old-format cache entry claiming compatible is ignored, and a verified change re-probes', async () => {
  const { FILES } = await import('../.harness/lib/common.mjs');
  const dir = useBin('stale-cache', { gemini: 'exit 0' });
  const bin = path.join(dir, 'gemini');
  const oldKey = `${bin}|${fs.statSync(bin).mtimeMs}|${profileFlags(profiles.gemini).join(' ')}`;
  fs.writeFileSync(FILES.probe, JSON.stringify({ [oldKey]: { installed: true, checked: false, compatible: true, missing: [], binPath: bin } }));
  assert.equal(probeEngine(profiles.gemini).compatible, false, 'old cache entry must not be reused');
  assert.equal(probeEngine({ ...profiles.gemini, verified: true }).compatible, true, 'flipping verified must re-probe');
  assert.equal(probeEngine(profiles.gemini).compatible, false, 'unverified result is cached separately');
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
