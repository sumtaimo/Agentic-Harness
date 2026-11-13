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

test('profileFlags extracts dash flags from args', () => {
  assert.deepEqual(profileFlags({ args: ['--yolo', 'sub', '--', '--x={p}'] }), ['--yolo']);
  assert.deepEqual(profileFlags(profiles.antigravity).sort(), ['--headless', '--json']);
});

test('fake gemini listing -y, --yolo is compatible and auto picks it', () => {
  useBin('gemini-ok', {
    gemini: `printf '%s\\n' 'Usage: gemini [options]' '  -y, --yolo   Auto-approve all actions' '  -h, --help   Show help'`,
  });
  const probe = probeEngine(profiles.gemini, { force: true });
  assert.equal(probe.installed, true);
  assert.equal(probe.checked, true);
  assert.equal(probe.compatible, true);
  assert.deepEqual(probe.missing, []);
  assert.equal(resolveProfile(config).name, 'gemini');
});

test('fake antigravity with VS Code style help is incompatible and falls back', () => {
  useBin('ag-vscode', {
    gemini: `printf '%s\\n' '  -y, --yolo   Auto-approve'`,
    antigravity: `printf '%s\\n' 'Visual Studio Code' 'Usage: antigravity [options] [paths...]' '  -d --diff <file> <file>  Compare two files' '  -h --help   Print usage'`,
  });
  const probe = probeEngine(profiles.antigravity, { force: true });
  assert.equal(probe.installed, true);
  assert.equal(probe.checked, true);
  assert.equal(probe.compatible, false);
  assert.deepEqual([...probe.missing].sort(), ['--headless', '--json']);
  const r = resolveProfile(config, 'antigravity');
  assert.equal(r.fallbackFrom, 'antigravity');
  assert.equal(r.name, 'gemini');
  assert.match(r.fallbackReason, /--headless/);
});

test('no gemini or antigravity on PATH gives installed=false', () => {
  useBin('none', {});
  for (const p of [profiles.gemini, profiles.antigravity]) {
    const probe = probeEngine(p, { force: true });
    assert.equal(probe.installed, false);
    assert.equal(probe.binPath, null);
  }
});

test('help printing nothing gives checked=false and is treated as compatible', () => {
  useBin('silent', { gemini: 'exit 0' });
  const probe = probeEngine(profiles.gemini, { force: true });
  assert.equal(probe.installed, true);
  assert.equal(probe.checked, false);
  assert.equal(probe.compatible, true);
  assert.equal(resolveProfile(config).name, 'gemini');
});
