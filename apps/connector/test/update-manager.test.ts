import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UpdateManager } from '../src/updateManager.js';
import { ServiceManager, type LaunchctlResult } from '../src/serviceManager.js';

async function release(root: string, version: string, content: string) {
  await mkdir(root, { recursive: true });
  const file = join(root, 'dist', 'cli.js');
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(join(root, 'VERSION'), `${version}\n`);
  await writeFile(file, content);
  const hash = createHash('sha256').update(content).digest('hex');
  await writeFile(join(root, 'checksums.sha256'), `${hash}  dist/cli.js\n`);
}

function fakeService() {
  const calls: string[] = [];
  return { calls, stop: async () => { calls.push('stop'); }, start: async () => { calls.push('start'); } };
}

test('same verified release reuses the running service without rotation', async t => {
  const base = await mkdtemp(join(tmpdir(), 'hc-update-reuse-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'install'), candidate = join(base, 'candidate');
  await release(candidate, '0.3.10', 'same');
  await release(join(root, 'current'), '0.3.10', 'same');
  const service = fakeService();
  const result = await new UpdateManager({ installRoot: root, service, healthCheck: async () => true }).update(candidate);
  assert.equal(result.updated, false);
  assert.equal(result.rolledBack, false);
  assert.deepEqual(service.calls, []);
  await assert.rejects(() => access(join(root, 'previous')));
});

test('update verifies release, rotates current to previous, and preserves config', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'hc-update-')); const root = join(base, 'install'); t.after(() => rm(base, { recursive: true, force: true }));
  const candidate = join(base, 'candidate'); await release(candidate, '0.2.1', 'new');
  await mkdir(join(root, 'current'), { recursive: true }); await writeFile(join(root, 'current', 'VERSION'), '0.2.0\n');
  await mkdir(join(root, 'Library', 'Application Support', 'HardwareCompanion'), { recursive: true });
  await writeFile(join(root, 'Library', 'Application Support', 'HardwareCompanion', 'config.json'), '{"token":"keep"}');
  const service = fakeService();
  const result = await new UpdateManager({ installRoot: root, service, healthCheck: async () => true }).update(candidate);
  assert.deepEqual(result, { updated: true, rolledBack: false, version: '0.2.1', previousVersion: '0.2.0', installRoot: root });
  assert.equal(await readFile(join(root, 'current', 'VERSION'), 'utf8'), '0.2.1\n');
  assert.equal(await readFile(join(root, 'previous', 'VERSION'), 'utf8'), '0.2.0\n');
  assert.equal(await readFile(join(root, 'Library', 'Application Support', 'HardwareCompanion', 'config.json'), 'utf8'), '{"token":"keep"}');
  assert.deepEqual(service.calls, ['stop', 'start']);
});

test('failed health check restores previous and reports rollback', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'hc-update-')); const root = join(base, 'install'); t.after(() => rm(base, { recursive: true, force: true }));
  const candidate = join(base, 'candidate'); await release(candidate, '0.2.1', 'new');
  await mkdir(join(root, 'current'), { recursive: true }); await writeFile(join(root, 'current', 'VERSION'), '0.2.0\n');
  const service = fakeService();
  let checks = 0;
  const result = await new UpdateManager({ installRoot: root, service, healthWaitMs: 0, healthCheck: async () => ++checks === 2 }).update(candidate);
  assert.equal(result.rolledBack, true); assert.equal(result.updated, false); assert.equal(result.version, '0.2.0');
  assert.equal(await readFile(join(root, 'current', 'VERSION'), 'utf8'), '0.2.0\n');
  assert.deepEqual(service.calls, ['stop', 'start', 'stop', 'start']);
});

test('checksum failure does not stop service or alter current', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'hc-update-')); const root = join(base, 'install'); t.after(() => rm(base, { recursive: true, force: true }));
  const candidate = join(base, 'candidate'); await release(candidate, '0.2.1', 'new'); await writeFile(join(candidate, 'checksums.sha256'), `${'0'.repeat(64)}  dist/cli.js\n`);
  await mkdir(join(root, 'current'), { recursive: true }); await writeFile(join(root, 'current', 'VERSION'), '0.2.0\n');
  const service = fakeService();
  await assert.rejects(() => new UpdateManager({ installRoot: root, service, healthCheck: async () => true }).update(candidate), /RELEASE_CHECKSUM_MISMATCH/);
  assert.equal(await readFile(join(root, 'current', 'VERSION'), 'utf8'), '0.2.0\n');
  assert.deepEqual(service.calls, []);
  await assert.rejects(() => access(join(root, 'previous')));
});

test('stop failure preserves current, previous, and config byte-for-byte', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'hc-update-')); const root = join(base, 'install'); t.after(() => rm(base, { recursive: true, force: true }));
  const candidate = join(base, 'candidate'); await release(candidate, '0.2.1', 'new');
  await mkdir(join(root, 'current'), { recursive: true }); await writeFile(join(root, 'current', 'VERSION'), '0.2.0\n');
  await mkdir(join(root, 'previous'), { recursive: true }); await writeFile(join(root, 'previous', 'VERSION'), '0.1.0\n');
  const config = join(root, 'config.json'); await writeFile(config, '{"token":"keep"}\n');
  const service = { stop: async () => { throw new Error('STOP_FAILED'); }, start: async () => {} };
  await assert.rejects(() => new UpdateManager({ installRoot: root, service, healthCheck: async () => true }).update(candidate), /STOP_FAILED/);
  assert.equal(await readFile(join(root, 'current', 'VERSION'), 'utf8'), '0.2.0\n');
  assert.equal(await readFile(join(root, 'previous', 'VERSION'), 'utf8'), '0.1.0\n');
  assert.equal(await readFile(config, 'utf8'), '{"token":"keep"}\n');
});

test('rollback service restart failure is reported instead of success', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'hc-update-')); const root = join(base, 'install'); t.after(() => rm(base, { recursive: true, force: true }));
  const candidate = join(base, 'candidate'); await release(candidate, '0.2.1', 'new');
  await mkdir(join(root, 'current'), { recursive: true }); await writeFile(join(root, 'current', 'VERSION'), '0.2.0\n');
  let starts = 0;
  const service = { stop: async () => {}, start: async () => { starts += 1; if (starts === 2) throw new Error('RESTART_FAILED'); } };
  await assert.rejects(() => new UpdateManager({ installRoot: root, service, healthWaitMs: 0, healthCheck: async () => false }).update(candidate), /UPDATE_ROLLBACK_FAILED:RESTART_FAILED/);
  assert.equal(await readFile(join(root, 'current', 'VERSION'), 'utf8'), '0.2.0\n');
});

test('candidate overlapping install root is rejected before service mutation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hc-update-')); t.after(() => rm(root, { recursive: true, force: true }));
  const service = fakeService();
  await assert.rejects(() => new UpdateManager({ installRoot: root, service, healthCheck: async () => true }).update(join(root, 'candidate')), /RELEASE_INSTALL_ROOT_OVERLAP/);
  assert.deepEqual(service.calls, []);
});

test('update waits for a newly started service to become healthy', async t => {
  const base = await mkdtemp(join(tmpdir(), 'hc-update-delayed-health-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'install'); const candidate = join(base, 'candidate');
  await release(candidate, '0.2.1', 'new');
  await mkdir(join(root, 'current'), { recursive: true });
  await writeFile(join(root, 'current', 'VERSION'), '0.2.0\n');
  let checks = 0;
  const result = await new UpdateManager({ installRoot: root, service: fakeService(), healthWaitMs: 1000, healthCheck: async () => ++checks >= 3 }).update(candidate);
  assert.equal(result.updated, true);
  assert.equal(result.rolledBack, false);
  assert.equal(checks, 3);
});

test('update reuses the install-root plist and health-checks the new version', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'hc-update-')); const root = join(base, 'install'); const home = join(base, 'home');
  t.after(() => rm(base, { recursive: true, force: true }));
  const candidate = join(base, 'candidate'); await release(candidate, '0.2.1', 'new');
  await mkdir(join(root, 'current'), { recursive: true }); await writeFile(join(root, 'current', 'VERSION'), '0.2.0\n');
  let loaded = false; const calls: string[][] = [];
  const launchctl = async (args: string[]): Promise<LaunchctlResult> => {
    calls.push(args);
    if (args[0] === 'print') return loaded ? { code: 0, stdout: 'state = running\n', stderr: '' } : { code: 113, stdout: '', stderr: 'Could not find service' };
    if (args[0] === 'bootstrap') { loaded = true; return { code: 0, stdout: '', stderr: '' }; }
    if (args[0] === 'bootout') { loaded = false; return { code: 0, stdout: '', stderr: '' }; }
    if (args[0] === 'kickstart') return { code: 0, stdout: '', stderr: '' };
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  const service = new ServiceManager({ homeDir: home, installRoot: root, uid: 501, launchctl });
  await service.install();
  const plist = await readFile(service.plistPath, 'utf8');
  assert.match(plist, new RegExp(process.execPath));
  assert.match(plist, new RegExp(`${root}/current/dist/cli\\.js`));
  const observed: string[] = [];
  const result = await new UpdateManager({
    installRoot: root,
    service,
    healthCheck: async (expected) => {
      observed.push((await readFile(join(root, 'current', 'VERSION'), 'utf8')).trim());
      return (await service.status()).running && observed.at(-1) === expected;
    },
  }).update(candidate);
  assert.equal(result.version, '0.2.1');
  assert.deepEqual(observed, ['0.2.1']);
  assert.ok(calls.some((args) => args[0] === 'bootstrap' && args[2] === service.plistPath));
});
