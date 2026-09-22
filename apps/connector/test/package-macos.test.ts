import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const run = promisify(execFile);

test('macOS package wrapper runs from a spaced staging path and embeds skill/checksums', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hc-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, 'release path with spaces');
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const script = join(repoRoot, 'apps', 'connector', 'scripts', 'package-macos.mjs');
  const result = await run(process.execPath, [script], { env: { ...process.env, HC_PACKAGE_OUT: output } });
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ok, true);
  assert.equal(summary.arch, process.arch);
  assert.equal(summary.x64Built, false);
  const packageRoot = join(output, `hardware-companion-macos-${process.arch}-v0.3.0`);
  const wrapper = join(packageRoot, 'bin', 'companion');
  const config = join(root, 'config path with spaces.json');
  const wrapperResult = await run(wrapper, ['unknown-operation', '--config', config], { env: { PATH: '/usr/bin:/bin' } }).catch(error => error);
  assert.equal(wrapperResult.code, 1);
  const outputJson = JSON.parse(wrapperResult.stdout);
  assert.equal(outputJson.ok, false);
  assert.equal(outputJson.operation, 'unknown-operation --config ' + config);
  assert.match(await readFile(join(packageRoot, 'skills', 'hardware-companion', 'SKILL.md'), 'utf8'), /hardware-companion/);
  assert.equal((await readFile(join(packageRoot, 'VERSION'), 'utf8')).trim(), '0.3.0');
  const compatibility = JSON.parse(await readFile(join(packageRoot, 'compatibility.json'), 'utf8'));
  assert.equal(compatibility.architecture, process.arch);
  assert.equal(compatibility.protocol, 'hc/1');
  assert.equal((await stat(wrapper)).mode & 0o111, 0o111);
  const checksums = await readFile(join(packageRoot, 'checksums.sha256'), 'utf8');
  for (const line of checksums.trim().split('\n')) {
    const [expected, ...rest] = line.split('  ');
    const relative = rest.join('  ');
    assert.equal(createHash('sha256').update(await readFile(join(packageRoot, relative))).digest('hex'), expected, relative);
  }
  const archive = await readFile(summary.artifact);
  const archiveHash = createHash('sha256').update(archive).digest('hex');
  assert.equal(archiveHash, (await readFile(`${summary.artifact}.sha256`, 'utf8')).split(/\s+/)[0]);
});
