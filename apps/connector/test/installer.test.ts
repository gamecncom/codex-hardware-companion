import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, access, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const connectorRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const installer = join(connectorRoot, 'scripts/install-package.mjs');

async function makeRelease(root: string) {
  await mkdir(join(root, 'bin'), { recursive: true }); await mkdir(join(root, 'runtime'), { recursive: true }); await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(join(root, 'VERSION'), '0.2.0\n');
  await writeFile(join(root, 'dist', 'cli.js'), '#!/bin/sh\nprintf cli-ok\n'); await chmod(join(root, 'dist', 'cli.js'), 0o755);
  await writeFile(join(root, 'runtime', 'node'), '#!/bin/sh\nprintf "runtime:%s\\n" "$1"\n'); await chmod(join(root, 'runtime', 'node'), 0o755);
  await mkdir(join(root, 'skills/hardware-companion'), { recursive: true });
  await writeFile(join(root, 'skills/hardware-companion/SKILL.md'), 'synthetic skill fixture');
  await writeFile(join(root, 'bin', 'companion'), '#!/bin/sh\nROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nexec "$ROOT/runtime/node" "$ROOT/dist/cli.js" "$@"\n'); await chmod(join(root, 'bin', 'companion'), 0o755);
  const files = ['VERSION', 'dist/cli.js', 'runtime/node', 'bin/companion', 'skills/hardware-companion/SKILL.md'];
  const lines = []; for (const file of files) lines.push(`${createHash('sha256').update(await readFile(join(root, file))).digest('hex')}  ${file}`);
  await writeFile(join(root, 'checksums.sha256'), `${lines.join('\n')}\n`);
}

test('installer rejects incomplete manifests and preserves an existing previous version', async t => {
  const base = await mkdtemp(join(tmpdir(), 'hc install validation '));
  t.after(() => rm(base, { recursive: true, force: true }));
  const release = join(base, 'release'), target = join(base, 'target');
  await makeRelease(release);
  const manifest = await readFile(join(release, 'checksums.sha256'), 'utf8');
  await writeFile(join(release, 'checksums.sha256'), manifest.split('\n').filter(line => !line.endsWith('  bin/companion')).join('\n'));
  await assert.rejects(() => run(process.execPath, [installer, '--from', release, '--install-root', target]), /RELEASE_REQUIRED_FILE_MISSING/);
  await assert.rejects(() => access(join(target, 'current')));
  await writeFile(join(release, 'checksums.sha256'), manifest);
  await mkdir(join(target, 'previous'), { recursive: true });
  await writeFile(join(target, 'previous', 'VERSION'), 'preserved');
  await assert.rejects(() => run(process.execPath, [installer, '--from', release, '--install-root', target]), /INSTALL_ROOT_OCCUPIED/);
  assert.equal(await readFile(join(target, 'previous', 'VERSION'), 'utf8'), 'preserved');
});

test('installer creates current in an explicit path with spaces and wrapper uses bundled runtime', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'hc package install ')); t.after(() => rm(base, { recursive: true, force: true }));
  const release = join(base, 'release package'); const installRoot = join(base, 'installed connector'); await makeRelease(release);
  await mkdir(installRoot, { recursive: true }); await writeFile(join(installRoot, 'config.json'), '{"token":"keep"}');
  const result = await run(process.execPath, [installer, '--from', release, '--install-root', installRoot]);
  const output = JSON.parse(result.stdout); assert.equal(output.ok, true); assert.equal(output.launchctl, 'not-called');
  assert.equal(await readFile(join(installRoot, 'current', 'VERSION'), 'utf8'), '0.2.0\n');
  assert.equal(await readFile(join(installRoot, 'config.json'), 'utf8'), '{"token":"keep"}');
  const wrapper = join(installRoot, 'current', 'bin', 'companion'); await access(wrapper);
  const invoked = await run(wrapper, ['doctor']); assert.match(invoked.stdout, /runtime:.*dist\/cli\.js/);
});

test('installer rejects occupied current and preserves old files', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'hc package occupied ')); t.after(() => rm(base, { recursive: true, force: true }));
  const release = join(base, 'release'); const installRoot = join(base, 'installed'); await makeRelease(release);
  await mkdir(join(installRoot, 'current'), { recursive: true }); await writeFile(join(installRoot, 'current', 'VERSION'), 'old\n');
  await assert.rejects(() => run(process.execPath, [installer, '--from', release, '--install-root', installRoot]), /INSTALL_ROOT_OCCUPIED/);
  assert.equal(await readFile(join(installRoot, 'current', 'VERSION'), 'utf8'), 'old\n');
});

test('real macOS light package installs with external Node and runs read-only CLI', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'hc real package ')); t.after(() => rm(base, { recursive: true, force: true }));
  const artifacts = join(base, 'artifacts with spaces'); const installRoot = join(base, 'installed connector');
  await mkdir(artifacts, { recursive: true });
  await run(process.execPath, [join(connectorRoot, 'scripts/package-macos.mjs')], { env: { ...process.env, HC_PACKAGE_OUT: artifacts } });
  const names = await readdir(artifacts);
  const tarball = names.find((name) => name.endsWith('.tar.gz'));
  assert.ok(tarball, 'package script must produce a tarball');
  await run('tar', ['-xzf', join(artifacts, tarball!), '-C', base]);
  const packageDir = join(base, tarball!.slice(0, -7));
  const checksumText = await readFile(join(packageDir, 'checksums.sha256'), 'utf8');
  for (const required of ['bin/companion', 'dist/cli.js', 'skills/hardware-companion/SKILL.md', 'VERSION']) assert.ok(checksumText.split(/\r?\n/).some((line) => line.endsWith(`  ${required}`)), `checksum missing ${required}`);
  assert.doesNotMatch(checksumText, /runtime\/node/);
  await mkdir(installRoot, { recursive: true }); await writeFile(join(installRoot, 'config.json'), '{"token":"keep"}');
  await run(process.execPath, [join(packageDir, 'scripts/install-package.mjs'), '--from', packageDir, '--install-root', installRoot, '--node', process.execPath]);
  const wrapper = join(installRoot, 'current', 'bin', 'companion'); await access(wrapper);
  assert.equal((await readFile(join(installRoot, 'current', 'runtime-node-path'), 'utf8')).trim(), process.execPath);
  let doctorOutput: any;
  try { await run(wrapper, ['doctor', '--binary', '/bin/echo'], { env: { PATH: '/usr/bin:/bin' } }); assert.fail('invalid synthetic app-server should not pass'); }
  catch (error: any) { doctorOutput = JSON.parse(String(error.stdout)); }
  assert.equal(doctorOutput.ok, false); assert.equal(doctorOutput.error.code, 'CONNECTOR_ERROR');
  assert.match(doctorOutput.error.message, /app-server exited/);
  assert.equal(await readFile(join(installRoot, 'config.json'), 'utf8'), '{"token":"keep"}');
});
