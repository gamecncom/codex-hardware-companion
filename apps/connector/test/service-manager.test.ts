import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, access, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServiceManager, type LaunchctlResult } from '../src/serviceManager.js';

function fakeLaunchctl() {
  let loaded = false;
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<LaunchctlResult> => {
    calls.push(args);
    if (args[0] === 'print') return loaded ? { code: 0, stdout: 'state = running\n', stderr: '' } : { code: 113, stdout: '', stderr: 'Could not find service' };
    if (args[0] === 'bootstrap') { loaded = true; return { code: 0, stdout: '', stderr: '' }; }
    if (args[0] === 'kickstart') return loaded ? { code: 0, stdout: '', stderr: '' } : { code: 113, stdout: '', stderr: 'not loaded' };
    if (args[0] === 'bootout') { loaded = false; return { code: 0, stdout: '', stderr: '' }; }
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  return { run, calls, isLoaded: () => loaded };
}

test('service manager installs an escaped plist, is idempotent, and reports actual state', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'hc-service-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const fake = fakeLaunchctl();
  const manager = new ServiceManager({ homeDir: home, uid: 501, nodePath: '/tmp/node&x', cliPath: '/tmp/cli<quoted>.js', configPath: '/tmp/config&v03.json', launchctl: fake.run });

  assert.deepEqual(await manager.status(), { loaded: false, running: false, label: manager.label, plistPath: manager.plistPath });
  const installed = await manager.install();
  assert.equal(installed.loaded, true);
  assert.equal(installed.installed, true);
  const plist = await readFile(manager.plistPath, 'utf8');
  assert.match(plist, /\/tmp\/node&amp;x/);
  assert.match(plist, /\/tmp\/cli&lt;quoted&gt;\.js/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /<string>--config<\/string><string>\/tmp\/config&amp;v03\.json<\/string>/);
  assert.deepEqual(await manager.install(), { installed: false, loaded: true, label: manager.label, plistPath: manager.plistPath });
  assert.equal(fake.calls.filter((args) => args[0] === 'bootstrap').length, 1);
});

test('service manager starts, stops, and uninstalls only its own plist', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'hc-service-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const config = join(home, 'Library', 'Application Support', 'HardwareCompanion', 'config.json');
  await mkdir(join(home, 'Library', 'Application Support', 'HardwareCompanion'), { recursive: true });
  await writeFile(config, '{"token":"keep"}');
  const fake = fakeLaunchctl();
  const manager = new ServiceManager({ homeDir: home, uid: 501, launchctl: fake.run });
  await assert.rejects(() => manager.start(), /SERVICE_NOT_INSTALLED/);
  await manager.install();
  assert.deepEqual(await manager.start(), { started: true, loaded: true, label: manager.label });
  assert.deepEqual(await manager.stop(), { stopped: true, loaded: false, label: manager.label });
  assert.deepEqual(await manager.start(), { started: true, loaded: true, label: manager.label });
  await manager.install();
  assert.deepEqual(await manager.uninstall(), { uninstalled: true, loaded: false, label: manager.label, plistPath: manager.plistPath });
  await assert.rejects(() => access(manager.plistPath));
  assert.equal(await readFile(config, 'utf8'), '{"token":"keep"}');
  assert.equal(fake.isLoaded(), false);
});

test('service stop waits for launchctl bootout to finish unloading', async t => {
  const home = await mkdtemp(join(tmpdir(), 'hc-service-delayed-stop-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let loaded = true;
  let printsAfterBootout = 0;
  let bootedOut = false;
  const manager = new ServiceManager({ homeDir: home, launchctl: async args => {
    if (args[0] === 'bootout') { bootedOut = true; return { code: 0, stdout: '', stderr: '' }; }
    if (args[0] === 'print') {
      if (bootedOut && ++printsAfterBootout >= 3) loaded = false;
      return loaded ? { code: 0, stdout: 'state = waiting\n', stderr: '' } : { code: 113, stdout: '', stderr: 'Could not find service' };
    }
    return { code: 1, stdout: '', stderr: 'unexpected' };
  } });
  assert.deepEqual(await manager.stop(), { stopped: true, loaded: false, label: manager.label });
  assert.ok(printsAfterBootout >= 3);
});

test('service manager does not report loaded when bootstrap fails', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'hc-service-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<LaunchctlResult> => {
    calls.push(args);
    if (args[0] === 'print') return { code: 113, stdout: '', stderr: 'Could not find service' };
    return { code: 5, stdout: '', stderr: 'permission denied' };
  };
  const manager = new ServiceManager({ homeDir: home, launchctl: run });
  await assert.rejects(() => manager.install(), /LAUNCHCTL_BOOTSTRAP_FAILED/);
  assert.equal(calls.filter((args) => args[0] === 'bootstrap').length, 1);
});

test('service status distinguishes loaded from running', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'hc-service-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const manager = new ServiceManager({
    homeDir: home,
    launchctl: async (args) => args[0] === 'print'
      ? { code: 0, stdout: 'state = waiting\n', stderr: '' }
      : { code: 0, stdout: '', stderr: '' },
  });
  const status = await manager.status();
  assert.equal(status.loaded, true);
  assert.equal(status.running, false);
});

test('installed service pins the validated Node executable outside the business release', async t => {
  const home = await mkdtemp(join(tmpdir(), 'hc-external-node-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const installRoot = join(home, 'connector with spaces');
  const fake = fakeLaunchctl();
  const manager = new ServiceManager({ homeDir: home, installRoot, nodePath: '/tmp/runtime cache/bin/node', launchctl: fake.run });
  await manager.install();
  assert.match(await readFile(manager.plistPath, 'utf8'), /\/tmp\/runtime cache\/bin\/node/);
  assert.doesNotMatch(await readFile(manager.plistPath, 'utf8'), /current\/runtime\/node/);
});
